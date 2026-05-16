import { z } from 'zod';
import { ToolError } from '../errors.js';
import { viewSceneBody, type ViewSceneResult } from '../evaluators/view-scene.js';
import { jsonText, type ToolDefinition } from './types.js';

const ViewSceneInput = z
  .object({
    sceneId: z
      .string()
      .min(1)
      .describe(
        'Scene document id to view. Use `list_scenes` to discover the id. ' +
          'This is GM-local: the headless GM client repoints its canvas at ' +
          'this scene without changing what other connected clients (players) ' +
          'are looking at.',
      ),
  })
  .strict();

export const viewSceneTool: ToolDefinition<typeof ViewSceneInput> = {
  name: 'view_scene',
  description:
    "Repoint the headless GM's canvas at a different scene so a follow-up " +
    '`foundry_screenshot` captures that scene. Calls `Scene#view()` on the ' +
    'resolved scene and waits up to 2s for the canvas redraw to commit before ' +
    'returning. Returns the viewed scene id, name, active flag, dimensions, ' +
    'padding, and grid info — the same projection shape as `get_current_scene` ' +
    'so a caller can chain a screenshot without a second metadata fetch. ' +
    'NOT a broadcast: does NOT change `game.scenes.active`, does NOT affect ' +
    "what players see. Use `activate_scene` when you want to change the " +
    "world-active scene for everyone. NOT a scene-detail view — use " +
    '`get_current_scene` after viewing if you also need per-collection counts.',
  inputSchema: ViewSceneInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(viewSceneBody, {
      sceneId: input.sceneId,
    })) as ViewSceneResult;
    if (!result.ok) {
      const code = result.error.code === 'SCENE_NOT_FOUND' ? 'INVALID_INPUT' : 'EVAL_FAILED';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    return [
      jsonText({
        sceneId: result.sceneId,
        name: result.name,
        active: result.active,
        width: result.width,
        height: result.height,
        padding: result.padding,
        grid: result.grid,
      }),
    ];
  },
};
