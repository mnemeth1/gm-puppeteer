/**
 * page.evaluate body for activate_scene. Sets a scene as the
 * world-active scene via `Scene#activate()` — broadcasts to all
 * connected clients, replaces the scene with the star icon in the
 * navbar, and pulls every connected user's canvas to the new scene
 * (Foundry's activate-implies-view contract for the activating client
 * and broadcast-view for the others).
 *
 * Short-circuits when the requested scene is already active so a
 * caller can use this tool idempotently without producing redundant
 * activation broadcasts. The short-circuit case is reported via
 * `noop: true` so the caller can distinguish a no-op from a real
 * activation if they care.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface ActivateSceneInput {
  sceneId: string;
}

export interface ActivateSceneOk {
  ok: true;
  sceneId: string;
  name: string;
  active: true;
  noop: boolean;
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

export interface ActivateSceneErr {
  ok: false;
  error: {
    code: 'SCENE_NOT_FOUND' | 'ACTIVATE_FAILED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ActivateSceneResult = ActivateSceneOk | ActivateSceneErr;

export async function activateSceneBody(input: ActivateSceneInput): Promise<ActivateSceneResult> {
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
    activate(): Promise<unknown>;
  }
  interface FoundryScenesCollection {
    get(id: string): FoundrySceneLike | undefined;
    active?: { id?: string } | null;
  }
  interface FoundryGameForActivate {
    scenes?: FoundryScenesCollection;
  }

  const game = (globalThis as unknown as { game?: FoundryGameForActivate }).game;
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

  const wasActive = scene.active === true;
  if (!wasActive) {
    try {
      await scene.activate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: 'ACTIVATE_FAILED',
          message: `Scene#activate() threw: ${message}`,
          details: { sceneId: input.sceneId },
        },
      };
    }
    const activeAfter = game?.scenes?.active?.id ?? null;
    if (activeAfter !== input.sceneId) {
      return {
        ok: false,
        error: {
          code: 'ACTIVATE_FAILED',
          message: `Scene#activate() resolved but game.scenes.active.id is "${activeAfter ?? 'null'}", not "${input.sceneId}".`,
          details: { sceneId: input.sceneId, activeAfter },
        },
      };
    }
  }

  const grid = scene.grid ?? {};
  return {
    ok: true,
    sceneId: scene.id ?? input.sceneId,
    name: typeof scene.name === 'string' ? scene.name : '',
    active: true,
    noop: wasActive,
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
