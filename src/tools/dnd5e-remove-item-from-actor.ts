import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eRemoveItemFromActorBody,
  type Dnd5eRemoveItemFromActorResult,
} from '../evaluators/dnd5e-remove-item-from-actor.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_remove_item_from_actor`.
 *
 * Flat object with a `mode` enum (`delete` | `decrement`). `quantity` and
 * `deleteIfZero` are only valid when `mode === 'decrement'`; supplying them
 * with `mode: 'delete'` is rejected by `.superRefine`. This is a flat object
 * rather than a discriminated union because `zodToJsonSchema` emits
 * discriminated unions as a top-level `anyOf` with no `type: "object"`, which
 * MCP clients reject — see the `mcp-inputschema-must-be-object` constraint.
 */
const Dnd5eRemoveItemFromActorInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). The actor ' +
          'to modify. Must be a character or npc; vehicle / group / encounter actors are rejected.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by ' +
          'dnd5e_get_actor_inventory). This is NOT a compendium UUID — the item must be embedded ' +
          "on this actor. For mode 'decrement', must be a physical item type (weapon, equipment, " +
          'consumable, tool, loot, container) — non-physical types like feats and spells have no ' +
          "`system.quantity` field and are rejected with the suggestion to use mode 'delete'.",
      ),
    mode: z
      .enum(['delete', 'decrement'])
      .describe(
        '`delete`: remove the item entry entirely. Deleting a container ejects its direct ' +
          'contents to the inventory root (dnd5e leaves them orphaned otherwise) — those promoted ' +
          'items are surfaced in `ejectedToTopLevel`. `decrement`: reduce the item\'s quantity by ' +
          '`quantity`. If the resulting quantity is 0 and `deleteIfZero` is true (default), the ' +
          'item is deleted (operation becomes `decrementedAndDeleted`); otherwise the entry ' +
          'persists at qty 0. `quantity` and `deleteIfZero` are only valid when `mode` is ' +
          '`decrement`.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "How many to remove from the stack (mode 'decrement' only). Default 1. Decrementing by " +
          'more than the current quantity is allowed and clamps to 0 — combined with ' +
          '`deleteIfZero: true`, this naturally collapses to a delete. To enforce strict bounds, ' +
          'read the current quantity via dnd5e_get_actor_inventory before calling.',
      ),
    deleteIfZero: z
      .boolean()
      .optional()
      .describe(
        "When the resulting quantity is 0, also delete the item entry (mode 'decrement' only). " +
          'Default true (matches the intuitive "used the last one" outcome). Set to false to ' +
          'keep a qty-0 entry — useful to model "out of stock" without losing the placeholder.',
      ),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'delete') {
      if (val.quantity !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quantity'],
          message: "`quantity` is only valid when mode is 'decrement'",
        });
      }
      if (val.deleteIfZero !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deleteIfZero'],
          message: "`deleteIfZero` is only valid when mode is 'decrement'",
        });
      }
    }
  });

export const dnd5eRemoveItemFromActorTool: ToolDefinition<typeof Dnd5eRemoveItemFromActorInput> = {
  name: 'dnd5e_remove_item_from_actor',
  description:
    "Remove an item from a D&D 5e character or npc's inventory, OR decrement its quantity. " +
    'Companion to dnd5e_add_item_to_actor. Two modes: "delete" removes the item entry entirely; ' +
    '"decrement" reduces a physical item\'s `system.quantity` by N (default 1) and by default ' +
    'also deletes the entry when quantity reaches 0. ' +
    'Returns one of three operations: ' +
    '{operation: "deleted", deletedItem, ejectedToTopLevel} — the item was removed; ' +
    '{operation: "decremented", item} — quantity reduced but the entry survives (qtyAfter > 0, ' +
    'or qtyAfter === 0 with deleteIfZero:false); {operation: "decrementedAndDeleted", ' +
    'deletedItem, ejectedToTopLevel} — quantity hit 0 and the entry was removed. ' +
    'Container semantics: deleting a container does NOT destroy its contents — the tool ejects ' +
    'the direct contents to the inventory root (dnd5e would otherwise leave them orphaned with ' +
    'a dangling container reference). Those promoted items are reported in `ejectedToTopLevel`. ' +
    'D&D 5e has no GrantItem cascade, so there is no cascade-delete field. ' +
    'Use dnd5e_get_actor_inventory to discover the itemId to remove. ' +
    'Errors carry a details.reason: ACTOR_NOT_FOUND, ACTOR_TYPE_UNSUPPORTED, ' +
    'ITEM_NOT_FOUND_ON_ACTOR, INVALID_QUANTITY, or DECREMENT_ON_NON_PHYSICAL.',
  inputSchema: Dnd5eRemoveItemFromActorInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args =
      input.mode === 'delete'
        ? {
            actorId: input.actorId,
            itemId: input.itemId,
            mode: 'delete' as const,
            quantity: 1,
            deleteIfZero: true,
          }
        : {
            actorId: input.actorId,
            itemId: input.itemId,
            mode: 'decrement' as const,
            quantity: input.quantity ?? 1,
            deleteIfZero: input.deleteIfZero ?? true,
          };
    const result = (await page.evaluate(
      dnd5eRemoveItemFromActorBody,
      args,
    )) as Dnd5eRemoveItemFromActorResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    const logCtx: Record<string, unknown> = {
      actorId: result.actor.id,
      operation: result.operation,
      itemId: input.itemId,
    };
    if (result.operation === 'deleted') {
      logCtx.deletedItemName = result.deletedItem.name;
      logCtx.ejectedCount = result.ejectedToTopLevel.length;
    } else if (result.operation === 'decremented') {
      logCtx.qtyBefore = result.item.qtyBefore;
      logCtx.qtyAfter = result.item.qtyAfter;
    } else {
      logCtx.deletedItemName = result.deletedItem.name;
      logCtx.qtyBefore = result.deletedItem.qtyBefore;
      logCtx.ejectedCount = result.ejectedToTopLevel.length;
    }
    ctx.log.info(logCtx, 'dnd5e_remove_item_from_actor');
    return [jsonText(result)];
  },
};
