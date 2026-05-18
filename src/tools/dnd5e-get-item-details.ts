import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eGetItemDetailsBody,
  PROJECTED_ITEM_TYPES,
  type Dnd5eGetItemDetailsResult,
} from '../evaluators/dnd5e-get-item-details.js';
import { jsonText, type ToolDefinition } from './types.js';

const KNOWN_PROJECTIONS = new Set<string>(PROJECTED_ITEM_TYPES);

const Dnd5eGetItemDetailsInput = z
  .object({
    uuid: z
      .string()
      .min(1)
      .describe(
        'Full Foundry Item UUID. Two shapes are accepted uniformly: ' +
          '`Actor.{actorId}.Item.{itemId}` for actor-embedded items, and ' +
          '`Compendium.{packCollectionId}.Item.{docId}` for compendium-resident items ' +
          '(the `uuid` returned by dnd5e_search_compendium for item packs). Resolves via ' +
          "Foundry's `fromUuid`. Returns NOT_FOUND if the UUID doesn't resolve, " +
          'WRONG_DOCUMENT_TYPE if it resolves to a non-Item document.',
      ),
    descriptionFormat: z
      .enum(['html', 'text', 'both'])
      .optional()
      .describe(
        'Which description shape(s) to include. "html" returns only `description` (raw HTML). ' +
          '"text" returns only `descriptionText` (tag-stripped, paragraph structure preserved). ' +
          '"both" (default) returns both fields.',
      ),
    includeEffects: z
      .boolean()
      .optional()
      .describe(
        "Include a slim projection of the item's Active Effects under `effects` " +
          '(id, name, disabled, transfer, durationSeconds, changesCount). Off by default. ' +
          'The D&D 5e analogue of the PF2e rule-elements opt-in.',
      ),
    includeRawSystem: z
      .boolean()
      .optional()
      .describe(
        'Include the full `system` object verbatim under `rawSystem` (JSON-roundtripped for ' +
          'wire safety). Off by default since the typed projection covers the common needs. ' +
          'Note: for item types without a known projection, `rawSystem` is always included ' +
          'regardless of this flag.',
      ),
  })
  .strict();

export const dnd5eGetItemDetailsTool: ToolDefinition<typeof Dnd5eGetItemDetailsInput> = {
  name: 'dnd5e_get_item_details',
  description:
    'Read-only fetch of full per-item data for any D&D 5e Foundry Item by UUID. Returns ' +
    'identification (name, identifier, rarity), provenance (source book, compendium source ' +
    'UUID), description (HTML and/or tag-stripped text), and a type-specific projection block. ' +
    'Physical items (weapon, equipment, consumable, tool, loot, container) also get a shared ' +
    '`physical` block with quantity, weight, price, equipped/attunement state, and durability. ' +
    'Items that track charges get a top-level `uses` block (spent / max / remaining). ' +
    'Type-specific projections cover all thirteen D&D 5e item types: weapon, equipment, ' +
    'consumable, tool, loot, container, spell, feat, background, class, subclass, race, ' +
    'facility. Companion to dnd5e_search_compendium — pass any `uuid` it returns here to read ' +
    'full item detail. NOT for D&D 5e rules text (the rules glossary) — use dnd5e_search_rules. ' +
    'NOT for creature stat blocks — use dnd5e_get_creature_details. Pass `includeEffects: true` ' +
    "for the item's Active Effects, `includeRawSystem: true` for the full system blob.",
  inputSchema: Dnd5eGetItemDetailsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      uuid: input.uuid,
      descriptionFormat: input.descriptionFormat ?? 'both',
      includeEffects: input.includeEffects ?? false,
      includeRawSystem: input.includeRawSystem ?? false,
    };
    const result = (await page.evaluate(
      dnd5eGetItemDetailsBody,
      args,
    )) as Dnd5eGetItemDetailsResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    if (!KNOWN_PROJECTIONS.has(result.type)) {
      ctx.log.warn(
        { uuid: input.uuid, type: result.type },
        'dnd5e_get_item_details: no typed projection for item type — falling back to rawSystem',
      );
    }
    return [jsonText(result)];
  },
};
