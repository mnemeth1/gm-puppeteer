import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  placeTokenAtGridBody,
  type PlaceTokenAtGridResult,
} from '../evaluators/place-token-at-grid.js';
import { jsonText, type ToolDefinition } from './types.js';

const PlaceTokenAtGridInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (the value of `actor.id`, NOT a compendium UUID). Use ' +
          '`create_actor_from_compendium` to import a compendium actor first.',
      ),
    i: z
      .number()
      .int()
      .describe(
        'Grid row offset. Increases southward (downward). Maps to canvas y. ' +
          'Origin (i:0, j:0) is the top-left of the padded canvas, NOT the image top-left — ' +
          'small values land in the scene padding region; see outOfImageBounds in the response.',
      ),
    j: z
      .number()
      .int()
      .describe(
        'Grid column offset. Increases eastward (rightward). Maps to canvas x. ' +
          'See `i` for origin notes.',
      ),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene document id. Omit to use the currently-active scene. Useful for staging ' +
          'tokens on a not-yet-active scene.',
      ),
    tokenName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Override the placed token's display name without renaming the underlying actor. " +
          'Lets one actor stat block back multiple labeled tokens (e.g. "Goblin Warrior 1" / ' +
          '"Goblin Warrior 2"). Omit to inherit from actor.prototypeToken.name.',
      ),
  })
  .strict();

export const placeTokenAtGridTool: ToolDefinition<typeof PlaceTokenAtGridInput> = {
  name: 'place_token_at_grid',
  description:
    'Create a token on a scene from an existing world actor at grid coordinates {i, j}. ' +
    'Resolves the actor by id, defaults to the active scene (or uses the supplied sceneId), ' +
    'converts {i, j} to canvas coords via the scene grid helper, builds the token document via ' +
    'actor.getTokenDocument(), and creates it via scene.createEmbeddedDocuments("Token", [...]). ' +
    'Supports only square grids (grid.type === 1) — hex and gridless scenes are refused. ' +
    'Returns tokenId, sceneId, gridCoords, canvasCoords, tokenName, actorLink, and a ' +
    'non-fatal outOfImageBounds flag set when the placed bounding box extends past the scene ' +
    'image rect. Foundry allows stacking tokens on an already-occupied square; this tool does ' +
    'not pre-check occupancy. Does NOT select, target, light, or otherwise modify the new token.',
  inputSchema: PlaceTokenAtGridInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      i: input.i,
      j: input.j,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      ...(input.tokenName !== undefined ? { tokenName: input.tokenName } : {}),
    };
    const result = (await page.evaluate(placeTokenAtGridBody, args)) as PlaceTokenAtGridResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [
      jsonText({
        tokenId: result.tokenId,
        sceneId: result.sceneId,
        gridCoords: result.gridCoords,
        canvasCoords: result.canvasCoords,
        tokenName: result.tokenName,
        actorLink: result.actorLink,
        outOfImageBounds: result.outOfImageBounds,
      }),
    ];
  },
};
