/**
 * page.evaluate body for search_compendium. Two-stage filter pass:
 *
 *   Stage A — Widened index. For each pack visited, call
 *     pack.getIndex({ fields: [...] }) with the paths the active
 *     filters reach. Foundry v14 projects those fields onto the
 *     index entries inline (entry.system.{...}), so name / type /
 *     level / traits / rarity / source filtering all happen on the
 *     bulk index call — no per-document fetch.
 *
 *   Stage B — Full-doc descriptionMatch fallback. Only runs when the
 *     caller specified `descriptionMatch`, and only over entries that
 *     survived Stage A. Loads each survivor via pack.getDocument(id)
 *     and runs a case-insensitive substring search across the
 *     description paths PF2e uses for each document type.
 *
 * Performance (probed on PF2e 8.1.2 / Foundry v14.361,
 * scripts/probe-compendium-warm-timing.mjs, cold cache):
 *   - Cold widened getIndex (single pack, no contention): ~240 ms for
 *     a 106-entry pack; scales roughly linearly with entry count.
 *   - Cold widened getIndex (all 90 packs in parallel): Foundry
 *     serializes server-side, so the largest pack
 *     (5636-entry equipment-srd) measures ~26 s; smallest finishes in
 *     ~500 ms. Total wall clock ≈ slowest pack.
 *   - Cold descriptionMatch per doc: ~92 ms with chunk-16 parallelism
 *     (Foundry is the bottleneck, so chunk-8 measured identically);
 *     ~276 ms serial. The session-start warm in
 *     src/browser/warm-compendium-cache.ts pre-populates Foundry's
 *     internal getDocument cache for the configured allowlist of packs
 *     (default: pf2e.pathfinder-monster-core), making subsequent
 *     descriptionMatch queries over those packs instant. Foundry's
 *     internal cache (not ours) is what holds the docs once loaded;
 *     we just call getDocument to warm it.
 *
 * So a query like "creatures level 2-8 with 'forest' in description"
 * across all bestiaries with the warm enabled costs roughly:
 *   - Stage A: ~1-2 s (warmed packs hit Foundry's index cache)
 *   - Stage B: ~0 s for warmed packs, ~90 ms × surviving entries for
 *     non-warmed packs (cost paid once per pack per session).
 *
 * Description-field paths (probed per doc type):
 *   - Items: system.description.value
 *   - NPCs:  system.details.publicNotes
 *   - Hazards: system.details.description
 *   - JournalEntry: pages[].text.content
 * Familiars don't carry their own description (it's master-derived).
 *
 * As with other evaluators, this function is shipped to the browser
 * as a serialized source string by Puppeteer — module-scope helpers
 * and outer closures are NOT available, so every utility is inlined.
 */
export interface SearchCompendiumLevelFilter {
  min?: number | undefined;
  max?: number | undefined;
}

export interface SearchCompendiumInput {
  query?: string | undefined;
  pack?: string | undefined;
  packs?: string[] | undefined;
  type?: string | undefined;
  level?: SearchCompendiumLevelFilter | undefined;
  traits?: string[] | undefined;
  rarity?: 'common' | 'uncommon' | 'rare' | 'unique' | undefined;
  source?: string[] | undefined;
  actorType?: string | undefined;
  itemType?: string | undefined;
  descriptionMatch?: string | undefined;
  limit: number;
}

export interface CompendiumHit {
  id: string;
  uuid: string;
  name: string;
  type: string;
  pack: string;
  packLabel: string;
  img: string | null;
  level: number | null;
  traits: string[];
  rarity: 'common' | 'uncommon' | 'rare' | 'unique' | null;
  source: string | null;
  description?: string;
  descriptionText?: string;
  descriptionMatchExcerpt?: string;
}

export interface SearchCompendiumResult {
  total: number;
  returned: number;
  results: CompendiumHit[];
  query?: string;
}

interface FoundryPackMetadata {
  label?: string;
}

interface FoundryIndexEntry {
  _id?: string;
  name?: string;
  type?: string;
  img?: string;
  uuid?: string;
  system?: Record<string, unknown>;
}

interface FoundryCompendium {
  collection: string;
  documentName: string;
  metadata?: FoundryPackMetadata;
  title?: string;
  getIndex(options?: { fields?: string[] }): Promise<{ contents: FoundryIndexEntry[] }>;
  getDocument(id: string): Promise<unknown>;
}

interface FoundryGameForSearch {
  packs?: Iterable<FoundryCompendium>;
}

export async function searchCompendiumBody(
  input: SearchCompendiumInput,
): Promise<SearchCompendiumResult> {
  const game = (globalThis as unknown as { game?: FoundryGameForSearch }).game;
  const allPacks = game?.packs ? Array.from(game.packs) : [];

  const wantQuery = typeof input.query === 'string' ? input.query.toLowerCase() : null;
  const wantType = input.type ?? null;
  const wantPackSingle = input.pack ?? null;
  const wantPacks = Array.isArray(input.packs) && input.packs.length > 0
    ? new Set(input.packs)
    : null;
  const wantActorType = input.actorType ?? null;
  const wantItemType = input.itemType ?? null;
  const levelMin = input.level?.min ?? null;
  const levelMax = input.level?.max ?? null;
  const wantTraits = Array.isArray(input.traits) && input.traits.length > 0
    ? input.traits.map((t) => t.toLowerCase())
    : null;
  const wantRarity = input.rarity ?? null;
  const wantSources = Array.isArray(input.source) && input.source.length > 0
    ? input.source.map((s) => s.toLowerCase())
    : null;
  const wantDescMatch =
    typeof input.descriptionMatch === 'string' && input.descriptionMatch.length > 0
      ? input.descriptionMatch.toLowerCase()
      : null;

  // Always widen the index with these paths. Cheap enough that the
  // simplification of unconditional widening beats the perf savings
  // of conditional widening, and it lets every hit carry level /
  // traits / rarity / source for free.
  const widenedFields = [
    'system.details.level.value',
    'system.level.value',
    'system.traits.value',
    'system.traits.rarity',
    'system.details.publication.title',
    'system.publication.title',
  ];

  // Inlined utilities — evaluator scope only.
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const extractLevel = (system: Record<string, unknown> | undefined): number | null => {
    const sys = (system ?? {}) as {
      details?: { level?: { value?: unknown } };
      level?: { value?: unknown };
    };
    return num(sys.details?.level?.value) ?? num(sys.level?.value);
  };
  const extractTraits = (system: Record<string, unknown> | undefined): string[] => {
    const sys = (system ?? {}) as { traits?: { value?: unknown } };
    return arr(sys.traits?.value).filter((t): t is string => typeof t === 'string');
  };
  const extractRarity = (
    system: Record<string, unknown> | undefined,
  ): 'common' | 'uncommon' | 'rare' | 'unique' | null => {
    const sys = (system ?? {}) as { traits?: { rarity?: unknown } };
    const r = sys.traits?.rarity;
    if (r === 'common' || r === 'uncommon' || r === 'rare' || r === 'unique') return r;
    return null;
  };
  const extractSource = (system: Record<string, unknown> | undefined): string | null => {
    const sys = (system ?? {}) as {
      publication?: { title?: unknown };
      details?: { publication?: { title?: unknown } };
    };
    const t = str(sys.publication?.title) || str(sys.details?.publication?.title);
    return t.length > 0 ? t : null;
  };

  // Pull plain text out of an HTML string using the DOM. Used for
  // description matching and for the excerpt returned to the caller.
  const plainText = (html: unknown): string => {
    if (typeof html !== 'string' || html.length === 0) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  // Best-effort HTML body extraction across the document shapes we
  // see. Returns the raw HTML string (or '' if absent).
  const rawDescription = (doc: unknown): string => {
    const d = doc as {
      system?: {
        description?: { value?: unknown };
        details?: { publicNotes?: unknown; description?: unknown; appearance?: unknown };
      };
      pages?: Iterable<{ text?: { content?: unknown } }>;
    };
    const candidates: unknown[] = [
      d?.system?.description?.value,
      d?.system?.details?.publicNotes,
      d?.system?.details?.description,
      d?.system?.details?.appearance,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    if (d?.pages) {
      for (const page of d.pages) {
        const c = page.text?.content;
        if (typeof c === 'string' && c.length > 0) return c;
      }
    }
    return '';
  };

  const truncate = (s: string, n: number): string =>
    s.length > n ? `${s.slice(0, n - 3)}...` : s;

  const excerpt = (text: string, hitIdx: number, window = 80): string => {
    if (text.length === 0) return '';
    const half = Math.floor(window / 2);
    const start = Math.max(0, hitIdx - half);
    const end = Math.min(text.length, hitIdx + half);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    return `${prefix}${text.slice(start, end)}${suffix}`;
  };

  const hits: CompendiumHit[] = [];
  let totalMatches = 0;

  for (const pack of allPacks) {
    if (wantType !== null && pack.documentName !== wantType) continue;
    if (wantPackSingle !== null && pack.collection !== wantPackSingle) continue;
    if (wantPacks !== null && !wantPacks.has(pack.collection)) continue;

    // Cheap pack-level type narrowing — actorType only applies to
    // Actor packs, itemType only to Item packs. Skip mismatched packs
    // entirely.
    if (wantActorType !== null && pack.documentName !== 'Actor') continue;
    if (wantItemType !== null && pack.documentName !== 'Item') continue;

    let index;
    try {
      index = await pack.getIndex({ fields: widenedFields });
    } catch {
      continue;
    }

    // Stage A: widened-index filters. Collect entries that pass; we
    // run descriptionMatch in Stage B over the survivor list.
    const survivors: Array<{ entry: FoundryIndexEntry; level: number | null; traits: string[]; rarity: 'common' | 'uncommon' | 'rare' | 'unique' | null; source: string | null }> = [];
    for (const entry of index.contents) {
      if (!entry.name || !entry._id) continue;

      // Name substring.
      if (wantQuery !== null && !entry.name.toLowerCase().includes(wantQuery)) continue;

      // Doc type narrowing.
      const entryType = entry.type ?? pack.documentName;
      if (wantActorType !== null && entryType !== wantActorType) continue;
      if (wantItemType !== null && entryType !== wantItemType) continue;

      const lvl = extractLevel(entry.system);
      if (levelMin !== null && (lvl === null || lvl < levelMin)) continue;
      if (levelMax !== null && (lvl === null || lvl > levelMax)) continue;

      const traits = extractTraits(entry.system);
      if (wantTraits !== null) {
        const lower = traits.map((t) => t.toLowerCase());
        const intersects = wantTraits.some((wt) => lower.includes(wt));
        if (!intersects) continue;
      }

      const rarity = extractRarity(entry.system);
      if (wantRarity !== null && rarity !== wantRarity) continue;

      const source = extractSource(entry.system);
      if (wantSources !== null) {
        if (source === null) continue;
        const sLower = source.toLowerCase();
        const matches = wantSources.some((ws) => sLower.includes(ws));
        if (!matches) continue;
      }

      survivors.push({ entry, level: lvl, traits, rarity, source });
    }

    // Stage B: descriptionMatch fallback over survivors. Only runs
    // when the caller asked — otherwise we never touch getDocument.
    // Chunked-parallel for throughput; serial per-doc loading runs
    // ~500 ms per doc on WSL, while a chunk of 16 parallel loads
    // finishes in roughly that same window. Early-stops once the
    // limit is met — `total` then under-counts the true match pool
    // for the unsatisfied tail.
    if (wantDescMatch !== null) {
      const chunkSize = 16;
      let stopped = false;
      for (let i = 0; i < survivors.length && !stopped; i += chunkSize) {
        const chunk = survivors.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(
          chunk.map(async (s) => {
            try {
              const doc = await pack.getDocument(s.entry._id!);
              const descRaw = rawDescription(doc);
              const descPlain = plainText(descRaw);
              const hitIdx = descPlain.toLowerCase().indexOf(wantDescMatch);
              if (hitIdx < 0) return null;
              return { s, descRaw, descPlain, hitIdx };
            } catch {
              return null;
            }
          }),
        );
        for (const r of chunkResults) {
          if (r === null) continue;
          totalMatches += 1;
          if (hits.length >= input.limit) continue;
          const entryType = r.s.entry.type ?? pack.documentName;
          hits.push({
            id: r.s.entry._id!,
            uuid:
              r.s.entry.uuid ??
              `Compendium.${pack.collection}.${pack.documentName}.${r.s.entry._id!}`,
            name: r.s.entry.name!,
            type: entryType,
            pack: pack.collection,
            packLabel: pack.metadata?.label ?? pack.title ?? pack.collection,
            img: r.s.entry.img ?? null,
            level: r.s.level,
            traits: r.s.traits,
            rarity: r.s.rarity,
            source: r.s.source,
            description: truncate(r.descRaw, 400),
            descriptionText: truncate(r.descPlain, 400),
            descriptionMatchExcerpt: excerpt(r.descPlain, r.hitIdx),
          });
        }
        if (hits.length >= input.limit) stopped = true;
      }
    } else {
      // No descriptionMatch — survivors are the hits.
      for (const s of survivors) {
        totalMatches += 1;
        if (hits.length >= input.limit) continue;
        const entryType = s.entry.type ?? pack.documentName;
        hits.push({
          id: s.entry._id!,
          uuid:
            s.entry.uuid ??
            `Compendium.${pack.collection}.${pack.documentName}.${s.entry._id!}`,
          name: s.entry.name!,
          type: entryType,
          pack: pack.collection,
          packLabel: pack.metadata?.label ?? pack.title ?? pack.collection,
          img: s.entry.img ?? null,
          level: s.level,
          traits: s.traits,
          rarity: s.rarity,
          source: s.source,
        });
      }
    }
  }

  return {
    total: totalMatches,
    returned: hits.length,
    results: hits,
    ...(input.query !== undefined ? { query: input.query } : {}),
  };
}
