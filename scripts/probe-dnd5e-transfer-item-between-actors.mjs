/**
 * Probe + acceptance script for dnd5e_transfer_item_between_actors. Drives
 * the live headless Foundry against the dnd5e test world (Foundry v14.361 /
 * dnd5e 5.3.3). Container-graph behavior was settled by
 * scripts/probe-dnd5e-inventory-graph-phase1.mjs; this script exercises
 * the shipped tool.
 *
 * Acceptance probes:
 *   1.  Full transfer, no merge → operation=transferred; gone from source.
 *   2.  Full transfer into a matching destination stack →
 *       operation=transferredAndMerged.
 *   3.  Partial-quantity split, no merge → operation=split.
 *   4.  Partial-quantity split into a matching stack → operation=splitAndMerged.
 *   5.  Cascade: a container with two nested items → operation=cascadeTransferred,
 *       two descendants, tree shape preserved on the destination.
 *   6.  Equip / attune reset: a transferred equipped+attuned item lands
 *       unequipped and unattuned.
 *   7.  Same-actor → TRANSFER_TO_SAME_ACTOR.
 *   8.  Non-physical item → NON_PHYSICAL_ITEM.
 *   9.  Partial-quantity on a container → SPLIT_ON_CONTAINER.
 *   10. Bogus source / destination / item / container ids → respective reasons.
 *   11. quantity > available → INVALID_QUANTITY.
 *   12. Destination container placement → containerAfter set.
 *   13. Teardown: scratch destination actor deleted; source restored to its
 *       start-of-probe signature multiset.
 *
 * State restoration (destructive — cross-actor transfer deletes from the
 * source): the destination is a scratch NPC actor created at probe start
 * and deleted whole at teardown. The source is a real character — snapshot
 * every item as {id, name, type, qty, container, payload: toObject()};
 * teardown deletes orphans, recreates any missing snapshot id from its
 * payload, restores drifted quantities, then asserts the
 * name|type|qty|container signature multiset matches.
 *
 *   npm run build && node scripts/probe-dnd5e-transfer-item-between-actors.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_transfer_item_between_actors');
if (!tool) {
  log.error('dnd5e_transfer_item_between_actors not registered');
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

// Create scratch items on an actor. Spec: { sourceUuid?, type?, name?,
// quantity?, container?, compendiumSource?, equipped?, attuned? }.
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
        if (typeof spec.equipped === 'boolean') data.system.equipped = spec.equipped;
        // `attunement` (the requirement) must be set before `attuned`
        // (the per-actor state) sticks — dnd5e clamps `attuned` to false
        // on an item with no attunement requirement.
        if (typeof spec.attunement === 'string') data.system.attunement = spec.attunement;
        if (typeof spec.attuned === 'boolean') data.system.attuned = spec.attuned;
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
        type: it.type ?? '',
        quantity: typeof it.system?.quantity === 'number' ? it.system.quantity : null,
        container:
          typeof it.system?.container === 'string' && it.system.container.length > 0
            ? it.system.container
            : null,
        equipped: it.system?.equipped ?? null,
        attuned: it.system?.attuned ?? null,
      };
    },
    actorId,
    itemId,
  );
}

let DEST_ID = null;

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
  const SOURCE_ID = actorIds.pc.id;

  // Create a scratch NPC destination actor.
  DEST_ID = await page.evaluate(async () => {
    const created = await globalThis.Actor.create({
      name: '__probe_transfer_dest',
      type: 'npc',
    });
    return created?.id ?? null;
  });
  if (!DEST_ID) {
    log.error('probe aborted: could not create a scratch destination actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  log.info({ SOURCE_ID, DEST_ID }, 'resolved source actor + created scratch destination');

  // Snapshot the source actor (full toObject payloads).
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
  }, SOURCE_ID);
  log.info({ itemCount: snapshot.itemCount }, 'source snapshot captured');

  // Discovery: weapon, equipment, container compendium sources.
  const discovery = await page.evaluate(async () => {
    const game = globalThis.game;
    const itemPacks = game.packs.filter((p) => p.documentName === 'Item');
    let weapon = null;
    let equipment = null;
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
        if (!equipment && type === 'equipment') equipment = { uuid, name: e.name ?? '', type };
        if (!container && type === 'container') container = { uuid, name: e.name ?? '', type };
      }
      if (weapon && equipment && container) break;
    }
    return { weapon, equipment, container };
  });
  log.info({ discovery }, 'discovered compendium sources');
  if (!discovery.weapon || !discovery.container) {
    log.error({ discovery }, 'probe aborted: need a weapon and a container in compendia');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const WEAPON = discovery.weapon.uuid;
  const CONTAINER = discovery.container.uuid;
  const EQUIPMENT = (discovery.equipment ?? discovery.weapon).uuid;

  // ------------------------------------------------------------------
  // Probe 1: full transfer, no merge.
  // ------------------------------------------------------------------
  {
    const [itemId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx full1' },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: null,
    });
    log.info({ probe: 1, res }, 'probe 1: full transfer');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'transferred', 'probe 1: operation=transferred', {
        op: res.data.operation,
      });
      assert(res.data.item?.oldId === itemId, 'probe 1: oldId echoed', { item: res.data.item });
      const sourceGone = await readItem(page, SOURCE_ID, itemId);
      assert(sourceGone === 'GONE', 'probe 1: gone from source', { sourceGone });
      const onDest = await readItem(page, DEST_ID, res.data.item?.newId);
      assert(onDest !== 'GONE', 'probe 1: present on destination', { onDest });
    }
  }

  // ------------------------------------------------------------------
  // Probe 2: full transfer into a matching destination stack.
  // ------------------------------------------------------------------
  {
    // Synthetic merge-identity tag — must be a format-valid compendium
    // UUID (real pack, 16-char id segment) or Foundry's
    // _stats.compendiumSource DocumentUUIDField drops the document.
    const SRC = 'Compendium.dnd5e.items.Item.PROBEtxMERGE0002';
    await createItems(page, DEST_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx merge2dest', quantity: 5, compendiumSource: SRC },
    ]);
    const [itemId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx merge2src', quantity: 3, compendiumSource: SRC },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: null,
    });
    log.info({ probe: 2, res }, 'probe 2: transfer + merge');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'transferredAndMerged',
        'probe 2: operation=transferredAndMerged',
        { op: res.data.operation },
      );
      assert(res.data.mergedInto?.newQuantity === 8, 'probe 2: newQuantity=8', {
        newQuantity: res.data.mergedInto?.newQuantity,
      });
      assert(res.data.sourceDeletedId === itemId, 'probe 2: sourceDeletedId echoed', {
        sourceDeletedId: res.data.sourceDeletedId,
      });
    }
    const sourceGone = await readItem(page, SOURCE_ID, itemId);
    assert(sourceGone === 'GONE', 'probe 2: gone from source', { sourceGone });
  }

  // ------------------------------------------------------------------
  // Probe 3: partial-quantity split, no merge.
  // ------------------------------------------------------------------
  {
    const [itemId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx split3', quantity: 10 },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: null,
      quantity: 4,
    });
    log.info({ probe: 3, res }, 'probe 3: split transfer');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'split', 'probe 3: operation=split', {
        op: res.data.operation,
      });
      assert(res.data.sourceItem?.qtyAfter === 6, 'probe 3: source qtyAfter=6', {
        qtyAfter: res.data.sourceItem?.qtyAfter,
      });
      assert(res.data.created?.quantity === 4, 'probe 3: created qty=4', {
        quantity: res.data.created?.quantity,
      });
    }
  }

  // ------------------------------------------------------------------
  // Probe 4: partial-quantity split into a matching stack.
  // ------------------------------------------------------------------
  {
    const SRC = 'Compendium.dnd5e.items.Item.PROBEtxMERGE0004';
    await createItems(page, DEST_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx merge4dest', quantity: 2, compendiumSource: SRC },
    ]);
    const [itemId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx merge4src', quantity: 10, compendiumSource: SRC },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: null,
      quantity: 3,
    });
    log.info({ probe: 4, res }, 'probe 4: split + merge');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'splitAndMerged', 'probe 4: operation=splitAndMerged', {
        op: res.data.operation,
      });
      assert(res.data.sourceItem?.qtyAfter === 7, 'probe 4: source qtyAfter=7', {
        qtyAfter: res.data.sourceItem?.qtyAfter,
      });
      assert(res.data.mergedInto?.newQuantity === 5, 'probe 4: dest newQuantity=5', {
        newQuantity: res.data.mergedInto?.newQuantity,
      });
    }
  }

  // ------------------------------------------------------------------
  // Probe 5: cascade — container with two nested items.
  // ------------------------------------------------------------------
  {
    const [containerId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: CONTAINER, name: '__probe_tx cascadeRoot' },
    ]);
    const [childA, childB] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx cascadeChildA', container: containerId },
      { sourceUuid: WEAPON, name: '__probe_tx cascadeChildB', container: containerId },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId: containerId,
      destinationContainerId: null,
    });
    log.info({ probe: 5, res }, 'probe 5: cascade transfer');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'cascadeTransferred', 'probe 5: operation=cascadeTransferred', {
        op: res.data.operation,
      });
      assert(res.data.descendants?.length === 2, 'probe 5: two descendants', {
        count: res.data.descendants?.length,
      });
      const rootNewId = res.data.root?.newId;
      const allUnderRoot = (res.data.descendants ?? []).every(
        (d) => d.containerAfter === rootNewId,
      );
      assert(allUnderRoot, 'probe 5: descendants nested under the new root id', {
        rootNewId,
        descendants: res.data.descendants,
      });
      const rootOnDest = await readItem(page, DEST_ID, rootNewId);
      assert(rootOnDest !== 'GONE' && rootOnDest.type === 'container', 'probe 5: root on dest', {
        rootOnDest,
      });
    }
    for (const id of [containerId, childA, childB]) {
      const gone = await readItem(page, SOURCE_ID, id);
      assert(gone === 'GONE', `probe 5: ${id} gone from source`, { gone });
    }
  }

  // ------------------------------------------------------------------
  // Probe 6: equip / attune reset.
  // ------------------------------------------------------------------
  {
    const [itemId] = await createItems(page, SOURCE_ID, [
      {
        sourceUuid: EQUIPMENT,
        name: '__probe_tx equipped6',
        equipped: true,
        attunement: 'optional',
        attuned: true,
      },
    ]);
    const before = await readItem(page, SOURCE_ID, itemId);
    assert(
      before !== 'GONE' && before.equipped === true && before.attuned === true,
      'probe 6: source item starts equipped + attuned',
      { before },
    );
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: null,
    });
    log.info({ probe: 6, res, before }, 'probe 6: equip/attune reset');
    assert(res.ok === true && res.data.operation === 'transferred', 'probe 6: transferred', {
      res,
    });
    if (res.ok) {
      const onDest = await readItem(page, DEST_ID, res.data.item?.newId);
      assert(
        onDest !== 'GONE' && onDest.equipped === false,
        'probe 6: equipped reset to false on destination',
        { onDest },
      );
      assert(
        onDest !== 'GONE' && onDest.attuned === false,
        'probe 6: attuned reset to false on destination',
        { onDest },
      );
    }
  }

  // ------------------------------------------------------------------
  // Probe 7: same-actor → TRANSFER_TO_SAME_ACTOR.
  // ------------------------------------------------------------------
  {
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: SOURCE_ID,
      itemId: 'x',
      destinationContainerId: null,
    });
    log.info({ probe: 7, res }, 'probe 7: same-actor');
    assert(
      res.isError && res.error?.details?.reason === 'TRANSFER_TO_SAME_ACTOR',
      'probe 7: reason=TRANSFER_TO_SAME_ACTOR',
      { res },
    );
  }

  // ------------------------------------------------------------------
  // Probe 8: non-physical item → NON_PHYSICAL_ITEM.
  // ------------------------------------------------------------------
  {
    const [featId] = await createItems(page, SOURCE_ID, [
      { type: 'feat', name: '__probe_tx feat8' },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId: featId,
      destinationContainerId: null,
    });
    log.info({ probe: 8, res }, 'probe 8: non-physical item');
    assert(
      res.isError && res.error?.details?.reason === 'NON_PHYSICAL_ITEM',
      'probe 8: reason=NON_PHYSICAL_ITEM',
      { res },
    );
  }

  // ------------------------------------------------------------------
  // Probe 9: partial-quantity on a container → SPLIT_ON_CONTAINER.
  // ------------------------------------------------------------------
  {
    const [containerId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: CONTAINER, name: '__probe_tx container9' },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId: containerId,
      destinationContainerId: null,
      quantity: 1,
    });
    log.info({ probe: 9, res }, 'probe 9: split on container');
    assert(
      res.isError && res.error?.details?.reason === 'SPLIT_ON_CONTAINER',
      'probe 9: reason=SPLIT_ON_CONTAINER',
      { res },
    );
  }

  // ------------------------------------------------------------------
  // Probe 10: bogus ids.
  // ------------------------------------------------------------------
  {
    const r1 = await call({
      sourceActorId: 'deadbeefdeadbeef',
      destinationActorId: DEST_ID,
      itemId: 'x',
      destinationContainerId: null,
    });
    assert(
      r1.isError &&
        r1.error?.details?.reason === 'ACTOR_NOT_FOUND' &&
        r1.error?.details?.which === 'source',
      'probe 10a: bogus source → ACTOR_NOT_FOUND (source)',
      { r1 },
    );
    const r2 = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: 'deadbeefdeadbeef',
      itemId: 'x',
      destinationContainerId: null,
    });
    assert(
      r2.isError &&
        r2.error?.details?.reason === 'ACTOR_NOT_FOUND' &&
        r2.error?.details?.which === 'destination',
      'probe 10b: bogus destination → ACTOR_NOT_FOUND (destination)',
      { r2 },
    );
    const r3 = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId: 'deadbeefdeadbeef',
      destinationContainerId: null,
    });
    assert(
      r3.isError && r3.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 10c: bogus itemId → ITEM_NOT_FOUND_ON_ACTOR',
      { r3 },
    );
    const [someItem] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx item10' },
    ]);
    const r4 = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId: someItem,
      destinationContainerId: 'deadbeefdeadbeef',
    });
    assert(
      r4.isError && r4.error?.details?.reason === 'CONTAINER_NOT_FOUND',
      'probe 10d: bogus destinationContainerId → CONTAINER_NOT_FOUND',
      { r4 },
    );
    log.info({ probe: 10 }, 'probe 10: bogus-id rejections');
  }

  // ------------------------------------------------------------------
  // Probe 11: quantity > available → INVALID_QUANTITY.
  // ------------------------------------------------------------------
  {
    const [itemId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx qty11', quantity: 2 },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: null,
      quantity: 5,
    });
    log.info({ probe: 11, res }, 'probe 11: quantity over available');
    assert(
      res.isError && res.error?.details?.reason === 'INVALID_QUANTITY',
      'probe 11: reason=INVALID_QUANTITY',
      { res },
    );
  }

  // ------------------------------------------------------------------
  // Probe 12: destination container placement.
  // ------------------------------------------------------------------
  {
    const [destContainerId] = await createItems(page, DEST_ID, [
      { sourceUuid: CONTAINER, name: '__probe_tx destContainer12' },
    ]);
    const [itemId] = await createItems(page, SOURCE_ID, [
      { sourceUuid: WEAPON, name: '__probe_tx placed12' },
    ]);
    const res = await call({
      sourceActorId: SOURCE_ID,
      destinationActorId: DEST_ID,
      itemId,
      destinationContainerId: destContainerId,
    });
    log.info({ probe: 12, res }, 'probe 12: destination container placement');
    assert(res.ok === true, 'probe 12: ok', { res });
    if (res.ok) {
      assert(
        res.data.item?.containerAfter === destContainerId,
        'probe 12: containerAfter is the destination container',
        { containerAfter: res.data.item?.containerAfter },
      );
      const onDest = await readItem(page, DEST_ID, res.data.item?.newId);
      assert(
        onDest !== 'GONE' && onDest.container === destContainerId,
        'probe 12: live item nested in the destination container',
        { onDest },
      );
    }
  }

  // ------------------------------------------------------------------
  // Teardown: delete the scratch destination actor, restore the source.
  // ------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (sourceId, destId, snap) => {
      // Delete the scratch destination actor whole.
      const dest = globalThis.game.actors.get(destId);
      if (dest) await dest.delete();

      const actor = globalThis.game.actors.get(sourceId);
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
        destActorDeleted: !globalThis.game.actors.get(destId),
        orphansDeleted: orphanIds.length,
        recreated: missing.length,
        quantitiesRestored: updates.length,
        finalItemCount: actor.items.size,
        signaturesMatch,
        snapSigs: signaturesMatch ? undefined : snapSigs,
        finalSigs: signaturesMatch ? undefined : finalSigs,
      };
    },
    SOURCE_ID,
    DEST_ID,
    snapshot,
  );
  DEST_ID = teardown.destActorDeleted ? null : DEST_ID;
  log.info({ teardown }, 'teardown: scratch destination removed, source restored');

  assert(teardown.destActorDeleted === true, 'probe 13: scratch destination actor deleted', {
    teardown,
  });
  assert(
    teardown.finalItemCount === snapshot.itemCount,
    'probe 13: source item count equals snapshot',
    { snapshot: snapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(teardown.signaturesMatch === true, 'probe 13: source signature multiset matches', {
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
  // Best-effort cleanup of the scratch destination actor on failure.
  if (DEST_ID) {
    try {
      const { page } = await session.ensureStarted();
      await page.evaluate(async (id) => {
        const a = globalThis.game.actors.get(id);
        if (a) await a.delete();
      }, DEST_ID);
    } catch {
      /* ignore */
    }
  }
} finally {
  await session.stop().catch(() => undefined);
}
