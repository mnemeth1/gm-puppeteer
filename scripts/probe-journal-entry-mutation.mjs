/**
 * Destructive probe for the journal entry-mutation cluster
 * (create_journal_entry, update_journal_entry, delete_journal_entry).
 *
 * The three tools each take an explicit entryId and cannot over-reach,
 * so the canonical-state guard is a per-entry signature snapshot
 * (`{id, name, folderId, pageCount}`) asserted unchanged at teardown —
 * this catches both accidental deletion AND accidental mutation of a
 * non-target entry. All probe-created entries live under the
 * `__probe_journal_` name prefix and are deleted in teardown.
 *
 *   npm run build && node scripts/probe-journal-entry-mutation.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { createJournalEntryBody } from '../dist/evaluators/create-journal-entry.js';
import { updateJournalEntryBody } from '../dist/evaluators/update-journal-entry.js';
import { deleteJournalEntryBody } from '../dist/evaluators/delete-journal-entry.js';

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

  // Pre-probe scrub: probe entries + probe folders.
  await page.evaluate(async (prefix) => {
    for (const e of (globalThis.game.journal?.contents ?? []).filter(
      (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
    )) {
      await e.delete();
    }
    for (const f of (globalThis.game.folders?.contents ?? []).filter(
      (x) => typeof x.name === 'string' && x.name.startsWith(prefix) && x.type === 'JournalEntry',
    )) {
      await f.delete();
    }
  }, PROBE_PREFIX);

  // Canonical-state signature snapshot of every existing entry.
  const startSnapshot = await page.evaluate(() => ({
    entries: (globalThis.game.journal?.contents ?? []).map((e) => ({
      id: e.id,
      name: e.name ?? '',
      folderId: e.folder?.id ?? null,
      pageCount: e.pages?.size ?? 0,
    })),
  }));
  log.info({ entryCount: startSnapshot.entries.length }, 'snapshot captured');

  // A scratch JournalEntry folder for folderId-move tests.
  const scratchFolder = await page.evaluate(async (prefix) => {
    const f = await globalThis.Folder.create({
      name: `${prefix}folder`,
      type: 'JournalEntry',
    });
    return { id: f.id };
  }, PROBE_PREFIX);
  log.info({ scratchFolder }, 'scratch folder created');

  // --- create_journal_entry: bare ---
  const created = await page.evaluate(createJournalEntryBody, {
    name: `${PROBE_PREFIX}create_bare`,
  });
  if (!created.ok) fail('create bare not ok', created);
  else {
    if (created.folderId !== null) fail('create bare folderId expected null', created);
    if (created.defaultOwnership !== 'NONE') fail('create bare default ownership', created);
  }

  // --- create_journal_entry: with folder + defaultOwnership ---
  const createdFoldered = await page.evaluate(createJournalEntryBody, {
    name: `${PROBE_PREFIX}create_foldered`,
    folderId: scratchFolder.id,
    defaultOwnership: 'OBSERVER',
  });
  if (!createdFoldered.ok) fail('create foldered not ok', createdFoldered);
  else {
    if (createdFoldered.folderId !== scratchFolder.id) {
      fail('create foldered folderId mismatch', createdFoldered);
    }
    if (createdFoldered.defaultOwnership !== 'OBSERVER') {
      fail('create foldered ownership mismatch', createdFoldered);
    }
  }

  // --- create_journal_entry: bad folder rejected ---
  const createBadFolder = await page.evaluate(createJournalEntryBody, {
    name: `${PROBE_PREFIX}create_badfolder`,
    folderId: 'nonexistentfolder',
  });
  if (createBadFolder.ok) fail('create with bad folder should error', createBadFolder);

  // --- update_journal_entry: rename ---
  if (created.ok) {
    const renamed = await page.evaluate(updateJournalEntryBody, {
      entryId: created.id,
      name: `${PROBE_PREFIX}create_bare_renamed`,
    });
    if (!renamed.ok) fail('rename not ok', renamed);
    else {
      if (!renamed.changedFields.includes('name'))
        fail('rename changedFields missing name', renamed);
      if (renamed.entry.name !== `${PROBE_PREFIX}create_bare_renamed`) {
        fail('rename did not apply', renamed);
      }
    }

    // --- update_journal_entry: move to folder ---
    const moved = await page.evaluate(updateJournalEntryBody, {
      entryId: created.id,
      folderId: scratchFolder.id,
    });
    if (!moved.ok) fail('move not ok', moved);
    else if (moved.entry.folderId !== scratchFolder.id) fail('move did not apply', moved);

    // --- update_journal_entry: unparent (folderId: null) ---
    const unparented = await page.evaluate(updateJournalEntryBody, {
      entryId: created.id,
      folderId: null,
    });
    if (!unparented.ok) fail('unparent not ok', unparented);
    else if (unparented.entry.folderId !== null) fail('unparent did not apply', unparented);

    // --- update_journal_entry: no changes rejected ---
    const noChange = await page.evaluate(updateJournalEntryBody, {
      entryId: created.id,
    });
    if (noChange.ok) fail('update with no changes should error', noChange);

    // --- update_journal_entry: missing entry rejected ---
    const updMissing = await page.evaluate(updateJournalEntryBody, {
      entryId: 'nonexistent999',
      name: 'whatever',
    });
    if (updMissing.ok) fail('update missing entry should error', updMissing);
  }

  // --- delete_journal_entry: entry with pages reports page count ---
  const withPages = await page.evaluate(async (prefix) => {
    const e = await globalThis.JournalEntry.create({
      name: `${prefix}delete_with_pages`,
      pages: [
        { name: 'p1', type: 'text' },
        { name: 'p2', type: 'text' },
      ],
    });
    return { id: e.id };
  }, PROBE_PREFIX);
  const deleted = await page.evaluate(deleteJournalEntryBody, { entryId: withPages.id });
  if (!deleted.ok) fail('delete not ok', deleted);
  else {
    if (deleted.deletedPageCount !== 2) fail('delete deletedPageCount expected 2', deleted);
    // Confirm gone.
    const gone = await page.evaluate(
      (id) => globalThis.game.journal?.get(id) == null,
      withPages.id,
    );
    if (!gone) fail('entry still present after delete', { id: withPages.id });
  }

  // --- delete_journal_entry: missing entry rejected ---
  const delMissing = await page.evaluate(deleteJournalEntryBody, { entryId: 'nonexistent888' });
  if (delMissing.ok) fail('delete missing entry should error', delMissing);

  // --------------------------------------------------------------------
  // Teardown: delete all probe entries + the probe folder, then assert
  // the canonical signature snapshot is intact.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (prefix, snapshot) => {
      for (const e of (globalThis.game.journal?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
      )) {
        await e.delete();
      }
      for (const f of (globalThis.game.folders?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(prefix) && x.type === 'JournalEntry',
      )) {
        await f.delete();
      }
      const live = (globalThis.game.journal?.contents ?? []).map((e) => ({
        id: e.id,
        name: e.name ?? '',
        folderId: e.folder?.id ?? null,
        pageCount: e.pages?.size ?? 0,
      }));
      const liveById = new Map(live.map((e) => [e.id, e]));
      const drift = [];
      for (const snap of snapshot.entries) {
        const now = liveById.get(snap.id);
        if (!now) {
          drift.push({ id: snap.id, reason: 'MISSING' });
          continue;
        }
        if (
          now.name !== snap.name ||
          now.folderId !== snap.folderId ||
          now.pageCount !== snap.pageCount
        ) {
          drift.push({ id: snap.id, reason: 'MUTATED', snap, now });
        }
      }
      const extras = live.filter((e) => !snapshot.entries.some((s) => s.id === e.id));
      return { drift, extras, liveCount: live.length };
    },
    PROBE_PREFIX,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');
  if (teardown.drift.length > 0) fail('canonical entries drifted', teardown.drift);
  if (teardown.extras.length > 0) fail('orphan entries left behind', teardown.extras);

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
