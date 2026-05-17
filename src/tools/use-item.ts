import { z } from 'zod';
import { ToolError } from '../errors.js';
import { useItemBody, type UseItemResult } from '../evaluators/use-item.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `pf2e_use_item`. Single-shape input: actorId, itemId. The tool
 * runs the PF2e use pipeline for one item per call — quantity is fixed
 * at 1. Callers who want to consume multiple charges or items invoke
 * the tool repeatedly.
 *
 * Reason for not exposing a quantity parameter: the use pipeline
 * produces side effects (chat cards, embedded-spell casts) that are
 * meaningful one at a time, not in bulk. A single tool call models a
 * single in-game action ("drink one potion", "expend one wand charge"),
 * which matches how the PF2e UI treats item use.
 */
const UseItemInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by pf2e_get_actor_inventory). The actor who ' +
          'is using the item.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of an item ALREADY ON the actor (the `id` field returned by pf2e_get_actor_inventory). ' +
          'This is NOT a compendium UUID — the item must be embedded on this actor. Must be ' +
          'type "consumable" (potion, scroll, wand, elixir, talisman, etc.) or type "equipment" ' +
          'with an activation; other physical types (weapon, armor, shield, backpack, treasure, ' +
          'ammo) and non-physical types (feat, action, spell) are rejected.',
      ),
  })
  .strict();

export const useItemTool: ToolDefinition<typeof UseItemInput> = {
  name: 'pf2e_use_item',
  description:
    "Activate or consume one item from a world actor's inventory: drink a potion, read a " +
    "scroll, expend a wand charge, click an equipment activation. Runs PF2e's use pipeline " +
    '(chat card, charges/quantity decrement, embedded-spell cast for scrolls/wands), so the ' +
    "result lands in Foundry's chat log as an audit trail rather than as a silent state edit. " +
    'Returns {operation: "used", mode: "consume"|"message", item: {id, name, type, subtype, ' +
    'qtyBefore, qtyAfter, usesBefore?, usesAfter?, deleted}, chatMessageId|null}. The ' +
    '`subtype` field carries `system.category` for consumables (potion, scroll, wand, ' +
    'elixir, talisman, etc.) and is null for equipment. `deleted: true` means autoDestroy ' +
    'fired and the item was removed from the inventory (e.g., last potion in a stack). ' +
    'Path selection by item type: type=consumable routes through ConsumablePF2e.consume(1); ' +
    'type=equipment routes through Item.toMessage() + uses.value decrement. Charges-tracking ' +
    'items are gated with NO_CHARGES_REMAINING when at zero, since PF2e silently no-ops in ' +
    'that case. Wand and scroll consumption silently aborts on actors without a spellcasting ' +
    'entry; the tool detects this and returns USE_HAD_NO_EFFECT with a hint. ' +
    'For pure state edits (set quantity, decrement without chat), use pf2e_update_item_quantity or ' +
    'pf2e_remove_item_from_actor. For weapon attacks, armor donning, and other non-use interactions, ' +
    'use foundry_eval or wait for the dedicated tools. PF2e rules text on specific items ' +
    '(what a Bestial Mutagen actually does) lives at https://2e.aonprd.com/ — this tool ' +
    'executes the mechanical pipeline but does not explain item effects.',
  inputSchema: UseItemInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
    };
    const result = (await page.evaluate(useItemBody, args)) as UseItemResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        operation: result.operation,
        mode: result.mode,
        itemId: result.item.id,
        itemName: result.item.name,
        itemType: result.item.type,
        subtype: result.item.subtype,
        qtyBefore: result.item.qtyBefore,
        qtyAfter: result.item.qtyAfter,
        usesBefore: result.item.usesBefore,
        usesAfter: result.item.usesAfter,
        deleted: result.item.deleted,
        chatMessageId: result.chatMessageId,
      },
      'pf2e_use_item',
    );
    return [jsonText(result)];
  },
};
