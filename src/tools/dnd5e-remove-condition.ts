import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eRemoveConditionBody,
  type Dnd5eRemoveConditionResult,
} from '../evaluators/dnd5e-remove-condition.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_remove_condition`. The removal operation in the D&D 5e
 * condition-mutation cluster (siblings `dnd5e_apply_condition` and
 * `dnd5e_set_condition_value`).
 *
 * Boundary validation:
 *   - `statusId` is loosely validated as a non-empty string at the MCP
 *     edge; the evaluator validates it against `CONFIG.statusEffects` and
 *     rejects unknown ids with `STATUS_NOT_FOUND`. No client-side enum —
 *     the id list is dnd5e-system-owned and shifts between releases.
 *   - `mode` is only load-bearing for `exhaustion` (the one valued 5e
 *     condition). On the other 42 (non-valued) statuses both modes are
 *     identical — the status toggles off — so `mode` is accepted but inert.
 */
const Dnd5eRemoveConditionInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_state). The actor ' +
          'to remove the status from. Must be a character or npc; vehicle / group / ' +
          'encounter actors are rejected.',
      ),
    statusId: z
      .string()
      .min(1)
      .describe(
        'Canonical D&D 5e status id — the "statusId" field of a dnd5e_get_available_conditions ' +
          'row, or a "conditions" entry from dnd5e_get_actor_state. Examples: "prone", ' +
          '"poisoned", "blinded", "frightened", "unconscious", "exhaustion". Validated live ' +
          'against CONFIG.statusEffects.',
      ),
    mode: z
      .enum(['decrement', 'remove'])
      .default('decrement')
      .describe(
        'How to handle the one valued condition, exhaustion: "decrement" steps the level ' +
          'down by 1, "remove" clears it to 0. Inert on the 42 non-valued statuses — both ' +
          'modes simply toggle the status off. Defaults to "decrement".',
      ),
  })
  .strict();

export const dnd5eRemoveConditionTool: ToolDefinition<typeof Dnd5eRemoveConditionInput> = {
  name: 'dnd5e_remove_condition',
  description:
    'Remove — or, for exhaustion, decrement — a D&D 5e status on a character or npc. The ' +
    'removal operation in the D&D 5e condition-mutation cluster (sibling to ' +
    'dnd5e_apply_condition and dnd5e_set_condition_value). ' +
    'Returns {operation: "removed", condition, effectId, cascadeRemoved?} when a status ' +
    'fully came off (a non-valued status toggled off, or exhaustion written to 0); ' +
    '{operation: "decremented", condition, effectId} when exhaustion was lowered by 1 but ' +
    'is still above 0; or {operation: "noop", condition, reason} when the status was not ' +
    'present (or exhaustion was already 0) — a clean no-op, NOT an error. ' +
    'Non-valued statuses (42 of the 43) toggle off; "mode" does not affect them. exhaustion ' +
    'is the one valued condition: mode "decrement" steps it down 1, mode "remove" clears it ' +
    'to 0. Some conditions carry rider statuses (removing unconscious also removes the ' +
    'incapacitated rider) — riders the system dropped in the call are surfaced in ' +
    'cascadeRemoved. ' +
    'Pick statusId from dnd5e_get_actor_state (the actor\'s current conditions) or ' +
    'dnd5e_get_available_conditions; verify afterward with dnd5e_get_actor_state. Unknown ' +
    'statusId is rejected with STATUS_NOT_FOUND; vehicle / group / encounter actors with ' +
    'ACTOR_TYPE_UNSUPPORTED.',
  inputSchema: Dnd5eRemoveConditionInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      statusId: input.statusId,
      mode: input.mode,
    };
    const result = (await page.evaluate(
      dnd5eRemoveConditionBody,
      args,
    )) as Dnd5eRemoveConditionResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    if (result.operation === 'noop') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          statusId: result.condition.statusId,
          reason: result.reason,
        },
        'dnd5e_remove_condition',
      );
    } else if (result.operation === 'decremented') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          statusId: result.condition.statusId,
          previousValue: result.condition.previousValue,
          value: result.condition.value,
          effectId: result.effectId,
        },
        'dnd5e_remove_condition',
      );
    } else {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          statusId: result.condition.statusId,
          valued: result.condition.valued,
          previousValue: result.condition.previousValue,
          effectId: result.effectId,
          cascadeCount: result.cascadeRemoved?.length ?? 0,
        },
        'dnd5e_remove_condition',
      );
    }
    return [jsonText(result)];
  },
};
