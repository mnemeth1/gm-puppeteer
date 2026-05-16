/**
 * page.evaluate body for get_current_scene. Reads the currently-active
 * Scene document and projects out the fields callers actually care about.
 *
 * "Active" here is Foundry's notion of the scene flagged as the active
 * one in the world (the GM-eye icon). It is not necessarily the scene
 * currently rendered on the canvas — that is `canvas.scene`. We return
 * the active scene by default since it is the campaign-state pointer;
 * a separate viewed-scene tool can be added later if needed.
 */
export interface SceneGridInfo {
  type: number;
  size: number;
  distance: number;
  units: string;
}

export interface SceneCollectionCounts {
  walls: number;
  tokens: number;
  lights: number;
  sounds: number;
  drawings: number;
  templates: number;
  notes: number;
  regions: number;
}

export interface SceneInfo {
  id: string;
  name: string;
  active: boolean;
  width: number;
  height: number;
  padding: number;
  backgroundImage: string | null;
  foregroundImage: string | null;
  grid: SceneGridInfo;
  counts: SceneCollectionCounts;
}

export type GetCurrentSceneResult = { scene: SceneInfo } | { scene: null; reason: string };

interface FoundrySceneGrid {
  type?: number;
  size?: number;
  distance?: number;
  units?: string;
}

interface FoundrySceneAssetField {
  src?: string | null;
}

interface FoundryCollection {
  size?: number;
}

interface FoundryScene {
  id?: string;
  name?: string;
  active?: boolean;
  width?: number;
  height?: number;
  padding?: number;
  background?: FoundrySceneAssetField | null;
  foreground?: FoundrySceneAssetField | string | null;
  grid?: FoundrySceneGrid;
  walls?: FoundryCollection;
  tokens?: FoundryCollection;
  lights?: FoundryCollection;
  sounds?: FoundryCollection;
  drawings?: FoundryCollection;
  templates?: FoundryCollection;
  notes?: FoundryCollection;
  regions?: FoundryCollection;
}

interface FoundryGameForScene {
  scenes?: { active?: FoundryScene | null };
}

/**
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * helper is defined inline.
 */
export function getCurrentSceneBody(): GetCurrentSceneResult {
  const sizeOf = (c: FoundryCollection | undefined): number => c?.size ?? 0;

  const game = (globalThis as unknown as { game?: FoundryGameForScene }).game;
  const scene = game?.scenes?.active ?? null;
  if (!scene || !scene.id) {
    return { scene: null, reason: 'No scene is set as active in this world.' };
  }

  const grid = scene.grid ?? {};
  const fg = scene.foreground;
  const foregroundImage =
    fg && typeof fg === 'object' ? (fg.src ?? null) : typeof fg === 'string' ? fg : null;

  return {
    scene: {
      id: scene.id,
      name: scene.name ?? '',
      active: scene.active === true,
      width: scene.width ?? 0,
      height: scene.height ?? 0,
      padding: scene.padding ?? 0,
      backgroundImage: scene.background?.src ?? null,
      foregroundImage,
      grid: {
        type: grid.type ?? 0,
        size: grid.size ?? 0,
        distance: grid.distance ?? 0,
        units: grid.units ?? '',
      },
      counts: {
        walls: sizeOf(scene.walls),
        tokens: sizeOf(scene.tokens),
        lights: sizeOf(scene.lights),
        sounds: sizeOf(scene.sounds),
        drawings: sizeOf(scene.drawings),
        templates: sizeOf(scene.templates),
        notes: sizeOf(scene.notes),
        regions: sizeOf(scene.regions),
      },
    },
  };
}
