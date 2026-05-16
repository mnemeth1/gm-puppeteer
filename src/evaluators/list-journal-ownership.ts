/**
 * page.evaluate body for list_journal_ownership. Reads a JournalEntry's
 * ownership map AND every page's ownership map, returns a structured,
 * name-resolved view.
 *
 * Behavior confirmed by `probe-journal-phase1.mjs`:
 *  - Entry ownership is a plain `{[userId|"default"]: number}` map, same
 *    shape as actors. Entry `default` is 0-3 in practice (a top-level
 *    document has nothing to inherit from).
 *  - Page ownership defaults to `{default: -1}` — level -1 is INHERIT,
 *    meaning the page falls through to its parent entry's permission.
 *    Pages can also carry explicit user keys and a non-INHERIT default.
 *  - Numeric levels: INHERIT -1, NONE 0, LIMITED 1, OBSERVER 2, OWNER 3.
 *  - Orphan-user entries (the user document was deleted) are surfaced
 *    with `userName: null` so they can be cleaned up via
 *    remove_journal_ownership.
 *
 * GMs and Assistant GMs ignore document ownership entirely — they always
 * have full access. This tool still reports any explicit entry on their
 * user id for completeness.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export type JournalOwnershipLevel = 'INHERIT' | 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface JournalOwnershipUserEntry {
  userId: string;
  userName: string | null;
  level: JournalOwnershipLevel;
}

export interface JournalPageOwnership {
  pageId: string;
  pageName: string;
  default: JournalOwnershipLevel;
  hasOverride: boolean;
  users: JournalOwnershipUserEntry[];
}

export interface ListJournalOwnershipInput {
  entryId: string;
}

export interface ListJournalOwnershipOk {
  ok: true;
  entry: { id: string; name: string };
  default: JournalOwnershipLevel;
  users: JournalOwnershipUserEntry[];
  pages: JournalPageOwnership[];
  warnings?: string[];
}

export interface ListJournalOwnershipErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ListJournalOwnershipResult = ListJournalOwnershipOk | ListJournalOwnershipErr;

export function listJournalOwnershipBody(
  input: ListJournalOwnershipInput,
): ListJournalOwnershipResult {
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
  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    ownership?: Record<string, number> | null;
  }
  interface FoundryEmbeddedCollection {
    contents?: FoundryJournalPageLike[];
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    ownership?: Record<string, number> | null;
    pages?: FoundryEmbeddedCollection | null;
  }
  interface FoundryGameForList {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
    users?: { get(id: string): FoundryUserLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForList }).game;
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

  const warnings: string[] = [];

  function resolveUserName(userId: string): string | null {
    const u = game?.users?.get(userId) ?? null;
    return u && typeof u.name === 'string' && u.name.length > 0 ? u.name : null;
  }

  function projectMap(
    own: Record<string, number>,
    label: string,
  ): { def: JournalOwnershipLevel; users: JournalOwnershipUserEntry[] } {
    let def = toLevelString(own.default);
    if (def === null) {
      warnings.push(
        `${label} default ownership ${JSON.stringify(own.default)} is outside -1..3; surfaced as "NONE"`,
      );
      def = 'NONE';
    }
    const users: JournalOwnershipUserEntry[] = [];
    for (const key of Object.keys(own)) {
      if (key === 'default') continue;
      let level = toLevelString(own[key]);
      if (level === null) {
        warnings.push(
          `${label} ownership ${JSON.stringify(own[key])} for user "${key}" is outside -1..3; surfaced as "NONE"`,
        );
        level = 'NONE';
      }
      users.push({ userId: key, userName: resolveUserName(key), level });
    }
    users.sort((a, b) =>
      (a.userName ?? '').localeCompare(b.userName ?? '', undefined, { sensitivity: 'base' }),
    );
    return { def, users };
  }

  const entryProj = projectMap(entry.ownership ?? {}, 'entry');

  const pages: JournalPageOwnership[] = [];
  for (const p of entry.pages?.contents ?? []) {
    if (!p || typeof p.id !== 'string') continue;
    const own = p.ownership ?? {};
    const proj = projectMap(own, `page "${p.id}"`);
    const hasUserKeys = proj.users.length > 0;
    const defaultIsInherit = proj.def === 'INHERIT';
    pages.push({
      pageId: p.id,
      pageName: typeof p.name === 'string' ? p.name : '',
      default: proj.def,
      hasOverride: hasUserKeys || !defaultIsInherit,
      users: proj.users,
    });
  }

  const result: ListJournalOwnershipOk = {
    ok: true,
    entry: { id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' },
    default: entryProj.def,
    users: entryProj.users,
    pages,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
