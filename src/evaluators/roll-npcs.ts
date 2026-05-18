/**
 * page.evaluate body for roll_npcs. Rolls initiative for every NPC
 * combatant in a scene's combat encounter — the combat tracker's
 * "Roll NPCs" button. This is a core Foundry action (`Combat#rollNPC`),
 * not a game-system feature, so the one tool serves both the PF2e and
 * D&D 5e worlds.
 *
 * Behavior nuances:
 *
 *  - **Scene + combat resolution.** `input.sceneId` → `game.scenes.get`
 *    (miss → `SCENE_NOT_FOUND`); else `game.scenes.active` (absent →
 *    `NO_ACTIVE_SCENE`). The encounter is the Combat whose `scene.id`
 *    matches (preferring `active`); none → `NO_COMBAT` (run start_combat
 *    first).
 *
 *  - **`rollNPC()`.** `Combat#rollNPC()` rolls initiative only for
 *    combatants where `isNPC` is true AND that have no initiative score
 *    yet. NPCs that already rolled are left untouched; the player's PC
 *    (`isNPC === false`) is never rolled — PC initiative stays the human
 *    GM's. The call is async, posts initiative chat messages, and is
 *    wrapped in an 8s `Promise.race` guard (mirrors `begin-combat.ts`)
 *    in case a roll-config dialog ever hangs the headless client.
 *
 *  - **Valid any time.** Not gated to round 0 — `rollNPC()` only fills
 *    in missing initiative, so calling it after `begin_combat` is safe
 *    and rolls any NPC added mid-combat. No NPC to roll is success, not
 *    an error (`rolled: []`).
 *
 *  - **Classification.** Combatant state is snapshotted before the roll
 *    and diffed after: `rolled` = NPCs whose initiative went null →
 *    number this call; `alreadyRolled` = NPCs that already had a score;
 *    `pcCount` = non-NPC combatants (reported as a count, never rolled).
 *
 *  - **ROLL_FAILED.** If `rollNPC()` throws or times out, the underlying
 *    message is surfaced in `details.cause`.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Helpers are inlined; TS interfaces are
 * erased.
 */
export interface RollNpcsInput {
  sceneId?: string;
}

export interface RolledCombatant {
  combatantId: string;
  name: string;
  initiative: number | null;
}

export type RollNpcsResult =
  | {
      ok: true;
      sceneId: string;
      combatId: string;
      round: number;
      started: boolean;
      rolled: RolledCombatant[];
      alreadyRolled: RolledCombatant[];
      pcCount: number;
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'NO_COMBAT' | 'ROLL_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function rollNpcsBody(input: RollNpcsInput): Promise<RollNpcsResult> {
  interface FoundryCombatantLike {
    id?: string;
    name?: string;
    initiative?: number | null;
    isNPC?: boolean;
  }
  interface FoundryCombatLike {
    id?: string;
    active?: boolean;
    round?: number;
    started?: boolean;
    scene?: { id?: string } | null;
    combatants?: { contents?: FoundryCombatantLike[] };
    rollNPC?: () => Promise<unknown>;
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
  if (typeof combat.rollNPC !== 'function') {
    return {
      ok: false,
      error: {
        code: 'ROLL_FAILED',
        message: 'Combat#rollNPC is not a function on this Foundry build.',
        details: { sceneId, combatId: combat.id ?? '' },
      },
    };
  }

  // Snapshot every combatant's NPC flag and initiative before the roll.
  const before = new Map<string, { isNPC: boolean; initiative: number | null }>();
  for (const c of combat.combatants?.contents ?? []) {
    if (typeof c.id !== 'string') continue;
    before.set(c.id, {
      isNPC: c.isNPC === true,
      initiative: typeof c.initiative === 'number' ? c.initiative : null,
    });
  }

  try {
    await Promise.race([
      combat.rollNPC(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('combat.rollNPC timed out after 8s')), 8000),
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'ROLL_FAILED',
        message: `combat.rollNPC threw: ${message}`,
        details: { sceneId, combatId: combat.id ?? '', cause: message },
      },
    };
  }

  const fresh = (combat.id && game?.combats?.get(combat.id)) || combat;

  const rolled: RolledCombatant[] = [];
  const alreadyRolled: RolledCombatant[] = [];
  let pcCount = 0;
  for (const c of fresh.combatants?.contents ?? []) {
    const id = typeof c.id === 'string' ? c.id : '';
    const snap = before.get(id);
    const wasNPC = snap ? snap.isNPC : c.isNPC === true;
    if (!wasNPC) {
      pcCount += 1;
      continue;
    }
    const initiative = typeof c.initiative === 'number' ? c.initiative : null;
    const entry: RolledCombatant = {
      combatantId: id,
      name: typeof c.name === 'string' ? c.name : '',
      initiative,
    };
    const beforeInit = snap ? snap.initiative : null;
    if (typeof beforeInit === 'number') {
      alreadyRolled.push(entry);
    } else if (initiative !== null) {
      rolled.push(entry);
    }
    // An NPC still lacking initiative after rollNPC is omitted from both
    // lists — rollNPC rolls every unrolled NPC, so this should not occur.
  }

  return {
    ok: true,
    sceneId,
    combatId: fresh.id ?? '',
    round: typeof fresh.round === 'number' ? fresh.round : 0,
    started: fresh.started === true,
    rolled,
    alreadyRolled,
    pcCount,
  };
}
