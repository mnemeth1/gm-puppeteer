import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getAvailableConditionsBody,
  type GetAvailableConditionsResult,
} from '../evaluators/get-available-conditions.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetAvailableConditionsInput = z.object({}).strict();

export const getAvailableConditionsTool: ToolDefinition<typeof GetAvailableConditionsInput> = {
  name: 'pf2e_get_available_conditions',
  description:
    'Read-only enumeration of every PF2e condition the system exposes ' +
    '(44 entries in PF2e 8.1.2: blinded, broken, clumsy, ..., wounded). ' +
    'One row per condition with slug (canonical kebab-case identifier), ' +
    'name (display string), valued (boolean — true for conditions that ' +
    'carry a 1-N numeric value like frightened/sickened/dying, false for ' +
    'binary toggles like off-guard/prone/blinded), defaultMax (4 for ' +
    "valued non-vitals; null for vitals — vitals' cap is per-actor at " +
    'actor.system.attributes.{slug}.max — and null for non-valued), ' +
    'isVital (true for dying/wounded/doomed, whose max is actor-specific ' +
    'and dynamic — doomed reduces dying.max), and persistentDamage (true ' +
    'only for slug=persistent-damage; pf2e_apply_condition rejects that slug ' +
    "because PF2e's increaseCondition path for it opens a UI dialog " +
    'that blocks in headless — callers should skip it). Sorted ' +
    'alphabetically by slug. No inputs. ' +
    'Use this before calling pf2e_apply_condition / pf2e_set_condition_value / ' +
    'pf2e_remove_condition to disambiguate which slugs accept a value, what ' +
    'the effective cap is, and which slugs are unsupported. ' +
    'NOT for rules text on what a condition does (mechanical effects, ' +
    'recovery rules, interactions) — fetch those from ' +
    'https://2e.aonprd.com/Conditions.aspx via web-fetch. ' +
    'NOT for reading conditions currently applied to an actor — use ' +
    'pf2e_get_actor_state for that.',
  inputSchema: GetAvailableConditionsInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(
      getAvailableConditionsBody,
    )) as GetAvailableConditionsResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        count: result.conditions.length,
        valuedCount: result.conditions.filter((c) => c.valued).length,
      },
      'pf2e_get_available_conditions',
    );
    return [jsonText(result)];
  },
};
