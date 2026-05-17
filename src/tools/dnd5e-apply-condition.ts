import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eApplyConditionBody,
  type Dnd5eApplyConditionResult,
} from '../evaluators/dnd5e-apply-condition.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_apply_condition`. The take-max apply operation in the
 * D&D 5e condition-mutation cluster (siblings `dnd5e_remove_condition` and
 * `dnd5e_set_condition_value` to follow).
 *
 * Boundary validation:
 *   - `statusId` is loosely validated as a non-empty string at the MCP
 *     edge; the evaluator validates it against `CONFIG.statusEffects` and
 *     rejects unknown ids with `STATUS_NOT_FOUND`. No client-side enum —
 *     the id list is dnd5e-system-owned and shifts between releases.
 *   - `value` is `z.number().int().positive()` — strict-int, no zero. It
 *     is only meaningful for `exhaustion` (the one valued 5e condition);
 *     passed on any other status it is rejected with
 *     `VALUE_ON_NON_VALUED_CONDITION`.
 */
const Dnd5eApplyConditionInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_state). The actor ' +
          'that will receive the status. Must be a character or npc; vehicle / group / ' +
          'encounter actors are rejected.',
      ),
    statusId: z
      .string()
      .min(1)
      .describe(
        'Canonical D&D 5e status id — the "statusId" field of a dnd5e_get_available_conditions ' +
          'row. Examples: "prone", "poisoned", "blinded", "frightened", "unconscious", ' +
          '"exhaustion", "concentrating", "dead". Validated live against CONFIG.statusEffects.',
      ),
    value: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Exhaustion level (1-6). Only meaningful for statusId "exhaustion" — the only valued ' +
          'D&D 5e condition. Take-max semantics: exhaustion ends at max(current, value), clamped ' +
          'to 6. Defaults to 1 if omitted. Passing value on any other (non-valued) status is ' +
          'rejected with VALUE_ON_NON_VALUED_CONDITION.',
      ),
  })
  .strict();

export const dnd5eApplyConditionTool: ToolDefinition<typeof Dnd5eApplyConditionInput> = {
  name: 'dnd5e_apply_condition',
  description:
    'Apply a D&D 5e status — a core condition, a pseudo-condition, or a plain status — to a ' +
    'character or npc. The take-max apply operation in the D&D 5e condition-mutation cluster ' +
    '(sibling to dnd5e_remove_condition and dnd5e_set_condition_value). ' +
    'Returns either {operation: "applied", condition, effectId, cascadeApplied?} when state ' +
    'changed, or {operation: "noop", condition, reason} when the status was already present ' +
    '(or exhaustion was already at/above the requested level) — a clean no-op, NOT an error. ' +
    'Non-valued statuses (42 of the 43) toggle on; re-applying one is a noop with reason ' +
    '"already_present". exhaustion is the one valued condition: pass "value" (1-6) for the ' +
    'target level, take-max semantics, default 1; re-applying at or below the current level is ' +
    'a noop with reason "already_at_or_above_requested_value". ' +
    'Some conditions carry rider statuses (applying unconscious also applies incapacitated) — ' +
    'riders that landed in the call are surfaced in cascadeApplied. ' +
    'Pick statusId from dnd5e_get_available_conditions; verify applied conditions afterward ' +
    'with dnd5e_get_actor_state. Unknown statusId is rejected with STATUS_NOT_FOUND; passing ' +
    'value on a non-valued status with VALUE_ON_NON_VALUED_CONDITION; vehicle / group / ' +
    'encounter actors with ACTOR_TYPE_UNSUPPORTED.',
  inputSchema: Dnd5eApplyConditionInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      statusId: input.statusId,
      value: input.value ?? null,
    };
    const result = (await page.evaluate(
      dnd5eApplyConditionBody,
      args,
    )) as Dnd5eApplyConditionResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    if (result.operation === 'applied') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          statusId: result.condition.statusId,
          valued: result.condition.valued,
          previousValue: result.condition.previousValue,
          existedBefore: result.condition.existedBefore,
          valueRequested: result.condition.valueRequested,
          valueApplied: result.condition.valueApplied,
          clamped: result.condition.clamped,
          effectId: result.effectId,
          cascadeCount: result.cascadeApplied?.length ?? 0,
        },
        'dnd5e_apply_condition',
      );
    } else {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          statusId: result.condition.statusId,
          currentValue: result.condition.value,
          reason: result.reason,
        },
        'dnd5e_apply_condition',
      );
    }
    return [jsonText(result)];
  },
};
