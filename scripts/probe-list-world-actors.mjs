/**
 * One-shot read-only probe: log in to live headless Foundry and answer the
 * v14.361 + PF2e 8.1.2 API questions that gate the list_world_actors impl.
 *
 * No mutation, no cleanup. Just enumerate game.actors.contents and dump the
 * fields the projection wants to surface.
 *
 * Questions:
 *   1. Type distribution — what actor.type values exist in this world?
 *      Decides which non-PC types (hazard / loot / party / vehicle / army)
 *      the projection has to handle gracefully.
 *   2. Level path on non-character types — is system.details.level.value
 *      present on hazard / loot / party? The projection needs to coerce
 *      missing-or-non-finite to null without crashing.
 *   3. UUID presence — is actor.uuid consistently a non-empty string?
 *      Should be ("Actor.<id>"), but verify before narrowing the type.
 *   4. Folder shape — actor.folder is what (id only? {id, name}? null)?
 *      Decides whether v1 surfaces a folderId field at all.
 *
 *   npm run build && node scripts/probe-list-world-actors.mjs
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
    const all = game?.actors?.contents ?? [];

    const typeCounts = {};
    const rows = [];
    let uuidMissing = 0;
    let uuidNonString = 0;
    const folderShapes = new Set();
    const folderSamples = [];
    const levelByType = {};

    for (const a of all) {
      const t = a?.type ?? '<undefined>';
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;

      const uuid = a?.uuid;
      if (uuid == null) uuidMissing += 1;
      else if (typeof uuid !== 'string') uuidNonString += 1;

      const folder = a?.folder ?? null;
      if (folder === null) {
        folderShapes.add('null');
      } else if (typeof folder === 'object') {
        const keys = Object.keys(folder).sort().join(',');
        folderShapes.add(`obj:{${keys}}`);
        if (folderSamples.length < 3) {
          folderSamples.push({
            actorName: a?.name,
            id: folder?.id ?? null,
            name: folder?.name ?? null,
            ctor: folder?.constructor?.name ?? null,
          });
        }
      } else {
        folderShapes.add(`prim:${typeof folder}`);
      }

      const sys = a?.system ?? {};
      const lvlValue = sys?.details?.level?.value;
      const lvlBare = sys?.details?.level;
      const levelEntry = levelByType[t] ?? {
        sampled: 0,
        levelValuePresent: 0,
        levelValueFinite: 0,
        levelBareIsObject: 0,
        levelBareMissing: 0,
      };
      levelEntry.sampled += 1;
      if (lvlValue !== undefined) levelEntry.levelValuePresent += 1;
      if (typeof lvlValue === 'number' && Number.isFinite(lvlValue))
        levelEntry.levelValueFinite += 1;
      if (lvlBare && typeof lvlBare === 'object') levelEntry.levelBareIsObject += 1;
      if (lvlBare === undefined) levelEntry.levelBareMissing += 1;
      levelByType[t] = levelEntry;

      rows.push({
        id: a?.id ?? null,
        uuid: typeof uuid === 'string' ? uuid : null,
        name: a?.name ?? null,
        type: t,
        levelValue: typeof lvlValue === 'number' ? lvlValue : null,
        folderId: folder && typeof folder === 'object' ? (folder.id ?? null) : null,
      });
    }

    return {
      total: all.length,
      typeCounts,
      uuidMissing,
      uuidNonString,
      folderShapes: Array.from(folderShapes).sort(),
      folderSamples,
      levelByType,
      rows,
    };
  });

  log.info(
    {
      total: enumeration.total,
      typeCounts: enumeration.typeCounts,
    },
    'Q1: actor.type distribution',
  );
  log.info(
    {
      uuidMissing: enumeration.uuidMissing,
      uuidNonString: enumeration.uuidNonString,
    },
    'Q3: actor.uuid presence (expect 0 / 0)',
  );
  log.info(
    {
      shapes: enumeration.folderShapes,
      samples: enumeration.folderSamples,
    },
    'Q4: actor.folder shape',
  );
  log.info(
    { levelByType: enumeration.levelByType },
    'Q2: system.details.level.value presence by actor.type',
  );
  log.info({ rows: enumeration.rows }, 'projection preview (one row per actor)');

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
