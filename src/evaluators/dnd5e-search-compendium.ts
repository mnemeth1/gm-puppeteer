/**
 * page.evaluate body for `dnd5e_search_compendium`.
 *
 * The engine is the dnd5e system's own Compendium Browser —
 * `dnd5e.applications.CompendiumBrowser` — not a hand-rolled pack scan.
 * That class is the same machinery behind the GUI "Compendium Browser"
 * button, and it exposes a fully programmatic query path:
 *
 *   - `CompendiumBrowser.fetch(documentClass, { types, filters, indexFields })`
 *     iterates every eligible pack, builds a widened index, applies the
 *     `{ k, o, v }` filter records, and returns name-sorted index entries.
 *     It skips packs of the wrong document type, packs not visible to the
 *     user, packs the GM disabled in the browser source settings, and items
 *     nested inside containers. NOTE: `fetch` mutates the `filters` array it
 *     is handed (pushes a container-exclusion record) — pass a fresh array.
 *   - `CompendiumBrowser.applyFilters(definition, currentFilters)` converts a
 *     UI-style `{ additional: { <key>: <value> } }` object into those
 *     `{ k, o, v }` records, including derived `createFilter` filters
 *     (spell-list membership, habitat, movement, …).
 *   - `CompendiumBrowser.intersectFilters(a, b, currentFilters)` merges two
 *     type filter-definition Maps for a multi-type search.
 *   - Each data model exposes a `compendiumBrowserFilters` getter returning
 *     a `Map<key, { type, config, createFilter? }>` — the filter vocabulary
 *     for that document subtype (e.g. spell → level/school/spelllist/
 *     properties; npc → size/type/habitat/cr/movement).
 *
 * Filter value shapes accepted by `applyFilters` (`scripts/probe-dnd5e-
 * compendium-browser.mjs`):
 *   - range  → `{ min?, max? }`
 *   - set / createFilter → `{ <choiceKey>: 1 }` include, `{ <choiceKey>: -1 }`
 *     exclude
 *   - boolean → truthy, with `v: value === 1` deciding the true-vs-false
 *     match
 * This evaluator normalizes the tool's ergonomic inputs (a `{min,max}`
 * object, a `string[]`, an `{include,exclude}` object, or a `boolean`) into
 * those shapes before calling `applyFilters`.
 *
 * `fetch` returns index entries only — it does NOT load full documents — so
 * the `descriptionMatch` body scan is still a separate Stage-B step that
 * loads each survivor via `pack.getDocument(id)`.
 *
 * The Compendium Browser only covers the document classes its tabs handle —
 * Item and Actor — and `fetch` filters every pack through `collateSources()`,
 * which never includes JournalEntry or RollTable packs. So a `documentClass`
 * of "JournalEntry" or "RollTable" (rules text, lore, roll tables) CANNOT go
 * through `fetch` — it would silently return nothing. Those classes take a
 * direct `pack.getIndex()` scan instead, narrowed only by name / pack /
 * folder / descriptionMatch (they have no `compendiumBrowserFilters`).
 *
 * D&D 5e data shapes (dnd5e 5.3.3 / Foundry v14.361):
 *   - CR: `system.details.cr` — a bare number, fractions included.
 *   - Creature type: `system.details.type.value` — lowercase string.
 *   - Spell level: `system.level` — bare int 0-9 on `spell` items.
 *   - Rarity: `system.rarity` — common/uncommon/rare/veryRare/legendary/
 *     artifact (camelCase `veryRare`).
 *   - Source: `system.source` is an OBJECT; `fetch` runs `SourceField.
 *     prepareData` on it so the index entry carries a resolved `label`.
 *   - Folders: index entries carry a top-level `folder` id; the owning
 *     pack's `folders` collection resolves the id → name → parent tree.
 *     The `folder` filter matches a folder name anywhere in an entry's
 *     ancestry chain, so a parent folder name broadens recursively.
 *
 * As with every evaluator, Puppeteer ships this function to the browser as
 * a serialized source string — module-scope helpers and outer closures are
 * NOT available, so every utility is inlined inside the function body.
 * Exported types are erased at runtime and may live at module scope.
 */
export interface Dnd5eRangeFilterValue {
  min?: number | undefined;
  max?: number | undefined;
}

export interface Dnd5eSetFilterObject {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

/**
 * A single filter value. The accepted shape depends on the filter's kind:
 * range filters take `{min,max}`, set/createFilter filters take a `string[]`
 * (include-only shorthand) or an `{include,exclude}` object, boolean filters
 * take a `boolean`.
 */
export type Dnd5eFilterValue = Dnd5eRangeFilterValue | string[] | Dnd5eSetFilterObject | boolean;

export type Dnd5eDocumentClass = 'Item' | 'Actor' | 'JournalEntry' | 'RollTable';

export type Dnd5eRarity = 'common' | 'uncommon' | 'rare' | 'veryRare' | 'legendary' | 'artifact';

export interface Dnd5eSearchCompendiumInput {
  query?: string | undefined;
  documentClass?: Dnd5eDocumentClass | undefined;
  types?: string[] | undefined;
  filters?: Record<string, Dnd5eFilterValue> | undefined;
  pack?: string | undefined;
  packs?: string[] | undefined;
  folder?: string | undefined;
  descriptionMatch?: string | undefined;
  limit: number;
}

export interface Dnd5eCompendiumHit {
  id: string;
  uuid: string;
  name: string;
  type: string | null;
  pack: string;
  packLabel: string;
  img: string | null;
  cr: number | null;
  spellLevel: number | null;
  creatureType: string | null;
  rarity: Dnd5eRarity | null;
  source: string | null;
  folderPath: string | null;
  description?: string;
  descriptionText?: string;
  descriptionMatchExcerpt?: string;
}

export interface Dnd5eSearchCompendiumResult {
  total: number;
  returned: number;
  results: Dnd5eCompendiumHit[];
  query?: string;
  /** Filter keys that matched no filter definition for any searched type. */
  unknownFilterKeys?: string[];
  /** Requested `types` that are not a known Item or Actor subtype. */
  unknownTypes?: string[];
}

interface FoundryIndexEntry {
  _id?: string;
  name?: string;
  type?: string;
  img?: string;
  uuid?: string;
  folder?: string;
  system?: Record<string, unknown>;
}

interface FoundryFolder {
  id?: string;
  name?: string;
  folder?: { id?: string } | null;
}

interface FoundryPack {
  collection: string;
  documentName: string;
  metadata?: { label?: string };
  title?: string;
  folders?: Iterable<FoundryFolder>;
  getIndex(options?: { fields?: string[] }): Promise<{ contents: FoundryIndexEntry[] }>;
  getDocument(id: string): Promise<unknown>;
}

interface FilterDefEntry {
  type?: string;
  createFilter?: unknown;
  config?: { keyPath?: string; multiple?: boolean; choices?: unknown };
}

type FilterDefinition = Map<string, FilterDefEntry>;

interface CurrentFilters {
  additional: Record<string, unknown>;
  documentClass: string;
  types: Set<string>;
}

interface CompendiumBrowserClass {
  fetch(
    documentClass: unknown,
    opts: {
      types?: Set<string>;
      filters?: unknown[];
      indexFields?: Set<string>;
      index?: boolean;
      sort?: boolean;
    },
  ): Promise<FoundryIndexEntry[]>;
  applyFilters(definition: FilterDefinition, currentFilters: CurrentFilters): unknown[];
  intersectFilters(
    first: FilterDefinition,
    second: FilterDefinition,
    currentFilters: CurrentFilters,
  ): FilterDefinition;
}

interface DocumentClassConfig {
  documentClass?: unknown;
  dataModels?: Record<string, { compendiumBrowserFilters?: FilterDefinition }>;
}

interface BrowserGlobals {
  game?: { packs?: { get(id: string): FoundryPack | undefined } & Iterable<FoundryPack> };
  CONFIG?: Record<string, DocumentClassConfig>;
  dnd5e?: { applications?: { CompendiumBrowser?: CompendiumBrowserClass } };
}

export async function dnd5eSearchCompendiumBody(
  input: Dnd5eSearchCompendiumInput,
): Promise<Dnd5eSearchCompendiumResult> {
  const globals = globalThis as unknown as BrowserGlobals;
  const game = globals.game;
  const CONFIG = globals.CONFIG ?? {};
  const CB = globals.dnd5e?.applications?.CompendiumBrowser;
  if (!CB) {
    throw new Error(
      'dnd5e_search_compendium: dnd5e.applications.CompendiumBrowser is unavailable — is this a D&D 5e world?',
    );
  }

  // ---- Inlined utilities — evaluator scope only. -------------------------
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const extractRarity = (v: unknown): Dnd5eRarity | null => {
    if (
      v === 'common' ||
      v === 'uncommon' ||
      v === 'rare' ||
      v === 'veryRare' ||
      v === 'legendary' ||
      v === 'artifact'
    ) {
      return v;
    }
    return null;
  };
  const extractSource = (v: unknown): string | null => {
    if (typeof v === 'string') return v.length > 0 ? v : null;
    if (v && typeof v === 'object') {
      const obj = v as { label?: unknown; value?: unknown; book?: unknown };
      const t = str(obj.label) || str(obj.value) || str(obj.book);
      return t.length > 0 ? t : null;
    }
    return null;
  };

  // Collection id parsed out of a compendium uuid
  // ("Compendium.<collection>.<DocType>.<id>"; collection ids contain dots).
  const collectionFromUuid = (uuid: unknown): string | null => {
    if (typeof uuid !== 'string') return null;
    const parts = uuid.split('.');
    if (parts.length < 4 || parts[0] !== 'Compendium') return null;
    return parts.slice(1, -2).join('.');
  };

  // Pull plain text out of an HTML string using the DOM.
  const plainText = (html: unknown): string => {
    if (typeof html !== 'string' || html.length === 0) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  // Best-effort HTML body extraction across the dnd5e document shapes.
  const rawDescription = (doc: unknown): string => {
    const d = doc as {
      description?: unknown;
      system?: {
        description?: { value?: unknown };
        details?: { biography?: { value?: unknown } };
      };
      pages?: Iterable<{ text?: { content?: unknown } }>;
    };
    const candidates: unknown[] = [
      d?.system?.description?.value,
      d?.system?.details?.biography?.value,
      d?.description,
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

  const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

  const excerpt = (text: string, hitIdx: number, window = 80): string => {
    if (text.length === 0) return '';
    const half = Math.floor(window / 2);
    const start = Math.max(0, hitIdx - half);
    const end = Math.min(text.length, hitIdx + half);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    return `${prefix}${text.slice(start, end)}${suffix}`;
  };

  // Normalize an ergonomic tool filter value into the shape `applyFilters`
  // expects for that filter definition's kind.
  const normalizeFilterValue = (def: FilterDefEntry, value: Dnd5eFilterValue): unknown => {
    const isSet = typeof def.createFilter === 'function' || def.type === 'set';
    if (isSet) {
      const out: Record<string, number> = {};
      if (Array.isArray(value)) {
        for (const k of value) out[k] = 1;
      } else if (value && typeof value === 'object') {
        const obj = value as Dnd5eSetFilterObject;
        for (const k of obj.include ?? []) out[k] = 1;
        for (const k of obj.exclude ?? []) out[k] = -1;
      }
      return out;
    }
    if (def.type === 'range') {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    if (def.type === 'boolean') {
      // applyFilters pushes when truthy and matches `v: value === 1`, so 1
      // selects the true rows and -1 (truthy, !== 1) selects the false rows.
      return value ? 1 : -1;
    }
    return value;
  };

  // ---- Build the (documentClass, types) query plan. ----------------------
  const itemModels = CONFIG.Item?.dataModels ?? {};
  const actorModels = CONFIG.Actor?.dataModels ?? {};
  const unknownTypes: string[] = [];
  const plan: Array<{ dcName: Dnd5eDocumentClass; types: string[] }> = [];

  if (input.documentClass !== undefined) {
    plan.push({ dcName: input.documentClass, types: input.types ?? [] });
  } else if (Array.isArray(input.types) && input.types.length > 0) {
    const itemTypes: string[] = [];
    const actorTypes: string[] = [];
    for (const t of input.types) {
      if (t in itemModels) itemTypes.push(t);
      else if (t in actorModels) actorTypes.push(t);
      else unknownTypes.push(t);
    }
    if (itemTypes.length > 0) plan.push({ dcName: 'Item', types: itemTypes });
    if (actorTypes.length > 0) plan.push({ dcName: 'Actor', types: actorTypes });
    if (plan.length === 0) {
      plan.push({ dcName: 'Item', types: [] }, { dcName: 'Actor', types: [] });
    }
  } else {
    plan.push({ dcName: 'Item', types: [] }, { dcName: 'Actor', types: [] });
  }

  const wantQuery = typeof input.query === 'string' && input.query.length > 0 ? input.query : null;
  const inputFilters: Record<string, Dnd5eFilterValue> =
    input.filters && typeof input.filters === 'object' ? input.filters : {};

  // ---- Per-plan-entry search. --------------------------------------------
  // The Compendium Browser engine (`CB.fetch`) covers only the document
  // classes its tabs handle — Item and Actor — and filters every pack
  // through `collateSources()`. JournalEntry / RollTable packs are never in
  // that set, so routing those classes through `fetch` would silently
  // return nothing; they take a direct pack scan instead.
  const BROWSER_DOC_CLASSES = new Set<Dnd5eDocumentClass>(['Item', 'Actor']);
  const survivors: Array<{ entry: FoundryIndexEntry; coll: string }> = [];
  const resolvedFilterKeys = new Set<string>();
  const wantQueryLower = wantQuery !== null ? wantQuery.toLowerCase() : null;

  for (const step of plan) {
    if (BROWSER_DOC_CLASSES.has(step.dcName)) {
      const dcCfg = CONFIG[step.dcName];
      const documentClass = dcCfg?.documentClass;
      if (!documentClass) continue;
      const dataModels = dcCfg.dataModels ?? {};

      // Build the filter definition: one type → that model's Map; many →
      // intersect them; none → empty (no `additional` filters can apply).
      const currentFilters: CurrentFilters = {
        additional: {},
        documentClass: step.dcName,
        types: new Set(step.types),
      };
      const defs: FilterDefinition[] = [];
      for (const t of step.types) {
        const def = dataModels[t]?.compendiumBrowserFilters;
        if (def) defs.push(def);
      }
      let definition: FilterDefinition;
      if (defs.length === 0) definition = new Map();
      else if (defs.length === 1) definition = defs[0]!;
      else definition = defs.reduce((a, b) => CB.intersectFilters(a, b, currentFilters));

      // Normalize the tool's filters against this definition.
      const additional: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(inputFilters)) {
        const def = definition.get(key);
        if (!def) continue;
        resolvedFilterKeys.add(key);
        additional[key] = normalizeFilterValue(def, value);
      }
      currentFilters.additional = additional;

      const built = CB.applyFilters(definition, currentFilters);
      // `fetch` mutates the filters array — hand it a fresh copy.
      const filters = built.slice();
      if (wantQuery !== null) filters.push({ k: 'name', o: 'icontains', v: wantQuery });

      let docs: FoundryIndexEntry[];
      try {
        docs = await CB.fetch(documentClass, {
          types: new Set(step.types),
          filters,
          indexFields: new Set([
            'system.source',
            'system.details.cr',
            'system.details.type.value',
            'system.level',
            'system.rarity',
          ]),
        });
      } catch {
        docs = [];
      }

      for (const entry of docs) {
        if (!entry || !entry._id || !entry.name) continue;
        const coll = collectionFromUuid(entry.uuid);
        if (coll === null) continue;
        survivors.push({ entry, coll });
      }
    } else {
      // JournalEntry / RollTable — direct pack scan. These document classes
      // have no Compendium Browser filter definitions, so `filters` cannot
      // apply; only name / pack / folder / descriptionMatch narrow them.
      for (const pack of game?.packs ?? []) {
        if (pack.documentName !== step.dcName) continue;
        let index: { contents: FoundryIndexEntry[] };
        try {
          index = await pack.getIndex();
        } catch {
          continue;
        }
        for (const entry of index.contents) {
          if (!entry || !entry._id || !entry.name) continue;
          if (wantQueryLower !== null && !entry.name.toLowerCase().includes(wantQueryLower)) {
            continue;
          }
          survivors.push({ entry, coll: pack.collection });
        }
      }
    }
  }

  const unknownFilterKeys = Object.keys(inputFilters).filter((k) => !resolvedFilterKeys.has(k));

  // ---- Post-filter: pack scope + compendium-folder ancestry. -------------
  const wantPackSingle = input.pack ?? null;
  const wantPacks =
    Array.isArray(input.packs) && input.packs.length > 0 ? new Set(input.packs) : null;
  const wantFolder = typeof input.folder === 'string' ? input.folder.toLowerCase() : null;
  const wantDescMatch =
    typeof input.descriptionMatch === 'string' && input.descriptionMatch.length > 0
      ? input.descriptionMatch.toLowerCase()
      : null;

  // Per-collection cache of {pack, folder id → {name, parentId}}.
  const packCache = new Map<
    string,
    { pack: FoundryPack | null; folderMap: Map<string, { name: string; parentId: string | null }> }
  >();
  const getPackInfo = (coll: string) => {
    const cached = packCache.get(coll);
    if (cached) return cached;
    const pack = game?.packs?.get(coll) ?? null;
    const folderMap = new Map<string, { name: string; parentId: string | null }>();
    if (pack) {
      for (const f of pack.folders ?? []) {
        if (typeof f.id === 'string') {
          folderMap.set(f.id, {
            name: str(f.name),
            parentId: typeof f.folder?.id === 'string' ? f.folder.id : null,
          });
        }
      }
    }
    const info = { pack, folderMap };
    packCache.set(coll, info);
    return info;
  };
  // Walk leaf → root; returns folder names leaf-first. Cycle-guarded.
  const folderNameChain = (
    folderMap: Map<string, { name: string; parentId: string | null }>,
    folderId: string | undefined,
  ): string[] => {
    const names: string[] = [];
    let cur: string | null = typeof folderId === 'string' ? folderId : null;
    let guard = 0;
    while (cur && guard < 32) {
      guard += 1;
      const f = folderMap.get(cur);
      if (!f) break;
      names.push(f.name);
      cur = f.parentId;
    }
    return names;
  };

  const filtered: Array<{
    entry: FoundryIndexEntry;
    coll: string;
    pack: FoundryPack | null;
    folderPath: string | null;
  }> = [];
  for (const s of survivors) {
    if (wantPackSingle !== null && s.coll !== wantPackSingle) continue;
    if (wantPacks !== null && !wantPacks.has(s.coll)) continue;
    const { pack, folderMap } = getPackInfo(s.coll);
    const folderNames = folderNameChain(folderMap, s.entry.folder);
    if (wantFolder !== null && !folderNames.some((n) => n.toLowerCase() === wantFolder)) {
      continue;
    }
    const folderPath = folderNames.length > 0 ? folderNames.slice().reverse().join(' / ') : null;
    filtered.push({ entry: s.entry, coll: s.coll, pack, folderPath });
  }
  // `fetch` sorts each document-class call by name; re-sort the merged list.
  filtered.sort((a, b) => String(a.entry.name).localeCompare(String(b.entry.name)));

  const buildHit = (
    f: {
      entry: FoundryIndexEntry;
      coll: string;
      pack: FoundryPack | null;
      folderPath: string | null;
    },
    extra: Partial<
      Pick<Dnd5eCompendiumHit, 'description' | 'descriptionText' | 'descriptionMatchExcerpt'>
    >,
  ): Dnd5eCompendiumHit => {
    const e = f.entry;
    const sys = (e.system ?? {}) as {
      details?: { cr?: unknown; type?: { value?: unknown } };
      level?: unknown;
      rarity?: unknown;
      source?: unknown;
    };
    const creatureTypeRaw = str(sys.details?.type?.value);
    return {
      id: e._id!,
      uuid: e.uuid ?? `Compendium.${f.coll}.${f.pack?.documentName ?? 'Document'}.${e._id!}`,
      name: e.name!,
      type: e.type ?? f.pack?.documentName ?? null,
      pack: f.coll,
      packLabel: f.pack?.metadata?.label ?? f.pack?.title ?? f.coll,
      img: e.img ?? null,
      cr: num(sys.details?.cr),
      spellLevel: num(sys.level),
      creatureType: creatureTypeRaw.length > 0 ? creatureTypeRaw : null,
      rarity: extractRarity(sys.rarity),
      source: extractSource(sys.source),
      folderPath: f.folderPath,
      ...extra,
    };
  };

  // ---- Stage B: descriptionMatch full-document body scan. ----------------
  const hits: Dnd5eCompendiumHit[] = [];
  let total = 0;

  if (wantDescMatch !== null) {
    const chunkSize = 16;
    let stopped = false;
    for (let i = 0; i < filtered.length && !stopped; i += chunkSize) {
      const chunk = filtered.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(async (f) => {
          if (!f.pack || !f.entry._id) return null;
          try {
            const doc = await f.pack.getDocument(f.entry._id);
            const descRaw = rawDescription(doc);
            const descPlain = plainText(descRaw);
            const hitIdx = descPlain.toLowerCase().indexOf(wantDescMatch);
            if (hitIdx < 0) return null;
            return { f, descRaw, descPlain, hitIdx };
          } catch {
            return null;
          }
        }),
      );
      for (const r of chunkResults) {
        if (r === null) continue;
        total += 1;
        if (hits.length >= input.limit) continue;
        hits.push(
          buildHit(r.f, {
            description: truncate(r.descRaw, 400),
            descriptionText: truncate(r.descPlain, 400),
            descriptionMatchExcerpt: excerpt(r.descPlain, r.hitIdx),
          }),
        );
      }
      if (hits.length >= input.limit) stopped = true;
    }
  } else {
    for (const f of filtered) {
      total += 1;
      if (hits.length >= input.limit) continue;
      hits.push(buildHit(f, {}));
    }
  }

  return {
    total,
    returned: hits.length,
    results: hits,
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(unknownFilterKeys.length > 0 ? { unknownFilterKeys } : {}),
    ...(unknownTypes.length > 0 ? { unknownTypes } : {}),
  };
}
