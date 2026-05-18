/**
 * Destructive probe for the journal-folder tool family
 * (create_journal_folder, update_journal_folder, delete_journal_folder,
 * list_journal_folders).
 *
 * Two phases:
 *  1. API-shape investigation — answers the design-blocking questions
 *     before the evaluators are written: the Folder parent field name,
 *     depth semantics, whether Foundry natively rejects cycles /
 *     over-depth nesting, and `Folder#delete()` option semantics.
 *  2. End-to-end exercise of the four built evaluators (added once the
 *     evaluators exist in dist/).
 *
 * Every probe-created folder lives under the `__probe_jfolder_` name
 * prefix; teardown deletes them all and asserts the canonical folder
 * snapshot is drift-free.
 *
 *   npm run build && node scripts/probe-journal-folder-mutation.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { createJournalFolderBody } from '../dist/evaluators/create-journal-folder.js';
import { updateJournalFolderBody } from '../dist/evaluators/update-journal-folder.js';
import { deleteJournalFolderBody } from '../dist/evaluators/delete-journal-folder.js';
import { listJournalFoldersBody } from '../dist/evaluators/list-journal-folders.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_PREFIX = '__probe_jfolder_';
const errors = [];

function fail(label, ctx) {
  errors.push({ label, ctx });
  log.error({ label, ctx }, 'PROBE FAILURE');
}

/** Delete every probe-prefixed folder + journal entry, deepest folders
 *  first so a parent never outlives its children mid-sweep. */
async function scrub(page, prefix) {
  await page.evaluate(async (p) => {
    for (const e of (globalThis.game.journal?.contents ?? []).filter(
      (x) => typeof x.name === 'string' && x.name.startsWith(p),
    )) {
      await e.delete();
    }
    const folders = (globalThis.game.folders?.contents ?? []).filter(
      (x) => typeof x.name === 'string' && x.name.startsWith(p),
    );
    // Sort deepest-first using each folder's ancestor depth.
    const depthOf = (f) => {
      let d = 0;
      let cur = f;
      const seen = new Set();
      while (cur && cur.folder && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = cur.folder;
        d += 1;
        if (d > 256) break;
      }
      return d;
    };
    folders.sort((a, b) => depthOf(b) - depthOf(a));
    for (const f of folders) {
      await f.delete();
    }
  }, prefix);
}

try {
  const { page } = await session.ensureStarted();

  await scrub(page, PROBE_PREFIX);

  // Canonical-state signature snapshot of every existing folder.
  const startSnapshot = await page.evaluate(() => ({
    folders: (globalThis.game.folders?.contents ?? []).map((f) => ({
      id: f.id,
      name: f.name ?? '',
      type: f.type ?? '',
      folderId: f.folder?.id ?? null,
      sort: typeof f.sort === 'number' ? f.sort : 0,
    })),
  }));
  log.info({ folderCount: startSnapshot.folders.length }, 'snapshot captured');

  // ====================================================================
  // PHASE 1 — API-shape investigation
  // ====================================================================
  const api = await page.evaluate(async (prefix) => {
    const out = {};
    const Folder = globalThis.Folder;
    const CONST = globalThis.CONST ?? globalThis.foundry?.CONST ?? {};

    out.folderMaxDepth = CONST.FOLDER_MAX_DEPTH ?? null;

    // Q1+Q2: parent field name + depth semantics.
    const parent = await Folder.create({ name: `${prefix}q_parent`, type: 'JournalEntry' });
    const child = await Folder.create({
      name: `${prefix}q_child`,
      type: 'JournalEntry',
      folder: parent.id,
    });
    const childFresh = globalThis.game.folders.get(child.id);
    out.parentRef = {
      childFolderField: childFresh.folder?.id ?? null,
      childParentField: childFresh.parent?.id ?? null,
      rootDepth: parent.depth ?? null,
      childDepth: childFresh.depth ?? null,
      depthType: typeof childFresh.depth,
    };

    // Q3: native cycle handling — try to make `parent` a child of `child`.
    try {
      await parent.update({ folder: child.id });
      const reParent = globalThis.game.folders.get(parent.id);
      out.nativeCycle = {
        threw: false,
        parentFolderAfter: reParent.folder?.id ?? null,
        acceptedCycle: (reParent.folder?.id ?? null) === child.id,
      };
      // Undo if it stuck.
      if ((reParent.folder?.id ?? null) === child.id) {
        await parent.update({ folder: null });
      }
    } catch (e) {
      out.nativeCycle = { threw: true, message: e instanceof Error ? e.message : String(e) };
    }

    // Q4: native max-depth handling — nest a chain one level past the limit.
    const max = typeof out.folderMaxDepth === 'number' ? out.folderMaxDepth : 3;
    const chain = [];
    let prevId = null;
    out.nativeMaxDepth = { attempts: [] };
    for (let i = 0; i < max + 2; i += 1) {
      try {
        const f = await Folder.create({
          name: `${prefix}q_depth_${i}`,
          type: 'JournalEntry',
          folder: prevId,
        });
        const fFresh = globalThis.game.folders.get(f.id);
        out.nativeMaxDepth.attempts.push({
          level: i,
          created: true,
          depth: fFresh.depth ?? null,
        });
        chain.push(f.id);
        prevId = f.id;
      } catch (e) {
        out.nativeMaxDepth.attempts.push({
          level: i,
          created: false,
          message: e instanceof Error ? e.message : String(e),
        });
        break;
      }
    }

    // Q5: Folder#delete() semantics — what happens to contents + subfolders.
    // Build: delFolder -> { subfolder, journalEntry }.
    const delA = await Folder.create({ name: `${prefix}q_del_default`, type: 'JournalEntry' });
    const delASub = await Folder.create({
      name: `${prefix}q_del_default_sub`,
      type: 'JournalEntry',
      folder: delA.id,
    });
    const delAEntry = await globalThis.JournalEntry.create({
      name: `${prefix}q_del_default_entry`,
      folder: delA.id,
    });
    await delA.delete();
    {
      const subAfter = globalThis.game.folders.get(delASub.id);
      const entryAfter = globalThis.game.journal.get(delAEntry.id);
      out.deleteDefault = {
        subfolderSurvived: subAfter != null,
        subfolderParentAfter: subAfter ? (subAfter.folder?.id ?? null) : 'GONE',
        entrySurvived: entryAfter != null,
        entryFolderAfter: entryAfter ? (entryAfter.folder?.id ?? null) : 'GONE',
      };
    }

    // Q5b: delete with { deleteSubfolders: true, deleteContents: true }.
    const delB = await Folder.create({ name: `${prefix}q_del_cascade`, type: 'JournalEntry' });
    const delBSub = await Folder.create({
      name: `${prefix}q_del_cascade_sub`,
      type: 'JournalEntry',
      folder: delB.id,
    });
    const delBEntry = await globalThis.JournalEntry.create({
      name: `${prefix}q_del_cascade_entry`,
      folder: delB.id,
    });
    await delB.delete({ deleteSubfolders: true, deleteContents: true });
    {
      const subAfter = globalThis.game.folders.get(delBSub.id);
      const entryAfter = globalThis.game.journal.get(delBEntry.id);
      out.deleteCascade = {
        subfolderSurvived: subAfter != null,
        entrySurvived: entryAfter != null,
      };
    }

    return out;
  }, PROBE_PREFIX);

  log.info({ api }, 'PHASE 1 — API shape');

  // Re-scrub everything the API phase created before phase 2.
  await scrub(page, PROBE_PREFIX);

  // ====================================================================
  // PHASE 2 — exercise the built evaluators
  // ====================================================================
  {
    // An Actor-type folder for wrong-type rejection tests.
    const actorFolder = await page.evaluate(async (prefix) => {
      const f = await globalThis.Folder.create({ name: `${prefix}actor`, type: 'Actor' });
      return { id: f.id };
    }, PROBE_PREFIX);

    // --- create: root ---
    const root = await page.evaluate(createJournalFolderBody, { name: `${PROBE_PREFIX}root` });
    if (!root.ok) fail('create root not ok', root);
    else if (root.parentFolderId !== null) fail('create root parentFolderId expected null', root);

    // --- create: nested ---
    const nested = root.ok
      ? await page.evaluate(createJournalFolderBody, {
          name: `${PROBE_PREFIX}nested`,
          parentFolderId: root.id,
        })
      : null;
    if (nested && !nested.ok) fail('create nested not ok', nested);
    else if (nested && nested.parentFolderId !== root.id) {
      fail('create nested parentFolderId mismatch', nested);
    }

    // --- create: wrong-type parent rejected ---
    const badType = await page.evaluate(createJournalFolderBody, {
      name: `${PROBE_PREFIX}badtype`,
      parentFolderId: actorFolder.id,
    });
    if (badType.ok) fail('create under Actor folder should error', badType);
    else if (badType.error.details?.reason !== 'FOLDER_WRONG_TYPE') {
      fail('create wrong-type reason mismatch', badType);
    }

    // --- create: missing parent rejected ---
    const badParent = await page.evaluate(createJournalFolderBody, {
      name: `${PROBE_PREFIX}badparent`,
      parentFolderId: 'nonexistent000',
    });
    if (badParent.ok) fail('create with missing parent should error', badParent);

    // --- update: rename ---
    if (root.ok) {
      const renamed = await page.evaluate(updateJournalFolderBody, {
        folderId: root.id,
        name: `${PROBE_PREFIX}root_renamed`,
      });
      if (!renamed.ok) fail('rename not ok', renamed);
      else if (!renamed.changedFields.includes('name')) {
        fail('rename changedFields missing name', renamed);
      }
    }

    // --- update: move nested to root, then back ---
    if (root.ok && nested && nested.ok) {
      const toRoot = await page.evaluate(updateJournalFolderBody, {
        folderId: nested.id,
        parentFolderId: null,
      });
      if (!toRoot.ok) fail('move-to-root not ok', toRoot);
      else if (toRoot.folder.parentFolderId !== null) fail('move-to-root did not apply', toRoot);

      const backUnder = await page.evaluate(updateJournalFolderBody, {
        folderId: nested.id,
        parentFolderId: root.id,
      });
      if (!backUnder.ok) fail('move-back not ok', backUnder);

      // --- update: self-move rejected ---
      const selfMove = await page.evaluate(updateJournalFolderBody, {
        folderId: root.id,
        parentFolderId: root.id,
      });
      if (selfMove.ok) fail('self-move should error', selfMove);
      else if (selfMove.error.details?.reason !== 'FOLDER_CYCLE') {
        fail('self-move reason mismatch', selfMove);
      }

      // --- update: descendant-cycle rejected (root under its own child) ---
      const cycle = await page.evaluate(updateJournalFolderBody, {
        folderId: root.id,
        parentFolderId: nested.id,
      });
      if (cycle.ok) fail('descendant-cycle move should error', cycle);
      else if (cycle.error.details?.reason !== 'FOLDER_CYCLE') {
        fail('descendant-cycle reason mismatch', cycle);
      }

      // --- update: no changes rejected ---
      const noChange = await page.evaluate(updateJournalFolderBody, { folderId: root.id });
      if (noChange.ok) fail('update with no changes should error', noChange);
    }

    // --- update: missing folder rejected ---
    const updMissing = await page.evaluate(updateJournalFolderBody, {
      folderId: 'nonexistent111',
      name: 'whatever',
    });
    if (updMissing.ok) fail('update missing folder should error', updMissing);

    // --- list: probe folders present ---
    const listed = await page.evaluate(listJournalFoldersBody);
    if (!listed.ok) fail('list not ok', listed);
    else if (!listed.folders.some((f) => f.name === `${PROBE_PREFIX}root_renamed`)) {
      fail('list missing probe root folder', { count: listed.count });
    }

    // --- delete: nested folder (default, non-destructive) ---
    if (nested && nested.ok) {
      const delNested = await page.evaluate(deleteJournalFolderBody, { folderId: nested.id });
      if (!delNested.ok) fail('delete nested not ok', delNested);
      else {
        const gone = await page.evaluate(
          (id) => globalThis.game.folders?.get(id) == null,
          nested.id,
        );
        if (!gone) fail('nested folder still present after delete', { id: nested.id });
      }
    }

    // --- delete: root folder ---
    if (root.ok) {
      const delRoot = await page.evaluate(deleteJournalFolderBody, { folderId: root.id });
      if (!delRoot.ok) fail('delete root not ok', delRoot);
    }

    // --- delete: missing folder rejected ---
    const delMissing = await page.evaluate(deleteJournalFolderBody, {
      folderId: 'nonexistent222',
    });
    if (delMissing.ok) fail('delete missing folder should error', delMissing);

    // --- delete: wrong-type folder rejected ---
    const delWrongType = await page.evaluate(deleteJournalFolderBody, {
      folderId: actorFolder.id,
    });
    if (delWrongType.ok) fail('delete Actor folder should error', delWrongType);

    log.info('PHASE 2 — evaluator exercise complete');
  }

  // --------------------------------------------------------------------
  // Teardown — delete all probe folders/entries, assert snapshot intact.
  // --------------------------------------------------------------------
  await scrub(page, PROBE_PREFIX);
  const teardown = await page.evaluate((snapshot) => {
    const live = (globalThis.game.folders?.contents ?? []).map((f) => ({
      id: f.id,
      name: f.name ?? '',
      type: f.type ?? '',
      folderId: f.folder?.id ?? null,
      sort: typeof f.sort === 'number' ? f.sort : 0,
    }));
    const liveById = new Map(live.map((f) => [f.id, f]));
    const drift = [];
    for (const snap of snapshot.folders) {
      const now = liveById.get(snap.id);
      if (!now) {
        drift.push({ id: snap.id, reason: 'MISSING' });
        continue;
      }
      if (
        now.name !== snap.name ||
        now.type !== snap.type ||
        now.folderId !== snap.folderId ||
        now.sort !== snap.sort
      ) {
        drift.push({ id: snap.id, reason: 'MUTATED', snap, now });
      }
    }
    const extras = live.filter((f) => !snapshot.folders.some((s) => s.id === f.id));
    return { drift, extras, liveCount: live.length };
  }, startSnapshot);
  log.info({ teardown }, 'teardown complete');
  if (teardown.drift.length > 0) fail('canonical folders drifted', teardown.drift);
  if (teardown.extras.length > 0) fail('orphan folders left behind', teardown.extras);

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
