import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  removeItemFromActorBody,
  type RemoveItemFromActorResult,
} from '../evaluators/remove-item-from-actor.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `pf2e_remove_item_from_actor`.
 *
 * Flat object with a `mode` enum (`delete` | `decrement`). `quantity` and
 * `deleteIfZero` are only valid when `mode === 'decrement'`; supplying them
 * with `mode: 'delete'` is rejected by `.superRefine` and surfaces as
 * `INVALID_ARGS` at the MCP boundary. This replaces an earlier discriminated-
 * union schema — `zodToJsonSchema` emits discriminated unions as a top-level
 * `anyOf` with no `type: "object"`, and MCP clients require
 * a top-level object schema. Probe 11 in
 * scripts/probe-remove-item-from-actor.mjs exercises that the
 * "delete with quantity" combination still rejects.
 */
const RemoveItemFromActorInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by pf2e_get_actor_inventory). The actor to ' +
          'modify.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by pf2e_get_actor_inventory). ' +
          'This is NOT a compendium UUID — the item must be embedded on this actor. For ' +
          "mode 'decrement', must be a physical item type (weapon, armor, shield, consumable, " +
          'equipment, backpack, treasure, ammo) — non-physical types like feats have no ' +
          "`system.quantity` field and are rejected with the suggestion to use mode 'delete'.",
      ),
    mode: z
      .enum(['delete', 'decrement'])
      .describe(
        '`delete`: remove the item entry entirely. For containers (`backpack`), PF2e ejects the ' +
          'contents to the actor top-level rather than destroying them — those promoted items are ' +
          'surfaced in `ejectedToTopLevel`. PF2e GrantItem children (e.g. items granted by a ' +
          'parent feat) cascade-delete automatically and are surfaced in `cascadeDeleted`. ' +
          "`decrement`: reduce the item's quantity by `quantity`. If the resulting quantity is 0 " +
          'and `deleteIfZero` is true (default), the item is deleted (operation becomes ' +
          '`decrementedAndDeleted`); otherwise the entry persists at qty 0. `quantity` and ' +
          '`deleteIfZero` are only valid when `mode` is `decrement`.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "How many to remove from the stack (mode 'decrement' only). Default 1. Decrementing by " +
          'more than the current quantity is allowed and clamps to 0 — combined with ' +
          '`deleteIfZero: true`, this naturally collapses to a delete. If you want strict bounds, ' +
          'read the current quantity via pf2e_get_actor_inventory before calling.',
      ),
    deleteIfZero: z
      .boolean()
      .optional()
      .describe(
        "When the resulting quantity is 0, also delete the item entry (mode 'decrement' only). " +
          "Default true (matches PF2e's consumable-consume behavior, where using the last charge " +
          'of an autoDestroy item removes the entry). Set to false to keep a qty-0 entry — useful ' +
          'if a caller wants to model "out of stock" without losing the placeholder.',
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

export const removeItemFromActorTool: ToolDefinition<typeof RemoveItemFromActorInput> = {
  name: 'pf2e_remove_item_from_actor',
  description:
    "Remove an item from a world actor's inventory, OR decrement its quantity. Companion to " +
    'pf2e_add_item_to_actor. Two modes: "delete" removes the item entry entirely; "decrement" ' +
    "reduces a physical item's `system.quantity` by N (default 1) and by default also deletes " +
    'the entry when quantity reaches 0. ' +
    'Returns one of three operations: ' +
    '{operation: "deleted", deletedItem, ejectedToTopLevel, cascadeDeleted} — the item was ' +
    'removed; {operation: "decremented", item} — quantity reduced but the entry survives ' +
    '(qtyAfter > 0, or qtyAfter === 0 with deleteIfZero:false); {operation: ' +
    '"decrementedAndDeleted", deletedItem, ejectedToTopLevel, cascadeDeleted} — quantity hit 0 ' +
    'and the entry was removed. ' +
    'Container semantics: deleting a backpack (or decrementing one to 0) does NOT destroy its ' +
    'contents — PF2e ejects them to the actor top-level by clearing their containerId. These ' +
    'promoted items are reported in `ejectedToTopLevel`. PF2e GrantItem children of the deleted ' +
    "item are auto-cascade-deleted and reported in `cascadeDeleted` (reason: 'grantedBy'). " +
    'Use pf2e_get_actor_inventory to discover the itemId to remove. For cross-actor moves or ' +
    'setting an exact quantity (not delta), use foundry_eval or wait for the dedicated tools.',
  inputSchema: RemoveItemFromActorInput,
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
      removeItemFromActorBody,
      args,
    )) as RemoveItemFromActorResult;
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
      logCtx.cascadeCount = result.cascadeDeleted.length;
    } else if (result.operation === 'decremented') {
      logCtx.qtyBefore = result.item.qtyBefore;
      logCtx.qtyAfter = result.item.qtyAfter;
    } else {
      logCtx.deletedItemName = result.deletedItem.name;
      logCtx.qtyBefore = result.deletedItem.qtyBefore;
      logCtx.ejectedCount = result.ejectedToTopLevel.length;
      logCtx.cascadeCount = result.cascadeDeleted.length;
    }
    ctx.log.info(logCtx, 'pf2e_remove_item_from_actor');
    return [jsonText(result)];
  },
};
