import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eUpdateItemUsesBody,
  type Dnd5eUpdateItemUsesResult,
} from '../evaluators/dnd5e-update-item-uses.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_update_item_uses`. Single-shape input: actorId, itemId,
 * value (the desired REMAINING charge count, non-negative integer). D&D 5e
 * sibling of `pf2e_update_item_uses`.
 *
 * The 5e uses model differs from PF2e: `system.uses.value` is a derived
 * getter (`max − spent`), so this tool writes the stored `system.uses.spent`
 * field. The caller still thinks in remaining charges — the tool does the
 * `spent = max − value` translation.
 *
 * Boundary validation:
 *   - zod's `.int().min(0)` rejects fractional and negative values at the
 *     MCP edge. 0 is allowed (depleted-but-present).
 *   - The upper bound (`value ≤ max`) is enforced in the evaluator, which
 *     knows the live resolved `max`; it rejects over-set with
 *     REMAINING_EXCEEDS_MAX.
 */
const Dnd5eUpdateItemUsesInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). The actor ' +
          'whose item charges will be set. Must be a character or npc.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by dnd5e_get_actor_inventory, ' +
          'or the embedded item id from dnd5e_get_actor_state). This is NOT a compendium UUID. ' +
          'The item must have a `system.uses` charge pool (`uses.max` resolving to a positive ' +
          'number) — wands, staves, charged magic items, and feats/spells with limited uses all ' +
          'qualify. Items without a uses tracker are rejected.',
      ),
    value: z
      .number()
      .int()
      .min(0)
      .describe(
        'Absolute REMAINING charge count to leave on the item. Must be a non-negative integer ' +
          "≤ the item's `uses.max`. The tool writes `system.uses.spent = max − value` under the " +
          'hood (5e stores spent, not remaining). Zero is allowed (depleted-but-present — does ' +
          'NOT trigger autoDestroy; use dnd5e_remove_item_from_actor if you also want to delete ' +
          'the item). Use dnd5e_get_item_details to read the current `uses` block first.',
      ),
  })
  .strict();

export const dnd5eUpdateItemUsesTool: ToolDefinition<typeof Dnd5eUpdateItemUsesInput> = {
  name: 'dnd5e_update_item_uses',
  description:
    'Set the remaining charge count of a uses-tracking item on a D&D 5e world actor. The caller ' +
    'passes the desired REMAINING charges (`value`); the tool writes `system.uses.spent` = ' +
    'max − value, because 5e stores `spent` and derives `uses.value` (= max − spent). Useful ' +
    'for refreshing daily wand/staff charges, hand-tuning state, or reverting a use. ' +
    'Returns {operation: "updated", item: {id, name, type, remainingBefore, remainingAfter, ' +
    'max, spentBefore, spentAfter}}. remainingBefore === remainingAfter indicates the item was ' +
    "already at that charge count (a clean no-op at Foundry's document layer). " +
    'Works on ANY item with a `uses` charge pool — not only physical inventory. Wands, staves, ' +
    'charged magic items, and feats/spells with limited activations (e.g. Bardic Inspiration, ' +
    'Misty Step) all qualify. Items whose `uses.max` does not resolve to a positive number are ' +
    'rejected with ITEM_HAS_NO_USES_TRACKER; use dnd5e_get_item_details to inspect first. ' +
    "value must be ≤ the item's max — 5e cannot over-charge; value > max is rejected with " +
    'REMAINING_EXCEEDS_MAX. value: 0 is a legitimate "depleted" state and does NOT trigger ' +
    'autoDestroy (that fires only in the 5e use pipeline); use dnd5e_remove_item_from_actor to ' +
    'delete an item. ' +
    'Errors carry a details.reason: ACTOR_NOT_FOUND, ACTOR_TYPE_UNSUPPORTED, ' +
    'ITEM_NOT_FOUND_ON_ACTOR, ITEM_HAS_NO_USES_TRACKER, REMAINING_EXCEEDS_MAX, or INVALID_VALUE.',
  inputSchema: Dnd5eUpdateItemUsesInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      value: input.value,
    };
    const result = (await page.evaluate(
      dnd5eUpdateItemUsesBody,
      args,
    )) as Dnd5eUpdateItemUsesResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        operation: result.operation,
        itemId: result.item.id,
        itemName: result.item.name,
        remainingBefore: result.item.remainingBefore,
        remainingAfter: result.item.remainingAfter,
        max: result.item.max,
        spentAfter: result.item.spentAfter,
      },
      'dnd5e_update_item_uses',
    );
    return [jsonText(result)];
  },
};
