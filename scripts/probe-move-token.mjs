/**
 * Probe + acceptance script for move_token.
 *
 * Exercises:
 *   1. {ij} input on square grid → token lands at getTopLeftPoint({i,j}),
 *      gridCoords echoes input, before/after match expected coords.
 *   2. {xy} input → token lands at exact pixel, gridCoords is null.
 *   3. Bogus tokenId → ToolError code=INVALID_INPUT.
 *   4. Both ij and xy supplied → zod refine rejects (INVALID_INPUT, schema layer).
 *   5. Neither ij nor xy supplied → zod refine rejects.
 *
 * Uses `animate: false` for all moves (default) to avoid the multi-
 * second slowness observed in probe-pr2-preflight.mjs.
 *
 * State restoration (position-only mutation):
 *  - Snapshot every token's {x, y} pre-probe.
 *  - Pick one token to move. Run cases. At end, restore that token's
 *    {x, y} via a direct token.update.
 *  - Assert final position matches snapshot.
 *
 *   npm run build && node scripts/probe-move-token.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'move_token');
if (!tool) {
  log.error('move_token not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  } else {
    log.info({ label }, 'pass');
  }
}

const ctx = { browser: session, log };

let snapshotPositions = new Map();
let targetTokenId = null;

try {
  const { page } = await session.ensureStarted();

  const initial = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    return {
      sceneId: s?.id,
      gridType: s?.grid?.type,
      gridSize: s?.grid?.size,
      tokens: (s?.tokens?.contents ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        x: t.x,
        y: t.y,
      })),
    };
  });
  if (initial.gridType !== 1) {
    log.error({ gridType: initial.gridType }, 'active scene is not square-grid; cannot probe');
    process.exit(2);
  }
  if (initial.tokens.length === 0) {
    log.error('no tokens on active scene to probe against');
    process.exit(2);
  }

  for (const t of initial.tokens) snapshotPositions.set(t.id, { x: t.x, y: t.y });

  // Use a token we know is disposable. Prefer one named with the goblin warrior.
  const target =
    initial.tokens.find((t) => t.name?.toLowerCase().includes('goblin')) ?? initial.tokens[0];
  targetTokenId = target.id;
  log.info({ target }, 'chosen token for movement probes');

  const origX = target.x;
  const origY = target.y;
  const size = initial.gridSize;

  // Case 1: {ij} input — move 2 cells east, 1 south.
  const newI = Math.round(origY / size) + 1;
  const newJ = Math.round(origX / size) + 2;
  const r1blocks = await tool.handler({ tokenId: target.id, ij: { i: newI, j: newJ } }, ctx);
  const r1 = JSON.parse(r1blocks[0].text);
  assert(r1.gridCoords?.i === newI && r1.gridCoords?.j === newJ, 'case 1 gridCoords echoes input', {
    r1,
  });
  assert(
    r1.targetCanvasCoords.x === newJ * size && r1.targetCanvasCoords.y === newI * size,
    'case 1 targetCanvasCoords = ij * size',
    { targetCanvasCoords: r1.targetCanvasCoords, expected: { x: newJ * size, y: newI * size } },
  );
  assert(
    r1.before.x === origX && r1.before.y === origY,
    'case 1 before matches original position',
    { before: r1.before, expected: { x: origX, y: origY } },
  );
  assert(r1.after.x === newJ * size && r1.after.y === newI * size, 'case 1 after matches target', {
    after: r1.after,
  });
  assert(r1.animated === false, 'case 1 animated default false', { animated: r1.animated });

  // Confirm document actually moved.
  const liveAfter1 = await page.evaluate((id) => {
    const t = globalThis.game.scenes.active.tokens.get(id);
    return t ? { x: t.x, y: t.y } : null;
  }, target.id);
  assert(
    liveAfter1?.x === newJ * size && liveAfter1?.y === newI * size,
    'case 1 live document position matches',
    { liveAfter1 },
  );

  // Case 2: {xy} input — move to an exact pixel (offset by 7 in both dims).
  const targetX = origX + 7;
  const targetY = origY + 13;
  const r2blocks = await tool.handler({ tokenId: target.id, xy: { x: targetX, y: targetY } }, ctx);
  const r2 = JSON.parse(r2blocks[0].text);
  assert(r2.gridCoords === null, 'case 2 gridCoords is null for xy input', { r2 });
  assert(
    r2.targetCanvasCoords.x === targetX && r2.targetCanvasCoords.y === targetY,
    'case 2 targetCanvasCoords matches xy input',
    { targetCanvasCoords: r2.targetCanvasCoords },
  );
  assert(r2.after.x === targetX && r2.after.y === targetY, 'case 2 after matches target', {
    after: r2.after,
  });

  // Case 3: bogus tokenId.
  try {
    await tool.handler({ tokenId: 'not-a-token', ij: { i: 0, j: 0 } }, ctx);
    failures.push({ label: 'case 3 should throw on bogus tokenId' });
  } catch (err) {
    assert(err?.code === 'INVALID_INPUT', 'case 3 INVALID_INPUT for bogus tokenId', {
      code: err?.code,
      message: err?.message,
    });
  }

  // Case 4: both ij and xy → schema refine rejection (zod throws).
  const both = tool.inputSchema.safeParse({
    tokenId: target.id,
    ij: { i: 0, j: 0 },
    xy: { x: 0, y: 0 },
  });
  assert(both.success === false, 'case 4 schema rejects both ij and xy', { both });

  // Case 5: neither ij nor xy → schema refine rejection.
  const neither = tool.inputSchema.safeParse({ tokenId: target.id });
  assert(neither.success === false, 'case 5 schema rejects neither ij nor xy', { neither });

  // Teardown: restore the target token to its original position.
  const restored = await page.evaluate(
    async (id, x, y) => {
      const t = globalThis.game.scenes.active.tokens.get(id);
      if (!t) return { ok: false, reason: 'token gone' };
      await t.update({ x, y }, { animate: false });
      const after = globalThis.game.scenes.active.tokens.get(id);
      return { ok: true, x: after?.x, y: after?.y };
    },
    target.id,
    origX,
    origY,
  );
  log.info({ restored }, 'teardown: restored target position');

  // Final invariant: all positions match the snapshot.
  const final = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    return (s?.tokens?.contents ?? []).map((t) => ({ id: t.id, x: t.x, y: t.y }));
  });
  for (const f of final) {
    const snap = snapshotPositions.get(f.id);
    if (!snap) continue; // new token created elsewhere; ignore
    assert(f.x === snap.x && f.y === snap.y, `final position matches snapshot for token ${f.id}`, {
      id: f.id,
      final: { x: f.x, y: f.y },
      snapshot: snap,
    });
  }

  if (failures.length === 0) {
    log.info('all cases passed');
    process.exitCode = 0;
  } else {
    log.error({ failures }, 'one or more cases failed');
    process.exitCode = 1;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  // Best-effort: restore the target token.
  try {
    const { page } = await session.ensureStarted();
    if (targetTokenId && snapshotPositions.has(targetTokenId)) {
      const orig = snapshotPositions.get(targetTokenId);
      await page.evaluate(
        async (id, x, y) => {
          const t = globalThis.game.scenes.active.tokens.get(id);
          if (t) await t.update({ x, y }, { animate: false });
        },
        targetTokenId,
        orig.x,
        orig.y,
      );
    }
  } catch {
    // already in error path
  }
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
