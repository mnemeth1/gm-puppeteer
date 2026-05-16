import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getCreatureDetailsBody,
  SUPPORTED_CREATURE_TYPES,
  type GetCreatureDetailsResult,
} from '../evaluators/get-creature-details.js';
import { jsonText, type ToolDefinition } from './types.js';

const KNOWN_TYPES = new Set<string>(SUPPORTED_CREATURE_TYPES);

const GetCreatureDetailsInput = z
  .object({
    uuid: z
      .string()
      .min(1)
      .describe(
        'Full Foundry Actor UUID. Two shapes are accepted uniformly: ' +
          '`Actor.{actorId}` for world-resident actors (use after create_actor_from_compendium), ' +
          'and `Compendium.{packCollectionId}.Actor.{docId}` for compendium-resident creatures ' +
          '(the value returned by search_compendium when searching actor packs). Resolves via ' +
          "Foundry's `fromUuid` — handles both shapes without preloading the pack. Returns " +
          "NOT_FOUND if the UUID doesn't resolve, WRONG_DOCUMENT_TYPE if it resolves to a " +
          'non-Actor document, ACTOR_TYPE_UNSUPPORTED if the actor is a PC / party / army / ' +
          'loot / vehicle (use get_actor_state for PCs).',
      ),
    descriptionFormat: z
      .enum(['html', 'text', 'both'])
      .optional()
      .describe(
        'Which description shape(s) to include. Applies to the base creature description AND, ' +
          'for hazards, the `disable` / `routine` / `reset` prose blocks AND each entry in the ' +
          '`actions` array. "html" returns only HTML fields. "text" returns only the ' +
          'tag-stripped *Text variants (paragraph structure preserved, PF2e @-syntax intact). ' +
          '"both" (default) returns both shapes.',
      ),
    includeRules: z
      .boolean()
      .optional()
      .describe(
        "Include raw `system.rules` — the PF2e active-effects engine's rule elements (auras, " +
          'IWR mutators, etc.). Off by default; opt in for diagnostics or rule-element ' +
          'inspection.',
      ),
    includeRawSystem: z
      .boolean()
      .optional()
      .describe(
        'Include the full `system` object verbatim under `rawSystem` (JSON-roundtripped for ' +
          'wire safety). Off by default — the typed projection covers the common stat-block ' +
          'needs. Opt in when projecting fields are missing or to spelunk unfamiliar shape.',
      ),
  })
  .strict();

export const getCreatureDetailsTool: ToolDefinition<typeof GetCreatureDetailsInput> = {
  name: 'get_creature_details',
  description:
    "Read-only fetch of full per-creature stat-block data for any Foundry Actor of type 'npc', " +
    "'hazard', or 'familiar' by UUID. Returns identification, provenance (compendium source, " +
    'PF2e sourcebook citation), description, traits, and a per-type projection block. For NPCs: ' +
    'AC, HP, saves, perception+senses, ability mods, speeds, languages, curated skills, strikes ' +
    '(with damage rolls, attack bonus, traits, melee/ranged discrimination), unified actions ' +
    'array (passive/reaction/free/active abilities), spellcasting entries with slot tables, and ' +
    'IWR. For hazards: hardness, HP/broken-threshold, Stealth DC, disable/routine/reset prose, ' +
    'simple-vs-complex flag, saves, attacks, actions, IWR. For familiars: slim sheet with master ' +
    'pointer, HP/AC (inherited at runtime), perception, speeds, reach, actions. NOT for PC ' +
    "actors (type 'character') — use get_actor_state for those, which surfaces runtime state " +
    '(conditions, effects, vitals, hero points) that this tool deliberately omits. NOT for ' +
    'PF2e rules text (spells, feats, conditions, action mechanics) — fetch those from Archives ' +
    'of Nethys at https://2e.aonprd.com/ via web-fetch. Companion to search_compendium for ' +
    'encounter prep: search a bestiary pack, then pass the returned UUID here to read the ' +
    'stat block before spawning. Pass `includeRules: true` for raw rule elements, ' +
    '`includeRawSystem: true` for the full system blob.',
  inputSchema: GetCreatureDetailsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      uuid: input.uuid,
      descriptionFormat: input.descriptionFormat ?? 'both',
      includeRules: input.includeRules ?? false,
      includeRawSystem: input.includeRawSystem ?? false,
    };
    const result = (await page.evaluate(getCreatureDetailsBody, args)) as GetCreatureDetailsResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    if (!KNOWN_TYPES.has(result.type)) {
      ctx.log.warn(
        { uuid: input.uuid, type: result.type },
        'get_creature_details: actor type fell outside supported set — projection may be incomplete',
      );
    }
    return [jsonText(result)];
  },
};
