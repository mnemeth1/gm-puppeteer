/**
 * Probe + acceptance script for transfer_item_between_actors. Drives
 * the live headless Foundry against the gm-puppeteer-sandbox world
 * and exercises every operation mode plus all input-rejection paths.
 *
 *   1.  Full transfer, no merge, destination root.
 *   2.  Full transfer, no merge, destination container.
 *   3.  Full transfer with merge — destination has a matching stack.
 *   4.  Split transfer, no merge.
 *   5.  Split transfer with merge.
 *   6.  Cascade transfer — backpack with two leaf items.
 *   7.  Cascade transfer — depth-2 nested container preserved.
 *   8.  Identification status preserved through transfer.
 *   9.  Equipment state reset (carryType: 'held' → 'stowed').
 *   10. ACTOR_NOT_FOUND (source).
 *   11. ACTOR_NOT_FOUND (destination).
 *   12. TRANSFER_TO_SAME_ACTOR.
 *   13. ITEM_NOT_FOUND_ON_ACTOR.
 *   14. TRANSFER_ON_NON_PHYSICAL (synthetic feat).
 *   15. CONTAINER_NOT_FOUND (bogus destinationContainerId).
 *   16. TARGET_NOT_CONTAINER (destinationContainerId → weapon).
 *   17. INVALID_QUANTITY (0 — zod or evaluator-layer rejection).
 *   18. INVALID_QUANTITY (quantity > available).
 *   19. SPLIT_ON_CONTAINER (partial qty on a backpack).
 *   20. Teardown: source actor signature multiset matches start.
 *
 * State restoration model: scratch destination actor is created in
 * a pre-probe step and deleted in teardown — the destination's state
 * doesn't need preservation. Source actor uses the full toObject()
 * snapshot model from probe-move-item-to-container.mjs (every item's
 * full payload at start; orphan deletes, missing recreates, drifted
 * qty/containerId restores; final signature-multiset assertion).
 *
 *   npm run build && node scripts/probe-transfer-item-between-actors.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'transfer_item_between_actors');
if (!tool) {
  log.error('transfer_item_between_actors not registered');
  process.exit(2);
}

const SOURCE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const ARROWS_UUID = 'Compendium.pf2e.equipment-srd.Item.w2ENw2VMPcsbif8g';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';
const BACKPACK_UUID = 'Compendium.pf2e.equipment-srd.Item.3lgwjrFEsQVKzhh7';

const SCRATCH_DEST_NAME = '__probe_transfer_dest__';

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

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe: scrub __probe_t_* leftovers from source AND any leftover
  // scratch destination actor from a crashed prior run.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(
    async (sourceActorId, scratchDestName) => {
      const result = { source: null, deletedDestActors: 0 };
      const sourceActor = globalThis.game.actors?.get(sourceActorId);
      if (sourceActor) {
        const orphans = sourceActor.items.contents
          .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe_t'))
          .map((i) => i.id);
        if (orphans.length > 0) {
          await sourceActor
            .updateEmbeddedDocuments(
              'Item',
              orphans.map((id) => ({ _id: id, 'system.containerId': null })),
            )
            .catch(() => undefined);
          await sourceActor.deleteEmbeddedDocuments('Item', orphans);
        }
        result.source = { deletedOrphans: orphans.length, itemCount: sourceActor.items.size };
      } else {
        result.source = { error: `source actor ${sourceActorId} not found` };
      }
      // Delete any stale scratch destination actors.
      const staleDest = [];
      for (const a of globalThis.game.actors?.contents ?? []) {
        if (a.name === scratchDestName) staleDest.push(a.id);
      }
      for (const id of staleDest) {
        await globalThis.game.actors
          .get(id)
          ?.delete()
          .catch(() => undefined);
      }
      result.deletedDestActors = staleDest.length;
      return result;
    },
    SOURCE_ACTOR_ID,
    SCRATCH_DEST_NAME,
  );
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub.source?.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot source actor (full toObject payloads for teardown restore).
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
  }, SOURCE_ACTOR_ID);
  log.info({ itemCount: startSnapshot.itemCount }, 'source snapshot captured');

  // --------------------------------------------------------------------
  // Create scratch destination actor (NPC to avoid character _preCreate
  // hooks that mutate token actorLink).
  // --------------------------------------------------------------------
  const destSetup = await page.evaluate(async (name) => {
    const created = await CONFIG.Actor.documentClass.create({
      name,
      type: 'npc',
    });
    return { id: created?.id ?? null, name: created?.name ?? null };
  }, SCRATCH_DEST_NAME);
  if (!destSetup?.id) {
    log.error({ destSetup }, 'failed to create scratch destination actor');
    process.exit(2);
  }
  const DEST_ACTOR_ID = destSetup.id;
  log.info({ destSetup }, 'scratch destination actor created');

  // Helper: create a scratch item on a specified actor from a compendium UUID.
  async function makeScratch(actorId, name, sourceUuid, overrides = {}) {
    return page.evaluate(
      async (actorId, name, sourceUuid, overrides) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(sourceUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name,
            system: { ...(data.system ?? {}), ...(overrides.system ?? {}) },
          },
        ]);
        const c = created[0];
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          qty: c.system?.quantity ?? null,
          containerId: c.system?.containerId ?? null,
          sourceUuid: c._stats?.compendiumSource ?? null,
        };
      },
      actorId,
      name,
      sourceUuid,
      overrides,
    );
  }

  // Helper: look up an item on an actor and return readable shape.
  async function readItem(actorId, itemId) {
    return page.evaluate(
      (actorId, itemId) => {
        const actor = globalThis.game.actors?.get(actorId);
        const item = actor?.items?.get?.(itemId);
        if (!item) return null;
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          qty: item.system?.quantity ?? null,
          containerId: item.system?.containerId ?? null,
          sourceUuid: item._stats?.compendiumSource ?? null,
          identificationStatus: item.system?.identification?.status ?? null,
          equipped: item.system?.equipped ? { ...item.system.equipped } : null,
        };
      },
      actorId,
      itemId,
    );
  }

  // --------------------------------------------------------------------
  // Probe 1: full transfer, no merge, destination root.
  // --------------------------------------------------------------------
  {
    const sword = await makeScratch(SOURCE_ACTOR_ID, '__probe_t1_sword', LONGSWORD_UUID, {
      system: { containerId: null },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sword.id,
      destinationContainerId: null,
    });
    log.info({ probe: 1, res }, 'probe 1: full transfer to dest root');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'transferred', 'probe 1: operation=transferred', {
        op: res.data.operation,
      });
      assert(res.data.item?.oldId === sword.id, 'probe 1: item.oldId echoes source id', {
        oldId: res.data.item?.oldId,
      });
      assert(
        typeof res.data.item?.newId === 'string' && res.data.item.newId.length > 0,
        'probe 1: item.newId is a non-empty string',
        { newId: res.data.item?.newId },
      );
      assert(res.data.item?.containerIdAfter === null, 'probe 1: containerIdAfter=null', {
        c: res.data.item?.containerIdAfter,
      });
      const sourceStill = await readItem(SOURCE_ACTOR_ID, sword.id);
      assert(sourceStill === null, 'probe 1: item gone from source', { sourceStill });
      const destLive = await readItem(DEST_ACTOR_ID, res.data.item?.newId);
      assert(destLive && destLive.type === 'weapon', 'probe 1: item present on dest', {
        destLive,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: full transfer, no merge, into a destination backpack.
  // --------------------------------------------------------------------
  {
    const destBp = await makeScratch(DEST_ACTOR_ID, '__probe_t2_destBp', BACKPACK_UUID);
    const sword = await makeScratch(SOURCE_ACTOR_ID, '__probe_t2_sword', LONGSWORD_UUID);
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sword.id,
      destinationContainerId: destBp.id,
    });
    log.info({ probe: 2, res }, 'probe 2: full transfer into dest backpack');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'transferred', 'probe 2: operation=transferred', {
        op: res.data.operation,
      });
      assert(res.data.item?.containerIdAfter === destBp.id, 'probe 2: containerIdAfter=destBp.id', {
        c: res.data.item?.containerIdAfter,
      });
      const destLive = await readItem(DEST_ACTOR_ID, res.data.item?.newId);
      assert(destLive?.containerId === destBp.id, 'probe 2: dest item lives inside dest backpack', {
        destLive,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: full transfer with merge.
  //
  // Source has scratch Arrows (qty=7). Dest has scratch Arrows (qty=10).
  // Both pulled from the same compendium UUID so _stats.compendiumSource
  // matches. Expect operation=transferredAndMerged, dest stack becomes 17,
  // source stack deleted.
  // --------------------------------------------------------------------
  {
    const destStack = await makeScratch(DEST_ACTOR_ID, '__probe_t3_arrows_dest', ARROWS_UUID, {
      system: { quantity: 10, containerId: null },
    });
    const sourceStack = await makeScratch(SOURCE_ACTOR_ID, '__probe_t3_arrows_src', ARROWS_UUID, {
      system: { quantity: 7, containerId: null },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sourceStack.id,
      destinationContainerId: null,
    });
    log.info({ probe: 3, res }, 'probe 3: full transfer with merge');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'transferredAndMerged',
        'probe 3: operation=transferredAndMerged',
        { op: res.data.operation },
      );
      assert(res.data.mergedInto?.id === destStack.id, 'probe 3: mergedInto.id=destStack.id', {
        mergedInto: res.data.mergedInto,
      });
      assert(res.data.mergedInto?.previousQuantity === 10, 'probe 3: previousQuantity=10', {
        q: res.data.mergedInto?.previousQuantity,
      });
      assert(res.data.mergedInto?.newQuantity === 17, 'probe 3: newQuantity=17', {
        q: res.data.mergedInto?.newQuantity,
      });
      assert(res.data.mergedInto?.addedQuantity === 7, 'probe 3: addedQuantity=7', {
        q: res.data.mergedInto?.addedQuantity,
      });
      assert(
        res.data.sourceDeletedId === sourceStack.id,
        'probe 3: sourceDeletedId echoes source id',
        { sourceDeletedId: res.data.sourceDeletedId },
      );
      const sourceStill = await readItem(SOURCE_ACTOR_ID, sourceStack.id);
      assert(sourceStill === null, 'probe 3: source stack deleted', { sourceStill });
      const destLive = await readItem(DEST_ACTOR_ID, destStack.id);
      assert(destLive?.qty === 17, 'probe 3: dest stack qty=17', { destLive });
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: split transfer, no merge.
  //
  // Source has scratch Arrows (qty=20). Transfer 5 to dest root with
  // merge:'never' — prior probe 3 left an arrows stack at dest root
  // with the same compendiumSource, so without merge:'never' this
  // would split-and-merge.
  // --------------------------------------------------------------------
  {
    const sourceStack = await makeScratch(SOURCE_ACTOR_ID, '__probe_t4_arrows', ARROWS_UUID, {
      system: { quantity: 20, containerId: null },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sourceStack.id,
      destinationContainerId: null,
      quantity: 5,
      merge: 'never',
    });
    log.info({ probe: 4, res }, 'probe 4: split transfer no merge');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'split', 'probe 4: operation=split', {
        op: res.data.operation,
      });
      assert(res.data.sourceItem?.qtyBefore === 20, 'probe 4: sourceItem.qtyBefore=20', {
        q: res.data.sourceItem?.qtyBefore,
      });
      assert(res.data.sourceItem?.qtyAfter === 15, 'probe 4: sourceItem.qtyAfter=15', {
        q: res.data.sourceItem?.qtyAfter,
      });
      assert(res.data.created?.quantity === 5, 'probe 4: created.quantity=5', {
        q: res.data.created?.quantity,
      });
      const sourceLive = await readItem(SOURCE_ACTOR_ID, sourceStack.id);
      assert(sourceLive?.qty === 15, 'probe 4: source qty=15 post-call', { sourceLive });
      const destLive = await readItem(DEST_ACTOR_ID, res.data.created?.newId);
      assert(destLive?.qty === 5, 'probe 4: dest qty=5 post-call', { destLive });
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: split transfer with merge.
  //
  // Source has scratch Arrows (qty=20). Dest has scratch Arrows (qty=10)
  // inside a fresh dest backpack — destination containerId isolates this
  // from prior probes' arrows at dest root. Transfer 4 of source's
  // arrows targeting that backpack. Expect operation=splitAndMerged,
  // source decremented to 16, dest stack bumped to 14, merge target is
  // exactly the destStack we created.
  // --------------------------------------------------------------------
  {
    const destBp = await makeScratch(DEST_ACTOR_ID, '__probe_t5_destBp', BACKPACK_UUID, {
      system: { containerId: null },
    });
    const destStack = await makeScratch(DEST_ACTOR_ID, '__probe_t5_arrows_dest', ARROWS_UUID, {
      system: { quantity: 10, containerId: destBp.id },
    });
    const sourceStack = await makeScratch(SOURCE_ACTOR_ID, '__probe_t5_arrows_src', ARROWS_UUID, {
      system: { quantity: 20, containerId: null },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sourceStack.id,
      destinationContainerId: destBp.id,
      quantity: 4,
    });
    log.info({ probe: 5, res }, 'probe 5: split transfer with merge');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'splitAndMerged', 'probe 5: operation=splitAndMerged', {
        op: res.data.operation,
      });
      assert(res.data.sourceItem?.qtyAfter === 16, 'probe 5: sourceItem.qtyAfter=16', {
        q: res.data.sourceItem?.qtyAfter,
      });
      assert(res.data.mergedInto?.id === destStack.id, 'probe 5: mergedInto.id=destStack.id', {
        mergedInto: res.data.mergedInto,
      });
      assert(res.data.mergedInto?.newQuantity === 14, 'probe 5: mergedInto.newQuantity=14', {
        q: res.data.mergedInto?.newQuantity,
      });
      assert(res.data.mergedInto?.addedQuantity === 4, 'probe 5: mergedInto.addedQuantity=4', {
        q: res.data.mergedInto?.addedQuantity,
      });
      const sourceLive = await readItem(SOURCE_ACTOR_ID, sourceStack.id);
      assert(sourceLive?.qty === 16, 'probe 5: source qty=16', { sourceLive });
      const destLive = await readItem(DEST_ACTOR_ID, destStack.id);
      assert(destLive?.qty === 14, 'probe 5: dest qty=14', { destLive });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: cascade transfer — backpack with two leaf items.
  //
  // Source: scratch Backpack, with a Healing Potion (qty=2) and a
  // Longsword inside. Transfer the backpack to dest root.
  // Expect: operation=cascadeTransferred, root.containerIdAfter=null,
  // two descendants both with containerIdAfter=root.newId. Source has
  // none of the subtree items. Dest has 3 new items with the right
  // containerId tree.
  // --------------------------------------------------------------------
  {
    const sourceBp = await makeScratch(SOURCE_ACTOR_ID, '__probe_t6_bp', BACKPACK_UUID, {
      system: { containerId: null },
    });
    const potion = await makeScratch(SOURCE_ACTOR_ID, '__probe_t6_potion', HEALING_POTION_UUID, {
      system: { quantity: 2, containerId: sourceBp.id },
    });
    const sword = await makeScratch(SOURCE_ACTOR_ID, '__probe_t6_sword', LONGSWORD_UUID, {
      system: { containerId: sourceBp.id },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sourceBp.id,
      destinationContainerId: null,
    });
    log.info({ probe: 6, res }, 'probe 6: cascade transfer');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'cascadeTransferred', 'probe 6: operation=cascadeTransferred', {
        op: res.data.operation,
      });
      assert(res.data.root?.containerIdAfter === null, 'probe 6: root.containerIdAfter=null', {
        c: res.data.root?.containerIdAfter,
      });
      assert(
        Array.isArray(res.data.descendants) && res.data.descendants.length === 2,
        'probe 6: 2 descendants',
        { count: res.data.descendants?.length },
      );
      const rootNewId = res.data.root?.newId;
      const allDescendantsPointAtRoot = res.data.descendants?.every(
        (d) => d.containerIdAfter === rootNewId,
      );
      assert(allDescendantsPointAtRoot, 'probe 6: all descendants point at root.newId', {
        descendants: res.data.descendants,
        rootNewId,
      });
      // Source no longer has any of the subtree items.
      const sourceBpLive = await readItem(SOURCE_ACTOR_ID, sourceBp.id);
      const potionLive = await readItem(SOURCE_ACTOR_ID, potion.id);
      const swordLive = await readItem(SOURCE_ACTOR_ID, sword.id);
      assert(
        sourceBpLive === null && potionLive === null && swordLive === null,
        'probe 6: source subtree gone',
        { sourceBpLive, potionLive, swordLive },
      );
      // Dest has the three items with the right containerId tree.
      const destBp = await readItem(DEST_ACTOR_ID, rootNewId);
      assert(destBp?.type === 'backpack', 'probe 6: dest root is backpack', { destBp });
      for (const d of res.data.descendants ?? []) {
        const live = await readItem(DEST_ACTOR_ID, d.newId);
        assert(
          live?.containerId === rootNewId,
          `probe 6: descendant ${d.newId} containerId points at root`,
          { live, rootNewId },
        );
      }
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: cascade with depth-2 nesting.
  //
  // outerBp → innerBp → potion. Transfer outerBp. Verify the tree shape
  // is preserved on dest: outer at root, inner inside outer, potion
  // inside inner.
  // --------------------------------------------------------------------
  {
    const outerBp = await makeScratch(SOURCE_ACTOR_ID, '__probe_t7_outerBp', BACKPACK_UUID, {
      system: { containerId: null },
    });
    const innerBp = await makeScratch(SOURCE_ACTOR_ID, '__probe_t7_innerBp', BACKPACK_UUID, {
      system: { containerId: outerBp.id },
    });
    const potion = await makeScratch(SOURCE_ACTOR_ID, '__probe_t7_potion', HEALING_POTION_UUID, {
      system: { quantity: 1, containerId: innerBp.id },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: outerBp.id,
      destinationContainerId: null,
    });
    log.info({ probe: 7, res }, 'probe 7: cascade depth-2');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'cascadeTransferred', 'probe 7: operation=cascadeTransferred', {
        op: res.data.operation,
      });
      assert(res.data.descendants?.length === 2, 'probe 7: 2 descendants', {
        count: res.data.descendants?.length,
      });
      const rootNewId = res.data.root?.newId;
      const oldToNew = new Map();
      oldToNew.set(outerBp.id, rootNewId);
      for (const d of res.data.descendants ?? []) {
        oldToNew.set(d.oldId, d.newId);
      }
      const innerNewId = oldToNew.get(innerBp.id);
      const potionNewId = oldToNew.get(potion.id);
      const innerLive = await readItem(DEST_ACTOR_ID, innerNewId);
      const potionLive = await readItem(DEST_ACTOR_ID, potionNewId);
      assert(innerLive?.containerId === rootNewId, 'probe 7: inner backpack containerId=root', {
        innerLive,
        rootNewId,
      });
      assert(potionLive?.containerId === innerNewId, 'probe 7: potion containerId=inner backpack', {
        potionLive,
        innerNewId,
      });
      // Name-and-type cross-check: when oldId → newId is built
      // positionally from createEmbeddedDocuments's return array, this
      // assertion catches a swap. The name (read from dest live state)
      // must match the type captured from source.
      assert(
        innerLive?.type === 'backpack' && innerLive?.name === '__probe_t7_innerBp',
        'probe 7: dest item at innerNewId is the inner backpack (not the potion)',
        { innerLive },
      );
      assert(
        potionLive?.type === 'consumable' && potionLive?.name === '__probe_t7_potion',
        'probe 7: dest item at potionNewId is the potion (not the inner backpack)',
        { potionLive },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 8: identification status preserved.
  // --------------------------------------------------------------------
  {
    const sword = await makeScratch(SOURCE_ACTOR_ID, '__probe_t8_sword', LONGSWORD_UUID, {
      system: { containerId: null, identification: { status: 'unidentified' } },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sword.id,
      destinationContainerId: null,
    });
    log.info({ probe: 8, res }, 'probe 8: identification preserved');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      const destLive = await readItem(DEST_ACTOR_ID, res.data.item?.newId);
      assert(
        destLive?.identificationStatus === 'unidentified',
        'probe 8: dest item still unidentified',
        { destLive },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 9: equipment state reset.
  //
  // Create a sword on source with system.equipped = {carryType: 'held',
  // handsHeld: 1}. After transfer, dest's item should be
  // {carryType: 'stowed', handsHeld: 0}. merge:'never' so the assertion
  // reads the freshly-created entry's equipped state instead of merging
  // into a prior probe's sword and reading that instead.
  // --------------------------------------------------------------------
  {
    const sword = await makeScratch(SOURCE_ACTOR_ID, '__probe_t9_sword', LONGSWORD_UUID, {
      system: { containerId: null, equipped: { carryType: 'held', handsHeld: 1 } },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: sword.id,
      destinationContainerId: null,
      merge: 'never',
    });
    log.info({ probe: 9, res }, 'probe 9: equipment reset');
    assert(res.ok === true, 'probe 9: ok', { res });
    if (res.ok) {
      const destLive = await readItem(DEST_ACTOR_ID, res.data.item?.newId);
      assert(destLive?.equipped?.carryType === 'stowed', 'probe 9: dest carryType=stowed', {
        equipped: destLive?.equipped,
      });
      assert(destLive?.equipped?.handsHeld === 0, 'probe 9: dest handsHeld=0', {
        equipped: destLive?.equipped,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 10: ACTOR_NOT_FOUND (source).
  // --------------------------------------------------------------------
  {
    const res = await call({
      sourceActorId: 'deadbeefdeadbeef',
      destinationActorId: DEST_ACTOR_ID,
      itemId: 'whatever',
      destinationContainerId: null,
    });
    log.info({ probe: 10, res }, 'probe 10: bogus source actor');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_NOT_FOUND' && res.error?.details?.which === 'source',
      'probe 10: reason=ACTOR_NOT_FOUND, which=source',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: ACTOR_NOT_FOUND (destination).
  // --------------------------------------------------------------------
  {
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: 'deadbeefdeadbeef',
      itemId: 'whatever',
      destinationContainerId: null,
    });
    log.info({ probe: 11, res }, 'probe 11: bogus destination actor');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_NOT_FOUND' &&
        res.error?.details?.which === 'destination',
      'probe 11: reason=ACTOR_NOT_FOUND, which=destination',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 12: TRANSFER_TO_SAME_ACTOR.
  // --------------------------------------------------------------------
  {
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: SOURCE_ACTOR_ID,
      itemId: 'whatever',
      destinationContainerId: null,
    });
    log.info({ probe: 12, res }, 'probe 12: same-actor');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(
      res.error?.details?.reason === 'TRANSFER_TO_SAME_ACTOR',
      'probe 12: reason=TRANSFER_TO_SAME_ACTOR',
      { details: res.error?.details },
    );
    assert(
      typeof res.error?.message === 'string' && /move_item_to_container/.test(res.error.message),
      'probe 12: message points at move_item_to_container',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 13: ITEM_NOT_FOUND_ON_ACTOR.
  // --------------------------------------------------------------------
  {
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: 'deadbeefdeadbeef',
      destinationContainerId: null,
    });
    log.info({ probe: 13, res }, 'probe 13: bogus itemId');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 13: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 14: TRANSFER_ON_NON_PHYSICAL.
  // --------------------------------------------------------------------
  {
    const feat = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors.get(actorId);
      const created = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe_t14_feat',
          type: 'feat',
          system: { description: { value: '' } },
        },
      ]);
      return { id: created[0].id };
    }, SOURCE_ACTOR_ID);
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: feat.id,
      destinationContainerId: null,
    });
    log.info({ probe: 14, res }, 'probe 14: transfer feat');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'TRANSFER_ON_NON_PHYSICAL',
      'probe 14: reason=TRANSFER_ON_NON_PHYSICAL',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 15: CONTAINER_NOT_FOUND on destination.
  // --------------------------------------------------------------------
  {
    const item = await makeScratch(SOURCE_ACTOR_ID, '__probe_t15_potion', HEALING_POTION_UUID);
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: item.id,
      destinationContainerId: 'deadbeefdeadbeef',
    });
    log.info({ probe: 15, res }, 'probe 15: bogus destinationContainerId');
    assert(res.isError === true, 'probe 15: error', { res });
    assert(
      res.error?.details?.reason === 'CONTAINER_NOT_FOUND',
      'probe 15: reason=CONTAINER_NOT_FOUND',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 16: TARGET_NOT_CONTAINER (destination container is a weapon).
  // --------------------------------------------------------------------
  {
    const destSword = await makeScratch(DEST_ACTOR_ID, '__probe_t16_destSword', LONGSWORD_UUID);
    const item = await makeScratch(SOURCE_ACTOR_ID, '__probe_t16_potion', HEALING_POTION_UUID);
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: item.id,
      destinationContainerId: destSword.id,
    });
    log.info({ probe: 16, res }, 'probe 16: dest container is a weapon');
    assert(res.isError === true, 'probe 16: error', { res });
    assert(
      res.error?.details?.reason === 'TARGET_NOT_CONTAINER',
      'probe 16: reason=TARGET_NOT_CONTAINER',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 17: INVALID_QUANTITY (0). Zod schema rejects at the input
  // layer; the call surfaces as a validation error rather than a
  // tool error.
  // --------------------------------------------------------------------
  {
    const item = await makeScratch(SOURCE_ACTOR_ID, '__probe_t17_potion', HEALING_POTION_UUID, {
      system: { quantity: 5 },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: item.id,
      destinationContainerId: null,
      quantity: 0,
    });
    log.info({ probe: 17, res }, 'probe 17: quantity 0');
    assert(res.isError === true, 'probe 17: error', { res });
    const surfacedAsValidation = Array.isArray(res.validation);
    const surfacedAsToolError = res.error?.details?.reason === 'INVALID_QUANTITY';
    assert(
      surfacedAsValidation || surfacedAsToolError,
      'probe 17: zod or tool layer rejected quantity 0',
      { res },
    );
  }

  // --------------------------------------------------------------------
  // Probe 18: INVALID_QUANTITY (quantity > available).
  // --------------------------------------------------------------------
  {
    const item = await makeScratch(SOURCE_ACTOR_ID, '__probe_t18_potion', HEALING_POTION_UUID, {
      system: { quantity: 3 },
    });
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: item.id,
      destinationContainerId: null,
      quantity: 10,
    });
    log.info({ probe: 18, res }, 'probe 18: quantity > available');
    assert(res.isError === true, 'probe 18: error', { res });
    assert(res.error?.details?.reason === 'INVALID_QUANTITY', 'probe 18: reason=INVALID_QUANTITY', {
      details: res.error?.details,
    });
    assert(
      res.error?.details?.requested === 10 && res.error?.details?.available === 3,
      'probe 18: details echo requested and available',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 19: SPLIT_ON_CONTAINER.
  // --------------------------------------------------------------------
  {
    const bp = await makeScratch(SOURCE_ACTOR_ID, '__probe_t19_bp', BACKPACK_UUID);
    const res = await call({
      sourceActorId: SOURCE_ACTOR_ID,
      destinationActorId: DEST_ACTOR_ID,
      itemId: bp.id,
      destinationContainerId: null,
      quantity: 1,
    });
    log.info({ probe: 19, res }, 'probe 19: split on backpack');
    assert(res.isError === true, 'probe 19: error', { res });
    assert(
      res.error?.details?.reason === 'SPLIT_ON_CONTAINER',
      'probe 19: reason=SPLIT_ON_CONTAINER',
      { details: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Teardown.
  //
  //  1. Delete the scratch destination actor (cascades all its items).
  //  2. Restore source actor to start-of-probe signature:
  //       a. Neutralize containerId on orphans.
  //       b. Delete orphans.
  //       c. Recreate missing snapshot items (Foundry assigns fresh ids).
  //       d. Restore drifted qty + containerId for surviving snapshot ids.
  //  3. Probe 20: assert source signature multiset equals snapshot.
  // --------------------------------------------------------------------
  const teardownDest = await page.evaluate(async (destActorId) => {
    const actor = globalThis.game.actors?.get(destActorId);
    if (!actor) return { deleted: false, reason: 'already missing' };
    const itemCount = actor.items.size;
    await actor.delete();
    return { deleted: true, itemCount };
  }, DEST_ACTOR_ID);
  log.info({ teardownDest }, 'teardown: scratch destination actor deleted');

  const teardownSource = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapIds = new Set(snapshot.items.map((s) => s.id));
      const orphans = actor.items.contents.filter((i) => !snapIds.has(i.id)).map((i) => i.id);
      if (orphans.length > 0) {
        await actor
          .updateEmbeddedDocuments(
            'Item',
            orphans.map((id) => ({ _id: id, 'system.containerId': null })),
          )
          .catch(() => undefined);
      }
      const deleted = [];
      const deleteFailures = [];
      for (const id of orphans) {
        const live = actor.items.get(id);
        if (!live) continue;
        try {
          await actor.deleteEmbeddedDocuments('Item', [id]);
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
      const snapQty = new Map(snapshot.items.map((s) => [s.id, s.qty]));
      const snapContainer = new Map(snapshot.items.map((s) => [s.id, s.containerId]));
      for (const item of actor.items.contents) {
        const eq = snapQty.get(item.id);
        const ec = snapContainer.get(item.id);
        if (eq !== undefined) {
          const cq = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
          if (cq !== eq) updates.push({ _id: item.id, 'system.quantity': eq });
        }
        if (ec !== undefined) {
          const cc = item.system?.containerId ?? null;
          if (cc !== ec) updates.push({ _id: item.id, 'system.containerId': ec });
        }
      }
      if (updates.length > 0) await actor.updateEmbeddedDocuments('Item', updates);

      const sigOf = (s) => `${s.name ?? ''}|${s.type ?? ''}|${s.qty}|${s.containerId ?? ''}`;
      const liveSig = new Map();
      for (const item of actor.items.contents) {
        const k = sigOf({
          name: item.name,
          type: item.type,
          qty: typeof item.system?.quantity === 'number' ? item.system.quantity : 1,
          containerId: item.system?.containerId ?? null,
        });
        liveSig.set(k, (liveSig.get(k) ?? 0) + 1);
      }
      const snapSig = new Map();
      for (const s of snapshot.items) {
        const k = sigOf(s);
        snapSig.set(k, (snapSig.get(k) ?? 0) + 1);
      }
      const missing = [];
      for (const [k, n] of snapSig) {
        const have = liveSig.get(k) ?? 0;
        if (have !== n) missing.push({ k, expected: n, actual: have });
      }
      const extras = [];
      for (const [k, n] of liveSig) {
        if (!snapSig.has(k)) extras.push({ k, n });
      }

      return {
        orphansDeleted: deleted.length,
        deleteFailures,
        itemsRecreated: recreated.length,
        recreateFailures,
        updatesApplied: updates.length,
        finalItemCount: actor.items.size,
        signaturesMatch: missing.length === 0 && extras.length === 0,
        missing,
        extras,
      };
    },
    SOURCE_ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardownSource }, 'teardown: source actor restored');

  // --------------------------------------------------------------------
  // Probe 20: signature multiset equality on source actor.
  // --------------------------------------------------------------------
  assert(
    teardownSource.finalItemCount === startSnapshot.itemCount,
    'probe 20: source item count equals snapshot',
    { snap: startSnapshot.itemCount, final: teardownSource.finalItemCount },
  );
  assert(
    teardownSource.signaturesMatch === true,
    'probe 20: source signature multiset matches snapshot',
    { missing: teardownSource.missing, extras: teardownSource.extras },
  );
  assert(
    teardownSource.deleteFailures.length === 0,
    'probe 20: no orphan-delete failures on source',
    { failures: teardownSource.deleteFailures },
  );
  assert(teardownSource.recreateFailures.length === 0, 'probe 20: no recreate failures on source', {
    failures: teardownSource.recreateFailures,
  });
  assert(teardownDest.deleted === true, 'probe 20: scratch destination actor deleted', {
    teardownDest,
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
