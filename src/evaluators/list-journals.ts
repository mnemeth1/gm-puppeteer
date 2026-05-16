/**
 * page.evaluate body for list_journals. Enumerates every JournalEntry in
 * `game.journal.contents` and projects the minimum triage fields a caller
 * needs to pick an `entryId` for downstream tools (`get_journal_entry`,
 * `get_journal_page`, mutation tools, ownership tools).
 *
 * Behavior confirmed by `probe-journal-phase1.mjs` against Foundry v14.361:
 *
 *  - `entry.pages` is an embedded collection; `entry.pages.size` returns
 *    the page count without forcing iteration.
 *  - `entry.folder` is either a Folder document or null.
 *  - `entry.ownership` is always present with a `default` key. Pages
 *    have their own ownership maps with `default: -1` (INHERIT) by
 *    default — page-level ownership is reported by `list_journal_ownership`,
 *    not here.
 *  - `hasOverrides` is true when any explicit user-keyed ownership entry
 *    exists beyond `default`. Lets callers spot entries with custom
 *    permissions at a glance.
 *
 * Note: serialized via Puppeteer's `page.evaluate`. All helpers inlined.
 */
export type JournalOwnershipDefault = 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface JournalEntrySummary {
  id: string;
  name: string;
  folderId: string | null;
  pageCount: number;
  ownership: {
    default: JournalOwnershipDefault;
    hasOverrides: boolean;
  };
}

export interface ListJournalsResult {
  entries: JournalEntrySummary[];
}

export function listJournalsBody(): ListJournalsResult {
  const LEVEL_NUM_TO_STRING: Record<number, JournalOwnershipDefault> = {
    0: 'NONE',
    1: 'LIMITED',
    2: 'OBSERVER',
    3: 'OWNER',
  };
  function toDefaultLevel(n: unknown): JournalOwnershipDefault {
    if (typeof n !== 'number') return 'NONE';
    return LEVEL_NUM_TO_STRING[n] ?? 'NONE';
  }

  interface FoundryFolderLike {
    id?: string;
  }
  interface FoundryEmbeddedCollection {
    size?: number;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    folder?: FoundryFolderLike | null;
    pages?: FoundryEmbeddedCollection | null;
    ownership?: Record<string, number> | null;
  }
  interface FoundryJournalCollection {
    contents?: FoundryJournalEntryLike[];
  }
  interface FoundryGameForJournals {
    journal?: FoundryJournalCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForJournals }).game;
  const all = game?.journal?.contents ?? [];

  const summaries: JournalEntrySummary[] = [];
  for (const e of all) {
    if (!e || typeof e.id !== 'string') continue;
    const own = e.ownership ?? {};
    const hasOverrides = Object.keys(own).some((k) => k !== 'default');
    summaries.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : '',
      folderId: e.folder?.id ?? null,
      pageCount: typeof e.pages?.size === 'number' ? e.pages.size : 0,
      ownership: {
        default: toDefaultLevel(own.default),
        hasOverrides,
      },
    });
  }

  summaries.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));

  return { entries: summaries };
}
