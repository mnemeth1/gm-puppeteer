import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  pf2eGetActorInventoryBody,
  type Pf2eGetActorInventoryResult,
} from '../evaluators/pf2e-get-actor-inventory.js';
import { jsonText, type ToolDefinition } from './types.js';

const Pf2eGetActorInventoryInput = z
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

export const pf2eGetActorInventoryTool: ToolDefinition<typeof Pf2eGetActorInventoryInput> = {
  name: 'pf2e_get_actor_inventory',
  description:
    "Read-only list view of an actor's physical inventory (weapons, armor, shields, " +
    'consumables, equipment, treasure, containers, ammo) plus their currency. Returns one ' +
    'flat array of items with structural fields only — id, uuid, name, type, category, ' +
    'quantity, equipped, containerId, bulk, traits, level, and (for weapon/armor/shield) ' +
    'runes. NO description text. Containers are returned as normal entries; nested items ' +
    'point back via containerId. Non-physical items (feats, spells, ancestries, conditions, ' +
    'NPC strike defs, etc.) are excluded — those belong to future per-domain tools. Use ' +
    'pf2e_get_item_details for full per-item data including description.',
  inputSchema: Pf2eGetActorInventoryInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(pf2eGetActorInventoryBody, {
      actorId: input.actorId,
    })) as Pf2eGetActorInventoryResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
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
