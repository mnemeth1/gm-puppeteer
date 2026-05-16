/**
 * Additive probe for get_journal_page. Creates one scratch entry with
 * pages of all four supported types (text/image/pdf/video), exercises
 * the evaluator on each, asserts the type-specific projection.
 *
 *   npm run build && node scripts/probe-get-journal-page.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { getJournalPageBody } from '../dist/evaluators/get-journal-page.js';

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
      name: `${prefix}page_types`,
      pages: [
        {
          name: 'markdown text',
          type: 'text',
          text: { format: 2, markdown: '# Heading\n\nbody **bold**.' },
        },
        {
          name: 'html text',
          type: 'text',
          text: { format: 1, content: '<p>plain html</p>' },
        },
        {
          name: 'image page',
          type: 'image',
          src: 'icons/svg/book.svg',
          image: { caption: 'a tome' },
        },
        {
          name: 'pdf page',
          type: 'pdf',
          src: 'systems/pf2e/icons/missing.pdf',
        },
        {
          name: 'video page',
          type: 'video',
          src: 'systems/pf2e/icons/missing.mp4',
          video: { controls: false, loop: true, autoplay: true, volume: 0.25 },
        },
      ],
    });
    const pages = entry.pages.contents.map((p) => ({ id: p.id, name: p.name, type: p.type }));
    return { entryId: entry.id, pages };
  }, PROBE_PREFIX);
  log.info({ setup }, 'fixture created');

  const byName = Object.fromEntries(setup.pages.map((p) => [p.name, p.id]));

  // Markdown text page.
  {
    const r = await page.evaluate(getJournalPageBody, {
      entryId: setup.entryId,
      pageId: byName['markdown text'],
    });
    if (!r.ok) fail('markdown text page result not ok', r);
    else if (!r.page.text) fail('markdown page missing .text', r.page);
    else {
      if (r.page.text.format !== 2) fail('markdown page format expected 2', r.page.text);
      if (!r.page.text.markdown?.includes('Heading')) fail('markdown source missing', r.page.text);
      // Per phase 1: content is null on freshly created markdown pages
      // because Foundry doesn't auto-compile during create. Accept null
      // OR compiled HTML — both are observed.
      if (r.page.text.content !== null && !/<\w+>/.test(r.page.text.content ?? '')) {
        fail('markdown page content neither null nor HTML', r.page.text);
      }
    }
  }

  // HTML text page.
  {
    const r = await page.evaluate(getJournalPageBody, {
      entryId: setup.entryId,
      pageId: byName['html text'],
    });
    if (!r.ok) fail('html text page result not ok', r);
    else if (!r.page.text) fail('html page missing .text', r.page);
    else {
      if (r.page.text.format !== 1) fail('html page format expected 1', r.page.text);
      if (!r.page.text.content?.includes('plain html')) fail('html content missing', r.page.text);
    }
  }

  // Image page.
  {
    const r = await page.evaluate(getJournalPageBody, {
      entryId: setup.entryId,
      pageId: byName['image page'],
    });
    if (!r.ok) fail('image page result not ok', r);
    else {
      if (r.page.type !== 'image') fail('image page type', r.page);
      if (!r.page.image) fail('image page missing .image', r.page);
      else if (r.page.image.caption !== 'a tome') fail('image caption', r.page.image);
      if (r.page.text) fail('image page should not have .text', r.page);
    }
  }

  // PDF page.
  {
    const r = await page.evaluate(getJournalPageBody, {
      entryId: setup.entryId,
      pageId: byName['pdf page'],
    });
    if (!r.ok) fail('pdf page result not ok', r);
    else {
      if (r.page.type !== 'pdf') fail('pdf page type', r.page);
      if (!r.page.pdf) fail('pdf page missing .pdf', r.page);
      if (r.page.text) fail('pdf page should not have .text', r.page);
    }
  }

  // Video page.
  {
    const r = await page.evaluate(getJournalPageBody, {
      entryId: setup.entryId,
      pageId: byName['video page'],
    });
    if (!r.ok) fail('video page result not ok', r);
    else {
      if (r.page.type !== 'video') fail('video page type', r.page);
      if (!r.page.video) fail('video page missing .video', r.page);
      else {
        if (r.page.video.controls !== false) fail('video.controls', r.page.video);
        if (r.page.video.loop !== true) fail('video.loop', r.page.video);
        if (r.page.video.volume !== 0.25) fail('video.volume', r.page.video);
      }
    }
  }

  // Missing entry / page.
  const missingEntry = await page.evaluate(getJournalPageBody, {
    entryId: 'nope',
    pageId: 'nope',
  });
  if (missingEntry.ok) fail('missing entry expected error', missingEntry);

  const missingPage = await page.evaluate(getJournalPageBody, {
    entryId: setup.entryId,
    pageId: 'nope',
  });
  if (missingPage.ok) fail('missing page expected error', missingPage);

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
