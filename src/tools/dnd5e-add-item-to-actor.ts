import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eAddItemToActorBody,
  type Dnd5eAddItemToActorResult,
} from '../evaluators/dnd5e-add-item-to-actor.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eAddItemToActorInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). The ' +
          'destination actor. Must be a character or npc; vehicle / group / encounter actors ' +
          'are rejected.',
      ),
    sourceUuid: z
      .string()
      .min(1)
      .describe(
        'Full compendium Item UUID (e.g. "Compendium.dnd5e.items.Item.xxxxxxxxxxxxxxxx"), as ' +
          'returned by dnd5e_search_compendium. Must point to a physical inventory item type ' +
          '(weapon, equipment, consumable, tool, loot, container). Actor-embedded UUIDs ' +
          '(Actor.X.Item.Y) are rejected — cross-actor moves are not yet supported.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'How many to grant. Default 1. Stackable items merge into an existing stack (see ' +
          'merge); non-stackable items are created with this quantity in a single entry. Must ' +
          'be an integer ≥ 1.',
      ),
    containerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Item id of a container (type "container") on the destination actor. When set, the new ' +
          'item is placed inside this container. When unset, the new item lives at the top ' +
          'level of the inventory.',
      ),
    identified: z
      .boolean()
      .optional()
      .describe(
        'Whether the granted item is identified. Default true. Pass false for mystery loot — ' +
          'the item displays as unidentified until a player Identifies it.',
      ),
    merge: z
      .enum(['auto', 'never'])
      .optional()
      .describe(
        'Stack-merge behavior. "auto" (default) folds the new item into an existing stack with ' +
          'the same compendium source, same container, and same identification status. "never" ' +
          'always creates a separate entry. Mismatch on any of source/container/identification ' +
          'produces a separate entry regardless of this setting. Container-type items never ' +
          'merge.',
      ),
  })
  .strict();

export const dnd5eAddItemToActorTool: ToolDefinition<typeof Dnd5eAddItemToActorInput> = {
  name: 'dnd5e_add_item_to_actor',
  description:
    'Grant a physical inventory item from a compendium source to a D&D 5e character or npc. ' +
    'Handles quantity, container placement, identification status, and automatic stack-merging ' +
    '(matching the Foundry UI\'s drag-to-merge behavior). Returns either {operation: "merged", ' +
    'mergedInto} when the new stack folded into an existing one, or {operation: "created", item} ' +
    'when a fresh item was created. Physical inventory only — weapon, equipment, consumable, ' +
    'tool, loot, container. Non-physical items (spells, feats, classes, backgrounds, races, ' +
    'etc.) are rejected; use foundry_eval to grant those. Pick sourceUuid from ' +
    'dnd5e_search_compendium; verify the result afterward with dnd5e_get_actor_inventory. ' +
    'Errors carry a details.reason: ACTOR_NOT_FOUND, ACTOR_TYPE_UNSUPPORTED, SOURCE_NOT_FOUND, ' +
    'SOURCE_NOT_ITEM, CROSS_ACTOR_UNSUPPORTED, NON_PHYSICAL_ITEM, INVALID_QUANTITY, ' +
    'CONTAINER_NOT_FOUND, CONTAINER_TYPE_INVALID, or CREATE_FAILED.',
  inputSchema: Dnd5eAddItemToActorInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      sourceUuid: input.sourceUuid,
      quantity: input.quantity ?? 1,
      containerId: input.containerId ?? null,
      identified: input.identified ?? true,
      merge: input.merge ?? 'auto',
    };
    const result = (await page.evaluate(
      dnd5eAddItemToActorBody,
      args,
    )) as Dnd5eAddItemToActorResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        operation: result.operation,
        sourceUuid: input.sourceUuid,
        ...(result.operation === 'created'
          ? { itemId: result.item?.id, quantity: result.item?.quantity }
          : {
              mergedIntoId: result.mergedInto?.id,
              addedQuantity: result.mergedInto?.addedQuantity,
            }),
      },
      'dnd5e_add_item_to_actor',
    );
    return [jsonText(result)];
  },
};
