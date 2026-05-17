/**
 * Probe + acceptance script for dnd5e_update_item_quantity. Drives the
 * live headless Foundry against the dnd5e test world (Foundry v14.361 /
 * dnd5e 5.3.3).
 *
 * Acceptance probes (run against the tool):
 *   1.  Happy: bump qty up (temp consumable 1 → 35).
 *   2.  Happy: drop qty down (temp consumable 35 → 2).
 *   3.  Happy: set-equal (2 → 2; qtyBefore === qtyAfter signals no-op,
 *       operation is still "updated").
 *   4.  Happy: large value (temp consumable 1 → 9999 → 1).
 *   5.  Reject: quantity 0 via raw handler (bypass zod) → QUANTITY_ZERO,
 *       message points at dnd5e_remove_item_from_actor.
 *   6.  Reject: quantity -5 → zod validation rejection.
 *   7.  Reject: quantity 1.5 → zod validation rejection.
 *   8.  Reject: bogus actorId → ACTOR_NOT_FOUND.
 *   9.  Reject: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR.
 *   10. Reject: non-physical item (synthetic feat) → UPDATE_ON_NON_PHYSICAL.
 *   11. Reject: unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped
 *       if the world has no vehicle/group/encounter actor).
 *   12. Teardown verification: post-teardown name|type|qty|container
 *       signature multiset equals the start snapshot.
 *
 * State restoration: the probe only ever creates temp items (deleted in
 * teardown) — it never mutates a canonical item. Teardown still runs the
 * full snapshot/recreate/restore pattern as a safety net: snapshot every
 * item as a full toObject() payload at start; delete orphans, recreate
 * missing snapshot ids, restore drifted quantities, assert signature
 * multiset equality.
 *
 *   npm run build && node scripts/probe-dnd5e-update-item-quantity.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_update_item_quantity');
if (!tool) {
  log.error('dnd5e_update_item_quantity not registered');
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
  return invoke(parsed.data);
}

// Bypass zod and call handler with a hand-rolled args object — reaches the
// evaluator's defensive checks (QUANTITY_ZERO) that zod otherwise rejects.
async function callRaw(args) {
  return invoke(args);
}

async function invoke(args) {
  const blocks = await tool.handler(args, { browser: session, log }).catch((err) => ({
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

// Create temp items on the actor via raw createEmbeddedDocuments.
async function createItems(page, actorId, specs) {
  return page.evaluate(
    async (aId, itemSpecs) => {
      const actor = globalThis.game.actors.get(aId);
      const datas = itemSpecs.map((spec) => {
        const data = { name: spec.name, type: spec.type, system: { ...(spec.system ?? {}) } };
        if (typeof spec.quantity === 'number') data.system.quantity = spec.quantity;
        return data;
      });
      const created = await actor.createEmbeddedDocuments('Item', datas);
      return created.map((i) => i.id);
    },
    actorId,
    specs,
  );
}

async function liveQty(page, actorId, itemId) {
  return page.evaluate(
    (aId, id) => globalThis.game.actors.get(aId).items.get(id)?.system?.quantity ?? null,
    actorId,
    itemId,
  );
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Resolve a probe-target character actor + an unsupported-type actor.
  // --------------------------------------------------------------------
  const actorIds = await page.evaluate(() => {
    const pc = globalThis.game.actors.find((a) => a.type === 'character');
    const other = globalThis.game.actors.find((a) => a.type !== 'character' && a.type !== 'npc');
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
  // Snapshot: full toObject() payload per item.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
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
  log.info({ itemCount: startSnapshot.itemCount }, 'snapshot captured');

  // --------------------------------------------------------------------
  // Probe 1: bump qty up (temp consumable 1 → 35).
  // --------------------------------------------------------------------
  const [tempA] = await createItems(page, ACTOR_ID, [
    { name: '__probe_qty_A__', type: 'consumable', quantity: 1 },
  ]);
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempA, quantity: 35 });
    log.info({ probe: 1, res }, 'probe 1: temp 1 → 35');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 1: operation=updated', {
        op: res.data.operation,
      });
      assert(res.data.item?.id === tempA, 'probe 1: id matches', { id: res.data.item?.id });
      assert(res.data.item?.type === 'consumable', 'probe 1: type=consumable', {
        type: res.data.item?.type,
      });
      assert(res.data.item?.qtyBefore === 1, 'probe 1: qtyBefore=1', {
        q: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === 35, 'probe 1: qtyAfter=35', {
        q: res.data.item?.qtyAfter,
      });
    }
    const live = await liveQty(page, ACTOR_ID, tempA);
    assert(live === 35, 'probe 1: live qty actually updated to 35', { live });
  }

  // --------------------------------------------------------------------
  // Probe 2: drop qty down (35 → 2).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempA, quantity: 2 });
    log.info({ probe: 2, res }, 'probe 2: temp 35 → 2');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.qtyBefore === 35, 'probe 2: qtyBefore=35', {
        q: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === 2, 'probe 2: qtyAfter=2', { q: res.data.item?.qtyAfter });
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: set-equal (2 → 2). qtyBefore === qtyAfter signals no-op.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempA, quantity: 2 });
    log.info({ probe: 3, res }, 'probe 3: temp 2 → 2 (set-equal)');
    assert(res.ok === true, 'probe 3: ok (set-equal does not throw)', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 3: operation=updated', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.qtyBefore === 2 && res.data.item?.qtyAfter === 2,
        'probe 3: qtyBefore === qtyAfter === 2 signals no-op',
        { before: res.data.item?.qtyBefore, after: res.data.item?.qtyAfter },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: large value (temp consumable 1 → 9999 → 1).
  // --------------------------------------------------------------------
  {
    const [tempB] = await createItems(page, ACTOR_ID, [
      { name: '__probe_qty_B__', type: 'consumable', quantity: 1 },
    ]);
    const resUp = await call({ actorId: ACTOR_ID, itemId: tempB, quantity: 9999 });
    log.info({ probe: 4, dir: 'up', res: resUp }, 'probe 4a: temp 1 → 9999');
    assert(resUp.ok === true, 'probe 4a: ok', { res: resUp });
    if (resUp.ok) {
      assert(resUp.data.item?.qtyBefore === 1, 'probe 4a: qtyBefore=1', {
        q: resUp.data.item?.qtyBefore,
      });
      assert(resUp.data.item?.qtyAfter === 9999, 'probe 4a: qtyAfter=9999', {
        q: resUp.data.item?.qtyAfter,
      });
    }
    const resDown = await call({ actorId: ACTOR_ID, itemId: tempB, quantity: 1 });
    log.info({ probe: 4, dir: 'down', res: resDown }, 'probe 4b: temp 9999 → 1');
    assert(resDown.ok === true, 'probe 4b: ok', { res: resDown });
    if (resDown.ok) {
      assert(resDown.data.item?.qtyBefore === 9999, 'probe 4b: qtyBefore=9999', {
        q: resDown.data.item?.qtyBefore,
      });
      assert(resDown.data.item?.qtyAfter === 1, 'probe 4b: qtyAfter=1', {
        q: resDown.data.item?.qtyAfter,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: QUANTITY_ZERO via raw handler (bypass zod). Message must
  // point at dnd5e_remove_item_from_actor.
  // --------------------------------------------------------------------
  {
    const res = await callRaw({ actorId: ACTOR_ID, itemId: tempA, quantity: 0 });
    log.info({ probe: 5, res }, 'probe 5: quantity 0 via raw handler');
    assert(res.isError === true, 'probe 5: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 5: INVALID_INPUT', { code: res.error?.code });
    assert(res.error?.details?.reason === 'QUANTITY_ZERO', 'probe 5: reason=QUANTITY_ZERO', {
      d: res.error?.details,
    });
    assert(
      typeof res.error?.message === 'string' &&
        res.error.message.includes('dnd5e_remove_item_from_actor'),
      'probe 5: message points at dnd5e_remove_item_from_actor',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 6: quantity -5 → zod rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempA, quantity: -5 });
    log.info({ probe: 6, res }, 'probe 6: quantity -5');
    assert(res.isError === true, 'probe 6: error', { res });
    assert(Array.isArray(res.validation), 'probe 6: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 7: quantity 1.5 → zod rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempA, quantity: 1.5 });
    log.info({ probe: 7, res }, 'probe 7: quantity 1.5');
    assert(res.isError === true, 'probe 7: error', { res });
    assert(Array.isArray(res.validation), 'probe 7: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 8: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef', itemId: 'whatever', quantity: 1 });
    log.info({ probe: 8, res }, 'probe 8: bogus actorId');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 8: reason=ACTOR_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 9: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: 'deadbeefdeadbeef', quantity: 1 });
    log.info({ probe: 9, res }, 'probe 9: bogus itemId');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 9: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 10: non-physical item type → UPDATE_ON_NON_PHYSICAL.
  // --------------------------------------------------------------------
  {
    const [tempFeat] = await createItems(page, ACTOR_ID, [
      { name: '__probe_qty_feat__', type: 'feat' },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId: tempFeat, quantity: 5 });
    log.info({ probe: 10, res }, 'probe 10: update on feat');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'UPDATE_ON_NON_PHYSICAL',
      'probe 10: reason=UPDATE_ON_NON_PHYSICAL',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
  // --------------------------------------------------------------------
  if (actorIds.other) {
    const res = await call({ actorId: actorIds.other.id, itemId: 'whatever', quantity: 1 });
    log.info({ probe: 11, res, otherType: actorIds.other.type }, 'probe 11: unsupported actor');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 11: reason=ACTOR_TYPE_UNSUPPORTED',
      { d: res.error?.details },
    );
  } else {
    log.info({ probe: 11 }, 'probe 11 skipped: no vehicle/group/encounter actor in world');
  }

  // --------------------------------------------------------------------
  // Teardown: delete orphans, recreate missing snapshot ids, restore
  // drifted quantities, assert signature-multiset equality.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors.get(actorId);
      const snapIds = new Set(snapshot.items.map((s) => s.id));
      const snapQty = new Map(snapshot.items.map((s) => [s.id, s.qty]));

      const orphans = actor.items.contents.filter((i) => !snapIds.has(i.id)).map((i) => i.id);
      const deleted = [];
      const deleteFailures = [];
      for (const id of orphans) {
        const existing = actor.items.get(id);
        if (!existing) continue;
        try {
          await existing.delete();
          deleted.push(id);
        } catch (err) {
          deleteFailures.push(`${id}:${err?.message ?? String(err)}`);
        }
      }

      const recreated = [];
      const recreateFailures = [];
      for (const snap of snapshot.items) {
        if (actor.items.get(snap.id)) continue;
        try {
          const c = await actor.createEmbeddedDocuments('Item', [snap.payload]);
          recreated.push({ originalId: snap.id, newId: c[0]?.id ?? null });
        } catch (err) {
          recreateFailures.push(`${snap.id}/${snap.name}: ${err?.message ?? String(err)}`);
        }
      }

      const updates = [];
      for (const item of actor.items.contents) {
        const expectedQty = snapQty.get(item.id);
        if (expectedQty === undefined) continue;
        const currentQty = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        if (currentQty !== expectedQty) {
          updates.push({ _id: item.id, 'system.quantity': expectedQty });
        }
      }
      if (updates.length > 0) await actor.updateEmbeddedDocuments('Item', updates);

      const sigOf = (name, type, qty, container) =>
        `${name}|${type}|${qty}|${container ?? ''}`;
      const postSig = new Map();
      for (const item of actor.items.contents) {
        const qty = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        const container =
          typeof item.system?.container === 'string' && item.system.container.length > 0
            ? item.system.container
            : '';
        const k = sigOf(item.name ?? '', item.type ?? '', qty, container);
        postSig.set(k, (postSig.get(k) ?? 0) + 1);
      }
      const snapSig = new Map();
      for (const s of snapshot.items) {
        const k = sigOf(s.name, s.type, s.qty, s.container);
        snapSig.set(k, (snapSig.get(k) ?? 0) + 1);
      }
      const missingSigs = [];
      for (const [sig, count] of snapSig) {
        if ((postSig.get(sig) ?? 0) !== count) {
          missingSigs.push({ sig, expected: count, actual: postSig.get(sig) ?? 0 });
        }
      }
      const extraSigs = [];
      for (const [sig, count] of postSig) {
        if (!snapSig.has(sig)) extraSigs.push({ sig, count });
      }

      return {
        orphansDeleted: deleted.length,
        deleteFailures,
        itemsRecreated: recreated.length,
        recreateFailures,
        quantitiesUpdated: updates.length,
        finalItemCount: actor.items.size,
        signaturesMatch: missingSigs.length === 0 && extraSigs.length === 0,
        missingSigs,
        extraSigs,
      };
    },
    ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');

  // --------------------------------------------------------------------
  // Probe 12: post-teardown signature equality.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 12: item count equals snapshot',
    { snap: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(teardown.signaturesMatch === true, 'probe 12: signature multiset matches snapshot', {
    missing: teardown.missingSigs,
    extra: teardown.extraSigs,
  });
  assert(teardown.deleteFailures.length === 0, 'probe 12: no orphan-delete failures', {
    failures: teardown.deleteFailures,
  });
  assert(teardown.recreateFailures.length === 0, 'probe 12: no recreation failures', {
    failures: teardown.recreateFailures,
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
