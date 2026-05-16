/**
 * Probe for the journal ownership cluster (list_journal_ownership,
 * assign_journal_ownership, remove_journal_ownership). Ported from
 * probe-actor-ownership-phase1.mjs with the page-level / INHERIT
 * extensions.
 *
 * All mutation targets are a scratch `__probe_journal_` entry and a
 * scratch `__probe_journal_user_` user, both created and destroyed
 * in-probe. Teardown asserts the journal id-set and confirms no
 * scratch user remains.
 *
 *   npm run build && node scripts/probe-journal-ownership.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { listJournalOwnershipBody } from '../dist/evaluators/list-journal-ownership.js';
import { assignJournalOwnershipBody } from '../dist/evaluators/assign-journal-ownership.js';
import { removeJournalOwnershipBody } from '../dist/evaluators/remove-journal-ownership.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_PREFIX = '__probe_journal_';
const SCRATCH_USER_PREFIX = '__probe_journal_user_';
const errors = [];

function fail(label, ctx) {
  errors.push({ label, ctx });
  log.error({ label, ctx }, 'PROBE FAILURE');
}

try {
  const { page } = await session.ensureStarted();

  // Pre-probe scrub: entries + scratch users.
  await page.evaluate(
    async (prefix, userPrefix) => {
      for (const e of (globalThis.game.journal?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
      )) {
        await e.delete();
      }
      for (const u of (globalThis.game.users?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(userPrefix),
      )) {
        await u.delete();
      }
    },
    PROBE_PREFIX,
    SCRATCH_USER_PREFIX,
  );

  const startSnapshot = await page.evaluate(() => ({
    ids: (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort(),
  }));

  // Scratch entry with one page + scratch user.
  const setup = await page.evaluate(
    async (prefix, userPrefix) => {
      const entry = await globalThis.JournalEntry.create({
        name: `${prefix}ownership`,
        pages: [{ name: 'page one', type: 'text' }],
      });
      const user = await globalThis.User.create({
        name: `${userPrefix}alpha`,
        role: globalThis.CONST?.USER_ROLES?.PLAYER ?? 1,
      });
      return {
        entryId: entry.id,
        pageId: entry.pages.contents[0].id,
        userId: user.id,
      };
    },
    PROBE_PREFIX,
    SCRATCH_USER_PREFIX,
  );
  log.info({ setup }, 'fixtures created');

  // --- list: fresh entry ---
  // Foundry auto-grants the creating user (Claude-GM) an OWNER entry on
  // JournalEntry.create — that entry is expected. What must be absent is
  // the scratch user, which has had nothing assigned yet.
  {
    const r = await page.evaluate(listJournalOwnershipBody, { entryId: setup.entryId });
    if (!r.ok) fail('list fresh not ok', r);
    else {
      if (r.default !== 'NONE') fail('fresh entry default expected NONE', r);
      if (r.users.some((u) => u.userId === setup.userId)) {
        fail('fresh entry should not yet list the scratch user', r);
      }
      if (r.pages.length !== 1) fail('expected 1 page', r);
      else if (r.pages[0].default !== 'INHERIT') fail('fresh page default expected INHERIT', r.pages[0]);
    }
  }

  // --- assign entry-level: default -> OBSERVER ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: 'default',
      level: 'OBSERVER',
    });
    if (!r.ok) fail('assign default OBSERVER not ok', r);
    else if (r.scope !== 'entry') fail('assign default scope expected entry', r);
  }

  // --- assign entry-level: scratch user -> OWNER (created) ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: setup.userId,
      level: 'OWNER',
    });
    if (!r.ok) fail('assign user OWNER not ok', r);
    else {
      if (r.operation !== 'created') fail('assign user expected operation created', r);
      if (r.previousLevel !== null) fail('assign user expected previousLevel null', r);
    }
  }

  // --- assign entry-level: scratch user -> OBSERVER (updated) ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: setup.userId,
      level: 'OBSERVER',
    });
    if (!r.ok) fail('assign user OBSERVER not ok', r);
    else {
      if (r.operation !== 'updated') fail('assign user expected operation updated', r);
      if (r.previousLevel !== 'OWNER') fail('assign user expected previousLevel OWNER', r);
    }
  }

  // --- assign entry-level INHERIT rejected ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: setup.userId,
      level: 'INHERIT',
    });
    if (r.ok) fail('assign INHERIT on entry should be rejected', r);
    else if (r.error.details?.reason !== 'INHERIT_ON_ENTRY') {
      fail('assign INHERIT wrong reason', r);
    }
  }

  // --- assign page-level: scratch user -> INHERIT (valid for pages) ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      pageId: setup.pageId,
      userId: setup.userId,
      level: 'INHERIT',
    });
    if (!r.ok) fail('assign page INHERIT not ok', r);
    else if (r.scope !== 'page') fail('assign page scope expected page', r);
  }

  // --- assign page-level: scratch user -> OWNER ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      pageId: setup.pageId,
      userId: setup.userId,
      level: 'OWNER',
    });
    if (!r.ok) fail('assign page OWNER not ok', r);
  }

  // --- assign: bad user rejected ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: 'bogususer123',
      level: 'OBSERVER',
    });
    if (r.ok) fail('assign bad user should be rejected', r);
  }

  // --- assign: bad pageId rejected ---
  {
    const r = await page.evaluate(assignJournalOwnershipBody, {
      entryId: setup.entryId,
      pageId: 'boguspage123',
      userId: setup.userId,
      level: 'OBSERVER',
    });
    if (r.ok) fail('assign bad pageId should be rejected', r);
  }

  // --- list: reflects all changes ---
  {
    const r = await page.evaluate(listJournalOwnershipBody, { entryId: setup.entryId });
    if (!r.ok) fail('list after assigns not ok', r);
    else {
      if (r.default !== 'OBSERVER') fail('entry default should be OBSERVER', r);
      const userEntry = r.users.find((u) => u.userId === setup.userId);
      if (!userEntry || userEntry.level !== 'OBSERVER') fail('entry user not OBSERVER', r.users);
      const pg = r.pages[0];
      if (!pg.hasOverride) fail('page should report hasOverride', pg);
      const pgUser = pg.users.find((u) => u.userId === setup.userId);
      if (!pgUser || pgUser.level !== 'OWNER') fail('page user not OWNER', pg);
    }
  }

  // --- remove page-level entry ---
  {
    const r = await page.evaluate(removeJournalOwnershipBody, {
      entryId: setup.entryId,
      pageId: setup.pageId,
      userId: setup.userId,
    });
    if (!r.ok) fail('remove page-level not ok', r);
    else {
      if (r.scope !== 'page') fail('remove page scope expected page', r);
      if (r.previousLevel !== 'OWNER') fail('remove page previousLevel expected OWNER', r);
    }
    // Confirm gone.
    const after = await page.evaluate(listJournalOwnershipBody, { entryId: setup.entryId });
    if (after.ok && after.pages[0].users.some((u) => u.userId === setup.userId)) {
      fail('page user still present after remove', after.pages[0]);
    }
  }

  // --- remove entry-level entry ---
  {
    const r = await page.evaluate(removeJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: setup.userId,
    });
    if (!r.ok) fail('remove entry-level not ok', r);
    else {
      if (r.scope !== 'entry') fail('remove entry scope expected entry', r);
      if (r.fellBackTo !== 'OBSERVER') fail('remove entry fellBackTo expected OBSERVER', r);
    }
  }

  // --- remove 'default' rejected ---
  {
    const r = await page.evaluate(removeJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: 'default',
    });
    if (r.ok) fail('remove default should be rejected', r);
  }

  // --- remove non-present user rejected ---
  {
    const r = await page.evaluate(removeJournalOwnershipBody, {
      entryId: setup.entryId,
      userId: setup.userId,
    });
    if (r.ok) fail('remove non-present user should be rejected', r);
  }

  // Teardown.
  const teardown = await page.evaluate(
    async (prefix, userPrefix, snap) => {
      for (const e of (globalThis.game.journal?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(prefix),
      )) {
        await e.delete();
      }
      const usersDeleted = [];
      for (const u of (globalThis.game.users?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(userPrefix),
      )) {
        await u.delete();
        usersDeleted.push(u.id);
      }
      const liveIds = (globalThis.game.journal?.contents ?? []).map((e) => e.id).sort();
      const scratchUsersLeft = (globalThis.game.users?.contents ?? []).filter(
        (x) => typeof x.name === 'string' && x.name.startsWith(userPrefix),
      ).length;
      return {
        idMatch: liveIds.join(',') === snap.ids.join(','),
        usersDeleted,
        scratchUsersLeft,
      };
    },
    PROBE_PREFIX,
    SCRATCH_USER_PREFIX,
    startSnapshot,
  );
  if (!teardown.idMatch) fail('teardown id-set mismatch', teardown);
  if (teardown.scratchUsersLeft > 0) fail('scratch users left behind', teardown);
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
