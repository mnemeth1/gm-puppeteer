/**
 * page.evaluate body for remove_actor_ownership. Deletes one user's
 * explicit entry from `actor.ownership` so that user falls back to the
 * `default` baseline. Refuses to remove the `default` key itself
 * (set the default to NONE via assign_actor_ownership instead).
 *
 * Behavior nuances confirmed by `probe-actor-ownership-phase1.mjs`
 * against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - Foundry's `-=key` deletion sugar SILENTLY DOES NOT WORK on the
 *    `ownership` field (no throw, no effect). Setting the entry to
 *    `null` (`actor.update({"ownership.<id>": null})`) is likewise a
 *    no-op.
 *  - The only working deletion path is a whole-map replace with
 *    `{recursive: false}`:
 *      `actor.update({ ownership: <map without target key> }, { recursive: false })`
 *    The `{recursive: false}` option forces Foundry to overwrite the
 *    object atomically rather than merge keys, so anything missing
 *    from the replacement map is actually removed.
 *  - Because this is a whole-map replace, the implementation must
 *    snapshot the current ownership map first and rebuild it minus
 *    the target key. Concurrent ownership writes from other clients
 *    between read and write are not protected against (this is a
 *    single-GM-deputy MCP and the window is one tick).
 *  - Orphan-user entries can be removed by this tool: we look up the
 *    target key on the actor, not on `game.users`, so cleanup of
 *    orphaned permissions works even after the user document has been
 *    deleted.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers and outer closures are NOT available at runtime —
 * keep everything the function needs inline.
 */
export type OwnershipLevelString = 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface RemoveActorOwnershipInput {
  actorId: string;
  userId: string;
}

export interface RemoveActorOwnershipOk {
  ok: true;
  actor: { id: string; name: string };
  userId: string;
  userName: string | null;
  previousLevel: OwnershipLevelString;
  fellBackTo: OwnershipLevelString;
}

export interface RemoveActorOwnershipErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RemoveActorOwnershipResult = RemoveActorOwnershipOk | RemoveActorOwnershipErr;

export async function removeActorOwnershipBody(
  input: RemoveActorOwnershipInput,
): Promise<RemoveActorOwnershipResult> {
  const LEVEL_NUM_TO_STRING: Record<number, OwnershipLevelString> = {
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };
  function toLevelString(n: unknown): OwnershipLevelString {
    if (typeof n !== 'number') return 'NONE';
    return LEVEL_NUM_TO_STRING[n] ?? 'NONE';
  }

  interface FoundryUserLike {
    id?: string;
    name?: string;
  }
  interface FoundryActorLike {
    id?: string;
    name?: string;
    ownership?: Record<string, number> | null;
    update(changes: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryGameForRemove {
    actors?: { get(id: string): FoundryActorLike | null | undefined };
    users?: { get(id: string): FoundryUserLike | null | undefined };
  }

  if (input.userId === 'default') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'Cannot remove the "default" ownership entry — Foundry always carries one. To clear ' +
          'the baseline level, call assign_actor_ownership with userId: "default" and level: ' +
          '"NONE".',
        details: { reason: 'CANNOT_REMOVE_DEFAULT' },
      },
    };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForRemove }).game;
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
  if (!Object.prototype.hasOwnProperty.call(own, input.userId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `User "${input.userId}" has no explicit ownership entry on actor "${actor.id}" — already falls back to default.`,
        details: { reason: 'NOT_PRESENT', userId: input.userId, actorId: actor.id },
      },
    };
  }

  const previousLevel = toLevelString(own[input.userId]);

  // Look up the user for display only — orphan entries are allowed.
  const userDoc = game.users?.get(input.userId) ?? null;
  const userName =
    userDoc && typeof userDoc.name === 'string' && userDoc.name.length > 0 ? userDoc.name : null;

  // Build replacement map without the target key. {recursive: false} is
  // mandatory — see file header for the probe-validated reason.
  const replacement: Record<string, number> = {};
  for (const k of Object.keys(own)) {
    if (k === input.userId) continue;
    const v = own[k];
    if (typeof v === 'number') replacement[k] = v;
  }
  await actor.update({ ownership: replacement }, { recursive: false });

  const defaultLevel = toLevelString(replacement.default);
  return {
    ok: true,
    actor: { id: actor.id, name: typeof actor.name === 'string' ? actor.name : '' },
    userId: input.userId,
    userName,
    previousLevel,
    fellBackTo: defaultLevel,
  };
}
