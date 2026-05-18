/**
 * page.evaluate body for `dnd5e_search_rules` — page-level full-text search
 * across compendium JournalEntry packs. The compendium analogue of
 * `search_journals` (which only covers *world* journals).
 *
 * Why this exists: the D&D 5e rules glossary is page-structured. A condition
 * like "Grappled" is a `JournalEntryPage` named "Grappled" inside the entry
 * "Appendix C: Rules Glossary" — not an entry of its own. `dnd5e_search_
 * compendium` matches entry names and entry-level description bodies, so it
 * cannot locate a rule by name. This tool searches page names and page
 * bodies directly.
 *
 * Probed live (dnd5e 5.3.3 / Foundry v14.361):
 *   - `pack.getIndex()` does NOT project `pages[]` for JournalEntry packs —
 *     the index entry carries only `_id, uuid, name, sort, folder, img`. To
 *     reach pages the scan must `pack.getDocument(entryId)` on every entry.
 *     Counts are small (~150 entries across the SRD / 2024 / PHB packs); the
 *     getDocument loads run chunked-parallel.
 *   - Page types: `text`, `rule`, `image`, `spells`, `subclass`, `class`.
 *     `rule` is the glossary page type (conditions, areas of effect, …).
 *   - Searchable body per page type:
 *       text, rule              → `page.text.content` (HTML)
 *       spells, subclass, class → `page.system.description.value` (HTML)
 *       image, pdf, video       → no body; name-only.
 *
 * No dedup: a rule recurs across the SRD / 2024 / PHB packs by design (like
 * a spell in `dnd5e.spells` and `dnd5e.spells24`). Every hit carries `pack`;
 * callers narrow with the `packs` filter.
 *
 * Serialized via `page.evaluate` — all helpers inlined, no module-scope
 * closure. Exported types are erased at runtime and may live at module scope.
 */
export interface Dnd5eSearchRulesInput {
  query: string;
  packs?: string[] | undefined;
  pageTypes?: string[] | undefined;
  limit?: number | undefined;
  snippetLength?: number | undefined;
}

export type Dnd5eRulesMatchField = 'page.name' | 'page.text';

export interface Dnd5eRulesHit {
  pack: string;
  packLabel: string;
  entryId: string;
  entryName: string;
  entryUuid: string;
  pageId: string;
  pageName: string;
  pageUuid: string;
  pageType: string;
  matchField: Dnd5eRulesMatchField;
  snippet: string;
  pageText: string;
}

export interface Dnd5eSearchRulesOk {
  ok: true;
  query: string;
  hitCount: number;
  hits: Dnd5eRulesHit[];
  scannedPacks: number;
  scannedEntries: number;
  scannedPages: number;
  truncated: boolean;
}

export interface Dnd5eSearchRulesErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eSearchRulesResult = Dnd5eSearchRulesOk | Dnd5eSearchRulesErr;

interface FoundryPageText {
  content?: string | null;
}
interface FoundryPageSystem {
  description?: { value?: string | null } | null;
}
interface FoundryJournalPage {
  id?: string;
  name?: string;
  type?: string;
  uuid?: string;
  text?: FoundryPageText | null;
  system?: FoundryPageSystem | null;
}
interface FoundryJournalEntryDoc {
  _id?: string;
  id?: string;
  name?: string;
  uuid?: string;
  pages?: Iterable<FoundryJournalPage> | null;
}
interface FoundryIndexEntry {
  _id?: string;
}
interface FoundryJournalPack {
  collection: string;
  documentName: string;
  metadata?: { label?: string };
  title?: string;
  getIndex(): Promise<{ contents: FoundryIndexEntry[] }>;
  getDocument(id: string): Promise<FoundryJournalEntryDoc | null>;
}
interface BrowserGlobals {
  game?: { packs?: Iterable<FoundryJournalPack> };
}

export async function dnd5eSearchRulesBody(
  input: Dnd5eSearchRulesInput,
): Promise<Dnd5eSearchRulesResult> {
  const query = (input.query ?? '').trim();
  if (query.length === 0) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Query must be a non-empty string.' },
    };
  }
  const queryLower = query.toLowerCase();
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 20;
  const snippetLength =
    typeof input.snippetLength === 'number' && input.snippetLength >= 40
      ? Math.floor(input.snippetLength)
      : 240;
  const PAGE_TEXT_CAP = 2000;

  const wantPacks =
    Array.isArray(input.packs) && input.packs.length > 0 ? new Set(input.packs) : null;
  const wantPageTypes =
    Array.isArray(input.pageTypes) && input.pageTypes.length > 0 ? new Set(input.pageTypes) : null;

  // ---- Inlined helpers — evaluator scope only. ---------------------------
  // Strip HTML to prose via the DOM, collapse whitespace.
  const plainText = (html: unknown): string => {
    if (typeof html !== 'string' || html.length === 0) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  // Window `snippetLength` chars around the first match; ellipsize the cut
  // edges. Falls back to a head slice when the query is not present.
  const buildSnippet = (haystack: string): string => {
    const collapsed = haystack.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return '';
    const idx = collapsed.toLowerCase().indexOf(queryLower);
    if (idx < 0) return truncate(collapsed, snippetLength);
    const half = Math.floor(snippetLength / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(collapsed.length, start + snippetLength);
    let snip = collapsed.slice(start, end);
    if (start > 0) snip = `…${snip}`;
    if (end < collapsed.length) snip = `${snip}…`;
    return snip;
  };

  // Best-effort raw HTML body for a page, by page type.
  const pageBodyHtml = (page: FoundryJournalPage): string => {
    const fromText = page.text?.content;
    if (typeof fromText === 'string' && fromText.length > 0) return fromText;
    const fromSystem = page.system?.description?.value;
    if (typeof fromSystem === 'string' && fromSystem.length > 0) return fromSystem;
    return '';
  };

  const globals = globalThis as unknown as BrowserGlobals;
  const allPacks = globals.game?.packs ? Array.from(globals.game.packs) : [];
  const journalPacks = allPacks.filter(
    (p) => p.documentName === 'JournalEntry' && (wantPacks === null || wantPacks.has(p.collection)),
  );

  interface RankedHit extends Dnd5eRulesHit {
    tier: number;
  }
  const ranked: RankedHit[] = [];
  let scannedEntries = 0;
  let scannedPages = 0;

  for (const pack of journalPacks) {
    const packLabel = pack.metadata?.label ?? pack.title ?? pack.collection;

    let index: { contents: FoundryIndexEntry[] };
    try {
      index = await pack.getIndex();
    } catch {
      continue;
    }
    const entryIds = index.contents
      .map((e) => e._id)
      .filter((id): id is string => typeof id === 'string');

    // Load full entries in chunked-parallel batches — getIndex does not
    // project pages, so each entry must be fetched to reach its pages.
    const chunkSize = 16;
    for (let i = 0; i < entryIds.length; i += chunkSize) {
      const chunk = entryIds.slice(i, i + chunkSize);
      const docs = await Promise.all(
        chunk.map(async (id) => {
          try {
            return await pack.getDocument(id);
          } catch {
            return null;
          }
        }),
      );

      for (const doc of docs) {
        if (!doc) continue;
        const entryId = typeof doc.id === 'string' ? doc.id : doc._id;
        if (typeof entryId !== 'string') continue;
        scannedEntries += 1;
        const entryName = typeof doc.name === 'string' ? doc.name : '';
        const entryUuid =
          typeof doc.uuid === 'string'
            ? doc.uuid
            : `Compendium.${pack.collection}.JournalEntry.${entryId}`;

        for (const page of doc.pages ?? []) {
          if (!page || typeof page.id !== 'string') continue;
          const pageType = typeof page.type === 'string' ? page.type : '';
          if (wantPageTypes !== null && !wantPageTypes.has(pageType)) continue;
          scannedPages += 1;

          const pageName = typeof page.name === 'string' ? page.name : '';
          const bodyPlain = plainText(pageBodyHtml(page));
          const nameHit = pageName.toLowerCase().includes(queryLower);
          const bodyHit = bodyPlain.toLowerCase().includes(queryLower);
          if (!nameHit && !bodyHit) continue;

          const pageUuid =
            typeof page.uuid === 'string' ? page.uuid : `${entryUuid}.JournalEntryPage.${page.id}`;
          // A page is one hit: name match outranks a body-only match.
          ranked.push({
            pack: pack.collection,
            packLabel,
            entryId,
            entryName,
            entryUuid,
            pageId: page.id,
            pageName,
            pageUuid,
            pageType,
            matchField: nameHit ? 'page.name' : 'page.text',
            snippet: nameHit ? buildSnippet(pageName) : buildSnippet(bodyPlain),
            pageText: truncate(bodyPlain, PAGE_TEXT_CAP),
            tier: nameHit ? 1 : 2,
          });
        }
      }
    }
  }

  // Tier 1 (page-name match) before Tier 2 (body-only); within a tier,
  // entry then page name, locale-aware, for deterministic output.
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const byEntry = a.entryName.localeCompare(b.entryName, undefined, { sensitivity: 'base' });
    if (byEntry !== 0) return byEntry;
    return a.pageName.localeCompare(b.pageName, undefined, { sensitivity: 'base' });
  });

  const truncated = ranked.length > limit;
  const hits: Dnd5eRulesHit[] = ranked.slice(0, limit).map((r) => ({
    pack: r.pack,
    packLabel: r.packLabel,
    entryId: r.entryId,
    entryName: r.entryName,
    entryUuid: r.entryUuid,
    pageId: r.pageId,
    pageName: r.pageName,
    pageUuid: r.pageUuid,
    pageType: r.pageType,
    matchField: r.matchField,
    snippet: r.snippet,
    pageText: r.pageText,
  }));

  return {
    ok: true,
    query,
    hitCount: hits.length,
    hits,
    scannedPacks: journalPacks.length,
    scannedEntries,
    scannedPages,
    truncated,
  };
}
