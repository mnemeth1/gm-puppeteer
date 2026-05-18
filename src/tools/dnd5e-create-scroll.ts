import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eCreateScrollBody,
  type Dnd5eCreateScrollResult,
} from '../evaluators/dnd5e-create-scroll.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eCreateScrollInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by dnd5e_get_actor_inventory). The ' +
          'destination actor. Must be a character or npc.',
      ),
    spellUuid: z
      .string()
      .min(1)
      .describe(
        'Full Spell UUID (e.g. "Compendium.dnd5e.spells.Item.0xmXiPiuYws1OGcX"), as returned ' +
          'by dnd5e_search_compendium for a spell. Must resolve to an Item whose type is ' +
          '"spell". For granting an already-finished compendium scroll/wand item, use ' +
          'dnd5e_add_item_to_actor instead.',
      ),
    level: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe(
        "The spell-slot level the scroll casts the spell at. Defaults to the spell's base " +
          'level. Must be ≥ the base level (a scroll cannot downcast); upcasting raises the ' +
          'embedded cast level only — the scroll item template/rarity stays keyed to the ' +
          "base level. Cantrips (base level 0) cannot be upcast.",
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'How many scrolls to create. Default 1. Produces one inventory entry holding this ' +
          'quantity.',
      ),
    containerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Item id of a container (type "container") on the destination actor. When set, the ' +
          'new scroll is placed inside that container; when unset, it lives at the inventory ' +
          'root.',
      ),
    identified: z
      .boolean()
      .optional()
      .describe(
        'Whether the created scroll is identified. Default true. Pass false to create a ' +
          'mystery scroll for loot — it displays its unidentified name until identified.',
      ),
  })
  .strict();

export const dnd5eCreateScrollTool: ToolDefinition<typeof Dnd5eCreateScrollInput> = {
  name: 'dnd5e_create_scroll',
  description:
    'Generate a D&D 5e spell-scroll consumable from a Spell UUID and place it on an actor. ' +
    "Mirrors the dnd5e system's spell-to-scroll workflow: runs Item5e.createScrollFromSpell " +
    'and persists the result, producing a fully-functional consumable (type "consumable", ' +
    'subtype "scroll") whose cast effect lives in an embedded activity. Returns {item} with ' +
    'id, uuid, name, spellName, castLevel, baseSpellLevel, quantity, containerId, and ' +
    'identified. Scroll-only: D&D 5e has no per-spell wand generation — 5e wands are bespoke ' +
    'SRD items, granted via dnd5e_add_item_to_actor. The cast level defaults to the spell’s ' +
    'base level; upcasting is allowed (raises the embedded cast level), downcasting is not, ' +
    'and cantrips cannot be upcast. For granting an existing finished compendium consumable ' +
    '(a Potion of Healing, a named wand), use dnd5e_add_item_to_actor instead — this tool is ' +
    'specifically for spell-to-scroll generation.',
  inputSchema: Dnd5eCreateScrollInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      spellUuid: input.spellUuid,
      level: input.level ?? null,
      quantity: input.quantity ?? 1,
      containerId: input.containerId ?? null,
      identified: input.identified ?? true,
    };
    const result = (await page.evaluate(
      dnd5eCreateScrollBody,
      args,
    )) as Dnd5eCreateScrollResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        itemId: result.item.id,
        spellUuid: input.spellUuid,
        spellName: result.item.spellName,
        castLevel: result.item.castLevel,
        quantity: result.item.quantity,
      },
      'dnd5e_create_scroll',
    );
    return [jsonText(result)];
  },
};
