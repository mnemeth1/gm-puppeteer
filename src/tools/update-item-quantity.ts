import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  updateItemQuantityBody,
  type UpdateItemQuantityResult,
} from '../evaluators/update-item-quantity.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `update_item_quantity`. Single-shape input: actorId,
 * itemId, quantity (positive integer). No discriminated union — this
 * tool does one thing.
 *
 * Boundary validation:
 *   - zod's `.int().min(1)` rejects fractional, negative, and zero
 *     quantities at the MCP edge as `INVALID_ARGS`. The evaluator
 *     re-validates defensively (a future direct caller of the evaluator
 *     body would otherwise hit Foundry's silent float-truncation /
 *     string-coercion / negative-clamp behaviors, all confirmed in
 *     Phase 1).
 *   - `quantity: 0` is rejected with a dedicated `QUANTITY_ZERO` reason
 *     code (and the user-facing pointer to `remove_item_from_actor`).
 *     The evaluator carries the friendly message because zod's
 *     `.min(1)` error is structurally informative but tonally generic.
 *
 * No `mode` discriminator: setting an absolute quantity is the entire
 * surface. Deltas live on `add_item_to_actor` (merge-add) and
 * `remove_item_from_actor` (decrement). Probe references:
 * scripts/probe-update-item-quantity.mjs.
 */
const UpdateItemQuantityInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by get_actor_inventory). The actor whose ' +
          'item quantity will be set.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by get_actor_inventory). ' +
          'This is NOT a compendium UUID — the item must be embedded on this actor. Must be a ' +
          'physical item type (weapon, armor, shield, consumable, equipment, backpack, treasure, ' +
          'ammo) — non-physical types have no `system.quantity` field and are rejected.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .describe(
        'Absolute quantity to set. Must be a positive integer ≥ 1. Zero is rejected — use ' +
          'remove_item_from_actor with mode: "delete" to remove the item entirely. For currency ' +
          '(treasure items), `actor.inventory.coins` reflects the new value automatically.',
      ),
  })
  .strict();

export const updateItemQuantityTool: ToolDefinition<typeof UpdateItemQuantityInput> = {
  name: 'update_item_quantity',
  description:
    "Set the absolute quantity of a physical item on a world actor. Sibling to " +
    'add_item_to_actor (merge-add delta) and remove_item_from_actor (decrement delta) — this is ' +
    'the set operation. Useful for currency adjustments ("set Copper Pieces to 50") and stack ' +
    'resets where computing the delta would be awkward. ' +
    'Returns {operation: "updated", item: {id, name, type, qtyBefore, qtyAfter}}. The response ' +
    'shape is single — qtyBefore === qtyAfter indicates the value was already what you asked for ' +
    "(a clean no-op at Foundry's document layer). " +
    'Physical inventory only — weapons, armor, shields, consumables, equipment, containers, ' +
    'treasure, ammo. Non-physical items (feats, classes, spells, etc.) are rejected — they have ' +
    'no `system.quantity` field. ' +
    'Quantity must be a positive integer ≥ 1; quantity 0 is rejected with a pointer to ' +
    'remove_item_from_actor. For treasure items, `actor.inventory.coins` (the aggregator) tracks ' +
    'the change automatically. ' +
    'Use get_actor_inventory to discover the itemId and current quantity. For cross-actor moves, ' +
    'container reassignment, or identification changes, use foundry_eval or wait for the ' +
    'dedicated tools.',
  inputSchema: UpdateItemQuantityInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      quantity: input.quantity,
    };
    const result = (await page.evaluate(
      updateItemQuantityBody,
      args,
    )) as UpdateItemQuantityResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
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
      'update_item_quantity',
    );
    return [jsonText(result)];
  },
};
