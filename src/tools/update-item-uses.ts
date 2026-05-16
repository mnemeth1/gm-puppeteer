import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  updateItemUsesBody,
  type UpdateItemUsesResult,
} from '../evaluators/update-item-uses.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `update_item_uses`. Single-shape input: actorId, itemId,
 * value (non-negative integer). Companion to `use_item` (decrement
 * with side effects) and `update_item_quantity` (sets quantity, not
 * uses).
 *
 * Boundary validation:
 *   - zod's `.int().min(0)` rejects fractional and negative values at
 *     the MCP edge. The evaluator re-validates defensively.
 *   - Zero IS allowed (a depleted-but-present state). This is the
 *     deliberate divergence from update_item_quantity, which rejects
 *     0 with a pointer to remove_item_from_actor.
 *   - There is no upper-bound enforcement. Foundry accepts values
 *     above `uses.max`; the response carries `usesMax` so callers can
 *     detect over-set themselves if they want to.
 *
 * No `mode` discriminator: setting an absolute uses.value is the
 * entire surface. `uses.max` and `autoDestroy` writes are intentionally
 * out of scope (vanishingly rare; reach for `foundry_eval`).
 */
const UpdateItemUsesInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by get_actor_inventory). The actor whose ' +
          'item charges will be set.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by get_actor_inventory). ' +
          'This is NOT a compendium UUID — the item must be embedded on this actor. Must be a ' +
          'physical item type with a `system.uses` tracker (wands, scrolls, talismans, batons, ' +
          'equipment with limited activations). Items without a `system.uses` field are rejected.',
      ),
    value: z
      .number()
      .int()
      .min(0)
      .describe(
        'Absolute charge count to set in `system.uses.value`. Must be a non-negative integer. ' +
          'Zero is allowed (depleted-but-present — does NOT trigger autoDestroy; use ' +
          'remove_item_from_actor if you also want to delete the item). No upper bound is ' +
          'enforced — Foundry accepts values above `uses.max` (response carries `usesMax` so ' +
          'callers can detect over-set). Use get_item_details to read the current `uses.value` ' +
          'and `uses.max` first.',
      ),
  })
  .strict();

export const updateItemUsesTool: ToolDefinition<typeof UpdateItemUsesInput> = {
  name: 'update_item_uses',
  description:
    "Set the absolute `system.uses.value` of a charges-tracking physical item on a world actor. " +
    'Sibling to use_item (which decrements with side effects: chat card, autoDestroy) and to ' +
    'update_item_quantity (which sets `system.quantity`). Useful for refreshing daily wand ' +
    'charges, hand-tuning probe state, or reverting an accidental use_item call. ' +
    'Returns {operation: "updated", item: {id, name, type, usesBefore, usesAfter, usesMax}}. ' +
    'usesBefore === usesAfter indicates the value was already what you asked for (a clean no-op ' +
    "at Foundry's document layer). " +
    'Physical inventory only — non-physical items (feats, classes, spells) are rejected. Items ' +
    'without a `system.uses` field (e.g. a longsword) are rejected with ITEM_HAS_NO_USES_FIELD; ' +
    'use get_item_details to inspect the tracker first. ' +
    'Important nuance: for `consumable` items with `uses.max === 1` (potions, single-shot ' +
    'scrolls), the live counter that use_item decrements is `system.quantity`, NOT ' +
    '`system.uses.value`. Setting `uses.value` on those items is technically valid but rarely ' +
    'the right verb — reach for update_item_quantity instead. The cleanest signal that ' +
    '`uses.value` is the right field is `uses.max > 1` (wands at max=10 are the canonical case). ' +
    'value: 0 is a legitimate "depleted" state; direct write does NOT trigger autoDestroy ' +
    '(that pipeline only fires inside ConsumablePF2e.consume()). Use remove_item_from_actor to ' +
    'delete. ' +
    'value > usesMax is accepted as-is (no clamping); compare usesAfter to usesMax in the ' +
    'response if you need the over-set signal. ' +
    '`system.frequency` (per-day activations on feats and abilities) is a different field on a ' +
    'different document type — this tool does not touch it.',
  inputSchema: UpdateItemUsesInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      value: input.value,
    };
    const result = (await page.evaluate(
      updateItemUsesBody,
      args,
    )) as UpdateItemUsesResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        operation: result.operation,
        itemId: result.item.id,
        itemName: result.item.name,
        usesBefore: result.item.usesBefore,
        usesAfter: result.item.usesAfter,
        usesMax: result.item.usesMax,
      },
      'update_item_uses',
    );
    return [jsonText(result)];
  },
};
