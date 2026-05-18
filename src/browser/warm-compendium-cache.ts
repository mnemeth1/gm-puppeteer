import type { Page } from 'puppeteer';
import type { Logger } from '../logging.js';

/**
 * Background compendium warm — kicks off after login and returns immediately.
 *
 * The warm exists to populate Foundry's *internal* document cache so the
 * user's first compendium search of the session is fast. `getDocument(id)`
 * results are retained by Foundry for the rest of the session, so warming is
 * just calling `getDocument` over the packs a search is most likely to load:
 * `descriptionMatch` body scans (`dnd5e_search_compendium` /
 * `pf2e_search_compendium`) and the wholesale per-call entry loads of
 * `dnd5e_search_rules`.
 *
 * Note what is deliberately NOT warmed: a widened `getIndex({ fields })`.
 * Probing (scripts/probe-compendium-warm-timing.mjs) found Foundry does not
 * cache `getIndex` per `fields` argument — re-requesting an identical field
 * set costs the same every time — so pre-widening the index buys nothing.
 * The base plain `getIndex()` is already built at world load.
 *
 * Pack selection adapts to whatever is installed (`selectWarmPacks`): there is
 * no hardcoded pack list. In auto mode it walks installed packs by document-
 * type priority (JournalEntry → Actor → Item → RollTable), smallest pack
 * first, admitting packs until a document-count budget is hit. An explicit
 * override list (`WARM_PHASE2_PACKS`) bypasses auto selection.
 *
 * Documents are warmed in fixed-size batches — one `page.evaluate` per batch.
 * A single evaluate over the whole selection would exceed puppeteer's
 * `protocolTimeout`; even one large pack in a single call blocks the page's
 * JS thread long enough to stall a concurrent tool call. Small batches keep
 * every round-trip short so user tool calls interleave with the warm.
 *
 * Diagnostics: the selection decision and per-pack progress are logged from
 * Node.
 *
 * Failure model: the warm is non-essential. Anything that throws is logged
 * and never propagated; the `.catch` swallows shutdown-driven rejections
 * (browser close mid-warm).
 */

/** One installed pack, as read from `pack.index.size` at world load. */
export interface WarmPackInfo {
  collection: string;
  documentType: string;
  size: number;
}

/** Per-pack admit/skip record, for diagnostics. */
export interface WarmPackDecision {
  collection: string;
  size: number;
  admitted: boolean;
  reason: 'override' | 'not-installed' | 'within-budget' | 'over-budget' | 'empty';
}

export interface WarmSelection {
  mode: 'override' | 'auto';
  /** Ordered collection ids to warm. */
  collections: string[];
  /** Sum of `size` over admitted packs. */
  cumulativeDocs: number;
  decisions: WarmPackDecision[];
}

export interface WarmSelectionOpts {
  /** Auto-mode cumulative document cap. 0 warms nothing. */
  budget: number;
  /** Explicit pack list; when non-empty, bypasses auto selection. */
  override: readonly string[];
}

// Document types worth warming, in priority order. JournalEntry first: the
// rules-glossary packs are small and `dnd5e_search_rules` loads every entry
// on every call. Packs of other types (Macro, Scene, …) are never warmed.
const TYPE_PRIORITY: Readonly<Record<string, number>> = {
  JournalEntry: 0,
  Actor: 1,
  Item: 2,
  RollTable: 3,
};

/**
 * Decide which packs to warm. Pure — no Foundry APIs — so it is unit-tested
 * directly.
 *
 * Override mode (`override` non-empty): warm exactly those collections, in
 * order; ids not present in `inventory` are recorded as `not-installed`. The
 * budget is ignored.
 *
 * Auto mode: keep only warm-relevant document types, order them by type
 * priority then smallest-pack-first, and admit packs whose `size` still fits
 * under `budget`. A pack that would overflow is skipped (`over-budget`) but
 * later, smaller packs are still considered — the budget is filled as far as
 * priority order allows.
 */
export function selectWarmPacks(
  inventory: readonly WarmPackInfo[],
  opts: WarmSelectionOpts,
): WarmSelection {
  if (opts.override.length > 0) {
    const byCollection = new Map(inventory.map((p) => [p.collection, p]));
    const decisions: WarmPackDecision[] = [];
    const collections: string[] = [];
    let cumulativeDocs = 0;
    for (const coll of opts.override) {
      const info = byCollection.get(coll);
      if (info) {
        collections.push(coll);
        cumulativeDocs += info.size;
        decisions.push({
          collection: coll,
          size: info.size,
          admitted: true,
          reason: 'override',
        });
      } else {
        decisions.push({ collection: coll, size: 0, admitted: false, reason: 'not-installed' });
      }
    }
    return { mode: 'override', collections, cumulativeDocs, decisions };
  }

  const candidates = inventory
    .filter((p) => p.documentType in TYPE_PRIORITY)
    .slice()
    .sort((a, b) => {
      const pa = TYPE_PRIORITY[a.documentType]!;
      const pb = TYPE_PRIORITY[b.documentType]!;
      if (pa !== pb) return pa - pb;
      if (a.size !== b.size) return a.size - b.size;
      return a.collection.localeCompare(b.collection);
    });

  const decisions: WarmPackDecision[] = [];
  const collections: string[] = [];
  let cumulativeDocs = 0;
  for (const p of candidates) {
    if (p.size <= 0) {
      decisions.push({ collection: p.collection, size: p.size, admitted: false, reason: 'empty' });
    } else if (cumulativeDocs + p.size <= opts.budget) {
      collections.push(p.collection);
      cumulativeDocs += p.size;
      decisions.push({
        collection: p.collection,
        size: p.size,
        admitted: true,
        reason: 'within-budget',
      });
    } else {
      decisions.push({
        collection: p.collection,
        size: p.size,
        admitted: false,
        reason: 'over-budget',
      });
    }
  }
  return { mode: 'auto', collections, cumulativeDocs, decisions };
}

/**
 * Kick off the background warm: read the installed-pack inventory, pick the
 * warm list with `selectWarmPacks`, then warm those packs inside the tab.
 * Fire-and-forget — the caller is not blocked.
 */
export function startCompendiumWarm(page: Page, log: Logger, opts: WarmSelectionOpts): void {
  void (async () => {
    const inventory = await page.evaluate(collectPackInventoryBody);
    const selection = selectWarmPacks(inventory, opts);
    log.info(
      {
        mode: selection.mode,
        warmPackCount: selection.collections.length,
        cumulativeDocs: selection.cumulativeDocs,
        budget: opts.budget,
        skipped: selection.decisions
          .filter((d) => !d.admitted)
          .map((d) => ({ collection: d.collection, size: d.size, reason: d.reason })),
      },
      'compendium warm: pack selection',
    );
    if (selection.collections.length === 0) {
      log.info('compendium warm: nothing selected to warm');
      return;
    }
    // Warm in small batches, one page.evaluate each, so the page's JS thread
    // is never monopolised long enough to stall a concurrent tool call.
    const BATCH_SIZE = 50;
    const startedAt = Date.now();
    let docCount = 0;
    let errorCount = 0;
    let warmedPackCount = 0;
    for (const collection of selection.collections) {
      const ids = await page.evaluate(listPackEntryIdsBody, collection);
      let packDocs = 0;
      let packErrs = 0;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const r = await page.evaluate(warmDocBatchBody, {
          collection,
          ids: ids.slice(i, i + BATCH_SIZE),
          chunkSize: 16,
        });
        packDocs += r.docCount;
        packErrs += r.errorCount;
      }
      docCount += packDocs;
      errorCount += packErrs;
      if (ids.length > 0) warmedPackCount += 1;
      log.debug({ collection, docs: packDocs, errors: packErrs }, 'compendium warm: pack done');
    }
    log.info(
      { warmedPackCount, docCount, errorCount, ms: Date.now() - startedAt },
      'compendium warm: done',
    );
  })().catch((err) => {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'compendium warm rejected (likely shutdown)',
    );
  });
}

/**
 * page.evaluate body — read every pack's id, document type, and indexed
 * document count. `pack.index` is built at world load, so `index.size` is
 * available without a `getIndex` round-trip.
 *
 * Per CLAUDE.md "Evaluator bodies have no outer scope" — every identifier is
 * defined within this function body.
 */
function collectPackInventoryBody(): WarmPackInfo[] {
  interface FoundryPack {
    collection: string;
    documentName: string;
    index?: { size?: number };
  }
  interface FoundryGame {
    packs?: Iterable<FoundryPack>;
  }
  const game = (globalThis as unknown as { game?: FoundryGame }).game;
  if (!game?.packs) return [];
  return Array.from(game.packs).map((p) => ({
    collection: p.collection,
    documentType: p.documentName,
    size: typeof p.index?.size === 'number' ? p.index.size : 0,
  }));
}

/**
 * page.evaluate body — return every entry id of one pack (via the base
 * `getIndex()`, which also warms that pack's index as a side effect).
 *
 * Per CLAUDE.md "Evaluator bodies have no outer scope" — every identifier is
 * defined within this function body or passed via args.
 */
async function listPackEntryIdsBody(collection: string): Promise<string[]> {
  interface FoundryPack {
    getIndex(options?: { fields?: string[] }): Promise<{ contents: { _id?: string }[] }>;
  }
  interface FoundryGame {
    packs?: { get(id: string): FoundryPack | undefined };
  }
  const pack = (globalThis as unknown as { game?: FoundryGame }).game?.packs?.get(collection);
  if (!pack) return [];
  try {
    const idx = await pack.getIndex();
    return idx.contents.map((e) => e._id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

interface WarmBatchArgs {
  collection: string;
  ids: string[];
  chunkSize: number;
}

interface WarmBatchResult {
  docCount: number;
  errorCount: number;
}

/**
 * page.evaluate body — load one batch of documents (chunked `getDocument`),
 * populating Foundry's internal document cache.
 *
 * Per CLAUDE.md "Evaluator bodies have no outer scope" — every identifier is
 * defined within this function body or passed via args.
 */
async function warmDocBatchBody(args: WarmBatchArgs): Promise<WarmBatchResult> {
  interface FoundryPack {
    getDocument(id: string): Promise<unknown>;
  }
  interface FoundryGame {
    packs?: { get(id: string): FoundryPack | undefined };
  }
  const pack = (globalThis as unknown as { game?: FoundryGame }).game?.packs?.get(args.collection);
  if (!pack) return { docCount: 0, errorCount: args.ids.length };

  let docCount = 0;
  let errorCount = 0;
  for (let i = 0; i < args.ids.length; i += args.chunkSize) {
    const chunk = args.ids.slice(i, i + args.chunkSize);
    const results = await Promise.allSettled(chunk.map((id) => pack.getDocument(id)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) docCount += 1;
      else errorCount += 1;
    }
  }
  return { docCount, errorCount };
}
