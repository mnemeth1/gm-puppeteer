/**
 * End-to-end exercise of place_token_at_grid against live headless Foundry.
 *
 * Preconditions:
 *   - Tavern Cellar scene is active.
 *   - World contains Valeros (Level 1) (tLhy0qgJyw31QaEy) and
 *     Goblin Warrior 1 (QKC9vREnE3ajuVIF). These are the actors the
 *     previous batch's create_actor_from_compendium run created.
 *
 * Scenarios:
 *   1. Place Valeros at v13-doc-blessed {i:17, j:17} (barrel storage).
 *   2. Place Goblin Warrior 1 at {i:12, j:13} (west passage).
 *   3. Place another goblin token with tokenName="Goblin Warrior 2"
 *      — confirm the display name is overridden while actorId still
 *      points back to the same actor.
 *   4. Place a token at {i:0, j:0} — confirm outOfImageBounds=true
 *      and the call still succeeds.
 *   5. Place a token on an already-occupied square — confirm stacking
 *      is permitted.
 *   6. Error: ACTOR_NOT_FOUND for a bogus actor id.
 *   7. Error: SCENE_NOT_FOUND for a bogus sceneId.
 *   8. Screenshot to visually confirm the test-overlay tokens landed
 *      in the rooms the v13 doc described.
 *
 * Cleanup: all probe tokens are removed at the end (Valeros + Goblin
 * Warrior 1 included — we re-place them in this script and don't want
 * the test run to leave the scene populated). Adjust below if you want
 * to leave them placed for the next batch's combat-tools work.
 *
 *   npm run build && node scripts/e2e-place-token-at-grid.mjs
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const placeTool = tools.find((t) => t.name === 'place_token_at_grid');
const screenshotTool = tools.find((t) => t.name === 'foundry_screenshot');
if (!placeTool || !screenshotTool) {
  console.error('required tools not registered');
  process.exit(2);
}

const VALEROS_ID = 'tLhy0qgJyw31QaEy';
const GOBLIN_ID = 'QKC9vREnE3ajuVIF';

const createdTokenIds = [];
let failures = 0;

function check(label, ok, details = undefined) {
  if (ok) {
    log.info({ check: label }, 'PASS');
  } else {
    failures += 1;
    log.error({ check: label, ...(details ? { details } : {}) }, 'FAIL');
  }
}

async function callTool(tool, args) {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new Error(`bad input: ${JSON.stringify(parsed.error.issues)}`);
  try {
    const blocks = await tool.handler(parsed.data, { browser: session, log });
    const text = blocks.find((b) => b.type === 'text')?.text;
    const image = blocks.find((b) => b.type === 'image');
    return {
      ok: true,
      value: text ? JSON.parse(text) : null,
      ...(image ? { image } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: err?.code, message: err?.message, details: err?.details },
    };
  }
}

try {
  log.info('logging in');
  await session.ensureStarted();

  // --- Pre-clean: remove any tokens already on the active scene so the
  // probe starts from a known empty state. (The previous probe-token-placement
  // run is supposed to have cleaned up its own, but a crashed prior run could
  // have left some — be defensive.)
  log.info('pre-clean: clearing all existing tokens from active scene');
  const { page } = await session.ensureStarted();
  const preClean = await page.evaluate(async () => {
    const scene = globalThis.game.scenes?.active;
    if (!scene) return { removed: [], reason: 'no active scene' };
    const ids = (scene.tokens?.contents ?? []).map((t) => t.id);
    if (ids.length === 0) return { removed: [] };
    await scene.deleteEmbeddedDocuments('Token', ids);
    return { removed: ids };
  });
  log.info(preClean, 'pre-clean result');

  // --- Scenario 1: Valeros at barrel storage ---
  log.info('scenario 1: place Valeros at {i:17, j:17}');
  const s1 = await callTool(placeTool, { actorId: VALEROS_ID, i: 17, j: 17 });
  check('1a. ok', s1.ok, s1);
  if (s1.ok) {
    createdTokenIds.push(s1.value.tokenId);
    check(
      '1b. canvasCoords {x:850, y:850}',
      s1.value.canvasCoords.x === 850 && s1.value.canvasCoords.y === 850,
      s1.value,
    );
    check(
      '1c. gridCoords {i:17, j:17}',
      s1.value.gridCoords.i === 17 && s1.value.gridCoords.j === 17,
      s1.value,
    );
    check('1d. outOfImageBounds === false', s1.value.outOfImageBounds === false, s1.value);
    check('1e. actorLink === true (character)', s1.value.actorLink === true, s1.value);
  }

  // --- Scenario 2: Goblin Warrior 1 at west passage ---
  log.info('scenario 2: place Goblin Warrior 1 at {i:12, j:13}');
  const s2 = await callTool(placeTool, { actorId: GOBLIN_ID, i: 12, j: 13 });
  check('2a. ok', s2.ok, s2);
  if (s2.ok) {
    createdTokenIds.push(s2.value.tokenId);
    check(
      '2b. canvasCoords {x:650, y:600}',
      s2.value.canvasCoords.x === 650 && s2.value.canvasCoords.y === 600,
      s2.value,
    );
    check('2c. outOfImageBounds === false', s2.value.outOfImageBounds === false, s2.value);
    // Goblin Warrior 1 is an NPC — actorLink should be false from prototype.
    check('2d. actorLink === false (npc)', s2.value.actorLink === false, s2.value);
  }

  // --- Scenario 3: tokenName override ---
  log.info('scenario 3: place Goblin with tokenName="Goblin Warrior 2"');
  const s3 = await callTool(placeTool, {
    actorId: GOBLIN_ID,
    i: 12,
    j: 14,
    tokenName: 'Goblin Warrior 2',
  });
  check('3a. ok', s3.ok, s3);
  if (s3.ok) {
    createdTokenIds.push(s3.value.tokenId);
    check(
      '3b. tokenName === "Goblin Warrior 2"',
      s3.value.tokenName === 'Goblin Warrior 2',
      s3.value,
    );
    // Verify the placed token still references the original actorId via game state.
    const tokenLink = await page.evaluate(async (tokenId) => {
      const s = globalThis.game.scenes?.active;
      const t = s?.tokens?.get(tokenId);
      return { name: t?.name, actorId: t?.actorId };
    }, s3.value.tokenId);
    check(
      '3c. token.actorId still points to Goblin Warrior 1 actor',
      tokenLink.actorId === GOBLIN_ID,
      tokenLink,
    );
    check('3d. token.name on scene === override', tokenLink.name === 'Goblin Warrior 2', tokenLink);
  }

  // --- Scenario 4: outOfImageBounds at {i:0, j:0} ---
  log.info('scenario 4: place at {i:0, j:0} → outOfImageBounds=true');
  const s4 = await callTool(placeTool, { actorId: GOBLIN_ID, i: 0, j: 0 });
  check('4a. ok', s4.ok, s4);
  if (s4.ok) {
    createdTokenIds.push(s4.value.tokenId);
    check(
      '4b. canvasCoords {x:0, y:0}',
      s4.value.canvasCoords.x === 0 && s4.value.canvasCoords.y === 0,
      s4.value,
    );
    check('4c. outOfImageBounds === true', s4.value.outOfImageBounds === true, s4.value);
  }

  // --- Scenario 5: stacking on an already-occupied square ---
  log.info('scenario 5: place a second token on {i:17, j:17} (where Valeros is)');
  const s5 = await callTool(placeTool, {
    actorId: GOBLIN_ID,
    i: 17,
    j: 17,
    tokenName: 'Stacked Goblin',
  });
  check('5a. ok (stacking permitted)', s5.ok, s5);
  if (s5.ok) {
    createdTokenIds.push(s5.value.tokenId);
    check(
      '5b. canvasCoords {x:850, y:850} (same as Valeros)',
      s5.value.canvasCoords.x === 850 && s5.value.canvasCoords.y === 850,
      s5.value,
    );
  }

  // --- Scenario 6: ACTOR_NOT_FOUND ---
  log.info('scenario 6: ACTOR_NOT_FOUND for a bogus actor id');
  const s6 = await callTool(placeTool, { actorId: 'doesNotExist0000', i: 17, j: 17 });
  check('6a. fails', s6.ok === false, s6);
  check('6b. code === INVALID_INPUT', s6.error?.code === 'INVALID_INPUT', s6.error);
  check(
    '6c. message mentions the actor id',
    typeof s6.error?.message === 'string' && s6.error.message.includes('doesNotExist0000'),
    s6.error,
  );

  // --- Scenario 7: SCENE_NOT_FOUND ---
  log.info('scenario 7: SCENE_NOT_FOUND for a bogus sceneId');
  const s7 = await callTool(placeTool, {
    actorId: VALEROS_ID,
    i: 17,
    j: 17,
    sceneId: 'bogusSceneId0001',
  });
  check('7a. fails', s7.ok === false, s7);
  check('7b. code === INVALID_INPUT', s7.error?.code === 'INVALID_INPUT', s7.error);
  check(
    '7c. message mentions the bogus sceneId',
    typeof s7.error?.message === 'string' && s7.error.message.includes('bogusSceneId0001'),
    s7.error,
  );

  // --- Scenario 8: screenshot for visual verification ---
  log.info('scenario 8: screenshot for visual verification');
  // Pan/zoom to fit the scene first so the screenshot actually shows the map.
  await page.evaluate(async () => {
    try {
      await globalThis.canvas?.animatePan?.({ x: 875, y: 728, scale: 0.8, duration: 0 });
    } catch {
      // No-op: this is a courtesy for legible screenshots, not load-bearing.
    }
  });
  const shot = await callTool(screenshotTool, { format: 'jpeg', quality: 70 });
  if (shot.ok && shot.image) {
    const outPath = join(
      'debug-output',
      `e2e-place-token-at-grid-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`,
    );
    await writeFile(outPath, Buffer.from(shot.image.data, 'base64'));
    log.info({ outPath }, '8. screenshot written');
  } else {
    log.warn({ shot }, '8. screenshot failed (non-fatal)');
  }

  // --- Cleanup: remove every probe token we created. ---
  log.info({ count: createdTokenIds.length }, 'cleanup: deleting placed tokens');
  const cleanup = await page.evaluate(async (ids) => {
    const s = globalThis.game.scenes?.active;
    if (!s) return { removed: [], reason: 'no active scene' };
    const present = ids.filter((id) => !!s.tokens?.get(id));
    if (present.length === 0) return { removed: [] };
    try {
      await s.deleteEmbeddedDocuments('Token', present);
      return { removed: present };
    } catch (e) {
      return { removed: [], error: e?.message ?? String(e) };
    }
  }, createdTokenIds);
  log.info(cleanup, 'cleanup result');

  if (failures > 0) {
    log.error({ failures }, 'E2E FAILED');
    process.exitCode = 1;
  } else {
    log.info('E2E PASSED');
    process.exitCode = 0;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'e2e crashed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
