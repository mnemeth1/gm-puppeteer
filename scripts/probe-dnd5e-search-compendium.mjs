/**
 * Probe: end-to-end exercise of the `dnd5e_search_compendium` evaluator
 * after the rebuild onto the native dnd5e Compendium Browser engine.
 *
 * Read-only — `CompendiumBrowser.fetch` / `getDocument` only, no mutation,
 * no teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-search-compendium.mjs
 *
 * Runs the compiled evaluator (`dist/evaluators/dnd5e-search-compendium.js`)
 * inside the headless Foundry client, the same way the MCP tool handler
 * does, and asserts the new `documentClass` / `types` / `filters` schema
 * behaves. The `NO_FILTERS` guard is handler-level (src/tools/...), not part
 * of the evaluator, so it is checked there — not here.
 *
 * Scenarios:
 *   S1  Name-only search.
 *   S2  Item + range + set filter (spell level 1-3, evocation school).
 *   S3  Actor range + set filter (npc CR 1-3, large/huge).
 *   S4  Derived createFilter filter (npc movement → can fly).
 *   S5  unknownFilterKeys — a filter key invalid for the searched type.
 *   S6  Multi-type routing (spell + npc → Item and Actor packs).
 *   S7  unknownTypes — an unrecognized subtype.
 *   S8  descriptionMatch full-document body scan.
 *   S9  Source-settings respect — every hit's pack is in collateSources().
 *   S10 JournalEntry search — direct pack scan (CB.fetch excludes these).
 */
import { BrowserSession } from '../dist/browser/session.js';
import { dnd5eSearchCompendiumBody } from '../dist/evaluators/dnd5e-search-compendium.js';
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
  const run = (input) => page.evaluate(dnd5eSearchCompendiumBody, input);

  // S1 — name-only.
  const s1 = await run({ query: 'goblin', limit: 20 });
  check('S1 name search returns goblins', s1.returned > 0 && s1.results.every((r) => /goblin/i.test(r.name)), {
    total: s1.total,
    sample: s1.results.slice(0, 4).map((r) => r.name),
  });

  // S2 — Item range + set filter.
  const s2 = await run({
    documentClass: 'Item',
    types: ['spell'],
    filters: { level: { min: 1, max: 3 }, school: ['evo'] },
    limit: 100,
  });
  check('S2 evocation spells level 1-3', s2.returned > 0 && s2.results.every((r) => r.spellLevel >= 1 && r.spellLevel <= 3), {
    total: s2.total,
    sample: s2.results.slice(0, 3).map((r) => `${r.name} (L${r.spellLevel})`),
  });

  // S3 — Actor range + set filter.
  const s3 = await run({ types: ['npc'], filters: { cr: { min: 1, max: 3 }, size: ['lg', 'huge'] }, limit: 50 });
  check('S3 npc CR 1-3, large/huge', s3.returned > 0 && s3.results.every((r) => r.cr >= 1 && r.cr <= 3), {
    total: s3.total,
    sample: s3.results.slice(0, 4).map((r) => `${r.name} (CR${r.cr})`),
  });

  // S4 — derived createFilter filter.
  const s4 = await run({ types: ['npc'], filters: { movement: ['fly'] }, limit: 50 });
  check('S4 flying creatures (createFilter)', s4.returned > 0, {
    total: s4.total,
    sample: s4.results.slice(0, 4).map((r) => r.name),
  });

  // S5 — unknownFilterKeys.
  const s5 = await run({ types: ['spell'], filters: { cr: { min: 1 } }, limit: 5 });
  check('S5 cr is unknown for spells', Array.isArray(s5.unknownFilterKeys) && s5.unknownFilterKeys.includes('cr'), {
    unknownFilterKeys: s5.unknownFilterKeys,
  });

  // S6 — multi-type routing.
  const s6 = await run({ types: ['spell', 'npc'], query: 'a', limit: 100 });
  const s6Types = new Set(s6.results.map((r) => r.type));
  check('S6 multi-type routes to Item + Actor', s6Types.has('spell') && s6Types.has('npc'), {
    total: s6.total,
    types: [...s6Types],
  });

  // S7 — unknownTypes.
  const s7 = await run({ types: ['bogus-subtype'], query: 'dragon', limit: 5 });
  check('S7 bogus subtype reported', Array.isArray(s7.unknownTypes) && s7.unknownTypes.includes('bogus-subtype'), {
    unknownTypes: s7.unknownTypes,
    returned: s7.returned,
  });

  // S8 — descriptionMatch.
  const s8 = await run({ types: ['spell'], descriptionMatch: 'acid', limit: 5 });
  check(
    'S8 descriptionMatch returns excerpts',
    s8.returned > 0 && s8.results.every((r) => typeof r.descriptionMatchExcerpt === 'string'),
    { total: s8.total, sample: s8.results.slice(0, 2).map((r) => r.name) },
  );

  // S9 — source-settings respect: every returned pack is an enabled source.
  const s9 = await run({ query: 'a', limit: 100 });
  const enabledSources = await page.evaluate(() =>
    Array.from(
      globalThis.dnd5e.applications.settings.CompendiumBrowserSettingsConfig.collateSources(),
    ),
  );
  const enabledSet = new Set(enabledSources);
  check(
    'S9 every hit comes from an enabled source pack',
    s9.results.every((r) => enabledSet.has(r.pack)),
    { enabledSourceCount: enabledSet.size, hitPacks: [...new Set(s9.results.map((r) => r.pack))] },
  );

  // S10 — JournalEntry search routes through the direct pack scan, not
  // CB.fetch (whose collateSources() never includes JournalEntry packs).
  const s10 = await run({ documentClass: 'JournalEntry', query: 'a', limit: 5 });
  check(
    'S10 JournalEntry search returns rows via direct scan',
    s10.returned > 0 && s10.results.every((r) => r.type === 'JournalEntry'),
    { total: s10.total, sample: s10.results.slice(0, 3).map((r) => `${r.name} (${r.pack})`) },
  );

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
