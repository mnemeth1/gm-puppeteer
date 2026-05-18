import { describe, expect, it } from 'vitest';
import {
  computeBudget,
  dnd5eCalculateEncounterBudgetTool,
  type Dnd5eCalculateEncounterBudgetInputT,
} from '../../src/tools/dnd5e-calculate-encounter-budget.js';
import type { Dnd5eEncounterBudgetProbeOk } from '../../src/evaluators/dnd5e-calculate-encounter-budget.js';

/**
 * CONFIG.DND5E.ENCOUNTER_DIFFICULTY verbatim from the live dnd5e 5.3.3
 * world (scripts/probe-dnd5e-calculate-encounter-budget-phase1.mjs): the
 * 2024 DMG per-character XP budget, [low, moderate, high] by level 0..20.
 */
const ENCOUNTER_DIFFICULTY: number[][] = [
  [0, 0, 0],
  [50, 75, 100],
  [100, 150, 200],
  [150, 225, 400],
  [250, 375, 500],
  [500, 750, 1100],
  [600, 1000, 1400],
  [750, 1300, 1700],
  [1000, 1700, 2100],
  [1300, 2000, 2600],
  [1600, 2300, 3100],
  [1900, 2900, 4100],
  [2200, 3700, 4700],
  [2600, 4200, 5400],
  [2900, 4900, 6200],
  [3300, 5400, 7800],
  [3800, 6100, 9800],
  [4500, 7200, 11700],
  [5000, 8700, 14200],
  [5500, 10700, 17200],
  [6400, 13200, 22000],
];

/** CONFIG.DND5E.CR_EXP_LEVELS — standard 5e XP by integer CR 0..30. */
const CR_EXP_LEVELS: number[] = [
  10, 200, 450, 700, 1100, 1800, 2300, 2900, 3900, 5000, 5900, 7200, 8400, 10000, 11500, 13000,
  15000, 18000, 20000, 22000, 25000, 33000, 41000, 50000, 62000, 75000, 90000, 105000, 120000,
  135000, 155000,
];

function modernProbe(): Dnd5eEncounterBudgetProbeOk {
  return {
    ok: true,
    rulesVersion: 'modern',
    encounterDifficultyTable: ENCOUNTER_DIFFICULTY.map((r) => [...r]),
    crExpLevels: [...CR_EXP_LEVELS],
  };
}

function legacyProbe(): Dnd5eEncounterBudgetProbeOk {
  return {
    ok: true,
    rulesVersion: 'legacy',
    // The legacy branch ignores encounterDifficultyTable (it uses the tool's
    // hardcoded 2014 thresholds); pass the modern table to prove that.
    encounterDifficultyTable: ENCOUNTER_DIFFICULTY.map((r) => [...r]),
    crExpLevels: [...CR_EXP_LEVELS],
  };
}

const input = (
  partyLevels: number[],
  difficulty: string,
): Dnd5eCalculateEncounterBudgetInputT =>
  ({ partyLevels, difficulty }) as Dnd5eCalculateEncounterBudgetInputT;

describe('dnd5e_calculate_encounter_budget — modern (2024)', () => {
  it('sums per-character budgets: uniform L1 party-of-4, moderate = 4×75', () => {
    const r = computeBudget(input([1, 1, 1, 1], 'moderate'), modernProbe());
    expect(r.rulesVersion).toBe('modern');
    expect(r.budgets).toEqual({ low: 200, moderate: 300, high: 400 });
    expect(r.partyCount).toBe(4);
    expect(r.difficulty).toBe('moderate');
  });

  it('handles mixed-level parties as a per-character sum: [3,3,5] high', () => {
    // L3 high = 400, L5 high = 1100  ->  400+400+1100 = 1900
    const r = computeBudget(input([3, 3, 5], 'high'), modernProbe());
    expect(r.budgets.high).toBe(1900);
    expect(r.budgets.low).toBe(150 + 150 + 500);
    expect(r.partyLevels).toEqual([3, 3, 5]);
  });

  it('CR cost table covers fractional + integer CRs with no multiplier', () => {
    const r = computeBudget(input([1, 1, 1, 1], 'moderate'), modernProbe());
    const crs = r.crCostTable.map((c) => c.cr);
    expect(crs.slice(0, 5)).toEqual(['0', '1/8', '1/4', '1/2', '1']);
    expect(crs).toContain('30');
    const cr1 = r.crCostTable.find((c) => c.cr === '1');
    // budget 300, CR1 = 200 XP, modern has no multiplier: floor(300/200) = 1.
    expect(cr1?.xpPerCreature).toBe(200);
    expect(cr1?.fits.moderate).toBe(1);
    expect(cr1?.fits.high).toBe(2); // floor(400/200)
  });

  it('suggested mixes carry multiplier 1 and adjustedXp === rawXp', () => {
    const r = computeBudget(input([5, 5, 5, 5], 'moderate'), modernProbe());
    expect(r.suggestedMixes.length).toBeGreaterThan(0);
    for (const mix of r.suggestedMixes) {
      expect(mix.multiplier).toBe(1);
      expect(mix.adjustedXp).toBe(mix.rawXp);
      expect(mix.adjustedXp).toBeLessThanOrEqual(mix.budgetXp);
      expect(mix.adjustedXp).toBeGreaterThanOrEqual(mix.budgetXp * 0.85);
    }
  });

  it('omits the legacyMultiplier block under modern rules', () => {
    const r = computeBudget(input([5], 'low'), modernProbe());
    expect(r.legacyMultiplier).toBeUndefined();
    expect(r.edition).toBe('2024 (modern)');
  });

  it('rejects a legacy tier against a modern probe', () => {
    expect(() => computeBudget(input([5], 'deadly'), modernProbe())).toThrow(/modern/);
  });
});

describe('dnd5e_calculate_encounter_budget — legacy (2014)', () => {
  it('uses the hardcoded 2014 thresholds: L5 party-of-4 medium = 4×500', () => {
    const r = computeBudget(input([5, 5, 5, 5], 'medium'), legacyProbe());
    expect(r.rulesVersion).toBe('legacy');
    expect(Object.keys(r.budgets).sort()).toEqual(['deadly', 'easy', 'hard', 'medium']);
    expect(r.budgets.easy).toBe(4 * 250);
    expect(r.budgets.medium).toBe(4 * 500);
    expect(r.budgets.deadly).toBe(4 * 1100);
    expect(r.edition).toBe('2014 (legacy)');
  });

  it('exposes the encounter-size multiplier model', () => {
    const r = computeBudget(input([5], 'medium'), legacyProbe());
    expect(r.legacyMultiplier).toBeDefined();
    expect(r.legacyMultiplier?.bands.find((b) => b.multiplier === 2)).toEqual({
      minCount: 3,
      maxCount: 6,
      multiplier: 2,
    });
  });

  it('bakes the encounter-size multiplier into mix adjustedXp', () => {
    const r = computeBudget(input([5, 5, 5, 5], 'medium'), legacyProbe());
    for (const mix of r.suggestedMixes) {
      const expectedMult = mix.creatureCount >= 3 && mix.creatureCount <= 6 ? 2 : mix.multiplier;
      expect(mix.multiplier).toBe(expectedMult);
      expect(mix.adjustedXp).toBe(mix.rawXp * mix.multiplier);
    }
    // boss-and-minions is a 5-creature mix -> band 3-6 -> ×2.
    const bm = r.suggestedMixes.find((m) => m.label === 'boss-and-minions');
    expect(bm).toBeDefined();
    expect(bm?.creatureCount).toBe(5);
    expect(bm?.multiplier).toBe(2);
    expect(bm?.adjustedXp).toBe((bm?.rawXp ?? 0) * 2);
  });

  it('CR cost table fit count is multiplier-aware', () => {
    const r = computeBudget(input([5, 5, 5, 5], 'medium'), legacyProbe());
    // budget 2000, CR1 = 200 XP. n×200×mult(n): 5 -> 1000×2 = 2000 (fits), 6 -> 2400 (over).
    const cr1 = r.crCostTable.find((c) => c.cr === '1');
    expect(cr1?.fits.medium).toBe(5);
  });

  it('rejects a modern tier against a legacy probe', () => {
    expect(() => computeBudget(input([5], 'high'), legacyProbe())).toThrow(/legacy/);
  });
});

describe('dnd5e_calculate_encounter_budget — edge cases', () => {
  it('an empty suggestedMixes array is valid output, not an error', () => {
    // A 380-XP budget sits in a dead zone: it falls between the discrete
    // CR XP values for every template count, so none lands in the band.
    const probe: Dnd5eEncounterBudgetProbeOk = {
      ok: true,
      rulesVersion: 'modern',
      encounterDifficultyTable: new Array(21).fill([380, 380, 380]),
      crExpLevels: [...CR_EXP_LEVELS],
    };
    const r = computeBudget(input([1], 'low'), probe);
    expect(r.budgets.low).toBe(380);
    expect(r.suggestedMixes).toEqual([]);
    expect(r.crCostTable.length).toBeGreaterThan(0);
  });
});

describe('dnd5e_calculate_encounter_budget — input schema', () => {
  const schema = dnd5eCalculateEncounterBudgetTool.inputSchema;

  it('accepts a valid per-character party', () => {
    expect(schema.safeParse({ partyLevels: [3, 3, 4, 5], difficulty: 'moderate' }).success).toBe(
      true,
    );
  });

  it('rejects out-of-range levels, bad enum, empty/oversized arrays', () => {
    expect(schema.safeParse({ partyLevels: [0], difficulty: 'low' }).success).toBe(false);
    expect(schema.safeParse({ partyLevels: [21], difficulty: 'low' }).success).toBe(false);
    expect(schema.safeParse({ partyLevels: [5.5], difficulty: 'low' }).success).toBe(false);
    expect(schema.safeParse({ partyLevels: [], difficulty: 'low' }).success).toBe(false);
    expect(
      schema.safeParse({ partyLevels: new Array(13).fill(5), difficulty: 'low' }).success,
    ).toBe(false);
    expect(schema.safeParse({ partyLevels: [5], difficulty: 'nightmare' }).success).toBe(false);
  });

  it('accepts both editions’ tiers at the schema layer (edition check is live)', () => {
    for (const difficulty of ['low', 'moderate', 'high', 'easy', 'medium', 'hard', 'deadly']) {
      expect(schema.safeParse({ partyLevels: [5], difficulty }).success).toBe(true);
    }
  });

  it('rejects unexpected keys (.strict())', () => {
    expect(
      schema.safeParse({ partyLevels: [5], difficulty: 'low', extra: 'nope' }).success,
    ).toBe(false);
  });
});
