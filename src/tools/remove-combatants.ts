import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  removeCombatantsBody,
  type RemoveCombatantsResult,
} from '../evaluators/remove-combatants.js';
import { jsonText, type ToolDefinition } from './types.js';

const RemoveCombatantsInput = z
  .object({
    combatantIds: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Combatant document ids to remove from the encounter. These are ' +
          'combatant ids, NOT token ids — call get_combat_state to discover ' +
          'them. Ids not in the encounter are returned in `notFound` rather ' +
          'than failing the batch.',
      ),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene id whose combat encounter to remove from; defaults to the ' +
          'world-active scene.',
      ),
  })
  .strict();

export const removeCombatantsTool: ToolDefinition<typeof RemoveCombatantsInput> = {
  name: 'remove_combatants',
  description:
    'Remove one or more combatants from a scene\'s combat encounter by ' +
    'combatant id. Resolves the scene (defaults to the active scene, or uses ' +
    'sceneId) and its Combat (no encounter → error). Each requested id is ' +
    'looked up first: hits are snapshotted (tokenId, name) and deleted in a ' +
    'single batch and returned in `removed`; ids not in the encounter go to ' +
    '`notFound`. Partial success: an unrecognized id does NOT abort the ' +
    'batch. Pre-filtering is required because Foundry throws on an unknown ' +
    'id passed to the delete. Pass combatant ids from get_combat_state, not ' +
    'token ids. To end the whole encounter use end_combat instead.',
  inputSchema: RemoveCombatantsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      combatantIds: input.combatantIds,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(removeCombatantsBody, args)) as RemoveCombatantsResult;
    if (!result.ok) {
      const code = result.error.code === 'REMOVE_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        sceneId: result.sceneId,
        combatId: result.combatId,
        removed: result.removed.length,
        notFound: result.notFound.length,
      },
      'remove_combatants',
    );
    return [
      jsonText({
        sceneId: result.sceneId,
        combatId: result.combatId,
        removed: result.removed,
        notFound: result.notFound,
      }),
    ];
  },
};
