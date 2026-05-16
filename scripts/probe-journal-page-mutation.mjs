/**
 * Destructive probe for the journal page-mutation cluster
 * (create_journal_page, update_journal_page, delete_journal_page).
 *
 * Every page exercised lives on a scratch `__probe_journal_` entry that
 * is deleted whole in teardown (cascade-removing its pages), so the
 * canonical-state guard is the journal entry id-set asserted unchanged.
 *
 * Coverage:
 *  - create: markdown render (showdown HTML in text.content), empty page,
 *    sort auto-assign across multiple creates, explicit sort.
 *  - update: replace / append / prepend modes, separator application,
 *    name+sort+title changes, INCOMPATIBLE_FORMAT rejection of
 *    append/prepend on an HTML-format page, replace converting an HTML
 *    page to markdown, no-changes rejection, non-text-page rejection.
 *  - delete: page removal + remainingPageCount, missing-page rejection.
 *
 *   npm run build && node scripts/probe-journal-page-mutation.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { createJournalPageBody } from '../dist/evaluators/create-journal-page.js';
import { updateJournalPageBody } from '../dist/evaluators/update-journal-page.js';
import { deleteJournalPageBody } from '../dist/evaluators/delete-journal-page.js';

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

  // Scratch entry to host all probe pages.
  const entry = await page.evaluate(async (prefix) => {
    const e = await globalThis.JournalEntry.create({ name: `${prefix}page_mutation` });
    return { id: e.id };
  }, PROBE_PREFIX);
  log.info({ entry }, 'scratch entry created');

  // Helper: read a page's raw text fields.
  const readPage = (entryId, pageId) =>
    page.evaluate(
      (eId, pId) => {
        const e = globalThis.game.journal?.get(eId);
        const p = e?.pages?.get(pId);
        if (!p) return null;
        return {
          name: p.name,
          sort: p.sort,
          type: p.type,
          format: p.text?.format ?? null,
          markdown: p.text?.markdown ?? null,
          content: p.text?.content ?? null,
          titleShow: p.title?.show ?? null,
          titleLevel: p.title?.level ?? null,
        };
      },
      entryId,
      pageId,
    );

  // --- create: markdown page, showdown renders content ---
  const createdMd = await page.evaluate(createJournalPageBody, {
    entryId: entry.id,
    name: 'session 1',
    markdown: '# Session 1\n\nThe party **arrived** in Otari.',
  });
  if (!createdMd.ok) fail('create markdown page not ok', createdMd);
  else {
    const pg = await readPage(entry.id, createdMd.pageId);
    if (!pg) fail('created md page not found', createdMd);
    else {
      if (pg.format !== 2) fail('md page format expected 2', pg);
      if (!pg.markdown?.includes('arrived')) fail('md page markdown missing', pg);
      if (!pg.content || !/<\w+>/.test(pg.content)) {
        fail('md page content not rendered to HTML (showdown?)', pg);
      }
    }
  }

  // --- create: empty page ---
  const createdEmpty = await page.evaluate(createJournalPageBody, {
    entryId: entry.id,
    name: 'empty page',
  });
  if (!createdEmpty.ok) fail('create empty page not ok', createdEmpty);

  // --- create: sort auto-assign across multiple creates ---
  const sortA = await page.evaluate(createJournalPageBody, { entryId: entry.id, name: 'sortA' });
  const sortB = await page.evaluate(createJournalPageBody, { entryId: entry.id, name: 'sortB' });
  if (sortA.ok && sortB.ok) {
    if (!(sortB.sort > sortA.sort)) {
      fail('sort auto-assign did not increase', { sortA: sortA.sort, sortB: sortB.sort });
    }
  } else {
    fail('sort auto-assign creates failed', { sortA, sortB });
  }

  // --- create: explicit sort honored ---
  const explicitSort = await page.evaluate(createJournalPageBody, {
    entryId: entry.id,
    name: 'explicit sort',
    sort: 42,
  });
  if (explicitSort.ok && explicitSort.sort !== 42) {
    fail('explicit sort not honored', explicitSort);
  }

  // --- update: replace mode ---
  if (createdMd.ok) {
    const replaced = await page.evaluate(updateJournalPageBody, {
      entryId: entry.id,
      pageId: createdMd.pageId,
      markdown: 'Wholly new body.',
      mode: 'replace',
    });
    if (!replaced.ok) fail('replace not ok', replaced);
    else {
      const pg = await readPage(entry.id, createdMd.pageId);
      if (pg?.markdown !== 'Wholly new body.') fail('replace did not apply', pg);
      if (pg?.markdown?.includes('arrived')) fail('replace left old content', pg);
    }

    // --- update: append mode ---
    const appended = await page.evaluate(updateJournalPageBody, {
      entryId: entry.id,
      pageId: createdMd.pageId,
      markdown: 'Appended line.',
      mode: 'append',
    });
    if (!appended.ok) fail('append not ok', appended);
    else {
      const pg = await readPage(entry.id, createdMd.pageId);
      if (!pg?.markdown?.includes('Wholly new body.')) fail('append lost old content', pg);
      if (!pg?.markdown?.includes('Appended line.')) fail('append missing new content', pg);
      // Default separator is a blank line.
      if (!pg?.markdown?.includes('Wholly new body.\n\nAppended line.')) {
        fail('append separator not applied', pg);
      }
    }

    // --- update: prepend mode with custom separator ---
    const prepended = await page.evaluate(updateJournalPageBody, {
      entryId: entry.id,
      pageId: createdMd.pageId,
      markdown: 'PREFIX',
      mode: 'prepend',
      separator: ' --- ',
    });
    if (!prepended.ok) fail('prepend not ok', prepended);
    else {
      const pg = await readPage(entry.id, createdMd.pageId);
      if (!pg?.markdown?.startsWith('PREFIX --- ')) fail('prepend/separator not applied', pg);
    }

    // --- update: name + sort + title ---
    const meta = await page.evaluate(updateJournalPageBody, {
      entryId: entry.id,
      pageId: createdMd.pageId,
      name: 'renamed session',
      sort: 5,
      titleShow: false,
      titleLevel: 3,
    });
    if (!meta.ok) fail('meta update not ok', meta);
    else {
      const pg = await readPage(entry.id, createdMd.pageId);
      if (pg?.name !== 'renamed session') fail('name not updated', pg);
      if (pg?.sort !== 5) fail('sort not updated', pg);
      if (pg?.titleShow !== false) fail('titleShow not updated', pg);
      if (pg?.titleLevel !== 3) fail('titleLevel not updated', pg);
    }

    // --- update: no changes rejected ---
    const noChange = await page.evaluate(updateJournalPageBody, {
      entryId: entry.id,
      pageId: createdMd.pageId,
    });
    if (noChange.ok) fail('no-change update should error', noChange);
  }

  // --- HTML page: append/prepend rejected, replace converts ---
  const htmlPage = await page.evaluate(async (entryId) => {
    const e = globalThis.game.journal?.get(entryId);
    const created = await e.createEmbeddedDocuments('JournalEntryPage', [
      {
        name: 'html authored',
        type: 'text',
        text: { format: 1, content: '<p>hand-authored HTML</p>' },
      },
    ]);
    return { pageId: created[0].id };
  }, entry.id);

  const appendOnHtml = await page.evaluate(updateJournalPageBody, {
    entryId: entry.id,
    pageId: htmlPage.pageId,
    markdown: 'should be rejected',
    mode: 'append',
  });
  if (appendOnHtml.ok) fail('append on HTML page should be rejected', appendOnHtml);
  else if (appendOnHtml.error.code !== 'INCOMPATIBLE_FORMAT') {
    fail('append on HTML wrong error code', appendOnHtml);
  }

  const prependOnHtml = await page.evaluate(updateJournalPageBody, {
    entryId: entry.id,
    pageId: htmlPage.pageId,
    markdown: 'should be rejected',
    mode: 'prepend',
  });
  if (prependOnHtml.ok) fail('prepend on HTML page should be rejected', prependOnHtml);

  const replaceOnHtml = await page.evaluate(updateJournalPageBody, {
    entryId: entry.id,
    pageId: htmlPage.pageId,
    markdown: '# Converted\n\nNow markdown.',
    mode: 'replace',
  });
  if (!replaceOnHtml.ok) fail('replace on HTML page should succeed', replaceOnHtml);
  else {
    const pg = await readPage(entry.id, htmlPage.pageId);
    if (pg?.format !== 2) fail('replace did not convert HTML page to format 2', pg);
    if (!pg?.markdown?.includes('Now markdown.')) fail('replace markdown missing', pg);
  }

  // --- non-text page rejected ---
  const imagePage = await page.evaluate(async (entryId) => {
    const e = globalThis.game.journal?.get(entryId);
    const created = await e.createEmbeddedDocuments('JournalEntryPage', [
      { name: 'an image', type: 'image', src: 'icons/svg/book.svg' },
    ]);
    return { pageId: created[0].id };
  }, entry.id);
  const updateImage = await page.evaluate(updateJournalPageBody, {
    entryId: entry.id,
    pageId: imagePage.pageId,
    markdown: 'nope',
  });
  if (updateImage.ok) fail('update on image page should be rejected', updateImage);

  // --- delete: page removed, remainingPageCount reported ---
  if (createdEmpty.ok) {
    const deleted = await page.evaluate(deleteJournalPageBody, {
      entryId: entry.id,
      pageId: createdEmpty.pageId,
    });
    if (!deleted.ok) fail('delete page not ok', deleted);
    else {
      const stillThere = await readPage(entry.id, createdEmpty.pageId);
      if (stillThere) fail('page still present after delete', deleted);
    }
  }

  // --- delete: missing page rejected ---
  const delMissing = await page.evaluate(deleteJournalPageBody, {
    entryId: entry.id,
    pageId: 'nonexistentpage',
  });
  if (delMissing.ok) fail('delete missing page should error', delMissing);

  // --- create on missing entry rejected ---
  const createMissingEntry = await page.evaluate(createJournalPageBody, {
    entryId: 'nonexistententry',
    name: 'orphan',
  });
  if (createMissingEntry.ok) fail('create on missing entry should error', createMissingEntry);

  // Teardown.
  const teardown = await page.evaluate(
    async (prefix, snap) => {
      for (const e of (globalThis.game.journal?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
      )) {
        await e.delete();
      }
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
