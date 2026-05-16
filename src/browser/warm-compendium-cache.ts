import type { Page } from 'puppeteer';
import type { Logger } from '../logging.js';

/**
 * Kicks off the background compendium warm and returns immediately.
 *
 * The warm exists to populate Foundry's *internal* compendium cache so
 * the user's first search_compendium query of the session is fast.
 * scripts/probe-compendium-doc-cache.mjs verified that Foundry v14 /
 * PF2e 8.1.2 already self-caches both pack.getIndex({ fields }) and
 * pack.getDocument(id) results on identity — a second call with the
 * same arguments is a no-op. So this warm does NOT maintain its own
 * Map; it just calls the same Foundry APIs that search_compendium
 * would call, getting the docs into Foundry's cache where they stay
 * for the rest of the session.
 *
 * Two phases:
 *
 *   Phase 1 — widened getIndex over every Actor + Item pack in
 *     parallel. After this, every search_compendium Stage-A call
 *     hits Foundry's index cache instead of paying the cold cost
 *     (which is ~250 ms for a small pack, up to ~25 s for the
 *     5636-entry equipment-srd on a large world). Foundry serializes
 *     these requests server-side, so the wall-clock is the cost of
 *     the slowest single pack rather than the sum.
 *
 *   Phase 2 — chunked getDocument over the configured allowlist of
 *     packs (config.warmPhase2Packs). After this, the first
 *     descriptionMatch query against any allowlisted pack returns at
 *     the speed of the in-process plain-text scan (a few ms) rather
 *     than ~90 ms × entry-count. Allowlist is intentionally narrow:
 *     warming every bestiary on a heavy-content world would take
 *     ~10 min and ~1 GB. Default is the single canonical Remastered
 *     creatures pack (~45 s, ~60 MB on the probe world).
 *
 * Diagnostics: phase milestones emit console.info tagged
 * '[gm-puppeteer:warm]'. The session's attachPageListeners forwards
 * those tags to pino-stderr at the matching level. Untagged page
 * console traffic stays at debug.
 *
 * Failure model: the warm is non-essential. If anything throws inside
 * the tab, the catch in the evaluator body records it but never
 * propagates; the .catch on the puppeteer promise swallows shutdown-
 * driven rejections (browser.close mid-warm).
 */
export function startCompendiumWarm(page: Page, log: Logger, phase2Packs: readonly string[]): void {
  void page
    .evaluate(warmCompendiumCacheBody, {
      widenedFields: [
        'system.details.level.value',
        'system.level.value',
        'system.traits.value',
        'system.traits.rarity',
        'system.details.publication.title',
        'system.publication.title',
      ],
      phase2Packs: Array.from(phase2Packs),
      phase2ChunkSize: 16,
    })
    .catch((err) => {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'compendium warm rejected (likely shutdown)',
      );
    });
}

interface WarmArgs {
  widenedFields: string[];
  phase2Packs: string[];
  phase2ChunkSize: number;
}

interface WarmResult {
  phase1Ms: number;
  phase1PackCount: number;
  phase1ErrorCount: number;
  phase2Ms: number;
  phase2PackCount: number;
  phase2DocCount: number;
  phase2ErrorCount: number;
}

/**
 * page.evaluate body. Runs inside the headless Foundry tab. Per CLAUDE.md
 * "Evaluator bodies have no outer scope" — every identifier referenced
 * here is defined within this function body or passed in via args.
 */
async function warmCompendiumCacheBody(args: WarmArgs): Promise<WarmResult> {
  interface FoundryPack {
    collection: string;
    documentName: string;
    getIndex(options?: { fields?: string[] }): Promise<{ contents: unknown[] }>;
    getDocument(id: string): Promise<unknown>;
  }
  interface FoundryGame {
    packs?: {
      get(id: string): FoundryPack | undefined;
      [Symbol.iterator](): Iterator<FoundryPack>;
    };
  }
  interface IndexEntry {
    _id?: string;
  }

  const game = (globalThis as unknown as { game?: FoundryGame }).game;
  if (!game?.packs) {
    return {
      phase1Ms: 0,
      phase1PackCount: 0,
      phase1ErrorCount: 0,
      phase2Ms: 0,
      phase2PackCount: 0,
      phase2DocCount: 0,
      phase2ErrorCount: 0,
    };
  }

  const allPacks = Array.from(game.packs);
  const candidatePacks = allPacks.filter(
    (p) => p.documentName === 'Actor' || p.documentName === 'Item',
  );

  // ====================================================================
  // Phase 1 — parallel widened getIndex over Actor + Item packs.
  // ====================================================================
  // eslint-disable-next-line no-console
  console.info(
    `[gm-puppeteer:warm] phase1 start ${JSON.stringify({
      candidatePackCount: candidatePacks.length,
    })}`,
  );

  let phase1ErrorCount = 0;
  const phase1Start = performance.now();
  await Promise.all(
    candidatePacks.map(async (pack) => {
      try {
        await pack.getIndex({ fields: args.widenedFields });
      } catch (err) {
        phase1ErrorCount += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[gm-puppeteer:warm] phase1 error ${JSON.stringify({
            collection: pack.collection,
            error: err instanceof Error ? err.message : String(err),
          })}`,
        );
      }
    }),
  );
  const phase1Ms = +(performance.now() - phase1Start).toFixed(2);

  // eslint-disable-next-line no-console
  console.info(
    `[gm-puppeteer:warm] phase1 done ${JSON.stringify({
      ms: phase1Ms,
      packCount: candidatePacks.length,
      errors: phase1ErrorCount,
    })}`,
  );

  // ====================================================================
  // Phase 2 — chunked getDocument over allowlist.
  // ====================================================================
  // eslint-disable-next-line no-console
  console.info(
    `[gm-puppeteer:warm] phase2 start ${JSON.stringify({
      allowlist: args.phase2Packs,
      chunkSize: args.phase2ChunkSize,
    })}`,
  );

  let phase2DocCount = 0;
  let phase2ErrorCount = 0;
  const phase2Start = performance.now();
  for (const collection of args.phase2Packs) {
    const pack = game.packs.get(collection);
    if (!pack) {
      phase2ErrorCount += 1;
      // eslint-disable-next-line no-console
      console.warn(`[gm-puppeteer:warm] phase2 pack not found ${JSON.stringify({ collection })}`);
      continue;
    }
    const packStart = performance.now();
    let packDocCount = 0;
    try {
      // The widened index was just populated in phase 1; ids come from
      // it cheaply. Bare getIndex (no fields) would work too, but the
      // already-built widened entries are right there.
      const idx = await pack.getIndex({ fields: args.widenedFields });
      const ids = (idx.contents as IndexEntry[])
        .map((e) => e._id)
        .filter((id): id is string => Boolean(id));

      for (let i = 0; i < ids.length; i += args.phase2ChunkSize) {
        const chunk = ids.slice(i, i + args.phase2ChunkSize);
        const results = await Promise.allSettled(chunk.map((id) => pack.getDocument(id)));
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) packDocCount += 1;
          else phase2ErrorCount += 1;
        }
      }
      phase2DocCount += packDocCount;
      // eslint-disable-next-line no-console
      console.info(
        `[gm-puppeteer:warm] phase2 pack done ${JSON.stringify({
          collection,
          docs: packDocCount,
          ms: +(performance.now() - packStart).toFixed(2),
        })}`,
      );
    } catch (err) {
      phase2ErrorCount += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[gm-puppeteer:warm] phase2 pack error ${JSON.stringify({
          collection,
          error: err instanceof Error ? err.message : String(err),
        })}`,
      );
    }
  }
  const phase2Ms = +(performance.now() - phase2Start).toFixed(2);

  // eslint-disable-next-line no-console
  console.info(
    `[gm-puppeteer:warm] phase2 done ${JSON.stringify({
      ms: phase2Ms,
      packCount: args.phase2Packs.length,
      docCount: phase2DocCount,
      errors: phase2ErrorCount,
    })}`,
  );

  return {
    phase1Ms,
    phase1PackCount: candidatePacks.length,
    phase1ErrorCount,
    phase2Ms,
    phase2PackCount: args.phase2Packs.length,
    phase2DocCount,
    phase2ErrorCount,
  };
}
