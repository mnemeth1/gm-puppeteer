import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eGetActorStateBody,
  SUPPORTED_ACTOR_TYPES,
  type Dnd5eGetActorStateResult,
} from '../evaluators/dnd5e-get-actor-state.js';
import { jsonText, type ToolDefinition } from './types.js';

const KNOWN_TYPES = new Set<string>(SUPPORTED_ACTOR_TYPES);

/**
 * Schema for `dnd5e_get_actor_state`. Single required input (`actorId`)
 * plus four opt-in flags that expand the projection — the same flag set as
 * the PF2e sibling `pf2e_get_actor_state`.
 */
const Dnd5eGetActorStateInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, NOT a compendium UUID). The actor whose ' +
          'state to project. Supported actor types: character, npc. Other types ' +
          '(vehicle, group, encounter) are rejected with ACTOR_TYPE_UNSUPPORTED.',
      ),
    includeSkills: z
      .boolean()
      .optional()
      .describe(
        'Include the full 18-skill array — key, name, ability, modifier, passive score, and ' +
          'proficiency multiplier (0/1/2) for every D&D 5e skill. Off by default; opt in for ' +
          'skill-check planning. Note 5e perception is the `prc` skill (there is no separate ' +
          'perception stat); senses are always in the top-level `senses` block.',
      ),
    includeSpellcasting: z
      .boolean()
      .optional()
      .describe(
        'Include a spellcasting block: spellcasting ability, save DC, spell attack bonus, the ' +
          'per-level slot table, the pact-magic pool, and known-spell count. Off by default. ' +
          'Non-casters return a block with a null ability and empty slots.',
      ),
    includeEncounterState: z
      .boolean()
      .optional()
      .describe(
        'Expand `encounter` from `{inCombat: bool}` to the full combatant shape: combatId, ' +
          'combatantId, initiative, isCurrentTurn, round, roundOfLastTurn. Off by default since ' +
          'most callers only need the boolean.',
      ),
    includeRawSystem: z
      .boolean()
      .optional()
      .describe(
        'Include the full `actor.system` object verbatim under `rawSystem` (JSON-roundtripped ' +
          'for wire safety). Off by default since the typed projection covers the common needs. ' +
          'Use when the typed projection is missing a field you need.',
      ),
  })
  .strict();

export const dnd5eGetActorStateTool: ToolDefinition<typeof Dnd5eGetActorStateInput> = {
  name: 'dnd5e_get_actor_state',
  description:
    "Read-only projection of a D&D 5e actor's combat-relevant runtime state: HP, AC, ability " +
    'scores + modifiers + saving throws, senses, movement speeds, active conditions, active ' +
    'effects, resources (hit dice, custom pools, legendary actions/resistances), and vitals ' +
    '(death saves, exhaustion level, inspiration). Supports character and npc actor types. ' +
    'Companion to dnd5e_get_actor_inventory (items + currency) and dnd5e_get_item_details ' +
    "(per-item drill-down) — this tool is the “what's this actor's situation?” surface and the " +
    'foundation for the future D&D 5e condition-mutation cluster (dnd5e_apply_condition / ' +
    'dnd5e_remove_condition). The `conditions[]` array lists active status ids with the backing ' +
    'Active Effect id (`effectId`) when one exists, and exhaustion with its numeric level; it ' +
    'intentionally overlaps `effects[]` (the document-centric view of the same Active Effects). ' +
    'Opt-in flags: includeSkills (full 18-skill array), includeSpellcasting (slot table + DC), ' +
    'includeEncounterState (full combatant shape vs just the inCombat boolean), includeRawSystem ' +
    '(full system blob). ' +
    'Out of scope: inventory (use dnd5e_get_actor_inventory), per-item details (use ' +
    'dnd5e_get_item_details), npc/vehicle stat-block reference (use dnd5e_get_creature_details), ' +
    'D&D 5e rules text (use dnd5e_search_rules), mutation, party aggregates, deltas vs. previous ' +
    'state.',
  inputSchema: Dnd5eGetActorStateInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      includeSkills: input.includeSkills ?? false,
      includeSpellcasting: input.includeSpellcasting ?? false,
      includeEncounterState: input.includeEncounterState ?? false,
      includeRawSystem: input.includeRawSystem ?? false,
    };
    const result = (await page.evaluate(dnd5eGetActorStateBody, args)) as Dnd5eGetActorStateResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    if (!KNOWN_TYPES.has(result.actor.type)) {
      ctx.log.warn(
        { actorId: input.actorId, type: result.actor.type },
        'dnd5e_get_actor_state: actor type fell outside supported set — projection may be incomplete',
      );
    }
    return [jsonText(result)];
  },
};
