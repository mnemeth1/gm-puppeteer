/**
 * Additive probe for show_journal_entry. Creates a scratch entry with a
 * page, calls the tool with force=false and force=true, asserts neither
 * throws and the result shape is correct.
 *
 * HUMAN-IN-THE-LOOP CHECKPOINT: code-level verification only confirms
 * the broadcast call resolves. To confirm end-to-end delivery, a human
 * must be logged in as a GM or player in a browser when this
 * probe runs and watch for the journal popup. The probe logs the active
 * user list and a checkpoint line; check the run log against what the
 * human observed.
 *
 *   npm run build && node scripts/probe-show-journal-entry.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { showJournalEntryBody } from '../dist/evaluators/show-journal-entry.js';

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

  const entry = await page.evaluate(async (prefix) => {
    const e = await globalThis.JournalEntry.create({
      name: `${prefix}show_target`,
      pages: [
        {
          name: 'broadcast me',
          type: 'text',
          text: { format: 2, markdown: '# Broadcast test\n\nIf you can read this, show() worked.' },
        },
      ],
    });
    return { id: e.id };
  }, PROBE_PREFIX);
  log.info({ entry }, 'scratch entry created');

  // force = false
  const showDefault = await page.evaluate(showJournalEntryBody, { entryId: entry.id });
  if (!showDefault.ok) fail('show force=false not ok', showDefault);
  else {
    if (showDefault.force !== false) fail('force expected false', showDefault);
    if (typeof showDefault.broadcastTo !== 'number') fail('broadcastTo not a number', showDefault);
    log.info(
      { activeUsers: showDefault.activeUsers, broadcastTo: showDefault.broadcastTo },
      'HUMAN CHECKPOINT: show(force=false) broadcast — confirm popup on any connected client',
    );
  }

  // force = true
  const showForce = await page.evaluate(showJournalEntryBody, {
    entryId: entry.id,
    force: true,
  });
  if (!showForce.ok) fail('show force=true not ok', showForce);
  else {
    if (showForce.force !== true) fail('force expected true', showForce);
    log.info(
      { activeUsers: showForce.activeUsers, broadcastTo: showForce.broadcastTo },
      'HUMAN CHECKPOINT: show(force=true) broadcast — confirm popup on ALL connected clients',
    );
  }

  // missing entry rejected
  const missing = await page.evaluate(showJournalEntryBody, { entryId: 'nonexistent777' });
  if (missing.ok) fail('show missing entry should error', missing);

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
