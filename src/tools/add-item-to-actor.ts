import { z } from 'zod';
import { ToolError } from '../errors.js';
import { addItemToActorBody, type AddItemToActorResult } from '../evaluators/add-item-to-actor.js';
import { jsonText, type ToolDefinition } from './types.js';

const AddItemToActorInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by get_actor_inventory). The destination actor.',
      ),
    sourceUuid: z
      .string()
      .min(1)
      .describe(
        'Full compendium Item UUID (e.g. "Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi"), ' +
          'as returned by search_compendium. Must point to a physical inventory item type. ' +
          'Actor-embedded UUIDs (Actor.X.Item.Y) are rejected — cross-actor moves are not yet ' +
          'supported.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'How many to grant. Default 1. Stackable items will merge into existing stacks (see ' +
          'merge); non-stackable items will be created with this quantity in a single entry ' +
          '(matches Foundry UI drop behavior). Must be an integer ≥ 1.',
      ),
    containerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Item id of a container (type "backpack") on the destination actor. When set, the new ' +
          'item will be placed inside this container. When unset, the new item lives at the top ' +
          'level of the inventory.',
      ),
    identified: z
      .boolean()
      .optional()
      .describe(
        'Whether the granted item is identified. Default true. Pass false for mystery loot — ' +
          'the item will display its unidentified name (e.g. "Unusual Longsword") until the ' +
          'player Identifies it.',
      ),
    merge: z
      .enum(['auto', 'never'])
      .optional()
      .describe(
        'Stack-merge behavior. "auto" (default) folds the new item into an existing stack with ' +
          'the same compendium source, same container, and same identification status. "never" ' +
          'always creates a separate entry. Mismatch on any of source/container/identification ' +
          'produces a separate entry regardless of this setting.',
      ),
  })
  .strict();

export const addItemToActorTool: ToolDefinition<typeof AddItemToActorInput> = {
  name: 'add_item_to_actor',
  description:
    'Grant a physical inventory item from a compendium source to a world actor. Handles ' +
    'quantity, container placement, identification status, and automatic stack-merging ' +
    '(matching the Foundry UI\'s drag-to-merge behavior). Returns either {operation: "merged", ' +
    'mergedInto} when the new stack folded into an existing one, or {operation: "created", item, ' +
    'cascadeGranted?} when a fresh item was created. Cascade-granted items (PF2e GrantItem rules) ' +
    'are surfaced explicitly. Physical inventory only — weapons, armor, shields, consumables, ' +
    'equipment, containers, treasure, ammo. Non-physical items (feats, classes, ancestries, ' +
    'spells, etc.) are rejected; use foundry_eval to grant those. Source items with PF2e ' +
    'ChoiceSet rules are also rejected in v1 because their cascade would block on a selection ' +
    'dialog in headless context.',
  inputSchema: AddItemToActorInput,
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
    const result = (await page.evaluate(addItemToActorBody, args)) as AddItemToActorResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
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
        cascadeCount: result.cascadeGranted?.length ?? 0,
      },
      'add_item_to_actor',
    );
    return [jsonText(result)];
  },
};
