import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  createScrollOrWandBody,
  type CreateScrollOrWandResult,
} from '../evaluators/create-scroll-or-wand.js';
import { jsonText, type ToolDefinition } from './types.js';

const CreateScrollOrWandInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by get_actor_inventory). The destination actor.',
      ),
    spellUuid: z
      .string()
      .min(1)
      .describe(
        'Full compendium Spell UUID (e.g. "Compendium.pf2e.spells-srd.Item.gKKqvLohtrSJj3BM"), ' +
          'as returned by search_compendium with documentType: "Item" and filter type: "spell". ' +
          'Must resolve to an Item whose type is "spell". Cantrips, focus spells, and rituals ' +
          'are rejected — they don\'t have a meaningful scroll/wand equivalent in PF2e.',
      ),
    kind: z
      .enum(['scroll', 'wand'])
      .describe(
        'Which consumable to create. Scrolls are single-use (uses.max: 1, autoDestroy: true); ' +
          'wands are once-per-day reusable (uses.max: 1, uses.value: 1, autoDestroy: false). ' +
          'Note that PF2e\'s remaster does not define a rank-10 wand — wand rank must be 1–9.',
      ),
    rank: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe(
        'The spell rank to scribe at. Must be ≥ the spell\'s base rank (heightening up is allowed; ' +
          'heightening down is not). Scrolls accept ranks 1–10; wands accept ranks 1–9.',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'How many to create. Default 1. Multiple entries do not auto-merge — each call produces ' +
          'one item entry with this quantity. Useful for stocking loot piles with consumables.',
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
        'Whether the created item is identified. Default true. Pass false to create a mystery ' +
          'scroll/wand for loot — the item will display its unidentified name (typically ' +
          '"Mysterious Scroll" or similar) until the player Identifies it.',
      ),
  })
  .strict();

export const createScrollOrWandTool: ToolDefinition<typeof CreateScrollOrWandInput> = {
  name: 'create_scroll_or_wand',
  description:
    'Generate a spell-specific scroll or wand consumable from a Spell UUID and place it on an ' +
    'actor. Mirrors PF2e\'s "drag a spell onto an actor" UI workflow: clones the generic per-rank ' +
    'template from CONFIG.PF2E.spellcastingItems (e.g. "Scroll of 1st-rank Spell" or "Magic Wand ' +
    '(5th-Rank Spell)") and embeds the source spell at the chosen rank. The resulting item is a ' +
    'fully-functional consumable that the PF2e use pipeline accepts. Returns ' +
    '{operation: "created", item} where item carries id, uuid, name, kind, rank, spellUuid, ' +
    'and containerId. Scrolls accept ranks 1–10; wands accept ranks 1–9 (PF2e\'s remaster has no ' +
    'rank-10 wand template). Cantrips, focus spells, and rituals are rejected — they don\'t ' +
    'have a meaningful scroll/wand equivalent in the PF2e rules. For PF2e rules text on specific ' +
    'spells, look up the spell at https://2e.aonprd.com/ rather than parsing the embedded ' +
    'description. For granting an existing physical compendium item (a Wand of Heal compendium ' +
    'entry, a Healing Potion), use add_item_to_actor instead — this tool is specifically for ' +
    'spell-to-consumable generation.',
  inputSchema: CreateScrollOrWandInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      spellUuid: input.spellUuid,
      kind: input.kind,
      rank: input.rank,
      quantity: input.quantity ?? 1,
      containerId: input.containerId ?? null,
      identified: input.identified ?? true,
    };
    const result = (await page.evaluate(
      createScrollOrWandBody,
      args,
    )) as CreateScrollOrWandResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        actorId: result.actor.id,
        itemId: result.item.id,
        kind: result.item.kind,
        rank: result.item.rank,
        spellUuid: input.spellUuid,
        quantity: result.item.quantity,
      },
      'create_scroll_or_wand',
    );
    return [jsonText(result)];
  },
};
