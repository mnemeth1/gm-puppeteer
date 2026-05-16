/**
 * page.evaluate body for `update_token`. Modifies non-positional
 * properties of an existing token on a scene.
 *
 * v1 surface (locked down by scripts/probe-update-token.mjs against
 * Foundry v14.361 + PF2e 8.1.2):
 *   - `name`               — token nameplate, does NOT propagate to a
 *                            linked actor.
 *   - `disposition`        — TOKEN_DISPOSITIONS enum (-2/-1/0/1).
 *                            Foundry accepts the write, but PF2e may
 *                            re-derive token disposition from the
 *                            linked actor on the next tick: observed
 *                            on the Redcap NPC, writing
 *                            `disposition: 0` was reverted to `-1`
 *                            (the actor's intrinsic hostility). The
 *                            tool faithfully reports the persisted
 *                            value in `after`; callers must NOT assume
 *                            the requested value stuck. Writes that
 *                            move toward the actor's intrinsic value
 *                            (e.g. -1 → -2 on an already-hostile
 *                            NPC) do persist.
 *   - `hidden`             — GM-only visibility flag.
 *   - `displayName`        — TOKEN_DISPLAY_MODES enum (0/10/20/30/40/50).
 *                            Out-of-enum values are silently CLAMPED to
 *                            0 by Foundry — the tool's zod schema
 *                            rejects them up-front instead.
 *   - `displayBars`        — same enum as `displayName`.
 *   - `sight.enabled`      — vision toggle. Persists reliably.
 *   - `sight.range`        — vision range in grid units. Foundry
 *                            accepts the write, but PF2e may override
 *                            it: observed writing `range: 30` to the
 *                            Redcap and getting back `range: 0`,
 *                            presumably because PF2e re-derives token
 *                            sight from `actor.system.perception` /
 *                            `senses`. As with `disposition`, the
 *                            tool reports the persisted value in
 *                            `after`.
 *
 * Deliberately NOT in v1:
 *   - `sight.visionMode`   — Foundry/PF2e silently rejects every value
 *                            except `'basic'` in this version pairing
 *                            (`darkvision`, `lowLightVision`, garbage
 *                            strings all revert to `'basic'`). Vision
 *                            modes are managed through `detectionModes`
 *                            and the system, not the token's
 *                            `sight.visionMode`.
 *   - Other `sight` fields (color, brightness, saturation, contrast,
 *     attenuation, angle): cosmetic; defer to a future tool if a
 *     workflow needs them.
 *   - `light.*`            — light emission; rare GM operation, defer.
 *
 * Behavior notes:
 *   - Nested-object form `{ sight: { enabled: true } }` merge-patches
 *     untouched sight fields (probe Q2). The dot-path form
 *     `{ 'sight.enabled': true }` also works; nested form is used here
 *     for cleaner typing.
 *   - The token reference is re-fetched after `update` to read `after`
 *     values. Stale-ref behavior was NOT observed for non-positional
 *     fields (probe Q4), but the re-fetch is kept for parity with
 *     `move_token` and costs nothing.
 *   - Empty changes payload — `token.update({})` is a silent no-op
 *     in v14, but the tool surface rejects empty input at the schema
 *     layer (and the evaluator surfaces NO_FIELDS_SUPPLIED defensively).
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope interfaces are erased at runtime (TypeScript) and so
 * are safe; module-scope helpers, imports, and outer closures are NOT
 * available at runtime.
 */

export interface UpdateTokenSightInput {
  enabled?: boolean | undefined;
  range?: number | undefined;
}

export interface UpdateTokenInput {
  tokenId: string;
  sceneId?: string | undefined;
  name?: string | undefined;
  disposition?: number | undefined;
  hidden?: boolean | undefined;
  displayName?: number | undefined;
  displayBars?: number | undefined;
  sight?: UpdateTokenSightInput | undefined;
}

export interface UpdateTokenFields {
  name?: string;
  disposition?: number;
  hidden?: boolean;
  displayName?: number;
  displayBars?: number;
  sight?: { enabled?: boolean; range?: number };
}

export interface UpdateTokenOk {
  ok: true;
  tokenId: string;
  sceneId: string;
  before: UpdateTokenFields;
  after: UpdateTokenFields;
  changed: string[];
}

export type UpdateTokenErrCode =
  | 'TOKEN_NOT_FOUND'
  | 'SCENE_NOT_FOUND'
  | 'NO_ACTIVE_SCENE'
  | 'NO_FIELDS_SUPPLIED'
  | 'UPDATE_FAILED';

export interface UpdateTokenErr {
  ok: false;
  error: {
    code: UpdateTokenErrCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateTokenResult = UpdateTokenOk | UpdateTokenErr;

interface FoundrySightLike {
  enabled?: unknown;
  range?: unknown;
}

interface FoundryTokenLike {
  id?: string;
  name?: unknown;
  disposition?: unknown;
  hidden?: unknown;
  displayName?: unknown;
  displayBars?: unknown;
  sight?: FoundrySightLike;
  update(
    changes: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<FoundryTokenLike | undefined>;
}

interface FoundrySceneLike {
  id?: string;
  tokens?: {
    get(id: string): FoundryTokenLike | undefined;
  };
}

interface FoundryGameLike {
  scenes?: {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  };
}

export async function updateTokenBody(input: UpdateTokenInput): Promise<UpdateTokenResult> {
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;

  let scene: FoundrySceneLike | null | undefined;
  if (input.sceneId !== undefined) {
    scene = game?.scenes?.get(input.sceneId);
    if (!scene) {
      return {
        ok: false,
        error: {
          code: 'SCENE_NOT_FOUND',
          message: `No scene with id "${input.sceneId}".`,
          details: { sceneId: input.sceneId },
        },
      };
    }
  } else {
    scene = game?.scenes?.active ?? null;
    if (!scene) {
      return {
        ok: false,
        error: {
          code: 'NO_ACTIVE_SCENE',
          message:
            'No active scene, and no sceneId provided. Activate a scene or pass sceneId.',
        },
      };
    }
  }

  const token = scene.tokens?.get(input.tokenId);
  if (!token) {
    return {
      ok: false,
      error: {
        code: 'TOKEN_NOT_FOUND',
        message: `No token with id "${input.tokenId}" on scene "${scene.id ?? '?'}".`,
        details: { tokenId: input.tokenId, sceneId: scene.id ?? null },
      },
    };
  }

  const changes: Record<string, unknown> = {};
  const before: UpdateTokenFields = {};
  const changed: string[] = [];

  if (input.name !== undefined) {
    changes.name = input.name;
    before.name = typeof token.name === 'string' ? token.name : '';
    changed.push('name');
  }
  if (input.disposition !== undefined) {
    changes.disposition = input.disposition;
    before.disposition = typeof token.disposition === 'number' ? token.disposition : 0;
    changed.push('disposition');
  }
  if (input.hidden !== undefined) {
    changes.hidden = input.hidden;
    before.hidden = token.hidden === true;
    changed.push('hidden');
  }
  if (input.displayName !== undefined) {
    changes.displayName = input.displayName;
    before.displayName = typeof token.displayName === 'number' ? token.displayName : 0;
    changed.push('displayName');
  }
  if (input.displayBars !== undefined) {
    changes.displayBars = input.displayBars;
    before.displayBars = typeof token.displayBars === 'number' ? token.displayBars : 0;
    changed.push('displayBars');
  }
  if (input.sight !== undefined) {
    const sightChanges: Record<string, unknown> = {};
    const sightBefore: { enabled?: boolean; range?: number } = {};
    if (input.sight.enabled !== undefined) {
      sightChanges.enabled = input.sight.enabled;
      sightBefore.enabled = token.sight?.enabled === true;
      changed.push('sight.enabled');
    }
    if (input.sight.range !== undefined) {
      sightChanges.range = input.sight.range;
      sightBefore.range = typeof token.sight?.range === 'number' ? token.sight.range : 0;
      changed.push('sight.range');
    }
    if (Object.keys(sightChanges).length > 0) {
      changes.sight = sightChanges;
      before.sight = sightBefore;
    }
  }

  if (changed.length === 0) {
    return {
      ok: false,
      error: {
        code: 'NO_FIELDS_SUPPLIED',
        message: 'update_token requires at least one updatable field; received none.',
        details: { tokenId: input.tokenId, sceneId: scene.id ?? null },
      },
    };
  }

  try {
    await token.update(changes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'UPDATE_FAILED',
        message: `token.update failed: ${message}`,
        details: { tokenId: input.tokenId, changed },
      },
    };
  }

  // Re-fetch the token after the update. Stale-ref behavior was NOT
  // observed for non-positional fields (probe Q4) but the pattern is
  // kept for parity with move_token and is free of cost.
  const refreshed = scene.tokens?.get(input.tokenId) ?? token;

  const after: UpdateTokenFields = {};
  if (input.name !== undefined) {
    after.name = typeof refreshed.name === 'string' ? refreshed.name : '';
  }
  if (input.disposition !== undefined) {
    after.disposition = typeof refreshed.disposition === 'number' ? refreshed.disposition : 0;
  }
  if (input.hidden !== undefined) {
    after.hidden = refreshed.hidden === true;
  }
  if (input.displayName !== undefined) {
    after.displayName = typeof refreshed.displayName === 'number' ? refreshed.displayName : 0;
  }
  if (input.displayBars !== undefined) {
    after.displayBars = typeof refreshed.displayBars === 'number' ? refreshed.displayBars : 0;
  }
  if (before.sight !== undefined) {
    const sightAfter: { enabled?: boolean; range?: number } = {};
    if (input.sight?.enabled !== undefined) {
      sightAfter.enabled = refreshed.sight?.enabled === true;
    }
    if (input.sight?.range !== undefined) {
      sightAfter.range = typeof refreshed.sight?.range === 'number' ? refreshed.sight.range : 0;
    }
    after.sight = sightAfter;
  }

  return {
    ok: true,
    tokenId: input.tokenId,
    sceneId: scene.id ?? '',
    before,
    after,
    changed,
  };
}
