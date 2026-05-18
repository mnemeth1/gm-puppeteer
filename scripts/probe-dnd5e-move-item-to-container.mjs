/**
 * Probe + acceptance script for dnd5e_move_item_to_container. Drives the
 * live headless Foundry against the dnd5e test world (Foundry v14.361 /
 * dnd5e 5.3.3). Container-graph behavior was settled by
 * scripts/probe-dnd5e-inventory-graph-phase1.mjs; this script exercises
 * the shipped tool.
 *
 * Acceptance probes:
 *   1.  Move root → container → operation=moved, containerBefore=null.
 *   2.  Move container → root → operation=moved, containerAfter=null.
 *   3.  Same-destination move → no-op (containerBefore === containerAfter).
 *   4.  Merge: move a stack into a container holding a same-source stack
 *       → operation=merged, source deleted.
 *   5.  merge:"never" → operation=moved, a separate entry survives.
 *   6.  Move a populated container → children's system.container intact.
 *   7.  Self-cycle (move a container into itself) → CYCLE_DETECTED.
 *   8.  Depth-2 cycle → CYCLE_DETECTED.
 *   9.  Non-container target → CONTAINER_TYPE_INVALID.
 *   10. Non-physical item → NON_PHYSICAL_ITEM.
 *   11. Bogus actorId / itemId / containerId → respective reasons.
 *   12. Unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped if absent).
 *   13. Teardown verification: signature-multiset match with the snapshot.
 *
 * State restoration (the merge path deletes): snapshot every item as
 * {id, name, type, qty, container, payload: toObject()}; teardown deletes
 * orphans, recreates any missing snapshot id from its payload, restores
 * drifted quantities, then asserts the name|type|qty|container signature
 * multiset matches. Scratch items carry a synthetic _stats.compendiumSource
 * so the merge path can never fold a scratch item into a real one.
 *
 *   npm run build && node scripts/probe-dnd5e-move-item-to-container.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_move_item_to_container');
if (!tool) {
  log.error('dnd5e_move_item_to_container not registered');
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

// Create scratch items on an actor via raw createEmbeddedDocuments. Each
// spec: { sourceUuid?, type?, name?, quantity?, container?, identified?,
// compendiumSource? }. Returns created ids in order.
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
          delete data._id;
        } else {
          data = { name: spec.name ?? '__probe', type: spec.type };
        }
        data.name = spec.name ?? data.name ?? '__probe';
        data.system = { ...(data.system ?? {}) };
        if (typeof spec.quantity === 'number') data.system.quantity = spec.quantity;
        if (spec.container !== undefined) data.system.container = spec.container;
        if (typeof spec.identified === 'boolean') data.system.identified = spec.identified;
        if (spec.compendiumSource) {
          data._stats = { ...(data._stats ?? {}), compendiumSource: spec.compendiumSource };
        }
        datas.push(data);
      }
      const created = await actor.createEmbeddedDocuments('Item', datas);
      return created.map((i) => i.id);
    },
    actorId,
    specs,
  );
}

async function readItem(page, actorId, itemId) {
  return page.evaluate(
    (aId, iId) => {
      const it = globalThis.game.actors.get(aId).items.get(iId);
      if (!it) return 'GONE';
      return {
        container:
          typeof it.system?.container === 'string' && it.system.container.length > 0
            ? it.system.container
            : null,
        quantity: typeof it.system?.quantity === 'number' ? it.system.quantity : null,
      };
    },
    actorId,
    itemId,
  );
}

try {
  const { page } = await session.ensureStarted();

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

  // Snapshot: full toObject() payloads for destructive-tool teardown.
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

  // Discovery: a weapon and a container compendium source.
  const discovery = await page.evaluate(async () => {
    const game = globalThis.game;
    const itemPacks = game.packs.filter((p) => p.documentName === 'Item');
    let weapon = null;
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
        if (!weapon && type === 'weapon') weapon = { uuid, name: e.name ?? '', type };
        if (!container && type === 'container') container = { uuid, name: e.name ?? '', type };
      }
      if (weapon && container) break;
    }
    return { weapon, container };
  });
  log.info({ discovery }, 'discovered compendium sources');
  if (!discovery.weapon || !discovery.container) {
    log.error({ discovery }, 'probe aborted: need a weapon and a container in compendia');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const WEAPON = discovery.weapon.uuid;
  const CONTAINER = discovery.container.uuid;
  // A synthetic merge-identity tag. Must be a format-valid compendium UUID
  // (real pack id, 16-char document-id segment) — Foundry's
  // _stats.compendiumSource is a DocumentUUIDField and silently drops a
  // document whose value fails to parse. The id segment is fake (never
  // resolved); only string equality drives merge identity, and no real
  // item carries this value, so a scratch stack never merges into a real one.
  const SRC_A = 'Compendium.dnd5e.items.Item.PROBEmvMERGEsrcA';

  // ------------------------------------------------------------------
  // Probe 1: move root → container.
  // ------------------------------------------------------------------
  let p1Container = null;
  {
    const [containerId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: CONTAINER, name: '__probe_mv c1' },
    ]);
    const [itemId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv w1' },
    ]);
    p1Container = containerId;
    const res = await call({ actorId: ACTOR_ID, itemId, containerId });
    log.info({ probe: 1, res }, 'probe 1: move root → container');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 1: operation=moved', {
        op: res.data.operation,
      });
      assert(res.data.item?.containerBefore === null, 'probe 1: containerBefore=null', {
        before: res.data.item?.containerBefore,
      });
      assert(res.data.item?.containerAfter === containerId, 'probe 1: containerAfter=container', {
        after: res.data.item?.containerAfter,
      });
    }
    const live = await readItem(page, ACTOR_ID, itemId);
    assert(live !== 'GONE' && live.container === containerId, 'probe 1: live container set', {
      live,
    });

    // --------------------------------------------------------------
    // Probe 2: move container → root.
    // --------------------------------------------------------------
    const res2 = await call({ actorId: ACTOR_ID, itemId, containerId: null });
    log.info({ probe: 2, res: res2 }, 'probe 2: move container → root');
    assert(res2.ok === true, 'probe 2: ok', { res: res2 });
    if (res2.ok) {
      assert(
        res2.data.item?.containerBefore === containerId,
        'probe 2: containerBefore=container',
        {
          before: res2.data.item?.containerBefore,
        },
      );
      assert(res2.data.item?.containerAfter === null, 'probe 2: containerAfter=null', {
        after: res2.data.item?.containerAfter,
      });
    }

    // --------------------------------------------------------------
    // Probe 3: same-destination move → no-op.
    // --------------------------------------------------------------
    const res3 = await call({ actorId: ACTOR_ID, itemId, containerId: null });
    log.info({ probe: 3, res: res3 }, 'probe 3: same-destination move');
    assert(res3.ok === true, 'probe 3: ok', { res: res3 });
    if (res3.ok) {
      assert(
        res3.data.operation === 'moved' &&
          res3.data.item?.containerBefore === res3.data.item?.containerAfter,
        'probe 3: no-op (containerBefore === containerAfter)',
        { item: res3.data.item },
      );
    }
  }

  // ------------------------------------------------------------------
  // Probe 4: merge — move a stack into a container holding a same-source
  // stack.
  // ------------------------------------------------------------------
  {
    const [stackInContainer] = await createItems(page, ACTOR_ID, [
      {
        sourceUuid: WEAPON,
        name: '__probe_mv mergeTarget',
        quantity: 5,
        container: p1Container,
        compendiumSource: SRC_A,
      },
    ]);
    const [stackAtRoot] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv mergeSource', quantity: 3, compendiumSource: SRC_A },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId: stackAtRoot, containerId: p1Container });
    log.info({ probe: 4, res }, 'probe 4: merge into container');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'merged', 'probe 4: operation=merged', {
        op: res.data.operation,
      });
      assert(
        res.data.mergedInto?.id === stackInContainer,
        'probe 4: merged into the container stack',
        {
          mergedInto: res.data.mergedInto?.id,
        },
      );
      assert(res.data.mergedInto?.newQuantity === 8, 'probe 4: newQuantity=8', {
        newQuantity: res.data.mergedInto?.newQuantity,
      });
    }
    const sourceGone = await readItem(page, ACTOR_ID, stackAtRoot);
    assert(sourceGone === 'GONE', 'probe 4: merge source deleted', { sourceGone });
  }

  // ------------------------------------------------------------------
  // Probe 5: merge:"never" → a separate entry survives.
  // ------------------------------------------------------------------
  {
    const [stackAtRoot] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv neverMerge', quantity: 2, compendiumSource: SRC_A },
    ]);
    const res = await call({
      actorId: ACTOR_ID,
      itemId: stackAtRoot,
      containerId: p1Container,
      merge: 'never',
    });
    log.info({ probe: 5, res }, 'probe 5: merge:never');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 5: operation=moved (no merge)', {
        op: res.data.operation,
      });
    }
    const live = await readItem(page, ACTOR_ID, stackAtRoot);
    assert(
      live !== 'GONE' && live.container === p1Container && live.quantity === 2,
      'probe 5: separate entry survives in the container',
      { live },
    );
  }

  // ------------------------------------------------------------------
  // Probe 6: move a populated container — children's refs stay intact.
  // ------------------------------------------------------------------
  {
    const [parentId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: CONTAINER, name: '__probe_mv parent' },
    ]);
    const [childId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv child', container: parentId },
    ]);
    const [grandId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: CONTAINER, name: '__probe_mv grandparent' },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId: parentId, containerId: grandId });
    log.info({ probe: 6, res }, 'probe 6: move a populated container');
    assert(res.ok === true && res.data.operation === 'moved', 'probe 6: moved', { res });
    const child = await readItem(page, ACTOR_ID, childId);
    assert(
      child !== 'GONE' && child.container === parentId,
      'probe 6: child stays inside the moved container',
      { child },
    );
  }

  // ------------------------------------------------------------------
  // Probe 7: self-cycle → CYCLE_DETECTED.
  // ------------------------------------------------------------------
  {
    const [containerId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: CONTAINER, name: '__probe_mv selfcycle' },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId: containerId, containerId });
    log.info({ probe: 7, res }, 'probe 7: self-cycle');
    assert(res.isError === true, 'probe 7: error', { res });
    assert(res.error?.details?.reason === 'CYCLE_DETECTED', 'probe 7: reason=CYCLE_DETECTED', {
      reason: res.error?.details?.reason,
    });
  }

  // ------------------------------------------------------------------
  // Probe 8: depth-2 cycle → CYCLE_DETECTED.
  // ------------------------------------------------------------------
  {
    const [outerId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: CONTAINER, name: '__probe_mv cycleOuter' },
    ]);
    const [innerId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: CONTAINER, name: '__probe_mv cycleInner', container: outerId },
    ]);
    // Move outer into inner → outer would be its own ancestor.
    const res = await call({ actorId: ACTOR_ID, itemId: outerId, containerId: innerId });
    log.info({ probe: 8, res }, 'probe 8: depth-2 cycle');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(res.error?.details?.reason === 'CYCLE_DETECTED', 'probe 8: reason=CYCLE_DETECTED', {
      reason: res.error?.details?.reason,
    });
  }

  // ------------------------------------------------------------------
  // Probe 9: non-container target → CONTAINER_TYPE_INVALID.
  // ------------------------------------------------------------------
  {
    const [weaponId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv notAContainer' },
    ]);
    const [itemId] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv movee9' },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId, containerId: weaponId });
    log.info({ probe: 9, res }, 'probe 9: non-container target');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(
      res.error?.details?.reason === 'CONTAINER_TYPE_INVALID',
      'probe 9: reason=CONTAINER_TYPE_INVALID',
      { reason: res.error?.details?.reason },
    );
  }

  // ------------------------------------------------------------------
  // Probe 10: non-physical item → NON_PHYSICAL_ITEM.
  // ------------------------------------------------------------------
  {
    const [featId] = await createItems(page, ACTOR_ID, [{ type: 'feat', name: '__probe_mv feat' }]);
    const res = await call({ actorId: ACTOR_ID, itemId: featId, containerId: p1Container });
    log.info({ probe: 10, res }, 'probe 10: non-physical item');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'NON_PHYSICAL_ITEM',
      'probe 10: reason=NON_PHYSICAL_ITEM',
      { reason: res.error?.details?.reason },
    );
  }

  // ------------------------------------------------------------------
  // Probe 11: bogus ids.
  // ------------------------------------------------------------------
  {
    const r1 = await call({ actorId: 'deadbeefdeadbeef', itemId: 'x', containerId: null });
    assert(
      r1.isError && r1.error?.details?.reason === 'ACTOR_NOT_FOUND',
      'probe 11a: bogus actorId → ACTOR_NOT_FOUND',
      { r1 },
    );
    const r2 = await call({ actorId: ACTOR_ID, itemId: 'deadbeefdeadbeef', containerId: null });
    assert(
      r2.isError && r2.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 11b: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR',
      { r2 },
    );
    const [someItem] = await createItems(page, ACTOR_ID, [
      { sourceUuid: WEAPON, name: '__probe_mv movee11' },
    ]);
    const r3 = await call({
      actorId: ACTOR_ID,
      itemId: someItem,
      containerId: 'deadbeefdeadbeef',
    });
    assert(
      r3.isError && r3.error?.details?.reason === 'CONTAINER_NOT_FOUND',
      'probe 11c: bogus containerId → CONTAINER_NOT_FOUND',
      { r3 },
    );
    log.info({ probe: 11 }, 'probe 11: bogus-id rejections');
  }

  // ------------------------------------------------------------------
  // Probe 12: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
  // ------------------------------------------------------------------
  if (actorIds.other) {
    const res = await call({ actorId: actorIds.other.id, itemId: 'x', containerId: null });
    log.info({ probe: 12, res, otherType: actorIds.other.type }, 'probe 12: unsupported type');
    assert(
      res.isError && res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 12: reason=ACTOR_TYPE_UNSUPPORTED',
      { res },
    );
  } else {
    log.info({ probe: 12 }, 'probe 12: skipped — no vehicle/group/encounter actor in world');
  }

  // ------------------------------------------------------------------
  // Teardown: restore the actor to the start-of-probe snapshot.
  // ------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snap) => {
      const actor = globalThis.game.actors.get(actorId);
      const snapshotIds = new Set(snap.items.map((i) => i.id));
      const orphanIds = actor.items.contents.filter((i) => !snapshotIds.has(i.id)).map((i) => i.id);
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
        snapSigs.length === finalSigs.length && snapSigs.every((s, idx) => s === finalSigs[idx]);
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

  assert(teardown.finalItemCount === snapshot.itemCount, 'probe 13: item count equals snapshot', {
    snapshot: snapshot.itemCount,
    final: teardown.finalItemCount,
  });
  assert(teardown.signaturesMatch === true, 'probe 13: signature multiset matches snapshot', {
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
