import { z } from 'zod';
import {
  pf2eSearchCompendiumBody,
  type Pf2eSearchCompendiumResult,
} from '../evaluators/pf2e-search-compendium.js';
import { jsonText, type ToolDefinition } from './types.js';

const DocumentType = z.enum(['Actor', 'Item', 'JournalEntry', 'RollTable', 'Macro']);

const Pf2eSearchCompendiumInput = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Case-insensitive substring match against the document name. Optional — filters alone can drive a search.',
      ),
    pack: z
      .string()
      .min(1)
      .optional()
      .describe('Restrict to a single pack by its collection id (e.g. "pf2e.actionspf2e").'),
    packs: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Restrict to a set of pack collection ids. Combined with `pack` via AND.'),
    type: DocumentType.optional().describe(
      'Restrict to a single Foundry document type (Actor, Item, JournalEntry, RollTable, Macro).',
    ),
    level: z
      .object({
        min: z.number().int().optional(),
        max: z.number().int().optional(),
      })
      .strict()
      .optional()
      .describe(
        'Inclusive level range. Reads system.details.level.value (NPCs) or system.level.value (items). Entries without a level are excluded when this filter is set.',
      ),
    traits: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'PF2e traits to match (any-of semantics within the array). Reads system.traits.value. Case-insensitive.',
      ),
    rarity: z
      .enum(['common', 'uncommon', 'rare', 'unique'])
      .optional()
      .describe('Exact rarity match against system.traits.rarity.'),
    source: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Source-book substring match (any-of). Reads system.publication.title or system.details.publication.title. Case-insensitive.',
      ),
    actorType: z
      .enum(['npc', 'hazard', 'familiar', 'character', 'loot', 'party', 'vehicle', 'army'])
      .optional()
      .describe('Narrow Actor results to a specific PF2e actor type. Implies Actor-only packs.'),
    itemType: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Narrow Item results to a specific PF2e item type (e.g. "weapon", "spell", "feat"). Implies Item-only packs.',
      ),
    descriptionMatch: z
      .string()
      .min(2)
      .optional()
      .describe(
        'Case-insensitive substring match against the document description body. EXPENSIVE — runs a full-document load on every entry that survived the other filters. Pre-narrow with type / level / traits / pack to keep latency tolerable. When set, the result rows include description / descriptionText / descriptionMatchExcerpt.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of results to return. Default 20, max 100.'),
  })
  .strict();

type Pf2eSearchCompendiumArgs = z.infer<typeof Pf2eSearchCompendiumInput>;

function hasAnyFilter(input: Pf2eSearchCompendiumArgs): boolean {
  return (
    input.query !== undefined ||
    input.pack !== undefined ||
    (input.packs !== undefined && input.packs.length > 0) ||
    input.type !== undefined ||
    input.level !== undefined ||
    (input.traits !== undefined && input.traits.length > 0) ||
    input.rarity !== undefined ||
    (input.source !== undefined && input.source.length > 0) ||
    input.actorType !== undefined ||
    input.itemType !== undefined ||
    input.descriptionMatch !== undefined
  );
}

export const pf2eSearchCompendiumTool: ToolDefinition<typeof Pf2eSearchCompendiumInput> = {
  name: 'pf2e_search_compendium',
  description:
    "Search the world's compendium packs for documents by name and/or structured filters. " +
    'Filters compose with AND: `query` (name substring), `pack`/`packs`, `type`, `actorType`, ' +
    '`itemType`, `level: {min, max}`, `traits[]` (any-of), `rarity`, `source[]` (any-of). All ' +
    'are optional, but at least one must be provided. Returns lightweight rows ' +
    '({id, uuid, name, type, pack, packLabel, img, level, traits, rarity, source}); follow-up ' +
    'reads go through `pf2e_get_item_details` or `pf2e_get_creature_details`. `descriptionMatch` opts in ' +
    'to a full-document body scan and includes description fields on hits — expensive, so ' +
    'always pre-narrow with the cheap filters first. Searches *world content* (stat blocks, ' +
    'items, monsters to drop on scenes). NOT for PF2e rules text (actions, spells, feats, ' +
    'conditions, traits) — fetch those from https://2e.aonprd.com/ via web-fetch. Roll tables ' +
    'live in compendia as RollTable documents (use `type: "RollTable"`) but encounter-prep ' +
    'should use this tool plus `pf2e_get_creature_details`, not random rolls.',
  inputSchema: Pf2eSearchCompendiumInput,
  async handler(input, ctx) {
    if (!hasAnyFilter(input)) {
      return [
        jsonText({
          ok: false,
          error: {
            code: 'NO_FILTERS',
            message:
              'pf2e_search_compendium requires at least one of query, pack, packs, type, actorType, itemType, level, traits, rarity, source, or descriptionMatch. Refusing to scan all world packs unconditionally.',
          },
        }),
      ];
    }
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.pack !== undefined ? { pack: input.pack } : {}),
      ...(input.packs !== undefined ? { packs: input.packs } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.traits !== undefined ? { traits: input.traits } : {}),
      ...(input.rarity !== undefined ? { rarity: input.rarity } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.actorType !== undefined ? { actorType: input.actorType } : {}),
      ...(input.itemType !== undefined ? { itemType: input.itemType } : {}),
      ...(input.descriptionMatch !== undefined ? { descriptionMatch: input.descriptionMatch } : {}),
      limit: input.limit ?? 20,
    };
    const result = (await page.evaluate(
      pf2eSearchCompendiumBody,
      args,
    )) as Pf2eSearchCompendiumResult;
    return [jsonText(result)];
  },
};
