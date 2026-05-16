/**
 * Preflight probes for PR-2 (place_token_at_screen_pixel + move_token).
 *
 * Q1 (grid.getOffset for square grids):
 *   - Does `scene.grid.getOffset({x, y})` return `{i, j}` in v14?
 *   - Round-trip: getTopLeftPoint(getOffset({x,y})) ≈ snapped({x,y})?
 *
 * Q2 (token.update animate flag):
 *   - Does `token.update({x, y}, {animate: false})` complete cleanly?
 *   - Does `{animate: true}` also complete cleanly?
 *   - Both restore the original position at teardown.
 *
 * Captures full {x, y} snapshots before mutating, restores at end.
 *
 *   npm run build && node scripts/probe-pr2-preflight.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  // ----- Q1: scene.grid.getOffset on a square grid. -----
  const offsetProbe = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    if (!s) return { ok: false, reason: 'no active scene' };
    const g = s.grid;
    if (g.type !== 1) return { ok: false, reason: `grid type ${g.type}, not square` };
    const size = g.size;

    const cases = [];
    const tryPair = (i, j, dx, dy) => {
      const x = j * size + dx;
      const y = i * size + dy;
      const offset = g.getOffset?.({ x, y });
      const back = g.getTopLeftPoint?.(offset);
      cases.push({
        input: { x, y, expectedI: i, expectedJ: j },
        offset,
        back,
        offsetMatchesExpected: offset?.i === i && offset?.j === j,
      });
    };
    // Cell center, top-left edge, near-bottom-right edge.
    tryPair(15, 20, 25, 25);
    tryPair(0, 0, 0, 0);
    tryPair(15, 20, 0, 0);
    tryPair(15, 20, size - 1, size - 1);
    return { ok: true, gridSize: size, cases };
  });
  log.info({ offsetProbe }, 'Q1: scene.grid.getOffset shape');

  // ----- Q2: token.update with animate flag. -----
  // Use an existing token from the active scene; snapshot {x, y} and restore.
  const tokenProbe = await page.evaluate(async () => {
    const s = globalThis.game.scenes.active;
    if (!s) return { ok: false, reason: 'no active scene' };
    const tok = s.tokens?.contents?.[0];
    if (!tok) return { ok: false, reason: 'no tokens on active scene to test against' };

    const originalX = tok.x;
    const originalY = tok.y;
    const size = s.grid.size;
    const altX = originalX + size; // shift 1 cell east
    const altY = originalY;

    const results = [];

    // animate: false
    const t0a = performance.now();
    await tok.update({ x: altX, y: altY }, { animate: false });
    const t0b = performance.now();
    results.push({
      mode: 'animate-false',
      durationMs: t0b - t0a,
      afterX: tok.x,
      afterY: tok.y,
      matches: tok.x === altX && tok.y === altY,
    });

    // animate: true
    const t1a = performance.now();
    await tok.update({ x: originalX, y: originalY }, { animate: true });
    const t1b = performance.now();
    results.push({
      mode: 'animate-true',
      durationMs: t1b - t1a,
      afterX: tok.x,
      afterY: tok.y,
      matches: tok.x === originalX && tok.y === originalY,
    });

    return { ok: true, tokenId: tok.id, tokenName: tok.name, originalX, originalY, results };
  });
  log.info({ tokenProbe }, 'Q2: token.update animate flag');

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
