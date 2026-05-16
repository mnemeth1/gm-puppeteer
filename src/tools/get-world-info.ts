import { z } from 'zod';
import {
  getWorldInfoBody,
  type GetWorldInfoResult,
} from '../evaluators/get-world-info.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetWorldInfoInput = z.object({}).strict();

export const getWorldInfoTool: ToolDefinition<typeof GetWorldInfoInput> = {
  name: 'get_world_info',
  description:
    'Return top-level Foundry world metadata for orienting a fresh session: ' +
    'world (id, title, description), system (id, version, title), foundry ' +
    '(version, generation, build), active scene (id, name) or null when no ' +
    'scene is active, and the logged-in user (id, name, isGM, role). The ' +
    'description field is passed through verbatim and may contain HTML. ' +
    'Use this to confirm which world/system/version is loaded before deeper ' +
    'operations. For PF2e *rules text* about the running system (spells, ' +
    'feats, conditions, actions), use Archives of Nethys ' +
    '(https://2e.aonprd.com/) via web-fetch — this tool returns the system ' +
    'id and version, not the system rules.',
  inputSchema: GetWorldInfoInput,
  async handler(_input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(getWorldInfoBody)) as GetWorldInfoResult;
    return [jsonText(result)];
  },
};
