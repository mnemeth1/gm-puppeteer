/**
 * page.evaluate body for list_world_actors. Enumerates every actor in
 * `game.actors.contents` and projects the minimum identifying / triage
 * fields a caller needs to pick an `actorId` for a downstream tool
 * (`get_actor_state`, `get_actor_inventory`, `get_creature_details`,
 * mutation tools, etc.). NOT a stat-block view.
 *
 * Behavior nuances confirmed by probe against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **Type passthrough.** `actor.type` is surfaced as a bare string. The
 *    probe world contained `character`, `npc`, and `party` only; PF2e and
 *    Foundry can register additional types (`familiar`, `hazard`, `loot`,
 *    `vehicle`, `army`). Rather than narrowing to a literal union and
 *    stripping unknown types, the projection passes the value through
 *    verbatim and lets callers decide.
 *
 *  - **Level normalization.** `system.details.level.value` is read for all
 *    actor types but only emitted when it is a finite number. The PF2e
 *    Party actor (`type === 'party'`) carries `system.details.level.value`
 *    that is *present but non-finite* (NaN); we coerce that to `null`.
 *    Distinguishing "level 0" (a real PF2e value, e.g. some hazards) from
 *    "no meaningful level" matters for downstream filtering, so coerce-to-
 *    zero is rejected. Goblin Warriors register as `level -1`, which is a
 *    real PF2e value and passes through unchanged.
 *
 *  - **UUID.** `actor.uuid` is consistently a string of the form
 *    `Actor.<id>` for world actors. Probed with 0/6 missing, 0/6
 *    non-string. Safe to type as `string`.
 *
 *  - **Folder.** `actor.folder` is either a Folder document (we read
 *    `.id`) or `null` (unfoldered). Probed world had only unfoldered
 *    actors; defensive `folder?.id ?? null` covers both cases.
 *
 *  - **Active-scene presence.** `onActiveScene` is `true` iff the actor
 *    has at least one token on the *world-active* scene
 *    (`game.scenes.active` — the campaign-state pointer, NOT
 *    `canvas.scene`, which is the headless GM's local view). This is the
 *    disambiguator when several actors share a name: the one in play is
 *    the one with a token on the active scene. When no scene is active,
 *    the top-level `activeScene` is `null` and every row is `false`.
 *
 *  - **Sort.** Output is sorted by `name` using a case-insensitive locale
 *    compare for stable ordering across calls.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface WorldActorSummary {
  id: string;
  uuid: string;
  name: string;
  type: string;
  level: number | null;
  folderId: string | null;
  /** True iff the actor has ≥1 token on the world-active scene. */
  onActiveScene: boolean;
}

export interface ListWorldActorsResult {
  /** The world-active scene the `onActiveScene` flags are computed against; null when none is active. */
  activeScene: { id: string; name: string } | null;
  actors: WorldActorSummary[];
}

export function listWorldActorsBody(): ListWorldActorsResult {
  interface FoundryFolderLike {
    id?: string;
  }
  interface FoundryActorSystemDetails {
    level?: { value?: unknown } | null;
  }
  interface FoundryActorSystem {
    details?: FoundryActorSystemDetails | null;
  }
  interface FoundryActorLike {
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    system?: FoundryActorSystem | null;
    folder?: FoundryFolderLike | null;
  }
  interface FoundryActorsCollection {
    contents?: FoundryActorLike[];
  }
  interface FoundryTokenLike {
    actorId?: string | null;
  }
  interface FoundryTokensCollection {
    contents?: FoundryTokenLike[];
  }
  interface FoundrySceneLike {
    id?: string;
    name?: string;
    tokens?: FoundryTokensCollection;
  }
  interface FoundryScenesCollection {
    active?: FoundrySceneLike | null;
  }
  interface FoundryGameForActors {
    actors?: FoundryActorsCollection;
    scenes?: FoundryScenesCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForActors }).game;
  const all = game?.actors?.contents ?? [];

  // -- World-active scene: the campaign-state pointer, NOT canvas.scene.
  const active = game?.scenes?.active ?? null;
  const activeScene =
    active && typeof active.id === 'string'
      ? { id: active.id, name: typeof active.name === 'string' ? active.name : '' }
      : null;
  const activeSceneActorIds = new Set<string>();
  for (const t of active?.tokens?.contents ?? []) {
    if (t && typeof t.actorId === 'string') activeSceneActorIds.add(t.actorId);
  }

  const summaries: WorldActorSummary[] = [];
  for (const a of all) {
    if (!a || typeof a.id !== 'string' || typeof a.uuid !== 'string') continue;
    const lvlRaw = a.system?.details?.level?.value;
    const level = typeof lvlRaw === 'number' && Number.isFinite(lvlRaw) ? lvlRaw : null;
    summaries.push({
      id: a.id,
      uuid: a.uuid,
      name: typeof a.name === 'string' ? a.name : '',
      type: typeof a.type === 'string' ? a.type : '',
      level,
      folderId: a.folder?.id ?? null,
      onActiveScene: activeSceneActorIds.has(a.id),
    });
  }

  summaries.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));

  return { activeScene, actors: summaries };
}
