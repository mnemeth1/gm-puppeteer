import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eGetCreatureDetailsBody,
  SUPPORTED_CREATURE_TYPES,
  type Dnd5eGetCreatureDetailsResult,
} from '../evaluators/dnd5e-get-creature-details.js';
import { jsonText, type ToolDefinition } from './types.js';

const KNOWN_TYPES = new Set<string>(SUPPORTED_CREATURE_TYPES);

const Dnd5eGetCreatureDetailsInput = z
  .object({
    uuid: z
      .string()
      .min(1)
      .describe(
        'Full Foundry Actor UUID. Two shapes are accepted uniformly: ' +
          '`Actor.{actorId}` for world-resident actors, and ' +
          '`Compendium.{packCollectionId}.Actor.{docId}` for compendium-resident creatures ' +
          '(the `uuid` returned by dnd5e_search_compendium for actor packs). Resolves via ' +
          "Foundry's `fromUuid`. Returns NOT_FOUND if the UUID doesn't resolve, " +
          'WRONG_DOCUMENT_TYPE if it resolves to a non-Actor document, and ' +
          'ACTOR_TYPE_UNSUPPORTED if the actor is a PC (type=character — use ' +
          'dnd5e_get_actor_state) or a group / encounter actor.',
      ),
    descriptionFormat: z
      .enum(['html', 'text', 'both'])
      .optional()
      .describe(
        'Which description shape(s) to include. Applies to the base creature description ' +
          'AND to each feature in the `features` / vehicle `actions` arrays. "html" returns ' +
          'only HTML fields, "text" only the tag-stripped *Text variants, "both" (default) ' +
          'returns both.',
      ),
    includeEffects: z
      .boolean()
      .optional()
      .describe(
        "Include a slim projection of the actor's Active Effects under `effects` " +
          '(id, name, disabled, transfer, durationSeconds, changesCount). Off by default. ' +
          'This is the D&D 5e analogue of the PF2e rule-elements opt-in — 5e has no ' +
          'rule-element array, the effects engine is Active Effects.',
      ),
    includeRawSystem: z
      .boolean()
      .optional()
      .describe(
        'Include the full `system` object verbatim under `rawSystem` (JSON-roundtripped for ' +
          'wire safety). Off by default — the typed projection covers the common stat-block ' +
          'needs. Opt in when projected fields are missing or to spelunk unfamiliar shape.',
      ),
  })
  .strict();

export const dnd5eGetCreatureDetailsTool: ToolDefinition<typeof Dnd5eGetCreatureDetailsInput> = {
  name: 'dnd5e_get_creature_details',
  description:
    'Read-only fetch of full per-creature stat-block data for a D&D 5e Foundry Actor of type ' +
    "'npc' or 'vehicle' by UUID. Returns identification (name, CR, creature type, size), " +
    'provenance (source book, compendium source UUID), description, and a per-type projection ' +
    'block. For NPCs: AC, HP, proficiency bonus, XP, alignment, initiative, ability scores ' +
    '(score + modifier + saving-throw bonus + proficiency), a flat saves summary, curated ' +
    'stat-block skills, senses, movement speeds, languages, damage immunities/resistances/' +
    'vulnerabilities + condition immunities, attacks (to-hit + damage + range, from the ' +
    "system's resolved item labels), passive/active features, and spellcasting (slot table, " +
    'save DC, spell attack bonus). For vehicles: vehicle category, AC, HP + damage threshold, ' +
    'abilities, speeds, cargo/creature capacity, dimensions, actions, crew/passengers. NOT for ' +
    "PC actors (type 'character') — use dnd5e_get_actor_state for those. NOT for D&D 5e rules " +
    'text (spells, conditions, the rules glossary) — use dnd5e_search_rules. Companion to ' +
    'dnd5e_search_compendium for encounter prep: search an actor pack, then pass the returned ' +
    'UUID here to read the stat block before spawning. Pass `includeEffects: true` for the ' +
    "actor's Active Effects, `includeRawSystem: true` for the full system blob.",
  inputSchema: Dnd5eGetCreatureDetailsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      uuid: input.uuid,
      descriptionFormat: input.descriptionFormat ?? 'both',
      includeEffects: input.includeEffects ?? false,
      includeRawSystem: input.includeRawSystem ?? false,
    };
    const result = (await page.evaluate(
      dnd5eGetCreatureDetailsBody,
      args,
    )) as Dnd5eGetCreatureDetailsResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    if (!KNOWN_TYPES.has(result.type)) {
      ctx.log.warn(
        { uuid: input.uuid, type: result.type },
        'dnd5e_get_creature_details: actor type fell outside supported set — projection may be incomplete',
      );
    }
    return [jsonText(result)];
  },
};
