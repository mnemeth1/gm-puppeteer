/**
 * page.evaluate body for `place_token_at_screen_pixel`. Places a
 * token from an existing world actor onto a scene at a screenshot-
 * pixel coordinate (the pixel coord as it appears in a screenshot
 * from `foundry_screenshot`).
 *
 * Behavior (verified by scripts/probe-canvas-transform.mjs and
 * scripts/probe-pr2-preflight.mjs against Foundry v14.361):
 *  - Screen pixel → canvas pixel via `canvas.stage.toLocal({x, y})`.
 *    Equivalent to `(screen - offset) / scale` using the derived
 *    offset surfaced by `foundry_screenshot`'s transform sidecar.
 *  - On square grids (`grid.type === 1`), the canvas pixel is
 *    snapped to the containing cell's top-left via
 *    `grid.getOffset({x, y})` → `grid.getTopLeftPoint({i, j})`. The
 *    snapped coord, not the raw canvas pixel, is used for placement
 *    so the token aligns with the grid.
 *  - On gridless scenes (`grid.type === 0`), the canvas pixel is
 *    used directly — no snapping. This is the primary reason this
 *    tool exists alongside `place_token_at_grid`.
 *  - Hex grids (`grid.type === 2-5`) are refused with
 *    `NON_SQUARE_GRID` for v1, matching the sibling tool.
 *  - `outOfImageBounds` is set when the placed bounding box extends
 *    past the scene image rect (mirrors `place_token_at_grid`).
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */

export interface PlaceTokenAtScreenPixelInput {
  actorId: string;
  screenX: number;
  screenY: number;
  sceneId?: string;
  tokenName?: string;
}

export interface PlaceTokenAtScreenPixelOk {
  ok: true;
  tokenId: string;
  sceneId: string;
  screenCoords: { x: number; y: number };
  canvasCoords: { x: number; y: number };
  /** Pre-snap canvas pixel from toLocal — present even when snapped. */
  rawCanvasCoords: { x: number; y: number };
  /** Set only when the scene has a square grid and the pixel was snapped. */
  gridCoords: { i: number; j: number } | null;
  tokenName: string;
  actorLink: boolean;
  outOfImageBounds: boolean;
  snappedToGrid: boolean;
}

export type PlaceTokenAtScreenPixelErrCode =
  | 'ACTOR_NOT_FOUND'
  | 'SCENE_NOT_FOUND'
  | 'NO_ACTIVE_SCENE'
  | 'NON_SQUARE_GRID'
  | 'CANVAS_NOT_READY'
  | 'CREATE_FAILED';

export interface PlaceTokenAtScreenPixelErr {
  ok: false;
  error: {
    code: PlaceTokenAtScreenPixelErrCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type PlaceTokenAtScreenPixelResult = PlaceTokenAtScreenPixelOk | PlaceTokenAtScreenPixelErr;

interface FoundryGridLike {
  type?: number;
  size?: number;
  getTopLeftPoint(offset: { i: number; j: number }): { x: number | null; y: number | null };
  getOffset?(p: { x: number; y: number }): { i: number; j: number };
}

interface FoundryTokenDocLike {
  toObject(): Record<string, unknown>;
}

interface FoundryActorLike {
  id?: string;
  getTokenDocument(data: Record<string, unknown>): Promise<FoundryTokenDocLike>;
}

interface FoundryCreatedTokenLike {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  actorLink?: boolean;
}

interface FoundrySceneLike {
  id?: string;
  width?: number;
  height?: number;
  padding?: number;
  grid?: FoundryGridLike;
  createEmbeddedDocuments(
    type: 'Token',
    data: Record<string, unknown>[],
  ): Promise<FoundryCreatedTokenLike[]>;
}

interface FoundryStageLike {
  toLocal(p: { x: number; y: number }): { x: number; y: number };
}

interface FoundryCanvasLike {
  stage?: FoundryStageLike;
}

interface FoundryGameLike {
  actors?: { get(id: string): FoundryActorLike | undefined };
  scenes?: {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  };
}

export async function placeTokenAtScreenPixelBody(
  input: PlaceTokenAtScreenPixelInput,
): Promise<PlaceTokenAtScreenPixelResult> {
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const canvasObj = (globalThis as unknown as { canvas?: FoundryCanvasLike }).canvas;

  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return {
      ok: false,
      error: {
        code: 'ACTOR_NOT_FOUND',
        message: `No world actor with id "${input.actorId}".`,
        details: { actorId: input.actorId },
      },
    };
  }

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
            'No active scene in this world, and no sceneId provided. ' +
            'Activate a scene in Foundry or pass sceneId explicitly.',
        },
      };
    }
  }

  const stage = canvasObj?.stage;
  if (!stage || typeof stage.toLocal !== 'function') {
    return {
      ok: false,
      error: {
        code: 'CANVAS_NOT_READY',
        message:
          'canvas.stage.toLocal is not available; the canvas is not ready. ' +
          'Wait for game.ready and a rendered scene before calling this tool.',
      },
    };
  }

  const grid = scene.grid;
  const gridType = grid?.type;
  // Refuse hex (types 2-5); allow square (1) and gridless (0).
  if (gridType !== 0 && gridType !== 1) {
    return {
      ok: false,
      error: {
        code: 'NON_SQUARE_GRID',
        message:
          `Scene grid type is ${gridType ?? 'unknown'} (hex variant). ` +
          'place_token_at_screen_pixel supports only square (type 1) and gridless (type 0) scenes.',
        details: { sceneId: scene.id ?? null, gridType: gridType ?? null },
      },
    };
  }

  // Inverse-transform screen pixel → canvas pixel.
  const rawCanvas = stage.toLocal({ x: input.screenX, y: input.screenY });

  // Snap to grid for square scenes; use raw pixel for gridless.
  let placeX = rawCanvas.x;
  let placeY = rawCanvas.y;
  let snappedToGrid = false;
  let gridCoords: { i: number; j: number } | null = null;
  if (gridType === 1 && grid && typeof grid.getOffset === 'function') {
    const offset = grid.getOffset({ x: rawCanvas.x, y: rawCanvas.y });
    if (offset && typeof offset.i === 'number' && typeof offset.j === 'number') {
      const tl = grid.getTopLeftPoint({ i: offset.i, j: offset.j });
      if (typeof tl?.x === 'number' && typeof tl?.y === 'number') {
        placeX = tl.x;
        placeY = tl.y;
        snappedToGrid = true;
        gridCoords = { i: offset.i, j: offset.j };
      }
    }
  }

  const getTokenDocInput: Record<string, unknown> = { x: placeX, y: placeY };
  if (input.tokenName !== undefined) {
    getTokenDocInput.name = input.tokenName;
  }

  let created: FoundryCreatedTokenLike | undefined;
  try {
    const tdoc = await actor.getTokenDocument(getTokenDocInput);
    const data = tdoc.toObject();
    const arr = await scene.createEmbeddedDocuments('Token', [data]);
    created = arr?.[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message: `Failed to create token: ${message}`,
        details: {
          actorId: input.actorId,
          sceneId: scene.id ?? null,
          screenX: input.screenX,
          screenY: input.screenY,
          placeX,
          placeY,
        },
      },
    };
  }

  if (!created || !created.id) {
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message:
          'scene.createEmbeddedDocuments("Token", [...]) resolved without a created document.',
        details: { actorId: input.actorId, sceneId: scene.id ?? null },
      },
    };
  }

  const gridSize = grid?.size ?? 0;
  const sceneWidth = scene.width ?? 0;
  const sceneHeight = scene.height ?? 0;
  const scenePadding = scene.padding ?? 0;
  const padX = Math.round(sceneWidth * scenePadding);
  const padY = Math.round(sceneHeight * scenePadding);
  const tokenW = (created.width ?? 1) * (gridSize || 1);
  const tokenH = (created.height ?? 1) * (gridSize || 1);
  const placedX = created.x ?? placeX;
  const placedY = created.y ?? placeY;
  const outOfImageBounds =
    sceneWidth > 0 && sceneHeight > 0
      ? placedX < padX ||
        placedY < padY ||
        placedX + tokenW > padX + sceneWidth ||
        placedY + tokenH > padY + sceneHeight
      : false;

  return {
    ok: true,
    tokenId: created.id,
    sceneId: scene.id ?? '',
    screenCoords: { x: input.screenX, y: input.screenY },
    canvasCoords: { x: placedX, y: placedY },
    rawCanvasCoords: { x: rawCanvas.x, y: rawCanvas.y },
    gridCoords,
    tokenName: created.name ?? '',
    actorLink: created.actorLink === true,
    outOfImageBounds,
    snappedToGrid,
  };
}
