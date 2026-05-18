import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eUpdateItemQuantityBody,
  type Dnd5eUpdateItemQuantityResult,
} from '../evaluators/dnd5e-update-item-quantity.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_update_item_quantity`. Single-shape input: actorId,
 * itemId, quantity (integer ≥ 1). D&D 5e sibling of
 * `pf2e_update_item_quantity`; companion to `dnd5e_add_item_to_actor`
 * (merge-add) and `dnd5e_remove_item_from_actor` (decrement / delete).
 *
 * Boundary validation:
 *   - zod's `.int().min(1)` rejects fractional, zero, and negative values
 *     at the MCP edge. The evaluator re-validates defensively and rejects
 *     `0` with a dedicated QUANTITY_ZERO reason pointing at
 *     `dnd5e_remove_item_from_actor`.
 */
const Dnd5eUpdateItemQuantityInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). The actor ' +
          'whose item stack will be set. Must be a character or npc.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by dnd5e_get_actor_inventory). ' +
          'This is NOT a compendium UUID — the item must be embedded on this actor. Must be a ' +
          'physical inventory type: weapon, equipment, consumable, tool, loot, container.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .describe(
        'Absolute quantity to set in `system.quantity`. Must be an integer ≥ 1. To remove the ' +
          'item entirely, use dnd5e_remove_item_from_actor instead — this tool rejects 0.',
      ),
  })
  .strict();

export const dnd5eUpdateItemQuantityTool: ToolDefinition<typeof Dnd5eUpdateItemQuantityInput> = {
  name: 'dnd5e_update_item_quantity',
  description:
    'Set the absolute `system.quantity` of a physical inventory item on a D&D 5e world actor. ' +
    'Sibling to dnd5e_add_item_to_actor (merge-add) and dnd5e_remove_item_from_actor (decrement ' +
    'or delete). Useful for correcting a stack count or hand-tuning state. ' +
    'Returns {operation: "updated", item: {id, name, type, qtyBefore, qtyAfter}}. ' +
    'qtyBefore === qtyAfter indicates the quantity was already what you asked for (a clean ' +
    "no-op at Foundry's document layer). " +
    'Physical inventory only — weapon, equipment, consumable, tool, loot, container. ' +
    'Non-physical items (spells, feats, classes, backgrounds, races) have no `system.quantity` ' +
    'field and are rejected. quantity must be an integer ≥ 1; setting 0 is rejected — use ' +
    'dnd5e_remove_item_from_actor to remove an item. ' +
    'Errors carry a details.reason: ACTOR_NOT_FOUND, ACTOR_TYPE_UNSUPPORTED, ' +
    'ITEM_NOT_FOUND_ON_ACTOR, UPDATE_ON_NON_PHYSICAL, QUANTITY_ZERO, or INVALID_QUANTITY.',
  inputSchema: Dnd5eUpdateItemQuantityInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      quantity: input.quantity,
    };
    const result = (await page.evaluate(
      dnd5eUpdateItemQuantityBody,
      args,
    )) as Dnd5eUpdateItemQuantityResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        operation: result.operation,
        itemId: result.item.id,
        itemName: result.item.name,
        qtyBefore: result.item.qtyBefore,
        qtyAfter: result.item.qtyAfter,
      },
      'dnd5e_update_item_quantity',
    );
    return [jsonText(result)];
  },
};
