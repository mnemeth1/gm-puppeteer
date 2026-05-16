/**
 * page.evaluate body for get_scene_tokens. Enumerates `scene.tokens.contents`
 * on either the active scene or a caller-supplied scene id and projects the
 * minimum identifying / triage fields needed to pick a `tokenId` for
 * downstream operations or to inspect what is currently on a scene.
 *
 * Behavior nuances confirmed against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **Scene resolution.** If `input.sceneId` is provided, the scene is
 *    looked up via `game.scenes.get(id)`; missing ids resolve to a
 *    `SCENE_NOT_FOUND` error. Otherwise `game.scenes.active` is used; an
 *    absent active scene resolves to `NO_ACTIVE_SCENE`. We deliberately do
 *    NOT fall back to `canvas.scene` (the rendered scene) — "active" is the
 *    campaign-state pointer and is the right default for a tool meant to
 *    discover `tokenId`s for further action.
 *
 *  - **Token collection access.** `scene.tokens.contents` is the canonical
 *    iterable on a Scene document (same form `scripts/probe-token-placement`
 *    uses). The collection itself is also iterable but `.contents` gives a
 *    plain array, which is what we want for sorting.
 *
 *  - **Position fields.** `token.x` / `token.y` are the top-left of the
 *    bounding box in canvas pixels (see CLAUDE.md "Grid orientation").
 *    `token.width` / `token.height` are in *grid squares*, not pixels
 *    (1 for Medium, 2 for Large, 3 for Huge, etc.). Passed through as
 *    numbers; callers convert to grid coords with `scene.grid.getOffset({x,y})`
 *    if needed.
 *
 *  - **Unlinked tokens.** A token without a backing actor (or one whose
 *    actor was deleted) carries `actorId = null`. We pass null through
 *    rather than dropping the row — an unlinked token is still a
 *    real placed token that the GM may want to delete or move.
 *
 *  - **Disposition.** `token.disposition` is Foundry's
 *    `CONST.TOKEN_DISPOSITIONS` enum: -2 secret, -1 hostile, 0 neutral,
 *    1 friendly. Passed through as a bare number; callers decide.
 *
 *  - **Sort.** Output is sorted by `name` using case-insensitive locale
 *    compare for stable ordering across calls (matches list_world_actors).
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * helper is defined inline.
 */
export interface GetSceneTokensInput {
  sceneId?: string;
}

export interface SceneTokenEntry {
  id: string;
  name: string;
  actorId: string | null;
  actorLink: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  disposition: number;
  hidden: boolean;
}

export type GetSceneTokensResult =
  | { ok: true; sceneId: string; tokens: SceneTokenEntry[] }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export function getSceneTokensBody(input: GetSceneTokensInput): GetSceneTokensResult {
  interface FoundryTokenLike {
    id?: string;
    name?: string;
    actorId?: string | null;
    actorLink?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    disposition?: number;
    hidden?: boolean;
  }
  interface FoundryTokensCollection {
    contents?: FoundryTokenLike[];
  }
  interface FoundrySceneLike {
    id?: string;
    tokens?: FoundryTokensCollection;
  }
  interface FoundryScenesLike {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  }
  interface FoundryGameLike {
    scenes?: FoundryScenesLike;
  }

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
            'No active scene in this world, and no sceneId provided. ' +
            'Activate a scene in Foundry or pass sceneId explicitly.',
        },
      };
    }
  }

  const all = scene.tokens?.contents ?? [];
  const entries: SceneTokenEntry[] = [];
  for (const t of all) {
    if (!t || typeof t.id !== 'string') continue;
    entries.push({
      id: t.id,
      name: typeof t.name === 'string' ? t.name : '',
      actorId: typeof t.actorId === 'string' ? t.actorId : null,
      actorLink: t.actorLink === true,
      x: typeof t.x === 'number' ? t.x : 0,
      y: typeof t.y === 'number' ? t.y : 0,
      width: typeof t.width === 'number' ? t.width : 1,
      height: typeof t.height === 'number' ? t.height : 1,
      disposition: typeof t.disposition === 'number' ? t.disposition : 0,
      hidden: t.hidden === true,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { ok: true, sceneId: scene.id ?? '', tokens: entries };
}
