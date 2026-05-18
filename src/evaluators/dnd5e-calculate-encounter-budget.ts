/**
 * page.evaluate body for dnd5e_calculate_encounter_budget. A thin,
 * read-only probe of the live D&D 5e world: it reads the rules edition
 * and two CONFIG tables and returns them verbatim. It performs NO budget
 * arithmetic — all of that lives in the tool layer (src/tools/
 * dnd5e-calculate-encounter-budget.ts) as ordinary, unit-testable TS that
 * runs after this function returns.
 *
 * Why the split: the budget math needs the 2014 (legacy) threshold table,
 * the encounter-size multiplier table, fractional-CR constants, and a list
 * of mix templates. Per CLAUDE.md's "evaluator bodies have no outer scope"
 * rule, running that math here would mean inlining every constant and
 * helper into this serialized function — fragile and untestable. Keeping
 * this body to ~3 property reads makes it robust across dnd5e releases:
 * anything that breaks is a missing CONFIG key, surfaced as a clean
 * FOUNDRY_NOT_READY error rather than a ReferenceError deep in serialized
 * math.
 *
 * Phase-1 findings encoded here (verified against dnd5e 5.3.3 + Foundry
 * v14.361 by scripts/probe-dnd5e-calculate-encounter-budget-phase1.mjs):
 *   - The rules edition is the world-scope setting `dnd5e.rulesVersion`,
 *     value "modern" (2024 rules) or "legacy" (2014 rules); default
 *     "modern"; requiresReload: true.
 *   - CONFIG.DND5E.ENCOUNTER_DIFFICULTY is the 2024 DMG per-character XP
 *     budget: an array indexed by character level 0..20, each element a
 *     triple [low, moderate, high]. L1 = [50,75,100], L20 = [6400,13200,22000].
 *   - This table is a STATIC config constant — the probe confirmed it is
 *     NOT swapped to a legacy shape when rulesVersion is "legacy", and
 *     CONFIG.DND5E carries no other XP/threshold key. So the system ships
 *     no 2014 table; the tool's legacy branch uses its own hardcoded one.
 *   - CONFIG.DND5E.CR_EXP_LEVELS is XP-by-CR: an array indexed by integer
 *     CR 0..30 (length 31). Fractional CRs (1/8, 1/4, 1/2) are NOT present
 *     — the tool adds the standard 25/50/100 values itself.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export type Dnd5eRulesVersion = 'modern' | 'legacy';

export interface Dnd5eEncounterBudgetProbeOk {
  ok: true;
  /** The world's D&D 5e rules edition. "modern" = 2024, "legacy" = 2014. */
  rulesVersion: Dnd5eRulesVersion;
  /**
   * CONFIG.DND5E.ENCOUNTER_DIFFICULTY verbatim — the 2024 DMG per-character
   * XP budget, indexed by character level (0..20), each row [low, moderate,
   * high]. Always the modern table; the system ships no legacy variant.
   */
  encounterDifficultyTable: number[][];
  /** CONFIG.DND5E.CR_EXP_LEVELS verbatim — XP by integer CR, index 0..30. */
  crExpLevels: number[];
}

export interface Dnd5eEncounterBudgetProbeErr {
  ok: false;
  error: {
    code: 'FOUNDRY_NOT_READY';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eEncounterBudgetProbeResult =
  | Dnd5eEncounterBudgetProbeOk
  | Dnd5eEncounterBudgetProbeErr;

export function dnd5eCalculateEncounterBudgetBody(): Dnd5eEncounterBudgetProbeResult {
  interface SettingsLike {
    get(namespace: string, key: string): unknown;
  }
  interface FoundryGameLike {
    settings?: SettingsLike;
    system?: { id?: string };
  }
  interface Dnd5eConfigLike {
    ENCOUNTER_DIFFICULTY?: unknown;
    CR_EXP_LEVELS?: unknown;
  }

  const fail = (
    message: string,
    details: Record<string, unknown>,
  ): Dnd5eEncounterBudgetProbeErr => ({
    ok: false,
    error: { code: 'FOUNDRY_NOT_READY', message, details },
  });

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  if (!game) {
    return fail('Foundry game global is unavailable.', { reason: 'GAME_UNAVAILABLE' });
  }
  const dnd5eConfig = (globalThis as unknown as { CONFIG?: { DND5E?: Dnd5eConfigLike } }).CONFIG
    ?.DND5E;
  if (!dnd5eConfig) {
    return fail('CONFIG.DND5E is unavailable — is this a D&D 5e world?', {
      reason: 'NOT_DND5E_WORLD',
      systemId: game.system?.id ?? null,
    });
  }

  // -- Rules edition. The setting is dnd5e-owned; treat any value other
  //    than the two known choices as "modern" (the system default).
  let rulesVersion: Dnd5eRulesVersion = 'modern';
  try {
    const raw = game.settings?.get('dnd5e', 'rulesVersion');
    rulesVersion = raw === 'legacy' ? 'legacy' : 'modern';
  } catch (e: unknown) {
    return fail(
      `Could not read the dnd5e.rulesVersion setting: ${e instanceof Error ? e.message : String(e)}`,
      { reason: 'RULES_VERSION_UNREADABLE' },
    );
  }

  // -- ENCOUNTER_DIFFICULTY: array of [low, moderate, high] by character level.
  const encRaw = dnd5eConfig.ENCOUNTER_DIFFICULTY;
  if (!Array.isArray(encRaw) || encRaw.length === 0) {
    return fail('CONFIG.DND5E.ENCOUNTER_DIFFICULTY is missing or empty.', {
      reason: 'ENCOUNTER_DIFFICULTY_MALFORMED',
    });
  }
  const encounterDifficultyTable: number[][] = [];
  for (const row of encRaw as unknown[]) {
    if (Array.isArray(row)) {
      encounterDifficultyTable.push((row as unknown[]).map((n) => Number(n)));
    } else {
      encounterDifficultyTable.push([]);
    }
  }

  // -- CR_EXP_LEVELS: XP by integer CR.
  const crRaw = dnd5eConfig.CR_EXP_LEVELS;
  if (!Array.isArray(crRaw) || crRaw.length === 0) {
    return fail('CONFIG.DND5E.CR_EXP_LEVELS is missing or empty.', {
      reason: 'CR_EXP_LEVELS_MALFORMED',
    });
  }
  const crExpLevels: number[] = (crRaw as unknown[]).map((n) => Number(n));

  return {
    ok: true,
    rulesVersion,
    encounterDifficultyTable,
    crExpLevels,
  };
}
