/**
 * Phase-2 probe for dnd5e_roll_check — narrows the one open question
 * from phase 1: rollSkill timed out (>8s) under the (config, dialog,
 * message) triad with { configure: false }, while rollAbilityCheck /
 * rollSavingThrow / rollToolCheck all resolved cleanly under the same
 * shape. This probe determines whether rollSkill truly opens a dialog
 * (a hard hang the tool must avoid) or was merely slow on a cold call.
 *
 * Method:
 *   - warm the roll pipeline with a rollAbilityCheck first,
 *   - snapshot open Application windows before/after each rollSkill,
 *   - give rollSkill a generous 30s timeout,
 *   - test several rollSkill argument shapes,
 *   - roll once against a high DC to capture a FAILURE outcome
 *     (phase 1 only saw isSuccess:true).
 *
 * Cleans up every ChatMessage it creates.
 *
 *   npm run build && node scripts/probe-dnd5e-roll-check-phase2.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const out = await page.evaluate(async () => {
    const game = globalThis.game;
    const report = {};
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    if (!npc) return { aborted: 'no npc' };
    report.npc = { id: npc.id, name: npc.name };
    const baseMsgIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);

    report.rollSkillArity = npc.rollSkill?.length ?? null;
    report.rollAbilityCheckArity = npc.rollAbilityCheck?.length ?? null;

    const openWindows = () => {
      const inst = globalThis.foundry?.applications?.instances;
      const fromInstances = inst
        ? [...inst.values()].map((a) => a?.constructor?.name)
        : null;
      const fromUi = globalThis.ui?.windows
        ? Object.values(globalThis.ui.windows).map((w) => w?.constructor?.name)
        : null;
      return { fromInstances, fromUi };
    };

    const withTimeout = (p, ms) =>
      Promise.race([
        Promise.resolve(p)
          .then((v) => ({ value: v }))
          .catch((e) => ({ error: e?.message ?? String(e) })),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), ms)),
      ]);

    const describeRoll = (val) => {
      const one = Array.isArray(val) ? val[0] : val;
      return {
        isArray: Array.isArray(val),
        len: Array.isArray(val) ? val.length : null,
        innerCtor: one?.constructor?.name ?? null,
        total: one?.total ?? null,
        firstDie: one?.dice?.[0]?.results?.[0]?.result ?? null,
        isSuccess: one?.isSuccess ?? null,
        isFailure: one?.isFailure ?? null,
        optionsTarget: one?.options?.target ?? null,
      };
    };

    const tryRoll = async (label, invoke, ms) => {
      const winBefore = openWindows();
      const before = game.messages?.size ?? 0;
      const t0 = Date.now();
      const raced = await withTimeout(invoke(), ms);
      const elapsed = Date.now() - t0;
      const after = game.messages?.size ?? 0;
      const winAfter = openWindows();
      const entry = { label, elapsedMs: elapsed, msgDelta: after - before, winBefore, winAfter };
      if (raced.timedOut) entry.timedOut = true;
      else if (raced.error) entry.threw = raced.error;
      else entry.roll = describeRoll(raced.value);
      return entry;
    };

    // Warm the pipeline.
    report.warmup = await tryRoll(
      'warmup rollAbilityCheck',
      () => npc.rollAbilityCheck({ ability: 'dex' }, { configure: false }, {}),
      30000,
    );

    // rollSkill — the open question. 30s timeout.
    report.skill1 = await tryRoll(
      'rollSkill triad {skill} configure:false',
      () => npc.rollSkill({ skill: 'acr' }, { configure: false }, {}),
      30000,
    );
    report.skill2 = await tryRoll(
      'rollSkill triad {skill} second call (steady state)',
      () => npc.rollSkill({ skill: 'ath' }, { configure: false }, {}),
      30000,
    );
    report.skill3 = await tryRoll(
      'rollSkill triad {skill,target:30} expect failure',
      () => npc.rollSkill({ skill: 'ste', target: 30 }, { configure: false }, {}),
      30000,
    );
    report.skill4 = await tryRoll(
      'rollSkill triad {skill,target:1} expect success',
      () => npc.rollSkill({ skill: 'prc', target: 1 }, { configure: false }, {}),
      30000,
    );

    // Cleanup.
    const created =
      game.messages?.contents.filter((m) => !baseMsgIds.has(m.id)).map((m) => m.id) ?? [];
    if (created.length > 0) await globalThis.ChatMessage.deleteDocuments(created);
    report.cleanedUpMessages = created.length;
    return report;
  });

  log.info({ out }, 'phase-2 dnd5e_roll_check rollSkill report');
  console.error(JSON.stringify(out, null, 2));
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
