/**
 * Probe + acceptance script for dnd5e_add_item_to_actor. Drives the live
 * headless Foundry against the dnd5e test world and exercises:
 *
 *   1.  Happy path: simple non-stackable weapon grant (merge: "never").
 *   2.  Grant a container — used as the containerId target by later probes.
 *   3.  Quantity > 1: stackable item x5 (merge: "never") — the merge target.
 *   4.  Auto-merge: +3 of the same stackable folds into probe-3's stack.
 *   5.  No-merge across container: stackable into the granted container
 *       stays separate from the top-level stack.
 *   6.  merge: "never" opt-out: a separate entry instead of folding. The
 *       assertion is contingent on the raw auto-merge finding (see below).
 *   7.  containerId placement: weapon into the granted container.
 *   8.  identified: false: weapon granted unidentified.
 *   9.  Raw auto-merge check (Q1): does createEmbeddedDocuments fold a
 *       duplicate? Run via direct page.evaluate, cleaned up in-place.
 *   10. Error: bogus actorId → ACTOR_NOT_FOUND.
 *   11. Error: unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped if
 *       the world has no vehicle/group/encounter actor).
 *   12. Error: bogus sourceUuid → SOURCE_NOT_FOUND.
 *   13. Error: sourceUuid resolves to a non-Item (a world Actor) →
 *       SOURCE_NOT_ITEM.
 *   14. Error: actor-embedded sourceUuid (Actor.X.Item.Y) →
 *       CROSS_ACTOR_UNSUPPORTED.
 *   15. Error: non-physical source (spell / feat) → NON_PHYSICAL_ITEM.
 *   16. Error: invalid quantity (0) — rejected by zod at the MCP edge.
 *   17. Error: bogus containerId → CONTAINER_NOT_FOUND.
 *   18. Error: non-container containerId → CONTAINER_TYPE_INVALID.
 *   19. Teardown verification: every item id and every modified quantity on
 *       the actor is restored to the start-of-probe snapshot.
 *
 * State restoration model (additive tool — probes only over-create):
 *  - At probe start, snapshot every item on the actor as {id, name, type, qty}.
 *  - At probe end, (a) delete any item whose id is on the actor but not in
 *    the snapshot, (b) for each snapshot id whose quantity drifted, restore
 *    via updateEmbeddedDocuments, (c) assert the post-teardown item-id set
 *    equals the snapshot set AND every snapshot id's quantity equals the
 *    snapshot quantity. A count-only check is insufficient — see CLAUDE.md
 *    "Writing probes for mutation tools".
 *
 *   npm run build && node scripts/probe-dnd5e-add-item-to-actor.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_add_item_to_actor');
if (!tool) {
  log.error('dnd5e_add_item_to_actor not registered');
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

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Resolve a probe-target character actor + an unsupported-type actor.
  // --------------------------------------------------------------------
  const actorIds = await page.evaluate(() => {
    const pc = globalThis.game.actors.find((a) => a.type === 'character');
    const other = globalThis.game.actors.find((a) => a.type !== 'character' && a.type !== 'npc');
    return {
      pc: pc ? { id: pc.id, name: pc.name, uuid: pc.uuid } : null,
      other: other ? { id: other.id, name: other.name, type: other.type } : null,
    };
  });
  if (!actorIds.pc) {
    log.error({ actorIds }, 'probe aborted: world needs a character actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const PROBE_ACTOR_ID = actorIds.pc.id;
  const PROBE_ACTOR_UUID = actorIds.pc.uuid;
  log.info({ actorIds }, 'resolved test actors');

  // --------------------------------------------------------------------
  // Snapshot: start-of-probe inventory shape teardown restores to.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors.get(actorId);
    return {
      itemCount: actor.items.size,
      items: actor.items.contents.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        qty: typeof i.system?.quantity === 'number' ? i.system.quantity : 1,
      })),
    };
  }, PROBE_ACTOR_ID);
  log.info(
    { itemCount: startSnapshot.itemCount, sample: startSnapshot.items.slice(0, 3) },
    'snapshot: start-of-probe inventory shape captured',
  );

  // --------------------------------------------------------------------
  // Discovery: compendium UUIDs needed for the probes — a non-stackable
  // weapon, a stackable consumable, a container, and a non-physical item.
  // Scans Item-pack indexes (no document loads) so it stays fast.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(async () => {
    const game = globalThis.game;
    const itemPacks = game.packs.filter((p) => p.documentName === 'Item');
    let weapon = null;
    let stackable = null;
    let container = null;
    let anyConsumable = null;
    let anyPhysical = null;
    let nonPhysical = null;
    for (const pack of itemPacks) {
      let idx;
      try {
        idx = await pack.getIndex();
      } catch {
        continue;
      }
      for (const e of idx.contents) {
        const uuid = e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`;
        const name = e.name ?? '';
        const type = e.type ?? '';
        if (!weapon && type === 'weapon' && /^longsword$/i.test(name)) {
          weapon = { uuid, name, type };
        }
        if (!container && type === 'container' && /backpack|pouch|sack/i.test(name)) {
          container = { uuid, name, type };
        }
        if (!stackable && type === 'consumable' && /arrow|bolt|bullet|dart/i.test(name)) {
          stackable = { uuid, name, type };
        }
        if (!anyConsumable && type === 'consumable') anyConsumable = { uuid, name, type };
        if (
          !anyPhysical &&
          (type === 'weapon' || type === 'equipment' || type === 'consumable' || type === 'tool')
        ) {
          anyPhysical = { uuid, name, type };
        }
        if (!nonPhysical && (type === 'spell' || type === 'feat')) {
          nonPhysical = { uuid, name, type };
        }
      }
    }
    return {
      packCount: itemPacks.length,
      weapon: weapon ?? anyPhysical,
      stackable: stackable ?? anyConsumable ?? anyPhysical,
      container,
      nonPhysical,
    };
  });
  log.info({ discovery }, 'discovered probe targets');

  if (!discovery.weapon) {
    log.error('no physical weapon/item discovered in any compendium — cannot probe');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  if (!discovery.stackable) {
    log.error('no stackable item discovered — cannot probe merge paths');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  if (!discovery.container) {
    log.warn('no container item discovered — container probes (5, 7, 18) will be skipped');
  }
  if (!discovery.nonPhysical) {
    log.warn('no spell/feat discovered — non-physical probe (15) will be skipped');
  }

  const WEAPON_UUID = discovery.weapon.uuid;
  const STACKABLE_UUID = discovery.stackable.uuid;

  // --------------------------------------------------------------------
  // Probe 9 (run early): raw auto-merge + compendiumSource-persistence
  // check. Does createEmbeddedDocuments fold a duplicate item, and does an
  // explicitly-set _stats.compendiumSource survive the create? Both feed
  // the merge design — probe 6's assertion depends on the answer.
  // Measured by actor.items.size delta so it does not itself depend on
  // compendiumSource.
  // --------------------------------------------------------------------
  const rawMerge = await page.evaluate(
    async (actorId, weaponUuid) => {
      const actor = globalThis.game.actors.get(actorId);
      const src = await fromUuid(weaponUuid);
      const beforeSize = actor.items.size;
      const beforeIds = new Set(actor.items.contents.map((i) => i.id));
      const mk = () => {
        const d = src.toObject();
        d.system = { ...(d.system ?? {}), quantity: 1 };
        d._stats = { ...(d._stats ?? {}), compendiumSource: weaponUuid };
        return d;
      };
      await actor.createEmbeddedDocuments('Item', [mk()]);
      await actor.createEmbeddedDocuments('Item', [mk()]);
      const afterSize = actor.items.size;
      const created = actor.items.contents.filter((i) => !beforeIds.has(i.id));
      const compendiumSourcePersisted =
        created.length === 2 && created.every((i) => i._stats?.compendiumSource === weaponUuid);
      const ids = created.map((i) => i.id);
      if (ids.length > 0) await actor.deleteEmbeddedDocuments('Item', ids);
      return {
        beforeSize,
        afterSize,
        createdCount: created.length,
        autoMerges: afterSize - beforeSize < 2,
        compendiumSourcePersisted,
      };
    },
    PROBE_ACTOR_ID,
    WEAPON_UUID,
  );
  log.info({ probe: 9, rawMerge }, 'probe 9: raw createEmbeddedDocuments auto-merge check');
  assert(
    rawMerge.autoMerges === false,
    'probe 9: createEmbeddedDocuments does NOT auto-merge (expected — stacking is a UI handler)',
    { rawMerge },
  );
  assert(
    rawMerge.compendiumSourcePersisted === true,
    'probe 9: an explicitly-set _stats.compendiumSource survives the create',
    { rawMerge },
  );

  // --------------------------------------------------------------------
  // Probe 1: happy path — non-stackable weapon, merge: "never".
  // --------------------------------------------------------------------
  let probe1ItemId = null;
  let probe1ItemUuid = null;
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: WEAPON_UUID, merge: 'never' });
    log.info({ probe: 1, res }, 'probe 1: simple weapon grant');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 1: operation=created', {
        op: res.data.operation,
      });
      assert(res.data.item?.quantity === 1, 'probe 1: quantity=1', {
        qty: res.data.item?.quantity,
      });
      assert(
        res.data.item?.sourceUuid === WEAPON_UUID,
        'probe 1: sourceUuid echoed (compendiumSource populated)',
        { sourceUuid: res.data.item?.sourceUuid },
      );
      assert(res.data.item?.container === null, 'probe 1: container=null at root', {
        container: res.data.item?.container,
      });
      assert(res.data.item?.identified === true, 'probe 1: identified=true', {
        identified: res.data.item?.identified,
      });
      probe1ItemId = res.data.item?.id ?? null;
      probe1ItemUuid = res.data.item?.uuid ?? null;
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: grant a container — the containerId target for later probes.
  // --------------------------------------------------------------------
  let grantedContainerId = null;
  if (discovery.container) {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: discovery.container.uuid,
      merge: 'never',
    });
    log.info({ probe: 2, res }, 'probe 2: grant a container');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 2: operation=created', {
        op: res.data.operation,
      });
      assert(res.data.item?.type === 'container', 'probe 2: type=container', {
        type: res.data.item?.type,
      });
      grantedContainerId = res.data.item?.id ?? null;
    }
  } else {
    log.info({ probe: 2 }, 'probe 2: skipped — no container item discovered');
  }

  // --------------------------------------------------------------------
  // Probe 3: quantity > 1 — stackable x5, merge: "never". Merge target
  // for probe 4.
  // --------------------------------------------------------------------
  let topStackId = null;
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: STACKABLE_UUID,
      quantity: 5,
      merge: 'never',
    });
    log.info({ probe: 3, res }, 'probe 3: stackable x5');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 3: operation=created', {
        op: res.data.operation,
      });
      assert(res.data.item?.quantity === 5, 'probe 3: quantity=5', {
        qty: res.data.item?.quantity,
      });
      topStackId = res.data.item?.id ?? null;
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: auto-merge — +3 of the same stackable folds into probe-3's
  // stack (same source, same container=null, same identified=true).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: STACKABLE_UUID, quantity: 3 });
    log.info({ probe: 4, res }, 'probe 4: stackable +3 auto-merge');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'merged', 'probe 4: operation=merged', {
        op: res.data.operation,
      });
      assert(res.data.mergedInto?.id === topStackId, 'probe 4: merged into probe-3 stack', {
        mergedInto: res.data.mergedInto?.id,
        topStackId,
      });
      assert(res.data.mergedInto?.previousQuantity === 5, 'probe 4: previousQuantity=5', {
        previous: res.data.mergedInto?.previousQuantity,
      });
      assert(res.data.mergedInto?.newQuantity === 8, 'probe 4: newQuantity=8', {
        newQuantity: res.data.mergedInto?.newQuantity,
      });
      assert(res.data.mergedInto?.addedQuantity === 3, 'probe 4: addedQuantity=3', {
        added: res.data.mergedInto?.addedQuantity,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: no-merge across container — stackable into the granted
  // container stays separate from the top-level stack.
  // --------------------------------------------------------------------
  if (grantedContainerId) {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: STACKABLE_UUID,
      quantity: 2,
      containerId: grantedContainerId,
    });
    log.info({ probe: 5, res }, 'probe 5: stackable into container');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 5: operation=created (container differs)', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.container === grantedContainerId,
        'probe 5: container set on new entry',
        { container: res.data.item?.container },
      );
    }
  } else {
    log.info({ probe: 5 }, 'probe 5: skipped — no container available');
  }

  // --------------------------------------------------------------------
  // Probe 6: merge: "never" opt-out — a separate top-level entry instead
  // of folding into probe-3's stack. Assertion is contingent on the raw
  // auto-merge finding from probe 9.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: STACKABLE_UUID,
      quantity: 2,
      merge: 'never',
    });
    log.info({ probe: 6, res }, 'probe 6: stackable +2 merge=never');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      if (rawMerge.autoMerges) {
        assert(
          res.data.operation === 'merged' && Array.isArray(res.data.warnings),
          'probe 6: dnd5e auto-merges on create — merge=never reported as merged with a warning',
          { op: res.data.operation, warnings: res.data.warnings },
        );
      } else {
        assert(res.data.operation === 'created', 'probe 6: merge=never created a separate entry', {
          op: res.data.operation,
        });
        assert(res.data.item?.quantity === 2, 'probe 6: separate stack qty=2', {
          qty: res.data.item?.quantity,
        });
      }
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: containerId placement — weapon into the granted container.
  // --------------------------------------------------------------------
  if (grantedContainerId) {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: WEAPON_UUID,
      containerId: grantedContainerId,
    });
    log.info({ probe: 7, res }, 'probe 7: weapon into container');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 7: operation=created', {
        op: res.data.operation,
      });
      assert(res.data.item?.container === grantedContainerId, 'probe 7: container reflected', {
        container: res.data.item?.container,
      });
    }
  } else {
    log.info({ probe: 7 }, 'probe 7: skipped — no container available');
  }

  // --------------------------------------------------------------------
  // Probe 8: identified: false.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: WEAPON_UUID,
      identified: false,
    });
    log.info({ probe: 8, res }, 'probe 8: weapon unidentified');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(res.data.item?.identified === false, 'probe 8: identified=false', {
        identified: res.data.item?.identified,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 10: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef', sourceUuid: WEAPON_UUID });
    log.info({ probe: 10, res }, 'probe 10: bogus actorId');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 10: reason=ACTOR_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 11: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
  // --------------------------------------------------------------------
  if (actorIds.other) {
    const res = await call({ actorId: actorIds.other.id, sourceUuid: WEAPON_UUID });
    log.info({ probe: 11, res, otherType: actorIds.other.type }, 'probe 11: unsupported type');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 11: reason=ACTOR_TYPE_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 11 }, 'probe 11: skipped — no vehicle/group/encounter actor in world');
  }

  // --------------------------------------------------------------------
  // Probe 12: bogus sourceUuid → SOURCE_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: 'Compendium.dnd5e.items.Item.deadbeefdeadbeef',
    });
    log.info({ probe: 12, res }, 'probe 12: bogus sourceUuid');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(res.error?.details?.reason === 'SOURCE_NOT_FOUND', 'probe 12: reason=SOURCE_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 13: sourceUuid resolves to a non-Item (the probe actor itself) →
  // SOURCE_NOT_ITEM.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: PROBE_ACTOR_UUID });
    log.info({ probe: 13, res }, 'probe 13: actor uuid as source');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(res.error?.details?.reason === 'SOURCE_NOT_ITEM', 'probe 13: reason=SOURCE_NOT_ITEM', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 14: actor-embedded sourceUuid (Actor.X.Item.Y) →
  // CROSS_ACTOR_UNSUPPORTED. Uses the probe-1 weapon's own uuid.
  // --------------------------------------------------------------------
  if (probe1ItemUuid) {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: probe1ItemUuid });
    log.info({ probe: 14, res }, 'probe 14: actor-embedded item uuid');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'CROSS_ACTOR_UNSUPPORTED',
      'probe 14: reason=CROSS_ACTOR_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 14 }, 'probe 14: skipped — probe 1 produced no item uuid');
  }

  // --------------------------------------------------------------------
  // Probe 15: non-physical source (spell / feat) → NON_PHYSICAL_ITEM.
  // --------------------------------------------------------------------
  if (discovery.nonPhysical) {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: discovery.nonPhysical.uuid });
    log.info({ probe: 15, res, type: discovery.nonPhysical.type }, 'probe 15: non-physical source');
    assert(res.isError === true, 'probe 15: error', { res });
    assert(
      res.error?.details?.reason === 'NON_PHYSICAL_ITEM',
      'probe 15: reason=NON_PHYSICAL_ITEM',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 15 }, 'probe 15: skipped — no spell/feat discovered');
  }

  // --------------------------------------------------------------------
  // Probe 16: invalid quantity (0) — rejected by zod at the MCP edge.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: WEAPON_UUID, quantity: 0 });
    log.info({ probe: 16, res }, 'probe 16: quantity 0');
    assert(res.isError === true, 'probe 16: error', { res });
    const surfacedAsValidation = Array.isArray(res.validation);
    const surfacedAsToolError = res.error?.details?.reason === 'INVALID_QUANTITY';
    assert(
      surfacedAsValidation || surfacedAsToolError,
      'probe 16: invalid quantity surfaced as zod validation or tool error',
      { res },
    );
  }

  // --------------------------------------------------------------------
  // Probe 17: bogus containerId → CONTAINER_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: WEAPON_UUID,
      containerId: 'deadbeefdeadbeef',
    });
    log.info({ probe: 17, res }, 'probe 17: bogus containerId');
    assert(res.isError === true, 'probe 17: error', { res });
    assert(
      res.error?.details?.reason === 'CONTAINER_NOT_FOUND',
      'probe 17: reason=CONTAINER_NOT_FOUND',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 18: non-container containerId — point at the probe-1 weapon →
  // CONTAINER_TYPE_INVALID.
  // --------------------------------------------------------------------
  if (probe1ItemId) {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: WEAPON_UUID,
      containerId: probe1ItemId,
    });
    log.info({ probe: 18, res }, 'probe 18: non-container containerId');
    assert(res.isError === true, 'probe 18: error', { res });
    assert(
      res.error?.details?.reason === 'CONTAINER_TYPE_INVALID',
      'probe 18: reason=CONTAINER_TYPE_INVALID',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 18 }, 'probe 18: skipped — probe 1 produced no item id');
  }

  // --------------------------------------------------------------------
  // Teardown: restore the actor to the exact start-of-probe snapshot.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors.get(actorId);
      const snapshotIds = new Set(snapshot.items.map((i) => i.id));
      const snapshotQty = new Map(snapshot.items.map((i) => [i.id, i.qty]));

      // 1. Delete orphans (one-by-one to tolerate cascade auto-deletes).
      const deleted = [];
      const deleteFailures = [];
      const orphanIds = actor.items.contents.filter((i) => !snapshotIds.has(i.id)).map((i) => i.id);
      for (const id of orphanIds) {
        const existing = actor.items.get(id);
        if (!existing) continue;
        try {
          await existing.delete();
          deleted.push(id);
        } catch (err) {
          deleteFailures.push(`${id}:${err?.message ?? String(err)}`);
        }
      }

      // 2. Restore quantities that drifted.
      const updates = [];
      for (const item of actor.items.contents) {
        const expected = snapshotQty.get(item.id);
        if (expected === undefined) continue;
        const current = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        if (current !== expected) {
          updates.push({ _id: item.id, 'system.quantity': expected });
        }
      }
      if (updates.length > 0) {
        await actor.updateEmbeddedDocuments('Item', updates);
      }

      // 3. Verify and report.
      const finalIds = new Set(actor.items.contents.map((i) => i.id));
      const driftedAfter = [];
      for (const item of actor.items.contents) {
        const expected = snapshotQty.get(item.id);
        if (expected === undefined) continue;
        const current = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        if (current !== expected) {
          driftedAfter.push({ id: item.id, name: item.name, expected, actual: current });
        }
      }
      const extraIds = [...finalIds].filter((id) => !snapshotIds.has(id));
      const missingIds = [...snapshotIds].filter((id) => !finalIds.has(id));

      return {
        deletedCount: deleted.length,
        deleteFailures,
        updatedCount: updates.length,
        finalItemCount: actor.items.size,
        idsMatch: extraIds.length === 0 && missingIds.length === 0,
        extraIds,
        missingIds,
        driftedAfter,
      };
    },
    PROBE_ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown: restore to start-of-probe snapshot');

  // --------------------------------------------------------------------
  // Probe 19: snapshot-equality verification.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 19: item count equals snapshot',
    { snapshot: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(teardown.idsMatch === true, 'probe 19: item-id set equals snapshot', {
    extraIds: teardown.extraIds,
    missingIds: teardown.missingIds,
  });
  assert(teardown.driftedAfter.length === 0, 'probe 19: every snapshot id has snapshot quantity', {
    drifted: teardown.driftedAfter,
  });
  assert(teardown.deleteFailures.length === 0, 'probe 19: no orphan delete failures', {
    failures: teardown.deleteFailures,
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
