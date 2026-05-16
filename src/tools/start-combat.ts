import { z } from 'zod';
import { ToolError } from '../errors.js';
import { startCombatBody, type StartCombatResult } from '../evaluators/start-combat.js';
import { jsonText, type ToolDefinition } from './types.js';

const StartCombatInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene id to create the combat encounter on; defaults to the ' +
          'world-active scene. The encounter is owned by this scene.',
      ),
  })
  .strict();

export const startCombatTool: ToolDefinition<typeof StartCombatInput> = {
  name: 'start_combat',
  description:
    'Create the combat encounter for a Foundry scene — the round-0 container ' +
    'that combatants are added to. Resolves the scene (defaults to the active ' +
    'scene, or uses sceneId) and, if it has no encounter yet, creates one via ' +
    'the Combat document class and sets it world-active. Returns combatId, ' +
    'round (0), started (false), active, combatantCount, and `created`. ' +
    'Idempotent: if the scene already owns an encounter it is returned ' +
    'untouched with `created: false` — start_combat never produces a second ' +
    'encounter on the same scene. This does NOT begin the encounter or roll ' +
    'initiative: add combatants with add_combatants, let the GM roll ' +
    'initiative, then call begin_combat to advance to round 1.',
  inputSchema: StartCombatInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(startCombatBody, args)) as StartCombatResult;
    if (!result.ok) {
      const code = result.error.code === 'CREATE_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      { sceneId: result.sceneId, combatId: result.combatId, created: result.created },
      'start_combat',
    );
    return [
      jsonText({
        sceneId: result.sceneId,
        combatId: result.combatId,
        round: result.round,
        started: result.started,
        active: result.active,
        created: result.created,
        combatantCount: result.combatantCount,
      }),
    ];
  },
};
