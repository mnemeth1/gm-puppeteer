/**
 * One-shot read-only probe: log in to live headless Foundry and answer the
 * v14.361 + PF2e 8.1.2 API questions that gate the get_world_info impl.
 *
 * No mutation, no cleanup. Just dump the field shapes of game.world,
 * game.system, the Foundry version accessor, the active scene id, and the
 * GM user identity so the typed evaluator can be built against verified
 * ground truth (per CLAUDE.md "Probe before designing").
 *
 * Questions:
 *   1. game.world shape — which properties exist, what types, what samples?
 *      Specifically: id, title, description, system (id), coreVersion,
 *      nextSession. Is `description` HTML or plain text?
 *   2. game.system shape — id, version, title presence and type.
 *   3. Foundry version source — game.version vs game.release.version vs
 *      game.release.generation. Pick the canonical accessor on v14.361.
 *   4. game.scenes.active?.id reachability and shape (already known from
 *      get_current_scene; included for sanity).
 *   5. GM user identity — game.user.name, game.user.id, game.user.role
 *      (optional fields the user can opt into post-probe).
 *
 *   npm run build && node scripts/probe-get-world-info.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const enumeration = await page.evaluate(() => {
    const game = globalThis.game;
    const describe = (v) => {
      if (v === null) return { type: 'null', sample: null };
      if (v === undefined) return { type: 'undefined', sample: null };
      const t = typeof v;
      if (t === 'string') {
        return {
          type: 'string',
          length: v.length,
          sample: v.length > 200 ? v.slice(0, 200) + '…' : v,
        };
      }
      if (t === 'number' || t === 'boolean') return { type: t, sample: v };
      if (Array.isArray(v)) return { type: 'array', length: v.length };
      if (t === 'object') {
        return {
          type: 'object',
          ctor: v?.constructor?.name ?? null,
          keys: Object.keys(v).sort(),
        };
      }
      return { type: t, sample: String(v) };
    };

    const world = game?.world ?? null;
    const worldFields = {};
    if (world && typeof world === 'object') {
      for (const k of [
        'id',
        'title',
        'description',
        'system',
        'coreVersion',
        'systemVersion',
        'nextSession',
        'background',
        'action',
        'lastPlayed',
        'playtime',
        'name',
      ]) {
        worldFields[k] = describe(world[k]);
      }
    }
    const worldAllKeys = world && typeof world === 'object' ? Object.keys(world).sort() : [];

    const system = game?.system ?? null;
    const systemFields = {};
    if (system && typeof system === 'object') {
      for (const k of ['id', 'version', 'title', 'name']) {
        systemFields[k] = describe(system[k]);
      }
    }
    const systemAllKeys = system && typeof system === 'object' ? Object.keys(system).sort() : [];

    const versionCandidates = {
      'game.version': describe(game?.version),
      'game.release': describe(game?.release),
      'game.release.version': describe(game?.release?.version),
      'game.release.generation': describe(game?.release?.generation),
      'game.release.build': describe(game?.release?.build),
      'game.data.version': describe(game?.data?.version),
    };

    const activeScene = game?.scenes?.active ?? null;
    const activeSceneInfo = activeScene
      ? {
          id: activeScene.id ?? null,
          name: activeScene.name ?? null,
          active: activeScene.active === true,
        }
      : null;

    const user = game?.user ?? null;
    const userFields = user
      ? {
          id: describe(user.id),
          name: describe(user.name),
          isGM: describe(user.isGM),
          role: describe(user.role),
        }
      : null;

    // Description HTML sniff: if string, check for tag-like content.
    const descriptionSniff =
      world && typeof world.description === 'string'
        ? {
            length: world.description.length,
            hasTags: /<[a-z][^>]*>/i.test(world.description),
            firstChars: world.description.length > 0 ? world.description.slice(0, 80) : '(empty)',
          }
        : null;

    return {
      worldPresent: world !== null,
      worldCtor: world?.constructor?.name ?? null,
      worldAllKeys,
      worldFields,
      descriptionSniff,
      systemPresent: system !== null,
      systemCtor: system?.constructor?.name ?? null,
      systemAllKeys,
      systemFields,
      versionCandidates,
      activeSceneInfo,
      userFields,
    };
  });

  log.info(
    {
      present: enumeration.worldPresent,
      ctor: enumeration.worldCtor,
      allKeys: enumeration.worldAllKeys,
    },
    'Q1a: game.world presence + all enumerable keys',
  );
  log.info(enumeration.worldFields, 'Q1b: game.world targeted field probe');
  log.info(
    enumeration.descriptionSniff ?? { reason: 'description not a string' },
    'Q1c: world.description HTML sniff',
  );
  log.info(
    {
      present: enumeration.systemPresent,
      ctor: enumeration.systemCtor,
      allKeys: enumeration.systemAllKeys,
    },
    'Q2a: game.system presence + all enumerable keys',
  );
  log.info(enumeration.systemFields, 'Q2b: game.system targeted field probe');
  log.info(
    enumeration.versionCandidates,
    'Q3: Foundry version accessor candidates (pick the populated one)',
  );
  log.info(
    enumeration.activeSceneInfo ?? { reason: 'no active scene' },
    'Q4: game.scenes.active id/name/active flag',
  );
  log.info(
    enumeration.userFields ?? { reason: 'game.user not present' },
    'Q5: game.user identity (optional fields for post-probe scope decision)',
  );

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
