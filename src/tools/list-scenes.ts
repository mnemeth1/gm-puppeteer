import { z } from 'zod';
import { listScenesBody, type ListScenesResult } from '../evaluators/list-scenes.js';
import { jsonText, type ToolDefinition } from './types.js';

const ListScenesInput = z.object({}).strict();

export const listScenesTool: ToolDefinition<typeof ListScenesInput> = {
  name: 'list_scenes',
  description:
    "Read-only enumeration of every scene in the current Foundry world's scene " +
    'directory. One row per scene with id, name, active (the world-active flag), ' +
    'and folderId, sorted by name. Use this to discover the sceneId you need to ' +
    'pass into get_scene_tokens or any other scene-targeted tool. The world has ' +
    'at most one active scene; the rest report active: false. NOT a full scene- ' +
    'detail view — use get_current_scene for grid, dimensions, padding, and ' +
    'per-collection counts on the active scene. NOT a token / wall / light ' +
    'enumeration — use get_scene_tokens (or get_current_scene counts) for those. ' +
    'NOT for compendium scenes — those live in scene-type compendium packs.',
  inputSchema: ListScenesInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(listScenesBody)) as ListScenesResult;
    return [jsonText({ scenes: result.scenes })];
  },
};
