/**
 * page.evaluate body for get_journal_entry. Reads a single JournalEntry
 * and projects its page list (TOC) without loading any page content.
 *
 * For each page: id, name, type, format (HTML=1, MARKDOWN=2 — undefined
 * for non-text pages), sort, title.{show,level}, and a flag for whether
 * the page carries an explicit ownership override beyond the default
 * INHERIT (-1).
 *
 * Behavior confirmed by `probe-journal-phase1.mjs`:
 *
 *  - `entry.pages` is an embedded collection; `pages.contents` returns
 *    page documents with `.toObject()` available.
 *  - Page `text.format` is HTML=1 or MARKDOWN=2 (CONST.JOURNAL_ENTRY_PAGE_FORMATS).
 *  - Bare `{type:"text"}` page defaults: format=1, title.show=true,
 *    title.level=1, ownership.default=-1, sort=0.
 *  - Pages do NOT auto-increment sort on creation — every page in the
 *    same batch gets sort=0 unless explicitly assigned. Callers wanting
 *    deterministic order should use the sort field returned here to
 *    decide insertion points for create_journal_page.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface GetJournalEntryInput {
  entryId: string;
}

export interface JournalPageTOCEntry {
  id: string;
  name: string;
  type: string;
  format: number | null;
  sort: number;
  title: {
    show: boolean;
    level: number;
  };
  hasOwnershipOverride: boolean;
}

export interface GetJournalEntryOk {
  ok: true;
  entry: {
    id: string;
    name: string;
    folderId: string | null;
    pageCount: number;
  };
  pages: JournalPageTOCEntry[];
}

export interface GetJournalEntryErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type GetJournalEntryResult = GetJournalEntryOk | GetJournalEntryErr;

export function getJournalEntryBody(input: GetJournalEntryInput): GetJournalEntryResult {
  interface FoundryFolderLike {
    id?: string;
  }
  interface FoundryPageTextLike {
    format?: number;
  }
  interface FoundryPageTitleLike {
    show?: boolean;
    level?: number;
  }
  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    type?: string;
    sort?: number;
    text?: FoundryPageTextLike | null;
    title?: FoundryPageTitleLike | null;
    ownership?: Record<string, number> | null;
  }
  interface FoundryEmbeddedCollection {
    contents?: FoundryJournalPageLike[];
    size?: number;
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    folder?: FoundryFolderLike | null;
    pages?: FoundryEmbeddedCollection | null;
  }
  interface FoundryGameForJournals {
    journal?: { get(id: string): FoundryJournalEntryLike | null | undefined };
  }

  const game = (globalThis as unknown as { game?: FoundryGameForJournals }).game;
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

  const pages = entry.pages?.contents ?? [];
  const tocPages: JournalPageTOCEntry[] = [];
  for (const p of pages) {
    if (!p || typeof p.id !== 'string') continue;
    const own = p.ownership ?? {};
    // A page has an "override" when it has any key beyond `default`,
    // OR when its `default` is anything other than INHERIT (-1).
    const hasUserKeys = Object.keys(own).some((k) => k !== 'default');
    const defaultIsInherit = own.default === -1 || own.default === undefined;
    const hasOwnershipOverride = hasUserKeys || !defaultIsInherit;
    tocPages.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : '',
      type: typeof p.type === 'string' ? p.type : '',
      format: typeof p.text?.format === 'number' ? p.text.format : null,
      sort: typeof p.sort === 'number' ? p.sort : 0,
      title: {
        show: p.title?.show !== false,
        level: typeof p.title?.level === 'number' ? p.title.level : 1,
      },
      hasOwnershipOverride,
    });
  }

  // Sort by Foundry's sort field (ascending), then by name for ties —
  // matches the order Foundry's UI displays pages.
  tocPages.sort((a, b) => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    ok: true,
    entry: {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : '',
      folderId: entry.folder?.id ?? null,
      pageCount: typeof entry.pages?.size === 'number' ? entry.pages.size : tocPages.length,
    },
    pages: tocPages,
  };
}
