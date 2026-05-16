import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getActorInventoryBody,
  type GetActorInventoryResult,
} from '../evaluators/get-actor-inventory.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetActorInventoryInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, NOT a compendium UUID). The actor whose ' +
          'physical inventory and currency to return.',
      ),
  })
  .strict();

export const getActorInventoryTool: ToolDefinition<typeof GetActorInventoryInput> = {
  name: 'get_actor_inventory',
  description:
    "Read-only list view of an actor's physical inventory (weapons, armor, shields, " +
    'consumables, equipment, treasure, containers, ammo) plus their currency. Returns one ' +
    'flat array of items with structural fields only — id, uuid, name, type, category, ' +
    'quantity, equipped, containerId, bulk, traits, level, and (for weapon/armor/shield) ' +
    'runes. NO description text. Containers are returned as normal entries; nested items ' +
    'point back via containerId. Non-physical items (feats, spells, ancestries, conditions, ' +
    'NPC strike defs, etc.) are excluded — those belong to future per-domain tools. Use ' +
    'get_item_details for full per-item data including description.',
  inputSchema: GetActorInventoryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(getActorInventoryBody, {
      actorId: input.actorId,
    })) as GetActorInventoryResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    return [
      jsonText({
        actorId: result.actorId,
        actorName: result.actorName,
        items: result.items,
        currency: result.currency,
      }),
    ];
  },
};
