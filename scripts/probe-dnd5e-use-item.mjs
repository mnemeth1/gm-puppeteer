/**
 * Probe + acceptance script for dnd5e_use_item. Drives the live headless
 * Foundry against the dnd5e test world (Foundry v14.361 / dnd5e 5.3.3).
 *
 * The dnd5e use/activity pipeline (settled by
 * scripts/probe-dnd5e-use-item-phase1.mjs / -phase2.mjs and encoded in
 * the evaluator JSDoc): items carry `system.activities`; the dialog-free
 * use path is `activity.use({event:{shiftKey:true}}, {configure:false},
 * {})`, raced against a 30s timeout. `cast`-type activities (spell
 * scrolls) are rejected — casting through the API orphans a cached-spell
 * item that corrupts world load.
 *
 * SAFETY MODEL — this probe must never corrupt the world, even if it
 * hangs or throws mid-run:
 *  - It operates on a DISPOSABLE actor created at start, never a
 *    canonical one. Teardown = delete that actor wholesale, which
 *    removes every item on it (incl. any orphaned cached spell) in one
 *    shot — no snapshot/restore needed.
 *  - Teardown runs in a `finally`, so a thrown/timed-out probe still
 *    cleans up.
 *  - Every tool call is raced against a 90s timeout, so a wedged
 *    pipeline call fails the probe fast instead of hanging the client.
 *  - A start-of-run scrub deletes leftover `__probe_use_item_*` actors
 *    from any prior aborted run.
 *
 * Acceptance probes:
 *   1.  Happy: use a potion (qty 3) → qty 3→2, not deleted, chat posted.
 *   2.  Happy: use it again → qty 2→1.
 *   3.  Happy: use the last one → deleted=true, quantityAfter=0.
 *   4.  Happy: explicit activityId → runs the named activity.
 *   5.  Reject: bogus actorId → ACTOR_NOT_FOUND.
 *   6.  Reject: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR.
 *   7.  Reject: item with no activities → ITEM_HAS_NO_ACTIVITIES.
 *   8.  Reject: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
 *   9.  Reject: bogus activityId → ACTIVITY_NOT_FOUND.
 *   10. Reject: spell-scroll cast activity → CAST_ACTIVITY_UNSUPPORTED
 *       (the scroll is never used, so no cached spell is created).
 *   11. Reject: depleted item → an error (USE_HAD_NO_EFFECT for a
 *       quantity-item whose uses are zeroed; NO_CHARGES_REMAINING for a
 *       genuinely charge-tracked item) — never a false success.
 *   12. Teardown verification: disposable actors are gone.
 *
 *   npm run build && node scripts/probe-dnd5e-use-item.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const CALL_TIMEOUT_MS = 90000;
const PROBE_ACTOR_NAME = '__probe_use_item_actor__';
const PROBE_VEHICLE_NAME = '__probe_use_item_vehicle__';

const tool = tools.find((t) => t.name === 'dnd5e_use_item');
if (!tool) {
  log.error('dnd5e_use_item not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

// Every tool call is raced against a timeout so a wedged pipeline call
// fails the probe fast instead of hanging the headless client.
async function invoke(args) {
  const raced = await Promise.race([
    tool
      .handler(args, { browser: session, log })
      .then((blocks) => ({ blocks }))
      .catch((err) => ({
        err:
          err instanceof Error
            ? { code: err.code, message: err.message, details: err.details }
            : { message: String(err) },
      })),
    new Promise((res) => setTimeout(() => res({ timedOut: true }), CALL_TIMEOUT_MS)),
  ]);
  if (raced.timedOut) {
    return { isError: true, error: { message: `tool call exceeded ${CALL_TIMEOUT_MS}ms` } };
  }
  if (raced.err) return { isError: true, error: raced.err };
  const block = raced.blocks?.[0];
  if (!block || block.type !== 'text') return { isError: true, raw: raced.blocks };
  try {
    return { ok: true, data: JSON.parse(block.text) };
  } catch {
    return { isError: true, raw: block.text };
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { isError: true, validation: parsed.error.issues };
  return invoke(parsed.data);
}

// --- world-side helpers (each its own page.evaluate) ------------------

async function scrubAndCreateActors(page) {
  return page.evaluate(
    async (charName, vehName) => {
      // Scrub leftover disposable actors from prior aborted runs.
      const stale = globalThis.game.actors.contents.filter(
        (a) => a.name === charName || a.name === vehName,
      );
      for (const a of stale) await a.delete();
      const char = await globalThis.Actor.create({ name: charName, type: 'character' });
      const veh = await globalThis.Actor.create({ name: vehName, type: 'vehicle' });
      return { charId: char.id, vehId: veh.id, scrubbed: stale.length };
    },
    PROBE_ACTOR_NAME,
    PROBE_VEHICLE_NAME,
  );
}

async function deleteActors(page, ids) {
  return page.evaluate(async (actorIds) => {
    const result = { deleted: 0, stillPresent: [] };
    for (const id of actorIds) {
      const a = globalThis.game.actors.get(id);
      if (a) {
        await a.delete();
        result.deleted++;
      }
    }
    for (const id of actorIds) {
      if (globalThis.game.actors.get(id)) result.stillPresent.push(id);
    }
    return result;
  }, ids);
}

// Add the Potion of Healing from a compendium UUID with a set quantity.
async function addPotion(page, actorId, potionUuid, qty, depleteUses) {
  return page.evaluate(
    async (aId, uuid, quantity, deplete) => {
      const actor = globalThis.game.actors.get(aId);
      const potion = await globalThis.fromUuid(uuid);
      const data = potion.toObject();
      delete data._id;
      data.system.quantity = quantity;
      const [item] = await actor.createEmbeddedDocuments('Item', [data]);
      if (deplete) {
        await actor.updateEmbeddedDocuments('Item', [
          { _id: item.id, 'system.uses.spent': 1 },
        ]);
      }
      return { id: item.id, activityId: item.system.activities.contents[0]?.id ?? null };
    },
    actorId,
    potionUuid,
    qty,
    depleteUses,
  );
}

// Bake a spell scroll onto the actor (carries a `cast` activity).
async function bakeScroll(page, actorId, spellUuid) {
  return page.evaluate(
    async (aId, uuid) => {
      const actor = globalThis.game.actors.get(aId);
      const ItemClass = globalThis.CONFIG.Item.documentClass;
      const spell = await globalThis.fromUuid(uuid);
      const scrollDoc = await ItemClass.createScrollFromSpell(spell, {}, { dialog: false });
      const data = scrollDoc.toObject();
      delete data._id;
      const [item] = await actor.createEmbeddedDocuments('Item', [data]);
      return { id: item.id };
    },
    actorId,
    spellUuid,
  );
}

let actorIds = [];

try {
  const { page } = await session.ensureStarted();

  // -- Fixtures: Potion of Healing + a level-1 spell. -----------------
  const fixtures = await page.evaluate(async () => {
    const game = globalThis.game;
    const itemsPack = game.packs.get('dnd5e.items');
    const itemIdx = await itemsPack.getIndex();
    const potion = itemIdx.find((e) => /potion of healing/i.test(e.name ?? ''));
    const spellPack = game.packs.get('dnd5e.spells');
    const spellIdx = await spellPack.getIndex({ fields: ['system.level'] });
    const lvl1 = spellIdx.find((e) => e.type === 'spell' && e.system?.level === 1);
    return { potionUuid: potion?.uuid ?? null, spellUuid: lvl1?.uuid ?? null };
  });
  log.info({ fixtures }, 'discovered fixtures');
  if (!fixtures.potionUuid || !fixtures.spellUuid) {
    throw new Error('precondition failed: missing potion / spell fixtures');
  }

  // -- Disposable actors. ---------------------------------------------
  const created = await scrubAndCreateActors(page);
  actorIds = [created.charId, created.vehId];
  const ACTOR_ID = created.charId;
  log.info({ created }, 'disposable actors created');

  // -- Probes 1-3: a Potion of Healing, quantity 3. -------------------
  const potion = await addPotion(page, ACTOR_ID, fixtures.potionUuid, 3, false);

  {
    const res = await call({ actorId: ACTOR_ID, itemId: potion.id });
    log.info({ probe: 1, res }, 'probe 1: use potion (qty 3 → 2)');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'used', 'probe 1: operation=used', {
        op: res.data.operation,
      });
      assert(res.data.item?.quantityBefore === 3, 'probe 1: quantityBefore=3', {
        v: res.data.item?.quantityBefore,
      });
      assert(res.data.item?.quantityAfter === 2, 'probe 1: quantityAfter=2', {
        v: res.data.item?.quantityAfter,
      });
      assert(res.data.item?.deleted === false, 'probe 1: not deleted', {
        v: res.data.item?.deleted,
      });
      assert(
        typeof res.data.chatMessageId === 'string' && res.data.chatMessageId.length > 0,
        'probe 1: chatMessageId populated',
        { v: res.data.chatMessageId },
      );
      assert(
        typeof res.data.activity?.id === 'string' && res.data.activity.id.length > 0,
        'probe 1: activity id surfaced',
        { v: res.data.activity },
      );
    }
  }

  {
    const res = await call({ actorId: ACTOR_ID, itemId: potion.id });
    log.info({ probe: 2, res }, 'probe 2: use potion again (qty 2 → 1)');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.quantityBefore === 2, 'probe 2: quantityBefore=2', {
        v: res.data.item?.quantityBefore,
      });
      assert(res.data.item?.quantityAfter === 1, 'probe 2: quantityAfter=1', {
        v: res.data.item?.quantityAfter,
      });
      assert(res.data.item?.deleted === false, 'probe 2: not deleted', {
        v: res.data.item?.deleted,
      });
    }
  }

  {
    const res = await call({ actorId: ACTOR_ID, itemId: potion.id });
    log.info({ probe: 3, res }, 'probe 3: use last potion (qty 1 → 0, autoDestroy)');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.item?.deleted === true, 'probe 3: deleted=true', {
        v: res.data.item?.deleted,
      });
      assert(res.data.item?.quantityAfter === 0, 'probe 3: quantityAfter=0', {
        v: res.data.item?.quantityAfter,
      });
    }
  }

  // -- Probe 4: explicit activityId. ----------------------------------
  {
    const p = await addPotion(page, ACTOR_ID, fixtures.potionUuid, 1, false);
    const res = await call({ actorId: ACTOR_ID, itemId: p.id, activityId: p.activityId });
    log.info({ probe: 4, res }, 'probe 4: explicit activityId');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.activity?.id === p.activityId, 'probe 4: ran the named activity', {
        expected: p.activityId,
        got: res.data.activity?.id,
      });
    }
  }

  // -- Probe 5: bogus actorId. ----------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef', itemId: 'whatever' });
    log.info({ probe: 5, res }, 'probe 5: bogus actorId');
    assert(
      res.error?.details?.reason === 'ACTOR_NOT_FOUND',
      'probe 5: reason=ACTOR_NOT_FOUND',
      { d: res.error?.details },
    );
  }

  // -- Probe 6: bogus itemId. -----------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: 'deadbeefdeadbeef' });
    log.info({ probe: 6, res }, 'probe 6: bogus itemId');
    assert(
      res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 6: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { d: res.error?.details },
    );
  }

  // -- Probe 7: item with no activities. ------------------------------
  {
    const [noActId] = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors.get(actorId);
      const c = await actor.createEmbeddedDocuments('Item', [
        { name: '__probe_noact__', type: 'loot', system: { quantity: 1 } },
      ]);
      return c.map((i) => i.id);
    }, ACTOR_ID);
    const res = await call({ actorId: ACTOR_ID, itemId: noActId });
    log.info({ probe: 7, res }, 'probe 7: item with no activities');
    assert(
      res.error?.details?.reason === 'ITEM_HAS_NO_ACTIVITIES',
      'probe 7: reason=ITEM_HAS_NO_ACTIVITIES',
      { d: res.error?.details },
    );
  }

  // -- Probe 8: unsupported actor type (the disposable vehicle). ------
  {
    const res = await call({ actorId: created.vehId, itemId: 'whatever' });
    log.info({ probe: 8, res }, 'probe 8: unsupported actor type (vehicle)');
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 8: reason=ACTOR_TYPE_UNSUPPORTED',
      { d: res.error?.details },
    );
  }

  // -- Probe 9: bogus activityId. -------------------------------------
  {
    const p = await addPotion(page, ACTOR_ID, fixtures.potionUuid, 1, false);
    const res = await call({
      actorId: ACTOR_ID,
      itemId: p.id,
      activityId: 'nonexistentactiv',
    });
    log.info({ probe: 9, res }, 'probe 9: bogus activityId');
    assert(
      res.error?.details?.reason === 'ACTIVITY_NOT_FOUND',
      'probe 9: reason=ACTIVITY_NOT_FOUND',
      { d: res.error?.details },
    );
  }

  // -- Probe 10: spell-scroll cast activity → rejected. ---------------
  // The scroll is never used (rejected before activity.use), so no
  // cached-spell item is created — this probe cannot corrupt anything.
  {
    const scroll = await bakeScroll(page, ACTOR_ID, fixtures.spellUuid);
    const res = await call({ actorId: ACTOR_ID, itemId: scroll.id });
    log.info({ probe: 10, res }, 'probe 10: spell-scroll cast activity');
    assert(
      res.error?.details?.reason === 'CAST_ACTIVITY_UNSUPPORTED',
      'probe 10: reason=CAST_ACTIVITY_UNSUPPORTED',
      { d: res.error?.details },
    );
  }

  // -- Probe 11: depleted item → NO_CHARGES_REMAINING. ----------------
  {
    const p = await addPotion(page, ACTOR_ID, fixtures.potionUuid, 1, true);
    const res = await call({ actorId: ACTOR_ID, itemId: p.id });
    log.info({ probe: 11, res }, 'probe 11: depleted potion');
    // A potion with uses zeroed still has quantity, so activity.canUse
    // stays true; the use is a silent no-op the evaluator catches as
    // USE_HAD_NO_EFFECT. A genuinely charge-tracked item (a wand at 0
    // charges) is caught earlier as NO_CHARGES_REMAINING. Either way the
    // tool must refuse with an error rather than report a false success.
    assert(res.isError === true, 'probe 11: depleted item is refused', { res });
    assert(
      res.error?.details?.reason === 'USE_HAD_NO_EFFECT' ||
        res.error?.details?.reason === 'NO_CHARGES_REMAINING',
      'probe 11: reason=USE_HAD_NO_EFFECT or NO_CHARGES_REMAINING',
      { d: res.error?.details },
    );
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe run threw',
  );
  failures.push({ label: 'probe run threw', ctx: { message: String(err?.message ?? err) } });
} finally {
  // -- Teardown ALWAYS runs: delete the disposable actors wholesale.
  // Removing the actors removes every item on them — including any
  // orphaned cached-spell document — so the world cannot be corrupted.
  try {
    const { page } = await session.ensureStarted();
    const td = await deleteActors(page, actorIds);
    log.info({ teardown: td }, 'teardown complete');
    assert(td.stillPresent.length === 0, 'probe 12: disposable actors deleted', {
      stillPresent: td.stillPresent,
    });
  } catch (tdErr) {
    log.error({ tdErr: String(tdErr?.message ?? tdErr) }, 'TEARDOWN FAILED');
    failures.push({ label: 'teardown failed', ctx: { message: String(tdErr) } });
  }

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all acceptance assertions passed');
    process.exitCode = 0;
  }
  await session.stop().catch(() => undefined);
}
