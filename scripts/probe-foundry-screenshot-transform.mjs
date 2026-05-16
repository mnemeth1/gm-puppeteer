/**
 * Verification probe for `foundry_screenshot`'s mixed-block return
 * shape. Asserts that the tool returns BOTH an image block and a
 * JSON sidecar carrying a self-consistent canvas transform.
 *
 * Cases:
 *   1. Default JPEG, no clip — 2 blocks, JPEG MIME, transform present,
 *      derived offset self-consistent with raw stage params.
 *   2. PNG with clip — 2 blocks, PNG MIME, clip echo matches input.
 *   3. Apply derived offset to a known canvas point and confirm the
 *      result agrees with what `canvas.stage.toGlobal` produces live
 *      (queried via the eval tool).
 *
 * Read-only — no scene state is mutated.
 *
 *   npm run build && node scripts/probe-foundry-screenshot-transform.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { foundryScreenshotTool } from '../dist/tools/foundry-screenshot.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);
const ctx = { browser: session, log };

function assert(cond, msg, extras) {
  if (!cond) {
    log.error({ extras }, `ASSERT FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

function parseSidecar(blocks) {
  assert(Array.isArray(blocks), 'response is an array');
  assert(blocks.length === 2, `expected 2 blocks, got ${blocks.length}`, { blocks });
  const [image, text] = blocks;
  assert(image.type === 'image', 'first block is image', { image });
  assert(typeof image.data === 'string' && image.data.length > 0, 'image data non-empty');
  assert(text.type === 'text', 'second block is text', { text });
  const sidecar = JSON.parse(text.text);
  return { image, sidecar };
}

try {
  // Case 1: default JPEG, no clip.
  const r1 = await foundryScreenshotTool.handler({}, ctx);
  const { image: img1, sidecar: side1 } = parseSidecar(r1);
  assert(img1.mimeType === 'image/jpeg', `case 1 MIME is jpeg, got ${img1.mimeType}`);
  assert(side1.clip === null, 'case 1 clip echo is null', { clip: side1.clip });
  assert(side1.transform !== undefined, 'case 1 has transform field');
  assert(side1.transform !== null, 'case 1 transform is non-null (canvas should be ready)', {
    transform: side1.transform,
  });
  const t1 = side1.transform;
  assert(typeof t1.derived.offsetX === 'number', 'derived.offsetX is number');
  assert(typeof t1.derived.offsetY === 'number', 'derived.offsetY is number');
  assert(typeof t1.derived.scale === 'number', 'derived.scale is number');
  assert(typeof t1.sceneDimensions.sceneWidth === 'number', 'sceneDimensions populated');
  log.info(
    {
      mime: img1.mimeType,
      bytes: img1.data.length,
      derived: t1.derived,
      sceneDims: t1.sceneDimensions,
    },
    'case 1 ok (default JPEG)',
  );

  // Case 2: PNG with clip.
  const clipInput = { x: 100, y: 100, width: 80, height: 80 };
  const r2 = await foundryScreenshotTool.handler({ format: 'png', clip: clipInput }, ctx);
  const { image: img2, sidecar: side2 } = parseSidecar(r2);
  assert(img2.mimeType === 'image/png', `case 2 MIME is png, got ${img2.mimeType}`);
  assert(
    side2.clip && side2.clip.x === 100 && side2.clip.width === 80,
    'case 2 clip echo matches input',
    { echoed: side2.clip, sent: clipInput },
  );
  log.info({ mime: img2.mimeType, clip: side2.clip }, 'case 2 ok (PNG with clip)');

  // Case 3: live-cross-check derived offset against stage.toGlobal.
  const { page } = await session.ensureStarted();
  const probePts = [
    { x: 0, y: 0 },
    { x: t1.sceneDimensions.sceneX, y: t1.sceneDimensions.sceneY },
    { x: 500, y: 300 },
  ];
  const live = await page.evaluate((pts) => {
    return pts.map((p) => globalThis.canvas.stage.toGlobal(p));
  }, probePts);
  for (let idx = 0; idx < probePts.length; idx++) {
    const canvasPt = probePts[idx];
    const liveScreen = live[idx];
    const formulaScreen = {
      x: canvasPt.x * t1.derived.scale + t1.derived.offsetX,
      y: canvasPt.y * t1.derived.scale + t1.derived.offsetY,
    };
    const dx = Math.abs(liveScreen.x - formulaScreen.x);
    const dy = Math.abs(liveScreen.y - formulaScreen.y);
    assert(dx < 0.01 && dy < 0.01, `case 3 point ${idx} derived agrees with toGlobal`, {
      canvasPt,
      liveScreen,
      formulaScreen,
      dx,
      dy,
    });
  }
  log.info({ checked: probePts.length }, 'case 3 ok (derived ↔ toGlobal consistency)');

  log.info('all cases passed');
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
