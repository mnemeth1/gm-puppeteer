import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  pf2eSetConditionValueBody,
  type Pf2eSetConditionValueResult,
} from '../evaluators/pf2e-set-condition-value.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `pf2e_set_condition_value`. Third tool in the condition-mutation
 * cluster (siblings: pf2e_apply_condition take-max, pf2e_remove_condition decrement/
 * clear). Absolute-set semantics: "set this valued condition to exactly
 * value N (clamped to effectiveMax)".
 *
 * Boundary validation:
 *   - `value` is `z.number().int().min(1)` — strict-int, no coerce, no
 *     zero. The zero case is routed to pf2e_remove_condition with
 *     mode: "remove"; mirrors pf2e_update_item_quantity's qty-0 policy.
 *   - `slug` is loosely validated as a non-empty string at the MCP edge;
 *     the evaluator validates against `game.pf2e.ConditionManager.
 *     conditionsSlugs` and rejects non-valued conditions with
 *     NON_VALUED_CONDITION_NOT_SUPPORTED (use apply/pf2e_remove_condition for
 *     those).
 *
 * No `silent` flag — neither increaseCondition nor updateEmbeddedDocuments
 * posts to chat in PF2e 8.1.2 (verified in pf2e_apply_condition and
 * pf2e_update_item_quantity probes).
 *
 * No `duration` parameter — same constraint as pf2e_apply_condition: PF2e
 * conditions carry uniform unlimited duration and the system does not
 * use the field for encounter-bound distinctions.
 */
const Pf2eSetConditionValueInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by pf2e_get_actor_state). The actor whose ' +
          'condition will be set. Must be a character, npc, or familiar; other actor types ' +
          '(party/loot/hazard/vehicle/army) are rejected.',
      ),
    slug: z
      .string()
      .min(1)
      .describe(
        'Canonical PF2e VALUED condition slug. Valued conditions: "frightened", "sickened", ' +
          '"stupefied", "slowed", "drained", "clumsy", "enfeebled", "stunned", "dying", ' +
          '"wounded", "doomed". Non-valued conditions (off-guard, prone, blinded, fascinated, ' +
          'etc.) are rejected with NON_VALUED_CONDITION_NOT_SUPPORTED — use pf2e_apply_condition ' +
          '(toggle on) or pf2e_remove_condition (toggle off) for those. "persistent-damage" is ' +
          "rejected because PF2e's mutation path opens a UI dialog for it. " +
          'See https://2e.aonprd.com/Conditions.aspx for canonical condition rules text.',
      ),
    value: z
      .number()
      .int()
      .min(1)
      .describe(
        'Target absolute value, integer >= 1. The condition will end up at exactly this value ' +
          "(clamped to the condition's effective max: 4 for non-vitals; " +
          'actor.system.attributes.{slug}.max for vitals, which doomed reduces dynamically). ' +
          'Clamped responses set clamped: true. value: 0 is rejected — use pf2e_remove_condition ' +
          'with mode: "remove" to clear a condition entirely.',
      ),
  })
  .strict();

export const pf2eSetConditionValueTool: ToolDefinition<typeof Pf2eSetConditionValueInput> = {
  name: 'pf2e_set_condition_value',
  description:
    'Set a PF2e valued condition to an absolute value on an actor. Third tool in the ' +
    'condition-mutation cluster (siblings: pf2e_apply_condition for take-max increment, ' +
    'pf2e_remove_condition for decrement-by-1 or clear). ' +
    'Fills the gap between the relative-change siblings: pf2e_apply_condition cannot lower a ' +
    'condition; pf2e_remove_condition only decrements by 1 or clears entirely. Use this when the GM ' +
    'wants an exact mid-encounter value ("frightened to 2"). ' +
    'Returns either {operation: "applied", condition, cascadeGranted?} when state changed, or ' +
    '{operation: "noop", condition, reason: "already_at_requested_value"} when the condition was ' +
    'already at the requested value (a clean no-op, NOT an error). ' +
    "cascadeGranted is surfaced ONLY when going up from absent (0 → N), because PF2e's " +
    'GrantItem cascade fires on item creation; raising or lowering an existing condition does ' +
    'not fire new cascades, and lowering does not delete cascade children (they persist until ' +
    'the parent condition is fully removed). ' +
    'Valued conditions only — non-valued (off-guard, prone, blinded, fascinated, etc.) are ' +
    'rejected with NON_VALUED_CONDITION_NOT_SUPPORTED; use pf2e_apply_condition / pf2e_remove_condition ' +
    'for those. ' +
    'value: 0 is rejected — use pf2e_remove_condition with mode: "remove" to clear. value is ' +
    'clamped to the effective max (4 for non-vitals; actor.system.attributes.{slug}.max for ' +
    'vitals, which doomed reduces). ' +
    'Take-max math applies to vitals (dying/wounded/doomed) too — the wounded-adds-to-dying ' +
    'RAW interaction is in actor.applyDamage and is NOT replicated here. ' +
    "'persistent-damage' is rejected. Rejected for actor types other than character/npc/" +
    'familiar. See https://2e.aonprd.com/Conditions.aspx for canonical condition rules text.',
  inputSchema: Pf2eSetConditionValueInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      slug: input.slug,
      value: input.value,
    };
    const result = (await page.evaluate(
      pf2eSetConditionValueBody,
      args,
    )) as Pf2eSetConditionValueResult;
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
        'pf2e_set_condition_value',
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
        'pf2e_set_condition_value',
      );
    }
    return [jsonText(result)];
  },
};
