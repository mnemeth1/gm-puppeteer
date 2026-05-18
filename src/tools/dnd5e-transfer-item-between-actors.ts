import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eTransferItemBetweenActorsBody,
  type Dnd5eTransferItemBetweenActorsResult,
} from '../evaluators/dnd5e-transfer-item-between-actors.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `dnd5e_transfer_item_between_actors`. Cross-actor cousin of
 * `dnd5e_move_item_to_container`. One tool covers five operations
 * (transferred, transferredAndMerged, split, splitAndMerged,
 * cascadeTransferred) — the evaluator picks the right one from `quantity`
 * and the target item's type.
 */
const Dnd5eTransferItemBetweenActorsInput = z
  .object({
    sourceActorId: z
      .string()
      .min(1)
      .describe(
        'World actor id holding the item being transferred away (matches the actorId returned ' +
          'by dnd5e_get_actor_inventory). Must be a character or npc.',
      ),
    destinationActorId: z
      .string()
      .min(1)
      .describe(
        'World actor id that will receive the item. Must be a character or npc, and must differ ' +
          'from sourceActorId — use dnd5e_move_item_to_container for same-actor moves.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of the item to transfer (the `id` field on the source actor returned by ' +
          'dnd5e_get_actor_inventory). Must be a physical inventory type: weapon, equipment, ' +
          'consumable, tool, loot, container.',
      ),
    destinationContainerId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Where the item should land on the destination actor: the item id of a container ' +
          '(type "container") on the destination actor, OR null for the destination\'s ' +
          'inventory root. Foundry does not enforce that this points at an actual container; ' +
          'the tool rejects non-container ids up front.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'How many to transfer. null or omitted = the entire stack (or, for a container, the ' +
          'container plus all of its nested contents via cascade). A positive integer N < the ' +
          'current stack size splits N off the source and adds them to the destination; N must ' +
          'not exceed the available quantity, and split is only valid for non-container items.',
      ),
    merge: z
      .enum(['auto', 'never'])
      .optional()
      .describe(
        'Stack-merge behavior on the destination. "auto" (default) folds the transferred item ' +
          'into an existing destination stack with the same compendium source, same destination ' +
          'container, and same identification status. "never" always creates a separate entry. ' +
          'Mismatch on any of source/container/identification produces a separate entry ' +
          'regardless. Containers never merge — they carry identity in their contents.',
      ),
  })
  .strict();

export const dnd5eTransferItemBetweenActorsTool: ToolDefinition<
  typeof Dnd5eTransferItemBetweenActorsInput
> = {
  name: 'dnd5e_transfer_item_between_actors',
  description:
    'Move a physical inventory item from one D&D 5e actor to another. Handles single-stack ' +
    'transfer, partial-stack split transfer (move N of a stack), stack-merging into matching ' +
    'destination stacks, and full-cascade transfer of a container plus everything nested inside ' +
    "it. Identification status and other system properties carry over via the source item's " +
    'toObject() payload; equipped state and per-actor attunement (system.attuned) are reset ' +
    'because the destination actor has done nothing to wield, wear, or attune the item. ' +
    'Returns a discriminated union: {operation: "transferred", item} for a full single-item ' +
    'move with no merge; {operation: "transferredAndMerged", mergedInto, sourceDeletedId} when ' +
    'the destination already had a matching stack; {operation: "split", sourceItem, created} ' +
    'for a partial-qty move with no merge; {operation: "splitAndMerged", sourceItem, ' +
    'mergedInto} for a partial-qty move that folded into a destination stack; {operation: ' +
    '"cascadeTransferred", root, descendants} for a container subtree move (descendants list ' +
    'every nested item with its remapped containerAfter on the destination). Source itemIds in ' +
    'the response refer to the source actor and are no longer valid post-call for the deleted ' +
    'paths; refresh via dnd5e_get_actor_inventory. Same-actor calls are rejected (use ' +
    'dnd5e_move_item_to_container). Non-physical items are rejected (use foundry_eval). ' +
    'Partial-quantity on a container is rejected. Errors carry a details.reason: ' +
    'INVALID_QUANTITY, TRANSFER_TO_SAME_ACTOR, ACTOR_NOT_FOUND, ACTOR_TYPE_UNSUPPORTED, ' +
    'ITEM_NOT_FOUND_ON_ACTOR, NON_PHYSICAL_ITEM, CONTAINER_NOT_FOUND, CONTAINER_TYPE_INVALID, ' +
    'SPLIT_ON_CONTAINER, or CREATE_FAILED.',
  inputSchema: Dnd5eTransferItemBetweenActorsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      sourceActorId: input.sourceActorId,
      destinationActorId: input.destinationActorId,
      itemId: input.itemId,
      destinationContainerId: input.destinationContainerId,
      quantity: input.quantity ?? null,
      merge: input.merge ?? 'auto',
    };
    const result = (await page.evaluate(
      dnd5eTransferItemBetweenActorsBody,
      args,
    )) as Dnd5eTransferItemBetweenActorsResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    const logFields: Record<string, unknown> = {
      sourceActorId: result.sourceActor.id,
      destinationActorId: result.destinationActor.id,
      operation: result.operation,
    };
    if (result.operation === 'transferred') {
      logFields.itemOldId = result.item.oldId;
      logFields.itemNewId = result.item.newId;
      logFields.itemName = result.item.name;
      logFields.quantity = result.item.quantity;
    } else if (result.operation === 'transferredAndMerged') {
      logFields.sourceDeletedId = result.sourceDeletedId;
      logFields.mergedIntoId = result.mergedInto.id;
      logFields.addedQuantity = result.mergedInto.addedQuantity;
    } else if (result.operation === 'split') {
      logFields.sourceItemId = result.sourceItem.id;
      logFields.sourceQtyBefore = result.sourceItem.qtyBefore;
      logFields.sourceQtyAfter = result.sourceItem.qtyAfter;
      logFields.createdNewId = result.created.newId;
      logFields.createdQuantity = result.created.quantity;
    } else if (result.operation === 'splitAndMerged') {
      logFields.sourceItemId = result.sourceItem.id;
      logFields.sourceQtyAfter = result.sourceItem.qtyAfter;
      logFields.mergedIntoId = result.mergedInto.id;
      logFields.addedQuantity = result.mergedInto.addedQuantity;
    } else {
      logFields.rootOldId = result.root.oldId;
      logFields.rootNewId = result.root.newId;
      logFields.descendantCount = result.descendants.length;
    }
    if (result.warnings && result.warnings.length > 0) {
      logFields.warningCount = result.warnings.length;
    }
    ctx.log.info(logFields, 'dnd5e_transfer_item_between_actors');
    return [jsonText(result)];
  },
};
