/**
 * page.evaluate body for view_scene. Repoints the headless GM client's
 * canvas at a different scene via `Scene#view()` and waits for the
 * canvas redraw to actually commit before reporting success.
 *
 * GM-local only. `view()` changes which scene the calling client
 * (here: the headless GM) is looking at, without touching
 * `game.scenes.active` — players see no change, and screenshots taken
 * afterward capture the newly-viewed scene. The companion
 * `activate_scene` tool covers the broadcast verb.
 *
 * Why poll `canvas.scene?.id` instead of just awaiting `view()`:
 * Foundry's `Scene#view()` triggers a canvas redraw pipeline that may
 * not be fully committed by the time the promise resolves. The TODO
 * entry that motivated this tool called out exactly this question
 * ("Worth probing whether `Scene#view()` triggers the same
 * Chromium-side rendering path we depend on for `foundry_screenshot`").
 * The probe answers it; the implementation polls defensively so
 * downstream callers can chain a screenshot without a sleep.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface ViewSceneInput {
  sceneId: string;
}

export interface ViewSceneOk {
  ok: true;
  sceneId: string;
  name: string;
  active: boolean;
  width: number;
  height: number;
  padding: number;
  grid: {
    type: number;
    size: number;
    distance: number;
    units: string;
  };
}

export interface ViewSceneErr {
  ok: false;
  error: {
    code: 'SCENE_NOT_FOUND' | 'CANVAS_REDRAW_TIMEOUT' | 'VIEW_FAILED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ViewSceneResult = ViewSceneOk | ViewSceneErr;

export async function viewSceneBody(input: ViewSceneInput): Promise<ViewSceneResult> {
  interface FoundrySceneGrid {
    type?: number;
    size?: number;
    distance?: number;
    units?: string;
  }
  interface FoundrySceneLike {
    id?: string;
    name?: string;
    active?: unknown;
    width?: number;
    height?: number;
    padding?: number;
    grid?: FoundrySceneGrid;
    view(): Promise<unknown>;
  }
  interface FoundryScenesCollection {
    get(id: string): FoundrySceneLike | undefined;
  }
  interface FoundryCanvasLike {
    scene?: { id?: string } | null;
  }
  interface FoundryGameForView {
    scenes?: FoundryScenesCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForView }).game;
  const scene = game?.scenes?.get(input.sceneId);
  if (!scene) {
    return {
      ok: false,
      error: {
        code: 'SCENE_NOT_FOUND',
        message: `No scene with id "${input.sceneId}" in this world.`,
        details: { sceneId: input.sceneId },
      },
    };
  }

  try {
    await scene.view();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: 'VIEW_FAILED',
        message: `Scene#view() threw: ${message}`,
        details: { sceneId: input.sceneId },
      },
    };
  }

  // Wait for the canvas redraw to commit. ~2 second budget, polled every
  // 25ms. In practice the canvas is already settled by the time view()
  // resolves on a warm Foundry; the poll exists to defend against the
  // case where it isn't.
  const deadline = Date.now() + 2000;
  let canvasSceneId: string | null = null;
  while (Date.now() < deadline) {
    const canvas = (globalThis as unknown as { canvas?: FoundryCanvasLike }).canvas;
    canvasSceneId = canvas?.scene?.id ?? null;
    if (canvasSceneId === input.sceneId) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (canvasSceneId !== input.sceneId) {
    return {
      ok: false,
      error: {
        code: 'CANVAS_REDRAW_TIMEOUT',
        message: `Scene#view() resolved but canvas.scene.id is "${canvasSceneId ?? 'null'}" after 2s, not "${input.sceneId}".`,
        details: { sceneId: input.sceneId, canvasSceneId },
      },
    };
  }

  const grid = scene.grid ?? {};
  return {
    ok: true,
    sceneId: scene.id ?? input.sceneId,
    name: typeof scene.name === 'string' ? scene.name : '',
    active: scene.active === true,
    width: typeof scene.width === 'number' ? scene.width : 0,
    height: typeof scene.height === 'number' ? scene.height : 0,
    padding: typeof scene.padding === 'number' ? scene.padding : 0,
    grid: {
      type: typeof grid.type === 'number' ? grid.type : 0,
      size: typeof grid.size === 'number' ? grid.size : 0,
      distance: typeof grid.distance === 'number' ? grid.distance : 0,
      units: typeof grid.units === 'string' ? grid.units : '',
    },
  };
}
