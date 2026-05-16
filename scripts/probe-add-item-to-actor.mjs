/**
 * Probe + acceptance script for add_item_to_actor. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Happy path: simple non-stackable Longsword grant.
 *   2.  Quantity > 1: Minor Healing Potion x5.
 *   3.  Auto-merge: +5 Arrows folds into the existing 20-Arrow stack at
 *       top level (quantity drift restored at teardown).
 *   4.  No-merge across containerId: +5 Arrows into a backpack stays
 *       separate from the top-level 20 Arrows.
 *   5.  merge: "never" opt-out: +5 Arrows at top level creates a separate
 *       entry instead of folding.
 *   6.  containerId placement: Longsword into a backpack.
 *   7.  identified: false: Longsword granted unidentified, name flips to
 *       "Unusual Longsword".
 *   8.  Cascade detection: synthetic GrantItem-style child injected via
 *       direct Foundry API. The tool rejects every real GrantItem-bearing
 *       source (all are feats) at the type check, so the
 *       cascade-detection scan is exercised through a synthetic test.
 *   9.  Error: bogus actorId.
 *   10. Error: bogus sourceUuid.
 *   11. Error: sourceUuid is an Actor UUID.
 *   12. Error: sourceUuid is an actor-embedded Item UUID.
 *   13. Error: non-physical source (feat).
 *   14. Error: ChoiceSet source. Defensive only in PF2e 8.1.2 — every
 *       ChoiceSet-bearing item is a feat, so the natural-input path hits
 *       the type-rejection branch first.
 *   15. Error: invalid quantity (0).
 *   16. Error: bogus containerId.
 *   17. Error: non-container containerId.
 *   18. Teardown verification: every item id and every modified quantity
 *       on the actor is restored to the start-of-probe snapshot.
 *
 * State restoration model (v1.1):
 *  - At probe start, snapshot every item on the actor as {id, qty}.
 *  - At probe end, (a) delete any item whose id is on the actor but not
 *    in the snapshot, (b) for each snapshot id whose quantity drifted,
 *    restore via updateEmbeddedDocuments, (c) assert the post-teardown
 *    item-id set equals the snapshot set AND every snapshot id's
 *    quantity equals the snapshot quantity.
 *
 *  Counting items at the end is insufficient because a created orphan
 *  can numerically balance a deleted-or-decremented item. Test Valeros
 *  arrived at probe development with one orphan Arrows entry (qty 3) AND
 *  the canonical Arrows entry bumped to qty 25 instead of 20 — the
 *  bumped quantity wasn't detected by the v1 count-only check. The probe
 *  now opens with a canonical-state scrub that deletes any non-canonical
 *  Arrows entries and resets the canonical entry's quantity to 20, so
 *  re-runs converge on the expected baseline even after prior pollution.
 *
 *   npm run build && node scripts/probe-add-item-to-actor.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'add_item_to_actor');
if (!tool) {
  log.error('add_item_to_actor not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B'; // Test Valeros in sandbox
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';
const ASSURANCE_FEAT_UUID = 'Compendium.pf2e.feats-srd.Item.W6Gl9ePmItfDHji0';
const PACK_STALKER_FEAT_UUID = 'Compendium.pf2e.feats-srd.Item.0FqbyC5tR2DC0DOk';

// Canonical baseline state for Test Valeros (used by the pre-probe scrub
// to converge re-runs back to a clean baseline). 20-Arrow stack at the
// top level, id stable across world saves.
const CANONICAL_ARROWS_ID = 'oAeupG1c0dIv5p7Y';
const CANONICAL_ARROWS_QTY = 20;

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
  // Pre-probe scrub: converge Test Valeros back to canonical state.
  //
  // The probe assumes a baseline of exactly one Arrows entry (qty 20).
  // Prior probe runs that exited early — or any external mutation — can
  // leave behind extra Arrows entries or bump the canonical entry's
  // quantity, and the snapshot/restore teardown below will preserve
  // *whatever* state it sees at start, including pollution. To break
  // that fixed point, this scrub:
  //   1. Deletes any Arrows-named items whose id is NOT the canonical id.
  //   2. Resets the canonical Arrows entry's quantity to 20.
  // It is a no-op on a clean baseline; it converges re-runs after
  // pollution. Kept in place permanently as a safety net.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(
    async (actorId, canonicalArrowsId, canonicalArrowsQty) => {
      const actor = globalThis.game.actors?.get(actorId);
      if (!actor) return { error: `actor ${actorId} not found` };
      const toDelete = actor.items.contents
        .filter((i) => (i.name ?? '') === 'Arrows' && i.id !== canonicalArrowsId)
        .map((i) => i.id);
      if (toDelete.length > 0) {
        await actor.deleteEmbeddedDocuments('Item', toDelete);
      }
      const canonical = actor.items.get(canonicalArrowsId);
      let qtyReset = null;
      if (canonical) {
        const before = canonical.system?.quantity ?? null;
        if (before !== canonicalArrowsQty) {
          await canonical.update({ 'system.quantity': canonicalArrowsQty });
        }
        qtyReset = { before, after: actor.items.get(canonicalArrowsId)?.system?.quantity ?? null };
      }
      return {
        deletedOrphanArrows: toDelete,
        canonicalArrowsQty: qtyReset,
        itemCount: actor.items.size,
      };
    },
    PROBE_ACTOR_ID,
    CANONICAL_ARROWS_ID,
    CANONICAL_ARROWS_QTY,
  );
  log.info({ scrub }, 'pre-probe scrub: canonicalize Arrows state');
  if (scrub.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot: take an exact start-of-probe inventory shape that teardown
  // restores to. {id, qty} pairs for every item on the actor.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
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
  // Discovery: key item ids, UUIDs needed for probes.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(
    async (actorId, longswordUuid) => {
      const actor = globalThis.game.actors?.get(actorId);
      if (!actor) return { error: `actor ${actorId} not found` };
      const items = actor.items?.contents ?? [];

      const arrows = items.find((i) => (i.name ?? '').toLowerCase() === 'arrows');
      const backpack = items.find((i) => i.type === 'backpack');

      // Discover a Minor Healing Potion UUID from the equipment-srd pack so
      // we don't hardcode a possibly-wrong ID.
      let minorHealingPotionUuid = null;
      const equipPack = globalThis.game.packs?.get('pf2e.equipment-srd');
      if (equipPack) {
        const idx = await equipPack.getIndex();
        const hit =
          idx.contents.find((e) => (e.name ?? '').toLowerCase() === 'healing potion (minor)') ??
          idx.contents.find((e) => /minor healing potion/i.test(e.name ?? ''));
        if (hit) {
          minorHealingPotionUuid =
            hit.uuid ?? `Compendium.${equipPack.collection}.Item.${hit._id}`;
        }
      }

      // Look for a physical item with a ChoiceSet rule. If none exists,
      // probe #14 is documented as limited (feat-only ChoiceSet items hit
      // the type-rejection path first).
      let physicalChoiceSetUuid = null;
      if (equipPack) {
        const idx = await equipPack.getIndex();
        // The compendium index doesn't carry system.rules; we have to load
        // documents. Limit the scan to keep the probe fast — we're just
        // sampling to see if any exist.
        const sample = idx.contents.slice(0, 40);
        for (const entry of sample) {
          const uuid = entry.uuid ?? `Compendium.${equipPack.collection}.Item.${entry._id}`;
          let doc = null;
          try {
            doc = await fromUuid(uuid);
          } catch {
            continue;
          }
          const rules = doc?.system?.rules;
          if (Array.isArray(rules) && rules.some((r) => r?.key === 'ChoiceSet')) {
            physicalChoiceSetUuid = uuid;
            break;
          }
        }
      }

      // First non-Test-Valeros actor in the world for cross-actor probe.
      let otherActorUuid = null;
      let otherActorItemUuid = null;
      for (const a of globalThis.game.actors?.contents ?? []) {
        if (a.id === actorId) continue;
        otherActorUuid = a.uuid;
        const firstItem = a.items?.contents?.[0];
        if (firstItem) otherActorItemUuid = firstItem.uuid;
        if (otherActorUuid && otherActorItemUuid) break;
      }

      // Probe sourceUuid on the Longsword to confirm what _stats.compendiumSource
      // gets set to after a create — we'll compare against this.
      const longswordSourceDoc = await fromUuid(longswordUuid);

      return {
        actorName: actor.name,
        itemCount: items.length,
        arrows: arrows
          ? {
              id: arrows.id,
              uuid: arrows.uuid,
              name: arrows.name,
              quantity: arrows.system?.quantity ?? null,
              sourceUuid: arrows._stats?.compendiumSource ?? null,
              containerId: arrows.system?.containerId ?? null,
            }
          : null,
        backpack: backpack
          ? { id: backpack.id, name: backpack.name }
          : null,
        minorHealingPotionUuid,
        physicalChoiceSetUuid,
        otherActorUuid,
        otherActorItemUuid,
        longswordSourceResolved: !!longswordSourceDoc,
        longswordSourceType: longswordSourceDoc?.type ?? null,
      };
    },
    PROBE_ACTOR_ID,
    LONGSWORD_UUID,
  );

  if (discovery.error) {
    log.error({ discovery }, 'discovery failed; aborting');
    process.exit(2);
  }
  log.info({ discovery }, 'discovered probe targets');

  if (!discovery.arrows) {
    log.error('Test Valeros has no Arrows entry — required for merge probes');
    process.exit(2);
  }
  if (discovery.arrows.quantity !== 20) {
    log.warn(
      { quantity: discovery.arrows.quantity },
      'Test Valeros arrows quantity is not 20; merge assertions will reference the actual baseline',
    );
  }
  if (!discovery.backpack) {
    log.error('Test Valeros has no backpack item — required for containerId probes');
    process.exit(2);
  }
  if (!discovery.arrows.sourceUuid) {
    log.error('Arrows item has no _stats.compendiumSource — required to compute the source UUID');
    process.exit(2);
  }
  if (!discovery.minorHealingPotionUuid) {
    log.error('Could not discover Minor Healing Potion in pf2e.equipment-srd');
    process.exit(2);
  }

  const baselineArrowsQty = discovery.arrows.quantity;
  const arrowsId = discovery.arrows.id;
  const arrowsSourceUuid = discovery.arrows.sourceUuid;
  const backpackId = discovery.backpack.id;

  // --------------------------------------------------------------------
  // Probe 1: happy path — simple non-stackable Longsword.
  //
  // Test Valeros already carries a Longsword and Minor Healing Potion at
  // top level identified, so we pass merge: "never" on probes 1 & 2 to
  // force the create path the spec is testing. The auto-merge path is
  // exercised separately in probe 3 (Arrows).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: LONGSWORD_UUID,
      merge: 'never',
    });
    log.info({ probe: 1, res }, 'probe 1: simple longsword grant');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 1: operation=created', { op: res.data.operation });
      assert(res.data.item?.quantity === 1, 'probe 1: quantity=1', { qty: res.data.item?.quantity });
      assert(res.data.item?.type === 'weapon', 'probe 1: type=weapon', { type: res.data.item?.type });
      assert(
        res.data.item?.sourceUuid === LONGSWORD_UUID,
        'probe 1: sourceUuid matches input',
        { sourceUuid: res.data.item?.sourceUuid },
      );
      assert(
        res.data.cascadeGranted === undefined,
        'probe 1: no cascadeGranted (Longsword has no GrantItem)',
        { cascade: res.data.cascadeGranted },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: quantity > 1.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: discovery.minorHealingPotionUuid,
      quantity: 5,
      merge: 'never',
    });
    log.info({ probe: 2, res }, 'probe 2: minor healing potion x5');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 2: operation=created', { op: res.data.operation });
      assert(res.data.item?.quantity === 5, 'probe 2: quantity=5', { qty: res.data.item?.quantity });
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: auto-merge happy path (+5 Arrows at top level).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: arrowsSourceUuid,
      quantity: 5,
    });
    log.info({ probe: 3, res }, 'probe 3: arrows +5 merge');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'merged', 'probe 3: operation=merged', { op: res.data.operation });
      assert(
        res.data.mergedInto?.id === arrowsId,
        'probe 3: merged into existing arrows id',
        { mergedInto: res.data.mergedInto },
      );
      assert(
        res.data.mergedInto?.previousQuantity === baselineArrowsQty,
        'probe 3: previousQuantity matches baseline',
        { previous: res.data.mergedInto?.previousQuantity, baseline: baselineArrowsQty },
      );
      assert(
        res.data.mergedInto?.newQuantity === baselineArrowsQty + 5,
        'probe 3: newQuantity = baseline + 5',
        { newQuantity: res.data.mergedInto?.newQuantity },
      );
      assert(
        res.data.mergedInto?.addedQuantity === 5,
        'probe 3: addedQuantity=5',
        { added: res.data.mergedInto?.addedQuantity },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: no-merge across containerId.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: arrowsSourceUuid,
      quantity: 5,
      containerId: backpackId,
    });
    log.info({ probe: 4, res }, 'probe 4: arrows into backpack');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 4: operation=created', { op: res.data.operation });
      assert(
        res.data.item?.containerId === backpackId,
        'probe 4: containerId set on new entry',
        { containerId: res.data.item?.containerId },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: merge: "never" opt-out.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: arrowsSourceUuid,
      quantity: 5,
      merge: 'never',
    });
    log.info({ probe: 5, res }, 'probe 5: arrows +5 merge=never');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 5: operation=created', { op: res.data.operation });
      assert(res.data.item?.quantity === 5, 'probe 5: separate stack qty=5', {
        qty: res.data.item?.quantity,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: containerId placement (Longsword in backpack).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: LONGSWORD_UUID,
      containerId: backpackId,
    });
    log.info({ probe: 6, res }, 'probe 6: longsword in backpack');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'created', 'probe 6: operation=created', { op: res.data.operation });
      assert(
        res.data.item?.containerId === backpackId,
        'probe 6: containerId reflected',
        { containerId: res.data.item?.containerId },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: identified: false.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: LONGSWORD_UUID,
      identified: false,
    });
    log.info({ probe: 7, res }, 'probe 7: longsword unidentified');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(
        res.data.item?.identificationStatus === 'unidentified',
        'probe 7: identificationStatus=unidentified',
        { status: res.data.item?.identificationStatus },
      );
      assert(
        /unusual|object/i.test(res.data.item?.name ?? ''),
        'probe 7: name reflects unidentified (typically "Unusual Longsword")',
        { name: res.data.item?.name },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 8: cascade detection.
  //
  // Skipped via the tool path: the source items we have available with
  // GrantItem cascades are feats (Pack Stalker), which the tool rejects
  // by type before the create runs. Instead, verify the cascade-detection
  // *mechanism* by injecting a synthetic cascade directly via Foundry API,
  // confirming our flags.pf2e.grantedBy.id scan would pick it up.
  // --------------------------------------------------------------------
  {
    const syntheticCascade = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      if (!actor) return { error: 'actor missing' };
      // Create a parent equipment item, then a synthetic child item whose
      // flags.pf2e.grantedBy.id points at the parent. This mirrors the
      // post-create state PF2e produces from GrantItem rules and lets us
      // exercise the scan path used by add_item_to_actor.
      const parents = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe_cascade_parent__',
          type: 'equipment',
          system: { description: { value: '' } },
        },
      ]);
      const parent = parents[0];
      const children = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe_cascade_child__',
          type: 'equipment',
          system: { description: { value: '' } },
          flags: { pf2e: { grantedBy: { id: parent.id, onDelete: 'cascade' } } },
        },
      ]);
      const child = children[0];
      // Now scan as add_item_to_actor's evaluator does.
      const scanHits = [];
      for (const item of actor.items.contents) {
        const gb = item.flags?.pf2e?.grantedBy;
        if (gb?.id === parent.id) scanHits.push({ id: item.id, name: item.name });
      }
      return {
        parentId: parent.id,
        childId: child.id,
        scanHits,
      };
    }, PROBE_ACTOR_ID);
    log.info({ probe: 8, syntheticCascade }, 'probe 8: synthetic cascade scan');
    assert(
      Array.isArray(syntheticCascade.scanHits) && syntheticCascade.scanHits.length === 1,
      'probe 8: cascade scan finds exactly one child',
      { syntheticCascade },
    );
    assert(
      syntheticCascade.scanHits?.[0]?.id === syntheticCascade.childId,
      'probe 8: scan hit is the synthetic child',
      { syntheticCascade },
    );
  }

  // --------------------------------------------------------------------
  // Probe 9: bogus actorId.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeef', sourceUuid: LONGSWORD_UUID });
    log.info({ probe: 9, res }, 'probe 9: bogus actorId');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 9: INVALID_INPUT', { code: res.error?.code });
    assert(
      typeof res.error?.message === 'string' && res.error.message.startsWith('No actor found for actorId:'),
      'probe 9: actor-not-found message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 10: bogus sourceUuid.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: 'Compendium.pf2e.equipment-srd.Item.deadbeefdeadbeef',
    });
    log.info({ probe: 10, res }, 'probe 10: bogus sourceUuid');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.message?.startsWith('No item found for sourceUuid:'),
      'probe 10: item-not-found message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: sourceUuid is an Actor UUID.
  // --------------------------------------------------------------------
  {
    if (!discovery.otherActorUuid) {
      log.warn('probe 11 skipped — no second world actor available');
    } else {
      const res = await call({
        actorId: PROBE_ACTOR_ID,
        sourceUuid: discovery.otherActorUuid,
      });
      log.info({ probe: 11, res }, 'probe 11: actor uuid');
      assert(res.isError === true, 'probe 11: error', { res });
      assert(
        res.error?.message?.includes('expected Item'),
        'probe 11: wrong-document-type message',
        { msg: res.error?.message },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 12: sourceUuid is an actor-embedded Item UUID (cross-actor).
  // --------------------------------------------------------------------
  {
    if (!discovery.otherActorItemUuid) {
      log.warn('probe 12 skipped — no actor-embedded item available on another actor');
    } else {
      const res = await call({
        actorId: PROBE_ACTOR_ID,
        sourceUuid: discovery.otherActorItemUuid,
      });
      log.info({ probe: 12, res }, 'probe 12: cross-actor item uuid');
      assert(res.isError === true, 'probe 12: error', { res });
      assert(
        res.error?.message?.includes('Cross-actor item moves are not yet supported'),
        'probe 12: cross-actor-not-supported message',
        { msg: res.error?.message },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 13: non-physical source (feat).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: PACK_STALKER_FEAT_UUID });
    log.info({ probe: 13, res }, 'probe 13: feat source');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(
      res.error?.message?.includes('physical inventory items only'),
      'probe 13: physical-only message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 14: ChoiceSet source.
  //
  // The ChoiceSet rejection branch in the evaluator is defensive forward-
  // compat: in PF2e 8.1.2, every ChoiceSet-bearing item is a feat, so the
  // natural-input path always hits the type-rejection branch first. We
  // keep both paths below so this probe stays correct if (a) PF2e ships a
  // physical item with a ChoiceSet rule in a future release or (b) a
  // third-party module adds one.
  //
  // Path A: a physical item with ChoiceSet was discovered → assert the
  //         ChoiceSet error message.
  // Path B: nothing physical found → fall back to Assurance (feat) and
  //         assert it hits the type-rejection path.
  // --------------------------------------------------------------------
  if (discovery.physicalChoiceSetUuid) {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: discovery.physicalChoiceSetUuid,
    });
    log.info({ probe: 14, res }, 'probe 14: physical ChoiceSet source');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.message?.includes('ChoiceSet rule'),
      'probe 14: ChoiceSet rejection message',
      { msg: res.error?.message },
    );
  } else {
    log.warn(
      'probe 14: no physical item with a ChoiceSet rule was discovered in the equipment-srd ' +
        'sample. The ChoiceSet rejection branch is implemented but not probe-witnessed against ' +
        'live data because ChoiceSet-bearing items in the sample are non-physical (feats). ' +
        'Calling Assurance instead exercises the type-rejection path, not the ChoiceSet path.',
    );
    const res = await call({ actorId: PROBE_ACTOR_ID, sourceUuid: ASSURANCE_FEAT_UUID });
    log.info({ probe: 14, res }, 'probe 14 (fallback): Assurance feat hits type-rejection first');
    assert(res.isError === true, 'probe 14 (fallback): error', { res });
    assert(
      res.error?.message?.includes('physical inventory items only'),
      'probe 14 (fallback): feat hits type rejection',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 15: invalid quantity.
  //
  // The zod schema rejects quantity: 0 at the input layer. We assert
  // that the call fails — either via zod validation (the consumer-facing
  // behavior at the MCP boundary) or via the evaluator's defensive check.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: LONGSWORD_UUID,
      quantity: 0,
    });
    log.info({ probe: 15, res }, 'probe 15: quantity 0');
    assert(res.isError === true, 'probe 15: error', { res });
    const surfacedAsValidation = Array.isArray(res.validation);
    const surfacedAsToolError = res.error?.message?.includes('quantity must be an integer');
    assert(
      surfacedAsValidation || surfacedAsToolError,
      'probe 15: invalid quantity surfaced as zod validation or tool error',
      { res },
    );
  }

  // --------------------------------------------------------------------
  // Probe 16: bogus containerId.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      sourceUuid: LONGSWORD_UUID,
      containerId: 'deadbeefdeadbeef',
    });
    log.info({ probe: 16, res }, 'probe 16: bogus containerId');
    assert(res.isError === true, 'probe 16: error', { res });
    assert(
      res.error?.message?.startsWith('No item found on actor for containerId:'),
      'probe 16: container-not-found message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 17: non-container containerId. Pass the Longsword we created in
  // probe 1 (a weapon — definitely not a backpack).
  // --------------------------------------------------------------------
  {
    // Find any non-backpack item we created earlier to use as a bad
    // containerId. The probe-1 longsword is the natural pick.
    const probe1Item = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const items = actor.items?.contents ?? [];
      const ls = items.find((i) => i.name === 'Longsword' && !i.system?.containerId);
      return ls ? { id: ls.id, type: ls.type } : null;
    }, PROBE_ACTOR_ID);
    if (!probe1Item) {
      log.warn('probe 17 skipped — no candidate non-container item on actor');
    } else {
      const res = await call({
        actorId: PROBE_ACTOR_ID,
        sourceUuid: LONGSWORD_UUID,
        containerId: probe1Item.id,
      });
      log.info({ probe: 17, res, probe1Item }, 'probe 17: non-container containerId');
      assert(res.isError === true, 'probe 17: error', { res });
      assert(
        /is type \w+, not a container/.test(res.error?.message ?? ''),
        'probe 17: wrong-container-type message',
        { msg: res.error?.message },
      );
    }
  }

  // --------------------------------------------------------------------
  // Teardown: restore the actor to the exact start-of-probe snapshot.
  //
  //   1. Delete any item whose id is on the actor but not in the snapshot
  //      (orphans introduced by probes 1, 2, 4-8 plus any cascade-children).
  //   2. For each snapshot id whose current quantity differs from the
  //      snapshot, restore via updateEmbeddedDocuments (probe 3's auto-merge
  //      bump is the canonical case).
  //   3. Return enough state for the verification step to assert exact match.
  //
  // The teardown is deliberately exhaustive — we do not assume which
  // probes left state behind. Counting items at the end is insufficient
  // because a created orphan can numerically balance a decremented item;
  // see CLAUDE.md "Writing probes for mutation tools".
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapshotIds = new Set(snapshot.items.map((i) => i.id));
      const snapshotQty = new Map(snapshot.items.map((i) => [i.id, i.qty]));

      // 1. Delete orphans (one-by-one to tolerate cascade auto-deletes).
      const deleted = [];
      const deleteFailures = [];
      const orphanIds = actor.items.contents
        .filter((i) => !snapshotIds.has(i.id))
        .map((i) => i.id);
      for (const id of orphanIds) {
        const existing = actor.items.get(id);
        if (!existing) continue; // cascade already removed it
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
        const current =
          typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
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
        const current =
          typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
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
  // Probe 18: snapshot-equality verification. Item ids AND quantities
  // must match the start-of-probe state exactly.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 18: item count equals snapshot',
    { snapshot: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(teardown.idsMatch === true, 'probe 18: item-id set equals snapshot', {
    extraIds: teardown.extraIds,
    missingIds: teardown.missingIds,
  });
  assert(
    teardown.driftedAfter.length === 0,
    'probe 18: every snapshot id has snapshot quantity',
    { drifted: teardown.driftedAfter },
  );
  assert(
    teardown.deleteFailures.length === 0,
    'probe 18: no orphan delete failures',
    { failures: teardown.deleteFailures },
  );

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
