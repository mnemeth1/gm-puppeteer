/**
 * Probe + acceptance script for roll_dice. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Deterministic formula: "2+2" → total=4, chatMessageId populated.
 *   2.  Single die: "1d30" → total in [1,30], terms=[{faces:30, 1 result}].
 *   3.  Multi-die + modifier: "2d6+3" → total in [5,15], 2 d6 results.
 *   4.  Flavor round-trips onto the created ChatMessage.
 *   5.  visibility "gm" → message whispered to GM users only, blind=false.
 *   6.  visibility "blind" → message blind=true, whisper non-empty.
 *   7.  speakerActorId → message speaker.actor + result speaker match the NPC.
 *   8.  Invalid formula → FORMULA_INVALID.
 *   9.  Bogus speakerActorId → SPEAKER_ACTOR_NOT_FOUND.
 *
 * State restoration: snapshot the set of ChatMessage ids at probe
 * start; at teardown delete every message id created during the run
 * and assert the message count returns to baseline.
 *
 *   npm run build && node scripts/probe-roll-dice.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'roll_dice');
if (!tool) {
  log.error('roll_dice not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { isError: true, validation: parsed.error.issues };
  }
  const blocks = await tool.handler(parsed.data, { browser: session, log }).catch((err) => ({
    __throw:
      err instanceof Error
        ? { code: err.code, message: err.message, details: err.details }
        : { message: String(err) },
  }));
  if (blocks?.__throw) return { isError: true, error: blocks.__throw };
  const block = blocks?.[0];
  if (!block || block.type !== 'text') return { isError: true, raw: blocks };
  try {
    return { ok: true, data: JSON.parse(block.text) };
  } catch {
    return { isError: true, raw: block.text };
  }
}

try {
  const { page } = await session.ensureStarted();

  // Snapshot baseline chat-message ids + GM user ids + an NPC actor.
  const setup = await page.evaluate(() => {
    const game = globalThis.game;
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    return {
      messageIds: game.messages?.contents.map((m) => m.id) ?? [],
      gmUserIds: game.users?.contents.filter((u) => u.isGM).map((u) => u.id) ?? [],
      npc: npc ? { id: npc.id, name: npc.name } : null,
    };
  });
  log.info(
    { baseline: setup.messageIds.length, gmUsers: setup.gmUserIds.length, npc: setup.npc },
    'setup',
  );
  if (!setup.npc) {
    log.error('no NPC actor in the world — cannot run the speaker probe');
    process.exit(2);
  }
  const baselineIds = new Set(setup.messageIds);

  async function getMessage(id) {
    return page.evaluate((mid) => {
      const m = globalThis.game.messages?.get(mid);
      if (!m) return null;
      return {
        id: m.id,
        whisper: Array.isArray(m.whisper) ? [...m.whisper] : m.whisper,
        blind: m.blind === true,
        flavor: typeof m.flavor === 'string' ? m.flavor : null,
        speaker: { actor: m.speaker?.actor ?? null, alias: m.speaker?.alias ?? null },
      };
    }, id);
  }

  // ====================================================================
  // Probe 1: deterministic formula.
  // ====================================================================
  {
    const res = await call({ formula: '2+2', flavor: 'Probe 1 flavor' });
    log.info({ probe: 1, res }, 'probe 1: deterministic formula');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.total === 4, 'probe 1: total=4', { total: res.data.total });
      assert(typeof res.data.chatMessageId === 'string', 'probe 1: chatMessageId populated', {
        id: res.data.chatMessageId,
      });
      const msg = await getMessage(res.data.chatMessageId);
      assert(msg?.flavor === 'Probe 1 flavor', 'probe 1: flavor round-trips', { msg });
      assert(msg?.blind === false, 'probe 1: public roll not blind', { msg });
      assert(
        Array.isArray(msg?.whisper) && msg.whisper.length === 0,
        'probe 1: public roll has empty whisper',
        { whisper: msg?.whisper },
      );
    }
  }

  // ====================================================================
  // Probe 2: single die.
  // ====================================================================
  {
    const res = await call({ formula: '1d30' });
    log.info({ probe: 2, res }, 'probe 2: single die');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.total >= 1 && res.data.total <= 30, 'probe 2: total in [1,30]', {
        total: res.data.total,
      });
      assert(res.data.terms.length === 1, 'probe 2: one dice term', { terms: res.data.terms });
      assert(res.data.terms[0]?.faces === 30, 'probe 2: faces=30', { terms: res.data.terms });
      assert(res.data.terms[0]?.results.length === 1, 'probe 2: one die result', {
        terms: res.data.terms,
      });
    }
  }

  // ====================================================================
  // Probe 3: multi-die + modifier.
  // ====================================================================
  {
    const res = await call({ formula: '2d6+3' });
    log.info({ probe: 3, res }, 'probe 3: multi-die + modifier');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.total >= 5 && res.data.total <= 15, 'probe 3: total in [5,15]', {
        total: res.data.total,
      });
      assert(res.data.terms[0]?.faces === 6, 'probe 3: faces=6', { terms: res.data.terms });
      assert(res.data.terms[0]?.results.length === 2, 'probe 3: two d6 results', {
        terms: res.data.terms,
      });
    }
  }

  // ====================================================================
  // Probe 4: visibility "gm" → whispered to GM users only.
  // ====================================================================
  {
    const res = await call({ formula: '1d6', visibility: 'gm' });
    log.info({ probe: 4, res }, 'probe 4: gm visibility');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.visibility === 'gm', 'probe 4: visibility=gm', { v: res.data.visibility });
      const msg = await getMessage(res.data.chatMessageId);
      assert(Array.isArray(msg?.whisper) && msg.whisper.length > 0, 'probe 4: whisper non-empty', {
        whisper: msg?.whisper,
      });
      const allGm =
        Array.isArray(msg?.whisper) && msg.whisper.every((id) => setup.gmUserIds.includes(id));
      assert(allGm, 'probe 4: all whisper recipients are GMs', {
        whisper: msg?.whisper,
        gmUserIds: setup.gmUserIds,
      });
      assert(msg?.blind === false, 'probe 4: gm roll not blind', { msg });
    }
  }

  // ====================================================================
  // Probe 5: visibility "blind".
  // ====================================================================
  {
    const res = await call({ formula: '1d6', visibility: 'blind' });
    log.info({ probe: 5, res }, 'probe 5: blind visibility');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      const msg = await getMessage(res.data.chatMessageId);
      assert(msg?.blind === true, 'probe 5: message blind=true', { msg });
      assert(Array.isArray(msg?.whisper) && msg.whisper.length > 0, 'probe 5: whisper non-empty', {
        whisper: msg?.whisper,
      });
    }
  }

  // ====================================================================
  // Probe 6: speakerActorId attributes the roll to an NPC.
  // ====================================================================
  {
    const res = await call({ formula: '1d10', speakerActorId: setup.npc.id });
    log.info({ probe: 6, res }, 'probe 6: NPC speaker');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(
        res.data.speaker.actorId === setup.npc.id,
        'probe 6: result speaker.actorId is the NPC',
        { speaker: res.data.speaker },
      );
      assert(
        res.data.speaker.alias === setup.npc.name,
        'probe 6: result speaker.alias is the NPC name',
        { speaker: res.data.speaker, expected: setup.npc.name },
      );
      const msg = await getMessage(res.data.chatMessageId);
      assert(msg?.speaker.actor === setup.npc.id, 'probe 6: message speaker.actor is the NPC', {
        msg,
      });
    }
  }

  // ====================================================================
  // Probe 7: invalid formula → FORMULA_INVALID.
  // ====================================================================
  {
    const res = await call({ formula: '1d6 + ' });
    log.info({ probe: 7, res }, 'probe 7: invalid formula');
    assert(res.isError === true, 'probe 7: error returned', { res });
    if (res.isError) {
      assert(res.error?.details?.reason === 'FORMULA_INVALID', 'probe 7: reason=FORMULA_INVALID', {
        reason: res.error?.details?.reason,
      });
    }
  }

  // ====================================================================
  // Probe 8: bogus speakerActorId → SPEAKER_ACTOR_NOT_FOUND.
  // ====================================================================
  {
    const res = await call({ formula: '1d6', speakerActorId: 'nope_no_such_actor' });
    log.info({ probe: 8, res }, 'probe 8: bogus speakerActorId');
    assert(res.isError === true, 'probe 8: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'SPEAKER_ACTOR_NOT_FOUND',
        'probe 8: reason=SPEAKER_ACTOR_NOT_FOUND',
        { reason: res.error?.details?.reason },
      );
    }
  }

  // --------------------------------------------------------------------
  // Teardown — delete every ChatMessage created during the probe.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (baseline) => {
      const game = globalThis.game;
      const baseSet = new Set(baseline);
      const created =
        game.messages?.contents.filter((m) => !baseSet.has(m.id)).map((m) => m.id) ?? [];
      if (created.length > 0) {
        await globalThis.ChatMessage.deleteDocuments(created);
      }
      return { deleted: created.length, finalCount: game.messages?.size ?? 0 };
    },
    [...baselineIds],
  );
  log.info({ teardown }, 'teardown complete');
  assert(teardown.finalCount === baselineIds.size, 'teardown: message count restored to baseline', {
    finalCount: teardown.finalCount,
    baseline: baselineIds.size,
  });

  log.info({ failureCount: failures.length, failures }, 'PROBE SUMMARY');
  if (failures.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
