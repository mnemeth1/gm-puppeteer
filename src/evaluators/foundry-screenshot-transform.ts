/**
 * page.evaluate body for the canvas-transform sidecar of
 * `foundry_screenshot`. Returns the page-pixel ↔ scene-canvas-pixel
 * transform as raw stage params plus a derived
 * `{offsetX, offsetY, scale}` helper.
 *
 * Conversion (verified by scripts/probe-canvas-transform.mjs against
 * Foundry v14.361):
 *
 *   screenPixel.x = canvasPixel.x * scale + offsetX
 *   screenPixel.y = canvasPixel.y * scale + offsetY
 *
 * Equivalent to `canvas.stage.toGlobal({x, y})`. The inverse is
 * `canvas.stage.toLocal({x, y})`; both round-trip to within
 * floating-point tolerance.
 *
 * Degradation: if the canvas isn't ready (no scene loaded, no stage,
 * called before `game.ready`), returns `{ transform: null, reason }`
 * rather than throwing. Lets `foundry_screenshot` still return the
 * image block with a graceful null sidecar.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */

export interface ScreenshotTransformOk {
  transform: {
    stage: {
      position: { x: number; y: number };
      pivot: { x: number; y: number };
      scale: number;
    };
    sceneDimensions: {
      sceneX: number;
      sceneY: number;
      sceneWidth: number;
      sceneHeight: number;
      size: number;
      distance: number;
      width: number;
      height: number;
      rows: number;
      columns: number;
    };
    /**
     * Pre-baked screen↔canvas conversion:
     *   screen.x = canvas.x * scale + offsetX
     *   screen.y = canvas.y * scale + offsetY
     */
    derived: { offsetX: number; offsetY: number; scale: number };
  };
}

export interface ScreenshotTransformDegraded {
  transform: null;
  reason: 'CANVAS_NOT_READY' | 'NO_ACTIVE_SCENE';
}

export type ScreenshotTransformResult = ScreenshotTransformOk | ScreenshotTransformDegraded;

interface PixiPoint {
  x: number;
  y: number;
}

interface FoundryStageLike {
  position?: PixiPoint;
  pivot?: PixiPoint;
  scale?: PixiPoint;
  toGlobal(p: { x: number; y: number }): PixiPoint;
}

interface FoundrySceneDimensionsLike {
  sceneX?: number;
  sceneY?: number;
  sceneWidth?: number;
  sceneHeight?: number;
  size?: number;
  distance?: number;
  width?: number;
  height?: number;
  rows?: number;
  columns?: number;
}

interface FoundrySceneLike {
  dimensions?: FoundrySceneDimensionsLike;
}

interface FoundryCanvasLike {
  stage?: FoundryStageLike;
  scene?: FoundrySceneLike | null;
}

export function foundryScreenshotTransformBody(): ScreenshotTransformResult {
  const canvas = (globalThis as unknown as { canvas?: FoundryCanvasLike }).canvas;
  const stage = canvas?.stage;
  const scene = canvas?.scene;

  if (!stage || typeof stage.toGlobal !== 'function') {
    return { transform: null, reason: 'CANVAS_NOT_READY' };
  }
  if (!scene || !scene.dimensions) {
    return { transform: null, reason: 'NO_ACTIVE_SCENE' };
  }

  const dims = scene.dimensions;
  const sceneX = dims.sceneX ?? 0;
  const sceneY = dims.sceneY ?? 0;
  const sceneTopLeftScreen = stage.toGlobal({ x: sceneX, y: sceneY });
  const scale = stage.scale?.x ?? 1;

  const offsetX = sceneTopLeftScreen.x - sceneX * scale;
  const offsetY = sceneTopLeftScreen.y - sceneY * scale;

  return {
    transform: {
      stage: {
        position: { x: stage.position?.x ?? 0, y: stage.position?.y ?? 0 },
        pivot: { x: stage.pivot?.x ?? 0, y: stage.pivot?.y ?? 0 },
        scale,
      },
      sceneDimensions: {
        sceneX,
        sceneY,
        sceneWidth: dims.sceneWidth ?? 0,
        sceneHeight: dims.sceneHeight ?? 0,
        size: dims.size ?? 0,
        distance: dims.distance ?? 0,
        width: dims.width ?? 0,
        height: dims.height ?? 0,
        rows: dims.rows ?? 0,
        columns: dims.columns ?? 0,
      },
      derived: { offsetX, offsetY, scale },
    },
  };
}
