/**
 * Stage 0 design-blocking probe for the compendium-cache warm strategy.
 * Measures the cost of the proposed two-phase warm against the live
 * headless Foundry so the warm budget and chunk size are chosen on
 * data, not guesses.
 *
 * Read-only. No world mutations.
 *
 * Findings expected:
 *   Q5. Phase 1 wall-clock — parallel pack.getIndex({ fields: WIDENED })
 *       over every Actor + Item pack. Report total, per-pack ms, and
 *       performance.memory delta. Expectation from plan: ~5 s total.
 *   Q6. Phase 2 chunk-size comparison — for two similarly-sized
 *       bestiary packs, time chunked getDocument at chunk 8 (Pack A)
 *       vs chunk 16 (Pack B). Cold per-pack to avoid Foundry's own
 *       internal doc cache leaking between the two tests. Decides the
 *       warm chunk size (8 vs 16).
 *   Q7. Phase 2 full-warm wall-clock — chunked getDocument at chunk 16
 *       over remaining bestiary packs (excluding Pack A and Pack B from
 *       Q6 so their cached docs don't skew the timing). Real number
 *       for the warm budget. Expectation from plan: ~30 s total across
 *       Monster Core + Bestiary 1/2/3.
 *   Q8. Memory ceiling — performance.memory.usedJSHeapSize before and
 *       after the full warm. Decision input: if delta > 150 MB, shrink
 *       phase 2 scope (warm Monster Core + Bestiary 1 only, leave 2/3
 *       lazy).
 *
 *   IMPORTANT: run AFTER restarting the MCP server, so the session is
 *   truly cold. Running probe-compendium-doc-cache.mjs first will
 *   pre-populate Foundry's internal index/doc state (if any) and the
 *   "cold" timing here will under-report.
 *
 *   npm run build && node scripts/probe-compendium-warm-timing.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const findings = [];
const errors = [];

function record(probeId, label, value) {
  findings.push({ probeId, label, value });
  log.info({ probeId, label, value }, 'finding');
}

function fail(probeId, label, ctx) {
  errors.push({ probeId, label, ctx });
  log.error({ probeId, label, ctx }, 'PROBE FAILURE');
}

// Mirror of the widened-fields array in src/evaluators/search-compendium.ts.
const WIDENED_FIELDS = [
  'system.details.level.value',
  'system.level.value',
  'system.traits.value',
  'system.traits.rarity',
  'system.details.publication.title',
  'system.publication.title',
];

try {
  const { page } = await session.ensureStarted();

  // ====================================================================
  // Inventory pass — identify Actor + Item packs and the bestiary-style
  // subset for phase-2 timing.
  // ====================================================================
  const inventory = await page.evaluate(async () => {
    const packsArr = globalThis.game?.packs ? Array.from(globalThis.game.packs) : [];
    const out = [];
    for (const pack of packsArr) {
      let total = 0;
      const typesSeen = {};
      try {
        const idx = await pack.getIndex();
        total = idx.contents.length;
        for (const e of idx.contents) {
          const t = e.type ?? '?';
          typesSeen[t] = (typesSeen[t] ?? 0) + 1;
        }
      } catch {
        // Skip packs that fail to index; they won't be warmed either.
      }
      out.push({
        collection: pack.collection,
        documentName: pack.documentName,
        total,
        typesSeen,
        locked: pack.locked ?? null,
      });
    }
    return out;
  });

  const actorPacks = inventory.filter((p) => p.documentName === 'Actor');
  const itemPacks = inventory.filter((p) => p.documentName === 'Item');
  // Working bestiary predicate for the probe — refined later from
  // probe-1's Q4 output. For timing purposes, "Actor pack with any npc
  // entries" is a fair proxy.
  const bestiaryPacks = actorPacks.filter((p) => (p.typesSeen.npc ?? 0) > 0);

  log.info(
    {
      actorPackCount: actorPacks.length,
      itemPackCount: itemPacks.length,
      bestiaryPackCount: bestiaryPacks.length,
      bestiaryCollections: bestiaryPacks.map((p) => ({
        collection: p.collection,
        total: p.total,
      })),
    },
    'inventory summary',
  );

  // Pick two similarly-sized bestiary packs for Q6. Sort by entry count,
  // pick the two whose sizes are closest. Falls back to using the same
  // pack twice with a flag if there's only one usable bestiary pack.
  let q6PackA = null;
  let q6PackB = null;
  if (bestiaryPacks.length >= 2) {
    const sorted = [...bestiaryPacks].sort((a, b) => a.total - b.total);
    let bestDelta = Infinity;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const delta = Math.abs(sorted[i].total - sorted[i + 1].total);
      // Skip very tiny packs (< 50 entries) — chunk-size diff won't show
      // a signal there.
      if (sorted[i].total < 50) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        q6PackA = sorted[i];
        q6PackB = sorted[i + 1];
      }
    }
  } else if (bestiaryPacks.length === 1) {
    q6PackA = bestiaryPacks[0];
    q6PackB = null;
  }

  log.info(
    {
      q6PackA: q6PackA ? { collection: q6PackA.collection, total: q6PackA.total } : null,
      q6PackB: q6PackB ? { collection: q6PackB.collection, total: q6PackB.total } : null,
    },
    'Q6 chunk-size comparison targets',
  );

  // ====================================================================
  // Q5. Phase 1 — parallel widened getIndex over all Actor + Item packs.
  // ====================================================================
  const phase1Collections = [
    ...actorPacks.map((p) => p.collection),
    ...itemPacks.map((p) => p.collection),
  ];

  const phase1 = await page.evaluate(
    async ({ collections, fields }) => {
      const memBefore = performance.memory?.usedJSHeapSize ?? null;
      const t0 = performance.now();
      const perPack = await Promise.all(
        collections.map(async (collection) => {
          const pack = globalThis.game.packs?.get(collection);
          if (!pack) return { collection, ms: null, entries: 0, error: 'not loaded' };
          const tA = performance.now();
          try {
            const idx = await pack.getIndex({ fields });
            const tB = performance.now();
            return {
              collection,
              ms: +(tB - tA).toFixed(2),
              entries: idx.contents.length,
            };
          } catch (err) {
            return {
              collection,
              ms: null,
              entries: 0,
              error: err?.message ?? String(err),
            };
          }
        }),
      );
      const t1 = performance.now();
      const memAfter = performance.memory?.usedJSHeapSize ?? null;
      const totalMs = +(t1 - t0).toFixed(2);
      const slowest = perPack
        .filter((p) => typeof p.ms === 'number')
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5);
      return {
        totalMs,
        packCount: collections.length,
        memBefore,
        memAfter,
        memDeltaBytes: memBefore !== null && memAfter !== null ? memAfter - memBefore : null,
        slowestFive: slowest,
        perPack,
      };
    },
    { collections: phase1Collections, fields: WIDENED_FIELDS },
  );
  record('Q5', 'phase 1 — parallel widened getIndex over Actor + Item packs', phase1);

  // ====================================================================
  // Q6. Phase 2 chunk-size comparison.
  //
  //   Pack A → chunk size 8, cold.
  //   Pack B → chunk size 16, cold.
  //   Both packs should not have had getDocument called on them yet in
  //   this session (we only ran getIndex above). Foundry's doc cache, if
  //   any, would be empty for both at this point.
  // ====================================================================
  if (q6PackA && q6PackB) {
    const q6 = await page.evaluate(
      async ({ packAColl, packBColl }) => {
        const runChunked = async (collection, chunkSize) => {
          const pack = globalThis.game.packs?.get(collection);
          if (!pack) return { collection, error: 'not loaded' };
          const idx = await pack.getIndex();
          const ids = idx.contents.map((e) => e._id).filter(Boolean);
          const memBefore = performance.memory?.usedJSHeapSize ?? null;
          const t0 = performance.now();
          let loaded = 0;
          for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const docs = await Promise.all(
              chunk.map(async (id) => {
                try {
                  return await pack.getDocument(id);
                } catch {
                  return null;
                }
              }),
            );
            loaded += docs.filter(Boolean).length;
          }
          const t1 = performance.now();
          const memAfter = performance.memory?.usedJSHeapSize ?? null;
          return {
            collection,
            chunkSize,
            entries: ids.length,
            loaded,
            ms: +(t1 - t0).toFixed(2),
            msPerDoc: +((t1 - t0) / Math.max(1, ids.length)).toFixed(2),
            memDeltaBytes:
              memBefore !== null && memAfter !== null ? memAfter - memBefore : null,
          };
        };
        const a = await runChunked(packAColl, 8);
        const b = await runChunked(packBColl, 16);
        return { packA_chunk8: a, packB_chunk16: b };
      },
      { packAColl: q6PackA.collection, packBColl: q6PackB.collection },
    );
    record('Q6', 'phase 2 chunk-size comparison (chunk 8 vs 16, different packs to keep both cold)', q6);
  } else if (q6PackA) {
    // Fallback: only one bestiary pack. Run chunk 8, then chunk 16 on
    // the same pack and flag the second as warm-cache-suspect.
    const q6 = await page.evaluate(
      async ({ packColl }) => {
        const runChunked = async (collection, chunkSize) => {
          const pack = globalThis.game.packs?.get(collection);
          if (!pack) return { collection, error: 'not loaded' };
          const idx = await pack.getIndex();
          const ids = idx.contents.map((e) => e._id).filter(Boolean);
          const t0 = performance.now();
          for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            await Promise.all(chunk.map((id) => pack.getDocument(id).catch(() => null)));
          }
          const t1 = performance.now();
          return { collection, chunkSize, entries: ids.length, ms: +(t1 - t0).toFixed(2) };
        };
        const a = await runChunked(packColl, 8);
        const b = await runChunked(packColl, 16);
        return {
          packA_chunk8: a,
          packA_chunk16_warmCacheSuspect: b,
          note: 'Only one bestiary pack available; chunk-16 run hits any internal doc cache populated by chunk-8 run. Compare with care.',
        };
      },
      { packColl: q6PackA.collection },
    );
    record('Q6', 'phase 2 chunk-size comparison — single-pack fallback', q6);
  } else {
    fail('Q6', 'no bestiary packs available — chunk-size comparison skipped', { bestiaryPacks });
  }

  // ====================================================================
  // Q7 + Q8. Phase 2 full warm (remaining bestiary packs at chunk 16).
  //
  //   Excludes Q6's Pack A and Pack B to avoid timing against Foundry's
  //   internal cache. Captures memory before/after the full warm for the
  //   ceiling estimate.
  // ====================================================================
  const q7Excluded = new Set(
    [q6PackA?.collection, q6PackB?.collection].filter(Boolean),
  );
  const q7Packs = bestiaryPacks
    .filter((p) => !q7Excluded.has(p.collection))
    .map((p) => p.collection);

  if (q7Packs.length > 0) {
    const q7 = await page.evaluate(
      async ({ collections }) => {
        const chunkSize = 16;
        const memBefore = performance.memory?.usedJSHeapSize ?? null;
        const t0 = performance.now();
        const perPack = [];
        for (const collection of collections) {
          const pack = globalThis.game.packs?.get(collection);
          if (!pack) {
            perPack.push({ collection, error: 'not loaded' });
            continue;
          }
          const idx = await pack.getIndex();
          const ids = idx.contents.map((e) => e._id).filter(Boolean);
          const tA = performance.now();
          let loaded = 0;
          for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const docs = await Promise.all(
              chunk.map((id) => pack.getDocument(id).catch(() => null)),
            );
            loaded += docs.filter(Boolean).length;
          }
          const tB = performance.now();
          perPack.push({
            collection,
            entries: ids.length,
            loaded,
            ms: +(tB - tA).toFixed(2),
          });
        }
        const t1 = performance.now();
        const memAfter = performance.memory?.usedJSHeapSize ?? null;
        return {
          totalMs: +(t1 - t0).toFixed(2),
          packCount: collections.length,
          memBefore,
          memAfter,
          memDeltaBytes:
            memBefore !== null && memAfter !== null ? memAfter - memBefore : null,
          memDeltaMB:
            memBefore !== null && memAfter !== null
              ? +((memAfter - memBefore) / 1024 / 1024).toFixed(1)
              : null,
          perPack,
        };
      },
      { collections: q7Packs },
    );
    record('Q7', 'phase 2 full warm (remaining bestiary packs, chunk 16)', q7);
    record('Q8', 'memory delta after full warm', {
      memBefore: q7.memBefore,
      memAfter: q7.memAfter,
      memDeltaBytes: q7.memDeltaBytes,
      memDeltaMB: q7.memDeltaMB,
      ceilingThresholdMB: 150,
      withinPlanCeiling: q7.memDeltaMB !== null ? q7.memDeltaMB <= 150 : null,
    });
  } else {
    fail('Q7', 'no remaining bestiary packs after Q6 exclusion — phase 2 timing skipped', {
      bestiaryPacks,
      q6Excluded: [...q7Excluded],
    });
  }

  // ====================================================================
  // Summary.
  // ====================================================================
  log.info(
    {
      findingCount: findings.length,
      errorCount: errors.length,
      errors,
    },
    'STAGE 0 warm-timing PROBE SUMMARY',
  );
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'warm-timing probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
