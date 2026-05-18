/**
 * Probe script for the roll_npcs tool. Drives the live headless Foundry
 * to verify the v14 `Combat#rollNPC()` API surface BEFORE trusting the
 * evaluator code.
 *
 * Verified, in order:
 *
 *   1. Setup.  Scrub probe-flagged combats from a crashed prior run,
 *      snapshot the combat-id and chat-message-id sets, discover the
 *      active scene and its tokens.
 *   2. Create + add.  `getDocumentClass("Combat").create(...)` flagged
 *      `flags.world.gmPuppeteerProbe`, then add the scene tokens as
 *      combatants. Record each combatant's `isNPC`.
 *   3. rollNPC presence + roll (MAIN HEADLESS RISK).  `combat.rollNPC()`
 *      exists, is wrapped in an 8s Promise.race, resolves with no hung
 *      dialog and no new UI window; every NPC combatant lacking
 *      initiative gains a numeric score; non-NPC combatants are left
 *      null. Chat-message delta is recorded (informational).
 *   4. Idempotent re-roll.  A second `rollNPC()` leaves already-rolled
 *      NPC initiatives unchanged.
 *   5. Mid-combat.  After `startCombat()` (round 1), a freshly-added
 *      combatant (null initiative) is still rolled by `rollNPC()`.
 *
 * State model: combats created here are flagged
 * `flags.world.gmPuppeteerProbe = true`; teardown deletes them and every
 * chat message created since the start snapshot (rollNPC posts initiative
 * messages), then asserts no probe leftovers remain.
 *
 *   npm run build && node scripts/probe-roll-npcs.mjs
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
  // Setup: scrub flagged leftovers, snapshot combat + chat-message ids,
  // discover the active scene and its tokens.
  // --------------------------------------------------------------------
  const setup = await page.evaluate(async () => {
    const game = globalThis.game;
    for (const c of [...(game.combats?.contents ?? [])]) {
      if (c.getFlag?.('world', 'gmPuppeteerProbe')) await c.delete();
    }
    const scene = game.scenes?.active ?? null;
    return {
      combatIdSnapshot: (game.combats?.contents ?? []).map((c) => c.id),
      messageIdSnapshot: (game.messages?.contents ?? []).map((m) => m.id),
      activeSceneId: scene?.id ?? null,
      activeSceneName: scene?.name ?? null,
      tokenIds: (scene?.tokens?.contents ?? []).map((t) => t.id),
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
  const probeTokenIds = setup.tokenIds.slice(0, 3);

  // --------------------------------------------------------------------
  // Probe 1: create a flagged Combat and add the scene tokens.
  // --------------------------------------------------------------------
  const created = await page.evaluate(
    async (sId, tokenIds) => {
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
        await combat.createEmbeddedDocuments(
          'Combatant',
          tokenIds.map((tokenId) => ({ tokenId, sceneId: sId })),
        );
      } catch (err) {
        return { error: `create/add threw: ${err?.message ?? String(err)}` };
      }
      const c = game.combats?.get(combat.id);
      return {
        combatId: c?.id ?? null,
        hasRollNPC: typeof c?.rollNPC === 'function',
        combatants: (c?.combatants?.contents ?? []).map((cb) => ({
          id: cb.id,
          tokenId: cb.tokenId ?? null,
          name: cb.name ?? null,
          isNPC: cb.isNPC === true,
          initiative: cb.initiative ?? null,
        })),
      };
    },
    sceneId,
    probeTokenIds,
  );
  log.info({ probe: 1, created }, 'probe 1: create combat + add combatants');

  if (created.error) {
    log.error({ created }, 'combat creation failed; aborting');
    process.exit(2);
  }
  const combatId = created.combatId;
  assert(created.hasRollNPC, 'probe 1: Combat#rollNPC is a function', {
    hasRollNPC: created.hasRollNPC,
  });
  assert(
    created.combatants.every((cb) => cb.initiative === null),
    'probe 1: combatants start with null initiative',
    { combatants: created.combatants },
  );

  const npcCombatants = created.combatants.filter((cb) => cb.isNPC);
  if (npcCombatants.length === 0) {
    log.error(
      { combatants: created.combatants },
      'no NPC combatants on the active scene — roll_npcs cannot be probed; ' +
        'use a scene with NPC/monster tokens',
    );
    process.exit(2);
  }
  log.info(
    { npcCount: npcCombatants.length, pcCount: created.combatants.length - npcCombatants.length },
    'probe 1: combatant NPC/PC split',
  );

  // --------------------------------------------------------------------
  // Probe 2: rollNPC() under an 8s timeout — the main headless risk.
  // --------------------------------------------------------------------
  const rolled = await page.evaluate(async (cId) => {
    const game = globalThis.game;
    const combat = game.combats?.get(cId);
    if (!combat) return { error: 'combat gone' };
    const titles = () => Object.values(globalThis.ui?.windows ?? {}).map((w) => w?.title ?? '?');
    const windowsBefore = titles();
    const messagesBefore = game.messages?.size ?? 0;

    let timedOut = false;
    let threw = null;
    try {
      await Promise.race([
        combat.rollNPC(),
        new Promise((_, rej) =>
          setTimeout(() => {
            timedOut = true;
            rej(new Error('rollNPC timed out after 8s'));
          }, 8000),
        ),
      ]);
    } catch (err) {
      threw = err?.message ?? String(err);
    }
    const c = game.combats?.get(cId);
    return {
      timedOut,
      threw,
      windowsBefore,
      windowsAfter: titles(),
      messageDelta: (game.messages?.size ?? 0) - messagesBefore,
      combatants: (c?.combatants?.contents ?? []).map((cb) => ({
        id: cb.id,
        name: cb.name ?? null,
        isNPC: cb.isNPC === true,
        initiative: cb.initiative ?? null,
      })),
    };
  }, combatId);
  log.info({ probe: 2, rolled }, 'probe 2: rollNPC()');

  if (rolled.error) {
    log.error({ rolled }, 'rollNPC probe failed; aborting');
    process.exit(2);
  }
  assert(!rolled.timedOut, 'probe 2: rollNPC did not hang', { rolled });
  assert(rolled.threw === null, 'probe 2: rollNPC did not throw', { threw: rolled.threw });
  assert(
    rolled.combatants.filter((cb) => cb.isNPC).every((cb) => typeof cb.initiative === 'number'),
    'probe 2: every NPC combatant has a numeric initiative after rollNPC',
    { combatants: rolled.combatants },
  );
  assert(
    rolled.combatants.filter((cb) => !cb.isNPC).every((cb) => cb.initiative === null),
    'probe 2: non-NPC combatants were NOT rolled',
    { combatants: rolled.combatants },
  );
  if (rolled.windowsAfter.length > rolled.windowsBefore.length) {
    log.warn({ rolled }, 'probe 2: rollNPC opened a UI window — review');
  }
  log.info({ messageDelta: rolled.messageDelta }, 'probe 2 note: chat messages posted by rollNPC');

  // --------------------------------------------------------------------
  // Probe 3: a second rollNPC() leaves already-rolled NPCs unchanged.
  // --------------------------------------------------------------------
  const initBefore = Object.fromEntries(rolled.combatants.map((cb) => [cb.id, cb.initiative]));
  const reroll = await page.evaluate(async (cId) => {
    const game = globalThis.game;
    const combat = game.combats?.get(cId);
    if (!combat) return { error: 'combat gone' };
    let threw = null;
    try {
      await Promise.race([
        combat.rollNPC(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
    } catch (err) {
      threw = err?.message ?? String(err);
    }
    const c = game.combats?.get(cId);
    return {
      threw,
      combatants: (c?.combatants?.contents ?? []).map((cb) => ({
        id: cb.id,
        initiative: cb.initiative ?? null,
      })),
    };
  }, combatId);
  log.info({ probe: 3, reroll }, 'probe 3: second rollNPC() is idempotent');

  assert(
    reroll.threw === null || reroll.threw === undefined,
    'probe 3: second rollNPC did not throw',
    {
      threw: reroll.threw,
    },
  );
  assert(
    (reroll.combatants ?? []).every((cb) => cb.initiative === initBefore[cb.id]),
    'probe 3: already-rolled NPC initiatives unchanged by a second rollNPC',
    { before: initBefore, after: reroll.combatants },
  );

  // --------------------------------------------------------------------
  // Probe 4: mid-combat — after startCombat(), a freshly-added combatant
  // (null initiative) is still rolled by rollNPC().
  // --------------------------------------------------------------------
  const npcTokenId = npcCombatants[0].tokenId;
  const midCombat = await page.evaluate(
    async (cId, sId, tokenId) => {
      const game = globalThis.game;
      const combat = game.combats?.get(cId);
      if (!combat) return { error: 'combat gone' };
      try {
        await Promise.race([
          combat.startCombat(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        // Adding an already-present token creates a fresh combatant with
        // null initiative — a stand-in for an NPC joining mid-combat.
        const made = await combat.createEmbeddedDocuments('Combatant', [{ tokenId, sceneId: sId }]);
        const freshId = Array.isArray(made) ? made[0]?.id : null;
        const c1 = game.combats?.get(cId);
        const freshBefore =
          c1?.combatants?.contents?.find((cb) => cb.id === freshId)?.initiative ?? null;
        await Promise.race([
          combat.rollNPC(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        const c2 = game.combats?.get(cId);
        return {
          round: c2?.round ?? null,
          started: c2?.started ?? null,
          freshId,
          freshBefore,
          freshAfter: c2?.combatants?.contents?.find((cb) => cb.id === freshId)?.initiative ?? null,
        };
      } catch (err) {
        return { error: `mid-combat threw: ${err?.message ?? String(err)}` };
      }
    },
    combatId,
    sceneId,
    npcTokenId,
  );
  log.info({ probe: 4, midCombat }, 'probe 4: rollNPC mid-combat');

  if (midCombat.error) {
    log.error({ midCombat }, 'mid-combat probe errored');
    failures.push({ label: 'probe 4: mid-combat probe errored', ctx: midCombat });
  } else {
    assert(midCombat.round === 1, 'probe 4: combat is at round 1 (started)', {
      round: midCombat.round,
    });
    assert(
      midCombat.freshBefore === null,
      'probe 4: fresh combatant started with null initiative',
      {
        freshBefore: midCombat.freshBefore,
      },
    );
    assert(
      typeof midCombat.freshAfter === 'number',
      'probe 4: rollNPC rolled the mid-combat NPC combatant',
      { freshAfter: midCombat.freshAfter },
    );
  }

  // --------------------------------------------------------------------
  // Teardown: delete probe-flagged combats and every chat message created
  // since the start snapshot, then assert no leftovers remain.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (combatSnapshot, messageSnapshot) => {
      const game = globalThis.game;
      const deletedCombats = [];
      for (const c of [...(game.combats?.contents ?? [])]) {
        if (c.getFlag?.('world', 'gmPuppeteerProbe')) {
          deletedCombats.push(c.id);
          await c.delete();
        }
      }
      const msgSnap = new Set(messageSnapshot);
      const newMessageIds = (game.messages?.contents ?? [])
        .map((m) => m.id)
        .filter((id) => !msgSnap.has(id));
      if (newMessageIds.length > 0) {
        await globalThis.getDocumentClass('ChatMessage').deleteDocuments(newMessageIds);
      }
      const combatSnap = new Set(combatSnapshot);
      return {
        deletedCombats,
        deletedMessages: newMessageIds.length,
        extraCombats: (game.combats?.contents ?? [])
          .map((c) => c.id)
          .filter((id) => !combatSnap.has(id)),
        flaggedRemaining: (game.combats?.contents ?? [])
          .filter((c) => c.getFlag?.('world', 'gmPuppeteerProbe'))
          .map((c) => c.id),
      };
    },
    [...combatIdSnapshot],
    setup.messageIdSnapshot,
  );
  log.info({ teardown }, 'teardown: remove probe combats + chat messages');

  assert(teardown.extraCombats.length === 0, 'teardown: no extra combats beyond snapshot', {
    extraCombats: teardown.extraCombats,
  });
  assert(teardown.flaggedRemaining.length === 0, 'teardown: no probe-flagged combat remains', {
    flaggedRemaining: teardown.flaggedRemaining,
  });

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all roll_npcs probe assertions passed');
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
