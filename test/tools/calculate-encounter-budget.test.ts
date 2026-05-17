import { describe, expect, it, vi } from 'vitest';
import {
  calculateEncounterBudgetTool,
  type CalculateEncounterBudgetResult,
} from '../../src/tools/calculate-encounter-budget.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';

function makeCtx(): { browser: BrowserSession; log: Logger } {
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // The handler never touches browser; the cast is intentional.
  return {
    browser: undefined as unknown as BrowserSession,
    log: log as unknown as Logger,
  };
}

async function run(input: {
  partyLevel: number;
  partySize: number;
  difficulty: string;
}): Promise<CalculateEncounterBudgetResult> {
  const ctx = makeCtx();
  const blocks = await calculateEncounterBudgetTool.handler(
    input as Parameters<typeof calculateEncounterBudgetTool.handler>[0],
    ctx,
  );
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe('text');
  return JSON.parse((blocks[0] as { text: string }).text) as CalculateEncounterBudgetResult;
}

describe('pf2e_calculate_encounter_budget', () => {
  it('moderate L5 party-of-4: 80 XP, no party-size adjustment', async () => {
    const r = await run({ partyLevel: 5, partySize: 4, difficulty: 'moderate' });
    expect(r.totalXp).toBe(80);
    expect(r.partySizeAdjustment).toBe(0);
    expect(r.partyLevel).toBe(5);
    expect(r.partySize).toBe(4);
    expect(r.difficulty).toBe('moderate');
  });

  it('party-size up: moderate L5 party-of-5 is 100 XP, +20', async () => {
    const r = await run({ partyLevel: 5, partySize: 5, difficulty: 'moderate' });
    expect(r.totalXp).toBe(100);
    expect(r.partySizeAdjustment).toBe(20);
  });

  it('party-size down: moderate L5 party-of-3 is 60 XP, -20', async () => {
    const r = await run({ partyLevel: 5, partySize: 3, difficulty: 'moderate' });
    expect(r.totalXp).toBe(60);
    expect(r.partySizeAdjustment).toBe(-20);
  });

  it('each difficulty at party-of-4 produces the GMG base budget', async () => {
    const expected: Record<string, number> = {
      trivial: 40,
      low: 60,
      moderate: 80,
      severe: 120,
      extreme: 160,
    };
    for (const [difficulty, totalXp] of Object.entries(expected)) {
      const r = await run({ partyLevel: 5, partySize: 4, difficulty });
      expect(r.totalXp, `difficulty=${difficulty}`).toBe(totalXp);
      expect(r.partySizeAdjustment, `difficulty=${difficulty}`).toBe(0);
    }
  });

  it('creatureCosts table matches GMG canon at PL+offset', async () => {
    const r = await run({ partyLevel: 5, partySize: 4, difficulty: 'moderate' });
    const byOffset = new Map(r.creatureCosts.map((c) => [c.relativeLevel, c.xpCost]));
    expect(byOffset.get(-4)).toBe(10);
    expect(byOffset.get(-3)).toBe(15);
    expect(byOffset.get(-2)).toBe(20);
    expect(byOffset.get(-1)).toBe(30);
    expect(byOffset.get(0)).toBe(40);
    expect(byOffset.get(1)).toBe(60);
    expect(byOffset.get(2)).toBe(80);
    expect(byOffset.get(3)).toBe(120);
    expect(byOffset.get(4)).toBe(160);
    expect(r.creatureCosts).toHaveLength(9);
  });

  it('omits entries whose absoluteLevel < -1 (GMG floor)', async () => {
    const r = await run({ partyLevel: 2, partySize: 4, difficulty: 'moderate' });
    const offsets = r.creatureCosts.map((c) => c.relativeLevel).sort((a, b) => a - b);
    // partyLevel=2, PL-4=level-2 (omit), PL-3=level-1 (keep), PL-2=level 0 (keep), ...
    expect(offsets).toEqual([-3, -2, -1, 0, 1, 2, 3, 4]);
    expect(r.creatureCosts.find((c) => c.relativeLevel === -3)?.absoluteLevel).toBe(-1);
  });

  it('formats creatureCost labels with signed offset and absolute level', async () => {
    const r = await run({ partyLevel: 5, partySize: 4, difficulty: 'moderate' });
    const byOffset = new Map(r.creatureCosts.map((c) => [c.relativeLevel, c.label]));
    expect(byOffset.get(0)).toBe('PL+0 (level 5)');
    expect(byOffset.get(-2)).toBe('PL-2 (level 3)');
    expect(byOffset.get(2)).toBe('PL+2 (level 7)');
    expect(byOffset.get(-4)).toBe('PL-4 (level 1)');
  });

  it('hazardCosts: simple = round(creature/5), complex = creature', async () => {
    const r = await run({ partyLevel: 5, partySize: 4, difficulty: 'moderate' });
    const haz = new Map(r.hazardCosts.map((h) => [h.relativeLevel, h]));
    expect(haz.get(0)).toEqual({ relativeLevel: 0, absoluteLevel: 5, simpleXp: 8, complexXp: 40 });
    expect(haz.get(1)).toEqual({ relativeLevel: 1, absoluteLevel: 6, simpleXp: 12, complexXp: 60 });
    expect(haz.get(-4)).toEqual({
      relativeLevel: -4,
      absoluteLevel: 1,
      simpleXp: 2,
      complexXp: 10,
    });
    expect(haz.get(-3)).toEqual({
      relativeLevel: -3,
      absoluteLevel: 2,
      simpleXp: 3,
      complexXp: 15,
    });
  });

  it('every suggestedMix sums to totalXp exactly', async () => {
    const cases: Array<{ partyLevel: number; partySize: number; difficulty: string }> = [
      { partyLevel: 5, partySize: 4, difficulty: 'moderate' },
      { partyLevel: 5, partySize: 5, difficulty: 'moderate' },
      { partyLevel: 1, partySize: 4, difficulty: 'severe' },
      { partyLevel: 10, partySize: 6, difficulty: 'extreme' },
    ];
    for (const input of cases) {
      const r = await run(input);
      for (const mix of r.suggestedMixes) {
        expect(mix.totalXp, `mix=${mix.label}, input=${JSON.stringify(input)}`).toBe(r.totalXp);
      }
    }
  });

  it('moderate L5 party-of-4 includes pair-of-equals (2x PL+0 = 80 XP)', async () => {
    const r = await run({ partyLevel: 5, partySize: 4, difficulty: 'moderate' });
    const pair = r.suggestedMixes.find((m) => m.label === 'pair-of-equals');
    expect(pair).toBeDefined();
    expect(pair?.creatures).toEqual([{ relativeLevel: 0, count: 2 }]);
    expect(pair?.totalXp).toBe(80);
  });

  it('suggestedMixes can be empty without erroring (trivial party-of-1 = 20 XP, no template fits)', async () => {
    const r = await run({ partyLevel: 5, partySize: 1, difficulty: 'trivial' });
    expect(r.totalXp).toBe(-20);
    expect(r.suggestedMixes).toEqual([]);
  });

  it('zod rejects out-of-range and bad-enum inputs', () => {
    const schema = calculateEncounterBudgetTool.inputSchema;
    expect(schema.safeParse({ partyLevel: 0, partySize: 4, difficulty: 'moderate' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ partyLevel: 26, partySize: 4, difficulty: 'moderate' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ partyLevel: 5, partySize: 0, difficulty: 'moderate' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ partyLevel: 5, partySize: 13, difficulty: 'moderate' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ partyLevel: 5, partySize: 4, difficulty: 'easy' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ partyLevel: 5.5, partySize: 4, difficulty: 'moderate' }).success,
    ).toBe(false);
  });

  it('zod rejects unexpected input keys (.strict())', () => {
    const parsed = calculateEncounterBudgetTool.inputSchema.safeParse({
      partyLevel: 5,
      partySize: 4,
      difficulty: 'moderate',
      extra: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});
