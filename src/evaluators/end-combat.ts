/**
 * page.evaluate body for end_combat. Ends a scene's combat encounter by
 * deleting the Combat document — Foundry's "End Combat" semantics.
 *
 * Behavior nuances:
 *
 *  - **Scene resolution.** `input.sceneId` → `game.scenes.get` (miss →
 *    `SCENE_NOT_FOUND`); else `game.scenes.active` (absent →
 *    `NO_ACTIVE_SCENE`).
 *
 *  - **Idempotent.** If the scene has no encounter, that is success, not
 *    an error: `ok: true` with `combatId: null`, `deleted: false`. So a
 *    repeated end_combat is harmless.
 *
 *  - **`combat.delete()`, not `endCombat()`.** Probe-confirmed
 *    (scripts/probe-combat-tracker.mjs probe 7): `combat.delete()`
 *    removes the encounter cleanly. `Combat#endCombat()` is deliberately
 *    NOT used — it opens a confirmation dialog that would hang the
 *    headless client.
 *
 *  - **Snapshot-before-delete.** `combatId` and `combatantCount` are
 *    captured before the Foundry call for the audit trail.
 *
 *  - **DELETE_FAILED.** If `combat.delete()` throws, `details.cause`
 *    carries the underlying message.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Helpers are inlined; TS interfaces are
 * erased.
 */
export interface EndCombatInput {
  sceneId?: string;
}

export type EndCombatResult =
  | {
      ok: true;
      sceneId: string;
      combatId: string | null;
      deleted: boolean;
      combatantCount: number;
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'DELETE_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function endCombatBody(input: EndCombatInput): Promise<EndCombatResult> {
  interface FoundryCombatLike {
    id?: string;
    active?: boolean;
    scene?: { id?: string } | null;
    combatants?: { size?: number };
    delete(): Promise<unknown>;
  }
  interface FoundrySceneLike {
    id?: string;
  }
  interface FoundryScenesLike {
    get(id: string): FoundrySceneLike | undefined;
    active?: FoundrySceneLike | null;
  }
  interface FoundryGameLike {
    scenes?: FoundryScenesLike;
    combats?: { contents?: FoundryCombatLike[] };
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
  const sceneId = scene.id ?? '';

  const forScene = (game?.combats?.contents ?? []).filter((c) => c.scene?.id === sceneId);
  const combat = forScene.find((c) => c.active === true) ?? forScene[0] ?? null;
  if (!combat) {
    return { ok: true, sceneId, combatId: null, deleted: false, combatantCount: 0 };
  }

  const combatId = combat.id ?? '';
  const combatantCount = typeof combat.combatants?.size === 'number' ? combat.combatants.size : 0;

  try {
    await combat.delete();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'DELETE_FAILED',
        message: `combat.delete threw: ${message}`,
        details: { sceneId, combatId, cause: message },
      },
    };
  }

  return { ok: true, sceneId, combatId, deleted: true, combatantCount };
}
