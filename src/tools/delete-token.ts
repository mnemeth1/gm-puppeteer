import { z } from 'zod';
import { ToolError, toolErrorFromEvaluator } from '../errors.js';
import { deleteTokenBody, type DeleteTokenResult } from '../evaluators/delete-token.js';
import {
  verifyTokensPresentBody,
  type VerifyTokensPresentResult,
} from '../evaluators/verify-tokens-present.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Puppeteer's CDP layer occasionally drops the response of a long-
 * running awaited operation inside `page.evaluate` with this error
 * even though the operation completed in the page context. Observed
 * twice with `scene.deleteEmbeddedDocuments` — each time the tokens
 * were in fact gone afterward, only the response was lost.
 */
function isPromiseCollectedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Promise was collected/i.test(msg);
}

const DeleteTokenInput = z
  .object({
    tokenIds: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Token document ids to remove from the scene. A `tokenId` is unique within ' +
          'a scene, not globally — use `get_scene_tokens` first to discover them. ' +
          'Ids not present on the resolved scene are returned in `notFound` rather ' +
          'than failing the batch.',
      ),
    sceneId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scene document id. Omit to use the currently-active scene. Useful for ' +
          'cleaning up tokens on a not-yet-active scene.',
      ),
  })
  .strict();

export const deleteTokenTool: ToolDefinition<typeof DeleteTokenInput> = {
  name: 'delete_token',
  description:
    'Delete one or more tokens from a Foundry scene by token id. Resolves the ' +
    'scene (defaults to the active scene, or uses the supplied sceneId), looks ' +
    'each requested id up in `scene.tokens.contents`, snapshots name and actorId, ' +
    'then issues a single `scene.deleteEmbeddedDocuments("Token", [...])` call ' +
    'for the ids that were found. Returns `deleted` (the snapshot per removed ' +
    'token) and `notFound` (ids that were not on the scene). Partial success: an ' +
    'unrecognized id does NOT abort the batch; an all-unrecognized batch returns ' +
    '`ok: true` with empty `deleted`. If Puppeteer drops the underlying response ' +
    'mid-flight ("Promise was collected"), the tool verifies state and, if all ' +
    'targeted tokens are absent, returns success with `recovered: true` and ' +
    'empty `tokenName`/`actorId` audit fields (the snapshot died with the failed ' +
    'evaluator). NOT for deleting the underlying world actor — that is a separate ' +
    'concern; this only removes the scene placement. NOT for hiding tokens ' +
    '(toggle `token.hidden` via foundry_eval) or for un-targeting (that is ' +
    'per-user client state). Use `get_scene_tokens` first to discover the token ' +
    'ids to pass here.',
  inputSchema: DeleteTokenInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      tokenIds: input.tokenIds,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    };

    let result: DeleteTokenResult;
    try {
      result = (await page.evaluate(deleteTokenBody, args)) as DeleteTokenResult;
    } catch (err) {
      if (!isPromiseCollectedError(err)) throw err;
      ctx.log.warn(
        { tokenIds: input.tokenIds, sceneId: input.sceneId ?? null },
        'delete_token: Puppeteer Promise-collected flake; verifying scene state',
      );
      const verify = (await page.evaluate(
        verifyTokensPresentBody,
        args,
      )) as VerifyTokensPresentResult;
      if (!verify.ok) {
        throw toolErrorFromEvaluator(verify.error, 'delete_token recovery');
      }
      if (verify.stillPresent.length > 0) {
        throw new ToolError(
          'EVAL_FAILED',
          `delete_token: Puppeteer dropped the response and ${verify.stillPresent.length} of ${input.tokenIds.length} ids are still on the scene. Retry the call.`,
          {
            sceneId: verify.sceneId,
            stillPresent: verify.stillPresent,
            absent: verify.absent,
          },
        );
      }
      ctx.log.info(
        { tokenIds: input.tokenIds, sceneId: verify.sceneId },
        'delete_token: flake recovery succeeded; all ids absent',
      );
      // Best-effort audit trail: the pre-delete snapshot lived in the
      // crashed evaluator, so tokenName/actorId are unavailable here.
      // `absent` from verify covers both "deleted by this call" and
      // "never on the scene" — we cannot distinguish; report all as
      // deleted with empty audit fields and surface `recovered: true`.
      return [
        jsonText({
          sceneId: verify.sceneId,
          deleted: verify.absent.map((tokenId) => ({
            tokenId,
            tokenName: '',
            actorId: null as string | null,
          })),
          notFound: [] as string[],
          recovered: true,
        }),
      ];
    }

    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [
      jsonText({
        sceneId: result.sceneId,
        deleted: result.deleted,
        notFound: result.notFound,
      }),
    ];
  },
};
