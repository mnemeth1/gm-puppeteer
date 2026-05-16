/**
 * One-shot read-only probe: log in to live headless Foundry and answer the
 * v14.361 + PF2e 8.1.2 API questions that gate the list_scenes impl.
 *
 * No mutation, no cleanup. Just enumerate game.scenes.contents and dump the
 * fields the projection wants to surface.
 *
 * Questions:
 *   1. Collection shape — does game.scenes.contents enumerate every scene the
 *      same way game.actors.contents does for actors? Verify shape and total.
 *   2. scene.active consistency — is the flag always a boolean? Is exactly one
 *      scene reported active (Foundry's invariant) or can the world be in a
 *      no-active or multi-active state?
 *   3. scene.folder shape — same as actor.folder ({id, name, ...} document or
 *      null)? Decides whether folderId surfacing matches the actor pattern.
 *   4. scene.id / scene.name presence — any missing or non-string? Defensive
 *      filtering vs. assume-string in the projection.
 *   5. Projection preview — log one row per scene with the v1 projection so
 *      the output can be eyeballed before shipping.
 *
 *   npm run build && node scripts/probe-list-scenes.mjs
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
    const all = game?.scenes?.contents ?? [];

    const rows = [];
    let idMissing = 0;
    let idNonString = 0;
    let nameMissing = 0;
    let nameNonString = 0;
    let activeTrue = 0;
    let activeFalse = 0;
    let activeOther = 0;
    const activeTypes = {};
    const folderShapes = new Set();
    const folderSamples = [];

    for (const s of all) {
      const id = s?.id;
      if (id == null) idMissing += 1;
      else if (typeof id !== 'string') idNonString += 1;

      const name = s?.name;
      if (name == null) nameMissing += 1;
      else if (typeof name !== 'string') nameNonString += 1;

      const active = s?.active;
      const activeType = typeof active;
      activeTypes[activeType] = (activeTypes[activeType] ?? 0) + 1;
      if (active === true) activeTrue += 1;
      else if (active === false) activeFalse += 1;
      else activeOther += 1;

      const folder = s?.folder ?? null;
      if (folder === null) {
        folderShapes.add('null');
      } else if (typeof folder === 'object') {
        const keys = Object.keys(folder).sort().join(',');
        folderShapes.add(`obj:{${keys}}`);
        if (folderSamples.length < 3) {
          folderSamples.push({
            sceneName: s?.name,
            id: folder?.id ?? null,
            name: folder?.name ?? null,
            ctor: folder?.constructor?.name ?? null,
          });
        }
      } else {
        folderShapes.add(`prim:${typeof folder}`);
      }

      rows.push({
        id: typeof id === 'string' ? id : null,
        name: typeof name === 'string' ? name : null,
        active: active === true,
        folderId: folder && typeof folder === 'object' ? (folder.id ?? null) : null,
      });
    }

    return {
      total: all.length,
      idMissing,
      idNonString,
      nameMissing,
      nameNonString,
      activeTrue,
      activeFalse,
      activeOther,
      activeTypes,
      folderShapes: Array.from(folderShapes).sort(),
      folderSamples,
      rows,
    };
  });

  log.info(
    {
      total: enumeration.total,
    },
    'Q1: game.scenes.contents total count',
  );
  log.info(
    {
      idMissing: enumeration.idMissing,
      idNonString: enumeration.idNonString,
      nameMissing: enumeration.nameMissing,
      nameNonString: enumeration.nameNonString,
    },
    'Q4: scene.id / scene.name presence (expect 0 / 0 / 0 / 0)',
  );
  log.info(
    {
      activeTrue: enumeration.activeTrue,
      activeFalse: enumeration.activeFalse,
      activeOther: enumeration.activeOther,
      activeTypes: enumeration.activeTypes,
    },
    'Q2: scene.active distribution (expect 1 / N-1 / 0, all boolean)',
  );
  log.info(
    {
      shapes: enumeration.folderShapes,
      samples: enumeration.folderSamples,
    },
    'Q3: scene.folder shape',
  );
  log.info({ rows: enumeration.rows }, 'Q5: projection preview (one row per scene)');

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
