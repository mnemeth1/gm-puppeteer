/**
 * Probe: D&D 5e compendium JournalEntry page structure + end-to-end exercise
 * of the `dnd5e_search_rules` evaluator.
 *
 * Read-only — `getIndex` / `getDocument` only, no mutation, no teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-search-rules.mjs
 *
 * C1  Characterize JournalEntry compendium packs: collection list, whether
 *     `getIndex()` projects `pages[]` (it does not), page-type histogram.
 * S1  query "grappled" → the "Grappled" rule page, matchField page.name,
 *     pageText carrying the rule prose.
 * S2  pageTypes: ["rule"] → every hit is a rule page.
 * S3  A broad query yields at least one body-only (page.text) match.
 * S4  packs filter scopes hits to one pack.
 * S5  limit cap → truncated flag set, hitCount === limit.
 * S6  A nonsense query → zero hits.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { dnd5eSearchRulesBody } from '../dist/evaluators/dnd5e-search-rules.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    log.info({ detail }, `PASS — ${name}`);
  } else {
    failures += 1;
    log.error({ detail }, `FAIL — ${name}`);
  }
};

try {
  const { page } = await session.ensureStarted();
  const run = (input) => page.evaluate(dnd5eSearchRulesBody, input);

  // C1 — characterize the JournalEntry compendium packs.
  const c1 = await page.evaluate(async () => {
    const out = { packs: [], indexHasPages: null, pageTypeHistogram: {} };
    const jPacks = game.packs.filter((p) => p.metadata.type === 'JournalEntry');
    for (const p of jPacks) {
      out.packs.push({ collection: p.collection, label: p.metadata.label });
    }
    if (jPacks[0]) {
      const idx = await jPacks[0].getIndex();
      out.indexHasPages = Array.isArray(idx.contents[0]?.pages);
      for (const p of jPacks) {
        const i = await p.getIndex();
        for (const e of i.contents) {
          const doc = await p.getDocument(e._id);
          for (const pg of doc.pages ?? []) {
            out.pageTypeHistogram[pg.type] = (out.pageTypeHistogram[pg.type] ?? 0) + 1;
          }
        }
      }
    }
    return out;
  });
  check(
    'C1 JournalEntry packs found, getIndex omits pages[]',
    c1.packs.length > 0 && c1.indexHasPages === false,
    c1,
  );

  // S1 — locate a rule by page name.
  const s1 = await run({ query: 'grappled', limit: 20 });
  const grappled = s1.ok && s1.hits.find((h) => /^grappled$/i.test(h.pageName));
  check(
    'S1 "grappled" finds the Grappled rule page',
    !!grappled && grappled.matchField === 'page.name' && grappled.pageText.length > 0,
    grappled
      ? {
          pageName: grappled.pageName,
          pageType: grappled.pageType,
          pack: grappled.pack,
          pageUuid: grappled.pageUuid,
        }
      : { hitCount: s1.hitCount },
  );

  // S2 — pageTypes scope.
  const s2 = await run({ query: 'grappled', pageTypes: ['rule'], limit: 50 });
  check(
    'S2 pageTypes:["rule"] returns only rule pages',
    s2.ok && s2.hitCount > 0 && s2.hits.every((h) => h.pageType === 'rule'),
    { hitCount: s2.ok ? s2.hitCount : null },
  );

  // S3 — a broad query produces at least one body-only match.
  const s3 = await run({ query: 'damage', limit: 100 });
  check(
    'S3 broad query yields a page.text match',
    s3.ok && s3.hits.some((h) => h.matchField === 'page.text'),
    {
      hitCount: s3.ok ? s3.hitCount : null,
      fields: s3.ok ? [...new Set(s3.hits.map((h) => h.matchField))] : null,
    },
  );

  // S4 — packs filter.
  const s4 = await run({ query: 'grappled', packs: ['dnd5e.content24'], limit: 50 });
  check(
    'S4 packs filter scopes hits to one pack',
    s4.ok && s4.hitCount > 0 && s4.hits.every((h) => h.pack === 'dnd5e.content24'),
    { hitCount: s4.ok ? s4.hitCount : null },
  );

  // S5 — limit cap and truncated flag.
  const s5 = await run({ query: 'the', limit: 5 });
  check(
    'S5 limit caps results and sets truncated',
    s5.ok && s5.hitCount === 5 && s5.truncated === true,
    { hitCount: s5.ok ? s5.hitCount : null, truncated: s5.ok ? s5.truncated : null },
  );

  // S6 — nonsense query.
  const s6 = await run({ query: 'zzqxnonexistentruletoken', limit: 10 });
  check('S6 nonsense query returns zero hits', s6.ok && s6.hitCount === 0, {
    hitCount: s6.ok ? s6.hitCount : null,
    scannedPages: s6.ok ? s6.scannedPages : null,
  });

  if (failures > 0) {
    log.error({ failures }, 'probe completed with failures');
    process.exitCode = 1;
  } else {
    log.info('probe completed — all scenarios passed');
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
