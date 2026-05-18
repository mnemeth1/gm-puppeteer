import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import { dnd5eUseItemBody, type Dnd5eUseItemResult } from '../evaluators/dnd5e-use-item.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eUseItemInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). Must be ' +
          'a character or npc.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Embedded item id on the actor (the inventory-row id from dnd5e_get_actor_inventory). ' +
          'The item must carry at least one activity — plain loot has no use pipeline.',
      ),
    activityId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional activity id to run, for items with more than one activity (e.g. a weapon ' +
          'with separate attack and utility activities). When omitted, the first usable ' +
          "activity is run. Activity ids are visible on the item's detail view.",
      ),
  })
  .strict();

export const dnd5eUseItemTool: ToolDefinition<typeof Dnd5eUseItemInput> = {
  name: 'dnd5e_use_item',
  description:
    'Run the D&D 5e activity / use pipeline for a single item on an actor — posts the chat ' +
    'card and consumes charges or quantity (a potion heal, a wand charge, a weapon or feat ' +
    'activation). The 5e equivalent of clicking an item on the character sheet. Resolves the ' +
    'activity to run (the optional activityId, else the first usable activity) and runs it ' +
    'dialog-free. Returns {operation: "used", activity, item, chatMessageId} where item ' +
    'carries quantityBefore/After and, for charge-tracked items, usesSpent/usesValue ' +
    'before/after, plus a deleted flag (true when the last copy was consumed). Items with ' +
    'no activity are rejected — for silent inventory edits use dnd5e_update_item_uses ' +
    '(recharge) or dnd5e_remove_item_from_actor (discard) instead. Spell-scroll cast ' +
    'activities are NOT supported and are rejected (CAST_ACTIVITY_UNSUPPORTED): casting a ' +
    'scroll through the API orphans a cached-spell document that corrupts world load — ' +
    'cast scrolls from the Foundry UI instead.',
  inputSchema: Dnd5eUseItemInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      activityId: input.activityId ?? null,
    };
    const result = (await page.evaluate(dnd5eUseItemBody, args)) as Dnd5eUseItemResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        itemId: result.item.id,
        itemName: result.item.name,
        activityId: result.activity.id,
        activityType: result.activity.type,
        quantityBefore: result.item.quantityBefore,
        quantityAfter: result.item.quantityAfter,
        deleted: result.item.deleted,
        chatMessageId: result.chatMessageId,
      },
      'dnd5e_use_item',
    );
    return [jsonText(result)];
  },
};
