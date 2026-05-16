/**
 * Supplemental read-only probe for get_token_details. Answers gaps left
 * after probe-get-token-details.mjs Phase 1:
 *
 *   S1. texture.tint shape — Q6 fell into "other"; dump constructor name,
 *       typeof, JSON.stringify, and any string-coercion path (.css, .toString,
 *       hex-from-number).
 *   S2. v14 surprise fields — for each of `attachments, auras, delta, depth,
 *       level, locked, movementAction, occludable, ring, shape, turnMarker`,
 *       dump a small projection so we know which are worth surfacing and
 *       which are runtime-only / always-default.
 *   S3. Mirror handling — confirm v14 has no top-level mirrorX/mirrorY;
 *       check whether texture.scaleX/Y < 0 is the v14 encoding for mirroring.
 *   S4. sight full shape — Q1 showed `sight` is a top-level field but we
 *       didn't dump it. Get its full keys + values to validate the
 *       interface's sight block.
 *   S5. light full shape — same.
 *
 *   npm run build && node scripts/probe-get-token-details-supplemental.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const data = await page.evaluate(() => {
    const game = globalThis.game;
    const scenes = game?.scenes?.contents ?? [];

    const tintSamples = [];
    const v14Fields = [];
    const mirrorObservations = [];
    let firstSight = null;
    let firstLight = null;
    let firstTextureFullDump = null;

    for (const scene of scenes) {
      for (const t of scene?.tokens?.contents ?? []) {
        // S1: tint samples
        const tint = t.texture?.tint;
        if (tintSamples.length < 5) {
          let css = null;
          let toStr = null;
          let hex = null;
          try {
            css = tint?.css ?? null;
          } catch {
            /* probe: ignore getter throw */
          }
          try {
            toStr = tint?.toString?.() ?? null;
          } catch {
            /* probe: ignore getter throw */
          }
          try {
            hex = typeof tint?.toString === 'function' && typeof tint?.valueOf === 'function'
              ? tint.valueOf()
              : null;
          } catch {
            /* probe: ignore getter throw */
          }
          tintSamples.push({
            tokenId: t.id,
            name: t.name,
            typeof: typeof tint,
            constructor: tint?.constructor?.name ?? null,
            jsonStringify: (() => {
              try { return JSON.stringify(tint); } catch { return '<unserializable>'; }
            })(),
            css,
            toString: toStr,
            valueOf: hex,
            ownKeys: tint && typeof tint === 'object' ? Object.keys(tint) : [],
          });
        }

        // S2: v14 fields surface
        if (v14Fields.length < 3) {
          v14Fields.push({
            tokenId: t.id,
            name: t.name,
            attachments: t.attachments,
            auras: t.auras,
            depth: t.depth,
            level: t.level,
            locked: t.locked,
            movementAction: t.movementAction,
            occludable: t.occludable,
            shape: t.shape,
            turnMarkerType: t.turnMarker?.constructor?.name ?? typeof t.turnMarker,
            turnMarker: t.turnMarker ? JSON.parse(JSON.stringify(t.turnMarker)) : null,
            ringType: t.ring?.constructor?.name ?? typeof t.ring,
            ring: t.ring ? JSON.parse(JSON.stringify(t.ring)) : null,
            deltaType: t.delta?.constructor?.name ?? typeof t.delta,
            deltaToObjectKeys: t.delta?.toObject ? Object.keys(t.delta.toObject()).sort() : null,
          });
        }

        // S3: mirror via texture.scaleX/Y sign
        if (mirrorObservations.length < 5) {
          mirrorObservations.push({
            tokenId: t.id,
            name: t.name,
            scaleX: t.texture?.scaleX,
            scaleY: t.texture?.scaleY,
            mirrorX_topLevel: 'mirrorX' in t ? t.mirrorX : '<not present>',
            mirrorY_topLevel: 'mirrorY' in t ? t.mirrorY : '<not present>',
          });
        }

        // S4: sight full shape
        if (!firstSight) {
          firstSight = {
            tokenId: t.id,
            name: t.name,
            keys: Object.keys(t.sight ?? {}).sort(),
            json: (() => {
              try { return JSON.parse(JSON.stringify(t.sight)); } catch { return null; }
            })(),
          };
        }

        // S5: light full shape
        if (!firstLight) {
          firstLight = {
            tokenId: t.id,
            name: t.name,
            keys: Object.keys(t.light ?? {}).sort(),
            json: (() => {
              try { return JSON.parse(JSON.stringify(t.light)); } catch { return null; }
            })(),
          };
        }

        if (!firstTextureFullDump) {
          firstTextureFullDump = {
            tokenId: t.id,
            name: t.name,
            keys: Object.keys(t.texture ?? {}).sort(),
            // attempt json; tint may break it
            json: (() => {
              try { return JSON.parse(JSON.stringify(t.texture)); } catch { return '<unserializable>'; }
            })(),
          };
        }
      }
    }

    return {
      tintSamples,
      v14Fields,
      mirrorObservations,
      firstSight,
      firstLight,
      firstTextureFullDump,
    };
  });

  log.info({ samples: data.tintSamples }, 'S1: texture.tint constructor/typeof/css/toString');
  log.info({ tokens: data.v14Fields }, 'S2: v14 token fields surface');
  log.info({ observations: data.mirrorObservations }, 'S3: mirror via texture.scaleX/Y sign');
  log.info({ sight: data.firstSight }, 'S4: sight full shape (first token)');
  log.info({ light: data.firstLight }, 'S5: light full shape (first token)');
  log.info({ texture: data.firstTextureFullDump }, 'S6: texture full shape (first token)');

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'supplemental probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
