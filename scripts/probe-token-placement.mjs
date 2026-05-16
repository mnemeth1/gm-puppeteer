/**
 * One-shot probe: log in to live headless Foundry and answer the v14
 * questions that gate the place_token_at_grid impl.
 *
 * Targets Foundry v14.361 + PF2e 8.1.2 with the Tavern Cellar scene active.
 *
 * Questions:
 *   1. scene.grid API surface — getTopLeftPoint / getCenterPoint /
 *      getOffset / getSnappedPoint signatures, return shapes.
 *   2. Padding / canvas origin — does grid (i:0, j:0) anchor at the padded
 *      canvas (0,0), or at the image's top-left inside the padded canvas?
 *      Probe-place at v13-math coords {x:17*50, y:17*50} and compare.
 *   3. actor.getTokenDocument({x,y}) shape — still returns a TokenDocument?
 *      What does .toObject() look like?
 *   4. Creation path — scene.createEmbeddedDocuments('Token', [...]) vs
 *      Scene.implementation.* — find the canonical entry point.
 *   5. Image bounds — placement in the padding region: allowed silently,
 *      warning, or rejected?
 *   6. Multi-square tokens — for a Large actor, is {x,y} the top-left of
 *      the 1x1 anchor or the bounding box?
 *   7. Square-occupancy — does Foundry reject placement on an already
 *      occupied square, or allow stacking?
 *
 * Auto-cleans up any tokens it places, including on error.
 *
 *   npm run build && node scripts/probe-token-placement.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_TOKEN_NAME_PREFIX = '__gm_puppeteer_probe_token__';

async function cleanupProbeTokens(page) {
  return page.evaluate(async (prefix) => {
    const scene = globalThis.game.scenes?.active;
    if (!scene) return { removed: [], reason: 'no active scene' };
    const targets = (scene.tokens?.contents ?? []).filter((t) => (t.name ?? '').startsWith(prefix));
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return { removed: [] };
    try {
      await scene.deleteEmbeddedDocuments('Token', ids);
      return { removed: ids };
    } catch (e) {
      return { removed: [], error: e?.message ?? String(e) };
    }
  }, PROBE_TOKEN_NAME_PREFIX);
}

try {
  const { page } = await session.ensureStarted();

  // --- Q0: Confirm the active scene matches expectations. ---
  const sceneInfo = await page.evaluate(() => {
    const s = globalThis.game.scenes?.active;
    if (!s) return null;
    return {
      id: s.id,
      name: s.name,
      width: s.width,
      height: s.height,
      padding: s.padding,
      backgroundSrc: s.background?.src ?? null,
      gridType: s.grid?.type,
      gridSize: s.grid?.size,
      gridDistance: s.grid?.distance,
      gridUnits: s.grid?.units,
      tokenCount: s.tokens?.size ?? 0,
      existingTokens: (s.tokens?.contents ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        actorId: t.actorId,
      })),
    };
  });
  log.info({ sceneInfo }, 'Q0: active scene');
  if (!sceneInfo) {
    log.error('No active scene; cannot continue probe');
    process.exitCode = 1;
    throw new Error('no active scene');
  }

  // --- Q1: scene.grid API surface. ---
  const gridApi = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    const g = s.grid;
    const proto = Object.getPrototypeOf(g);
    const methods = [];
    let cur = proto;
    while (cur && cur !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(cur)) {
        if (k === 'constructor') continue;
        const v = g[k];
        if (typeof v === 'function') methods.push({ name: k, length: v.length });
      }
      cur = Object.getPrototypeOf(cur);
    }
    // De-dup by name.
    const seen = new Set();
    const unique = methods.filter((m) => {
      if (seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
    return {
      ctorName: g.constructor?.name,
      type: g.type,
      size: g.size,
      sizeX: g.sizeX,
      sizeY: g.sizeY,
      distance: g.distance,
      units: g.units,
      columns: g.columns,
      methods: unique.sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
  log.info({ gridApi }, 'Q1: scene.grid surface');

  // --- Q1b: Concrete invocations of getTopLeftPoint / getOffset / getCenterPoint / getSnappedPoint. ---
  const gridCalls = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    const g = s.grid;
    const gridSize = g.size;

    const safe = (fn) => {
      try {
        return { ok: true, value: fn() };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    };

    return {
      // Try {i, j} input shape on getTopLeftPoint.
      getTopLeftPoint_ij: safe(() => g.getTopLeftPoint?.({ i: 17, j: 17 })),
      // Try [i, j] input shape too.
      getTopLeftPoint_array: safe(() => g.getTopLeftPoint?.([17, 17])),
      // {row, col} input shape (just in case).
      getTopLeftPoint_rowcol: safe(() => g.getTopLeftPoint?.({ row: 17, col: 17 })),

      getOffset_xy: safe(() => g.getOffset?.({ x: 17 * gridSize, y: 17 * gridSize })),
      // Some Foundry versions accept GridCoordinates union; try the alternate.
      getOffset_ij: safe(() => g.getOffset?.({ i: 17, j: 17 })),

      getCenterPoint_ij: safe(() => g.getCenterPoint?.({ i: 17, j: 17 })),
      getCenterPoint_xy: safe(() => g.getCenterPoint?.({ x: 17 * gridSize, y: 17 * gridSize })),

      getSnappedPoint_xy: safe(() =>
        g.getSnappedPoint?.(
          { x: 17 * gridSize + 7, y: 17 * gridSize + 12 },
          { mode: 1, resolution: 1 },
        ),
      ),
    };
  });
  log.info({ gridCalls }, 'Q1b: grid helper invocations');

  // --- Q2/Q4: round-trip a placement and observe where it lands.
  // Probe-place a token using each candidate path and read back the position.
  const valerosWorld = await page.evaluate(() => {
    const a = globalThis.game.actors?.getName('Valeros (Level 1)');
    if (!a) return null;
    return { id: a.id, name: a.name, type: a.type };
  });
  log.info({ valerosWorld }, 'Q-pre: world Valeros lookup');

  // Build a list of all world actors for the probe to pick from if Valeros (Level 1) isn't there.
  const actorList = await page.evaluate(() => {
    return (globalThis.game.actors?.contents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      prototypeWidth: a.prototypeToken?.width,
      prototypeHeight: a.prototypeToken?.height,
    }));
  });
  log.info({ count: actorList.length, sample: actorList.slice(0, 10) }, 'Q-pre: world actors');

  const placeableActor =
    actorList.find((a) => a.name === 'Valeros (Level 1)') ??
    actorList.find((a) => a.type === 'character') ??
    actorList[0];
  if (!placeableActor) {
    log.error('No world actors available; cannot run placement probes');
    process.exitCode = 1;
    throw new Error('no world actor available');
  }
  log.info({ placeableActor }, 'Q-pre: chosen actor for placement probes');

  // --- Q3 + Q2 + Q4: Place via the v13-math coords and read back. ---
  const placementProbe = await page.evaluate(
    async (actorId, namePrefix) => {
      const s = globalThis.game.scenes.active;
      const g = s.grid;
      const gridSize = g.size;
      const actor = globalThis.game.actors.get(actorId);
      if (!actor) return { error: 'actor not found' };

      // First, build a TokenDocument via the canonical Actor helper.
      // Use the v13-math coords {x: j*gridSize, y: i*gridSize} for {i:17,j:17}.
      const xV13 = 17 * gridSize;
      const yV13 = 17 * gridSize;
      let tdoc;
      try {
        tdoc = await actor.getTokenDocument({ x: xV13, y: yV13, name: namePrefix + '_v13math' });
      } catch (e) {
        return { error: 'getTokenDocument failed: ' + (e?.message ?? e) };
      }

      const tdocShape = {
        ctor: tdoc?.constructor?.name,
        documentName: tdoc?.documentName,
        hasToObject: typeof tdoc?.toObject === 'function',
        objKeysSample:
          typeof tdoc?.toObject === 'function' ? Object.keys(tdoc.toObject()).slice(0, 25) : null,
        // Read x, y, width, height, name from the doc.
        x: tdoc?.x,
        y: tdoc?.y,
        width: tdoc?.width,
        height: tdoc?.height,
        name: tdoc?.name,
        actorId: tdoc?.actorId,
        sourceActorLink: tdoc?.actorLink ?? null,
      };

      // Now creation: try scene.createEmbeddedDocuments('Token', [tdoc.toObject()]).
      // (Note: in v14 the canonical entry should be the active scene
      // instance's createEmbeddedDocuments — not Scene.create or Scene.implementation.*.)
      const data = tdoc.toObject();
      let created;
      try {
        const arr = await s.createEmbeddedDocuments('Token', [data]);
        created = arr?.[0];
      } catch (e) {
        return { tdocShape, error: 'createEmbeddedDocuments failed: ' + (e?.message ?? e) };
      }

      // Check the placed position.
      const placedX = created?.x;
      const placedY = created?.y;
      // And the offset returned by getOffset for that position.
      const offsetBack =
        typeof g.getOffset === 'function'
          ? (() => {
              try {
                return g.getOffset({ x: placedX, y: placedY });
              } catch (e) {
                return { error: e?.message ?? String(e) };
              }
            })()
          : null;

      // Inspect both helper-derived top-left and our v13 math.
      const helperTopLeft =
        typeof g.getTopLeftPoint === 'function'
          ? (() => {
              try {
                return g.getTopLeftPoint({ i: 17, j: 17 });
              } catch (e) {
                return { error: e?.message ?? String(e) };
              }
            })()
          : null;

      // Padding pixels for context.
      const padX = Math.round(s.width * s.padding);
      const padY = Math.round(s.height * s.padding);

      return {
        tdocShape,
        createdId: created?.id,
        createdName: created?.name,
        createdX: placedX,
        createdY: placedY,
        createdWidth: created?.width,
        createdHeight: created?.height,
        offsetBackFromPlacedXY: offsetBack,
        helperTopLeftFor_ij17: helperTopLeft,
        v13MathTopLeftFor_ij17: { x: xV13, y: yV13 },
        padding: s.padding,
        padPxX: padX,
        padPxY: padY,
        sceneWidth: s.width,
        sceneHeight: s.height,
      };
    },
    placeableActor.id,
    PROBE_TOKEN_NAME_PREFIX,
  );
  log.info(
    { placementProbe },
    'Q2/Q3/Q4: round-trip placement + getTokenDocument shape + creation path',
  );

  // --- Q4b: Try Scene.implementation? Look at what's exposed. ---
  const sceneClass = await page.evaluate(() => {
    return {
      hasSceneImpl: typeof Scene?.implementation === 'function',
      sceneImplName: Scene?.implementation?.name,
      sceneBaseName: Scene?.name,
      hasCreateEmbeddedDocumentsOnInstance:
        typeof globalThis.game.scenes.active?.createEmbeddedDocuments === 'function',
      // Token document class.
      hasTokenDocImpl: typeof TokenDocument?.implementation === 'function',
      tokenDocImplName: TokenDocument?.implementation?.name,
    };
  });
  log.info({ sceneClass }, 'Q4b: Scene / TokenDocument class surface');

  // --- Q2b: Try placing at the helper-blessed top-left vs v13-math top-left
  // for the SAME (i,j) — do they differ?
  const helperVsHand = await page.evaluate(
    async (actorId, namePrefix) => {
      const s = globalThis.game.scenes.active;
      const g = s.grid;
      const actor = globalThis.game.actors.get(actorId);

      const helperTL = g.getTopLeftPoint?.({ i: 12, j: 13 });
      const handTL = { x: 13 * g.size, y: 12 * g.size };

      // Place a token at the helper coord.
      let helperPlaced = null;
      if (helperTL && typeof helperTL.x === 'number') {
        const td = await actor.getTokenDocument({
          x: helperTL.x,
          y: helperTL.y,
          name: namePrefix + '_helperTL_12_13',
        });
        const arr = await s.createEmbeddedDocuments('Token', [td.toObject()]);
        helperPlaced = { id: arr?.[0]?.id, x: arr?.[0]?.x, y: arr?.[0]?.y };
      }

      // Place a token at the hand-computed coord.
      const td2 = await actor.getTokenDocument({
        x: handTL.x,
        y: handTL.y,
        name: namePrefix + '_handTL_12_13',
      });
      const arr2 = await s.createEmbeddedDocuments('Token', [td2.toObject()]);
      const handPlaced = { id: arr2?.[0]?.id, x: arr2?.[0]?.x, y: arr2?.[0]?.y };

      return { helperTL, handTL, helperPlaced, handPlaced };
    },
    placeableActor.id,
    PROBE_TOKEN_NAME_PREFIX,
  );
  log.info({ helperVsHand }, 'Q2b: helper-vs-hand placement for {i:12, j:13}');

  // --- Q5: Image bounds — what does padding cover? Try placing at {i:0, j:0}. ---
  const padProbe = await page.evaluate(
    async (actorId, namePrefix) => {
      const s = globalThis.game.scenes.active;
      const g = s.grid;
      const actor = globalThis.game.actors.get(actorId);
      const tl = g.getTopLeftPoint?.({ i: 0, j: 0 });
      let placed = null;
      let err = null;
      try {
        const td = await actor.getTokenDocument({
          x: tl?.x ?? 0,
          y: tl?.y ?? 0,
          name: namePrefix + '_padCorner_0_0',
        });
        const arr = await s.createEmbeddedDocuments('Token', [td.toObject()]);
        placed = { id: arr?.[0]?.id, x: arr?.[0]?.x, y: arr?.[0]?.y };
      } catch (e) {
        err = e?.message ?? String(e);
      }

      // Compute the image rect in canvas coords.
      const padX = Math.round(s.width * s.padding);
      const padY = Math.round(s.height * s.padding);
      const imageRect = {
        left: padX,
        top: padY,
        right: padX + s.width,
        bottom: padY + s.height,
      };
      return { tlFor00: tl, placed, err, imageRect };
    },
    placeableActor.id,
    PROBE_TOKEN_NAME_PREFIX,
  );
  log.info({ padProbe }, 'Q5: out-of-image placement at {i:0,j:0}');

  // --- Q6: Multi-square tokens. Find a Large/Huge actor if any, else
  // simulate via prototypeToken.width/height override on the probe data. ---
  const largeProbe = await page.evaluate(
    async (actorId, namePrefix) => {
      const s = globalThis.game.scenes.active;
      const g = s.grid;
      const actor = globalThis.game.actors.get(actorId);
      // Build a fake "Large" 2x2 token from this actor by overriding width/height.
      const td = await actor.getTokenDocument({
        x: g.getTopLeftPoint?.({ i: 14, j: 20 })?.x ?? 20 * g.size,
        y: g.getTopLeftPoint?.({ i: 14, j: 20 })?.y ?? 14 * g.size,
        width: 2,
        height: 2,
        name: namePrefix + '_largeSim_14_20',
      });
      const obj = td.toObject();
      const arr = await s.createEmbeddedDocuments('Token', [obj]);
      const placed = arr?.[0];
      return {
        intendedI: 14,
        intendedJ: 20,
        intendedTopLeft: g.getTopLeftPoint?.({ i: 14, j: 20 }) ?? null,
        placedX: placed?.x,
        placedY: placed?.y,
        placedWidth: placed?.width,
        placedHeight: placed?.height,
        placedId: placed?.id,
        // What does getOffset say about the placed coord?
        offsetOfPlaced:
          typeof g.getOffset === 'function'
            ? (() => {
                try {
                  return g.getOffset({ x: placed.x, y: placed.y });
                } catch (e) {
                  return { error: e?.message ?? String(e) };
                }
              })()
            : null,
      };
    },
    placeableActor.id,
    PROBE_TOKEN_NAME_PREFIX,
  );
  log.info({ largeProbe }, 'Q6: 2x2 (Large-sim) placement — {x,y} semantics');

  // --- Q7: Stacking — try to place a second token on the same square as the first one. ---
  const stackProbe = await page.evaluate(
    async (actorId, namePrefix) => {
      const s = globalThis.game.scenes.active;
      const g = s.grid;
      const actor = globalThis.game.actors.get(actorId);
      const tl = g.getTopLeftPoint?.({ i: 17, j: 17 }) ?? { x: 17 * g.size, y: 17 * g.size };
      let err = null;
      let placedId = null;
      let placedX = null;
      let placedY = null;
      try {
        const td = await actor.getTokenDocument({
          x: tl.x,
          y: tl.y,
          name: namePrefix + '_stack_17_17',
        });
        const arr = await s.createEmbeddedDocuments('Token', [td.toObject()]);
        placedId = arr?.[0]?.id;
        placedX = arr?.[0]?.x;
        placedY = arr?.[0]?.y;
      } catch (e) {
        err = e?.message ?? String(e);
      }
      return { tl, placedId, placedX, placedY, err };
    },
    placeableActor.id,
    PROBE_TOKEN_NAME_PREFIX,
  );
  log.info({ stackProbe }, 'Q7: stacking on already-occupied square');

  // --- Bonus: actorLink and linked-actor token creation — make sure
  // creating from a linked-character actor doesn't produce a sheet-prompt
  // or other surprise. Mostly a sanity log. ---
  const linkedShape = await page.evaluate((actorId) => {
    const a = globalThis.game.actors.get(actorId);
    return {
      protoActorLink: a?.prototypeToken?.actorLink,
      protoName: a?.prototypeToken?.name,
      protoWidth: a?.prototypeToken?.width,
      protoHeight: a?.prototypeToken?.height,
    };
  }, placeableActor.id);
  log.info({ linkedShape }, 'Bonus: prototypeToken shape for placed actor');

  // Cleanup before exit.
  const cleanup = await cleanupProbeTokens(page);
  log.info({ cleanup }, 'cleanup');

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  // Best-effort cleanup even on error.
  try {
    const { page } = await session.ensureStarted();
    const cleanup = await cleanupProbeTokens(page);
    log.warn({ cleanup }, 'post-failure cleanup');
  } catch {
    // Already in error path; nothing more to do.
  }
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
