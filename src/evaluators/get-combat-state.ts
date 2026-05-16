/**
 * page.evaluate body for get_combat_state. Read-only projection of the
 * combat encounter attached to a scene: round, turn, started flag, and
 * the ordered combatant list.
 *
 * Behavior nuances:
 *
 *  - **Scene resolution.** Mirrors `deleteTokenBody`. `input.sceneId` →
 *    `game.scenes.get(id)` (miss → `SCENE_NOT_FOUND`); otherwise
 *    `game.scenes.active` (absent → `NO_ACTIVE_SCENE`).
 *
 *  - **Combat-for-scene.** A Combat is a world document carrying a
 *    `scene` pointer; `game.combat` is only the globally-active one,
 *    which can differ from the combat owned by the resolved scene. We
 *    resolve via `game.combats.contents.filter(c => c.scene?.id ===
 *    sceneId)`, preferring `c.active`. No combat for the scene is a
 *    valid read state — `combat: null`, not an error.
 *
 *  - **Combatant ordering.** `combat.turns` is the array Foundry's
 *    tracker renders (initiative desc, ties broken deterministically);
 *    we use it when present. Before initiative is rolled every
 *    `initiative` is null and the order reflects creation order.
 *
 *  - **Round 0.** A created-but-not-begun combat has `round === 0` and
 *    `turn === null`; `begin_combat` advances it to `round 1 / turn 0`.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Every runtime helper is inlined;
 * TypeScript interfaces are erased and may live at module scope.
 */
export interface GetCombatStateInput {
  sceneId?: string;
}

export interface CombatantEntry {
  combatantId: string;
  tokenId: string | null;
  actorId: string | null;
  name: string;
  initiative: number | null;
  isCurrentTurn: boolean;
  hidden: boolean;
  defeated: boolean;
}

export interface CombatStateBlock {
  combatId: string;
  round: number;
  turn: number | null;
  started: boolean;
  combatants: CombatantEntry[];
}

export type GetCombatStateResult =
  | {
      ok: true;
      sceneId: string;
      combat: CombatStateBlock | null;
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export function getCombatStateBody(input: GetCombatStateInput): GetCombatStateResult {
  interface FoundryCombatantLike {
    id?: string;
    tokenId?: string | null;
    actorId?: string | null;
    name?: string;
    initiative?: number | null;
    hidden?: boolean;
    defeated?: boolean;
    isDefeated?: boolean;
  }
  interface FoundryCombatantsCollection {
    contents?: FoundryCombatantLike[];
  }
  interface FoundryCombatLike {
    id?: string;
    active?: boolean;
    round?: number;
    turn?: number | null;
    started?: boolean;
    scene?: { id?: string } | null;
    turns?: FoundryCombatantLike[];
    combatant?: { id?: string } | null;
    combatants?: FoundryCombatantsCollection;
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
    return { ok: true, sceneId, combat: null };
  }

  const currentTurnId = combat.combatant?.id ?? null;
  const ordered: FoundryCombatantLike[] = Array.isArray(combat.turns)
    ? combat.turns
    : (combat.combatants?.contents ?? []);

  const combatants: CombatantEntry[] = ordered.map((c) => ({
    combatantId: typeof c.id === 'string' ? c.id : '',
    tokenId: typeof c.tokenId === 'string' ? c.tokenId : null,
    actorId: typeof c.actorId === 'string' ? c.actorId : null,
    name: typeof c.name === 'string' ? c.name : '',
    initiative: typeof c.initiative === 'number' ? c.initiative : null,
    isCurrentTurn: currentTurnId != null && c.id === currentTurnId,
    hidden: c.hidden === true,
    defeated: c.isDefeated === true || c.defeated === true,
  }));

  return {
    ok: true,
    sceneId,
    combat: {
      combatId: combat.id ?? '',
      round: typeof combat.round === 'number' ? combat.round : 0,
      turn: typeof combat.turn === 'number' ? combat.turn : null,
      started: combat.started === true,
      combatants,
    },
  };
}
