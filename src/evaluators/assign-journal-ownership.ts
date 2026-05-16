/**
 * page.evaluate body for assign_journal_ownership. Sets one ownership
 * entry on a JournalEntry, or on a specific page within it, keyed by a
 * user id or the literal `"default"` sentinel.
 *
 * Entry vs page:
 *  - `pageId` omitted → the target is the entry. Valid levels are
 *    NONE / LIMITED / OBSERVER / OWNER. INHERIT is rejected — a
 *    top-level document has nothing to inherit from.
 *  - `pageId` set → the target is that page. INHERIT is additionally
 *    valid: it makes the page fall through to the entry's permission
 *    for that user (the natural page default).
 *
 * Write form (confirmed by `probe-journal-phase1.mjs`): the surgical
 * dot-path update `target.update({ "ownership.<key>": <level> })`
 * preserves `default` and every other entry. It works identically on
 * both JournalEntry and JournalEntryPage documents.
 *
 * Non-`"default"` user ids are validated against the user directory so
 * a typo cannot silently create an orphan ownership entry.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export type JournalOwnershipLevel = 'INHERIT' | 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface AssignJournalOwnershipInput {
  entryId: string;
  pageId?: string | undefined;
  userId: string;
  level: JournalOwnershipLevel;
}

export interface AssignJournalOwnershipOk {
  ok: true;
  entryId: string;
  pageId: string | null;
  scope: 'entry' | 'page';
  userId: string;
  userName: string | null;
  previousLevel: JournalOwnershipLevel | null;
  newLevel: JournalOwnershipLevel;
  operation: 'created' | 'updated';
}

export interface AssignJournalOwnershipErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT' | 'FOUNDRY_REJECTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type AssignJournalOwnershipResult = AssignJournalOwnershipOk | AssignJournalOwnershipErr;

export async function assignJournalOwnershipBody(
  input: AssignJournalOwnershipInput,
): Promise<AssignJournalOwnershipResult> {
  const LEVEL_STRING_TO_NUM: Record<JournalOwnershipLevel, number> = {
    INHERIT: -1,
    NONE: 0,
    LIMITED: 1,
    OBSERVER: 2,
    OWNER: 3,
  };
  const LEVEL_NUM_TO_STRING: Record<number, JournalOwnershipLevel> = {
    [-1]: 'INHERIT',
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };
  function toLevelString(n: unknown): JournalOwnershipLevel | null {
    if (typeof n !== 'number') return null;
    return LEVEL_NUM_TO_STRING[n] ?? null;
  }

  interface FoundryUserLike {
    id?: string;
    name?: string;
  }
  interface FoundryDocLike {
    ownership?: Record<string, number> | null;
    update(changes: Record<string, unknown>): Promise<unknown>;
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
  interface FoundryGameForAssign {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
    users?: { get(id: string): FoundryUserLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForAssign }).game;
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

  // INHERIT only valid for page-scope.
  if (input.level === 'INHERIT' && !isPageScope) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'INHERIT is only valid for page-level ownership (pass a pageId). An entry has no ' +
          'parent to inherit from — use NONE to deny baseline access instead.',
        details: { reason: 'INHERIT_ON_ENTRY' },
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

  let userName: string | null = null;
  if (input.userId !== 'default') {
    const user = game.users?.get(input.userId) ?? null;
    if (!user || typeof user.id !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `No user found with id "${input.userId}". Use list_users to discover valid ids, or pass "default" to set the baseline level.`,
          details: { reason: 'USER_NOT_FOUND', userId: input.userId },
        },
      };
    }
    userName = typeof user.name === 'string' ? user.name : null;
  }

  const own = target.ownership ?? {};
  const previousRaw = Object.prototype.hasOwnProperty.call(own, input.userId)
    ? own[input.userId]
    : undefined;
  const previousLevel = previousRaw === undefined ? null : toLevelString(previousRaw);
  const hadKey = previousRaw !== undefined;

  try {
    await target.update({ [`ownership.${input.userId}`]: numericLevel });
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
    newLevel: input.level,
    operation: hadKey ? 'updated' : 'created',
  };
}
