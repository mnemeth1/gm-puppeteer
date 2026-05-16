/**
 * Phase 1 design-blocking probes for the journal tool cluster. Run BEFORE
 * any evaluator code is written; multiple tool shapes hang on Q1 in
 * particular (markdown render path).
 *
 * All scratch state lives under entries with names prefixed `__probe_journal_`.
 * Pre-probe scrub deletes leftover scratch from past runs. Teardown deletes
 * everything created and asserts the journal entry id-set equals the
 * start snapshot.
 *
 * Questions:
 *   Q1: Markdown render path. Create a page with text.format=2 +
 *       text.markdown="# H\n\nbody **bold**". Does Foundry auto-compile
 *       to text.content on save? If not, write tools must render HTML
 *       themselves.
 *   Q2: JournalEntry#show() from the headless GM tab. Does it throw?
 *       Does it produce socket traffic? (Full broadcast verification is
 *       a human checkpoint in a later probe.)
 *   Q3: Search mechanism. Probe game.journal.search?, world.collections
 *       indexes; fall back to manual contents scan. Time both.
 *   Q4: Ownership dot-path update semantics on entries AND pages.
 *       Page-level override via page.update({"ownership.<id>": N}).
 *   Q5: Page sort field auto-assignment.
 *   Q6: CONST.JOURNAL_ENTRY_PAGE_FORMATS values.
 *   Q7: Page-type defaults — what does Foundry default for text.format,
 *       title.show, title.level when creating a bare {type:"text"} page.
 *
 *   npm run build && node scripts/probe-journal-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_PREFIX = '__probe_journal_';
const SCRATCH_USER_PREFIX = '__probe_journal_user_';

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

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub: delete any leftover __probe_journal_* entries.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(
    async (prefix, userPrefix) => {
      const entries = (globalThis.game.journal?.contents ?? []).filter(
        (e) => typeof e.name === 'string' && e.name.startsWith(prefix),
      );
      const entriesDeleted = [];
      for (const e of entries) {
        try {
          await e.delete();
          entriesDeleted.push(e.id);
        } catch (err) {
          entriesDeleted.push({ id: e.id, err: err?.message ?? String(err) });
        }
      }
      const scratchUsers = (globalThis.game.users?.contents ?? []).filter(
        (u) => typeof u.name === 'string' && u.name.startsWith(userPrefix),
      );
      const usersDeleted = [];
      for (const u of scratchUsers) {
        try {
          await u.delete();
          usersDeleted.push(u.id);
        } catch (err) {
          usersDeleted.push({ id: u.id, err: err?.message ?? String(err) });
        }
      }
      return {
        entriesDeleted,
        usersDeleted,
        totalEntries: globalThis.game.journal.size,
      };
    },
    PROBE_PREFIX,
    SCRATCH_USER_PREFIX,
  );
  log.info({ scrub }, 'pre-probe scrub');

  // --------------------------------------------------------------------
  // Snapshot: capture id set + page-count summary so teardown can
  // assert nothing about the canonical journal directory changed.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate(() => {
    const entries = globalThis.game.journal?.contents ?? [];
    return {
      ids: entries.map((e) => e.id).sort(),
      pageCounts: Object.fromEntries(entries.map((e) => [e.id, e.pages?.size ?? 0])),
      totalEntries: globalThis.game.journal.size,
    };
  });
  log.info(
    { totalEntries: startSnapshot.totalEntries, idCount: startSnapshot.ids.length },
    'snapshot captured',
  );

  // ====================================================================
  // Q6: CONST.JOURNAL_ENTRY_PAGE_FORMATS values.
  // Pin first so subsequent probes can refer to them.
  // ====================================================================
  {
    const probe = await page.evaluate(() => {
      const C = globalThis.CONST?.JOURNAL_ENTRY_PAGE_FORMATS;
      return {
        present: !!C,
        constants: C ? { ...C } : null,
      };
    });
    record('Q6', 'CONST.JOURNAL_ENTRY_PAGE_FORMATS', probe);
    if (!probe.present) fail('Q6', 'JOURNAL_ENTRY_PAGE_FORMATS missing', probe);
  }

  // ====================================================================
  // Q7: Page-type defaults. Create a minimal {type:"text"} page and
  // observe what Foundry fills in for text.format, title.show,
  // title.level, text.markdown, text.content.
  // ====================================================================
  {
    const probe = await page.evaluate(async (prefix) => {
      const entry = await globalThis.JournalEntry.create({
        name: `${prefix}q7_defaults`,
        pages: [{ name: 'bare page', type: 'text' }],
      });
      const page = entry.pages.contents[0];
      const obj = page.toObject();
      return {
        entryId: entry.id,
        pageId: page.id,
        fullPage: obj,
        textFormat: obj?.text?.format ?? null,
        textMarkdown: obj?.text?.markdown ?? null,
        textContent: obj?.text?.content ?? null,
        titleShow: obj?.title?.show ?? null,
        titleLevel: obj?.title?.level ?? null,
        sort: obj?.sort ?? null,
        ownership: obj?.ownership ?? null,
      };
    }, PROBE_PREFIX);
    record('Q7', 'page-type=text defaults', probe);
  }

  // ====================================================================
  // Q1: Markdown render path. Create an entry whose page is written
  // explicitly with text.format=2 and text.markdown. Does Foundry
  // auto-populate text.content with rendered HTML?
  //
  // Then update the markdown source — does text.content re-render?
  // ====================================================================
  let q1EntryId = null;
  {
    const probe = await page.evaluate(async (prefix) => {
      const MD_FORMAT = globalThis.CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.MARKDOWN ?? 2;
      const initialMd = '# Heading\n\nbody **bold** and _italic_.';
      const entry = await globalThis.JournalEntry.create({
        name: `${prefix}q1_markdown`,
        pages: [
          {
            name: 'md page',
            type: 'text',
            text: {
              format: MD_FORMAT,
              markdown: initialMd,
            },
          },
        ],
      });
      const page = entry.pages.contents[0];
      const afterCreate = {
        format: page.text?.format ?? null,
        markdown: page.text?.markdown ?? null,
        content: page.text?.content ?? null,
        contentLooksHTML: /<\/?\w+>/.test(page.text?.content ?? ''),
      };

      // Now update the markdown and re-read.
      const newMd = '## Updated heading\n\nDifferent body.';
      let updateThrew = null;
      try {
        await page.update({ 'text.markdown': newMd });
      } catch (e) {
        updateThrew = e?.message ?? String(e);
      }
      const reread = entry.pages.get(page.id);
      const afterUpdate = {
        format: reread.text?.format ?? null,
        markdown: reread.text?.markdown ?? null,
        content: reread.text?.content ?? null,
        contentLooksHTML: /<\/?\w+>/.test(reread.text?.content ?? ''),
        contentReflectsUpdate:
          typeof reread.text?.content === 'string' &&
          reread.text.content.includes('Updated heading'),
      };

      // Also probe: is there an enrichHTML / marked helper available?
      const enrichers = {
        TextEditorEnrichHTML:
          typeof globalThis.TextEditor?.enrichHTML === 'function' ||
          typeof globalThis.foundry?.applications?.ux?.TextEditor?.enrichHTML === 'function',
        markedPresent:
          typeof globalThis.marked === 'function' ||
          typeof globalThis.marked?.parse === 'function',
        showdownPresent: typeof globalThis.showdown !== 'undefined',
      };

      return {
        entryId: entry.id,
        pageId: page.id,
        afterCreate,
        afterUpdate,
        updateThrew,
        enrichers,
      };
    }, PROBE_PREFIX);
    q1EntryId = probe.entryId;
    record('Q1', 'markdown render path', probe);
    if (probe.afterCreate.content && probe.afterCreate.contentLooksHTML) {
      record('Q1', 'CONCLUSION: Foundry auto-compiles MD→HTML on save', {
        autoCompile: true,
      });
    } else {
      record('Q1', 'CONCLUSION: Foundry does NOT auto-compile MD→HTML; write tools must render', {
        autoCompile: false,
        availableEnrichers: probe.enrichers,
      });
    }
  }

  // ====================================================================
  // Q2: JournalEntry#show() from headless GM tab. Does it throw?
  // Does it queue a socket emit? Full broadcast verification is a
  // human checkpoint later.
  // ====================================================================
  {
    const probe = await page.evaluate(async (entryId) => {
      const entry = globalThis.game.journal?.get(entryId);
      if (!entry) return { error: 'entry missing' };
      const result = {
        hasShowMethod: typeof entry.show === 'function',
        activeUsers: (globalThis.game.users?.contents ?? [])
          .filter((u) => u.active)
          .map((u) => ({ id: u.id, name: u.name, isGM: u.isGM })),
      };
      let showThrew = null;
      try {
        await entry.show();
      } catch (e) {
        showThrew = e?.message ?? String(e);
      }
      result.showNoArgsThrew = showThrew;

      let showForceThrew = null;
      try {
        await entry.show(true);
      } catch (e) {
        showForceThrew = e?.message ?? String(e);
      }
      result.showForceThrew = showForceThrew;

      return result;
    }, q1EntryId);
    record('Q2', 'JournalEntry#show() from headless GM', probe);
  }

  // ====================================================================
  // Q3: Search mechanism. Probe the API surface, then time a manual
  // contents scan. Create a few entries with known-unique tokens so we
  // can measure both correctness and perf.
  // ====================================================================
  let q3EntryIds = [];
  {
    const setup = await page.evaluate(async (prefix) => {
      // Create three entries with distinct tokens in name, page name,
      // and body. Tokens are made unique enough to avoid collision with
      // real world content.
      const tok = 'XYZZYPROBE';
      const e1 = await globalThis.JournalEntry.create({
        name: `${prefix}q3_${tok}_in_entry_name`,
        pages: [{ name: 'page', type: 'text' }],
      });
      const e2 = await globalThis.JournalEntry.create({
        name: `${prefix}q3_entry_two`,
        pages: [{ name: `page ${tok}_in_page_name`, type: 'text' }],
      });
      const e3 = await globalThis.JournalEntry.create({
        name: `${prefix}q3_entry_three`,
        pages: [
          {
            name: 'body-target',
            type: 'text',
            text: { format: 2, markdown: `prose containing ${tok}_in_body keyword` },
          },
        ],
      });
      return { tok, ids: [e1.id, e2.id, e3.id] };
    }, PROBE_PREFIX);
    q3EntryIds = setup.ids;

    const probe = await page.evaluate(
      async (entryIds, tok) => {
        const J = globalThis.game.journal;
        const collectionHasSearch = typeof J?.search === 'function';
        const collectionHasIndex = typeof J?.index !== 'undefined';

        // Manual scan path: walk every entry, every page, substring match
        // on entry name, page name, page.text.markdown, page.text.content.
        const t0 = performance.now();
        const hits = [];
        for (const entry of J?.contents ?? []) {
          if ((entry.name ?? '').includes(tok)) {
            hits.push({ entryId: entry.id, where: 'entry.name' });
          }
          for (const pg of entry.pages?.contents ?? []) {
            if ((pg.name ?? '').includes(tok)) {
              hits.push({ entryId: entry.id, pageId: pg.id, where: 'page.name' });
            }
            const md = pg.text?.markdown ?? '';
            const ct = pg.text?.content ?? '';
            if (md.includes(tok) || ct.includes(tok)) {
              hits.push({ entryId: entry.id, pageId: pg.id, where: 'page.text' });
            }
          }
        }
        const tManual = performance.now() - t0;

        // Built-in path (if any): try the v14-shape search method.
        let builtinHits = null;
        let builtinError = null;
        let tBuiltin = null;
        if (collectionHasSearch) {
          try {
            const tb0 = performance.now();
            builtinHits = J.search({ query: tok });
            tBuiltin = performance.now() - tb0;
            // Normalize to a count + sample.
            if (Array.isArray(builtinHits)) {
              builtinHits = {
                shape: 'array',
                count: builtinHits.length,
                sampleIds: builtinHits.slice(0, 5).map((x) => x?.id ?? null),
              };
            } else if (builtinHits && typeof builtinHits === 'object') {
              builtinHits = {
                shape: 'object',
                keys: Object.keys(builtinHits).slice(0, 10),
              };
            }
          } catch (e) {
            builtinError = e?.message ?? String(e);
          }
        }

        return {
          collectionHasSearch,
          collectionHasIndex,
          journalCount: J?.size ?? 0,
          manualHits: hits,
          manualHitCount: hits.length,
          manualScanMs: Math.round(tManual * 100) / 100,
          builtinHits,
          builtinError,
          builtinScanMs: tBuiltin === null ? null : Math.round(tBuiltin * 100) / 100,
          probeEntryIds: entryIds,
        };
      },
      q3EntryIds,
      setup.tok,
    );
    record('Q3', 'search API surface and manual-scan perf', probe);
    if (probe.manualHitCount < 3) {
      fail('Q3', 'expected at least 3 manual hits (entry name, page name, body)', probe);
    }
  }

  // ====================================================================
  // Q4: Ownership dot-path semantics on entries AND pages. Page-level
  // override is new — actor docs don't have embedded permission docs.
  // ====================================================================
  {
    // Create a scratch user for the page-level override test.
    const scratch = await page.evaluate(async (userPrefix) => {
      try {
        const u = await globalThis.User.create({
          name: `${userPrefix}alpha`,
          role: globalThis.CONST?.USER_ROLES?.PLAYER ?? 1,
        });
        return { ok: true, id: u.id };
      } catch (e) {
        return { ok: false, err: e?.message ?? String(e) };
      }
    }, SCRATCH_USER_PREFIX);
    if (!scratch.ok) {
      fail('Q4', 'failed to create scratch user', scratch);
    } else {
      const probe = await page.evaluate(
        async (entryId, scratchId) => {
          const entry = globalThis.game.journal?.get(entryId);
          const pg = entry?.pages?.contents?.[0];
          if (!entry || !pg) return { error: 'entry/page missing' };

          // Entry-level dot-path update.
          const entryBefore = JSON.parse(JSON.stringify(entry.ownership ?? {}));
          let entryThrew = null;
          try {
            await entry.update({ [`ownership.${scratchId}`]: 2 });
          } catch (e) {
            entryThrew = e?.message ?? String(e);
          }
          const entryAfter = JSON.parse(JSON.stringify(entry.ownership ?? {}));

          // Page-level dot-path update.
          const pageBefore = JSON.parse(JSON.stringify(pg.ownership ?? {}));
          let pageThrew = null;
          try {
            await pg.update({ [`ownership.${scratchId}`]: 3 });
          } catch (e) {
            pageThrew = e?.message ?? String(e);
          }
          const pageAfter = JSON.parse(JSON.stringify(pg.ownership ?? {}));

          // Read the page back fresh to confirm persistence.
          const reread = entry.pages.get(pg.id);
          const pageRereadOwnership = JSON.parse(JSON.stringify(reread.ownership ?? {}));

          // Clear both via -= for hygiene.
          await entry.update({ [`ownership.-=${scratchId}`]: null });
          await pg.update({ [`ownership.-=${scratchId}`]: null });
          const entryCleared = JSON.parse(JSON.stringify(entry.ownership ?? {}));
          const pageCleared = JSON.parse(JSON.stringify(pg.ownership ?? {}));

          return {
            entryBefore,
            entryAfter,
            entryThrew,
            entryScratchLevel: entryAfter[scratchId],
            entrySurgical:
              entryAfter[scratchId] === 2 &&
              Object.keys(entryBefore)
                .filter((k) => k !== scratchId)
                .every((k) => entryBefore[k] === entryAfter[k]),
            pageBefore,
            pageAfter,
            pageThrew,
            pageScratchLevel: pageAfter[scratchId],
            pageRereadOwnership,
            pageRereadHasScratch: Object.prototype.hasOwnProperty.call(
              pageRereadOwnership,
              scratchId,
            ),
            entryClearedKeys: Object.keys(entryCleared).sort(),
            pageClearedKeys: Object.keys(pageCleared).sort(),
            entryScratchCleared: !Object.prototype.hasOwnProperty.call(
              entryCleared,
              scratchId,
            ),
            pageScratchCleared: !Object.prototype.hasOwnProperty.call(
              pageCleared,
              scratchId,
            ),
          };
        },
        q1EntryId,
        scratch.id,
      );
      record('Q4', 'ownership dot-path on entries and pages', probe);
    }
  }

  // ====================================================================
  // Q5: Page sort field auto-assignment. Create three pages on a
  // scratch entry without specifying sort. Observe what Foundry fills in.
  // ====================================================================
  {
    const probe = await page.evaluate(async (prefix) => {
      const entry = await globalThis.JournalEntry.create({
        name: `${prefix}q5_sort`,
        pages: [{ name: 'first', type: 'text' }],
      });

      // Add two more pages via createEmbeddedDocuments.
      const created = await entry.createEmbeddedDocuments('JournalEntryPage', [
        { name: 'second', type: 'text' },
        { name: 'third', type: 'text' },
      ]);

      const all = entry.pages.contents.map((p) => ({
        id: p.id,
        name: p.name,
        sort: p.sort,
      }));

      // Now explicitly set a sort and see if it sticks.
      const target = entry.pages.contents[1];
      await target.update({ sort: 999999 });
      const reread = entry.pages.get(target.id);

      return {
        entryId: entry.id,
        pagesWithDefaultSort: all,
        explicitSetSort: { id: target.id, sortAfter: reread.sort },
        createdViaEmbeddedDocsCount: created.length,
      };
    }, PROBE_PREFIX);
    record('Q5', 'page sort auto-assignment', probe);
  }

  // --------------------------------------------------------------------
  // Teardown: delete every __probe_journal_* entry and the scratch user.
  // Then assert the journal id set equals the start snapshot.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (prefix, userPrefix, snapshot) => {
      // Delete scratch user.
      const scratchUsers = (globalThis.game.users?.contents ?? []).filter(
        (u) => typeof u.name === 'string' && u.name.startsWith(userPrefix),
      );
      const usersDeleted = [];
      for (const u of scratchUsers) {
        try {
          await u.delete();
          usersDeleted.push(u.id);
        } catch (e) {
          usersDeleted.push({ id: u.id, err: e?.message ?? String(e) });
        }
      }

      // Delete every probe entry.
      const entries = (globalThis.game.journal?.contents ?? []).filter(
        (e) => typeof e.name === 'string' && e.name.startsWith(prefix),
      );
      const entriesDeleted = [];
      for (const e of entries) {
        try {
          await e.delete();
          entriesDeleted.push(e.id);
        } catch (err) {
          entriesDeleted.push({ id: e.id, err: err?.message ?? String(err) });
        }
      }

      // Assert ids match snapshot exactly.
      const liveIds = (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort();
      const idMatch = liveIds.join(',') === snapshot.ids.join(',');

      return {
        usersDeleted,
        entriesDeleted,
        finalIds: liveIds,
        expectedIds: snapshot.ids,
        idMatch,
        totalEntriesAfter: globalThis.game.journal.size,
      };
    },
    PROBE_PREFIX,
    SCRATCH_USER_PREFIX,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');

  if (!teardown.idMatch) {
    fail('teardown', 'journal id set did not restore cleanly', {
      missing: startSnapshot.ids.filter((id) => !teardown.finalIds.includes(id)),
      extra: teardown.finalIds.filter((id) => !startSnapshot.ids.includes(id)),
    });
  }

  // --------------------------------------------------------------------
  // Final report.
  // --------------------------------------------------------------------
  log.info(
    { findings, errors, errorCount: errors.length, findingCount: findings.length },
    'PHASE 1 SUMMARY',
  );
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'phase 1 probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
