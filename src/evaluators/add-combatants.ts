/**
 * page.evaluate body for add_combatants. Adds scene tokens to a scene's
 * combat encounter as Combatant documents. Partial success is the
 * contract: tokens not on the scene, or already in the encounter, do not
 * abort the batch.
 *
 * Behavior nuances:
 *
 *  - **Scene + combat resolution.** `input.sceneId` → `game.scenes.get`
 *    (miss → `SCENE_NOT_FOUND`); else `game.scenes.active` (absent →
 *    `NO_ACTIVE_SCENE`). The encounter is the Combat whose `scene.id`
 *    matches (preferring `active`); none → `NO_COMBAT` (run start_combat
 *    first).
 *
 *  - **Pre-filter for duplicates.** Probe-confirmed
 *    (scripts/probe-combat-tracker.mjs probe 4): Foundry does NOT dedupe
 *    — `createEmbeddedDocuments` for a token already in the encounter
 *    creates a SECOND combatant. So each requested tokenId is partitioned
 *    BEFORE any Foundry call: absent from the scene → `notFound`; already
 *    a combatant → `alreadyPresent` (with its existing combatantId);
 *    otherwise → batched into a single create.
 *
 *  - **Minimal payload.** `{tokenId, sceneId}` is sufficient — Foundry
 *    derives `actorId` from the token (probe 3). Initiative is left
 *    null; this tool never rolls initiative.
 *
 *  - **Combatant id resolution.** After the create, combatant ids are
 *    resolved by re-scanning `combat.combatants` for each added tokenId.
 *
 *  - **ADD_FAILED.** If `createEmbeddedDocuments` throws, `details`
 *    carries `attempted` (tokenIds in the create) and `notFound` so the
 *    caller sees what was and wasn't tried.
 *
 * Note: serialized via Puppeteer's `page.evaluate` — only this function's
 * own source reaches the browser. Helpers are inlined; TS interfaces are
 * erased.
 */
export interface AddCombatantsInput {
  tokenIds: string[];
  sceneId?: string;
}

export interface AddedCombatantEntry {
  tokenId: string;
  combatantId: string;
  name: string;
}

export interface AlreadyPresentEntry {
  tokenId: string;
  combatantId: string;
}

export type AddCombatantsResult =
  | {
      ok: true;
      sceneId: string;
      combatId: string;
      added: AddedCombatantEntry[];
      alreadyPresent: AlreadyPresentEntry[];
      notFound: string[];
    }
  | {
      ok: false;
      error: {
        code: 'SCENE_NOT_FOUND' | 'NO_ACTIVE_SCENE' | 'NO_COMBAT' | 'ADD_FAILED';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export async function addCombatantsBody(input: AddCombatantsInput): Promise<AddCombatantsResult> {
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
    createEmbeddedDocuments(
      type: 'Combatant',
      data: Array<Record<string, unknown>>,
    ): Promise<unknown>;
  }
  interface FoundryTokenLike {
    id?: string;
  }
  interface FoundrySceneLike {
    id?: string;
    tokens?: { contents?: FoundryTokenLike[] };
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

  const tokensOnScene = new Set<string>();
  for (const t of scene.tokens?.contents ?? []) {
    if (t && typeof t.id === 'string') tokensOnScene.add(t.id);
  }
  // tokenId -> existing combatantId (first match).
  const existingByToken = new Map<string, string>();
  for (const c of combat.combatants?.contents ?? []) {
    if (
      typeof c.tokenId === 'string' &&
      typeof c.id === 'string' &&
      !existingByToken.has(c.tokenId)
    ) {
      existingByToken.set(c.tokenId, c.id);
    }
  }

  const notFound: string[] = [];
  const alreadyPresent: AlreadyPresentEntry[] = [];
  const toAdd: string[] = [];
  const seen = new Set<string>();
  for (const tokenId of input.tokenIds) {
    if (seen.has(tokenId)) continue;
    seen.add(tokenId);
    if (!tokensOnScene.has(tokenId)) {
      notFound.push(tokenId);
      continue;
    }
    const existing = existingByToken.get(tokenId);
    if (existing) {
      alreadyPresent.push({ tokenId, combatantId: existing });
      continue;
    }
    toAdd.push(tokenId);
  }

  if (toAdd.length > 0) {
    try {
      await combat.createEmbeddedDocuments(
        'Combatant',
        toAdd.map((tokenId) => ({ tokenId, sceneId })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: 'ADD_FAILED',
          message: `combat.createEmbeddedDocuments threw: ${message}`,
          details: {
            sceneId,
            combatId: combat.id ?? '',
            attempted: toAdd,
            notFound,
            cause: message,
          },
        },
      };
    }
  }

  // Resolve combatant ids for the tokens we just added.
  const fresh = (combat.id && game?.combats?.get(combat.id)) || combat;
  const resolvedByToken = new Map<string, FoundryCombatantLike>();
  for (const c of fresh.combatants?.contents ?? []) {
    if (typeof c.tokenId === 'string' && !resolvedByToken.has(c.tokenId)) {
      resolvedByToken.set(c.tokenId, c);
    }
  }
  const added: AddedCombatantEntry[] = toAdd.map((tokenId) => {
    const c = resolvedByToken.get(tokenId);
    return {
      tokenId,
      combatantId: c && typeof c.id === 'string' ? c.id : '',
      name: c && typeof c.name === 'string' ? c.name : '',
    };
  });

  return {
    ok: true,
    sceneId,
    combatId: combat.id ?? '',
    added,
    alreadyPresent,
    notFound,
  };
}
