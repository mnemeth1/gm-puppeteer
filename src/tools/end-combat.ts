import { z } from 'zod';
import { ToolError } from '../errors.js';
import { endCombatBody, type EndCombatResult } from '../evaluators/end-combat.js';
import { jsonText, type ToolDefinition } from './types.js';

const EndCombatInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe('Scene id whose combat encounter to end; defaults to the ' + 'world-active scene.'),
  })
  .strict();

export const endCombatTool: ToolDefinition<typeof EndCombatInput> = {
  name: 'end_combat',
  description:
    "End a scene's combat encounter — delete the Combat document, Foundry's " +
    '"End Combat". Resolves the scene (defaults to the active scene, or uses ' +
    'sceneId) and its Combat, snapshots combatId and combatantCount, then ' +
    'deletes the encounter and all its combatants. Returns combatId, ' +
    '`deleted`, and combatantCount. Idempotent: if the scene has no ' +
    'encounter, returns `ok` with `combatId: null` and `deleted: false` — ' +
    'ending a non-existent encounter is not an error. To drop individual ' +
    'combatants without ending the whole encounter use remove_combatants.',
  inputSchema: EndCombatInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(endCombatBody, args)) as EndCombatResult;
    if (!result.ok) {
      const code = result.error.code === 'DELETE_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      { sceneId: result.sceneId, combatId: result.combatId, deleted: result.deleted },
      'end_combat',
    );
    return [
      jsonText({
        sceneId: result.sceneId,
        combatId: result.combatId,
        deleted: result.deleted,
        combatantCount: result.combatantCount,
      }),
    ];
  },
};
