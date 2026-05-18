import { z } from 'zod';
import { ToolError, toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eCalculateEncounterBudgetBody,
  type Dnd5eEncounterBudgetProbeOk,
  type Dnd5eEncounterBudgetProbeResult,
  type Dnd5eRulesVersion,
} from '../evaluators/dnd5e-calculate-encounter-budget.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * D&D 5e encounter-budget math. The sibling of pf2e_calculate_encounter_budget.
 *
 * Unlike the PF2e tool, this is NOT pure published math — it reads three
 * live values from the world (via the evaluator): the rules edition
 * (`dnd5e.rulesVersion`), CONFIG.DND5E.ENCOUNTER_DIFFICULTY (the 2024 DMG
 * per-character XP budget), and CONFIG.DND5E.CR_EXP_LEVELS (XP by CR).
 * Reading the modern table live means the tool inherits whatever budget
 * numbers the dnd5e system author maintains.
 *
 * Two editions, two models:
 *   - modern (2024 DMG): 3 tiers (low / moderate / high). The budget is a
 *     flat per-character XP sum; there is NO encounter-size multiplier.
 *     ENCOUNTER_DIFFICULTY[level] = [low, moderate, high] per character.
 *   - legacy (2014 DMG): 4 tiers (easy / medium / hard / deadly). The
 *     budget is a per-character XP threshold sum; a monster's *adjusted*
 *     XP is its raw XP times an encounter-size multiplier keyed off the
 *     monster count. The probe confirmed the dnd5e system ships no 2014
 *     table, so LEGACY_XP_THRESHOLDS below is hardcoded from DMG p.82.
 *
 * The 2014 DMG's party-size adjustment (shift the multiplier column for a
 * party smaller than 3 / larger than 5) is intentionally NOT applied — the
 * standard count-keyed multiplier column is used. This is surfaced in the
 * tool description and the result's `legacyMultiplier.note`.
 *
 * The budget math is all here (pure TS, runs in Node after the evaluator
 * returns) rather than in the evaluator body — see the evaluator JSDoc for
 * why. `computeBudget` is exported for direct unit testing.
 */

const MODERN_TIERS = ['low', 'moderate', 'high'] as const;
const LEGACY_TIERS = ['easy', 'medium', 'hard', 'deadly'] as const;
const ALL_TIERS = [...MODERN_TIERS, ...LEGACY_TIERS] as const;

type Tier = (typeof ALL_TIERS)[number];

/** Standard XP for the three fractional CRs, absent from CONFIG.DND5E.CR_EXP_LEVELS. */
const FRACTIONAL_CR: ReadonlyArray<{ cr: string; xp: number }> = [
  { cr: '1/8', xp: 25 },
  { cr: '1/4', xp: 50 },
  { cr: '1/2', xp: 100 },
];

/**
 * 2014 DMG p.82 "XP Thresholds by Character Level". Indexed by character
 * level; index 0 is a zero filler. Each row is [easy, medium, hard, deadly]
 * XP for ONE character. Hardcoded — the dnd5e system exposes no legacy table.
 */
const LEGACY_XP_THRESHOLDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 0],
  [25, 50, 75, 100],
  [50, 100, 150, 200],
  [75, 150, 225, 400],
  [125, 250, 375, 500],
  [250, 500, 750, 1100],
  [300, 600, 900, 1400],
  [350, 750, 1100, 1700],
  [450, 900, 1400, 2100],
  [550, 1100, 1600, 2400],
  [600, 1200, 1900, 2800],
  [800, 1600, 2400, 3600],
  [1000, 2000, 3000, 4500],
  [1100, 2200, 3400, 5100],
  [1250, 2500, 3800, 5700],
  [1400, 2800, 4300, 6400],
  [1600, 3200, 4800, 7200],
  [2000, 3900, 5900, 8800],
  [2100, 4200, 6300, 9500],
  [2400, 4900, 7300, 10900],
  [2800, 5700, 8500, 12700],
];

/** 2014 DMG p.82 encounter-size multiplier bands, keyed off the monster count. */
const LEGACY_MULTIPLIER_BANDS: ReadonlyArray<{
  minCount: number;
  maxCount: number | null;
  multiplier: number;
}> = [
  { minCount: 1, maxCount: 1, multiplier: 1 },
  { minCount: 2, maxCount: 2, multiplier: 1.5 },
  { minCount: 3, maxCount: 6, multiplier: 2 },
  { minCount: 7, maxCount: 10, multiplier: 2.5 },
  { minCount: 11, maxCount: 14, multiplier: 3 },
  { minCount: 15, maxCount: null, multiplier: 4 },
];

function multiplierForCount(count: number): number {
  for (const band of LEGACY_MULTIPLIER_BANDS) {
    if (count >= band.minCount && (band.maxCount === null || count <= band.maxCount)) {
      return band.multiplier;
    }
  }
  return 1;
}

/**
 * Encounter-shape skeletons. A `group` template is N equal creatures; a
 * `boss-group` template is one boss plus a group of weaker creatures. Roles
 * are output labels only — the resolver picks concrete CRs at runtime so
 * each mix's adjusted XP lands in the budget tolerance band.
 */
type MixTemplate =
  | { label: string; kind: 'group'; role: string; count: number }
  | {
      label: string;
      kind: 'boss-group';
      bossRole: string;
      groupRole: string;
      groupCount: number;
    };

const MIX_TEMPLATES: ReadonlyArray<MixTemplate> = [
  { label: 'solo-boss', kind: 'group', role: 'boss', count: 1 },
  { label: 'pair', kind: 'group', role: 'standard', count: 2 },
  { label: 'trio', kind: 'group', role: 'standard', count: 3 },
  { label: 'gang', kind: 'group', role: 'minion', count: 6 },
  { label: 'horde', kind: 'group', role: 'minion', count: 10 },
  {
    label: 'boss-and-lieutenants',
    kind: 'boss-group',
    bossRole: 'boss',
    groupRole: 'lieutenant',
    groupCount: 2,
  },
  {
    label: 'boss-and-minions',
    kind: 'boss-group',
    bossRole: 'boss',
    groupRole: 'minion',
    groupCount: 4,
  },
];

/** A mix is emitted only if its adjusted XP is at least this fraction of the budget. */
const MIX_BAND_FLOOR = 0.85;

const Dnd5eCalculateEncounterBudgetInput = z
  .object({
    partyLevels: z
      .array(z.number().int().min(1).max(20).describe('A single player character’s level, 1-20.'))
      .min(1)
      .max(12)
      .describe(
        'Per-character party levels — one array entry per PC (length 1-12). The encounter ' +
          'budget is the SUM of each PC’s own per-level budget/threshold, so mixed-level ' +
          'parties are handled exactly. This is NOT a uniform partyLevel + partySize pair. ' +
          'Example: [3,3,4,5] is a four-PC party of those levels.',
      ),
    difficulty: z
      .enum(ALL_TIERS)
      .describe(
        'Difficulty tier. The 2024 (modern) rules use low / moderate / high; the 2014 (legacy) ' +
          'rules use easy / medium / hard / deadly. The tool reads the world’s ' +
          'dnd5e.rulesVersion live and rejects a tier that does not belong to the active ' +
          'edition with INVALID_INPUT.',
      ),
  })
  .strict();

export type Dnd5eCalculateEncounterBudgetInputT = z.infer<
  typeof Dnd5eCalculateEncounterBudgetInput
>;

export interface CrCost {
  /** CR as a label: '0', '1/8', '1/4', '1/2', '1' ... '30'. */
  cr: string;
  xpPerCreature: number;
  /** Per tier: how many creatures of this CR the tier budget affords. */
  fits: Record<string, number>;
}

export interface MixCreature {
  role: string;
  cr: string;
  count: number;
  xpPerCreature: number;
}

export interface SuggestedMix {
  label: string;
  tier: string;
  creatures: MixCreature[];
  /** Total creature count across the mix. */
  creatureCount: number;
  /** Raw XP sum, before the legacy encounter-size multiplier. */
  rawXp: number;
  /** Encounter-size multiplier applied (always 1 under modern rules). */
  multiplier: number;
  /** rawXp * multiplier — the figure compared against the budget. */
  adjustedXp: number;
  budgetXp: number;
  /** adjustedXp / budgetXp, rounded to two decimals. */
  budgetFraction: number;
}

export interface LegacyMultiplierInfo {
  bands: Array<{ minCount: number; maxCount: number | null; multiplier: number }>;
  note: string;
}

export interface Dnd5eCalculateEncounterBudgetResult {
  rulesVersion: Dnd5eRulesVersion;
  /** Human-readable edition label. */
  edition: string;
  partyLevels: number[];
  partyCount: number;
  difficulty: Tier;
  /** XP budget per tier of the active edition (3 keys modern / 4 keys legacy). */
  budgets: Record<string, number>;
  crCostTable: CrCost[];
  /** Mix skeletons for the selected difficulty whose adjusted XP fills the budget band. */
  suggestedMixes: SuggestedMix[];
  /** Present only under legacy rules — the encounter-size multiplier model. */
  legacyMultiplier?: LegacyMultiplierInfo;
}

interface CrEntry {
  cr: string;
  xp: number;
}

/** Ordered CR -> XP map: CR 0, then the three fractional CRs, then CR 1..30. */
function buildCrMap(crExpLevels: number[]): CrEntry[] {
  const map: CrEntry[] = [];
  const cr0 = crExpLevels[0];
  if (typeof cr0 === 'number' && Number.isFinite(cr0)) map.push({ cr: '0', xp: cr0 });
  for (const f of FRACTIONAL_CR) map.push({ cr: f.cr, xp: f.xp });
  for (let c = 1; c < crExpLevels.length; c += 1) {
    const xp = crExpLevels[c];
    if (typeof xp === 'number' && Number.isFinite(xp)) map.push({ cr: String(c), xp });
  }
  return map;
}

/** How many creatures of `xp` each fit `budget`, multiplier-aware for legacy. */
function fitCount(budget: number, xp: number, rulesVersion: Dnd5eRulesVersion): number {
  if (xp <= 0 || budget <= 0) return 0;
  if (rulesVersion === 'modern') return Math.floor(budget / xp);
  // Legacy: n * xp * multiplier(n) is monotone increasing in n.
  let n = 0;
  for (let candidate = 1; candidate <= 200; candidate += 1) {
    if (candidate * xp * multiplierForCount(candidate) <= budget) n = candidate;
    else break;
  }
  return n;
}

function resolveTemplate(
  template: MixTemplate,
  budgetXp: number,
  tier: Tier,
  crMap: CrEntry[],
  rulesVersion: Dnd5eRulesVersion,
): SuggestedMix | null {
  const bandFloor = budgetXp * MIX_BAND_FLOOR;
  const multOf = (count: number): number =>
    rulesVersion === 'modern' ? 1 : multiplierForCount(count);

  if (template.kind === 'group') {
    const count = template.count;
    const multiplier = multOf(count);
    let best: { cr: string; xp: number; rawXp: number; adjustedXp: number } | null = null;
    for (const entry of crMap) {
      const rawXp = count * entry.xp;
      const adjustedXp = rawXp * multiplier;
      if (adjustedXp > budgetXp || adjustedXp < bandFloor) continue;
      if (!best || adjustedXp > best.adjustedXp) {
        best = { cr: entry.cr, xp: entry.xp, rawXp, adjustedXp };
      }
    }
    if (!best) return null;
    return {
      label: template.label,
      tier,
      creatures: [{ role: template.role, cr: best.cr, count, xpPerCreature: best.xp }],
      creatureCount: count,
      rawXp: best.rawXp,
      multiplier,
      adjustedXp: best.adjustedXp,
      budgetXp,
      budgetFraction: Math.round((best.adjustedXp / budgetXp) * 100) / 100,
    };
  }

  // boss-group: one boss + `groupCount` weaker creatures.
  const totalCount = 1 + template.groupCount;
  const multiplier = multOf(totalCount);
  let best: {
    bossCr: string;
    bossXp: number;
    groupCr: string;
    groupXp: number;
    rawXp: number;
    adjustedXp: number;
  } | null = null;
  for (const boss of crMap) {
    for (const minion of crMap) {
      if (minion.xp >= boss.xp) continue; // the boss must be strictly bigger
      const rawXp = boss.xp + template.groupCount * minion.xp;
      const adjustedXp = rawXp * multiplier;
      if (adjustedXp > budgetXp || adjustedXp < bandFloor) continue;
      if (!best || adjustedXp > best.adjustedXp) {
        best = {
          bossCr: boss.cr,
          bossXp: boss.xp,
          groupCr: minion.cr,
          groupXp: minion.xp,
          rawXp,
          adjustedXp,
        };
      }
    }
  }
  if (!best) return null;
  return {
    label: template.label,
    tier,
    creatures: [
      { role: template.bossRole, cr: best.bossCr, count: 1, xpPerCreature: best.bossXp },
      {
        role: template.groupRole,
        cr: best.groupCr,
        count: template.groupCount,
        xpPerCreature: best.groupXp,
      },
    ],
    creatureCount: totalCount,
    rawXp: best.rawXp,
    multiplier,
    adjustedXp: best.adjustedXp,
    budgetXp,
    budgetFraction: Math.round((best.adjustedXp / budgetXp) * 100) / 100,
  };
}

/**
 * Pure budget computation. Throws on a difficulty tier that does not belong
 * to the probe's rules edition — the tool handler validates that first and
 * raises a friendlier ToolError, so a throw here is a defensive backstop
 * (and the seam unit tests exercise directly).
 */
export function computeBudget(
  input: Dnd5eCalculateEncounterBudgetInputT,
  probe: Dnd5eEncounterBudgetProbeOk,
): Dnd5eCalculateEncounterBudgetResult {
  const { partyLevels, difficulty } = input;
  const { rulesVersion } = probe;
  const tiers = rulesVersion === 'modern' ? MODERN_TIERS : LEGACY_TIERS;
  const tierIndex = (tiers as readonly string[]).indexOf(difficulty);
  if (tierIndex === -1) {
    throw new Error(
      `Difficulty '${difficulty}' does not belong to the ${rulesVersion} rules edition ` +
        `(valid tiers: ${tiers.join(', ')}).`,
    );
  }

  // -- Per-tier budgets: sum each PC's per-level row entry.
  const budgets: Record<string, number> = {};
  for (let i = 0; i < tiers.length; i += 1) {
    let sum = 0;
    for (const level of partyLevels) {
      const row =
        rulesVersion === 'modern'
          ? probe.encounterDifficultyTable[level]
          : LEGACY_XP_THRESHOLDS[level];
      const cell = row?.[i];
      sum += typeof cell === 'number' && Number.isFinite(cell) ? cell : 0;
    }
    budgets[tiers[i] as string] = sum;
  }

  // -- CR cost table.
  const crMap = buildCrMap(probe.crExpLevels);
  const crCostTable: CrCost[] = crMap.map((entry) => {
    const fits: Record<string, number> = {};
    for (const tier of tiers) fits[tier] = fitCount(budgets[tier] ?? 0, entry.xp, rulesVersion);
    return { cr: entry.cr, xpPerCreature: entry.xp, fits };
  });

  // -- Suggested mixes for the selected difficulty.
  const budgetXp = budgets[difficulty] ?? 0;
  const suggestedMixes: SuggestedMix[] = [];
  for (const template of MIX_TEMPLATES) {
    const mix = resolveTemplate(template, budgetXp, difficulty, crMap, rulesVersion);
    if (mix) suggestedMixes.push(mix);
  }

  const result: Dnd5eCalculateEncounterBudgetResult = {
    rulesVersion,
    edition: rulesVersion === 'modern' ? '2024 (modern)' : '2014 (legacy)',
    partyLevels: [...partyLevels],
    partyCount: partyLevels.length,
    difficulty,
    budgets,
    crCostTable,
    suggestedMixes,
  };
  if (rulesVersion === 'legacy') {
    result.legacyMultiplier = {
      bands: LEGACY_MULTIPLIER_BANDS.map((b) => ({ ...b })),
      note:
        'Each suggested mix’s adjustedXp already has the encounter-size multiplier ' +
        'applied; adjustedXp = rawXp × multiplier(creatureCount). The 2014 DMG ' +
        'party-size column adjustment (for parties smaller than 3 or larger than 5) is ' +
        'NOT applied.',
    };
  }
  return result;
}

export const dnd5eCalculateEncounterBudgetTool: ToolDefinition<
  typeof Dnd5eCalculateEncounterBudgetInput
> = {
  name: 'dnd5e_calculate_encounter_budget',
  description:
    'Compute a D&D 5e encounter XP budget for a party. Reads the world’s rules edition ' +
    'live (dnd5e.rulesVersion) and branches: 2024 (modern) rules return a three-tier ' +
    'low/moderate/high per-character XP budget; 2014 (legacy) rules return a four-tier ' +
    'easy/medium/hard/deadly XP-threshold budget plus the encounter-size multiplier model. ' +
    'partyLevels is PER-CHARACTER — one array entry per PC — and the budget is the ' +
    'sum of each PC’s own level budget, so mixed-level parties work directly. Returns the ' +
    'XP budgets for every tier of the active edition, a CR→XP cost table (covering ' +
    'fractional CRs 1/8, 1/4, 1/2 and integer CR 0-30) with a per-tier "how many of this CR ' +
    'fit" count, and a list of suggested creature-mix skeletons for the requested difficulty ' +
    '(solo-boss, pair, trio, gang, horde, boss-and-lieutenants, boss-and-minions). Each mix ' +
    'is a SKELETON, not a roster — the LLM still picks actual creatures fitting the ' +
    'scene and theme. A mix is shown only if its adjusted XP fills ~85-100% of the budget; ' +
    'an empty suggestedMixes array is valid (compose from crCostTable directly). Under ' +
    'legacy rules a mix’s adjustedXp already bakes in the encounter-size multiplier ' +
    '(adjustedXp = rawXp × multiplier(creatureCount)); the 2014 party-size column ' +
    'adjustment is not applied. The difficulty tier must match the active edition — a ' +
    'legacy tier on a modern world (or vice versa) is rejected with INVALID_INPUT. ' +
    'Not for: choosing specific creatures (use dnd5e_search_compendium + ' +
    'dnd5e_get_creature_details), rolling random encounters, or computing treasure budgets.',
  inputSchema: Dnd5eCalculateEncounterBudgetInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const probe = (await page.evaluate(
      dnd5eCalculateEncounterBudgetBody,
    )) as Dnd5eEncounterBudgetProbeResult;
    if (!probe.ok) {
      throw toolErrorFromEvaluator(probe.error);
    }

    const tiers = probe.rulesVersion === 'modern' ? MODERN_TIERS : LEGACY_TIERS;
    if (!(tiers as readonly string[]).includes(input.difficulty)) {
      throw new ToolError(
        'INVALID_INPUT',
        `Difficulty '${input.difficulty}' is not valid for the ${probe.rulesVersion} rules ` +
          `edition this world runs. Valid tiers: ${tiers.join(', ')}.`,
        {
          difficulty: input.difficulty,
          rulesVersion: probe.rulesVersion,
          validTiers: [...tiers],
          reason: 'TIER_EDITION_MISMATCH',
        },
      );
    }

    const result = computeBudget(input, probe);
    ctx.log.info(
      {
        rulesVersion: result.rulesVersion,
        partyCount: result.partyCount,
        difficulty: result.difficulty,
        budgetXp: result.budgets[result.difficulty],
        mixCount: result.suggestedMixes.length,
      },
      'dnd5e_calculate_encounter_budget',
    );
    return [jsonText(result)];
  },
};
