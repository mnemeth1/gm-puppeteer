/**
 * page.evaluate body for list_compendium_packs. Enumerates `game.packs`
 * (the CompendiumCollection registry) and projects the minimum
 * identifying fields a caller needs to pick a pack id for a downstream
 * tool (`search_compendium`'s `pack` / `packs` filter, etc.). NOT a
 * search-of-pack-contents view — that is `search_compendium`'s surface.
 *
 * Behavior nuances confirmed by probe against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **`collection` / `documentName` are non-empty strings.** Probed
 *    across all 95 sandbox packs: 0 missing, 0 non-string for either
 *    field. `collection` is the pack id callers pass back into
 *    `search_compendium` (e.g. `pf2e.pathfinder-bestiary`).
 *    `documentName` is the Foundry document class (`Actor`, `Item`,
 *    `JournalEntry`, `RollTable`, `Macro`; in other worlds `Scene`,
 *    `Adventure`, `Cards` may also appear).
 *
 *  - **`metadata` always present with `packageName`, `packageType`,
 *    `system`, and `label`.** All 95 sandbox packs have a metadata
 *    object exposing these as strings. `packageName` is the package
 *    the pack ships from — the system id for system-shipped packs,
 *    the module id for module packs, the world id for world packs.
 *    That makes it the right "system" column for this projection
 *    (a per-pack source label, not a per-game-system label).
 *
 *  - **`metadata.system` is the game-system id, not the source.** It
 *    equals the active system id (`pf2e` here) on every pack — also
 *    on module-shipped packs built for PF2e. So it discriminates
 *    "what system was this designed for" rather than "where does
 *    this pack come from." `packageName` is the better discriminator
 *    and is what we expose as `system`.
 *
 *  - **`metadata.label` always present on probed packs (0/95
 *    missing).** The cascade `metadata?.label ?? title ?? collection`
 *    mirrors the cascade already used by `search-compendium`'s
 *    `packLabel` projection. The fallback levels (`title`,
 *    `collection`) never fired in the probed world; they exist as
 *    defense in depth in case a future module ships a metadata
 *    object without a label.
 *
 *  - **Sort.** Output is sorted by `label` using a case-insensitive
 *    locale compare for stable ordering across calls.
 *
 *  - **Filters.** `documentType` and `system` are exact-match string
 *    filters applied with AND semantics. Either or both may be
 *    omitted. Empty/whitespace inputs match nothing — we expect the
 *    tool layer's zod schema to reject those, but the evaluator
 *    treats undefined as "no filter" only.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface ListCompendiumPacksInput {
  documentType?: string;
  system?: string;
}

export interface CompendiumPackSummary {
  id: string;
  label: string;
  system: string;
  documentType: string;
}

export interface ListCompendiumPacksResult {
  packs: CompendiumPackSummary[];
}

export function listCompendiumPacksBody(
  input: ListCompendiumPacksInput,
): ListCompendiumPacksResult {
  interface FoundryPackMetadata {
    label?: string;
    packageName?: string;
  }
  interface FoundryCompendiumLike {
    collection?: string;
    documentName?: string;
    metadata?: FoundryPackMetadata;
    title?: string;
  }
  interface FoundryGameForPacks {
    packs?: Iterable<FoundryCompendiumLike>;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForPacks }).game;
  const all = game?.packs ? Array.from(game.packs) : [];

  const wantDocumentType =
    typeof input?.documentType === 'string' ? input.documentType : null;
  const wantSystem = typeof input?.system === 'string' ? input.system : null;

  const summaries: CompendiumPackSummary[] = [];
  for (const pack of all) {
    if (!pack || typeof pack.collection !== 'string') continue;
    if (typeof pack.documentName !== 'string') continue;

    const id = pack.collection;
    const documentType = pack.documentName;

    const metaLabel =
      typeof pack.metadata?.label === 'string' && pack.metadata.label.length > 0
        ? pack.metadata.label
        : null;
    const title =
      typeof pack.title === 'string' && pack.title.length > 0 ? pack.title : null;
    const label = metaLabel ?? title ?? id;

    const packageName =
      typeof pack.metadata?.packageName === 'string' &&
      pack.metadata.packageName.length > 0
        ? pack.metadata.packageName
        : null;
    const prefix = id.includes('.') ? id.slice(0, id.indexOf('.')) : id;
    const system = packageName ?? prefix;

    if (wantDocumentType !== null && documentType !== wantDocumentType) continue;
    if (wantSystem !== null && system !== wantSystem) continue;

    summaries.push({ id, label, system, documentType });
  }

  summaries.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );

  return { packs: summaries };
}
