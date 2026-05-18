import { z } from 'zod';
import { ToolError } from '../errors.js';
import { rollNpcsBody, type RollNpcsResult } from '../evaluators/roll-npcs.js';
import { jsonText, type ToolDefinition } from './types.js';

const RollNpcsInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Scene id whose combat encounter to roll NPC initiative for; " +
          'defaults to the world-active scene.',
      ),
  })
  .strict();

export const rollNpcsTool: ToolDefinition<typeof RollNpcsInput> = {
  name: 'roll_npcs',
  description:
    "Roll initiative for every NPC combatant in a scene's combat encounter — " +
    'the combat tracker\'s "Roll NPCs" button (core `Combat#rollNPC`, ' +
    'system-agnostic). Resolves the scene (defaults to the active scene, or ' +
    'uses sceneId) and its Combat (no encounter → error; run start_combat ' +
    'first). Rolls only combatants flagged NPC that have no initiative score ' +
    "yet — the player's PC is never rolled (PC initiative stays the human " +
    "GM's), and NPCs that already rolled are left untouched. Works before or " +
    'after begin_combat: it only fills in missing initiative, so it is safe ' +
    'mid-combat for late-joining NPCs. Returns the NPCs `rolled` this call ' +
    '(with initiative), the NPCs `alreadyRolled`, and `pcCount`.',
  inputSchema: RollNpcsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(rollNpcsBody, args)) as RollNpcsResult;
    if (!result.ok) {
      const code = result.error.code === 'ROLL_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        sceneId: result.sceneId,
        combatId: result.combatId,
        rolled: result.rolled.length,
        alreadyRolled: result.alreadyRolled.length,
        pcCount: result.pcCount,
      },
      'roll_npcs',
    );
    return [
      jsonText({
        sceneId: result.sceneId,
        combatId: result.combatId,
        round: result.round,
        started: result.started,
        rolled: result.rolled,
        alreadyRolled: result.alreadyRolled,
        pcCount: result.pcCount,
      }),
    ];
  },
};
