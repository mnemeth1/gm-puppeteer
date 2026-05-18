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
 *   - `idle`   — Foundry's "away" flag (the "zzz" badge in the
 *                players panel): an `active` user who has produced no
 *                input recently. `User#idle` is a plain boolean on
 *                the document.
 *   - `idleSeconds` — seconds since the user's last activity, or
 *                `null` when unknown. Derived from `User#lastActivityTime`
 *                (epoch ms): `Math.floor((Date.now() - lastActivityTime)
 *                / 1000)` for an `active` user with a non-zero
 *                timestamp, else `null`. Computed inside this body so
 *                the browser clock is used consistently on both ends.
 *
 * Caveat — the headless self client. The MCP logs in as `AI-GM`; that
 * headless Chromium produces no mouse/keyboard input, so Foundry
 * always reports `AI-GM` as `idle: true` with `lastActivityTime === 0`
 * (hence `idleSeconds: null`). `idle`/`idleSeconds` are only
 * meaningful for *other* `active` users; the self user's idle state
 * is noise. Inactive (not-logged-in) users report `idle: false`,
 * `idleSeconds: null`.
 *
 * Confirmed by `probe-actor-ownership-phase1.mjs`:
 *   - Sandbox returns 3 users: AI-GM (GM, role 4), Human-GM
 *     (GM, role 4), Player (TRUSTED, role 2, not active).
 *   - `game.users.get(<bogusId>)` returns `null` cleanly — caller-side
 *     validation in the assign/remove tools can rely on this.
 *
 * `idle` / `lastActivityTime` confirmed by a live `foundry_eval` probe
 * against Foundry v14.361: `User#idle` is a boolean, `User#lastActivityTime`
 * a getter returning epoch ms (0 for the self client and never-connected
 * users).
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
  idle: boolean;
  idleSeconds: number | null;
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
    idle?: boolean;
    lastActivityTime?: number;
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
    const active = u.active === true;
    const lastActivityTime = typeof u.lastActivityTime === 'number' ? u.lastActivityTime : 0;
    const idleSeconds =
      active && lastActivityTime > 0
        ? Math.floor((Date.now() - lastActivityTime) / 1000)
        : null;
    summaries.push({
      id: u.id,
      name: typeof u.name === 'string' ? u.name : '',
      role: typeof u.role === 'number' ? u.role : 0,
      isGM: u.isGM === true,
      active,
      idle: u.idle === true,
      idleSeconds,
    });
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { users: summaries };
}
