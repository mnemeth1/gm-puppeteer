import { z } from 'zod';
import { ToolError } from '../errors.js';
import { getActorStateBody, type GetActorStateResult } from '../evaluators/get-actor-state.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `pf2e_get_actor_state`. Single required input (`actorId`) plus
 * four opt-in flags that expand the projection.
 *
 * No `descriptionFormat`-style flag — this tool does not return HTML
 * descriptions of conditions or effects. Callers needing condition or
 * effect description text should pass the entry's id back through
 * `pf2e_get_item_details` (or fetch the canonical PF2e rules from Archives
 * of Nethys).
 *
 * No condition-filtering flag — the conditions array is returned in
 * full; callers filter client-side.
 *
 * Numeric strictness: there are no numeric inputs here; the
 * strict-int / no-coerce convention from sibling mutation tools is
 * trivially satisfied.
 */
const GetActorStateInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, NOT a compendium UUID). The actor whose ' +
          'state to project. Supported actor types: character, npc, familiar. Other types ' +
          '(party, loot, hazard, vehicle, army) are rejected with ACTOR_TYPE_UNSUPPORTED.',
      ),
    includeSkills: z
      .boolean()
      .optional()
      .describe(
        'Include the full skills array — slug, name, modifier, proficiency (untrained..legendary) ' +
          'for every skill on the actor including lore skills. Off by default since most callers ' +
          "don't need it; opt in for skill-check planning.",
      ),
    includeSpellcasting: z
      .boolean()
      .optional()
      .describe(
        'Include spellcasting entries with category (prepared/spontaneous/focus/innate), ' +
          'tradition, and per-rank slot counts (slot0..slot11 where slot0 is cantrips). Off by ' +
          'default. Characters without spellcasting return an empty array.',
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
        'Include the full `actor.system` object verbatim under `rawSystem`. Off by default since ' +
          'the typed projection covers the common needs. Use when the typed projection is ' +
          'missing a field you need (and consider filing a request to add it to the projection).',
      ),
  })
  .strict();

export const getActorStateTool: ToolDefinition<typeof GetActorStateInput> = {
  name: 'pf2e_get_actor_state',
  description:
    "Read-only projection of an actor's combat-relevant state: HP, AC, saves, perception (with " +
    'senses), ability modifiers, speeds, active conditions, active effects, hero points / focus, ' +
    'immunities/weaknesses/resistances, and vitals (dying/wounded/doomed). Supports character, ' +
    'npc, and familiar actor types. Companion to pf2e_get_actor_inventory (items) and pf2e_get_item_details ' +
    "(per-item drill-down) — this tool is the “what's this actor's situation?” surface and the " +
    'foundation for the condition-mutation cluster (pf2e_apply_condition / pf2e_remove_condition). ' +
    'AC.value is the effective AC with all current modifiers applied (raised shield, frightened, ' +
    'unconscious, etc.). Save and perception modifiers are likewise effective values. The ' +
    '`conditions[]` array lists embedded condition items with slug + value + grantedBy linkage; ' +
    'the `vitals` block always reports dying/wounded/doomed numerically (value+max), independent ' +
    'of whether those conditions are currently in `conditions[]`. ' +
    'Opt-in flags: includeSkills (full skill array), includeSpellcasting (entries with slots), ' +
    'includeEncounterState (full combatant shape vs just the inCombat boolean), includeRawSystem ' +
    '(full system blob). ' +
    'Out of scope: inventory (use pf2e_get_actor_inventory), per-item details (use pf2e_get_item_details), ' +
    'condition/effect HTML descriptions (use pf2e_get_item_details on the embedded item id, or fetch ' +
    'canonical rules from Archives of Nethys), mutation (use the future pf2e_apply_condition / ' +
    'pf2e_remove_condition / pf2e_set_condition_value tools), party aggregates, NPC stat-block lookup, ' +
    'deltas vs. previous state.',
  inputSchema: GetActorStateInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      includeSkills: input.includeSkills ?? false,
      includeSpellcasting: input.includeSpellcasting ?? false,
      includeEncounterState: input.includeEncounterState ?? false,
      includeRawSystem: input.includeRawSystem ?? false,
    };
    const result = (await page.evaluate(getActorStateBody, args)) as GetActorStateResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    return [jsonText(result)];
  },
};
