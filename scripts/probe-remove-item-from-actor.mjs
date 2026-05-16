/**
 * Probe + acceptance script for remove_item_from_actor. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Delete (physical): temp Longsword → operation: "deleted",
 *       ejectedToTopLevel: [], cascadeDeleted: [].
 *   2.  Delete (non-physical): temp feat → qtyAtDelete: null.
 *   3.  Decrement > 0: canonical Arrows (qty 20) -5 → "decremented",
 *       qtyAfter: 15 (teardown restores to 20).
 *   4.  Decrement to 0 with default delete: temp 1-qty consumable -1 →
 *       "decrementedAndDeleted", deletedItem.qtyBefore: 1.
 *   5.  Decrement to 0 with deleteIfZero: false: temp 1-qty consumable
 *       -1 with the flag → "decremented", qtyAfter: 0, entry persists
 *       at qty 0 (teardown deletes the orphan).
 *   6.  Decrement past 0 (clamp + delete): temp consumable qty 2 -5 →
 *       "decrementedAndDeleted", deletedItem.qtyBefore: 2.
 *   7.  Container delete with contents → ejectedToTopLevel: temp
 *       backpack with temp consumable inside; delete the backpack and
 *       confirm the consumable survives at top level (containerId
 *       null) and shows up in ejectedToTopLevel.
 *   8.  Granted-child cascade: synthetic parent + child with
 *       flags.pf2e.grantedBy.id=parent. Delete the parent. Verify (a)
 *       cascadeDeleted contains the child with reason "grantedBy" and
 *       (b) PF2e's auto-cascade actually removed the child from the
 *       actor.
 *   9.  Currency decrement: canonical Copper Pieces (qty 9) -5 →
 *       "decremented", qtyAfter: 4; actor.inventory.coins.cp updates
 *       to 4 (teardown restores to 9).
 *   10. Error: bogus actorId.
 *   11. Error: bogus itemId.
 *   12. Error: INCOMPATIBLE_INPUT — mode "delete" + quantity field
 *       (zod strict-mode rejection at the MCP boundary).
 *   13. Error: INVALID_QUANTITY — quantity: 0 in decrement mode (zod
 *       .min(1) rejection).
 *   14. Error: INVALID_QUANTITY — quantity: -1 in decrement mode.
 *   15. Error: DECREMENT_ON_NON_PHYSICAL — decrement a feat (canonical;
 *       rejected, no mutation).
 *   16. Error: MODE_REQUIRED — missing mode field (zod discriminator
 *       failure).
 *   17. Teardown verification: post-teardown signature multiset
 *       (name|type|qty) equals the start-of-probe signature multiset.
 *
 * State restoration model:
 *  - At probe start, snapshot every item on the actor as {id, name,
 *    type, qty, containerId, payload (item.toObject())}.
 *  - Probes 4-8 use temporary items the tool deletes; they leave no
 *    canonical trace.
 *  - Probes 3 and 9 mutate canonical item quantities; teardown restores
 *    those via updateEmbeddedDocuments.
 *  - At probe end, (a) delete every id present now that isn't in the
 *    snapshot (orphans from leftover/qty-0 probes), (b) recreate any
 *    snapshot id missing from the actor by calling
 *    createEmbeddedDocuments with the saved payload (Foundry assigns a
 *    fresh id — the original is unrecoverable), (c) restore any
 *    snapshot id whose quantity drifted.
 *  - Final assertion: post-teardown name+type+qty signature multiset
 *    equals the snapshot signature multiset. The id-equality assertion
 *    used by the add probe doesn't apply here because recreate
 *    assigns new ids — the signature multiset is the stronger,
 *    id-independent check.
 *
 *   npm run build && node scripts/probe-remove-item-from-actor.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'remove_item_from_actor');
if (!tool) {
  log.error('remove_item_from_actor not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B'; // Test Valeros in sandbox
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const BACKPACK_UUID = 'Compendium.pf2e.equipment-srd.Item.3lgwjrFEsQVKzhh7';
// NOTE: real compendium feats are NOT safe to instantiate via direct
// createEmbeddedDocuments for probe purposes. PF2e's GrantItem rules on
// feats like Pack Stalker hang the eval — the cascade attempts to
// resolve dependent compendium documents in a way that does not
// terminate cleanly in headless context (this is the same family of
// concern that motivated add_item_to_actor's ChoiceSet rejection). For
// probe 2 (delete-non-physical), we use a synthetic rules-free feat
// instead.

// Canonical baseline for Test Valeros — drives the pre-probe scrub.
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

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub. Converge Test Valeros back to canonical state
  // regardless of how a prior probe run exited.
  //   1. Delete any items whose name starts with "__probe" (probe
  //      generated names, leftover from a failed run).
  //   2. Delete any items not in the known canonical set with qty 0
  //      (qty-0 entries only exist if probe 5 left an orphan).
  //   3. Delete any non-canonical Arrows entries (matches add probe).
  //   4. Reset canonical Arrows qty to CANONICAL_ARROWS_QTY.
  //   5. Reset Copper Pieces qty to CANONICAL_COPPER_PIECES_QTY.
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
      // Synthesize a "known canonical" set by id; anything else with qty 0
      // is presumed probe leftover. We rely on naming above to catch the
      // common case; this is a belt-and-suspenders fallback.
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
  // Snapshot: full toObject() payload per item, plus signature fields.
  // For destructive probes, the payload is what lets teardown
  // recreate-on-restore (since the original id is unrecoverable after
  // a delete, and the post-teardown assertion shifts to a signature
  // multiset comparison).
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

  // --------------------------------------------------------------------
  // Discovery: target ids for canonical probes and a feat id for the
  // decrement-on-non-physical rejection.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    const items = actor.items.contents;
    const arrows = items.find((i) => (i.name ?? '').toLowerCase() === 'arrows');
    const copperPieces = items.find((i) => (i.name ?? '').toLowerCase() === 'copper pieces');
    const feat = items.find((i) => i.type === 'feat');
    return {
      arrowsId: arrows?.id ?? null,
      arrowsQty: arrows?.system?.quantity ?? null,
      cpId: copperPieces?.id ?? null,
      cpQty: copperPieces?.system?.quantity ?? null,
      featId: feat?.id ?? null,
      featName: feat?.name ?? null,
    };
  }, PROBE_ACTOR_ID);
  log.info({ discovery }, 'discovered probe targets');

  if (!discovery.arrowsId || !discovery.cpId || !discovery.featId) {
    log.error({ discovery }, 'missing required canonical targets; aborting');
    process.exit(2);
  }

  // Helper: create a temp item on actor via direct API, return its id.
  // Used for probes that need a fresh item the tool is then going to
  // mutate/delete. We tag temp items with names beginning "__probe" so
  // any leftover from a failed run is caught by the scrub.
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
  // Probe 1: delete (physical) — temp Longsword.
  // --------------------------------------------------------------------
  {
    const temp = await makeTemp('__probe1_longsword__', LONGSWORD_UUID, { quantity: 1 });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: temp.id,
      mode: 'delete',
    });
    log.info({ probe: 1, res }, 'probe 1: delete physical longsword');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 1: operation=deleted', {
        op: res.data.operation,
      });
      assert(res.data.deletedItem?.id === temp.id, 'probe 1: deletedItem.id matches', {
        di: res.data.deletedItem,
      });
      assert(res.data.deletedItem?.type === 'weapon', 'probe 1: type=weapon', {
        type: res.data.deletedItem?.type,
      });
      assert(res.data.deletedItem?.qtyAtDelete === 1, 'probe 1: qtyAtDelete=1', {
        qty: res.data.deletedItem?.qtyAtDelete,
      });
      assert(
        Array.isArray(res.data.ejectedToTopLevel) && res.data.ejectedToTopLevel.length === 0,
        'probe 1: no ejections',
        { e: res.data.ejectedToTopLevel },
      );
      assert(
        Array.isArray(res.data.cascadeDeleted) && res.data.cascadeDeleted.length === 0,
        'probe 1: no cascades',
        { c: res.data.cascadeDeleted },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: delete (non-physical) — synthetic rules-free feat.
  //
  // qtyAtDelete must be null since feats have no system.quantity. We
  // construct a minimal feat document directly (no compendium source,
  // no rules, no GrantItem) to avoid triggering PF2e's cascade machinery
  // for real feats like Pack Stalker — those hang on the create call
  // because their GrantItem resolution does not terminate cleanly in
  // headless context.
  // --------------------------------------------------------------------
  {
    const tempFeat = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const created = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe2_feat__',
          type: 'feat',
          system: { description: { value: '' } },
        },
      ]);
      return { id: created[0].id, name: created[0].name, type: created[0].type };
    }, PROBE_ACTOR_ID);
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: tempFeat.id,
      mode: 'delete',
    });
    log.info({ probe: 2, res }, 'probe 2: delete non-physical feat');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 2: operation=deleted', {
        op: res.data.operation,
      });
      assert(res.data.deletedItem?.type === 'feat', 'probe 2: type=feat', {
        type: res.data.deletedItem?.type,
      });
      assert(
        res.data.deletedItem?.qtyAtDelete === null,
        'probe 2: qtyAtDelete=null for non-physical',
        { qty: res.data.deletedItem?.qtyAtDelete },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: decrement > 0 (canonical Arrows -5, restored by teardown).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.arrowsId,
      mode: 'decrement',
      quantity: 5,
    });
    log.info({ probe: 3, res }, 'probe 3: arrows -5');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 3: operation=decremented', {
        op: res.data.operation,
      });
      assert(res.data.item?.qtyBefore === CANONICAL_ARROWS_QTY, 'probe 3: qtyBefore=20', {
        q: res.data.item?.qtyBefore,
      });
      assert(res.data.item?.qtyAfter === CANONICAL_ARROWS_QTY - 5, 'probe 3: qtyAfter=15', {
        q: res.data.item?.qtyAfter,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: decrement to 0 with default delete.
  //
  // Temp qty-1 potion, decrement by 1 → decrementedAndDeleted.
  // --------------------------------------------------------------------
  {
    const temp = await makeTemp('__probe4_potion__', HEALING_POTION_UUID, { quantity: 1 });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: temp.id,
      mode: 'decrement',
      quantity: 1,
    });
    log.info({ probe: 4, res }, 'probe 4: temp potion qty 1 -1');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'decrementedAndDeleted',
        'probe 4: operation=decrementedAndDeleted',
        { op: res.data.operation },
      );
      assert(res.data.deletedItem?.qtyBefore === 1, 'probe 4: qtyBefore=1', {
        q: res.data.deletedItem?.qtyBefore,
      });
      assert(Array.isArray(res.data.ejectedToTopLevel), 'probe 4: ejectedToTopLevel present', {});
      assert(Array.isArray(res.data.cascadeDeleted), 'probe 4: cascadeDeleted present', {});
    }
    // Verify item is actually gone
    const stillExists = await page.evaluate(
      (actorId, itemId) => !!globalThis.game.actors.get(actorId).items.get(itemId),
      PROBE_ACTOR_ID,
      temp.id,
    );
    assert(stillExists === false, 'probe 4: item actually removed from actor', { stillExists });
  }

  // --------------------------------------------------------------------
  // Probe 5: decrement to 0 with deleteIfZero: false.
  //
  // Item should persist at qty 0. Teardown will pick up the orphan.
  // --------------------------------------------------------------------
  {
    const temp = await makeTemp('__probe5_potion__', HEALING_POTION_UUID, { quantity: 1 });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: temp.id,
      mode: 'decrement',
      quantity: 1,
      deleteIfZero: false,
    });
    log.info({ probe: 5, res }, 'probe 5: temp potion qty 1 -1 deleteIfZero:false');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'decremented',
        'probe 5: operation=decremented (entry persists)',
        { op: res.data.operation },
      );
      assert(res.data.item?.qtyAfter === 0, 'probe 5: qtyAfter=0', { q: res.data.item?.qtyAfter });
    }
    const persistsAtZero = await page.evaluate(
      (actorId, itemId) => {
        const it = globalThis.game.actors.get(actorId).items.get(itemId);
        return it ? { exists: true, qty: it.system?.quantity } : { exists: false };
      },
      PROBE_ACTOR_ID,
      temp.id,
    );
    assert(
      persistsAtZero.exists === true && persistsAtZero.qty === 0,
      'probe 5: item persists with qty 0',
      { persistsAtZero },
    );
  }

  // --------------------------------------------------------------------
  // Probe 6: decrement past 0 (clamp + delete).
  //
  // Temp qty-2 potion, decrement by 5 → clamps to 0 and deletes.
  // --------------------------------------------------------------------
  {
    const temp = await makeTemp('__probe6_potion__', HEALING_POTION_UUID, { quantity: 2 });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: temp.id,
      mode: 'decrement',
      quantity: 5,
    });
    log.info({ probe: 6, res }, 'probe 6: temp potion qty 2 -5 (clamp)');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'decrementedAndDeleted',
        'probe 6: operation=decrementedAndDeleted',
        { op: res.data.operation },
      );
      assert(
        res.data.deletedItem?.qtyBefore === 2,
        'probe 6: qtyBefore=2 (overflow not reflected)',
        { q: res.data.deletedItem?.qtyBefore },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: container delete with contents → ejectedToTopLevel.
  //
  // Build a TEMP backpack and place a TEMP consumable inside it. Then
  // delete the backpack via the tool. The consumable should survive on
  // the actor at top level (containerId === null), and the tool's
  // response should report it under ejectedToTopLevel. Teardown deletes
  // the orphaned consumable.
  // --------------------------------------------------------------------
  let probe7OrphanIds = [];
  {
    const tempBp = await makeTemp('__probe7_backpack__', BACKPACK_UUID, { quantity: 1 });
    const tempConsumable = await page.evaluate(
      async (actorId, sourceUuid, containerId) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(sourceUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name: '__probe7_potion__',
            system: { ...(data.system ?? {}), containerId, quantity: 1 },
          },
        ]);
        return {
          id: created[0].id,
          name: created[0].name,
          type: created[0].type,
          containerId: created[0].system?.containerId ?? null,
        };
      },
      PROBE_ACTOR_ID,
      HEALING_POTION_UUID,
      tempBp.id,
    );

    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: tempBp.id,
      mode: 'delete',
    });
    log.info({ probe: 7, res }, 'probe 7: delete container with contents');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 7: operation=deleted', {
        op: res.data.operation,
      });
      assert(res.data.deletedItem?.id === tempBp.id, 'probe 7: deletedItem is the container', {
        di: res.data.deletedItem,
      });
      assert(
        Array.isArray(res.data.ejectedToTopLevel) && res.data.ejectedToTopLevel.length === 1,
        'probe 7: exactly one ejection',
        { e: res.data.ejectedToTopLevel },
      );
      assert(
        res.data.ejectedToTopLevel[0]?.id === tempConsumable.id,
        'probe 7: ejection is the inner consumable',
        { e: res.data.ejectedToTopLevel },
      );
      assert(
        Array.isArray(res.data.cascadeDeleted) && res.data.cascadeDeleted.length === 0,
        'probe 7: no cascade-deletes',
        { c: res.data.cascadeDeleted },
      );
    }
    // Verify post-state: consumable is at top level, container gone.
    const postState = await page.evaluate(
      (actorId, bpId, consumableId) => {
        const actor = globalThis.game.actors.get(actorId);
        return {
          backpackGone: !actor.items.get(bpId),
          consumableExists: !!actor.items.get(consumableId),
          consumableContainerId: actor.items.get(consumableId)?.system?.containerId ?? null,
        };
      },
      PROBE_ACTOR_ID,
      tempBp.id,
      tempConsumable.id,
    );
    assert(postState.backpackGone === true, 'probe 7: backpack actually gone', { postState });
    assert(postState.consumableExists === true, 'probe 7: consumable survived', { postState });
    assert(
      postState.consumableContainerId === null,
      'probe 7: consumable containerId cleared to null',
      { postState },
    );
    probe7OrphanIds.push(tempConsumable.id);
  }

  // --------------------------------------------------------------------
  // Probe 8: granted-child cascade.
  //
  // Synthetic parent + child where child.flags.pf2e.grantedBy.id =
  // parent.id with onDelete: "cascade". Delete the parent via the tool;
  // verify cascadeDeleted contains the child AND PF2e's auto-cascade
  // actually removed the child from the actor.
  // --------------------------------------------------------------------
  {
    const synth = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const parents = await actor.createEmbeddedDocuments('Item', [
        { name: '__probe8_parent__', type: 'equipment', system: { description: { value: '' } } },
      ]);
      const parent = parents[0];
      const children = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe8_child__',
          type: 'equipment',
          system: { description: { value: '' } },
          flags: { pf2e: { grantedBy: { id: parent.id, onDelete: 'cascade' } } },
        },
      ]);
      return { parentId: parent.id, childId: children[0].id };
    }, PROBE_ACTOR_ID);

    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: synth.parentId,
      mode: 'delete',
    });
    log.info({ probe: 8, res }, 'probe 8: grant-child cascade');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'deleted', 'probe 8: operation=deleted', {
        op: res.data.operation,
      });
      assert(
        Array.isArray(res.data.cascadeDeleted) && res.data.cascadeDeleted.length === 1,
        'probe 8: exactly one cascade entry',
        { c: res.data.cascadeDeleted },
      );
      assert(
        res.data.cascadeDeleted[0]?.id === synth.childId,
        'probe 8: cascade entry is the synthetic child',
        { c: res.data.cascadeDeleted },
      );
      assert(res.data.cascadeDeleted[0]?.reason === 'grantedBy', 'probe 8: reason=grantedBy', {
        c: res.data.cascadeDeleted,
      });
    }
    const post = await page.evaluate(
      (actorId, parentId, childId) => {
        const actor = globalThis.game.actors.get(actorId);
        return {
          parentGone: !actor.items.get(parentId),
          childGone: !actor.items.get(childId),
        };
      },
      PROBE_ACTOR_ID,
      synth.parentId,
      synth.childId,
    );
    assert(post.parentGone === true, 'probe 8: parent actually gone', { post });
    assert(post.childGone === true, "probe 8: PF2e's auto-cascade actually removed the child", {
      post,
    });
  }

  // --------------------------------------------------------------------
  // Probe 9: currency decrement (canonical Copper Pieces 9 → 4).
  //
  // Verify actor.inventory.coins.cp tracks the change. Teardown restores
  // qty to CANONICAL_COPPER_PIECES_QTY.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.cpId,
      mode: 'decrement',
      quantity: 5,
    });
    log.info({ probe: 9, res }, 'probe 9: copper pieces -5');
    assert(res.ok === true, 'probe 9: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 9: operation=decremented', {
        op: res.data.operation,
      });
      assert(res.data.item?.qtyAfter === CANONICAL_COPPER_PIECES_QTY - 5, 'probe 9: qtyAfter=4', {
        q: res.data.item?.qtyAfter,
      });
    }
    const coins = await page.evaluate(
      (actorId) => globalThis.game.actors.get(actorId).inventory?.coins ?? null,
      PROBE_ACTOR_ID,
    );
    assert(
      coins?.cp === CANONICAL_COPPER_PIECES_QTY - 5,
      'probe 9: actor.inventory.coins.cp updates',
      { coins },
    );
  }

  // --------------------------------------------------------------------
  // Probe 10: bogus actorId.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeef', itemId: 'whatever', mode: 'delete' });
    log.info({ probe: 10, res }, 'probe 10: bogus actorId');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 10: INVALID_INPUT', {
      code: res.error?.code,
    });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 10: reason=ACTOR_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 11: bogus itemId.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: 'deadbeefdeadbeef', mode: 'delete' });
    log.info({ probe: 11, res }, 'probe 11: bogus itemId');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 11: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 12: INCOMPATIBLE_INPUT — mode=delete with quantity field.
  //
  // zod strict-mode rejects unknown keys per branch. Surfaces as
  // res.validation (zod issues array).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.arrowsId,
      mode: 'delete',
      quantity: 5,
    });
    log.info({ probe: 12, res }, 'probe 12: delete with quantity');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(Array.isArray(res.validation), 'probe 12: surfaced as zod validation error', {
      v: res.validation,
    });
  }

  // --------------------------------------------------------------------
  // Probe 13: INVALID_QUANTITY — quantity 0 in decrement.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.arrowsId,
      mode: 'decrement',
      quantity: 0,
    });
    log.info({ probe: 13, res }, 'probe 13: decrement quantity=0');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(Array.isArray(res.validation), 'probe 13: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 14: INVALID_QUANTITY — quantity -1.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.arrowsId,
      mode: 'decrement',
      quantity: -1,
    });
    log.info({ probe: 14, res }, 'probe 14: decrement quantity=-1');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(Array.isArray(res.validation), 'probe 14: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 15: DECREMENT_ON_NON_PHYSICAL — decrement a feat.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.featId,
      mode: 'decrement',
      quantity: 1,
    });
    log.info({ probe: 15, res }, 'probe 15: decrement on feat');
    assert(res.isError === true, 'probe 15: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 15: INVALID_INPUT', {
      code: res.error?.code,
    });
    assert(
      res.error?.details?.reason === 'DECREMENT_ON_NON_PHYSICAL',
      'probe 15: reason=DECREMENT_ON_NON_PHYSICAL',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 16: MODE_REQUIRED — missing mode field (zod discriminator).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: discovery.arrowsId,
    });
    log.info({ probe: 16, res }, 'probe 16: missing mode');
    assert(res.isError === true, 'probe 16: error', { res });
    assert(Array.isArray(res.validation), 'probe 16: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Teardown.
  //
  // Strategy:
  //   1. Delete all items currently on the actor that aren't in the
  //      snapshot (orphans: probe 5 qty-0 entry, probe 7 ejected
  //      consumable, any cascade leftover from probe 2/8).
  //   2. For each snapshot id that's missing from the actor, recreate
  //      via createEmbeddedDocuments using the saved payload (Foundry
  //      assigns a new id, which is fine — the post-teardown assertion
  //      is on name+type+qty signature, not on id).
  //   3. For each snapshot id still present, restore its quantity to
  //      the snapshot value.
  //   4. Report the final state for the verification assertion.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapIds = new Set(snapshot.items.map((s) => s.id));
      const snapQty = new Map(snapshot.items.map((s) => [s.id, s.qty]));

      // 1. Delete orphans.
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

      // 2. Recreate missing snapshot items.
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

      // 3. Restore drifted quantities for surviving snapshot ids.
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

      // 4. Build the signature multiset for post-teardown verification.
      // Signature = `${name}|${type}|${qty}|${containerId??''}` so we
      // catch quantity drift AND container-relationship drift.
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
  // Probe 17: post-teardown signature equality.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 17: item count equals snapshot',
    { snap: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(
    teardown.signaturesMatch === true,
    'probe 17: name+type+qty+containerId multiset matches snapshot',
    { missing: teardown.missingSigs, extra: teardown.extraSigs },
  );
  assert(teardown.deleteFailures.length === 0, 'probe 17: no orphan-delete failures', {
    failures: teardown.deleteFailures,
  });
  assert(teardown.recreateFailures.length === 0, 'probe 17: no recreation failures', {
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
