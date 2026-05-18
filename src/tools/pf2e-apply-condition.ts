import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  pf2eApplyConditionBody,
  type Pf2eApplyConditionResult,
} from '../evaluators/pf2e-apply-condition.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `pf2e_apply_condition`. First tool in the condition-mutation
 * cluster (siblings `pf2e_remove_condition` and `pf2e_set_condition_value` to
 * follow). Take-max semantics: "ensure this condition is at value N
 * or above; otherwise no change."
 *
 * Boundary validation:
 *   - `value` is `z.number().int().positive()` — strict-int, no coerce,
 *     no zero. Omitted on valued conditions defaults to 1 in the
 *     evaluator. Passed on a non-valued condition is rejected with the
 *     dedicated `VALUE_ON_NON_VALUED_CONDITION` reason.
 *   - `slug` is loosely validated as a non-empty string at the MCP edge;
 *     the evaluator validates against `game.pf2e.ConditionManager.
 *     conditionsSlugs` (44 entries in PF2e 8.1.2) and rejects with
 *     `CONDITION_NOT_FOUND`. No client-side slug enum because the slug
 *     list is PF2e-system-owned and could change between PF2e releases.
 *
 * No `silent` flag — Phase 1 confirmed that `actor.increaseCondition`
 * does NOT post to chat in PF2e 8.1.2. Nothing to suppress.
 *
 * No `source` / `grantedBy` parameter — pf2e_apply_condition is direct
 * application, not effect-cascade-grant. Use foundry_eval with raw
 * createEmbeddedDocuments if a manual grantedBy chain is needed.
 *
 * No `duration` parameter — PF2e conditions carry a uniform
 * `duration: {value: -1, unit: "unlimited"}` in their compendium
 * template, and PF2e does not use the field for "encounter-bound vs
 * permanent" distinctions (the EffectTracker handles that for effects,
 * not conditions). Surfaced or not, no API path to override duration on
 * a condition.
 */
const Pf2eApplyConditionInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by pf2e_get_actor_state). The actor that will ' +
          'receive the condition. Must be a character, npc, or familiar; other actor types ' +
          '(party/loot/hazard/vehicle/army) are rejected.',
      ),
    slug: z
      .string()
      .min(1)
      .describe(
        'Canonical PF2e condition slug. Examples: "frightened", "off-guard", "dying", "stupefied", ' +
          '"sickened", "prone", "fascinated", "blinded". Validated against the system\'s slug ' +
          'list (game.pf2e.ConditionManager.conditionsSlugs — 44 entries in PF2e 8.1.2). For rules ' +
          'text on a specific condition see https://2e.aonprd.com/Conditions.aspx. ' +
          '"persistent-damage" is rejected because PF2e\'s increaseCondition path opens a UI ' +
          'dialog for it; use foundry_eval for persistent damage in v1.',
      ),
    value: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'For valued conditions (frightened, sickened, stupefied, slowed, drained, clumsy, ' +
          'enfeebled, dying, wounded, doomed): the target value. Take-max semantics — the tool ' +
          "sets the condition to max(current, value), clamped to the condition's effective max " +
          '(4 for most non-vitals; actor.system.attributes.{slug}.max for vitals, which doomed ' +
          'reduces). Defaults to 1 if omitted. For non-valued conditions (off-guard, prone, ' +
          'blinded, fascinated, etc.), passing value is rejected with ' +
          'VALUE_ON_NON_VALUED_CONDITION. Must be a positive integer.',
      ),
  })
  .strict();

export const pf2eApplyConditionTool: ToolDefinition<typeof Pf2eApplyConditionInput> = {
  name: 'pf2e_apply_condition',
  description:
    'Apply a PF2e condition to an actor. First tool in the condition-mutation cluster (sibling to ' +
    'pf2e_remove_condition and pf2e_set_condition_value). Take-max semantics: the actor ends up at ' +
    'max(current, value) for valued conditions, clamped to the effective max; non-valued ' +
    'conditions are toggled on if absent. ' +
    'Returns either {operation: "applied", condition, cascadeGranted?} when state changed, or ' +
    '{operation: "noop", condition, reason} when the actor was already at or above the requested ' +
    "value (a clean no-op, NOT an error). Mirrors pf2e_update_item_quantity's no-op-as-success " +
    'precedent. ' +
    'Cascade effects (e.g. dying spawns unconscious, which spawns blinded + prone) are surfaced in ' +
    'cascadeGranted as a transitive closure of every condition that landed in the call. ' +
    'Take-max applies to vitals (dying/wounded/doomed) too — the wounded-adds-to-dying RAW ' +
    'interaction is in actor.applyDamage and is NOT replicated here. Caller computes the desired ' +
    'final state. ' +
    "Valued conditions: 'value' is the target. Defaults to 1. Non-valued: 'value' must be " +
    'omitted. ' +
    "'persistent-damage' is rejected in v1 (PF2e opens a UI dialog for it). Use foundry_eval for " +
    'persistent damage manipulation. ' +
    'Rejected for actor types other than character/npc/familiar. Bogus slugs are rejected with ' +
    'CONDITION_NOT_FOUND. See https://2e.aonprd.com/Conditions.aspx for canonical condition rules ' +
    'text.',
  inputSchema: Pf2eApplyConditionInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      slug: input.slug,
      value: input.value ?? null,
    };
    const result = (await page.evaluate(pf2eApplyConditionBody, args)) as Pf2eApplyConditionResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    if (result.operation === 'applied') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          slug: result.condition.slug,
          conditionId: result.condition.id,
          previousValue: result.condition.previousValue,
          existedBefore: result.condition.existedBefore,
          valueRequested: result.condition.valueRequested,
          valueApplied: result.condition.valueApplied,
          clamped: result.condition.clamped,
          cascadeCount: result.cascadeGranted?.length ?? 0,
        },
        'pf2e_apply_condition',
      );
    } else {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          slug: result.condition.slug,
          conditionId: result.condition.id,
          currentValue: result.condition.value,
          reason: result.reason,
        },
        'pf2e_apply_condition',
      );
    }
    return [jsonText(result)];
  },
};
