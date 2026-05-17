import { z } from 'zod';
import { getSceneTokensBody, type GetSceneTokensResult } from '../evaluators/get-scene-tokens.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetSceneTokensInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe('Scene id to enumerate; defaults to the world-active scene.'),
  })
  .strict();

export const getSceneTokensTool: ToolDefinition<typeof GetSceneTokensInput> = {
  name: 'get_scene_tokens',
  description:
    'Read-only enumeration of every token on a Foundry scene. One row per token ' +
    'with id, name, actorId (null for unlinked), actorLink, x, y, width, height, ' +
    'disposition, and hidden — sorted by name. Defaults to the active scene; pass ' +
    'sceneId to enumerate a different scene. Use this to discover the tokenId you ' +
    'need for downstream token operations, or to inspect what is on a scene before ' +
    'taking action. x/y are the top-left of the token bounding box in canvas ' +
    'pixels; width/height are in grid squares (1 for Medium, 2 for Large). ' +
    'disposition is the Foundry TOKEN_DISPOSITIONS enum (-2 secret, -1 hostile, ' +
    '0 neutral, 1 friendly). NOT a stat-block view — call pf2e_get_actor_state or ' +
    'pf2e_get_creature_details for combat-relevant detail. NOT for actors that are ' +
    'not placed on the scene — use list_world_actors for the world directory.',
  inputSchema: GetSceneTokensInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };
    const result = (await page.evaluate(getSceneTokensBody, args)) as GetSceneTokensResult;
    return [jsonText(result)];
  },
};
