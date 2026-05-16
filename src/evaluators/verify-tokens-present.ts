/**
 * page.evaluate body that reports which of the given token ids are
 * still present on a scene. Used by `delete_token`'s recovery path:
 * when Puppeteer's CDP layer drops the response of a long-running
 * `deleteEmbeddedDocuments` await with "Promise was collected" — even
 * though Foundry actually completed the operation — this evaluator
 * lets the tool verify post-hoc whether the deletion took effect.
 *
 * Scope is intentionally narrow: no snapshot, no deletes, just an
 * id-presence check. Mirrors the scene-resolution semantics of
 * `delete_token` and `get_scene_tokens` so the verification reflects
 * the same scene the original call targeted.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface VerifyTokensPresentInput {
  tokenIds: string[];
  sceneId?: string;
}

export type VerifyTokensPresentResult =
  | {
      ok: true;
      sceneId: string;
      /** Subset of `tokenIds` that are still on the scene. */
      stillPresent: string[];
      /** Subset of `tokenIds` that are no longer on the scene. */
      absent: string[];
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export function verifyTokensPresentBody(
  input: VerifyTokensPresentInput,
): VerifyTokensPresentResult {
  interface FoundryTokenLike {
    id?: string;
  }
  interface FoundryTokensCollection {
    get(id: string): FoundryTokenLike | undefined;
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
          message: 'No active scene; pass sceneId explicitly.',
        },
      };
    }
  }

  const stillPresent: string[] = [];
  const absent: string[] = [];
  for (const id of input.tokenIds) {
    const t = scene.tokens?.get(id);
    if (t && typeof t.id === 'string') {
      stillPresent.push(id);
    } else {
      absent.push(id);
    }
  }
  return { ok: true, sceneId: scene.id ?? '', stillPresent, absent };
}
