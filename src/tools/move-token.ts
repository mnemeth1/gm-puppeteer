import { z } from 'zod';
import { ToolError } from '../errors.js';
import { moveTokenBody, type MoveTokenResult } from '../evaluators/move-token.js';
import { jsonText, type ToolDefinition } from './types.js';

const IJ = z
  .object({
    i: z.number().int(),
    j: z.number().int(),
  })
  .strict();

const XY = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();

const MoveTokenInput = z
  .object({
    tokenId: z
      .string()
      .min(1)
      .describe(
        'Token document id (unique within a scene, not globally). Use `get_scene_tokens` ' +
          'to discover token ids.',
      ),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe('Scene document id. Omit to use the currently-active scene.'),
    animate: z
      .boolean()
      .optional()
      .describe(
        'Animate the visual move? Defaults to false. Position semantics are identical ' +
          'either way (this is a teleport via token.update, not a movement-pipeline call); ' +
          '`animate: true` only controls whether Foundry tweens the sprite. Tens-of-seconds ' +
          'slowness has been observed for animated updates under contention in headless ' +
          'Chromium, which is why the default is false.',
      ),
    ij: IJ.optional().describe(
      'Grid coordinates {i: row, j: column}. Use for square-grid scenes when you know ' +
        'the target cell. Conflicts with `xy`; pass exactly one.',
    ),
    xy: XY.optional().describe(
      'Canvas-pixel coordinates {x, y}. Use for gridless scenes or for sub-cell precision. ' +
        'Conflicts with `ij`; pass exactly one.',
    ),
  })
  .strict()
  .refine((v) => (v.ij !== undefined) !== (v.xy !== undefined), {
    message: 'Pass exactly one of `ij` or `xy` (not both, not neither).',
    path: ['ij'],
  });

export const moveTokenTool: ToolDefinition<typeof MoveTokenInput> = {
  name: 'move_token',
  description:
    'Move an existing token to a new position on a scene. Accepts either grid coordinates ' +
    '`ij: {i, j}` (square grids only) or canvas-pixel coordinates `xy: {x, y}` (any grid ' +
    'type including gridless); exactly one must be provided. The move is a ' +
    '`token.update({x, y})` write — a teleport, not a simulated walk: no pathfinding, no ' +
    'wall collision check, no movement-triggered effects. `animate: true` only controls ' +
    'whether Foundry tweens the sprite visually (default false). Returns tokenId, sceneId, ' +
    'before/after positions, targetCanvasCoords, gridCoords (when ij was used, else null), ' +
    'and animated flag. NOT for creating tokens (use `place_token_at_grid` or ' +
    '`place_token_at_screen_pixel`). NOT for deleting tokens (use `delete_token`).',
  inputSchema: MoveTokenInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      tokenId: input.tokenId,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      ...(input.animate !== undefined ? { animate: input.animate } : {}),
      ...(input.ij !== undefined ? { ij: input.ij } : {}),
      ...(input.xy !== undefined ? { xy: input.xy } : {}),
    };
    const result = (await page.evaluate(moveTokenBody, args)) as MoveTokenResult;
    if (!result.ok) {
      const code = result.error.code === 'UPDATE_FAILED' ? 'EVAL_FAILED' : 'INVALID_INPUT';
      throw new ToolError(code, result.error.message, result.error.details);
    }
    return [
      jsonText({
        tokenId: result.tokenId,
        sceneId: result.sceneId,
        before: result.before,
        after: result.after,
        targetCanvasCoords: result.targetCanvasCoords,
        gridCoords: result.gridCoords,
        animated: result.animated,
      }),
    ];
  },
};
