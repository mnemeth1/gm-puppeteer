/**
 * page.evaluate body for list_actor_ownership. Reads the actor's
 * `ownership` map and returns a structured, name-resolved view.
 *
 * Behavior nuances confirmed by `probe-actor-ownership-phase1.mjs`
 * against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - `actor.ownership` is a plain `{[key: string]: number}` map. Foundry
 *    always includes a `default` key (the level used for any user not
 *    otherwise listed).
 *  - Numeric levels come from `CONST.DOCUMENT_OWNERSHIP_LEVELS`:
 *      INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3.
 *    INHERIT is only meaningful for embedded documents; actor-level
 *    ownership in practice is 0-3 only. We surface 0-3 as the enum
 *    strings used by the assign/remove tools and append a warning if
 *    we encounter anything outside that range.
 *  - Orphan-user entries: when a user document is deleted, the actor's
 *    ownership map retains the (now-meaningless) entry. We surface those
 *    with `userName: null` so callers can spot them — `remove_actor_ownership`
 *    can be used to clean them up.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers and outer closures are NOT available at runtime —
 * keep everything the function needs inline.
 */
export interface ListActorOwnershipInput {
  actorId: string;
}

export type OwnershipLevelString = 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface OwnershipEntry {
  userId: string;
  userName: string | null;
  level: OwnershipLevelString;
}

export interface ListActorOwnershipOk {
  ok: true;
  actor: { id: string; name: string };
  default: OwnershipLevelString;
  users: OwnershipEntry[];
  warnings?: string[];
}

export interface ListActorOwnershipErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ListActorOwnershipResult = ListActorOwnershipOk | ListActorOwnershipErr;

export function listActorOwnershipBody(input: ListActorOwnershipInput): ListActorOwnershipResult {
  // Inlined per the page.evaluate serialization constraint.
  const LEVEL_NUM_TO_STRING: Record<number, OwnershipLevelString> = {
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };
  function toLevelString(n: unknown): OwnershipLevelString | null {
    if (typeof n !== 'number') return null;
    const s = LEVEL_NUM_TO_STRING[n];
    return s ?? null;
  }

  interface FoundryUserLike {
    id?: string;
    name?: string;
  }
  interface FoundryUsersCollection {
    get(id: string): FoundryUserLike | null | undefined;
  }
  interface FoundryActorLike {
    id?: string;
    name?: string;
    ownership?: Record<string, number> | null;
  }
  interface FoundryGameForOwnership {
    actors?: { get(id: string): FoundryActorLike | null | undefined };
    users?: FoundryUsersCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForOwnership }).game;
  if (!game) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  const actor = game.actors?.get(input.actorId) ?? null;
  if (!actor || typeof actor.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `No actor found with id "${input.actorId}".`,
        details: { reason: 'ACTOR_NOT_FOUND', actorId: input.actorId },
      },
    };
  }

  const own = actor.ownership ?? {};
  const warnings: string[] = [];

  const defaultRaw = own.default;
  let defaultLevel = toLevelString(defaultRaw);
  if (defaultLevel === null) {
    warnings.push(
      `default ownership value ${JSON.stringify(defaultRaw)} is outside the 0-3 range; surfaced as "NONE"`,
    );
    defaultLevel = 'NONE';
  }

  const users: OwnershipEntry[] = [];
  for (const key of Object.keys(own)) {
    if (key === 'default') continue;
    const raw = own[key];
    let level = toLevelString(raw);
    if (level === null) {
      warnings.push(
        `ownership value ${JSON.stringify(raw)} for user "${key}" is outside the 0-3 range; surfaced as "NONE"`,
      );
      level = 'NONE';
    }
    const userDoc = game.users?.get(key) ?? null;
    const userName =
      userDoc && typeof userDoc.name === 'string' && userDoc.name.length > 0
        ? userDoc.name
        : null;
    users.push({ userId: key, userName, level });
  }

  users.sort((a, b) => {
    const an = a.userName ?? '';
    const bn = b.userName ?? '';
    return an.localeCompare(bn, undefined, { sensitivity: 'base' });
  });

  const result: ListActorOwnershipOk = {
    ok: true,
    actor: { id: actor.id, name: typeof actor.name === 'string' ? actor.name : '' },
    default: defaultLevel,
    users,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
