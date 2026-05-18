import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  pf2eGetItemDetailsBody,
  PROJECTED_ITEM_TYPES,
  type Pf2eGetItemDetailsResult,
} from '../evaluators/pf2e-get-item-details.js';
import { jsonText, type ToolDefinition } from './types.js';

const KNOWN_PROJECTIONS = new Set<string>(PROJECTED_ITEM_TYPES);

const Pf2eGetItemDetailsInput = z
  .object({
    uuid: z
      .string()
      .min(1)
      .describe(
        'Full Foundry Item UUID. Two shapes are accepted uniformly: ' +
          '`Actor.{actorId}.Item.{itemId}` for actor-embedded items (the value returned in ' +
          '`uuid` fields by pf2e_get_actor_inventory), and `Compendium.{packCollectionId}.Item.{docId}` ' +
          'for compendium-resident items (the value returned by pf2e_search_compendium). Resolves via ' +
          "Foundry's `fromUuid` — handles both shapes without preloading the pack. Returns " +
          "NOT_FOUND error if the UUID doesn't resolve, WRONG_DOCUMENT_TYPE if it resolves to a " +
          'non-Item document.',
      ),
    descriptionFormat: z
      .enum(['html', 'text', 'both'])
      .optional()
      .describe(
        'Which description shape(s) to include. "html" returns only `description` (raw HTML). ' +
          '"text" returns only `descriptionText` (tag-stripped, paragraph structure preserved, ' +
          'PF2e @-syntax intact). "both" (default) returns both fields.',
      ),
    includeRules: z
      .boolean()
      .optional()
      .describe(
        "Include raw `system.rules` — the PF2e active-effects engine's rule elements. Off by " +
          'default; opt in when diagnosing active-effects behavior or building automation that ' +
          'inspects rule elements.',
      ),
    includeRawSystem: z
      .boolean()
      .optional()
      .describe(
        'Include the full `system` object verbatim under `rawSystem`. Off by default since the ' +
          'typed projection covers the common needs. Note: for item types without a known ' +
          'projection, `rawSystem` is always included regardless of this flag.',
      ),
  })
  .strict();

export const pf2eGetItemDetailsTool: ToolDefinition<typeof Pf2eGetItemDetailsInput> = {
  name: 'pf2e_get_item_details',
  description:
    'Read-only fetch of full per-item data for any Foundry Item by UUID. Returns identification, ' +
    'provenance (compendium source, PF2e sourcebook citation), description (HTML and/or ' +
    'text-stripped with @-syntax preserved), traits, and a type-specific projection block. ' +
    'Physical items also get a shared `physical` block with bulk, price, equipment state, ' +
    'identification status, hardness, HP. Companion to pf2e_get_actor_inventory — pass any `uuid` ' +
    'value from inventory results to get full details. Also works on compendium-resident items ' +
    'via `Compendium.{pack}.Item.{id}` UUIDs (use pf2e_search_compendium to find them). Type-specific ' +
    'projections cover: weapon, armor, shield, consumable, equipment, container, treasure, ammo, ' +
    'feat, action, ancestry, heritage, background, class, lore, spell. Unknown types fall back ' +
    'to a raw-system view. Pass `includeRules: true` for raw PF2e rule elements (active-effects ' +
    'engine internals), `includeRawSystem: true` for the full system object.',
  inputSchema: Pf2eGetItemDetailsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      uuid: input.uuid,
      descriptionFormat: input.descriptionFormat ?? 'both',
      includeRules: input.includeRules ?? false,
      includeRawSystem: input.includeRawSystem ?? false,
    };
    const result = (await page.evaluate(pf2eGetItemDetailsBody, args)) as Pf2eGetItemDetailsResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    if (!KNOWN_PROJECTIONS.has(result.type)) {
      ctx.log.warn(
        { uuid: input.uuid, type: result.type },
        'pf2e_get_item_details: no typed projection for item type — falling back to rawSystem',
      );
    }
    return [jsonText(result)];
  },
};
