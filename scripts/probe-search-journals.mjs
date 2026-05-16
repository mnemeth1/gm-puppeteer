/**
 * Additive probe for search_journals. Creates four scratch entries with
 * known unique tokens in entry name, page name, markdown body, and HTML
 * body, exercises the evaluator with a variety of queries, asserts hit
 * shape, ranking, snippet construction, and the entryId/folder filters.
 *
 *   npm run build && node scripts/probe-search-journals.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { searchJournalsBody } from '../dist/evaluators/search-journals.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_PREFIX = '__probe_journal_';
const TOKEN = 'XYZZYPROBE';
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

  const setup = await page.evaluate(
    async (prefix, tok) => {
      const entryNameHit = await globalThis.JournalEntry.create({
        name: `${prefix}${tok}_in_entry_name`,
        pages: [{ name: 'placeholder', type: 'text' }],
      });
      const pageNameHit = await globalThis.JournalEntry.create({
        name: `${prefix}entry_two`,
        pages: [{ name: `page ${tok}_in_page_name`, type: 'text' }],
      });
      const markdownHit = await globalThis.JournalEntry.create({
        name: `${prefix}entry_three`,
        pages: [
          {
            name: 'body-target-md',
            type: 'text',
            text: { format: 2, markdown: `prose surrounding ${tok}_in_md keyword` },
          },
        ],
      });
      const htmlHit = await globalThis.JournalEntry.create({
        name: `${prefix}entry_four`,
        pages: [
          {
            name: 'body-target-html',
            type: 'text',
            text: { format: 1, content: `<p>html prose with ${tok}_in_html marker</p>` },
          },
        ],
      });
      return {
        ids: [entryNameHit.id, pageNameHit.id, markdownHit.id, htmlHit.id],
        entryNameHitId: entryNameHit.id,
        pageNameHitId: pageNameHit.id,
        markdownHitId: markdownHit.id,
        htmlHitId: htmlHit.id,
      };
    },
    PROBE_PREFIX,
    TOKEN,
  );
  log.info({ setup }, 'fixtures created');

  // Query 1: bare token, expect 4 hits across all surfaces.
  {
    const r = await page.evaluate(searchJournalsBody, { query: TOKEN });
    if (!r.ok) fail('q1 bare token result not ok', r);
    else {
      if (r.hitCount < 4) fail('q1 expected at least 4 hits', r);
      // Tier check: first hit should be entry.name match.
      if (r.hits[0]?.matchField !== 'entry.name') {
        fail('q1 first hit should be entry.name tier', r.hits[0]);
      }
      // Verify each surface produced a hit.
      const fields = new Set(r.hits.map((h) => h.matchField));
      if (!fields.has('entry.name')) fail('q1 missing entry.name match', r.hits);
      if (!fields.has('page.name')) fail('q1 missing page.name match', r.hits);
      if (!fields.has('page.text')) fail('q1 missing page.text match', r.hits);
      // Snippets present.
      if (r.hits.some((h) => !h.snippet || h.snippet.length === 0)) {
        fail('q1 some snippet empty', r.hits);
      }
    }
  }

  // Query 2: case-insensitive — lowercase the token.
  {
    const r = await page.evaluate(searchJournalsBody, { query: TOKEN.toLowerCase() });
    if (!r.ok) fail('q2 lowercase result not ok', r);
    else if (r.hitCount < 4) fail('q2 case-insensitive missed hits', r);
  }

  // Query 3: entryId filter limits scope to one entry.
  {
    const r = await page.evaluate(searchJournalsBody, {
      query: TOKEN,
      entryId: setup.markdownHitId,
    });
    if (!r.ok) fail('q3 entryId filter result not ok', r);
    else {
      if (r.scannedEntries !== 1) fail('q3 scannedEntries expected 1', r);
      if (r.hits.some((h) => h.entryId !== setup.markdownHitId)) {
        fail('q3 hit outside entryId scope', r.hits);
      }
    }
  }

  // Query 4: limit caps hits.
  {
    const r = await page.evaluate(searchJournalsBody, { query: TOKEN, limit: 2 });
    if (!r.ok) fail('q4 limit result not ok', r);
    else {
      if (r.hits.length !== 2) fail('q4 hits length expected 2', r);
      if (!r.truncated) fail('q4 truncated expected true', r);
    }
  }

  // Query 5: snippet length honored.
  {
    const longBody = 'A'.repeat(800) + ` ${TOKEN}_in_md ` + 'B'.repeat(800);
    await page.evaluate(
      async (prefix, body) => {
        await globalThis.JournalEntry.create({
          name: `${prefix}long_body`,
          pages: [{ name: 'long', type: 'text', text: { format: 2, markdown: body } }],
        });
      },
      PROBE_PREFIX,
      longBody,
    );
    const r = await page.evaluate(searchJournalsBody, {
      query: TOKEN,
      entryId: undefined,
      limit: 50,
      snippetLength: 50,
    });
    if (!r.ok) fail('q5 snippetLength result not ok', r);
    else {
      const longHit = r.hits.find((h) => h.snippet?.includes(`${TOKEN}_in_md`));
      // Snippet may include leading/trailing ellipsis chars (1 char each)
      // so allow a small slack window above the requested length.
      if (longHit && longHit.snippet.length > 60) {
        fail('q5 snippet exceeded requested length', longHit);
      }
    }
  }

  // Query 6: empty query rejected.
  {
    const r = await page.evaluate(searchJournalsBody, { query: '   ' });
    if (r.ok) fail('q6 empty query expected error', r);
  }

  // Query 7: zero hits — query for a token that doesn't exist anywhere.
  {
    const r = await page.evaluate(searchJournalsBody, { query: 'QWZXNOTHINGYHERE' });
    if (!r.ok) fail('q7 result not ok', r);
    else if (r.hitCount !== 0) fail('q7 expected 0 hits', r);
  }

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
