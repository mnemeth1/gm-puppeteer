/**
 * Phase 1 follow-up: confirm Foundry v14's
 * `pack.getIndex({ fields: [...] })` widens the index. If it works,
 * structured filtering can run entirely off a bulk index call without
 * per-doc loads — that decides the evaluator architecture.
 *
 *   npm run build && node scripts/probe-search-compendium-index-fields.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  // Probe a small NPC pack (Bestiary 1 has ~167 entries) and a small item
  // pack to keep timing tight while exercising both shapes.
  const result = await page.evaluate(async () => {
    const probe = async (collection, fields) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };

      const t0 = performance.now();
      const idx = await pack.getIndex({ fields });
      const t1 = performance.now();

      const entries = idx.contents.slice(0, 3).map((e) => ({
        keys: Object.keys(e),
        type: e.type ?? null,
        system: e.system ?? null,
      }));

      // Also re-call without fields to see whether the existing cached
      // index gets clobbered or merged.
      const t2 = performance.now();
      const plain = await pack.getIndex();
      const t3 = performance.now();
      const plainEntry = plain.contents[0] ? Object.keys(plain.contents[0]) : [];

      return {
        collection,
        widenedMs: Math.round(t1 - t0),
        plainMs: Math.round(t3 - t2),
        entryCount: idx.contents.length,
        widenedFirstKeys: idx.contents[0] ? Object.keys(idx.contents[0]) : [],
        plainFirstKeys: plainEntry,
        widenedSample: entries,
      };
    };

    const npcFields = [
      'system.details.level.value',
      'system.details.publication.title',
      'system.traits.value',
      'system.traits.rarity',
    ];
    const itemFields = [
      'system.level.value',
      'system.publication.title',
      'system.traits.value',
      'system.traits.rarity',
    ];

    return {
      npcSmall: await probe('pf2e.pathfinder-bestiary', npcFields),
      npcLarge: await probe('pf2e.pathfinder-monster-core', npcFields),
      itemLarge: await probe('pf2e.equipment-srd', itemFields),
    };
  });

  log.info({ result }, 'index-widening probe');
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
