/**
 * page.evaluate body for start_combat. Creates the Combat encounter for
 * a scene — the round-0 container that combatants are added to. It does
 * NOT begin the encounter (that is `begin_combat`'s job, after the GM
 * rolls initiative).
 *
 * Behavior nuances:
 *
 *  - **Scene resolution.** Mirrors `deleteTokenBody`: `input.sceneId` →
 *    `game.scenes.get(id)` (miss → `SCENE_NOT_FOUND`); otherwise
 *    `game.scenes.active` (absent → `NO_ACTIVE_SCENE`).
 *
 *  - **Idempotent.** A scene owns at most one encounter in normal use.
 *    If a Combat already exists for the scene we return it untouched
 *    with `created: false` — re-calling start_combat never produces a
 *    second encounter. The pre-existing combat is preferred by `active`
 *    flag, else first match.
 *
 *  - **Creation.** `getDocumentClass("Combat").create({scene, active:
 *    true})` — probe-confirmed (scripts/probe-combat-tracker.mjs): the
 *    new combat lands `round: 0`, `started: false`, becomes
 *    `game.combat`, and `combat.scene.id` matches. `active: true` makes
 *    it the globally-active encounter.
 *
 *  - **CREATE_FAILED.** If `create` throws, the underlying message is
 *    surfaced in `details.cause`.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Helpers are inlined; TS interfaces are
 * erased.
 */
export interface StartCombatInput {
  sceneId?: string;
}

export type StartCombatResult =
  | {
      ok: true;
      sceneId: string;
      combatId: string;
      round: number;
      started: boolean;
      active: boolean;
      created: boolean;
      combatantCount: number;
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'CREATE_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function startCombatBody(input: StartCombatInput): Promise<StartCombatResult> {
  interface FoundryCombatLike {
    id?: string;
    active?: boolean;
    round?: number;
    started?: boolean;
    scene?: { id?: string } | null;
    combatants?: { size?: number };
  }
  interface FoundryCombatClass {
    create(data: Record<string, unknown>): Promise<FoundryCombatLike>;
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
    combats?: { contents?: FoundryCombatLike[]; get(id: string): FoundryCombatLike | undefined };
  }

  const root = globalThis as unknown as {
    game?: FoundryGameLike;
    getDocumentClass?: (name: string) => FoundryCombatClass | undefined;
  };
  const game = root.game;

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

  const project = (c: FoundryCombatLike, created: boolean): StartCombatResult => ({
    ok: true,
    sceneId,
    combatId: c.id ?? '',
    round: typeof c.round === 'number' ? c.round : 0,
    started: c.started === true,
    active: c.active === true,
    created,
    combatantCount: typeof c.combatants?.size === 'number' ? c.combatants.size : 0,
  });

  const forScene = (game?.combats?.contents ?? []).filter((c) => c.scene?.id === sceneId);
  const existing = forScene.find((c) => c.active === true) ?? forScene[0] ?? null;
  if (existing) {
    return project(existing, false);
  }

  const cls = root.getDocumentClass?.('Combat');
  if (!cls || typeof cls.create !== 'function') {
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message: 'getDocumentClass("Combat") did not yield a creatable document class.',
      },
    };
  }

  let combat: FoundryCombatLike;
  try {
    combat = await cls.create({ scene: sceneId, active: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'CREATE_FAILED',
        message: `Combat.create threw: ${message}`,
        details: { sceneId, cause: message },
      },
    };
  }

  // Re-fetch for fresh state — the create return is usable but a lookup
  // is the authoritative post-mutation view.
  const fresh = (combat.id && game?.combats?.get(combat.id)) || combat;
  return project(fresh, true);
}
