/**
 * page.evaluate body for list_scenes. Enumerates every scene in
 * `game.scenes.contents` and projects the minimum identifying fields a
 * caller needs to pick a `sceneId` for a downstream tool
 * (`get_scene_tokens`, etc.). NOT a full scene-detail view — that is
 * `get_current_scene`'s surface.
 *
 * Behavior nuances confirmed by probe against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **`active` is boolean.** Probed across the world's scenes; every
 *    `scene.active` value was a concrete boolean (`typeof === 'boolean'`).
 *    Exactly one scene reported `active: true`, matching Foundry's
 *    invariant that a world has at most one active scene. We surface the
 *    flag with a strict `=== true` check so any future non-boolean drift
 *    coerces to `false` rather than to a truthy non-boolean.
 *
 *  - **`id` / `name`.** Both fields are consistently non-empty strings on
 *    every probed scene (0/2 missing, 0/2 non-string). Safe to type as
 *    `string`; we still defensively skip rows missing a string `id` since
 *    the id is the primary key callers will pass back into other tools.
 *
 *  - **`folder`.** In the probed world every scene had `folder === null`
 *    (no foldered scenes present). The shape when populated is expected
 *    to mirror `actor.folder` — a Folder document with at least `.id`,
 *    or `null` when unfoldered — based on Foundry's common folder
 *    pattern. We expose `folderId` with the same `folder?.id ?? null`
 *    defensive read used by `list_world_actors`; a future probe against
 *    a world with foldered scenes can confirm the populated shape if it
 *    ever matters.
 *
 *  - **Sort.** Output is sorted by `name` using a case-insensitive locale
 *    compare for stable ordering across calls.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface SceneSummary {
  id: string;
  name: string;
  active: boolean;
  folderId: string | null;
}

export interface ListScenesResult {
  scenes: SceneSummary[];
}

export function listScenesBody(): ListScenesResult {
  interface FoundryFolderLike {
    id?: string;
  }
  interface FoundrySceneLike {
    id?: string;
    name?: string;
    active?: unknown;
    folder?: FoundryFolderLike | null;
  }
  interface FoundryScenesCollection {
    contents?: FoundrySceneLike[];
  }
  interface FoundryGameForScenes {
    scenes?: FoundryScenesCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForScenes }).game;
  const all = game?.scenes?.contents ?? [];

  const summaries: SceneSummary[] = [];
  for (const s of all) {
    if (!s || typeof s.id !== 'string') continue;
    summaries.push({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : '',
      active: s.active === true,
      folderId: s.folder?.id ?? null,
    });
  }

  summaries.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));

  return { scenes: summaries };
}
