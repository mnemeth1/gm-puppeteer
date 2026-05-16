/**
 * Probe + acceptance script for roll_check. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Perception vs DC → ok, total numeric, dieResult in [1,20],
 *       outcome is one of the four degree-of-success values.
 *   2.  Skill (no DC) → ok, outcome=null, modifier matches the NPC's
 *       real stat-block check modifier.
 *   3.  Save vs DC → ok, outcome present, chatMessageId populated.
 *   4.  visibility "gm" → message whispered to GM users only.
 *   5.  PC actor → ACTOR_IS_PC (the agency gate).
 *   6.  Bogus actorId → ACTOR_NOT_FOUND.
 *
 * The dialog-bypass check is implicit: if skipDialog did not take,
 * `await statistic.roll()` would block on CheckModifiersDialog and the
 * probe would time out. A clean run IS the verification.
 *
 * State restoration: snapshot ChatMessage ids at probe start; delete
 * every message created during the run at teardown.
 *
 *   npm run build && node scripts/probe-roll-check.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'roll_check');
if (!tool) {
  log.error('roll_check not registered');
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
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    const pc = game.actors?.contents.find((a) => a.type === 'character');
    return {
      messageIds: game.messages?.contents.map((m) => m.id) ?? [],
      gmUserIds: game.users?.contents.filter((u) => u.isGM).map((u) => u.id) ?? [],
      npc: npc
        ? { id: npc.id, name: npc.name, athleticsMod: npc.skills?.athletics?.check?.mod ?? null }
        : null,
      pc: pc ? { id: pc.id, name: pc.name } : null,
    };
  });
  log.info({ setup }, 'setup');
  if (!setup.npc || !setup.pc) {
    log.error('need both an NPC and a PC actor in the world');
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
      };
    }, id);
  }

  const OUTCOMES = ['criticalSuccess', 'success', 'failure', 'criticalFailure'];

  // ====================================================================
  // Probe 1: perception vs DC.
  // ====================================================================
  {
    const res = await call({ actorId: setup.npc.id, checkType: 'perception', dc: 15 });
    log.info({ probe: 1, res }, 'probe 1: perception vs DC');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(typeof res.data.total === 'number', 'probe 1: total numeric', { d: res.data });
      assert(res.data.dieResult >= 1 && res.data.dieResult <= 20, 'probe 1: dieResult in [1,20]', {
        dieResult: res.data.dieResult,
      });
      assert(OUTCOMES.includes(res.data.outcome), 'probe 1: outcome is a degree of success', {
        outcome: res.data.outcome,
      });
      assert(res.data.dc === 15, 'probe 1: dc echoed', { dc: res.data.dc });
      assert(typeof res.data.chatMessageId === 'string', 'probe 1: chatMessageId populated', {
        id: res.data.chatMessageId,
      });
    }
  }

  // ====================================================================
  // Probe 2: skill, no DC → outcome null, modifier matches stat block.
  // ====================================================================
  {
    const res = await call({ actorId: setup.npc.id, checkType: 'athletics' });
    log.info({ probe: 2, res }, 'probe 2: skill, no DC');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.outcome === null, 'probe 2: outcome null without DC', {
        outcome: res.data.outcome,
      });
      assert(res.data.dc === null, 'probe 2: dc null', { dc: res.data.dc });
      assert(
        res.data.modifier === setup.npc.athleticsMod,
        'probe 2: modifier matches the NPC stat block',
        { modifier: res.data.modifier, expected: setup.npc.athleticsMod },
      );
      assert(res.data.statisticSlug === 'athletics', 'probe 2: statisticSlug=athletics', {
        slug: res.data.statisticSlug,
      });
    }
  }

  // ====================================================================
  // Probe 3: save vs DC.
  // ====================================================================
  {
    const res = await call({ actorId: setup.npc.id, checkType: 'will', dc: 20 });
    log.info({ probe: 3, res }, 'probe 3: save vs DC');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(OUTCOMES.includes(res.data.outcome), 'probe 3: outcome present', {
        outcome: res.data.outcome,
      });
      assert(typeof res.data.chatMessageId === 'string', 'probe 3: chatMessageId populated', {
        id: res.data.chatMessageId,
      });
    }
  }

  // ====================================================================
  // Probe 4: visibility "gm".
  // ====================================================================
  {
    const res = await call({ actorId: setup.npc.id, checkType: 'stealth', visibility: 'gm' });
    log.info({ probe: 4, res }, 'probe 4: gm visibility');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
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
    }
  }

  // ====================================================================
  // Probe 5: PC actor → ACTOR_IS_PC.
  // ====================================================================
  {
    const res = await call({ actorId: setup.pc.id, checkType: 'perception' });
    log.info({ probe: 5, res }, 'probe 5: PC actor rejection');
    assert(res.isError === true, 'probe 5: error returned', { res });
    if (res.isError) {
      assert(res.error?.details?.reason === 'ACTOR_IS_PC', 'probe 5: reason=ACTOR_IS_PC', {
        reason: res.error?.details?.reason,
      });
    }
  }

  // ====================================================================
  // Probe 6: bogus actorId → ACTOR_NOT_FOUND.
  // ====================================================================
  {
    const res = await call({ actorId: 'nope_no_such_actor', checkType: 'perception' });
    log.info({ probe: 6, res }, 'probe 6: bogus actorId');
    assert(res.isError === true, 'probe 6: error returned', { res });
    if (res.isError) {
      assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 6: reason=ACTOR_NOT_FOUND', {
        reason: res.error?.details?.reason,
      });
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
