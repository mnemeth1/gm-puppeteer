/**
 * Probe + acceptance script for place_token_at_screen_pixel.
 *
 * Exercises:
 *   1. Square-grid scene + screen pixel inside a known cell → snaps to
 *      expected {i, j}, canvasCoords = grid.getTopLeftPoint({i, j}),
 *      rawCanvasCoords matches stage.toLocal output, snappedToGrid=true.
 *   2. Same scene, screen pixel near a cell-boundary → still snaps to a
 *      single cell, never a half-cell coord.
 *   3. Bogus actorId → ToolError code=INVALID_INPUT (evaluator
 *      ACTOR_NOT_FOUND → tool wrapper INVALID_INPUT).
 *   4. Bogus sceneId → ToolError code=INVALID_INPUT.
 *
 * State restoration (additive probe — over-creates only):
 *  - Pre-probe scrub: delete any token on the active scene whose name
 *    starts with PROBE_TOKEN_NAME_PREFIX (leftovers from a failed run).
 *  - Snapshot: id set of every token on the scene now.
 *  - Run cases; track every token created via the tool.
 *  - Teardown: delete every id created during the probe; assert that
 *    the final id set equals the snapshot id set.
 *
 *   npm run build && node scripts/probe-place-token-at-screen-pixel.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'place_token_at_screen_pixel');
if (!tool) {
  log.error('place_token_at_screen_pixel not registered');
  process.exit(2);
}

const PROBE_TOKEN_NAME_PREFIX = '__probe_place_screen_pixel__';
const failures = [];

function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  } else {
    log.info({ label }, 'pass');
  }
}

async function scrubPrefixed(page) {
  return page.evaluate(async (prefix) => {
    const s = globalThis.game.scenes.active;
    const ids = (s?.tokens?.contents ?? [])
      .filter((t) => (t.name ?? '').startsWith(prefix))
      .map((t) => t.id);
    if (ids.length > 0) await s.deleteEmbeddedDocuments('Token', ids);
    return ids;
  }, PROBE_TOKEN_NAME_PREFIX);
}

const createdIds = [];
let snapshotIds = new Set();
const ctx = { browser: session, log };

try {
  const { page } = await session.ensureStarted();

  await scrubPrefixed(page);

  // Snapshot pre-probe id set.
  const initial = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    return {
      sceneId: s?.id,
      tokenIds: (s?.tokens?.contents ?? []).map((t) => t.id),
      gridType: s?.grid?.type,
      gridSize: s?.grid?.size,
    };
  });
  snapshotIds = new Set(initial.tokenIds);
  log.info({ initial }, 'pre-probe scene state');
  if (initial.gridType !== 1) {
    log.error({ gridType: initial.gridType }, 'active scene is not square-grid; cannot probe');
    process.exit(2);
  }

  // Pick an actor to place.
  const actor = await page.evaluate(() => {
    const a =
      globalThis.game.actors?.getName('Goblin Warrior 1') ??
      globalThis.game.actors?.contents?.find((a) => a.type === 'npc');
    return a ? { id: a.id, name: a.name } : null;
  });
  if (!actor) {
    log.error('no NPC actor available; cannot probe');
    process.exit(2);
  }

  // For case 1: pick a known cell (i=10, j=10), compute its center in
  // canvas coords, project via toGlobal to a screen pixel, then call
  // the tool with that screen pixel and expect it to snap back.
  const setupCase1 = await page.evaluate((sceneId) => {
    const s = globalThis.game.scenes.get(sceneId);
    const g = s.grid;
    const i = 10;
    const j = 10;
    const tl = g.getTopLeftPoint({ i, j });
    const center = { x: tl.x + g.size / 2, y: tl.y + g.size / 2 };
    const screen = globalThis.canvas.stage.toGlobal(center);
    return { i, j, tl, center, screen };
  }, initial.sceneId);
  log.info({ setupCase1 }, 'case 1 setup: cell-center screen pixel');

  // Case 1: cell-center pixel.
  const r1blocks = await tool.handler(
    {
      actorId: actor.id,
      screenX: setupCase1.screen.x,
      screenY: setupCase1.screen.y,
      tokenName: PROBE_TOKEN_NAME_PREFIX + '_case1',
    },
    ctx,
  );
  const r1 = JSON.parse(r1blocks[0].text);
  createdIds.push(r1.tokenId);
  assert(r1.snappedToGrid === true, 'case 1 snappedToGrid', { r1 });
  assert(
    r1.gridCoords?.i === setupCase1.i && r1.gridCoords?.j === setupCase1.j,
    'case 1 gridCoords match input cell',
    { gridCoords: r1.gridCoords, expected: { i: setupCase1.i, j: setupCase1.j } },
  );
  assert(
    r1.canvasCoords.x === setupCase1.tl.x && r1.canvasCoords.y === setupCase1.tl.y,
    'case 1 canvasCoords == getTopLeftPoint',
    { canvasCoords: r1.canvasCoords, expected: setupCase1.tl },
  );

  // Case 2: near a cell boundary (1 px from top-left corner of cell (11, 11)).
  const setupCase2 = await page.evaluate((sceneId) => {
    const s = globalThis.game.scenes.get(sceneId);
    const g = s.grid;
    const i = 11;
    const j = 11;
    const tl = g.getTopLeftPoint({ i, j });
    const nearCorner = { x: tl.x + 1, y: tl.y + 1 };
    const screen = globalThis.canvas.stage.toGlobal(nearCorner);
    return { i, j, tl, nearCorner, screen };
  }, initial.sceneId);
  log.info({ setupCase2 }, 'case 2 setup: near-cell-corner screen pixel');

  const r2blocks = await tool.handler(
    {
      actorId: actor.id,
      screenX: setupCase2.screen.x,
      screenY: setupCase2.screen.y,
      tokenName: PROBE_TOKEN_NAME_PREFIX + '_case2',
    },
    ctx,
  );
  const r2 = JSON.parse(r2blocks[0].text);
  createdIds.push(r2.tokenId);
  assert(r2.snappedToGrid === true, 'case 2 snappedToGrid', { r2 });
  assert(
    r2.gridCoords?.i === setupCase2.i && r2.gridCoords?.j === setupCase2.j,
    'case 2 gridCoords match expected cell',
    { gridCoords: r2.gridCoords, expected: { i: setupCase2.i, j: setupCase2.j } },
  );

  // Case 3: bogus actorId.
  try {
    await tool.handler({ actorId: 'totally-not-a-real-actor', screenX: 100, screenY: 100 }, ctx);
    failures.push({ label: 'case 3 should throw on bogus actorId' });
  } catch (err) {
    assert(err?.code === 'INVALID_INPUT', 'case 3 INVALID_INPUT for bogus actorId', {
      code: err?.code,
      message: err?.message,
    });
  }

  // Case 4: bogus sceneId.
  try {
    await tool.handler(
      {
        actorId: actor.id,
        screenX: setupCase1.screen.x,
        screenY: setupCase1.screen.y,
        sceneId: 'definitely-not-a-scene',
      },
      ctx,
    );
    failures.push({ label: 'case 4 should throw on bogus sceneId' });
  } catch (err) {
    assert(err?.code === 'INVALID_INPUT', 'case 4 INVALID_INPUT for bogus sceneId', {
      code: err?.code,
      message: err?.message,
    });
  }

  // Teardown: delete every token created during the probe.
  await page.evaluate(async (ids) => {
    const s = globalThis.game.scenes.active;
    if (ids.length > 0) await s.deleteEmbeddedDocuments('Token', ids);
  }, createdIds);

  // Also scrub by prefix in case any case leaked.
  await scrubPrefixed(page);

  // Final invariant: id set is the snapshot id set.
  const finalIds = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    return (s?.tokens?.contents ?? []).map((t) => t.id);
  });
  const finalSet = new Set(finalIds);
  const added = [...finalSet].filter((id) => !snapshotIds.has(id));
  const removed = [...snapshotIds].filter((id) => !finalSet.has(id));
  assert(added.length === 0, 'no leftover token ids vs snapshot', { added });
  assert(removed.length === 0, 'no missing token ids vs snapshot', { removed });

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
  // Best-effort teardown.
  try {
    const { page } = await session.ensureStarted();
    if (createdIds.length > 0) {
      await page.evaluate(async (ids) => {
        const s = globalThis.game.scenes.active;
        if (ids.length > 0) await s.deleteEmbeddedDocuments('Token', ids);
      }, createdIds);
    }
    await scrubPrefixed(page);
  } catch {
    // already in error path
  }
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
