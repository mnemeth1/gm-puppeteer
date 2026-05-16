/**
 * page.evaluate body for remove_journal_ownership. Deletes one user's
 * explicit ownership entry from a JournalEntry, or from a page within
 * it, so that user falls back to the target's `default` level.
 *
 * Refuses to remove the `default` key itself — Foundry always carries
 * one. To clear a baseline, call assign_journal_ownership with
 * userId "default" and the desired level (NONE for an entry, INHERIT
 * for a page).
 *
 * Deletion mechanics (confirmed by `probe-journal-phase1.mjs`): the
 * `-=key` deletion sugar silently does NOT work on ownership maps, and
 * neither does setting the entry to null. The only working path is a
 * whole-map replace with `{recursive: false}`, which forces Foundry to
 * overwrite the object atomically rather than merge — so a key absent
 * from the replacement map is genuinely removed. The implementation
 * therefore snapshots the current map and rebuilds it minus the target
 * key. (Single-GM-deputy MCP; the read-then-write window is one tick
 * and not guarded against concurrent ownership writes.)
 *
 * Orphan-user entries can be removed: the target key is looked up on
 * the document, not on `game.users`, so cleanup works after the user
 * document has been deleted.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export type JournalOwnershipLevel = 'INHERIT' | 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface RemoveJournalOwnershipInput {
  entryId: string;
  pageId?: string | undefined;
  userId: string;
}

export interface RemoveJournalOwnershipOk {
  ok: true;
  entryId: string;
  pageId: string | null;
  scope: 'entry' | 'page';
  userId: string;
  userName: string | null;
  previousLevel: JournalOwnershipLevel;
  fellBackTo: JournalOwnershipLevel;
}

export interface RemoveJournalOwnershipErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RemoveJournalOwnershipResult = RemoveJournalOwnershipOk | RemoveJournalOwnershipErr;

export async function removeJournalOwnershipBody(
  input: RemoveJournalOwnershipInput,
): Promise<RemoveJournalOwnershipResult> {
  const LEVEL_NUM_TO_STRING: Record<number, JournalOwnershipLevel> = {
    [-1]: 'INHERIT',
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };
  function toLevelString(n: unknown): JournalOwnershipLevel {
    if (typeof n !== 'number') return 'NONE';
    return LEVEL_NUM_TO_STRING[n] ?? 'NONE';
  }

  interface FoundryUserLike {
    id?: string;
    name?: string;
  }
  interface FoundryDocLike {
    ownership?: Record<string, number> | null;
    update(changes: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  }
  interface FoundryJournalPageLike extends FoundryDocLike {
    id?: string;
  }
  interface FoundryEmbeddedCollection {
    get(id: string): FoundryJournalPageLike | null | undefined;
  }
  interface FoundryJournalEntryLike extends FoundryDocLike {
    id?: string;
    pages?: FoundryEmbeddedCollection | null;
  }
  interface FoundryGameForRemove {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
    users?: { get(id: string): FoundryUserLike | null | undefined };
  }

  if (input.userId === 'default') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'Cannot remove the "default" ownership entry — Foundry always carries one. To ' +
          'clear the baseline, call assign_journal_ownership with userId "default" and the ' +
          'desired level (NONE for an entry, INHERIT for a page).',
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

  const entry = game.journal?.get(input.entryId) ?? null;
  if (!entry || typeof entry.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `No journal entry found with id "${input.entryId}".`,
        details: { reason: 'ENTRY_NOT_FOUND', entryId: input.entryId },
      },
    };
  }

  const isPageScope = typeof input.pageId === 'string' && input.pageId.length > 0;
  let target: FoundryDocLike = entry;
  let pageId: string | null = null;
  if (isPageScope) {
    const pg = entry.pages?.get(input.pageId as string) ?? null;
    if (!pg || typeof pg.id !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `No page "${input.pageId}" on journal entry "${input.entryId}".`,
          details: { reason: 'PAGE_NOT_FOUND', entryId: input.entryId, pageId: input.pageId },
        },
      };
    }
    target = pg;
    pageId = pg.id;
  }

  const own = target.ownership ?? {};
  if (!Object.prototype.hasOwnProperty.call(own, input.userId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `User "${input.userId}" has no explicit ownership entry on this ${isPageScope ? 'page' : 'entry'} — already falls back to default.`,
        details: { reason: 'NOT_PRESENT', userId: input.userId },
      },
    };
  }

  const previousLevel = toLevelString(own[input.userId]);

  const userDoc = game.users?.get(input.userId) ?? null;
  const userName =
    userDoc && typeof userDoc.name === 'string' && userDoc.name.length > 0 ? userDoc.name : null;

  // Whole-map replace minus the target key. {recursive: false} is
  // mandatory — see file header for the probe-validated reason.
  const replacement: Record<string, number> = {};
  for (const k of Object.keys(own)) {
    if (k === input.userId) continue;
    const v = own[k];
    if (typeof v === 'number') replacement[k] = v;
  }

  try {
    await target.update({ ownership: replacement }, { recursive: false });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'FOUNDRY_REJECTED',
        message: `Foundry rejected ownership update: ${e instanceof Error ? e.message : String(e)}`,
        details: { reason: 'UPDATE_THREW' },
      },
    };
  }

  return {
    ok: true,
    entryId: entry.id,
    pageId,
    scope: isPageScope ? 'page' : 'entry',
    userId: input.userId,
    userName,
    previousLevel,
    fellBackTo: toLevelString(replacement.default),
  };
}
