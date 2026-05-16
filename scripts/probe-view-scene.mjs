/**
 * Probe + acceptance script for view_scene. Drives the live headless
 * Foundry and exercises:
 *
 *   1. Happy path: view a non-active scene, assert canvas.scene.id flips
 *      to the target and game.scenes.active.id is unchanged.
 *   2. Screenshot integration: foundry_screenshot after view_scene
 *      returns a transform whose sceneDimensions match the viewed scene.
 *      This is the answer to the TODO's open question about whether
 *      Scene#view() triggers the same rendering path foundry_screenshot
 *      depends on.
 *   3. Error: bogus sceneId returns INVALID_INPUT (SCENE_NOT_FOUND).
 *
 * State restoration model: view_scene is non-destructive (it does not
 * mutate any document). The probe takes a snapshot of which scene the
 * canvas was viewing at start and calls view_scene against that id at
 * teardown so the headless GM ends the run looking at the same scene it
 * started on.
 *
 *   npm run build && node scripts/probe-view-scene.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const viewSceneTool = tools.find((t) => t.name === 'view_scene');
const listScenesTool = tools.find((t) => t.name === 'list_scenes');
const screenshotTool = tools.find((t) => t.name === 'foundry_screenshot');
if (!viewSceneTool || !listScenesTool || !screenshotTool) {
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
  // Snapshot which scene the canvas is viewing right now.
  // ----------------------------------------------------------------
  const startSnapshot = await page.evaluate(() => ({
    canvasSceneId: globalThis.canvas?.scene?.id ?? null,
    activeSceneId: globalThis.game?.scenes?.active?.id ?? null,
  }));
  log.info({ startSnapshot }, 'snapshot: starting canvas / active scene ids');

  // ----------------------------------------------------------------
  // Discovery: need at least one scene to view.
  // ----------------------------------------------------------------
  const listResp = await callTool(listScenesTool, {});
  if (!listResp.ok) {
    log.error({ listResp }, 'list_scenes failed; aborting');
    process.exit(2);
  }
  const allScenes = textBlock(listResp.blocks).scenes ?? [];
  if (allScenes.length === 0) {
    log.error('no scenes in this world; cannot probe view_scene');
    process.exit(2);
  }

  // Prefer a non-active scene as the target so we exercise the
  // not-already-viewed path. Fall back to whatever's available.
  const target =
    allScenes.find((s) => s.id !== startSnapshot.canvasSceneId) ?? allScenes[0];
  log.info(
    { targetId: target.id, targetName: target.name, targetActive: target.active },
    'discovery: chose target scene',
  );

  // ----------------------------------------------------------------
  // Probe 1: happy path.
  // ----------------------------------------------------------------
  log.info('--- Probe 1: view_scene happy path ---');
  const viewResp = await callTool(viewSceneTool, { sceneId: target.id });
  assert(viewResp.ok, 'view_scene returned ok', viewResp);
  if (viewResp.ok) {
    const viewed = textBlock(viewResp.blocks);
    assert(viewed.sceneId === target.id, 'response sceneId matches target', { viewed, target });
    assert(viewed.name === target.name, 'response name matches target', { viewed, target });

    const postState = await page.evaluate(() => ({
      canvasSceneId: globalThis.canvas?.scene?.id ?? null,
      activeSceneId: globalThis.game?.scenes?.active?.id ?? null,
    }));
    assert(postState.canvasSceneId === target.id, 'canvas.scene.id flipped to target', {
      postState,
      target,
    });
    assert(
      postState.activeSceneId === startSnapshot.activeSceneId,
      'game.scenes.active.id unchanged (view is local-only)',
      { postState, startSnapshot },
    );
  }

  // ----------------------------------------------------------------
  // Probe 2: foundry_screenshot after view_scene shows the right scene.
  // The TODO's open question — does Scene#view() trigger the
  // foundry_screenshot rendering path?
  // ----------------------------------------------------------------
  log.info('--- Probe 2: screenshot integration after view_scene ---');
  const shotResp = await callTool(screenshotTool, {});
  assert(shotResp.ok, 'foundry_screenshot returned ok', shotResp);
  if (shotResp.ok) {
    // Image is blocks[0], transform JSON is blocks[1].
    const imageBlock = shotResp.blocks.find((b) => b.type === 'image');
    assert(!!imageBlock, 'screenshot returned an image block', shotResp.blocks.map((b) => b.type));
    assert(
      typeof imageBlock?.data === 'string' && imageBlock.data.length > 0,
      'screenshot image data is non-empty',
      { dataLen: imageBlock?.data?.length },
    );

    const transformPayload = textBlock(shotResp.blocks);
    assert(transformPayload?.transform !== undefined, 'screenshot text block has transform key', {
      transformPayload,
    });
    if (transformPayload?.transform) {
      const dims = transformPayload.transform.sceneDimensions;
      log.info(
        { dims, expectedSceneId: target.id, expectedW: target.width, expectedH: target.height },
        'screenshot sceneDimensions vs target scene',
      );
      // We can't assert exact width/height because list_scenes doesn't surface
      // them — but we can confirm dims is populated and non-zero.
      assert(
        dims && typeof dims.width === 'number' && dims.width > 0,
        'transform.sceneDimensions.width is populated',
        { dims },
      );
      assert(
        dims && typeof dims.height === 'number' && dims.height > 0,
        'transform.sceneDimensions.height is populated',
        { dims },
      );
    }
  }

  // ----------------------------------------------------------------
  // Probe 3: bogus sceneId -> INVALID_INPUT (SCENE_NOT_FOUND).
  // ----------------------------------------------------------------
  log.info('--- Probe 3: bogus sceneId ---');
  const badResp = await callTool(viewSceneTool, { sceneId: 'nope_does_not_exist' });
  assert(badResp.isError, 'bogus sceneId returns isError', badResp);
  assert(badResp.error?.code === 'INVALID_INPUT', 'error code is INVALID_INPUT', badResp.error);

  // ----------------------------------------------------------------
  // Teardown: restore canvas to whatever scene we started on.
  // ----------------------------------------------------------------
  log.info('--- Teardown: restoring canvas scene ---');
  if (startSnapshot.canvasSceneId && startSnapshot.canvasSceneId !== target.id) {
    const restoreResp = await callTool(viewSceneTool, { sceneId: startSnapshot.canvasSceneId });
    assert(restoreResp.ok, 'teardown view_scene to original canvas scene succeeded', restoreResp);
    const finalState = await page.evaluate(() => ({
      canvasSceneId: globalThis.canvas?.scene?.id ?? null,
      activeSceneId: globalThis.game?.scenes?.active?.id ?? null,
    }));
    assert(
      finalState.canvasSceneId === startSnapshot.canvasSceneId,
      'post-teardown canvas matches snapshot',
      { finalState, startSnapshot },
    );
    assert(
      finalState.activeSceneId === startSnapshot.activeSceneId,
      'post-teardown active matches snapshot',
      { finalState, startSnapshot },
    );
  } else {
    log.info('teardown: target was the starting canvas scene; nothing to restore');
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
