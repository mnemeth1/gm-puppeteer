/**
 * Additive probe for get_journal_entry. Creates one scratch entry with
 * three pages of varying type/sort/ownership, exercises the evaluator,
 * asserts the TOC projection.
 *
 *   npm run build && node scripts/probe-get-journal-entry.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { getJournalEntryBody } from '../dist/evaluators/get-journal-entry.js';

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

  await page.evaluate(async (prefix) => {
    for (const e of (globalThis.game.journal?.contents ?? []).filter(
      (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
    )) {
      await e.delete();
    }
  }, PROBE_PREFIX);

  const startSnapshot = await page.evaluate(() => ({
    ids: (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort(),
  }));

  const setup = await page.evaluate(async (prefix) => {
    const entry = await globalThis.JournalEntry.create({
      name: `${prefix}toc`,
      pages: [
        // Out-of-order sort: third in array but smallest sort.
        {
          name: 'first by sort',
          type: 'text',
          sort: 100,
          text: { format: 1 },
        },
        {
          name: 'second by sort',
          type: 'text',
          sort: 200,
          text: { format: 2 },
          // Page-level ownership override.
          ownership: { default: 2 },
        },
        {
          name: 'third by sort',
          type: 'image',
          sort: 300,
          src: 'icons/svg/book.svg',
        },
      ],
    });
    return {
      entryId: entry.id,
      pageIds: entry.pages.contents.map((p) => p.id),
    };
  }, PROBE_PREFIX);
  log.info({ setup }, 'fixture created');

  const result = await page.evaluate(getJournalEntryBody, { entryId: setup.entryId });
  log.info({ result }, 'get_journal_entry returned');

  if (!result.ok) {
    fail('result.ok false', result);
  } else {
    if (result.entry.pageCount !== 3) fail('pageCount expected 3', result.entry);
    if (result.pages.length !== 3) fail('pages.length expected 3', result.pages);

    // Sort assertion.
    const sortedNames = result.pages.map((p) => p.name);
    if (
      sortedNames[0] !== 'first by sort' ||
      sortedNames[1] !== 'second by sort' ||
      sortedNames[2] !== 'third by sort'
    ) {
      fail('pages not sorted by sort field', { sortedNames });
    }

    // Format projection.
    const p1 = result.pages[0];
    const p2 = result.pages[1];
    const p3 = result.pages[2];
    if (p1.format !== 1) fail('p1 format expected 1 (HTML)', p1);
    if (p2.format !== 2) fail('p2 format expected 2 (MARKDOWN)', p2);
    if (p3.type !== 'image') fail('p3 type expected image', p3);

    // Ownership-override flag.
    if (p1.hasOwnershipOverride) fail('p1 should not have override', p1);
    if (!p2.hasOwnershipOverride) fail('p2 should have override (default=2)', p2);
    if (p3.hasOwnershipOverride) fail('p3 should not have override', p3);

    // Title defaults.
    if (p1.title.show !== true) fail('p1 title.show expected true', p1);
    if (p1.title.level !== 1) fail('p1 title.level expected 1', p1);
  }

  // Missing-entry path.
  const missing = await page.evaluate(getJournalEntryBody, { entryId: 'nonexistent12345' });
  if (missing.ok) fail('missing entryId expected error', missing);
  else if (missing.error.code !== 'INVALID_INPUT') fail('missing entryId error code', missing);

  const teardown = await page.evaluate(
    async (prefix, snap) => {
      for (const e of (globalThis.game.journal?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
      )) {
        await e.delete();
      }
      const liveIds = (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort();
      return { idMatch: liveIds.join(',') === snap.ids.join(',') };
    },
    PROBE_PREFIX,
    startSnapshot,
  );
  if (!teardown.idMatch) fail('teardown id-set mismatch', teardown);

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
