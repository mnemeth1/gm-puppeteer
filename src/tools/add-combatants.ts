import { z } from 'zod';
import { ToolError } from '../errors.js';
import { addCombatantsBody, type AddCombatantsResult } from '../evaluators/add-combatants.js';
import { jsonText, type ToolDefinition } from './types.js';

const AddCombatantsInput = z
  .object({
    tokenIds: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Token document ids on the scene to add to the combat encounter as ' +
          'combatants. A `tokenId` is unique within a scene — use ' +
          '`get_scene_tokens` to discover them. Ids not on the resolved scene ' +
          'are returned in `notFound`; tokens already in the encounter are ' +
          'returned in `alreadyPresent` — neither aborts the batch.',
      ),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene id whose combat encounter to add to; defaults to the ' +
          'world-active scene.',
      ),
  })
  .strict();

export const addCombatantsTool: ToolDefinition<typeof AddCombatantsInput> = {
  name: 'add_combatants',
  description:
    'Add one or more scene tokens to the combat encounter as combatants. ' +
    'Resolves the scene (defaults to the active scene, or uses sceneId) and ' +
    'its Combat — the scene must already have an encounter, so call ' +
    'start_combat first (no encounter → error). Each requested tokenId is ' +
    'partitioned before any change: ids not on the scene go to `notFound`, ' +
    'tokens already in the encounter go to `alreadyPresent` (with their ' +
    'existing combatantId), the rest are created in a single batch and ' +
    'returned in `added` with their new combatantId. Partial success: ' +
    'unrecognized or already-present ids do NOT abort the batch. ' +
    'Pre-filtering is required because Foundry does not dedupe — re-adding ' +
    'a token would otherwise create a duplicate combatant. This does NOT ' +
    'roll initiative (the GM does that); new combatants start with no ' +
    'initiative. Use get_scene_tokens to discover token ids.',
  inputSchema: AddCombatantsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      tokenIds: input.tokenIds,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(addCombatantsBody, args)) as AddCombatantsResult;
    if (!result.ok) {
      const code = result.error.code === 'ADD_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    ctx.log.info(
      {
        sceneId: result.sceneId,
        combatId: result.combatId,
        added: result.added.length,
        alreadyPresent: result.alreadyPresent.length,
        notFound: result.notFound.length,
      },
      'add_combatants',
    );
    return [
      jsonText({
        sceneId: result.sceneId,
        combatId: result.combatId,
        added: result.added,
        alreadyPresent: result.alreadyPresent,
        notFound: result.notFound,
      }),
    ];
  },
};
