import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  transferItemBetweenActorsBody,
  type TransferItemBetweenActorsResult,
} from '../evaluators/transfer-item-between-actors.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `transfer_item_between_actors`. Cross-actor cousin of
 * `move_item_to_container`. The single tool covers five operations
 * (transferred, transferredAndMerged, split, splitAndMerged,
 * cascadeTransferred) — the evaluator picks the right one based on
 * `quantity` and the target item's type.
 */
const TransferItemBetweenActorsInput = z
  .object({
    sourceActorId: z
      .string()
      .min(1)
      .describe(
        'World actor id holding the item that will be transferred away (matches the actorId ' +
          'returned by get_actor_inventory).',
      ),
    destinationActorId: z
      .string()
      .min(1)
      .describe(
        'World actor id that will receive the item. Must differ from sourceActorId — use ' +
          'move_item_to_container for same-actor moves.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of the item to transfer (the `id` field on the source actor returned by ' +
          'get_actor_inventory). Must be a physical inventory type: weapon, armor, shield, ' +
          'consumable, equipment, backpack, treasure, ammo.',
      ),
    destinationContainerId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Where the item should land on the destination actor: the id of a backpack on the ' +
          "destination actor, OR null for the destination's top-level inventory. Foundry does " +
          'not enforce that this points at an actual container; the tool rejects non-backpack ids ' +
          'up front.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'How many to transfer. null or omitted = the entire stack (or, for containers, the ' +
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
          'regardless of this setting. Containers (backpacks) never merge — they have unique ' +
          'identity in their contents.',
      ),
  })
  .strict();

export const transferItemBetweenActorsTool: ToolDefinition<typeof TransferItemBetweenActorsInput> =
  {
    name: 'transfer_item_between_actors',
    description:
      'Move a physical inventory item from one actor to another. Handles single-stack transfer, ' +
      'partial-stack split transfer (move N of a stack), stack-merging into matching destination ' +
      'stacks, and full-cascade transfer of a container plus everything nested inside it. ' +
      "Identification status, runes, and other system properties carry over via the source item's " +
      'toObject() payload; equipment state (held/worn/in-slot) is reset to stowed on transfer ' +
      'because the destination actor has done nothing to wield or wear the item. ' +
      'Returns a discriminated union: {operation: "transferred", item} for a full single-item move ' +
      'with no merge; {operation: "transferredAndMerged", mergedInto, sourceDeletedId} when the ' +
      'destination already had a matching stack and merge folded the source into it; ' +
      '{operation: "split", sourceItem, created} for a partial-qty move with no merge; ' +
      '{operation: "splitAndMerged", sourceItem, mergedInto} for a partial-qty move that folded ' +
      'into a destination stack; {operation: "cascadeTransferred", root, descendants} for a ' +
      'container subtree move (descendants list every nested item with its remapped ' +
      'containerIdAfter on the destination). Source itemIds in the response refer to the source ' +
      'actor and are no longer valid post-call; refresh via get_actor_inventory on the destination. ' +
      'Merge identity matches add_item_to_actor: compendium source + destination containerId + ' +
      'identification status. Pass merge: "never" to opt out. ' +
      'Same-actor calls are rejected (use move_item_to_container). Non-physical items are rejected ' +
      '(use foundry_eval). Source items with PF2e ChoiceSet rules are rejected (would block on ' +
      'a selection dialog in headless context). Partial-quantity on a container is rejected ' +
      '(backpacks have unique identity in their contents).',
    inputSchema: TransferItemBetweenActorsInput,
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
        transferItemBetweenActorsBody,
        args,
      )) as TransferItemBetweenActorsResult;
      if (!result.ok) {
        throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
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
      if (
        (result.operation === 'transferred' || result.operation === 'cascadeTransferred') &&
        result.brokenGrantLinks &&
        result.brokenGrantLinks.length > 0
      ) {
        logFields.brokenGrantLinkCount = result.brokenGrantLinks.length;
      }
      ctx.log.info(logFields, 'transfer_item_between_actors');
      return [jsonText(result)];
    },
  };
