/**
 * Live login smoke test for the headless Chromium session.
 *
 *   npm run debug:login                            # uses .env / defaults
 *   FOUNDRY_HEADLESS=false npm run debug:login     # watch the browser
 *
 * Drives BrowserSession exactly the way the real MCP server will, then
 * tears it down. Verbose logs and any debug-output/ artifacts written by
 * the session itself are left in place so failures are easy to inspect.
 *
 * Requires `npm run build` first — this script imports from dist/.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
// Force a verbose logger for the debug run regardless of LOG_LEVEL in env.
const log = createLogger({ logLevel: 'debug' });
log.info({ headless: config.foundryHeadless, url: config.foundryUrl }, 'debug:login starting');

const session = new BrowserSession(config, log);
const t0 = Date.now();

try {
  const { verify } = await session.ensureStarted();
  const elapsed = Date.now() - t0;
  log.info({ verify, elapsedMs: elapsed }, 'login succeeded');

  // Round-trip a trivial page.evaluate to prove the channel is healthy.
  const { page } = await session.ensureStarted();
  const sceneCount = await page.evaluate(() => globalThis.game?.scenes?.size ?? -1);
  log.info({ sceneCount }, 'page.evaluate round-trip ok');

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'login failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch((err) => log.warn({ err: String(err) }, 'stop failed'));
}
