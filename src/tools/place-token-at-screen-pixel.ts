import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  placeTokenAtScreenPixelBody,
  type PlaceTokenAtScreenPixelResult,
} from '../evaluators/place-token-at-screen-pixel.js';
import { jsonText, type ToolDefinition } from './types.js';

const PlaceTokenAtScreenPixelInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, NOT a compendium UUID). Use ' +
          '`create_actor_from_compendium` to import a compendium actor first.',
      ),
    screenX: z
      .number()
      .describe(
        'Page-pixel X coordinate as it appears in a `foundry_screenshot` capture. The ' +
          'tool inverse-transforms via `canvas.stage.toLocal` before placement; on square ' +
          'grids the resulting canvas pixel is snapped to the containing cell. Get a ' +
          'screenshot first to identify the pixel visually; the transform sidecar in the ' +
          'screenshot response confirms the conversion offset.',
      ),
    screenY: z
      .number()
      .describe('Page-pixel Y coordinate. See `screenX` for conversion semantics.'),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene document id. Omit to use the currently-active scene. The screen pixel is ' +
          'always interpreted against the *currently rendered* canvas — passing sceneId ' +
          'only changes which scene gets the new token, not how the pixel is interpreted.',
      ),
    tokenName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Override the placed token's display name without renaming the underlying actor. " +
          'Omit to inherit from actor.prototypeToken.name.',
      ),
  })
  .strict();

export const placeTokenAtScreenPixelTool: ToolDefinition<typeof PlaceTokenAtScreenPixelInput> = {
  name: 'place_token_at_screen_pixel',
  description:
    'Create a token on a scene at a screenshot-pixel coordinate (the pixel as it appears ' +
    'in a `foundry_screenshot` capture). Inverse-transforms via `canvas.stage.toLocal`, ' +
    'then on square grids snaps to the containing cell via `grid.getOffset` → ' +
    '`grid.getTopLeftPoint`; on gridless scenes places at the exact canvas pixel. Hex ' +
    'grids (`grid.type` 2-5) are refused with NON_SQUARE_GRID. Designed for the workflow ' +
    'where an LLM reads a feature off a screenshot and wants to place a token there ' +
    'without manually computing the screen↔canvas↔grid conversions. For deterministic ' +
    'grid-coord placement (when you already know the cell), use `place_token_at_grid` ' +
    'instead. Returns tokenId, sceneId, screenCoords, canvasCoords (post-snap), ' +
    'rawCanvasCoords (pre-snap), gridCoords (when snapped, else null), tokenName, ' +
    'actorLink, outOfImageBounds, and snappedToGrid.',
  inputSchema: PlaceTokenAtScreenPixelInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      screenX: input.screenX,
      screenY: input.screenY,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      ...(input.tokenName !== undefined ? { tokenName: input.tokenName } : {}),
    };
    const result = (await page.evaluate(
      placeTokenAtScreenPixelBody,
      args,
    )) as PlaceTokenAtScreenPixelResult;
    if (!result.ok) {
      const code = result.error.code === 'CREATE_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    return [
      jsonText({
        tokenId: result.tokenId,
        sceneId: result.sceneId,
        screenCoords: result.screenCoords,
        canvasCoords: result.canvasCoords,
        rawCanvasCoords: result.rawCanvasCoords,
        gridCoords: result.gridCoords,
        tokenName: result.tokenName,
        actorLink: result.actorLink,
        outOfImageBounds: result.outOfImageBounds,
        snappedToGrid: result.snappedToGrid,
      }),
    ];
  },
};
