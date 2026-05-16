/**
 * page.evaluate body for begin_combat. Advances a scene's combat
 * encounter from the round-0 staging state to round 1 / turn 0 — the
 * "Begin Combat" action. It does NOT roll initiative; the human GM does
 * that first, so combatants without a rolled initiative simply appear
 * unordered.
 *
 * Behavior nuances:
 *
 *  - **Scene + combat resolution.** `input.sceneId` → `game.scenes.get`
 *    (miss → `SCENE_NOT_FOUND`); else `game.scenes.active` (absent →
 *    `NO_ACTIVE_SCENE`). The encounter is the Combat whose `scene.id`
 *    matches (preferring `active`); none → `NO_COMBAT` (run start_combat
 *    first).
 *
 *  - **`startCombat()`.** Probe-confirmed (scripts/probe-combat-tracker
 *    .mjs probe 5): `Combat#startCombat()` exists, resolves promptly
 *    with no initiative dialog opened, and lands `round: 1`,
 *    `turn: 0`, `started: true`. No `combat.update` fallback is needed.
 *
 *  - **Idempotent.** If the encounter is already `started`, no Foundry
 *    call is made — the current state is returned with
 *    `alreadyStarted: true`.
 *
 *  - **BEGIN_FAILED.** If `startCombat()` throws, the underlying message
 *    is surfaced in `details.cause`.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Helpers are inlined; TS interfaces are
 * erased.
 */
export interface BeginCombatInput {
  sceneId?: string;
}

export type BeginCombatResult =
  | {
      ok: true;
      sceneId: string;
      combatId: string;
      round: number;
      turn: number | null;
      started: boolean;
      alreadyStarted: boolean;
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'NO_COMBAT' | 'BEGIN_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function beginCombatBody(input: BeginCombatInput): Promise<BeginCombatResult> {
  interface FoundryCombatLike {
    id?: string;
    active?: boolean;
    round?: number;
    turn?: number | null;
    started?: boolean;
    scene?: { id?: string } | null;
    startCombat(): Promise<unknown>;
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
    return {
      ok: false,
      error: {
        code: 'NO_COMBAT',
        message: `Scene "${sceneId}" has no combat encounter. Run start_combat first.`,
        details: { sceneId },
      },
    };
  }

  const project = (c: FoundryCombatLike, alreadyStarted: boolean): BeginCombatResult => ({
    ok: true,
    sceneId,
    combatId: c.id ?? '',
    round: typeof c.round === 'number' ? c.round : 0,
    turn: typeof c.turn === 'number' ? c.turn : null,
    started: c.started === true,
    alreadyStarted,
  });

  if (combat.started === true) {
    return project(combat, true);
  }

  try {
    await combat.startCombat();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'BEGIN_FAILED',
        message: `combat.startCombat threw: ${message}`,
        details: { sceneId, combatId: combat.id ?? '', cause: message },
      },
    };
  }

  const fresh = (combat.id && game?.combats?.get(combat.id)) || combat;
  return project(fresh, false);
}
