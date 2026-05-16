import { z } from 'zod';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * GMG encounter-building constants. Single source of truth for the
 * math this tool encodes. Lifted from Gamemastery Guide pp.488-491
 * (encounter budget) and p.74 (hazard XP).
 *
 *   - BASE_BUDGETS: total XP for a party of 4 at each difficulty.
 *   - PARTY_SIZE_DELTA: ±XP per character above/below 4. Applied to
 *     the base budget AND interpreted by the GMG as "treat the
 *     adjusted budget as if it were a party of 4 — the per-creature
 *     cost table is the same."
 *   - CREATURE_XP_BY_OFFSET: per-creature XP at the given relative
 *     level (party level + offset). PL+4 is boss-tier — roughly the
 *     whole moderate budget on its own; the GMG warns against
 *     using it for anything below severe.
 *
 * No Foundry probing applies — this is canonical published math, not
 * a live-API surface.
 */
const BASE_BUDGETS = {
  trivial: 40,
  low: 60,
  moderate: 80,
  severe: 120,
  extreme: 160,
} as const;

const PARTY_SIZE_DELTA = 20;

const CREATURE_XP_BY_OFFSET: Readonly<Record<number, number>> = {
  [-4]: 10,
  [-3]: 15,
  [-2]: 20,
  [-1]: 30,
  [0]: 40,
  [1]: 60,
  [2]: 80,
  [3]: 120,
  [4]: 160,
};

const RELATIVE_LEVELS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

/**
 * Static template list for `suggestedMixes`. Each template is a
 * named recipe of relative-level counts; the tool emits it ONLY if
 * (a) its XP sum equals the input's totalXp exactly and (b) every
 * referenced relativeLevel survives the "absolute level >= -1"
 * filter for the input partyLevel. If no template fits, the array
 * is empty — that is informative, not an error. The mix list is
 * intentionally a small set of common encounter shapes; it is a
 * skeleton, not a roster.
 */
type MixTemplate = {
  readonly label: string;
  readonly creatures: ReadonlyArray<{ readonly relativeLevel: number; readonly count: number }>;
};

const MIX_TEMPLATES: ReadonlyArray<MixTemplate> = [
  { label: 'solo-boss', creatures: [{ relativeLevel: 4, count: 1 }] },
  {
    label: 'boss-and-lieutenant',
    creatures: [
      { relativeLevel: 3, count: 1 },
      { relativeLevel: -1, count: 1 },
    ],
  },
  {
    label: 'boss-and-minions',
    creatures: [
      { relativeLevel: 2, count: 1 },
      { relativeLevel: -2, count: 2 },
    ],
  },
  { label: 'pair-of-equals', creatures: [{ relativeLevel: 0, count: 2 }] },
  { label: 'gang', creatures: [{ relativeLevel: -2, count: 4 }] },
  { label: 'swarm', creatures: [{ relativeLevel: -4, count: 8 }] },
  {
    label: 'lieutenant-and-troops',
    creatures: [
      { relativeLevel: 1, count: 1 },
      { relativeLevel: -2, count: 1 },
    ],
  },
  { label: 'duo-tough', creatures: [{ relativeLevel: 1, count: 2 }] },
];

const DIFFICULTY_VALUES = ['trivial', 'low', 'moderate', 'severe', 'extreme'] as const;

const CalculateEncounterBudgetInput = z
  .object({
    partyLevel: z
      .number()
      .int()
      .min(1)
      .max(25)
      .describe(
        "The party's level (1-25, PF2e standard range). The encounter budget table is keyed off " +
          'this; per-creature XP costs are computed at PL+offset for each offset in [-4,+4]. The ' +
          'tool does not validate that the party is actually at this level; trust the caller.',
      ),
    partySize: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe(
        'Number of player characters in the party (1-12). The GMG baseline is 4; the total XP ' +
          'budget shifts by ±20 XP per character above or below 4 (per-creature costs do NOT ' +
          'shift — they remain keyed to the party LEVEL). Fractional parties (e.g., counting a ' +
          'companion as 0.5) are not supported; round to taste before calling.',
      ),
    difficulty: z
      .enum(DIFFICULTY_VALUES)
      .describe(
        'GMG difficulty band. Maps to a party-of-4 XP budget of 40/60/80/120/160 for ' +
          'trivial/low/moderate/severe/extreme respectively, then adjusted by partySize.',
      ),
  })
  .strict();

export interface CreatureCost {
  relativeLevel: number;
  absoluteLevel: number;
  xpCost: number;
  label: string;
}

export interface HazardCost {
  relativeLevel: number;
  absoluteLevel: number;
  simpleXp: number;
  complexXp: number;
}

export interface SuggestedMix {
  label: string;
  creatures: Array<{ relativeLevel: number; count: number }>;
  totalXp: number;
}

export interface CalculateEncounterBudgetResult {
  partyLevel: number;
  partySize: number;
  difficulty: (typeof DIFFICULTY_VALUES)[number];
  totalXp: number;
  partySizeAdjustment: number;
  creatureCosts: CreatureCost[];
  hazardCosts: HazardCost[];
  suggestedMixes: SuggestedMix[];
}

function formatOffset(offset: number): string {
  if (offset === 0) return 'PL+0';
  return offset > 0 ? `PL+${offset}` : `PL${offset}`;
}

function computeBudget(
  input: z.infer<typeof CalculateEncounterBudgetInput>,
): CalculateEncounterBudgetResult {
  const { partyLevel, partySize, difficulty } = input;
  const partySizeAdjustment = (partySize - 4) * PARTY_SIZE_DELTA;
  const totalXp = BASE_BUDGETS[difficulty] + partySizeAdjustment;

  const creatureCosts: CreatureCost[] = [];
  const hazardCosts: HazardCost[] = [];
  for (const relativeLevel of RELATIVE_LEVELS) {
    const absoluteLevel = partyLevel + relativeLevel;
    if (absoluteLevel < -1) continue;
    const xpCost = CREATURE_XP_BY_OFFSET[relativeLevel]!;
    creatureCosts.push({
      relativeLevel,
      absoluteLevel,
      xpCost,
      label: `${formatOffset(relativeLevel)} (level ${absoluteLevel})`,
    });
    hazardCosts.push({
      relativeLevel,
      absoluteLevel,
      simpleXp: Math.round(xpCost / 5),
      complexXp: xpCost,
    });
  }

  const survivingOffsets = new Set(creatureCosts.map((c) => c.relativeLevel));
  const suggestedMixes: SuggestedMix[] = [];
  for (const template of MIX_TEMPLATES) {
    const allOffsetsAllowed = template.creatures.every((c) =>
      survivingOffsets.has(c.relativeLevel),
    );
    if (!allOffsetsAllowed) continue;
    const mixXp = template.creatures.reduce(
      (sum, c) => sum + CREATURE_XP_BY_OFFSET[c.relativeLevel]! * c.count,
      0,
    );
    if (mixXp !== totalXp) continue;
    suggestedMixes.push({
      label: template.label,
      creatures: template.creatures.map((c) => ({ ...c })),
      totalXp: mixXp,
    });
  }

  return {
    partyLevel,
    partySize,
    difficulty,
    totalXp,
    partySizeAdjustment,
    creatureCosts,
    hazardCosts,
    suggestedMixes,
  };
}

export const calculateEncounterBudgetTool: ToolDefinition<typeof CalculateEncounterBudgetInput> = {
  name: 'calculate_encounter_budget',
  description:
    'Encode the PF2e Gamemastery Guide encounter-budget math. Given a partyLevel (1-25), ' +
    'partySize (1-12), and difficulty (trivial/low/moderate/severe/extreme), return the total ' +
    'XP budget (with ±20-per-extra-character party-size adjustment), a per-creature XP cost ' +
    'table at each relative party-level offset PL-4..PL+4, matching hazard XP costs (simple = ' +
    'round(creature/5), complex = creature), and a small list of suggested mix skeletons that ' +
    'hit the budget exactly (e.g., solo-boss, pair-of-equals, boss-and-minions). ' +
    'Pure math — does not touch Foundry. ' +
    'Entries whose absoluteLevel would fall below -1 are omitted (PF2e creature floor). ' +
    'suggestedMixes is a SKELETON, not a roster — the LLM still has to pick actual creatures ' +
    "that fit the GM's scene and theme. An empty suggestedMixes array means no template hit " +
    'the budget exactly; the caller can compose from the creatureCosts table directly. ' +
    'Not for: choosing specific creatures (use search_compendium + the upcoming ' +
    'get_creature_details), rolling random encounters (that is the roll-tables cluster — ' +
    'deferring to dice skips the AI thematic-curation step), or computing treasure budgets ' +
    '(separate concern). Fractional party sizes are not supported.',
  inputSchema: CalculateEncounterBudgetInput,
  async handler(input, ctx) {
    const result = computeBudget(input);
    ctx.log.info(
      {
        partyLevel: result.partyLevel,
        partySize: result.partySize,
        difficulty: result.difficulty,
        totalXp: result.totalXp,
        mixCount: result.suggestedMixes.length,
      },
      'calculate_encounter_budget',
    );
    return [jsonText(result)];
  },
};
