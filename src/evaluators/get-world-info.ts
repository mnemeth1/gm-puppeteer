/**
 * page.evaluate body for get_world_info. Projects top-level Foundry world
 * metadata useful for orienting a fresh MCP session: which world, which
 * system, which Foundry version, which scene is active, and which user the
 * headless GM is logged in as.
 *
 * Field shapes are verified against live Foundry v14.361 + PF2e 8.1.2 by
 * `scripts/probe-get-world-info.mjs`. Notable findings encoded here:
 *
 *  - `game.world.description` is a string (HTML when populated; empty
 *    string when not). Passed through verbatim — callers strip/render as
 *    needed. We do not normalize to null on empty.
 *  - `game.version` and `game.release.version` carry the same string
 *    ("14.361"). We expose `game.version` as the flat version string and
 *    additionally project `game.release.generation` (14) and
 *    `game.release.build` (361) for callers that need the parts.
 *  - `game.system.title` is the human-readable name ("Pathfinder Second
 *    Edition"); `game.system.id` is the stable id ("pf2e").
 *  - `game.user.role` is a numeric Foundry permission level (4 = GM).
 *    Passed through as a number; we do not map to a name string.
 */
export interface WorldDescriptor {
  id: string;
  title: string;
  description: string;
}

export interface SystemDescriptor {
  id: string;
  version: string;
  title: string;
}

export interface FoundryDescriptor {
  version: string;
  generation: number;
  build: number;
}

export interface ActiveSceneDescriptor {
  id: string;
  name: string;
}

export interface UserDescriptor {
  id: string;
  name: string;
  isGM: boolean;
  role: number;
}

export interface WorldInfo {
  world: WorldDescriptor;
  system: SystemDescriptor;
  foundry: FoundryDescriptor;
  activeScene: ActiveSceneDescriptor | null;
  user: UserDescriptor;
}

export type GetWorldInfoResult = { world: WorldInfo } | { world: null; reason: string };

interface FoundryWorld {
  id?: string;
  title?: string;
  description?: string;
}

interface FoundrySystem {
  id?: string;
  version?: string;
  title?: string;
}

interface FoundryRelease {
  version?: string;
  generation?: number;
  build?: number;
}

interface FoundryActiveScene {
  id?: string;
  name?: string;
}

interface FoundryUser {
  id?: string;
  name?: string;
  isGM?: boolean;
  role?: number;
}

interface FoundryGameForWorldInfo {
  world?: FoundryWorld | null;
  system?: FoundrySystem | null;
  version?: string;
  release?: FoundryRelease | null;
  scenes?: { active?: FoundryActiveScene | null };
  user?: FoundryUser | null;
}

/**
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers and outer closures are NOT available at runtime — keep everything
 * the function needs inline.
 */
export function getWorldInfoBody(): GetWorldInfoResult {
  const game = (globalThis as unknown as { game?: FoundryGameForWorldInfo }).game;
  if (!game) {
    return { world: null, reason: 'Foundry game object not ready.' };
  }

  const world = game.world;
  if (!world || !world.id) {
    return { world: null, reason: 'game.world is missing or has no id.' };
  }

  const system = game.system;
  if (!system || !system.id) {
    return { world: null, reason: 'game.system is missing or has no id.' };
  }

  const user = game.user;
  if (!user || !user.id) {
    return { world: null, reason: 'game.user is missing or has no id.' };
  }

  const release = game.release ?? {};
  const active = game.scenes?.active ?? null;
  const activeScene: ActiveSceneDescriptor | null =
    active && active.id ? { id: active.id, name: active.name ?? '' } : null;

  return {
    world: {
      world: {
        id: world.id,
        title: world.title ?? '',
        description: world.description ?? '',
      },
      system: {
        id: system.id,
        version: system.version ?? '',
        title: system.title ?? '',
      },
      foundry: {
        version: game.version ?? '',
        generation: release.generation ?? 0,
        build: release.build ?? 0,
      },
      activeScene,
      user: {
        id: user.id,
        name: user.name ?? '',
        isGM: user.isGM === true,
        role: typeof user.role === 'number' ? user.role : 0,
      },
    },
  };
}
