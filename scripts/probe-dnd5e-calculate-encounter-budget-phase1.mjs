/**
 * Phase-1 exploratory probe for dnd5e_calculate_encounter_budget. Confirms
 * the dnd5e encounter-budget data shape against the live headless Foundry
 * BEFORE the evaluator is written. Throwaway — does not exercise a tool.
 *
 * The tool reads three live values: the rules edition setting plus two
 * CONFIG tables. TODO.md's "pure math, no probe" claim is wrong — this
 * probe settles whether the dnd5e system swaps CONFIG.DND5E.ENCOUNTER_DIFFICULTY
 * to a legacy (2014) shape when the world is set to legacy rules. If it
 * does not, the tool's legacy branch must carry a hardcoded 2014 DMG table.
 *
 * Questions:
 *   Q1. game.settings.get("dnd5e","rulesVersion") — current value, and the
 *       setting definition (choices, default, requiresReload).
 *   Q2. CONFIG.DND5E.ENCOUNTER_DIFFICULTY — length, element shape, sample
 *       rows (L1/L5/L20), in the current ("modern") state.
 *   Q3. CONFIG.DND5E.CR_EXP_LEVELS — length, CR0/CR1/CR30, any fractional
 *       indices (expected absent — fractional CR XP must be hardcoded).
 *   Q4. Flip rulesVersion to "legacy", re-read ENCOUNTER_DIFFICULTY and
 *       CR_EXP_LEVELS — same 21x3, a 21x4, or unchanged? Scan CONFIG.DND5E
 *       for any other XP / threshold / difficulty keys.
 *   Q5. Restore rulesVersion to its original value; re-read
 *       ENCOUNTER_DIFFICULTY and assert it equals the Q2 snapshot.
 *
 * Mutates a world setting; restores it exactly (CLAUDE.md probe rule).
 *
 *   npm run build && node scripts/probe-dnd5e-calculate-encounter-budget-phase1.mjs
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
    const CONFIG = globalThis.CONFIG;
    const report = {
      system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
    };

    const D = CONFIG?.DND5E ?? {};

    // Q1: rulesVersion setting + its definition.
    const originalRulesVersion = game.settings.get('dnd5e', 'rulesVersion');
    const settingDef = game.settings.settings.get('dnd5e.rulesVersion') ?? null;
    report.rulesVersion = {
      original: originalRulesVersion,
      default: settingDef?.default ?? null,
      choices: settingDef?.choices ?? null,
      scope: settingDef?.scope ?? null,
      requiresReload: settingDef?.requiresReload ?? null,
    };

    const tableShape = (t) => ({
      isArray: Array.isArray(t),
      length: Array.isArray(t) ? t.length : null,
      elementWidth: Array.isArray(t?.[1]) ? t[1].length : null,
      rowL1: t?.[1] ?? null,
      rowL5: t?.[5] ?? null,
      rowL20: t?.[20] ?? null,
    });

    // Q2 / Q3: modern-state tables.
    const modernEnc = D.ENCOUNTER_DIFFICULTY;
    report.modern = {
      ENCOUNTER_DIFFICULTY: tableShape(modernEnc),
      CR_EXP_LEVELS: {
        isArray: Array.isArray(D.CR_EXP_LEVELS),
        length: Array.isArray(D.CR_EXP_LEVELS) ? D.CR_EXP_LEVELS.length : null,
        cr0: D.CR_EXP_LEVELS?.[0] ?? null,
        cr1: D.CR_EXP_LEVELS?.[1] ?? null,
        cr30: D.CR_EXP_LEVELS?.[30] ?? null,
        // fractional CR keys would be non-integer indices; arrays cannot carry
        // them, so this confirms 1/8, 1/4, 1/2 must be hardcoded by the tool.
        hasFractionalKeys: Object.keys(D.CR_EXP_LEVELS ?? {}).some(
          (k) => !Number.isInteger(Number(k)),
        ),
      },
    };

    // Snapshot the modern ENCOUNTER_DIFFICULTY for the post-restore assertion.
    const modernSnapshot = JSON.stringify(modernEnc ?? null);

    // Q4: any other XP / threshold / difficulty CONFIG keys?
    report.configXpKeys = Object.keys(D).filter((k) =>
      /xp|exp|encounter|difficult|threshold|challenge/i.test(k),
    );

    // Q4: flip to legacy, re-read.
    let flipError = null;
    try {
      await game.settings.set('dnd5e', 'rulesVersion', 'legacy');
    } catch (e) {
      flipError = e?.message ?? String(e);
    }
    report.legacy = {
      flipError,
      rulesVersionNow: game.settings.get('dnd5e', 'rulesVersion'),
      ENCOUNTER_DIFFICULTY: tableShape(CONFIG.DND5E.ENCOUNTER_DIFFICULTY),
      encounterDifficultyChanged:
        JSON.stringify(CONFIG.DND5E.ENCOUNTER_DIFFICULTY ?? null) !== modernSnapshot,
      crExpLevelsLength: Array.isArray(CONFIG.DND5E.CR_EXP_LEVELS)
        ? CONFIG.DND5E.CR_EXP_LEVELS.length
        : null,
    };

    // Q5: restore exactly.
    let restoreError = null;
    try {
      await game.settings.set('dnd5e', 'rulesVersion', originalRulesVersion);
    } catch (e) {
      restoreError = e?.message ?? String(e);
    }
    report.restore = {
      restoreError,
      rulesVersionNow: game.settings.get('dnd5e', 'rulesVersion'),
      restored: game.settings.get('dnd5e', 'rulesVersion') === originalRulesVersion,
      encounterDifficultyMatchesSnapshot:
        JSON.stringify(CONFIG.DND5E.ENCOUNTER_DIFFICULTY ?? null) === modernSnapshot,
    };

    return report;
  });

  log.info({ out }, 'phase-1 dnd5e_calculate_encounter_budget data report');
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
