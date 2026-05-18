import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import { activateSceneBody, type ActivateSceneResult } from '../evaluators/activate-scene.js';
import { jsonText, type ToolDefinition } from './types.js';

const ActivateSceneInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .describe(
        'Scene document id to activate. Use `list_scenes` to discover the ' +
          "id. Activating broadcasts to every connected client — all players' " +
          'canvases pull to this scene, and the scene gets the star icon in ' +
          'the scene navbar.',
      ),
  })
  .strict();

export const activateSceneTool: ToolDefinition<typeof ActivateSceneInput> = {
  name: 'activate_scene',
  description:
    'Set a scene as the world-active scene by calling `Scene#activate()`. ' +
    "Broadcasts: every connected client's canvas pulls to this scene; the " +
    'scene gets the star icon in the navbar; `game.scenes.active.id` changes ' +
    'to the supplied id. Idempotent — if the scene is already active, returns ' +
    'success with `noop: true` without re-broadcasting. Returns the activated ' +
    "scene's id, name, dimensions, padding, and grid info. NOT for previewing " +
    'a scene without disrupting players — use `view_scene` for the GM-local ' +
    'verb. NOT for editing scene contents (tokens, walls, lights) — those are ' +
    'separate tools.',
  inputSchema: ActivateSceneInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(activateSceneBody, {
      sceneId: input.sceneId,
    })) as ActivateSceneResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [
      jsonText({
        sceneId: result.sceneId,
        name: result.name,
        active: result.active,
        noop: result.noop,
        width: result.width,
        height: result.height,
        padding: result.padding,
        grid: result.grid,
      }),
    ];
  },
};
