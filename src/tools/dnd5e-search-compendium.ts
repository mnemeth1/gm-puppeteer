import { z } from 'zod';
import {
  dnd5eSearchCompendiumBody,
  type Dnd5eSearchCompendiumResult,
} from '../evaluators/dnd5e-search-compendium.js';
import { jsonText, type ToolDefinition } from './types.js';

const RangeFilter = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .strict()
  .describe('Inclusive numeric range for a range-type filter (e.g. level, cr, price).');

const SetFilterObject = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .describe('Explicit include / exclude choice lists for a set-type filter.');

// One filter value. The accepted shape depends on the filter's kind:
// range → {min,max}; set / derived → string[] (include shorthand) or
// {include,exclude}; boolean → true/false. Nested union — fine, the
// top-level inputSchema stays an object.
const FilterValue = z.union([
  RangeFilter,
  z.array(z.string().min(1)),
  SetFilterObject,
  z.boolean(),
]);

const Dnd5eSearchCompendiumInput = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Case-insensitive substring match against the document name. Optional — filters alone can drive a search.',
      ),
    documentClass: z
      .enum(['Item', 'Actor', 'JournalEntry', 'RollTable'])
      .optional()
      .describe(
        'Foundry document class to search. Omit to search Item + Actor packs (the common case). Use "JournalEntry" for the rules glossary / lore packs and "RollTable" for roll tables.',
      ),
    types: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'D&D 5e document subtypes to search, e.g. ["spell"], ["npc"], ["weapon","equipment"]. Item subtypes: spell, weapon, equipment, consumable, tool, loot, container, feat, class, subclass, race, background. Actor subtypes: npc, vehicle, character. Drives the result set AND selects which filter keys are valid. When documentClass is omitted, subtypes are routed to Item or Actor automatically; unrecognized subtypes come back in `unknownTypes`.',
      ),
    filters: z
      .record(z.string().min(1), FilterValue)
      .optional()
      .describe(
        'Structured filters keyed by the dnd5e Compendium Browser filter names for the chosen `types`. ' +
          'Range filters take {min,max}: `level` (spell, 0-9), `cr` (npc Challenge Rating, fractions allowed), `price` (physical items). ' +
          'Set filters take a string[] (include) or {include,exclude}: `school` (abj/con/div/enc/evo/ill/nec/trs), `properties`, `rarity` (common/uncommon/rare/veryRare/legendary/artifact), `size` (tiny/sm/med/lg/huge/grg), `type` (npc creature type, or item subtype), `category`/`subtype` (feat), `spelllist`, `habitat`, `movement` (walk/burrow/climb/fly/jump/swim), `abilityScoreImprovement`, `mastery`, `class`. ' +
          'Boolean filters take true/false: `attunement`, `hasSpellcasting`, `hasDarkvision`. ' +
          'A filter key not valid for any searched type is ignored and reported in `unknownFilterKeys` — narrow `types` to a single subtype to use type-specific filters.',
      ),
    pack: z
      .string()
      .min(1)
      .optional()
      .describe('Restrict to a single pack by its collection id (e.g. "dnd5e.monsters").'),
    packs: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Restrict to a set of pack collection ids. Combined with `pack` via AND.'),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Compendium-folder name to match (case-insensitive, exact). Matches if the name appears anywhere in an entry\'s folder ancestry, so a parent folder broadens recursively — e.g. "Premades" matches every level subfolder. dnd5e content is heavily folder-organized; this reaches groupings (like premade-PC level) not in the index. Every result row carries `folderPath`.',
      ),
    descriptionMatch: z
      .string()
      .min(2)
      .optional()
      .describe(
        'Case-insensitive substring match against the document description body. EXPENSIVE — runs a full-document load on every entry that survived the other filters. Pre-narrow with types / filters / pack first. When set, result rows include description / descriptionText / descriptionMatchExcerpt.',
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

type Dnd5eSearchCompendiumArgs = z.infer<typeof Dnd5eSearchCompendiumInput>;

function hasAnyFilter(input: Dnd5eSearchCompendiumArgs): boolean {
  return (
    input.query !== undefined ||
    (input.types !== undefined && input.types.length > 0) ||
    (input.filters !== undefined && Object.keys(input.filters).length > 0) ||
    input.pack !== undefined ||
    (input.packs !== undefined && input.packs.length > 0) ||
    input.folder !== undefined ||
    input.descriptionMatch !== undefined
  );
}

export const dnd5eSearchCompendiumTool: ToolDefinition<typeof Dnd5eSearchCompendiumInput> = {
  name: 'dnd5e_search_compendium',
  description:
    "Search the world's compendium packs for D&D 5e documents by name and/or structured " +
    "filters. Runs on the dnd5e system's own Compendium Browser engine — the same machinery " +
    'behind the GUI "Compendium Browser" button — so it honors the GM\'s browser source ' +
    'settings (packs disabled there are skipped) and excludes items nested inside containers. ' +
    'Filters compose with AND: `query` (name substring), `documentClass`, `types` (subtypes), ' +
    '`filters` (structured per-type filters: level/cr/price ranges, school/size/rarity/' +
    'properties/habitat/movement/etc. sets, attunement/hasSpellcasting/hasDarkvision booleans), ' +
    '`pack`/`packs`, `folder`. All optional, but at least one of query/types/filters/pack/' +
    'packs/folder/descriptionMatch must be provided. `folder` matches a compendium-folder name ' +
    "anywhere in an entry's ancestry. Returns lightweight rows ({id, uuid, name, type, pack, " +
    'packLabel, img, cr, spellLevel, creatureType, rarity, source, folderPath}); follow-up ' +
    'detail reads use the dnd5e_get_* / pf2e_get_* tools. `descriptionMatch` opts in to a ' +
    'full-document body scan (expensive — always pre-narrow first). Searches *world content* ' +
    '(monster stat blocks, items, spells, NPCs, pre-made PCs to drop onto scenes). For D&D 5e ' +
    'rules text (conditions, actions, the rules glossary) pass `documentClass: "JournalEntry"` ' +
    '— that content lives in JournalEntry packs (e.g. dnd5e.content24, dnd5e.rules). Roll ' +
    'tables: `documentClass: "RollTable"`.',
  inputSchema: Dnd5eSearchCompendiumInput,
  async handler(input, ctx) {
    if (!hasAnyFilter(input)) {
      return [
        jsonText({
          ok: false,
          error: {
            code: 'NO_FILTERS',
            message:
              'dnd5e_search_compendium requires at least one of query, types, filters, pack, packs, folder, or descriptionMatch. Refusing to scan all world packs unconditionally.',
          },
        }),
      ];
    }
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.documentClass !== undefined ? { documentClass: input.documentClass } : {}),
      ...(input.types !== undefined ? { types: input.types } : {}),
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
      ...(input.pack !== undefined ? { pack: input.pack } : {}),
      ...(input.packs !== undefined ? { packs: input.packs } : {}),
      ...(input.folder !== undefined ? { folder: input.folder } : {}),
      ...(input.descriptionMatch !== undefined ? { descriptionMatch: input.descriptionMatch } : {}),
      limit: input.limit ?? 20,
    };
    const result = (await page.evaluate(
      dnd5eSearchCompendiumBody,
      args,
    )) as Dnd5eSearchCompendiumResult;
    return [jsonText(result)];
  },
};
