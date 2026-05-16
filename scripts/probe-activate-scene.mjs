/**
 * Probe + acceptance script for activate_scene. Drives the live headless
 * Foundry and exercises:
 *
 *   1. Happy path: activate a non-active scene, assert
 *      game.scenes.active.id flips to the target and the response
 *      reports active: true, noop: false.
 *   2. Idempotency: a second activate_scene call against the same id
 *      returns ok: true, noop: true.
 *   3. Error: bogus sceneId returns INVALID_INPUT (SCENE_NOT_FOUND).
 *
 * State restoration model: activate_scene mutates a world-level
 * pointer (`game.scenes.active`). The probe snapshots which scene is
 * active at start and re-activates that scene at teardown. Edge case:
 * if no scene is active at start (rare — Foundry typically keeps one
 * scene active), teardown skips restoration and logs a warning rather
 * than leaving a foreign scene active.
 *
 *   npm run build && node scripts/probe-activate-scene.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const activateSceneTool = tools.find((t) => t.name === 'activate_scene');
const listScenesTool = tools.find((t) => t.name === 'list_scenes');
if (!activateSceneTool || !listScenesTool) {
  log.error('required tool(s) not registered');
  process.exit(2);
}

const failures = [];

function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

async function callTool(tool, input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { isError: true, validation: parsed.error.issues };
  const blocks = await tool.handler(parsed.data, { browser: session, log }).catch((err) => ({
    __throw:
      err instanceof Error
        ? { code: err.code, message: err.message, details: err.details }
        : { message: String(err) },
  }));
  if (blocks?.__throw) return { isError: true, error: blocks.__throw };
  return { ok: true, blocks };
}

function textBlock(blocks, index = 0) {
  const candidates = blocks.filter((b) => b.type === 'text');
  const b = candidates[index];
  return b ? JSON.parse(b.text) : null;
}

try {
  await session.ensureStarted();
  const { page } = await session.ensureStarted();

  // ----------------------------------------------------------------
  // Snapshot the active scene at start.
  // ----------------------------------------------------------------
  const startSnapshot = await page.evaluate(() => ({
    activeSceneId: globalThis.game?.scenes?.active?.id ?? null,
  }));
  log.info({ startSnapshot }, 'snapshot: starting active scene id');

  // ----------------------------------------------------------------
  // Discovery: pick a non-active scene as target.
  // ----------------------------------------------------------------
  const listResp = await callTool(listScenesTool, {});
  if (!listResp.ok) {
    log.error({ listResp }, 'list_scenes failed; aborting');
    process.exit(2);
  }
  const allScenes = textBlock(listResp.blocks).scenes ?? [];
  if (allScenes.length < 2) {
    log.error({ count: allScenes.length }, 'need at least 2 scenes to probe activation');
    process.exit(2);
  }
  const target = allScenes.find((s) => !s.active);
  if (!target) {
    log.error('all scenes report active=true — impossible per Foundry invariants; aborting');
    process.exit(2);
  }
  log.info({ targetId: target.id, targetName: target.name }, 'discovery: chose non-active target');

  // ----------------------------------------------------------------
  // Probe 1: happy path activate.
  // ----------------------------------------------------------------
  log.info('--- Probe 1: activate_scene happy path ---');
  const activateResp = await callTool(activateSceneTool, { sceneId: target.id });
  assert(activateResp.ok, 'activate_scene returned ok', activateResp);
  if (activateResp.ok) {
    const activated = textBlock(activateResp.blocks);
    assert(activated.sceneId === target.id, 'response sceneId matches target', activated);
    assert(activated.active === true, 'response active is true', activated);
    assert(activated.noop === false, 'response noop is false on first activate', activated);

    const postState = await page.evaluate(() => ({
      activeSceneId: globalThis.game?.scenes?.active?.id ?? null,
    }));
    assert(postState.activeSceneId === target.id, 'game.scenes.active.id flipped to target', {
      postState,
      target,
    });
  }

  // ----------------------------------------------------------------
  // Probe 2: re-activating the same scene is a no-op.
  // ----------------------------------------------------------------
  log.info('--- Probe 2: idempotent activate ---');
  const repeatResp = await callTool(activateSceneTool, { sceneId: target.id });
  assert(repeatResp.ok, 'second activate_scene returned ok', repeatResp);
  if (repeatResp.ok) {
    const repeated = textBlock(repeatResp.blocks);
    assert(repeated.noop === true, 'response noop is true on re-activate', repeated);
    assert(repeated.active === true, 'response active is true on re-activate', repeated);
  }

  // ----------------------------------------------------------------
  // Probe 3: bogus sceneId -> INVALID_INPUT.
  // ----------------------------------------------------------------
  log.info('--- Probe 3: bogus sceneId ---');
  const badResp = await callTool(activateSceneTool, { sceneId: 'nope_does_not_exist' });
  assert(badResp.isError, 'bogus sceneId returns isError', badResp);
  assert(badResp.error?.code === 'INVALID_INPUT', 'error code is INVALID_INPUT', badResp.error);

  // ----------------------------------------------------------------
  // Teardown: re-activate whatever scene was active at probe start.
  // ----------------------------------------------------------------
  log.info('--- Teardown: restoring active scene ---');
  if (startSnapshot.activeSceneId && startSnapshot.activeSceneId !== target.id) {
    const restoreResp = await callTool(activateSceneTool, {
      sceneId: startSnapshot.activeSceneId,
    });
    assert(
      restoreResp.ok,
      'teardown activate_scene to original active scene succeeded',
      restoreResp,
    );
    const finalState = await page.evaluate(() => ({
      activeSceneId: globalThis.game?.scenes?.active?.id ?? null,
    }));
    assert(
      finalState.activeSceneId === startSnapshot.activeSceneId,
      'post-teardown active matches snapshot',
      { finalState, startSnapshot },
    );
  } else if (!startSnapshot.activeSceneId) {
    log.warn(
      { target: target.id },
      'no scene was active at probe start; leaving target active (Foundry has no clean deactivate)',
    );
  } else {
    log.info('teardown: target was already the active scene; nothing to restore');
  }

  if (failures.length === 0) {
    log.info('all probes passed');
    process.exitCode = 0;
  } else {
    log.error({ count: failures.length, failures }, 'probe failed');
    process.exitCode = 1;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
