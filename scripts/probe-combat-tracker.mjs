/**
 * Probe script for the planned combat-tracker tools (start_combat,
 * begin_combat, end_combat, add_combatants, remove_combatants,
 * get_combat_state). Drives the live headless Foundry to verify the v14
 * Combat / Combatant API surface BEFORE the evaluator code is committed.
 *
 * Verified, in order:
 *
 *   1. Create.  `getDocumentClass("Combat").create({scene, active:true})`
 *      produces a Combat: scene.id matches, active === true,
 *      game.combat.id matches, round === 0, started === false.
 *   2. Per-scene filter.  `game.combats.contents.filter(c =>
 *      c.scene?.id === sceneId)` finds exactly the combat created.
 *   3. Add combatants.  `combat.createEmbeddedDocuments("Combatant",
 *      [{tokenId, sceneId}])` for the discovered scene tokens — the
 *      minimal payload is sufficient, each combatant resolves tokenId,
 *      actorId, name, and initiative === null.
 *   4. Re-add an existing token — observe throw / duplicate / silent skip.
 *   5. begin_combat (MAIN HEADLESS RISK).  `combat.startCombat()` wrapped
 *      in an 8s Promise.race; verify it resolves with no hung initiative
 *      dialog and lands round === 1, started === true. If it is missing
 *      or hangs, the `combat.update({round:1,turn:0})` fallback is tested.
 *   6. Remove.  `combat.deleteEmbeddedDocuments("Combatant", [id])` — count
 *      drop, plus behavior on a bogus combatant id.
 *   7. End.  `combat.delete()` removes the Combat (endCombat() is NOT used
 *      — it opens a confirmation dialog).
 *
 * State model: a Combat is a world document. Combats this probe creates
 * are tagged `flags.world.gmPuppeteerProbe = true`. At start, any combat
 * still carrying that flag (a crashed prior run) is scrubbed. Teardown
 * deletes every combat created this run, then asserts no probe-flagged
 * combat remains and the combat-id set has no probe leftovers.
 *
 *   npm run build && node scripts/probe-combat-tracker.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const failures = [];

function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Setup: scrub flagged leftovers, snapshot the combat-id set, and
  // discover the active scene plus a few tokens to make combatants of.
  // --------------------------------------------------------------------
  const setup = await page.evaluate(async () => {
    const game = globalThis.game;
    const combats = game.combats?.contents ?? [];

    // Scrub combats left flagged by a crashed prior run.
    const scrubbed = [];
    for (const c of [...combats]) {
      if (c.getFlag?.('world', 'gmPuppeteerProbe')) {
        scrubbed.push(c.id);
        await c.delete();
      }
    }

    const remaining = (game.combats?.contents ?? []).map((c) => c.id);
    const scene = game.scenes?.active ?? null;
    const tokenIds = (scene?.tokens?.contents ?? []).map((t) => t.id);
    return {
      scrubbed,
      combatIdSnapshot: remaining,
      activeSceneId: scene?.id ?? null,
      activeSceneName: scene?.name ?? null,
      tokenIds,
    };
  });
  log.info({ setup }, 'setup: scrub + snapshot + scene discovery');

  if (!setup.activeSceneId) {
    log.error('no active scene — activate a scene with tokens before probing');
    process.exit(2);
  }
  if (setup.tokenIds.length < 2) {
    log.error(
      { tokenCount: setup.tokenIds.length },
      'active scene has fewer than 2 tokens — place tokens before probing',
    );
    process.exit(2);
  }
  const sceneId = setup.activeSceneId;
  const combatIdSnapshot = new Set(setup.combatIdSnapshot);
  // Up to 3 tokens for the add/remove probes.
  const probeTokenIds = setup.tokenIds.slice(0, 3);

  // --------------------------------------------------------------------
  // Probe 1 + 2: create a Combat for the scene, check fields and filter.
  // --------------------------------------------------------------------
  const created = await page.evaluate(async (sId) => {
    const game = globalThis.game;
    const cls = globalThis.getDocumentClass?.('Combat');
    if (typeof cls?.create !== 'function') {
      return { error: 'getDocumentClass("Combat").create is not a function' };
    }
    let combat;
    try {
      combat = await cls.create({
        scene: sId,
        active: true,
        flags: { world: { gmPuppeteerProbe: true } },
      });
    } catch (err) {
      return { error: `create threw: ${err?.message ?? String(err)}` };
    }
    const c = game.combats?.get(combat.id);
    const perScene = (game.combats?.contents ?? []).filter((x) => x.scene?.id === sId);
    return {
      combatId: c?.id ?? null,
      sceneId: c?.scene?.id ?? null,
      active: c?.active ?? null,
      gameCombatId: game.combat?.id ?? null,
      round: c?.round ?? null,
      started: c?.started ?? null,
      turn: c?.turn ?? null,
      hasStartCombat: typeof c?.startCombat === 'function',
      perSceneCount: perScene.length,
      perSceneIds: perScene.map((x) => x.id),
    };
  }, sceneId);
  log.info({ probe: '1+2', created }, 'probe 1+2: create combat + per-scene filter');

  if (created.error) {
    log.error({ created }, 'combat creation failed; aborting');
    process.exit(2);
  }
  const combatId = created.combatId;
  assert(typeof combatId === 'string', 'probe 1: combat created with an id', { created });
  assert(created.sceneId === sceneId, 'probe 1: combat.scene.id matches scene', { created });
  assert(created.active === true, 'probe 1: combat.active === true', { created });
  assert(created.gameCombatId === combatId, 'probe 1: game.combat is the new combat', { created });
  assert(created.round === 0, 'probe 1: round === 0 before begin', { round: created.round });
  assert(created.started === false, 'probe 1: started === false before begin', {
    started: created.started,
  });
  assert(
    created.perSceneCount === 1 && created.perSceneIds[0] === combatId,
    'probe 2: per-scene filter finds exactly the new combat',
    { created },
  );
  log.info({ hasStartCombat: created.hasStartCombat }, 'probe note: Combat#startCombat presence');

  // --------------------------------------------------------------------
  // Probe 3: add combatants from the scene tokens.
  // --------------------------------------------------------------------
  const added = await page.evaluate(
    async (cId, sId, tokenIds) => {
      const game = globalThis.game;
      const combat = game.combats?.get(cId);
      if (!combat) return { error: 'combat gone' };
      let result;
      try {
        result = await combat.createEmbeddedDocuments(
          'Combatant',
          tokenIds.map((tokenId) => ({ tokenId, sceneId: sId })),
        );
      } catch (err) {
        return { error: `createEmbeddedDocuments threw: ${err?.message ?? String(err)}` };
      }
      const c = game.combats?.get(cId);
      return {
        returnedCount: Array.isArray(result) ? result.length : null,
        combatantCount: c?.combatants?.size ?? null,
        combatants: (c?.combatants?.contents ?? []).map((cb) => ({
          id: cb.id,
          tokenId: cb.tokenId ?? null,
          actorId: cb.actorId ?? null,
          name: cb.name ?? null,
          initiative: cb.initiative ?? null,
        })),
      };
    },
    combatId,
    sceneId,
    probeTokenIds,
  );
  log.info({ probe: 3, added }, 'probe 3: add combatants');

  if (added.error) {
    log.error({ added }, 'combatant creation failed; aborting');
    process.exit(2);
  }
  assert(
    added.combatantCount === probeTokenIds.length,
    'probe 3: combatant count equals tokens added',
    { expected: probeTokenIds.length, actual: added.combatantCount },
  );
  assert(
    added.combatants.every((cb) => typeof cb.tokenId === 'string'),
    'probe 3: every combatant resolved a tokenId',
    { combatants: added.combatants },
  );
  assert(
    added.combatants.every((cb) => typeof cb.actorId === 'string'),
    'probe 3: every combatant resolved an actorId from {tokenId, sceneId}',
    { combatants: added.combatants },
  );
  assert(
    added.combatants.every((cb) => cb.initiative === null),
    'probe 3: combatants start with null initiative (not auto-rolled)',
    { combatants: added.combatants },
  );

  // --------------------------------------------------------------------
  // Probe 4: re-add an already-present token. Observe and record.
  // --------------------------------------------------------------------
  const readd = await page.evaluate(
    async (cId, sId, tokenId) => {
      const game = globalThis.game;
      const combat = game.combats?.get(cId);
      if (!combat) return { error: 'combat gone' };
      const before = combat.combatants?.size ?? null;
      let threw = null;
      let result = null;
      try {
        const r = await combat.createEmbeddedDocuments('Combatant', [{ tokenId, sceneId: sId }]);
        result = Array.isArray(r) ? r.length : null;
      } catch (err) {
        threw = err?.message ?? String(err);
      }
      const c = game.combats?.get(cId);
      return { before, after: c?.combatants?.size ?? null, threw, createdCount: result };
    },
    combatId,
    sceneId,
    probeTokenIds[0],
  );
  log.info(
    { probe: 4, readd },
    'probe 4: re-add existing token — OBSERVED behavior (throw / duplicate / skip)',
  );
  // No hard assertion: this probe records behavior. The tools pre-filter
  // existing tokenIds regardless. Log a duplicate as a notable finding.
  if (readd.after > readd.before) {
    log.warn({ readd }, 'probe 4: re-adding a token CREATED A DUPLICATE combatant');
  }

  // --------------------------------------------------------------------
  // Probe 5: begin_combat — startCombat() under an 8s timeout.
  // --------------------------------------------------------------------
  const begun = await page.evaluate(async (cId) => {
    const game = globalThis.game;
    const combat = game.combats?.get(cId);
    if (!combat) return { error: 'combat gone' };
    const hasStartCombat = typeof combat.startCombat === 'function';
    const titles = () => Object.values(globalThis.ui?.windows ?? {}).map((w) => w?.title ?? '?');
    const windowsBefore = titles();

    let path = null;
    let timedOut = false;
    let threw = null;
    if (hasStartCombat) {
      path = 'startCombat';
      try {
        await Promise.race([
          combat.startCombat(),
          new Promise((_, rej) =>
            setTimeout(() => {
              timedOut = true;
              rej(new Error('startCombat timed out after 8s'));
            }, 8000),
          ),
        ]);
      } catch (err) {
        threw = err?.message ?? String(err);
      }
    } else {
      path = 'update-fallback';
      try {
        await combat.update({ round: 1, turn: 0 });
      } catch (err) {
        threw = err?.message ?? String(err);
      }
    }
    const c = game.combats?.get(cId);
    return {
      path,
      hasStartCombat,
      timedOut,
      threw,
      round: c?.round ?? null,
      started: c?.started ?? null,
      turn: c?.turn ?? null,
      windowsBefore,
      windowsAfter: titles(),
    };
  }, combatId);
  log.info({ probe: 5, begun }, 'probe 5: begin combat (startCombat / fallback)');

  assert(!begun.timedOut, 'probe 5: begin did not hang on a dialog', { begun });
  assert(begun.threw === null, 'probe 5: begin did not throw', { begun });
  assert(begun.round === 1, 'probe 5: round === 1 after begin', { round: begun.round });
  assert(begun.started === true, 'probe 5: started === true after begin', {
    started: begun.started,
  });
  if (begun.windowsAfter.length > begun.windowsBefore.length) {
    log.warn({ begun }, 'probe 5: begin opened a UI window — possible initiative dialog; review');
  }

  // --------------------------------------------------------------------
  // Probe 6: remove a combatant; observe bogus-id behavior.
  // --------------------------------------------------------------------
  const removed = await page.evaluate(async (cId) => {
    const game = globalThis.game;
    const combat = game.combats?.get(cId);
    if (!combat) return { error: 'combat gone' };
    const before = combat.combatants?.size ?? null;
    const victim = combat.combatants?.contents?.[0]?.id ?? null;
    let removeThrew = null;
    if (victim) {
      try {
        await combat.deleteEmbeddedDocuments('Combatant', [victim]);
      } catch (err) {
        removeThrew = err?.message ?? String(err);
      }
    }
    const afterReal = game.combats?.get(cId)?.combatants?.size ?? null;

    let bogusThrew = null;
    try {
      await combat.deleteEmbeddedDocuments('Combatant', ['deadbeefdeadbeef']);
    } catch (err) {
      bogusThrew = err?.message ?? String(err);
    }
    const afterBogus = game.combats?.get(cId)?.combatants?.size ?? null;
    return { before, victim, removeThrew, afterReal, bogusThrew, afterBogus };
  }, combatId);
  log.info({ probe: 6, removed }, 'probe 6: remove combatant + bogus-id behavior');

  assert(removed.removeThrew === null, 'probe 6: removing a real combatant did not throw', {
    removed,
  });
  assert(removed.afterReal === removed.before - 1, 'probe 6: combatant count dropped by one', {
    removed,
  });

  // --------------------------------------------------------------------
  // Probe 7: end combat via combat.delete().
  // --------------------------------------------------------------------
  const ended = await page.evaluate(async (cId) => {
    const game = globalThis.game;
    const combat = game.combats?.get(cId);
    if (!combat) return { error: 'combat gone' };
    let threw = null;
    try {
      await combat.delete();
    } catch (err) {
      threw = err?.message ?? String(err);
    }
    return { threw, stillPresent: game.combats?.get(cId) != null };
  }, combatId);
  log.info({ probe: 7, ended }, 'probe 7: end combat (combat.delete)');

  assert(ended.threw === null, 'probe 7: combat.delete did not throw', { ended });
  assert(ended.stillPresent === false, 'probe 7: combat removed from game.combats', { ended });

  // --------------------------------------------------------------------
  // Teardown: delete any probe-flagged combat still present, then assert
  // the combat-id set carries no probe leftovers.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (snapshotIds) => {
      const game = globalThis.game;
      const deleted = [];
      for (const c of [...(game.combats?.contents ?? [])]) {
        if (c.getFlag?.('world', 'gmPuppeteerProbe')) {
          deleted.push(c.id);
          await c.delete();
        }
      }
      const finalIds = (game.combats?.contents ?? []).map((c) => c.id);
      const snap = new Set(snapshotIds);
      return {
        deleted,
        extraIds: finalIds.filter((id) => !snap.has(id)),
        flaggedRemaining: (game.combats?.contents ?? [])
          .filter((c) => c.getFlag?.('world', 'gmPuppeteerProbe'))
          .map((c) => c.id),
      };
    },
    [...combatIdSnapshot],
  );
  log.info({ teardown }, 'teardown: remove probe-flagged combats');

  assert(teardown.extraIds.length === 0, 'teardown: no extra combats beyond snapshot', {
    extraIds: teardown.extraIds,
  });
  assert(teardown.flaggedRemaining.length === 0, 'teardown: no probe-flagged combat remains', {
    flaggedRemaining: teardown.flaggedRemaining,
  });

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all combat-tracker probe assertions passed');
    process.exitCode = 0;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
