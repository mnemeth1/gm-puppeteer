/**
 * Probe + acceptance script for request_check. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world and
 * exercises:
 *
 *   1.  Perception vs DC, GM-only DC → exact checkExpression, the
 *       stored message content carries an inline-check anchor with
 *       data-pf2-check / data-pf2-dc, whisper covers the actor owners.
 *   2.  showDcToPlayers:true → expression ends showDC:all.
 *   3.  Basic save → expression contains the bare `basic` flag.
 *   4.  Traits → expression contains traits:<csv>.
 *   5.  basic on a non-save → BASIC_ON_NON_SAVE.
 *   6.  NPC actor → ACTOR_NOT_A_PC.
 *   7.  Bogus actorId → ACTOR_NOT_FOUND.
 *
 * The probe verifies the enriched button HTML is well-formed and
 * correctly whispered. It CANNOT verify that a player clicking the
 * button rolls for the intended actor — that needs a human-in-the-loop
 * check (log in as the owning player, click the whispered button).
 *
 * State restoration: snapshot ChatMessage ids at probe start; delete
 * every message created during the run at teardown.
 *
 *   npm run build && node scripts/probe-request-check.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'request_check');
if (!tool) {
  log.error('request_check not registered');
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

  const setup = await page.evaluate(() => {
    const game = globalThis.game;
    const pc = game.actors?.contents.find((a) => a.type === 'character');
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    const owners =
      pc != null
        ? (game.users?.contents.filter((u) => pc.testUserPermission(u, 'OWNER')) ?? []).map(
            (u) => u.id,
          )
        : [];
    return {
      messageIds: game.messages?.contents.map((m) => m.id) ?? [],
      pc: pc ? { id: pc.id, name: pc.name, ownerIds: owners } : null,
      npc: npc ? { id: npc.id, name: npc.name } : null,
    };
  });
  log.info({ setup }, 'setup');
  if (!setup.pc || !setup.npc) {
    log.error('need both a PC and an NPC actor in the world');
    process.exit(2);
  }
  const baselineIds = new Set(setup.messageIds);

  async function getMessage(id) {
    return page.evaluate((mid) => {
      const m = globalThis.game.messages?.get(mid);
      if (!m) return null;
      return {
        id: m.id,
        content: typeof m.content === 'string' ? m.content : '',
        whisper: Array.isArray(m.whisper) ? [...m.whisper] : m.whisper,
        speakerActor: m.speaker?.actor ?? null,
      };
    }, id);
  }

  // ====================================================================
  // Probe 1: perception vs DC, GM-only DC.
  // ====================================================================
  {
    const res = await call({ actorId: setup.pc.id, checkType: 'perception', dc: 20 });
    log.info({ probe: 1, res }, 'probe 1: perception vs DC');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(
        res.data.checkExpression === '@Check[perception|dc:20|showDC:gm]',
        'probe 1: exact checkExpression',
        { expr: res.data.checkExpression },
      );
      assert(typeof res.data.chatMessageId === 'string', 'probe 1: chatMessageId populated', {
        id: res.data.chatMessageId,
      });
      assert(res.data.whisperedTo.length > 0, 'probe 1: whisperedTo non-empty', {
        whisperedTo: res.data.whisperedTo,
      });
      const msg = await getMessage(res.data.chatMessageId);
      assert(
        /class="[^"]*inline-check/.test(msg?.content ?? ''),
        'probe 1: stored content has inline-check anchor',
        { content: msg?.content },
      );
      assert(
        /data-pf2-check="perception"/.test(msg?.content ?? ''),
        'probe 1: content has data-pf2-check=perception',
        { content: msg?.content },
      );
      assert(
        /data-pf2-dc="20"/.test(msg?.content ?? ''),
        'probe 1: content has data-pf2-dc=20',
        { content: msg?.content },
      );
      assert(
        msg?.speakerActor === setup.pc.id,
        'probe 1: message speaker is the target PC',
        { speakerActor: msg?.speakerActor },
      );
      const whisperCoversOwners =
        Array.isArray(msg?.whisper) &&
        setup.pc.ownerIds.every((id) => msg.whisper.includes(id));
      assert(whisperCoversOwners, 'probe 1: whisper covers all actor owners', {
        whisper: msg?.whisper,
        ownerIds: setup.pc.ownerIds,
      });
    }
  }

  // ====================================================================
  // Probe 2: showDcToPlayers true → showDC:all.
  // ====================================================================
  {
    const res = await call({
      actorId: setup.pc.id,
      checkType: 'athletics',
      dc: 18,
      showDcToPlayers: true,
    });
    log.info({ probe: 2, res }, 'probe 2: showDcToPlayers');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(
        res.data.checkExpression === '@Check[athletics|dc:18|showDC:all]',
        'probe 2: expression uses showDC:all',
        { expr: res.data.checkExpression },
      );
    }
  }

  // ====================================================================
  // Probe 3: basic save.
  // ====================================================================
  {
    const res = await call({
      actorId: setup.pc.id,
      checkType: 'reflex',
      dc: 22,
      basic: true,
    });
    log.info({ probe: 3, res }, 'probe 3: basic save');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(
        res.data.checkExpression === '@Check[reflex|dc:22|basic|showDC:gm]',
        'probe 3: expression contains the basic flag',
        { expr: res.data.checkExpression },
      );
      assert(res.data.basic === true, 'probe 3: result basic=true', { basic: res.data.basic });
    }
  }

  // ====================================================================
  // Probe 4: traits.
  // ====================================================================
  {
    const res = await call({
      actorId: setup.pc.id,
      checkType: 'stealth',
      traits: ['secret'],
    });
    log.info({ probe: 4, res }, 'probe 4: traits');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(
        res.data.checkExpression === '@Check[stealth|traits:secret|showDC:gm]',
        'probe 4: expression contains traits:secret',
        { expr: res.data.checkExpression },
      );
    }
  }

  // ====================================================================
  // Probe 5: basic on a non-save → BASIC_ON_NON_SAVE.
  // ====================================================================
  {
    const res = await call({ actorId: setup.pc.id, checkType: 'arcana', basic: true });
    log.info({ probe: 5, res }, 'probe 5: basic on non-save');
    assert(res.isError === true, 'probe 5: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'BASIC_ON_NON_SAVE',
        'probe 5: reason=BASIC_ON_NON_SAVE',
        { reason: res.error?.details?.reason },
      );
    }
  }

  // ====================================================================
  // Probe 6: NPC actor → ACTOR_NOT_A_PC.
  // ====================================================================
  {
    const res = await call({ actorId: setup.npc.id, checkType: 'perception' });
    log.info({ probe: 6, res }, 'probe 6: NPC actor rejection');
    assert(res.isError === true, 'probe 6: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'ACTOR_NOT_A_PC',
        'probe 6: reason=ACTOR_NOT_A_PC',
        { reason: res.error?.details?.reason },
      );
    }
  }

  // ====================================================================
  // Probe 7: bogus actorId → ACTOR_NOT_FOUND.
  // ====================================================================
  {
    const res = await call({ actorId: 'nope_no_such_actor', checkType: 'perception' });
    log.info({ probe: 7, res }, 'probe 7: bogus actorId');
    assert(res.isError === true, 'probe 7: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'ACTOR_NOT_FOUND',
        'probe 7: reason=ACTOR_NOT_FOUND',
        { reason: res.error?.details?.reason },
      );
    }
  }

  // --------------------------------------------------------------------
  // Teardown — delete every ChatMessage created during the probe.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(async (baseline) => {
    const game = globalThis.game;
    const baseSet = new Set(baseline);
    const created = game.messages?.contents.filter((m) => !baseSet.has(m.id)).map((m) => m.id) ?? [];
    if (created.length > 0) {
      await globalThis.ChatMessage.deleteDocuments(created);
    }
    return { deleted: created.length, finalCount: game.messages?.size ?? 0 };
  }, [...baselineIds]);
  log.info({ teardown }, 'teardown complete');
  assert(
    teardown.finalCount === baselineIds.size,
    'teardown: message count restored to baseline',
    { finalCount: teardown.finalCount, baseline: baselineIds.size },
  );

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
