/**
 * Probe for the adaptive compendium-cache warm.
 *
 * Read-only — `getIndex` / `getDocument` only, no mutation.
 *
 *   npm run build && node scripts/probe-compendium-warm-timing.mjs
 *
 * The probe disables the session's own background warm
 * (`warmCompendiumOnStart = false`) so its timings are not contended by the
 * warm running concurrently.
 *
 * Q1  getIndex caching — `pack.getIndex({fields})` and plain `getIndex()`:
 *     cold cost vs a re-request with the identical argument.
 * Q2  Pack selection — collect the installed-pack inventory and run the real
 *     `selectWarmPacks` (imported from dist) at the default 1500-doc budget.
 * Q3  Warm timing — warm each selected pack in its own page.evaluate (the
 *     shape the real warm uses), report per-pack and total wall-clock, then
 *     re-`getDocument` one warmed id to confirm it is ~instant.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { selectWarmPacks } from '../dist/browser/warm-compendium-cache.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
config.warmCompendiumOnStart = false; // probe controls warm timing itself
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  // --- Q1 — getIndex caching ----------------------------------------------
  const q1 = await page.evaluate(async () => {
    const pack = Array.from(globalThis.game.packs).find((p) => p.documentName === 'Item');
    const time = async (fn) => {
      const t = performance.now();
      await fn();
      return +(performance.now() - t).toFixed(1);
    };
    return {
      pack: pack.collection,
      plain1_ms: await time(() => pack.getIndex()),
      plain2_ms: await time(() => pack.getIndex()),
      fields1_ms: await time(() => pack.getIndex({ fields: ['system.source'] })),
      fields2_ms: await time(() => pack.getIndex({ fields: ['system.source'] })),
    };
  });
  log.info(q1, 'Q1 — getIndex caching (re-request with identical arg should be ~0)');

  // --- Q2 — pack selection -------------------------------------------------
  const inventory = await page.evaluate(() =>
    Array.from(globalThis.game.packs).map((p) => ({
      collection: p.collection,
      documentType: p.documentName,
      size: typeof p.index?.size === 'number' ? p.index.size : 0,
    })),
  );
  const selection = selectWarmPacks(inventory, { budget: 1500, override: [] });
  log.info(
    {
      mode: selection.mode,
      cumulativeDocs: selection.cumulativeDocs,
      admitted: selection.collections,
      skipped: selection.decisions
        .filter((d) => !d.admitted)
        .map((d) => `${d.collection}:${d.reason}`),
    },
    'Q2 — selectWarmPacks @ budget 1500',
  );

  // --- Q3 — warm timing (per-pack page.evaluate, as the real warm does) ---
  const warmStart = Date.now();
  let totalDocs = 0;
  let firstWarmed = null;
  for (const collection of selection.collections) {
    const r = await page.evaluate(
      async ({ collection, chunkSize }) => {
        const pack = globalThis.game.packs.get(collection);
        const t = performance.now();
        const ids = (await pack.getIndex()).contents.map((e) => e._id).filter(Boolean);
        let docs = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const res = await Promise.allSettled(chunk.map((id) => pack.getDocument(id)));
          docs += res.filter((x) => x.status === 'fulfilled' && x.value).length;
        }
        return { docs, ms: +(performance.now() - t).toFixed(1), firstId: ids[0] ?? null };
      },
      { collection, chunkSize: 16 },
    );
    totalDocs += r.docs;
    if (!firstWarmed && r.firstId) firstWarmed = { collection, id: r.firstId };
    log.info({ collection, docs: r.docs, ms: r.ms }, 'Q3 — pack warmed');
  }
  log.info({ totalDocs, totalMs: Date.now() - warmStart }, 'Q3 — warm complete');

  // getDocument cache check — a warmed id should re-load ~instantly.
  if (firstWarmed) {
    const reGetMs = await page.evaluate(async ({ collection, id }) => {
      const t = performance.now();
      await globalThis.game.packs.get(collection).getDocument(id);
      return +(performance.now() - t).toFixed(1);
    }, firstWarmed);
    log.info({ ...firstWarmed, reGetMs }, 'Q3 — getDocument re-load (should be ~0)');
  }

  log.info('probe complete');
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
