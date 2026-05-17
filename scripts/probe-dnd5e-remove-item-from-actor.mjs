/**
 * Probe + acceptance script for dnd5e_remove_item_from_actor. Drives the
 * live headless Foundry against the dnd5e test world (Foundry v14.361 /
 * dnd5e 5.3.3).
 *
 * Phase 1 discovery findings (now baked into the evaluator JSDoc):
 *   Q1: deleting a `type:"container"` item ORPHANS its contents — they
 *       survive with `system.container` dangling at the deleted id. The
 *       tool ejects them to root (nulls `system.container`) itself.
 *   Q2: only depth-1 children of the deleted container are affected.
 *   Q3: `system.quantity` 0 persists (no auto-delete); negative clamps to 0.
 *   Q4: `item.name` is the MASKED name on an unidentified item.
 *
 * Acceptance probes (run against the tool):
 *   1.  Delete a physical item → operation=deleted, qtyAtDelete=1.
 *   2.  Delete a non-physical item (synthetic feat) → qtyAtDelete=null.
 *   3.  Decrement > 0 → operation=decremented, qtyAfter correct.
 *   4.  Decrement to exactly 0, deleteIfZero default true →
 *       operation=decrementedAndDeleted.
 *   5.  Decrement to 0, deleteIfZero:false → operation=decremented,
 *       qtyAfter=0, entry persists.
 *   6.  Decrement past 0 (clamp) → collapses to decrementedAndDeleted.
 *   7.  Delete a populated container → operation=deleted, the contained
 *       item is in ejectedToTopLevel and survives with container=null.
 *   8.  Error: bogus actorId → ACTOR_NOT_FOUND.
 *   9.  Error: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR.
 *   10. Error: unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped if
 *       the world has no vehicle/group/encounter actor).
 *   11. Error: delete with quantity → zod validation rejection.
 *   12. Error: decrement quantity 0 → zod validation rejection.
 *   13. Error: decrement on a non-physical item → DECREMENT_ON_NON_PHYSICAL.
 *   14. Teardown verification: signature-multiset match with the snapshot.
 *
 * State restoration (destructive tool — probes over-delete): at probe
 * start, snapshot every item as {id, name, type, qty, container, payload:
 * toObject()}. At probe end: delete orphans, recreate any missing snapshot
 * id from its saved payload (Foundry assigns a new id), restore drifted
 * quantities, then assert the post-teardown name|type|qty|container
 * signature multiset equals the snapshot's. See CLAUDE.md "Snapshot full
 * toObject() payloads when probing destructive tools".
 *
 *   npm run build && node scripts/probe-dnd5e-remove-item-from-actor.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_remove_item_from_actor');
if (!tool) {
  log.error('dnd5e_remove_item_from_actor not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { isError: true, validation: parsed.error.issues };
  }
  const blocks = await tool.handler(parsed.data, { browser: session, log }).catch((err) => ({
    __throw:
      err instanceof Error
        ? { code: err.code, message: err.message, details: err.details }
        : { message: String(err) },
  }));
  if (blocks?.__throw) return { isError: true, error: blocks.__throw };
  const block = blocks?.[0];
  if (!block || block.type !== 'text') return { isError: true, raw: blocks };
  try {
    return { ok: true, data: JSON.parse(block.text) };
  } catch {
    return { isError: true, raw: block.text };
  }
}

// Create test items on the actor via raw createEmbeddedDocuments; returns
// the created ids in order.
async function createItems(page, actorId, specs) {
  return page.evaluate(
    async (aId, itemSpecs) => {
      const actor = globalThis.game.actors.get(aId);
      const datas = [];
      for (const spec of itemSpecs) {
        let data;
        if (spec.sourceUuid) {
          const src = await fromUuid(spec.sourceUuid);
          data = src.toObject();
        } else {
          data = { name: spec.name ?? '__probe', type: spec.type };
        }
        data.system = { ...(data.system ?? {}) };
        if (typeof spec.quantity === 'number') data.system.quantity = spec.quantity;
        if (spec.container !== undefined) data.system.container = spec.container;
        datas.push(data);
      }
      const created = await actor.createEmbeddedDocuments('Item', datas);
      return created.map((i) => i.id);
    },
    actorId,
    specs,
  );
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Resolve a probe-target character actor + an unsupported-type actor.
  // --------------------------------------------------------------------
  const actorIds = await page.evaluate(() => {
    const pc = globalThis.game.actors.find((a) => a.type === 'character');
    const other = globalThis.game.actors.find(
      (a) => a.type !== 'character' && a.type !== 'npc',
    );
    return {
      pc: pc ? { id: pc.id, name: pc.name } : null,
      other: other ? { id: other.id, name: other.name, type: other.type } : null,
    };
  });
  if (!actorIds.pc) {
    log.error({ actorIds }, 'probe aborted: world needs a character actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const ACTOR_ID = actorIds.pc.id;
  log.info({ actorIds }, 'resolved test actors');

  // --------------------------------------------------------------------
  // Snapshot: full toObject() payloads for destructive-tool teardown.
  // --------------------------------------------------------------------
  const snapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors.get(actorId);
    return {
      itemCount: actor.items.size,
      items: actor.items.contents.map((i) => ({
        id: i.id,
        name: i.name ?? '',
        type: i.type ?? '',
        qty: typeof i.system?.quantity === 'number' ? i.system.quantity : 1,
        container:
          typeof i.system?.container === 'string' && i.system.container.length > 0
            ? i.system.container
            : null,
        payload: i.toObject(),
      })),
    };
  }, ACTOR_ID);
  log.info({ itemCount: snapshot.itemCount }, 'snapshot captured');

  // --------------------------------------------------------------------
  // Discovery: a physical item UUID and a container UUID from compendia.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(async () => {
    const game = globalThis.game;
    const itemPacks = game.packs.filter((p) => p.documentName === 'Item');
    let physical = null;
    let container = null;
    for (const pack of itemPacks) {
      let idx;
      try {
        idx = await pack.getIndex();
      } catch {
        continue;
      }
      for (const e of idx.contents) {
        const uuid = e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`;
        const type = e.type ?? '';
        if (!physical && (type === 'weapon' || type === 'equipment' || type === 'consumable')) {
          physical = { uuid, name: e.name ?? '', type };
        }
        if (!container && type === 'container') {
          container = { uuid, name: e.name ?? '', type };
        }
      }
      if (physical && container) break;
    }
    return { physical, container };
  });
  log.info({ discovery }, 'discovered compendium sources');
  if (!discovery.physical || !discovery.container) {
    log.error({ discovery }, 'probe aborted: need a physical item and a container in compendia');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const PHYS = discovery.physical.uuid;
  const CONT = discovery.container.uuid;

  // --------------------------------------------------------------------
  // Probe 1: delete a physical item → operation=deleted, qtyAtDelete=1.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ sourceUuid: PHYS, quantity: 1 }]);
    const res = await call({ actorId: ACTOR_ID, itemId: id, mode: 'delete' });
    log.info({ probe: 1, res }, 'probe 1: delete physical item');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 1: operation=deleted', {
        op: res.data.operation,
      });
      assert(res.data.deletedItem?.qtyAtDelete === 1, 'probe 1: qtyAtDelete=1', {
        qty: res.data.deletedItem?.qtyAtDelete,
      });
      assert(
        Array.isArray(res.data.ejectedToTopLevel) && res.data.ejectedToTopLevel.length === 0,
        'probe 1: ejectedToTopLevel empty',
        { ejected: res.data.ejectedToTopLevel },
      );
    }
    const gone = await page.evaluate(
      (aId, iId) => !globalThis.game.actors.get(aId).items.get(iId),
      ACTOR_ID,
      id,
    );
    assert(gone === true, 'probe 1: item is gone from the actor', { id });
  }

  // --------------------------------------------------------------------
  // Probe 2: delete a non-physical item (synthetic feat) → qtyAtDelete=null.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ type: 'feat', name: '__probe_feat' }]);
    const res = await call({ actorId: ACTOR_ID, itemId: id, mode: 'delete' });
    log.info({ probe: 2, res }, 'probe 2: delete non-physical item');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 2: operation=deleted', {
        op: res.data.operation,
      });
      assert(
        res.data.deletedItem?.qtyAtDelete === null,
        'probe 2: qtyAtDelete=null for non-physical',
        { qty: res.data.deletedItem?.qtyAtDelete },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: decrement > 0 → operation=decremented.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ sourceUuid: PHYS, quantity: 10 }]);
    const res = await call({ actorId: ACTOR_ID, itemId: id, mode: 'decrement', quantity: 4 });
    log.info({ probe: 3, res }, 'probe 3: decrement 10 - 4');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 3: operation=decremented', {
        op: res.data.operation,
      });
      assert(res.data.item?.qtyBefore === 10, 'probe 3: qtyBefore=10', {
        before: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === 6, 'probe 3: qtyAfter=6', {
        after: res.data.item?.qtyAfter,
      });
    }
    // Clean up the survivor.
    await page.evaluate(
      (aId, iId) => globalThis.game.actors.get(aId).deleteEmbeddedDocuments('Item', [iId]),
      ACTOR_ID,
      id,
    );
  }

  // --------------------------------------------------------------------
  // Probe 4: decrement to exactly 0, deleteIfZero default true →
  // decrementedAndDeleted.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ sourceUuid: PHYS, quantity: 3 }]);
    const res = await call({ actorId: ACTOR_ID, itemId: id, mode: 'decrement', quantity: 3 });
    log.info({ probe: 4, res }, 'probe 4: decrement 3 - 3, deleteIfZero default');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'decrementedAndDeleted',
        'probe 4: operation=decrementedAndDeleted',
        { op: res.data.operation },
      );
      assert(res.data.deletedItem?.qtyBefore === 3, 'probe 4: qtyBefore=3', {
        before: res.data.deletedItem?.qtyBefore,
      });
    }
    const gone = await page.evaluate(
      (aId, iId) => !globalThis.game.actors.get(aId).items.get(iId),
      ACTOR_ID,
      id,
    );
    assert(gone === true, 'probe 4: item is gone', { id });
  }

  // --------------------------------------------------------------------
  // Probe 5: decrement to 0, deleteIfZero:false → decremented, entry stays.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ sourceUuid: PHYS, quantity: 2 }]);
    const res = await call({
      actorId: ACTOR_ID,
      itemId: id,
      mode: 'decrement',
      quantity: 2,
      deleteIfZero: false,
    });
    log.info({ probe: 5, res }, 'probe 5: decrement 2 - 2, deleteIfZero:false');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 5: operation=decremented', {
        op: res.data.operation,
      });
      assert(res.data.item?.qtyAfter === 0, 'probe 5: qtyAfter=0', {
        after: res.data.item?.qtyAfter,
      });
    }
    const survives = await page.evaluate(
      (aId, iId) => {
        const it = globalThis.game.actors.get(aId).items.get(iId);
        return it ? it.system?.quantity : 'GONE';
      },
      ACTOR_ID,
      id,
    );
    assert(survives === 0, 'probe 5: qty-0 entry persists on the actor', { survives });
    await page.evaluate(
      (aId, iId) => globalThis.game.actors.get(aId).deleteEmbeddedDocuments('Item', [iId]),
      ACTOR_ID,
      id,
    );
  }

  // --------------------------------------------------------------------
  // Probe 6: decrement past 0 (clamp) → collapses to decrementedAndDeleted.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ sourceUuid: PHYS, quantity: 2 }]);
    const res = await call({ actorId: ACTOR_ID, itemId: id, mode: 'decrement', quantity: 5 });
    log.info({ probe: 6, res }, 'probe 6: decrement 2 - 5 (clamp)');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'decrementedAndDeleted',
        'probe 6: clamp collapses to decrementedAndDeleted',
        { op: res.data.operation },
      );
    }
    const gone = await page.evaluate(
      (aId, iId) => !globalThis.game.actors.get(aId).items.get(iId),
      ACTOR_ID,
      id,
    );
    assert(gone === true, 'probe 6: item is gone', { id });
  }

  // --------------------------------------------------------------------
  // Probe 7: delete a populated container → contained item ejected to root.
  // --------------------------------------------------------------------
  {
    const [containerId] = await createItems(page, ACTOR_ID, [{ sourceUuid: CONT }]);
    const [innerId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: PHYS, quantity: 1, container: containerId },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId: containerId, mode: 'delete' });
    log.info({ probe: 7, res }, 'probe 7: delete populated container');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 7: operation=deleted', {
        op: res.data.operation,
      });
      assert(
        res.data.ejectedToTopLevel?.length === 1 &&
          res.data.ejectedToTopLevel[0].id === innerId,
        'probe 7: contained item reported in ejectedToTopLevel',
        { ejected: res.data.ejectedToTopLevel },
      );
    }
    const survivorContainer = await page.evaluate(
      (aId, iId) => {
        const it = globalThis.game.actors.get(aId).items.get(iId);
        if (!it) return 'GONE';
        return it.system?.container ?? null;
      },
      ACTOR_ID,
      innerId,
    );
    assert(
      survivorContainer === null,
      'probe 7: ejected item survives with system.container=null (no dangling ref)',
      { survivorContainer },
    );
    // Clean up the ejected survivor.
    await page.evaluate(
      (aId, iId) => {
        const actor = globalThis.game.actors.get(aId);
        if (actor.items.get(iId)) return actor.deleteEmbeddedDocuments('Item', [iId]);
      },
      ACTOR_ID,
      innerId,
    );
  }

  // --------------------------------------------------------------------
  // Probe 8: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef', itemId: 'whatever0000', mode: 'delete' });
    log.info({ probe: 8, res }, 'probe 8: bogus actorId');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 8: reason=ACTOR_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 9: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: 'deadbeefdeadbeef', mode: 'delete' });
    log.info({ probe: 9, res }, 'probe 9: bogus itemId');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 9: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 10: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
  // --------------------------------------------------------------------
  if (actorIds.other) {
    const res = await call({
      actorId: actorIds.other.id,
      itemId: 'deadbeefdeadbeef',
      mode: 'delete',
    });
    log.info({ probe: 10, res, otherType: actorIds.other.type }, 'probe 10: unsupported type');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 10: reason=ACTOR_TYPE_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 10 }, 'probe 10: skipped — no vehicle/group/encounter actor in world');
  }

  // --------------------------------------------------------------------
  // Probe 11: delete with quantity → zod validation rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: ACTOR_ID,
      itemId: 'whatever0000',
      mode: 'delete',
      quantity: 2,
    });
    log.info({ probe: 11, res }, 'probe 11: delete with quantity');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      Array.isArray(res.validation),
      'probe 11: delete+quantity rejected at the zod boundary',
      { res },
    );
  }

  // --------------------------------------------------------------------
  // Probe 12: decrement quantity 0 → zod validation rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: ACTOR_ID,
      itemId: 'whatever0000',
      mode: 'decrement',
      quantity: 0,
    });
    log.info({ probe: 12, res }, 'probe 12: decrement quantity 0');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(Array.isArray(res.validation), 'probe 12: quantity 0 rejected at the zod boundary', {
      res,
    });
  }

  // --------------------------------------------------------------------
  // Probe 13: decrement on a non-physical item → DECREMENT_ON_NON_PHYSICAL.
  // --------------------------------------------------------------------
  {
    const [id] = await createItems(page, ACTOR_ID, [{ type: 'feat', name: '__probe_feat2' }]);
    const res = await call({ actorId: ACTOR_ID, itemId: id, mode: 'decrement', quantity: 1 });
    log.info({ probe: 13, res }, 'probe 13: decrement on non-physical');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(
      res.error?.details?.reason === 'DECREMENT_ON_NON_PHYSICAL',
      'probe 13: reason=DECREMENT_ON_NON_PHYSICAL',
      { reason: res.error?.details?.reason },
    );
    // The item should be untouched — clean it up.
    await page.evaluate(
      (aId, iId) => {
        const actor = globalThis.game.actors.get(aId);
        if (actor.items.get(iId)) return actor.deleteEmbeddedDocuments('Item', [iId]);
      },
      ACTOR_ID,
      id,
    );
  }

  // --------------------------------------------------------------------
  // Teardown: restore the actor to the exact start-of-probe snapshot.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snap) => {
      const actor = globalThis.game.actors.get(actorId);
      const snapshotIds = new Set(snap.items.map((i) => i.id));

      const orphanIds = actor.items.contents
        .filter((i) => !snapshotIds.has(i.id))
        .map((i) => i.id);
      for (const id of orphanIds) {
        if (actor.items.get(id)) await actor.items.get(id).delete();
      }

      const missing = snap.items.filter((s) => !actor.items.get(s.id));
      if (missing.length > 0) {
        await actor.createEmbeddedDocuments(
          'Item',
          missing.map((s) => s.payload),
        );
      }

      const snapQty = new Map(snap.items.map((i) => [i.id, i.qty]));
      const updates = [];
      for (const item of actor.items.contents) {
        const expected = snapQty.get(item.id);
        if (expected === undefined) continue;
        const current = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        if (current !== expected) updates.push({ _id: item.id, 'system.quantity': expected });
      }
      if (updates.length > 0) await actor.updateEmbeddedDocuments('Item', updates);

      const sig = (name, type, qty, container) => `${name}|${type}|${qty}|${container ?? ''}`;
      const sortSigs = (arr) => arr.slice().sort();
      const snapSigs = sortSigs(snap.items.map((s) => sig(s.name, s.type, s.qty, s.container)));
      const finalSigs = sortSigs(
        actor.items.contents.map((i) =>
          sig(
            i.name ?? '',
            i.type ?? '',
            typeof i.system?.quantity === 'number' ? i.system.quantity : 1,
            typeof i.system?.container === 'string' && i.system.container.length > 0
              ? i.system.container
              : null,
          ),
        ),
      );
      const signaturesMatch =
        snapSigs.length === finalSigs.length &&
        snapSigs.every((s, idx) => s === finalSigs[idx]);

      return {
        orphansDeleted: orphanIds.length,
        recreated: missing.length,
        quantitiesRestored: updates.length,
        finalItemCount: actor.items.size,
        signaturesMatch,
        snapSigs: signaturesMatch ? undefined : snapSigs,
        finalSigs: signaturesMatch ? undefined : finalSigs,
      };
    },
    ACTOR_ID,
    snapshot,
  );
  log.info({ teardown }, 'teardown: restore to start-of-probe snapshot');

  // --------------------------------------------------------------------
  // Probe 14: snapshot-equality verification.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === snapshot.itemCount,
    'probe 14: item count equals snapshot',
    { snapshot: snapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(teardown.signaturesMatch === true, 'probe 14: signature multiset matches snapshot', {
    teardown,
  });

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all acceptance assertions passed');
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
