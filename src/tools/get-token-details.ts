import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  getTokenDetailsBody,
  type GetTokenDetailsResult,
} from '../evaluators/get-token-details.js';
import { jsonText, type ToolDefinition } from './types.js';

const GetTokenDetailsInput = z
  .object({
    tokenId: z
      .string()
      .min(1)
      .describe(
        'Id of the token document to inspect. Token ids are scene-scoped — obtain one from ' +
          'get_scene_tokens.',
      ),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene id the token lives on. Defaults to the world-active scene; pass explicitly when ' +
          'inspecting a token on a non-active scene.',
      ),
    includeRawDocument: z
      .boolean()
      .optional()
      .describe(
        'Include the full Foundry TokenDocument `toObject()` payload under `rawDocument`. Off by ' +
          'default; opt in for diagnostic work or to read fields the typed projection omits ' +
          '(attachments, auras, delta, depth, level, ActorDelta override doc).',
      ),
  })
  .strict();

export const getTokenDetailsTool: ToolDefinition<typeof GetTokenDetailsInput> = {
  name: 'get_token_details',
  description:
    'Read-only detail view of a single token on a scene. Returns identity, scene-bound position ' +
    '(x/y in canvas pixels), size, disposition, visibility (displayName/displayBars modes, hidden, ' +
    'alpha), appearance (texture src, scaleX/Y including mirror sign, anchor, fit, tint, ' +
    'alphaThreshold; v14 dynamic ring config; turn marker), bar attribute pointers, vision ' +
    '(sight: range/angle/visionMode/color/etc.), light emission (full v14 light config including ' +
    'animation and darkness range), and detectionModes (special senses). Reads the LIVE token ' +
    'document, not the persisted form — PF2e re-derives disposition and other fields at runtime, ' +
    'so the projection reflects what is actually rendered. Defaults to the active scene; pass ' +
    'sceneId for a different scene. Companion to get_scene_tokens: pass any token id from the ' +
    'list into this tool for full detail. NOT a stat-block view — for actor-side combat state ' +
    '(HP, AC, conditions, saves, initiative) call get_actor_state; for the full NPC/creature ' +
    'stat block (skills, attacks, spells, defenses) call get_creature_details. NOT for ' +
    'enumerating tokens — use get_scene_tokens when you need the list. NOT for actors not yet ' +
    'placed on a scene — token documents only exist scene-bound; use list_world_actors for the ' +
    'actor directory and place_token_at_grid / place_token_at_screen_pixel to create one. Pass ' +
    '`includeRawDocument: true` for the full Foundry TokenDocument payload including the ' +
    'ActorDelta override doc and other fields omitted from the typed projection.',
  inputSchema: GetTokenDetailsInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      tokenId: input.tokenId,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      includeRawDocument: input.includeRawDocument ?? false,
    };
    const result = (await page.evaluate(getTokenDetailsBody, args)) as GetTokenDetailsResult;
    if (!result.ok) {
      throw new ToolError('INVALID_INPUT', result.error.message, result.error.details);
    }
    return [jsonText(result)];
  },
};
