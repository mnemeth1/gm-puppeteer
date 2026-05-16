import { z } from 'zod';
import { ToolError } from '../errors.js';
import { beginCombatBody, type BeginCombatResult } from '../evaluators/begin-combat.js';
import { jsonText, type ToolDefinition } from './types.js';

const BeginCombatInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene id whose combat encounter to begin; defaults to the ' +
          'world-active scene.',
      ),
  })
  .strict();

export const beginCombatTool: ToolDefinition<typeof BeginCombatInput> = {
  name: 'begin_combat',
  description:
    'Begin a scene\'s combat encounter — advance it from the round-0 staging ' +
    'state to round 1, turn 0. Resolves the scene (defaults to the active ' +
    'scene, or uses sceneId) and its Combat (no encounter → error; run ' +
    'start_combat first). Returns combatId, round, turn, started, and ' +
    '`alreadyStarted`. Idempotent: if the encounter is already underway it ' +
    'is returned untouched with `alreadyStarted: true`. This does NOT roll ' +
    'initiative — that is the human GM\'s job and should be done before ' +
    'begin_combat so the turn order is meaningful. It also does not advance ' +
    'turns or rounds; that stays manual.',
  inputSchema: BeginCombatInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(beginCombatBody, args)) as BeginCombatResult;
    if (!result.ok) {
      const code = result.error.code === 'BEGIN_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        sceneId: result.sceneId,
        combatId: result.combatId,
        round: result.round,
        alreadyStarted: result.alreadyStarted,
      },
      'begin_combat',
    );
    return [
      jsonText({
        sceneId: result.sceneId,
        combatId: result.combatId,
        round: result.round,
        turn: result.turn,
        started: result.started,
        alreadyStarted: result.alreadyStarted,
      }),
    ];
  },
};
