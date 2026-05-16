/**
 * Probe + acceptance script for update_item_quantity. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Happy: bump qty up (canonical Arrows 20 → 35, restored).
 *   2.  Happy: drop qty down (canonical Copper Pieces 9 → 2, restored).
 *   3.  Happy: set-equal (Arrows 20 → 20; verify qtyBefore === qtyAfter
 *       and the response is still operation: "updated").
 *   4.  Happy: large value (temp consumable qty 1 → 9999, then 9999 → 1
 *       to verify both directions; temp deleted in teardown).
 *   5.  Happy: treasure aggregator pass-through (Copper Pieces → 17;
 *       actor.inventory.coins.cp tracks).
 *   6.  Reject: quantity 0 → QUANTITY_ZERO (the eval-layer
 *       remove_item_from_actor pointer). Note: zod's .min(1) catches
 *       this at the MCP boundary too — this probe deliberately reaches
 *       the eval layer by calling tool.handler with a hand-rolled args
 *       object that bypasses zod, exercising the defensive evaluator
 *       check.
 *   7.  Reject: quantity -5 → zod validation rejection.
 *   8.  Reject: quantity 1.5 → zod validation rejection.
 *   9.  Reject: actor not found → ACTOR_NOT_FOUND.
 *   10. Reject: itemId not on actor → ITEM_NOT_FOUND_ON_ACTOR.
 *   11. Reject: non-physical item (synthetic rules-free feat created
 *       inline, cleaned up in teardown) → UPDATE_ON_NON_PHYSICAL.
 *   12. Teardown verification: post-teardown signature multiset
 *       (name|type|qty|containerId) equals start-of-probe snapshot.
 *
 * State restoration model: mirrors probe-remove-item-from-actor.mjs.
 * Snapshot every item as full toObject() payload at start. Teardown
 * deletes orphans, recreates missing snapshot ids (Foundry assigns
 * fresh ids — assertion is on signature multiset, not id-equality),
 * and restores drifted quantities.
 *
 *   npm run build && node scripts/probe-update-item-quantity.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'update_item_quantity');
if (!tool) {
  log.error('update_item_quantity not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';

const CANONICAL_ARROWS_ID = 'oAeupG1c0dIv5p7Y';
const CANONICAL_ARROWS_QTY = 20;
const CANONICAL_COPPER_PIECES_ID = 'L1LDHWdCbDhOfSRP';
const CANONICAL_COPPER_PIECES_QTY = 9;

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

// Bypass zod and call handler with a hand-rolled args object. Used to
// reach the evaluator's defensive checks (e.g. QUANTITY_ZERO) that the
// zod schema otherwise rejects at the boundary.
async function callRaw(args) {
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

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub. Converge Test Valeros to canonical state.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(
    async (actorId, canonicalArrowsId, canonicalArrowsQty, canonicalCpId, canonicalCpQty) => {
      const actor = globalThis.game.actors?.get(actorId);
      if (!actor) return { error: `actor ${actorId} not found` };

      const namedOrphans = actor.items.contents
        .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe'))
        .map((i) => i.id);
      const arrowsOrphans = actor.items.contents
        .filter((i) => (i.name ?? '') === 'Arrows' && i.id !== canonicalArrowsId)
        .map((i) => i.id);
      const zeroQtyOrphans = actor.items.contents
        .filter(
          (i) =>
            i.id !== canonicalArrowsId &&
            i.id !== canonicalCpId &&
            typeof i.system?.quantity === 'number' &&
            i.system.quantity === 0,
        )
        .map((i) => i.id);
      const allOrphans = [...new Set([...namedOrphans, ...arrowsOrphans, ...zeroQtyOrphans])];
      if (allOrphans.length > 0) {
        await actor.deleteEmbeddedDocuments('Item', allOrphans);
      }

      const updates = [];
      const arrows = actor.items.get(canonicalArrowsId);
      if (arrows && arrows.system?.quantity !== canonicalArrowsQty) {
        updates.push({ _id: arrows.id, 'system.quantity': canonicalArrowsQty });
      }
      const cp = actor.items.get(canonicalCpId);
      if (cp && cp.system?.quantity !== canonicalCpQty) {
        updates.push({ _id: cp.id, 'system.quantity': canonicalCpQty });
      }
      if (updates.length > 0) await actor.updateEmbeddedDocuments('Item', updates);

      return {
        deletedOrphans: allOrphans,
        quantityFixes: updates,
        itemCount: actor.items.size,
      };
    },
    PROBE_ACTOR_ID,
    CANONICAL_ARROWS_ID,
    CANONICAL_ARROWS_QTY,
    CANONICAL_COPPER_PIECES_ID,
    CANONICAL_COPPER_PIECES_QTY,
  );
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot: full toObject() payload per item.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    return {
      itemCount: actor.items.size,
      items: actor.items.contents.map((i) => ({
        id: i.id,
        name: i.name ?? '',
        type: i.type ?? '',
        qty: typeof i.system?.quantity === 'number' ? i.system.quantity : 1,
        containerId: i.system?.containerId ?? null,
        payload: i.toObject(),
      })),
    };
  }, PROBE_ACTOR_ID);
  log.info(
    {
      itemCount: startSnapshot.itemCount,
      sample: startSnapshot.items
        .slice(0, 3)
        .map((i) => ({ id: i.id, name: i.name, type: i.type, qty: i.qty })),
    },
    'snapshot captured',
  );

  async function makeTemp(name, sourceUuid, system = {}) {
    return page.evaluate(
      async (actorId, name, sourceUuid, systemOverrides) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(sourceUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name,
            system: { ...(data.system ?? {}), ...systemOverrides },
          },
        ]);
        const c = created[0];
        return { id: c.id, name: c.name, type: c.type, qty: c.system?.quantity ?? null };
      },
      PROBE_ACTOR_ID,
      name,
      sourceUuid,
      system,
    );
  }

  // --------------------------------------------------------------------
  // Probe 1: bump qty up (Arrows 20 → 35).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_ARROWS_ID,
      quantity: 35,
    });
    log.info({ probe: 1, res }, 'probe 1: arrows 20 → 35');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 1: operation=updated', {
        op: res.data.operation,
      });
      assert(res.data.item?.id === CANONICAL_ARROWS_ID, 'probe 1: id matches', {
        id: res.data.item?.id,
      });
      assert(
        typeof res.data.item?.type === 'string' && res.data.item.type.length > 0,
        'probe 1: type is a physical-item type string (exact value system-dependent)',
        { type: res.data.item?.type },
      );
      assert(res.data.item?.qtyBefore === CANONICAL_ARROWS_QTY, 'probe 1: qtyBefore=20', {
        q: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === 35, 'probe 1: qtyAfter=35', {
        q: res.data.item?.qtyAfter,
      });
    }
    const live = await page.evaluate(
      (actorId, id) => globalThis.game.actors.get(actorId).items.get(id)?.system?.quantity,
      PROBE_ACTOR_ID,
      CANONICAL_ARROWS_ID,
    );
    assert(live === 35, 'probe 1: live qty actually updated to 35', { live });
  }

  // --------------------------------------------------------------------
  // Probe 2: drop qty down (Copper Pieces 9 → 2).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_COPPER_PIECES_ID,
      quantity: 2,
    });
    log.info({ probe: 2, res }, 'probe 2: copper pieces 9 → 2');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.qtyBefore === CANONICAL_COPPER_PIECES_QTY, 'probe 2: qtyBefore=9', {
        q: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === 2, 'probe 2: qtyAfter=2', {
        q: res.data.item?.qtyAfter,
      });
      assert(res.data.item?.type === 'treasure', 'probe 2: type=treasure', {
        type: res.data.item?.type,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: set-equal (Arrows currently 35 → set to 35).
  //
  // Confirms the response shape carries qtyBefore === qtyAfter rather
  // than introducing a noop flag.
  // --------------------------------------------------------------------
  {
    // Arrows is at 35 from probe 1.
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_ARROWS_ID,
      quantity: 35,
    });
    log.info({ probe: 3, res }, 'probe 3: arrows 35 → 35 (set-equal)');
    assert(res.ok === true, 'probe 3: ok (set-equal does not throw)', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 3: operation=updated', {
        op: res.data.operation,
      });
      assert(res.data.item?.qtyBefore === 35, 'probe 3: qtyBefore=35', {
        q: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === 35, 'probe 3: qtyAfter=35', {
        q: res.data.item?.qtyAfter,
      });
      assert(
        res.data.item?.qtyBefore === res.data.item?.qtyAfter,
        'probe 3: qtyBefore === qtyAfter signals no-op',
        { before: res.data.item?.qtyBefore, after: res.data.item?.qtyAfter },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: large value (temp consumable qty 1 → 9999 → 1).
  // --------------------------------------------------------------------
  {
    const temp = await makeTemp('__probe4_potion__', HEALING_POTION_UUID, { quantity: 1 });

    const resUp = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: temp.id,
      quantity: 9999,
    });
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

    const resDown = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: temp.id,
      quantity: 1,
    });
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
  // Probe 5: treasure aggregator pass-through (Copper Pieces 2 → 17,
  // confirm actor.inventory.coins.cp tracks).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_COPPER_PIECES_ID,
      quantity: 17,
    });
    log.info({ probe: 5, res }, 'probe 5: copper pieces 2 → 17');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.item?.qtyAfter === 17, 'probe 5: qtyAfter=17', {
        q: res.data.item?.qtyAfter,
      });
    }
    const coinsCp = await page.evaluate(
      (actorId) => globalThis.game.actors.get(actorId).inventory?.coins?.cp,
      PROBE_ACTOR_ID,
    );
    assert(coinsCp === 17, 'probe 5: actor.inventory.coins.cp tracks set', { coinsCp });
  }

  // --------------------------------------------------------------------
  // Probe 6: QUANTITY_ZERO via raw handler call (bypass zod). The
  // pointer message must mention remove_item_from_actor.
  // --------------------------------------------------------------------
  {
    const res = await callRaw({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_ARROWS_ID,
      quantity: 0,
    });
    log.info({ probe: 6, res }, 'probe 6: quantity 0 via raw handler');
    assert(res.isError === true, 'probe 6: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 6: INVALID_INPUT', {
      code: res.error?.code,
    });
    assert(res.error?.details?.reason === 'QUANTITY_ZERO', 'probe 6: reason=QUANTITY_ZERO', {
      d: res.error?.details,
    });
    assert(
      typeof res.error?.message === 'string' &&
        res.error.message.includes('remove_item_from_actor'),
      'probe 6: message points at remove_item_from_actor',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 7: quantity -5 → zod rejection at the MCP boundary.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_ARROWS_ID,
      quantity: -5,
    });
    log.info({ probe: 7, res }, 'probe 7: quantity -5');
    assert(res.isError === true, 'probe 7: error', { res });
    assert(Array.isArray(res.validation), 'probe 7: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 8: quantity 1.5 → zod rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: CANONICAL_ARROWS_ID,
      quantity: 1.5,
    });
    log.info({ probe: 8, res }, 'probe 8: quantity 1.5');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(Array.isArray(res.validation), 'probe 8: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 9: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: 'deadbeefdeadbeef',
      itemId: 'whatever',
      quantity: 1,
    });
    log.info({ probe: 9, res }, 'probe 9: bogus actorId');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 9: reason=ACTOR_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 10: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: 'deadbeefdeadbeef',
      quantity: 1,
    });
    log.info({ probe: 10, res }, 'probe 10: bogus itemId');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 10: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: non-physical item type → UPDATE_ON_NON_PHYSICAL.
  //
  // Synthetic rules-free feat (avoids PF2e compendium-feat GrantItem
  // cascades that hang in headless context).
  // --------------------------------------------------------------------
  {
    const tempFeat = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const created = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe11_feat__',
          type: 'feat',
          system: { description: { value: '' } },
        },
      ]);
      return { id: created[0].id, name: created[0].name, type: created[0].type };
    }, PROBE_ACTOR_ID);

    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: tempFeat.id,
      quantity: 5,
    });
    log.info({ probe: 11, res }, 'probe 11: update on feat');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 11: INVALID_INPUT', {
      code: res.error?.code,
    });
    assert(
      res.error?.details?.reason === 'UPDATE_ON_NON_PHYSICAL',
      'probe 11: reason=UPDATE_ON_NON_PHYSICAL',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Teardown. Identical strategy to probe-remove-item-from-actor.mjs:
  //   1. Delete orphans (items currently present but not in snapshot).
  //   2. Recreate snapshot items missing from the actor (new ids).
  //   3. Restore drifted quantities for surviving snapshot ids.
  //   4. Build the signature multiset for verification.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
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
          recreated.push({
            originalId: snap.id,
            newId: c[0]?.id ?? null,
            name: snap.name,
            type: snap.type,
          });
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

      const sigOf = (item) => {
        const qty = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        const containerId = item.system?.containerId ?? '';
        return `${item.name ?? ''}|${item.type ?? ''}|${qty}|${containerId}`;
      };
      const postSig = new Map();
      for (const item of actor.items.contents) {
        const k = sigOf(item);
        postSig.set(k, (postSig.get(k) ?? 0) + 1);
      }
      const snapSig = new Map();
      for (const s of snapshot.items) {
        const k = `${s.name}|${s.type}|${s.qty}|${s.containerId ?? ''}`;
        snapSig.set(k, (snapSig.get(k) ?? 0) + 1);
      }
      const missingSigs = [];
      for (const [sig, count] of snapSig) {
        const have = postSig.get(sig) ?? 0;
        if (have !== count) missingSigs.push({ sig, expected: count, actual: have });
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
    PROBE_ACTOR_ID,
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
  assert(
    teardown.signaturesMatch === true,
    'probe 12: name+type+qty+containerId multiset matches snapshot',
    { missing: teardown.missingSigs, extra: teardown.extraSigs },
  );
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
