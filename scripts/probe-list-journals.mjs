/**
 * Additive probe for list_journals. Creates two scratch entries with
 * different folder/page-count/ownership profiles, exercises the
 * evaluator, asserts projection shape, then deletes the scratch
 * entries and asserts the journal id-set matches the start snapshot.
 *
 *   npm run build && node scripts/probe-list-journals.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { listJournalsBody } from '../dist/evaluators/list-journals.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_PREFIX = '__probe_journal_';
const errors = [];

function fail(label, ctx) {
  errors.push({ label, ctx });
  log.error({ label, ctx }, 'PROBE FAILURE');
}

try {
  const { page } = await session.ensureStarted();

  // Pre-probe scrub.
  await page.evaluate(async (prefix) => {
    const entries = (globalThis.game.journal?.contents ?? []).filter(
      (e) => typeof e.name === 'string' && e.name.startsWith(prefix),
    );
    for (const e of entries) await e.delete();
  }, PROBE_PREFIX);

  const startSnapshot = await page.evaluate(() => ({
    ids: (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort(),
  }));

  // Set up: two entries — one with 0 pages and a non-default ownership,
  // one with 2 pages and default ownership.
  const setup = await page.evaluate(async (prefix) => {
    const e1 = await globalThis.JournalEntry.create({
      name: `${prefix}list_a_zero_pages`,
      ownership: { default: 2 }, // OBSERVER
    });
    const e2 = await globalThis.JournalEntry.create({
      name: `${prefix}list_b_two_pages`,
      pages: [
        { name: 'page one', type: 'text' },
        { name: 'page two', type: 'text' },
      ],
    });
    return { e1Id: e1.id, e2Id: e2.id };
  }, PROBE_PREFIX);
  log.info({ setup }, 'fixtures created');

  // Exercise.
  const result = await page.evaluate(listJournalsBody);
  log.info({ entryCount: result.entries.length }, 'list_journals returned');

  // Assertions.
  const e1 = result.entries.find((e) => e.id === setup.e1Id);
  const e2 = result.entries.find((e) => e.id === setup.e2Id);

  if (!e1) fail('e1 missing from result', { setup, sample: result.entries.slice(0, 5) });
  if (!e2) fail('e2 missing from result', { setup, sample: result.entries.slice(0, 5) });

  if (e1) {
    if (e1.name !== `${PROBE_PREFIX}list_a_zero_pages`) fail('e1 name mismatch', e1);
    if (e1.pageCount !== 0) fail('e1 pageCount expected 0', e1);
    if (e1.ownership.default !== 'OBSERVER') fail('e1 ownership.default expected OBSERVER', e1);
    if (e1.folderId !== null) fail('e1 folderId expected null', e1);
  }
  if (e2) {
    if (e2.name !== `${PROBE_PREFIX}list_b_two_pages`) fail('e2 name mismatch', e2);
    if (e2.pageCount !== 2) fail('e2 pageCount expected 2', e2);
    if (e2.ownership.default !== 'NONE') fail('e2 ownership.default expected NONE', e2);
  }

  // Sort assertion: entries are sorted by name. Locate both indices and
  // confirm a < b ordering.
  const idxA = result.entries.findIndex((e) => e.id === setup.e1Id);
  const idxB = result.entries.findIndex((e) => e.id === setup.e2Id);
  if (idxA >= 0 && idxB >= 0 && idxA > idxB) {
    fail('entries not sorted by name', { idxA, idxB });
  }

  // Teardown.
  const teardown = await page.evaluate(
    async (prefix, snap) => {
      const entries = (globalThis.game.journal?.contents ?? []).filter(
        (e) => typeof e.name === 'string' && e.name.startsWith(prefix),
      );
      for (const e of entries) await e.delete();
      const liveIds = (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort();
      return { idMatch: liveIds.join(',') === snap.ids.join(','), liveIds };
    },
    PROBE_PREFIX,
    startSnapshot,
  );
  if (!teardown.idMatch) fail('teardown id-set mismatch', teardown);
  log.info({ teardown }, 'teardown complete');

  log.info({ errorCount: errors.length, errors }, 'PROBE SUMMARY');
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
