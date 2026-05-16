/**
 * page.evaluate body for place_token_at_grid. Places a token from an
 * existing world actor onto a scene at grid coordinates {i, j}.
 *
 * Behavior nuances confirmed by scripts/probe-token-placement.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *  - The canonical row/col → pixel helper is
 *    `scene.grid.getTopLeftPoint({i, j})`. Alternate input shapes
 *    (`[i, j]` and `{row, col}`) silently return `{x: null, y: null}`,
 *    so the `{i, j}` form is the only safe one.
 *  - The grid origin is the padded canvas's (0, 0), NOT the image's
 *    top-left. The image occupies the rect
 *    `[padX, padY, padX + width, padY + height]` where
 *    `padX = round(width * padding)` and `padY = round(height * padding)`.
 *    Tokens placed in the padding region are accepted silently by
 *    Foundry; we surface this as a non-fatal `outOfImageBounds: true`
 *    flag rather than refusing.
 *  - `actor.getTokenDocument({x, y, name})` honors the `name` override
 *    but ignores `width`/`height` (those come from the prototype). For
 *    `tokenName` we therefore route the override through that param.
 *  - The canonical creation path is the active-scene instance's
 *    `createEmbeddedDocuments('Token', [data])` — equivalent to the
 *    drag-from-sidebar-onto-canvas UI flow. There is no
 *    `Scene.implementation.createEmbeddedDocuments` static; `Scene`
 *    resolves to `ScenePF2e` and the instance method already dispatches
 *    to the PF2e subclass.
 *  - v14 lets you stack tokens on an already-occupied square. We do not
 *    pre-check; the caller is responsible (grappling, swallowed, etc.).
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface PlaceTokenAtGridInput {
  actorId: string;
  i: number;
  j: number;
  sceneId?: string;
  tokenName?: string;
}

export interface PlaceTokenAtGridOk {
  ok: true;
  tokenId: string;
  sceneId: string;
  gridCoords: { i: number; j: number };
  canvasCoords: { x: number; y: number };
  tokenName: string;
  actorLink: boolean;
  outOfImageBounds: boolean;
}

export type PlaceTokenAtGridErrCode =
  | 'ACTOR_NOT_FOUND'
  | 'SCENE_NOT_FOUND'
  | 'NO_ACTIVE_SCENE'
  | 'NON_SQUARE_GRID'
  | 'CREATE_FAILED';

export interface PlaceTokenAtGridErr {
  ok: false;
  error: {
    code: PlaceTokenAtGridErrCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type PlaceTokenAtGridResult = PlaceTokenAtGridOk | PlaceTokenAtGridErr;

interface FoundryGridLike {
  type?: number;
  size?: number;
  getTopLeftPoint(offset: { i: number; j: number }): { x: number | null; y: number | null };
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

interface FoundryGameLike {
  actors?: { get(id: string): FoundryActorLike | undefined };
  scenes?: {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  };
}

export async function placeTokenAtGridBody(
  input: PlaceTokenAtGridInput,
): Promise<PlaceTokenAtGridResult> {
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;

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

  const grid = scene.grid;
  if (!grid || grid.type !== 1) {
    return {
      ok: false,
      error: {
        code: 'NON_SQUARE_GRID',
        message:
          `Scene grid type is ${grid?.type ?? 'unknown'}, not 1 (square). ` +
          'place_token_at_grid only supports square grids; hex and gridless scenes are not supported.',
        details: { sceneId: scene.id ?? null, gridType: grid?.type ?? null },
      },
    };
  }

  const topLeft = grid.getTopLeftPoint({ i: input.i, j: input.j });
  if (typeof topLeft?.x !== 'number' || typeof topLeft?.y !== 'number') {
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message: `scene.grid.getTopLeftPoint({i:${input.i}, j:${input.j}}) returned a non-numeric point.`,
        details: {
          i: input.i,
          j: input.j,
          returned: topLeft as unknown as Record<string, unknown>,
        },
      },
    };
  }
  const x = topLeft.x;
  const y = topLeft.y;

  const getTokenDocInput: Record<string, unknown> = { x, y };
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
        details: { actorId: input.actorId, sceneId: scene.id ?? null, i: input.i, j: input.j },
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
        details: { actorId: input.actorId, sceneId: scene.id ?? null, i: input.i, j: input.j },
      },
    };
  }

  // Compute outOfImageBounds against the image rect (which sits inside the padded canvas).
  const gridSize = grid.size ?? 0;
  const sceneWidth = scene.width ?? 0;
  const sceneHeight = scene.height ?? 0;
  const scenePadding = scene.padding ?? 0;
  const padX = Math.round(sceneWidth * scenePadding);
  const padY = Math.round(sceneHeight * scenePadding);
  const tokenW = (created.width ?? 1) * gridSize;
  const tokenH = (created.height ?? 1) * gridSize;
  const placedX = created.x ?? x;
  const placedY = created.y ?? y;
  const outOfImageBounds =
    placedX < padX ||
    placedY < padY ||
    placedX + tokenW > padX + sceneWidth ||
    placedY + tokenH > padY + sceneHeight;

  return {
    ok: true,
    tokenId: created.id,
    sceneId: scene.id ?? '',
    gridCoords: { i: input.i, j: input.j },
    canvasCoords: { x: placedX, y: placedY },
    tokenName: created.name ?? '',
    actorLink: created.actorLink === true,
    outOfImageBounds,
  };
}
