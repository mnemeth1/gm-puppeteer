/**
 * page.evaluate body for remove_combatants. Removes combatants from a
 * scene's combat encounter by combatant id. Partial success is the
 * contract: ids not in the encounter do not abort the batch.
 *
 * Behavior nuances:
 *
 *  - **Scene + combat resolution.** `input.sceneId` → `game.scenes.get`
 *    (miss → `SCENE_NOT_FOUND`); else `game.scenes.active` (absent →
 *    `NO_ACTIVE_SCENE`). The encounter is the Combat whose `scene.id`
 *    matches (preferring `active`); none → `NO_COMBAT`.
 *
 *  - **Pre-filter is mandatory.** Probe-confirmed
 *    (scripts/probe-combat-tracker.mjs probe 6): passing an unknown id
 *    to `deleteEmbeddedDocuments` THROWS ("does not exist in the
 *    EmbeddedCollection"). So each requested combatantId is looked up in
 *    `combat.combatants` first — hits are batched into one delete, misses
 *    go to `notFound`.
 *
 *  - **Snapshot-before-delete.** Each hit's `tokenId` and `name` are
 *    captured before the Foundry call so the response carries an audit
 *    trail after the document is gone.
 *
 *  - **REMOVE_FAILED.** If `deleteEmbeddedDocuments` throws, `details`
 *    carries `attempted` and `notFound`.
 *
 * remove_combatants takes combatant ids, not token ids — get_combat_state
 * is the discovery tool for them.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Helpers are inlined; TS interfaces are
 * erased.
 */
export interface RemoveCombatantsInput {
  combatantIds: string[];
  sceneId?: string;
}

export interface RemovedCombatantEntry {
  combatantId: string;
  tokenId: string | null;
  name: string;
}

export type RemoveCombatantsResult =
  | {
      ok: true;
      sceneId: string;
      combatId: string;
      removed: RemovedCombatantEntry[];
      notFound: string[];
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'NO_COMBAT' | 'REMOVE_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function removeCombatantsBody(
  input: RemoveCombatantsInput,
): Promise<RemoveCombatantsResult> {
  interface FoundryCombatantLike {
    id?: string;
    tokenId?: string | null;
    name?: string;
  }
  interface FoundryCombatLike {
    id?: string;
    active?: boolean;
    scene?: { id?: string } | null;
    combatants?: { contents?: FoundryCombatantLike[] };
    deleteEmbeddedDocuments(type: 'Combatant', ids: string[]): Promise<unknown>;
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
    return {
      ok: false,
      error: {
        code: 'NO_COMBAT',
        message: `Scene "${sceneId}" has no combat encounter.`,
        details: { sceneId },
      },
    };
  }

  const byId = new Map<string, FoundryCombatantLike>();
  for (const c of combat.combatants?.contents ?? []) {
    if (c && typeof c.id === 'string') byId.set(c.id, c);
  }

  const removed: RemovedCombatantEntry[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();
  for (const id of input.combatantIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) {
      notFound.push(id);
      continue;
    }
    removed.push({
      combatantId: id,
      tokenId: typeof c.tokenId === 'string' ? c.tokenId : null,
      name: typeof c.name === 'string' ? c.name : '',
    });
  }

  if (removed.length > 0) {
    try {
      await combat.deleteEmbeddedDocuments(
        'Combatant',
        removed.map((r) => r.combatantId),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: 'REMOVE_FAILED',
          message: `combat.deleteEmbeddedDocuments threw: ${message}`,
          details: {
            sceneId,
            combatId: combat.id ?? '',
            attempted: removed.map((r) => r.combatantId),
            notFound,
            cause: message,
          },
        },
      };
    }
  }

  return { ok: true, sceneId, combatId: combat.id ?? '', removed, notFound };
}
