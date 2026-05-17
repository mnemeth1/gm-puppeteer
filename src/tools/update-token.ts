import { z } from 'zod';
import { ToolError } from '../errors.js';
import { updateTokenBody, type UpdateTokenResult } from '../evaluators/update-token.js';
import { jsonText, type ToolDefinition } from './types.js';

const DISPOSITION = z
  .union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1)])
  .describe(
    'TOKEN_DISPOSITIONS: -2 secret, -1 hostile, 0 neutral, 1 friendly. Drives the ' +
      'colored border around the token and how PF2e treats hostility for targeting.',
  );

const DISPLAY_MODE = z.union([
  z.literal(0),
  z.literal(10),
  z.literal(20),
  z.literal(30),
  z.literal(40),
  z.literal(50),
]);

const SightInput = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        'Toggle whether this token has vision. When false, the token sees only what the ' +
          'scene lights illuminate; when true, the token sees per its sight settings.',
      ),
    range: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Vision range in grid units. 0 means unlimited within scene illumination; ' +
          'positive numbers cap the bright/dim radius.',
      ),
  })
  .strict();

const UpdateTokenInput = z
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
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        'New nameplate label for the token. Renames only the token document — does NOT ' +
          'propagate to the linked actor (verified via probe on a linked PC).',
      ),
    disposition: DISPOSITION.optional(),
    hidden: z
      .boolean()
      .optional()
      .describe(
        'GM-only visibility. When true the token is hidden from players and shown ' +
          'half-opaque to the GM. Distinct from `sight.enabled` (vision capability).',
      ),
    displayName: DISPLAY_MODE.optional().describe(
      'When the nameplate is visible. TOKEN_DISPLAY_MODES enum: 0 NONE, 10 CONTROL, ' +
        '20 OWNER_HOVER, 30 HOVER, 40 OWNER, 50 ALWAYS. Foundry silently clamps non-enum ' +
        'numbers to 0; this schema rejects them up-front.',
    ),
    displayBars: DISPLAY_MODE.optional().describe(
      'When resource bars are visible. Same TOKEN_DISPLAY_MODES enum as `displayName`.',
    ),
    sight: SightInput.optional().describe(
      'Narrow vision update: enabled toggle and range only. v1 deliberately omits ' +
        '`visionMode` — Foundry/PF2e silently rejects every value except `basic` in v14 ' +
        '+ PF2e 8.1.2, and vision modes are managed via `detectionModes` instead. ' +
        'Cosmetic sight fields (color, brightness, saturation, contrast, attenuation, ' +
        'angle) are also out of v1.',
    ),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.disposition !== undefined ||
      v.hidden !== undefined ||
      v.displayName !== undefined ||
      v.displayBars !== undefined ||
      (v.sight !== undefined && (v.sight.enabled !== undefined || v.sight.range !== undefined)),
    {
      message:
        'Provide at least one updatable field: name, disposition, hidden, displayName, ' +
        'displayBars, or a non-empty `sight` object.',
      path: ['name'],
    },
  );

export const updateTokenTool: ToolDefinition<typeof UpdateTokenInput> = {
  name: 'update_token',
  description:
    'Update non-positional properties of an existing token on a scene: nameplate ' +
    '`name`, `disposition` (-2 secret / -1 hostile / 0 neutral / 1 friendly), `hidden` ' +
    'flag, `displayName` / `displayBars` enum modes, and a narrow `sight` projection ' +
    '({enabled, range}). At least one updatable field must be supplied; the schema ' +
    'rejects an empty update. Returns `{tokenId, sceneId, before, after, changed}` ' +
    'where `before` and `after` are partial objects keyed only by the fields the caller ' +
    'requested, and `changed` is a flat dot-path list of those field names (e.g. ' +
    '`["disposition","sight.enabled"]`). IMPORTANT: PF2e (and Foundry) may silently ' +
    'override `disposition` and `sight.range` writes after the update — e.g., writing ' +
    '`disposition: 0` to an NPC token may snap back to `-1` because the PF2e system ' +
    're-derives token disposition from the linked actor. Always read `after` to see what ' +
    'actually persisted; do NOT assume a successful write means the requested value ' +
    'stuck. `name`, `hidden`, `displayName`, `displayBars`, and `sight.enabled` write ' +
    'reliably. NOT for moving tokens ' +
    '(use `move_token`). NOT for creating tokens (use `place_token_at_grid` or ' +
    '`place_token_at_screen_pixel`). NOT for deleting tokens (use `delete_token`). NOT ' +
    'for actor stat-block changes — those live on the actor document and are owned by ' +
    '`pf2e_get_actor_state` and other actor tools.',
  inputSchema: UpdateTokenInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      tokenId: input.tokenId,
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.disposition !== undefined ? { disposition: input.disposition } : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.displayBars !== undefined ? { displayBars: input.displayBars } : {}),
      ...(input.sight !== undefined ? { sight: input.sight } : {}),
    };
    const result = (await page.evaluate(updateTokenBody, args)) as UpdateTokenResult;
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
        changed: result.changed,
      }),
    ];
  },
};
