/**
 * One-shot probe: log in to the live headless Foundry, inject a synthetic
 * permanent HW-accel warning, then dump every queryable property of
 * ui.notifications WHILE the notification is live. Used to decide whether
 * an API-level dismiss is even possible in v14, or whether DOM removal is
 * the only viable path.
 *
 *   npm run build && node scripts/probe-hw-accel-dismiss.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'debug' });

const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  // The startup auto-dismiss has already run. Inject a fresh synthetic
  // warning so we can inspect ui.notifications WHILE it has live state.
  await page.evaluate(() => {
    globalThis.ui?.notifications?.warn?.(
      'Your web browser does not have hardware acceleration enabled (probe).',
      { permanent: true, console: false },
    );
  });

  // Give Foundry a moment to register the notification before we inspect.
  await new Promise((r) => setTimeout(r, 300));

  const inspection = await page.evaluate(() => {
    const ui = globalThis.ui;
    const n = ui?.notifications;
    if (!n) return { hasNotifications: false };

    const safe = (v, depth = 0) => {
      if (v == null) return v;
      const t = typeof v;
      if (t === 'function') return '<function>';
      if (t !== 'object') return v;
      if (depth > 2) return '<truncated>';
      if (Array.isArray(v)) return v.slice(0, 5).map((x) => safe(x, depth + 1));
      if (v instanceof Map) {
        const out = [];
        for (const [k, val] of v.entries()) out.push([safe(k, depth + 1), safe(val, depth + 1)]);
        return { __type: 'Map', entries: out };
      }
      const out = {};
      for (const k of Object.keys(v).slice(0, 30)) out[k] = safe(v[k], depth + 1);
      return out;
    };

    const proto = Object.getPrototypeOf(n);
    return {
      hasNotifications: true,
      ownKeys: Object.getOwnPropertyNames(n),
      protoName: proto?.constructor?.name,
      protoKeys: proto ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor') : [],
      values: Object.fromEntries(
        Object.getOwnPropertyNames(n).map((k) => {
          try {
            return [k, safe(n[k])];
          } catch (e) {
            return [k, `<error: ${e?.message ?? e}>`];
          }
        }),
      ),
      domItemCount: document.querySelectorAll('#notifications li, #notifications .notification')
        .length,
    };
  });

  log.info({ inspection }, 'ui.notifications live state with synthetic warning');

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
