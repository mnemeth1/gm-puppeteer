/**
 * page.evaluate body for list_users. Enumerates `game.users.contents`
 * and projects the minimum fields needed to drive the
 * actor-ownership tool cluster:
 *
 *   - `id`     — User document id, used as the key into
 *                `actor.ownership` and as the `userId` argument to
 *                `assign_actor_ownership` / `remove_actor_ownership`.
 *   - `name`   — display name; not unique by Foundry guarantee, but in
 *                practice unique per world.
 *   - `role`   — numeric role from `CONST.USER_ROLES`:
 *                  0 NONE | 1 PLAYER | 2 TRUSTED | 3 ASSISTANT | 4 GAMEMASTER.
 *                Surfaced numerically for downstream filtering; the
 *                tool description carries the mapping.
 *   - `isGM`   — derived flag, true for ASSISTANT and GAMEMASTER.
 *   - `active` — whether the user is currently logged in (Foundry
 *                sets this transiently). Useful for "who's playing
 *                right now" UX but unrelated to ownership.
 *
 * Confirmed by `probe-actor-ownership-phase1.mjs`:
 *   - Sandbox returns 3 users: AI-GM (GM, role 4), Human-GM
 *     (GM, role 4), Player (TRUSTED, role 2, not active).
 *   - `game.users.get(<bogusId>)` returns `null` cleanly — caller-side
 *     validation in the assign/remove tools can rely on this.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers and outer closures are NOT available at runtime —
 * keep everything the function needs inline.
 */
export interface UserSummary {
  id: string;
  name: string;
  role: number;
  isGM: boolean;
  active: boolean;
}

export interface ListUsersResult {
  users: UserSummary[];
}

export function listUsersBody(): ListUsersResult {
  interface FoundryUserLike {
    id?: string;
    name?: string;
    role?: number;
    isGM?: boolean;
    active?: boolean;
  }
  interface FoundryUsersCollection {
    contents?: FoundryUserLike[];
  }
  interface FoundryGameForUsers {
    users?: FoundryUsersCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForUsers }).game;
  const all = game?.users?.contents ?? [];

  const summaries: UserSummary[] = [];
  for (const u of all) {
    if (!u || typeof u.id !== 'string') continue;
    summaries.push({
      id: u.id,
      name: typeof u.name === 'string' ? u.name : '',
      role: typeof u.role === 'number' ? u.role : 0,
      isGM: u.isGM === true,
      active: u.active === true,
    });
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { users: summaries };
}
