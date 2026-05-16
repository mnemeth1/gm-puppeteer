/**
 * page.evaluate body for delete_token. Removes one or more tokens from a
 * Foundry scene by token id. Partial success is the contract: missing ids
 * surface in `notFound` rather than aborting the whole batch.
 *
 * Behavior nuances:
 *
 *  - **Scene resolution.** Mirrors `getSceneTokensBody`. If `input.sceneId`
 *    is provided, the scene is looked up via `game.scenes.get(id)`; a miss
 *    resolves to `SCENE_NOT_FOUND`. Otherwise `game.scenes.active` is used;
 *    an absent active scene resolves to `NO_ACTIVE_SCENE`. We deliberately
 *    do NOT fall back to `canvas.scene` — "active" is the campaign-state
 *    pointer, and `canvas.scene` would silently target the rendered scene,
 *    which can differ. A `tokenId` is unique within a scene, not globally,
 *    so the scene we look in matters.
 *
 *  - **Partial success.** Each requested id is looked up in
 *    `scene.tokens?.contents`. Hits are batched into the
 *    `deleteEmbeddedDocuments` call; misses are returned in `notFound`. An
 *    all-`notFound` batch is still `ok: true` (no Foundry call happened,
 *    nothing went wrong) — callers can branch on `deleted.length === 0`
 *    if they need to.
 *
 *  - **Snapshot-before-delete.** Each hit's `tokenName` (string, '' if
 *    missing) and `actorId` (string or null for unlinked tokens; see
 *    `get-scene-tokens.ts` comments) is captured BEFORE the Foundry call,
 *    so the response carries a usable audit trail even though the document
 *    is gone by the time we return.
 *
 *  - **Foundry document type.** `'Token'` is the v14 canonical embedded
 *    document type, confirmed by every probe that cleans tokens up
 *    (e.g. `scripts/probe-token-placement.mjs:46`,
 *    `scripts/e2e-place-token-at-grid.mjs:100`,
 *    `scripts/probe-get-actor-state.mjs:150`).
 *
 *  - **DELETE_FAILED.** If `scene.deleteEmbeddedDocuments` throws (network
 *    transient, permission edge case, etc.) we surface the underlying
 *    message in `details.cause` and return `DELETE_FAILED`. By that point
 *    `notFound` has already been computed, so the caller can see which
 *    ids weren't even attempted.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * runtime helper is defined inline. (TypeScript interfaces are type-only
 * and erased at compile time, so they may live anywhere.)
 */
export interface DeleteTokenInput {
  tokenIds: string[];
  sceneId?: string;
}

export interface DeletedTokenEntry {
  tokenId: string;
  tokenName: string;
  actorId: string | null;
}

export type DeleteTokenResult =
  | {
      ok: true;
      sceneId: string;
      deleted: DeletedTokenEntry[];
      notFound: string[];
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'DELETE_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function deleteTokenBody(input: DeleteTokenInput): Promise<DeleteTokenResult> {
  interface FoundryTokenLike {
    id?: string;
    name?: string;
    actorId?: string | null;
  }
  interface FoundryTokensCollection {
    contents?: FoundryTokenLike[];
  }
  interface FoundrySceneLike {
    id?: string;
    tokens?: FoundryTokensCollection;
    deleteEmbeddedDocuments(type: 'Token', ids: string[]): Promise<unknown>;
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

  const tokensOnScene = scene.tokens?.contents ?? [];
  const byId = new Map<string, FoundryTokenLike>();
  for (const t of tokensOnScene) {
    if (t && typeof t.id === 'string') byId.set(t.id, t);
  }

  const deleted: DeletedTokenEntry[] = [];
  const notFound: string[] = [];
  for (const id of input.tokenIds) {
    const t = byId.get(id);
    if (!t) {
      notFound.push(id);
      continue;
    }
    deleted.push({
      tokenId: id,
      tokenName: typeof t.name === 'string' ? t.name : '',
      actorId: typeof t.actorId === 'string' ? t.actorId : null,
    });
  }

  if (deleted.length > 0) {
    try {
      await scene.deleteEmbeddedDocuments(
        'Token',
        deleted.map((d) => d.tokenId),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: 'DELETE_FAILED',
          message: `scene.deleteEmbeddedDocuments threw: ${message}`,
          details: {
            sceneId: scene.id ?? '',
            attempted: deleted.map((d) => d.tokenId),
            notFound,
            cause: message,
          },
        },
      };
    }
  }

  return { ok: true, sceneId: scene.id ?? '', deleted, notFound };
}
