/**
 * One-shot probe: extract the screenshot↔canvas transform from a live
 * headless Foundry session and verify two-way conversion is consistent.
 *
 * Targets Foundry v14.361. Drives the design of
 * `src/evaluators/foundry-screenshot-transform.ts`.
 *
 * Questions:
 *   1. What does `canvas.stage.{position, pivot, scale}` look like at rest?
 *   2. Does `canvas.scene.dimensions` carry `sceneX/sceneY/sceneWidth/sceneHeight`?
 *   3. Can we derive a simple `{offsetX, offsetY, scale}` from those numbers
 *      such that `screen = canvas * scale + offset` round-trips through
 *      `stage.toGlobal({x, y})` for any canvas pixel?
 *   4. Does `stage.toGlobal(stage.toLocal(p))` equal `p` (and vice versa)?
 *
 *   npm run build && node scripts/probe-canvas-transform.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const payload = await page.evaluate(() => {
    const c = globalThis.canvas;
    const stage = c?.stage;
    const scene = c?.scene;
    if (!stage || !scene) {
      return { ok: false, reason: 'no canvas/stage/scene at probe time' };
    }

    const dims = scene.dimensions;
    const sceneTopLeftCanvas = { x: dims?.sceneX ?? 0, y: dims?.sceneY ?? 0 };
    const sceneBottomRightCanvas = {
      x: (dims?.sceneX ?? 0) + (dims?.sceneWidth ?? 0),
      y: (dims?.sceneY ?? 0) + (dims?.sceneHeight ?? 0),
    };

    const sceneTopLeftScreen = stage.toGlobal(sceneTopLeftCanvas);

    const derived = {
      offsetX: sceneTopLeftScreen.x - sceneTopLeftCanvas.x,
      offsetY: sceneTopLeftScreen.y - sceneTopLeftCanvas.y,
      scale: stage.scale?.x ?? 1,
    };

    // Cross-check: for several canvas points, formula should match toGlobal.
    const checkPoints = [
      { x: 0, y: 0 },
      { x: 100, y: 200 },
      { x: dims?.sceneX ?? 0, y: dims?.sceneY ?? 0 },
      sceneBottomRightCanvas,
    ];
    const checks = checkPoints.map((canvasPt) => {
      const viaToGlobal = stage.toGlobal(canvasPt);
      const viaFormula = {
        x: canvasPt.x * derived.scale + derived.offsetX,
        y: canvasPt.y * derived.scale + derived.offsetY,
      };
      const dx = Math.abs(viaToGlobal.x - viaFormula.x);
      const dy = Math.abs(viaToGlobal.y - viaFormula.y);
      return { canvasPt, viaToGlobal, viaFormula, dx, dy, agree: dx < 0.01 && dy < 0.01 };
    });

    // Round-trip: toLocal(toGlobal(p)) should equal p.
    const roundtrips = checkPoints.map((p) => {
      const screen = stage.toGlobal(p);
      const back = stage.toLocal(screen);
      const dx = Math.abs(back.x - p.x);
      const dy = Math.abs(back.y - p.y);
      return { canvasPt: p, screen, backToCanvas: back, dx, dy, agree: dx < 0.01 && dy < 0.01 };
    });

    return {
      ok: true,
      stage: {
        position: { x: stage.position?.x, y: stage.position?.y },
        pivot: { x: stage.pivot?.x, y: stage.pivot?.y },
        scale: { x: stage.scale?.x, y: stage.scale?.y },
      },
      sceneDimensions: {
        sceneX: dims?.sceneX,
        sceneY: dims?.sceneY,
        sceneWidth: dims?.sceneWidth,
        sceneHeight: dims?.sceneHeight,
        size: dims?.size,
        distance: dims?.distance,
        width: dims?.width,
        height: dims?.height,
        rows: dims?.rows,
        columns: dims?.columns,
      },
      derived,
      checks,
      roundtrips,
      viewport: {
        width: c.app?.renderer?.screen?.width,
        height: c.app?.renderer?.screen?.height,
      },
    };
  });

  log.info({ payload }, 'canvas-transform probe payload');
  if (!payload.ok) {
    log.error('probe failed — no canvas/stage/scene available');
    process.exitCode = 1;
  } else {
    const allChecksAgree = payload.checks.every((c) => c.agree);
    const allRoundtripsAgree = payload.roundtrips.every((r) => r.agree);
    log.info({ allChecksAgree, allRoundtripsAgree }, 'consistency summary');
    if (!allChecksAgree || !allRoundtripsAgree) {
      log.error('transform derivation inconsistent with toGlobal/toLocal');
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
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
