import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import { getCombatStateBody, type GetCombatStateResult } from '../evaluators/get-combat-state.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetCombatStateInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene id whose combat encounter to read; defaults to the world-active ' +
          'scene. A Combat is owned by a scene, so the scene determines which ' +
          'encounter is reported.',
      ),
  })
  .strict();

export const getCombatStateTool: ToolDefinition<typeof GetCombatStateInput> = {
  name: 'get_combat_state',
  description:
    'Read-only view of the combat encounter on a Foundry scene. Resolves the ' +
    'scene (defaults to the active scene, or uses sceneId), finds the Combat ' +
    'owned by that scene, and returns `combat.combatId`, `round`, `turn` ' +
    '(null before the encounter is begun), `started`, and an ordered ' +
    '`combatants` list — each entry carries combatantId, tokenId, actorId, ' +
    'name, initiative (null until rolled), isCurrentTurn, hidden, and ' +
    'defeated. The list is in Foundry tracker order (initiative descending). ' +
    'When the scene has no encounter, `combat` is null — that is a normal ' +
    'state, not an error. Use this to discover the combatantId values that ' +
    'remove_combatants needs, and to see whose turn it is. NOT for advancing ' +
    "turns or rolling initiative — those remain the human GM's job.",
  inputSchema: GetCombatStateInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(getCombatStateBody, args)) as GetCombatStateResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [jsonText({ sceneId: result.sceneId, combat: result.combat })];
  },
};
