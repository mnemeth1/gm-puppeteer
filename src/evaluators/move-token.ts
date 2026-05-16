/**
 * page.evaluate body for `move_token`. Repositions an existing token
 * on a scene to a new location, expressed in either grid `{i, j}` or
 * canvas-pixel `{x, y}` coordinates.
 *
 * Behavior (verified by scripts/probe-pr2-preflight.mjs against
 * Foundry v14.361):
 *  - The move is a `token.update({x, y}, {animate})` write, not a
 *    pathfinding/movement call. No wall collision check, no movement-
 *    triggered effects. The `animate` option controls only the visual
 *    tween — semantics are identical to a teleport either way.
 *  - `animate: false` is the default. Headless Chromium with a
 *    contended event loop has been observed to make animated updates
 *    very slow (tens of seconds) and to leave the in-memory `token`
 *    reference reporting stale `.x/.y` immediately after `await`.
 *    Re-fetching from `scene.tokens.get(id)` post-update is therefore
 *    necessary to report the final position truthfully.
 *  - Grid input `{i, j}` is converted via
 *    `scene.grid.getTopLeftPoint({i, j})`. Hex/gridless scenes are
 *    refused with `NON_SQUARE_GRID` when `{i, j}` is used; pixel
 *    input `{x, y}` works on any grid type.
 *  - No occupancy / wall collision pre-check; mirrors
 *    `place_token_at_grid`.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */

export interface MoveTokenInput {
  tokenId: string;
  sceneId?: string;
  animate?: boolean;
  ij?: { i: number; j: number };
  xy?: { x: number; y: number };
}

export interface MoveTokenOk {
  ok: true;
  tokenId: string;
  sceneId: string;
  before: { x: number; y: number };
  after: { x: number; y: number };
  targetCanvasCoords: { x: number; y: number };
  gridCoords: { i: number; j: number } | null;
  animated: boolean;
}

export type MoveTokenErrCode =
  | 'TOKEN_NOT_FOUND'
  | 'SCENE_NOT_FOUND'
  | 'NO_ACTIVE_SCENE'
  | 'NON_SQUARE_GRID'
  | 'UPDATE_FAILED';

export interface MoveTokenErr {
  ok: false;
  error: {
    code: MoveTokenErrCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type MoveTokenResult = MoveTokenOk | MoveTokenErr;

interface FoundryGridLike {
  type?: number;
  getTopLeftPoint(offset: { i: number; j: number }): { x: number | null; y: number | null };
}

interface FoundryTokenLike {
  id?: string;
  x?: number;
  y?: number;
  update(
    changes: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<FoundryTokenLike | undefined>;
}

interface FoundrySceneLike {
  id?: string;
  grid?: FoundryGridLike;
  tokens?: {
    get(id: string): FoundryTokenLike | undefined;
    contents?: FoundryTokenLike[];
  };
}

interface FoundryGameLike {
  scenes?: {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  };
}

export async function moveTokenBody(input: MoveTokenInput): Promise<MoveTokenResult> {
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

  // Resolve target canvas coords from either {i, j} or {x, y} input.
  let targetX: number;
  let targetY: number;
  let gridCoords: { i: number; j: number } | null = null;

  if (input.ij !== undefined) {
    const grid = scene.grid;
    if (!grid || grid.type !== 1) {
      return {
        ok: false,
        error: {
          code: 'NON_SQUARE_GRID',
          message:
            `Scene grid type is ${grid?.type ?? 'unknown'}, not 1 (square). ` +
            'Pass `xy` (canvas-pixel coords) instead of `ij` for non-square scenes.',
          details: { sceneId: scene.id ?? null, gridType: grid?.type ?? null },
        },
      };
    }
    const tl = grid.getTopLeftPoint({ i: input.ij.i, j: input.ij.j });
    if (typeof tl?.x !== 'number' || typeof tl?.y !== 'number') {
      return {
        ok: false,
        error: {
          code: 'UPDATE_FAILED',
          message: `scene.grid.getTopLeftPoint({i:${input.ij.i}, j:${input.ij.j}}) returned non-numeric.`,
          details: { ij: input.ij, returned: tl as unknown as Record<string, unknown> },
        },
      };
    }
    targetX = tl.x;
    targetY = tl.y;
    gridCoords = { i: input.ij.i, j: input.ij.j };
  } else if (input.xy !== undefined) {
    targetX = input.xy.x;
    targetY = input.xy.y;
  } else {
    // Schema layer should prevent this; defensive only.
    return {
      ok: false,
      error: {
        code: 'UPDATE_FAILED',
        message: 'move_token requires either `ij` or `xy` input; neither was provided.',
      },
    };
  }

  const before = { x: token.x ?? 0, y: token.y ?? 0 };
  const animate = input.animate === true;

  try {
    await token.update({ x: targetX, y: targetY }, { animate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'UPDATE_FAILED',
        message: `token.update failed: ${message}`,
        details: { tokenId: input.tokenId, targetX, targetY },
      },
    };
  }

  // Re-fetch the token after update — the existing reference can report
  // stale x/y immediately after the await resolves (observed in
  // probe-pr2-preflight.mjs against an animated update under load).
  const refreshed = scene.tokens?.get(input.tokenId) ?? token;
  const after = { x: refreshed.x ?? targetX, y: refreshed.y ?? targetY };

  return {
    ok: true,
    tokenId: input.tokenId,
    sceneId: scene.id ?? '',
    before,
    after,
    targetCanvasCoords: { x: targetX, y: targetY },
    gridCoords,
    animated: animate,
  };
}
