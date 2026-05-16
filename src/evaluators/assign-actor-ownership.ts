/**
 * page.evaluate body for assign_actor_ownership. Sets one entry in
 * `actor.ownership` to a target level, where the entry key is either
 * a user id or the literal sentinel `"default"`.
 *
 * Behavior nuances confirmed by `probe-actor-ownership-phase1.mjs`
 * against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - The surgical write form is the dot-path update:
 *      `actor.update({ "ownership.<userId>": <numericLevel> })`.
 *    This preserves `default` and all other user entries unchanged.
 *  - Whole-object updates (`actor.update({ ownership: {...} })`) merge
 *    by default rather than replace, which would also work for assign
 *    but is unnecessary surface area; the dot-path is what we use.
 *  - `actor.update({ "ownership.default": N })` works identically;
 *    `default` is just another key in the map.
 *  - `game.users.get(<bogusId>)` returns `null` cleanly. The tool
 *    validates non-`"default"` user ids against the user directory
 *    so a typo doesn't silently create an orphan entry.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers and outer closures are NOT available at runtime —
 * keep everything the function needs inline.
 */
export type OwnershipLevelString = 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface AssignActorOwnershipInput {
  actorId: string;
  userId: string;
  level: OwnershipLevelString;
}

export interface AssignActorOwnershipOk {
  ok: true;
  actor: { id: string; name: string };
  userId: string;
  userName: string | null;
  previousLevel: OwnershipLevelString | null;
  newLevel: OwnershipLevelString;
  operation: 'created' | 'updated';
}

export interface AssignActorOwnershipErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type AssignActorOwnershipResult = AssignActorOwnershipOk | AssignActorOwnershipErr;

export async function assignActorOwnershipBody(
  input: AssignActorOwnershipInput,
): Promise<AssignActorOwnershipResult> {
  const LEVEL_STRING_TO_NUM: Record<OwnershipLevelString, number> = {
    NONE: 0,
    LIMITED: 1,
    OBSERVER: 2,
    OWNER: 3,
  };
  const LEVEL_NUM_TO_STRING: Record<number, OwnershipLevelString> = {
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };
  function toLevelString(n: unknown): OwnershipLevelString | null {
    if (typeof n !== 'number') return null;
    return LEVEL_NUM_TO_STRING[n] ?? null;
  }

  interface FoundryUserLike {
    id?: string;
    name?: string;
  }
  interface FoundryActorLike {
    id?: string;
    name?: string;
    ownership?: Record<string, number> | null;
    update(changes: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryGameForAssign {
    actors?: { get(id: string): FoundryActorLike | null | undefined };
    users?: { get(id: string): FoundryUserLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForAssign }).game;
  if (!game) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' } };
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

  const numericLevel = LEVEL_STRING_TO_NUM[input.level];
  if (typeof numericLevel !== 'number') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Unknown ownership level "${input.level}".`,
        details: { reason: 'INVALID_LEVEL', level: input.level },
      },
    };
  }

  let userName: string | null = null;
  if (input.userId !== 'default') {
    const user = game.users?.get(input.userId) ?? null;
    if (!user || typeof user.id !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `No user found with id "${input.userId}". Use list_users to discover valid ids, or pass "default" to set the baseline ownership level.`,
          details: { reason: 'USER_NOT_FOUND', userId: input.userId },
        },
      };
    }
    userName = typeof user.name === 'string' ? user.name : null;
  }

  const own = actor.ownership ?? {};
  const previousRaw = Object.prototype.hasOwnProperty.call(own, input.userId)
    ? own[input.userId]
    : undefined;
  const previousLevel = previousRaw === undefined ? null : toLevelString(previousRaw);
  const hadKey = previousRaw !== undefined;

  await actor.update({ [`ownership.${input.userId}`]: numericLevel });

  const operation: 'created' | 'updated' = hadKey ? 'updated' : 'created';
  return {
    ok: true,
    actor: { id: actor.id, name: typeof actor.name === 'string' ? actor.name : '' },
    userId: input.userId,
    userName,
    previousLevel,
    newLevel: input.level,
    operation,
  };
}
