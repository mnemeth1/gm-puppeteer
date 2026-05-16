/**
 * page.evaluate body for search_journals. Full-text scan across world
 * journal entries and their text pages, with snippet extraction and
 * tier-based ranking.
 *
 * Why a manual scan and not Foundry's built-in `game.journal.search`?
 * The built-in search only matches `Document#name` — it found exactly 1
 * hit (the entry name) for a token also present in a page name and a
 * page body during phase 1 probing. Manual scan over 6 entries took
 * 0.1ms; scales linearly so a 1000-entry world is well under 100ms.
 *
 * Match surfaces:
 *   - entry.name              → matchField: "entry.name"
 *   - page.name (text pages)  → matchField: "page.name"
 *   - page.text.markdown OR
 *     page.text.content       → matchField: "page.text"
 *
 * Non-text page types (image/pdf/video) are matched on `page.name` only.
 *
 * Snippet construction: find the first occurrence (case-insensitive),
 * window the surrounding text to `snippetLength` chars, collapse
 * whitespace, prefix/suffix with `…` when the window was truncated.
 * For HTML page content, strip tags before snippet construction so
 * users see prose, not `<p>` markup.
 *
 * Ranking: entry.name > page.name > page.text, then by parent entry's
 * `_stats.modifiedTime` desc, then entry.name asc for determinism.
 *
 * Note: serialized via `page.evaluate`. All helpers inlined.
 */
export interface SearchJournalsInput {
  query: string;
  limit?: number | undefined;
  snippetLength?: number | undefined;
  folder?: string | undefined;
  entryId?: string | undefined;
}

export type SearchMatchField = 'entry.name' | 'page.name' | 'page.text';

export interface SearchJournalsHit {
  entryId: string;
  entryName: string;
  pageId: string | null;
  pageName: string | null;
  matchField: SearchMatchField;
  snippet: string;
}

export interface SearchJournalsOk {
  ok: true;
  query: string;
  hitCount: number;
  hits: SearchJournalsHit[];
  scannedEntries: number;
  truncated: boolean;
}

export interface SearchJournalsErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type SearchJournalsResult = SearchJournalsOk | SearchJournalsErr;

export function searchJournalsBody(input: SearchJournalsInput): SearchJournalsResult {
  const query = (input.query ?? '').trim();
  if (query.length === 0) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Query must be a non-empty string.' },
    };
  }
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 20;
  const snippetLength =
    typeof input.snippetLength === 'number' && input.snippetLength > 0
      ? Math.floor(input.snippetLength)
      : 200;
  const queryLower = query.toLowerCase();

  function stripTags(s: string): string {
    return s.replace(/<[^>]+>/g, ' ');
  }

  function buildSnippet(haystack: string): string {
    const collapsed = haystack.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return '';
    const lower = collapsed.toLowerCase();
    const idx = lower.indexOf(queryLower);
    if (idx < 0) return collapsed.slice(0, snippetLength);
    const half = Math.floor(snippetLength / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(collapsed.length, start + snippetLength);
    let snip = collapsed.slice(start, end);
    if (start > 0) snip = `…${snip}`;
    if (end < collapsed.length) snip = `${snip}…`;
    return snip;
  }

  interface FoundryFolderLike {
    id?: string;
  }
  interface FoundryStatsLike {
    modifiedTime?: number;
  }
  interface FoundryPageTextLike {
    format?: number;
    markdown?: string | null;
    content?: string | null;
  }
  interface FoundryJournalPageLike {
    id?: string;
    name?: string;
    type?: string;
    text?: FoundryPageTextLike | null;
  }
  interface FoundryEmbeddedCollection {
    contents?: FoundryJournalPageLike[];
  }
  interface FoundryJournalEntryLike {
    id?: string;
    name?: string;
    folder?: FoundryFolderLike | null;
    pages?: FoundryEmbeddedCollection | null;
    _stats?: FoundryStatsLike | null;
  }
  interface FoundryJournalCollection {
    contents?: FoundryJournalEntryLike[];
    get(id: string): FoundryJournalEntryLike | null | undefined;
  }
  interface FoundryGameForJournals {
    journal?: FoundryJournalCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForJournals }).game;
  if (!game?.journal) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Foundry game object is not ready.' },
    };
  }

  let entries: FoundryJournalEntryLike[];
  if (typeof input.entryId === 'string' && input.entryId.length > 0) {
    const single = game.journal.get(input.entryId);
    if (!single) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `No journal entry found with id "${input.entryId}".`,
          details: { reason: 'ENTRY_NOT_FOUND', entryId: input.entryId },
        },
      };
    }
    entries = [single];
  } else {
    entries = game.journal.contents ?? [];
  }

  if (typeof input.folder === 'string' && input.folder.length > 0) {
    const folderId = input.folder;
    entries = entries.filter((e) => e.folder?.id === folderId);
  }

  // Tier 1: entry.name; Tier 2: page.name; Tier 3: page.text.
  // Collect with a stable tier marker so we can sort once at the end.
  interface RankedHit extends SearchJournalsHit {
    tier: number;
    modifiedTime: number;
  }
  const ranked: RankedHit[] = [];
  let scannedEntries = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    scannedEntries += 1;
    const entryName = typeof entry.name === 'string' ? entry.name : '';
    const modifiedTime =
      typeof entry._stats?.modifiedTime === 'number' ? entry._stats.modifiedTime : 0;

    if (entryName.toLowerCase().includes(queryLower)) {
      ranked.push({
        entryId: entry.id,
        entryName,
        pageId: null,
        pageName: null,
        matchField: 'entry.name',
        snippet: buildSnippet(entryName),
        tier: 1,
        modifiedTime,
      });
    }

    for (const pg of entry.pages?.contents ?? []) {
      if (!pg || typeof pg.id !== 'string') continue;
      const pageName = typeof pg.name === 'string' ? pg.name : '';
      if (pageName.toLowerCase().includes(queryLower)) {
        ranked.push({
          entryId: entry.id,
          entryName,
          pageId: pg.id,
          pageName,
          matchField: 'page.name',
          snippet: buildSnippet(pageName),
          tier: 2,
          modifiedTime,
        });
      }
      // Only text pages have searchable body content.
      if (pg.type === 'text') {
        const md = typeof pg.text?.markdown === 'string' ? pg.text.markdown : '';
        const ct = typeof pg.text?.content === 'string' ? pg.text.content : '';
        // Prefer markdown source for snippet (cleaner); fall back to
        // tag-stripped HTML.
        const sourcePreferred = md.length > 0 ? md : stripTags(ct);
        if (sourcePreferred.toLowerCase().includes(queryLower)) {
          ranked.push({
            entryId: entry.id,
            entryName,
            pageId: pg.id,
            pageName,
            matchField: 'page.text',
            snippet: buildSnippet(sourcePreferred),
            tier: 3,
            modifiedTime,
          });
        }
      }
    }
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.modifiedTime !== b.modifiedTime) return b.modifiedTime - a.modifiedTime;
    return a.entryName.localeCompare(b.entryName, undefined, { sensitivity: 'base' });
  });

  const truncated = ranked.length > limit;
  const trimmed = ranked.slice(0, limit);
  const hits: SearchJournalsHit[] = trimmed.map((r) => ({
    entryId: r.entryId,
    entryName: r.entryName,
    pageId: r.pageId,
    pageName: r.pageName,
    matchField: r.matchField,
    snippet: r.snippet,
  }));

  return {
    ok: true,
    query,
    hitCount: hits.length,
    hits,
    scannedEntries,
    truncated,
  };
}
