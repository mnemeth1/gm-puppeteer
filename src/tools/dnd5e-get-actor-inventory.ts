import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eGetActorInventoryBody,
  type Dnd5eGetActorInventoryResult,
} from '../evaluators/dnd5e-get-actor-inventory.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eGetActorInventoryInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, NOT a compendium UUID). The D&D 5e actor ' +
          'whose physical inventory and currency to return.',
      ),
  })
  .strict();

export const dnd5eGetActorInventoryTool: ToolDefinition<typeof Dnd5eGetActorInventoryInput> = {
  name: 'dnd5e_get_actor_inventory',
  description:
    "Read-only list view of a D&D 5e actor's physical inventory (weapon, equipment, " +
    'consumable, tool, loot, container) plus their currency. Returns one flat array of items ' +
    'with structural fields only — id, uuid, name, type, quantity, weight, price, equipped, ' +
    'attunement, attuned, identified, container, a slim uses block (for charge-tracking ' +
    'items), and — on containers — their own coin pool. NO description text. Containers are ' +
    'returned as normal entries; nested items point back via their container id. Currency is ' +
    'a {pp, gp, ep, sp, cp} object (note electrum). Non-physical items (spells, feats, ' +
    'classes, races, facilities, etc.) are excluded. Use dnd5e_get_item_details for full ' +
    'per-item data including description.',
  inputSchema: Dnd5eGetActorInventoryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(dnd5eGetActorInventoryBody, {
      actorId: input.actorId,
    })) as Dnd5eGetActorInventoryResult;
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
