import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  dnd5eGetAvailableConditionsBody,
  type Dnd5eGetAvailableConditionsResult,
} from '../evaluators/dnd5e-get-available-conditions.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eGetAvailableConditionsInput = z.object({}).strict();

export const dnd5eGetAvailableConditionsTool: ToolDefinition<
  typeof Dnd5eGetAvailableConditionsInput
> = {
  name: 'dnd5e_get_available_conditions',
  description:
    'Read-only enumeration of every status the D&D 5e system can apply to ' +
    'an actor (43 entries in dnd5e 5.3.3). One row per status with statusId ' +
    '(canonical status id, e.g. blinded, exhaustion, dead), name (display ' +
    'string), category, valued, maxValue, and reference. ' +
    'category is one of: "condition" (a core 5e condition — blinded, ' +
    'charmed, ..., unconscious, plus exhaustion), "pseudo-condition" (a ' +
    'status the system tracks like a condition but that is not one of the ' +
    'core conditions — bleeding, burning, cursed, diseased, falling, ' +
    'silenced, surprised, transformed, etc.), or "status" (a non-condition ' +
    'applyable status — concentrating, dead, dodging, flying, hiding, the ' +
    'cover and encumbrance tiers, etc.). ' +
    'valued is true only for exhaustion (the one status that carries a 1-N ' +
    'numeric level); maxValue is its level cap (6 in the 2024 rules) and ' +
    'null for every unvalued status. reference is a Compendium UUID into ' +
    'the rules glossary — feed it to dnd5e_search_rules or get_journal_page ' +
    'for the mechanical text; null when the system ships no reference. ' +
    'Sorted alphabetically by id. No inputs. ' +
    'Use this before calling dnd5e_apply_condition / dnd5e_set_condition_value ' +
    '/ dnd5e_remove_condition to pick the right statusId and learn which ' +
    'status accepts a value and what its cap is. ' +
    'NOT for rules text on what a condition does — fetch that via ' +
    'dnd5e_search_rules (or get_journal_page on the reference UUID). ' +
    'NOT for reading conditions currently applied to an actor — use ' +
    'dnd5e_get_actor_state for that.',
  inputSchema: Dnd5eGetAvailableConditionsInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(
      dnd5eGetAvailableConditionsBody,
    )) as Dnd5eGetAvailableConditionsResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        count: result.conditions.length,
        conditionCount: result.conditions.filter((c) => c.category === 'condition').length,
        pseudoCount: result.conditions.filter((c) => c.category === 'pseudo-condition').length,
        statusCount: result.conditions.filter((c) => c.category === 'status').length,
      },
      'dnd5e_get_available_conditions',
    );
    return [jsonText(result)];
  },
};
