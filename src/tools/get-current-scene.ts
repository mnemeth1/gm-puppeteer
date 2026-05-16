import { z } from 'zod';
import {
  getCurrentSceneBody,
  type GetCurrentSceneResult,
} from '../evaluators/get-current-scene.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetCurrentSceneInput = z.object({}).strict();

export const getCurrentSceneTool: ToolDefinition<typeof GetCurrentSceneInput> = {
  name: 'get_current_scene',
  description:
    "Return metadata for the world's currently-active Scene: id, name, dimensions, padding, " +
    'grid info (type, size, distance, units), background/foreground image paths, and counts of ' +
    'walls, tokens, lights, sounds, drawings, templates, notes, and regions. Returns ' +
    '{scene: null, reason} when no scene is flagged active.',
  inputSchema: GetCurrentSceneInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(getCurrentSceneBody)) as GetCurrentSceneResult;
    return [jsonText(result)];
  },
};
