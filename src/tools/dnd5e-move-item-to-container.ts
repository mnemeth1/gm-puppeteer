import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eMoveItemToContainerBody,
  type Dnd5eMoveItemToContainerResult,
} from '../evaluators/dnd5e-move-item-to-container.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eMoveItemToContainerInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). The actor ' +
          'whose inventory tree is being rearranged. Must be a character or npc; vehicle / group ' +
          '/ encounter actors are rejected.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of the item to move (the `id` field on the actor returned by ' +
          'dnd5e_get_actor_inventory). Must be a physical inventory type: weapon, equipment, ' +
          'consumable, tool, loot, container.',
      ),
    containerId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Destination: the item id of a container (type "container") on the SAME actor, OR null ' +
          "to move the item to the inventory root. Foundry does not enforce that this points at " +
          'an actual container, nor does it reject cycles — the tool rejects non-container ids ' +
          'and moves that would make the item its own ancestor.',
      ),
    merge: z
      .enum(['auto', 'never'])
      .optional()
      .describe(
        'Stack-merge behavior at the destination. "auto" (default) folds the moved item into an ' +
          'existing stack with the same compendium source, same destination container, and same ' +
          'identification status — the source entry is deleted. "never" always leaves the moved ' +
          'item as its own entry. Container-type items never merge.',
      ),
  })
  .strict();

export const dnd5eMoveItemToContainerTool: ToolDefinition<typeof Dnd5eMoveItemToContainerInput> = {
  name: 'dnd5e_move_item_to_container',
  description:
    'Relocate a physical item between containers (or to/from the inventory root) on a single ' +
    'D&D 5e character or npc. Same-actor only — use dnd5e_transfer_item_between_actors to move ' +
    'an item to a different actor. Returns either {operation: "moved", item} with ' +
    'containerBefore/containerAfter (equal values signal a no-op), or {operation: "merged", ' +
    'mergedInto} when the moved item folded into an existing stack at the destination (the ' +
    'source entry is then deleted — refresh ids via dnd5e_get_actor_inventory). Moving a ' +
    'container carries its contents with it. Physical inventory only — weapon, equipment, ' +
    'consumable, tool, loot, container; non-physical items are rejected (use foundry_eval). ' +
    'Errors carry a details.reason: ACTOR_NOT_FOUND, ACTOR_TYPE_UNSUPPORTED, ' +
    'ITEM_NOT_FOUND_ON_ACTOR, NON_PHYSICAL_ITEM, CONTAINER_NOT_FOUND, CONTAINER_TYPE_INVALID, ' +
    'or CYCLE_DETECTED.',
  inputSchema: Dnd5eMoveItemToContainerInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      containerId: input.containerId,
      merge: input.merge ?? 'auto',
    };
    const result = (await page.evaluate(
      dnd5eMoveItemToContainerBody,
      args,
    )) as Dnd5eMoveItemToContainerResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        operation: result.operation,
        ...(result.operation === 'moved'
          ? {
              itemId: result.item.id,
              itemName: result.item.name,
              containerBefore: result.item.containerBefore,
              containerAfter: result.item.containerAfter,
            }
          : {
              mergedIntoId: result.mergedInto.id,
              mergedIntoName: result.mergedInto.name,
              addedQuantity: result.mergedInto.addedQuantity,
            }),
        ...(result.warnings && result.warnings.length > 0
          ? { warningCount: result.warnings.length }
          : {}),
      },
      'dnd5e_move_item_to_container',
    );
    return [jsonText(result)];
  },
};
