import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  removeConditionBody,
  type RemoveConditionResult,
} from '../evaluators/remove-condition.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `remove_condition`. Counterpart to apply_condition in the
 * condition-mutation cluster. Decrement-by-1 or full-remove semantics over
 * PF2e's `actor.decreaseCondition(slug, {forceRemove?})`.
 *
 * Boundary validation:
 *   - `slug` XOR `conditionId` — exactly one must be set. The `.refine`
 *     produces a clean MCP-edge error before the evaluator runs.
 *   - `mode` defaults to `"decrement"`. Callers wanting a full delete pass
 *     `mode: "remove"`. On non-valued conditions both modes are silently
 *     equivalent.
 *   - Slugs are not enumerated in the schema because the slug list is
 *     PF2e-system-owned (could change between PF2e releases). The evaluator
 *     validates against `game.pf2e.ConditionManager.conditionsSlugs` and
 *     rejects unknown values with `CONDITION_NOT_FOUND`.
 *
 * No `force` or `quiet` flag. `decreaseCondition` does not post to chat
 * (Phase 1 — same as `increaseCondition`), so there's nothing to
 * suppress.
 */
const RemoveConditionInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by get_actor_state). The actor whose ' +
          'condition will be removed or decremented. Must be a character, npc, or familiar; other ' +
          'actor types (party/loot/hazard/vehicle/army) are rejected.',
      ),
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Canonical PF2e condition slug to remove. Examples: "frightened", "off-guard", "dying", ' +
          '"stupefied", "prone". Validated against the system\'s slug list (game.pf2e.' +
          'ConditionManager.conditionsSlugs). Mutually exclusive with conditionId — pass exactly ' +
          'one. If the condition is not on the actor, the result is a clean no-op (NOT an error). ' +
          '"persistent-damage" is rejected; use foundry_eval for persistent-damage in v1.',
      ),
    conditionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Embedded condition item's id on the actor (matches the id field from get_actor_state's " +
          'condition entries). Use this form when you have already read the actor state and want ' +
          'to remove a specific condition instance — unambiguous in cases where multiple ' +
          'same-slug items might co-exist. Mutually exclusive with slug.',
      ),
    mode: z
      .enum(['decrement', 'remove'])
      .default('decrement')
      .describe(
        '"decrement" reduces a valued condition by 1 (frightened 3 → 2) or deletes it when at 1; ' +
          '"remove" deletes the condition outright regardless of value. On non-valued conditions ' +
          '(prone, off-guard, blinded, etc.) the two modes are silently equivalent — the condition ' +
          'is deleted either way. Defaults to "decrement".',
      ),
  })
  .strict()
  .refine((v) => Boolean(v.slug) !== Boolean(v.conditionId), {
    message: "Provide exactly one of 'slug' or 'conditionId'.",
  });

export const removeConditionTool: ToolDefinition<typeof RemoveConditionInput> = {
  name: 'remove_condition',
  description:
    'Decrement or remove a PF2e condition on an actor. Counterpart to apply_condition. ' +
    'Modes: "decrement" (default) reduces a valued condition by 1 or deletes it when at 1; ' +
    '"remove" deletes outright. Non-valued conditions (prone, off-guard, etc.) silently collapse ' +
    'both modes to a full delete — no error on decrement-of-non-valued. ' +
    "Target the condition by 'slug' (natural form, e.g. 'frightened') or by 'conditionId' (the " +
    "id field returned by get_actor_state); exactly one is required. " +
    'Returns one of three operations: {operation: "removed", condition, cascadeDeleted?} when the ' +
    'condition was fully deleted (cascadeDeleted lists children auto-removed by PF2e, e.g. blinded ' +
    'and prone when unconscious is removed); {operation: "decremented", condition} when a valued ' +
    'condition still has value > 0 after the decrement; {operation: "noop", slug, reason: ' +
    '"not_present"} when the condition was not on the actor (a clean no-op, NOT an error — mirrors ' +
    "apply_condition's noop-as-success precedent). " +
    'Vitals (dying/wounded/doomed) route through the attribute path correctly inside ' +
    'decreaseCondition; the new attribute value is reflected in the response. Side effects of ' +
    "PF2e's vitals recovery flow (e.g. wounded auto-incrementing on dying clear, if that fires) " +
    'are not surfaced here — re-read with get_actor_state for the post-call vitals state. ' +
    "'persistent-damage' is rejected in v1 because PF2e's increase/decrease paths invoke a UI " +
    'dialog. Use foundry_eval with actor.deleteEmbeddedDocuments for persistent damage. ' +
    'If the actor has multiple items with the same slug (rare — PF2e single-instances same-slug ' +
    'conditions in normal operation), the slug-input path errors with ' +
    "MULTIPLE_INSTANCES_USE_CONDITION_ID; disambiguate via conditionId. " +
    'Rejected for actor types other than character/npc/familiar. See ' +
    'https://2e.aonprd.com/Conditions.aspx for canonical condition rules text.',
  inputSchema: RemoveConditionInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      slug: input.slug ?? null,
      conditionId: input.conditionId ?? null,
      mode: input.mode,
    };
    const result = (await page.evaluate(removeConditionBody, args)) as RemoveConditionResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    if (result.operation === 'removed') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          slug: result.condition.slug,
          conditionId: result.condition.id,
          previousValue: result.condition.previousValue,
          mode: input.mode,
          cascadeDeletedCount: result.cascadeDeleted?.length ?? 0,
        },
        'remove_condition',
      );
    } else if (result.operation === 'decremented') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          slug: result.condition.slug,
          conditionId: result.condition.id,
          previousValue: result.condition.previousValue,
          value: result.condition.value,
        },
        'remove_condition',
      );
    } else {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          slug: result.slug,
          reason: result.reason,
        },
        'remove_condition',
      );
    }
    return [jsonText(result)];
  },
};
