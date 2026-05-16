/**
 * Probe + acceptance script for move_item_to_container. Drives the
 * live headless Foundry against the gm-puppeteer-sandbox world and
 * exercises:
 *
 *   1.  Happy: move from root → container (canonical Backpack).
 *   2.  Happy: move from container → root.
 *   3.  Happy: move from container A → container B (two scratch backpacks).
 *   4.  Happy: same-destination no-op success (containerIdBefore ===
 *       containerIdAfter, no error).
 *   5.  Happy: merge into matching sibling, merge: true (default) →
 *       operation: "merged", source deleted.
 *   6.  Happy: merge candidate exists but merge: false → operation:
 *       "moved", both items coexist in destination.
 *   7.  Happy: move a container with contents → contents stay inside
 *       it (their containerId reference unaffected).
 *   8.  Happy: identification mismatch defeats merge → operation:
 *       "moved" even with merge: true.
 *
 *   Rejections:
 *   9.  ACTOR_NOT_FOUND (made-up actorId).
 *   10. ITEM_NOT_FOUND (made-up itemId).
 *   11. CONTAINER_NOT_FOUND (made-up containerId).
 *   12. TARGET_NOT_CONTAINER (containerId references a weapon).
 *   13. MOVE_ON_NON_PHYSICAL (itemId references a synthetic feat —
 *       message points to foundry_eval).
 *   14. CYCLE_DETECTED (item moved into itself).
 *   15. CYCLE_DETECTED (parent container moved into its own child).
 *
 *   16. Teardown verification: post-teardown signature multiset
 *       (name|type|qty|containerId) equals start-of-probe snapshot.
 *
 * State restoration model: full toObject() snapshot at start. Teardown
 * deletes orphans (after neutralizing their containerId so cycles
 * don't trip cleanup), recreates missing snapshot ids (Foundry assigns
 * fresh ids — the post-teardown assertion is on the multiset
 * signature, not id-equality), and restores drifted quantities AND
 * containerIds.
 *
 * Signature includes containerId — this tool mutates that relational
 * field, and a pure {id, qty} snapshot would miss state drift on this
 * tool specifically.
 *
 *   npm run build && node scripts/probe-move-item-to-container.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'move_item_to_container');
if (!tool) {
  log.error('move_item_to_container not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const ARROWS_UUID = 'Compendium.pf2e.equipment-srd.Item.w2ENw2VMPcsbif8g';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';
const BACKPACK_UUID = 'Compendium.pf2e.equipment-srd.Item.3lgwjrFEsQVKzhh7';

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
  // Pre-probe scrub: clear __probe_m_* leftovers from any earlier run,
  // and neutralize their containerId before delete (so cycles from a
  // crashed run don't trip cleanup).
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    const orphans = actor.items.contents
      .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe_m'))
      .map((i) => i.id);
    if (orphans.length > 0) {
      await actor
        .updateEmbeddedDocuments(
          'Item',
          orphans.map((id) => ({ _id: id, 'system.containerId': null })),
        )
        .catch(() => undefined);
      await actor.deleteEmbeddedDocuments('Item', orphans);
    }
    return { deleted: orphans.length, itemCount: actor.items.size };
  }, PROBE_ACTOR_ID);
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub?.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot full toObject() per item.
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
        .map((i) => ({ id: i.id, name: i.name, type: i.type, qty: i.qty, containerId: i.containerId })),
    },
    'snapshot captured',
  );

  // --------------------------------------------------------------------
  // Discovery: canonical Backpack id, an Arrows entry to use for moves.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    const items = actor.items?.contents ?? [];
    const backpack = items.find((i) => i.type === 'backpack');
    const arrows = items.find((i) => i.name === 'Arrows');
    return {
      canonicalBackpackId: backpack?.id ?? null,
      arrowsId: arrows?.id ?? null,
      arrowsContainerId: arrows?.system?.containerId ?? null,
      arrowsQty: arrows?.system?.quantity ?? null,
    };
  }, PROBE_ACTOR_ID);
  log.info({ discovery }, 'discovery');
  if (!discovery.canonicalBackpackId || !discovery.arrowsId) {
    log.error({ discovery }, 'discovery missing required ids');
    process.exit(2);
  }
  const canonicalBackpackId = discovery.canonicalBackpackId;

  // Helper: create a scratch item from a compendium UUID with overrides.
  async function makeScratch(name, sourceUuid, overrides = {}) {
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
        };
      },
      PROBE_ACTOR_ID,
      name,
      sourceUuid,
      overrides,
    );
  }

  // --------------------------------------------------------------------
  // Probe 1: move from root → container.
  //
  // Uses a non-stackable Longsword to avoid leaving a stackable residue
  // in canonical Backpack that could be picked up as a merge candidate
  // by later probes (Test Valeros has a canonical Longsword at root,
  // but it's at a different containerId — no conflict).
  // --------------------------------------------------------------------
  {
    const sword = await makeScratch('__probe_m1_sword', LONGSWORD_UUID, {
      system: { containerId: null },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: sword.id,
      containerId: canonicalBackpackId,
    });
    log.info({ probe: 1, res }, 'probe 1: root → canonical Backpack');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 1: operation=moved', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.containerIdBefore === null,
        'probe 1: containerIdBefore=null',
        { c: res.data.item?.containerIdBefore },
      );
      assert(
        res.data.item?.containerIdAfter === canonicalBackpackId,
        'probe 1: containerIdAfter=canonicalBackpackId',
        { c: res.data.item?.containerIdAfter },
      );
      assert(res.data.item?.quantity === 1, 'probe 1: quantity preserved', {
        q: res.data.item?.quantity,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: move from container → root.
  //
  // Use a brand-new scratch backpack (created in canonical Backpack,
  // then moved to root) — backpacks won't trigger an unintended merge
  // because containers aren't stackable, and the canonical actor has no
  // sibling backpack with this exact id. We deliberately avoid reusing
  // probe-1's arrows here: moving those back to root would merge with
  // the canonical 20-arrow stack at root (same compendiumSource, same
  // identification, same destination null), which is correct merge
  // behavior but not the plain-move case this probe asserts.
  // --------------------------------------------------------------------
  {
    const innerBp = await makeScratch('__probe_m2_innerBp', BACKPACK_UUID, {
      system: { containerId: canonicalBackpackId },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: innerBp.id,
      containerId: null,
    });
    log.info({ probe: 2, res }, 'probe 2: container → root');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 2: operation=moved', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.containerIdBefore === canonicalBackpackId,
        'probe 2: containerIdBefore=canonicalBackpackId',
        { c: res.data.item?.containerIdBefore },
      );
      assert(
        res.data.item?.containerIdAfter === null,
        'probe 2: containerIdAfter=null',
        { c: res.data.item?.containerIdAfter },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: container A → container B.
  // --------------------------------------------------------------------
  {
    const bpA = await makeScratch('__probe_m3_bpA', BACKPACK_UUID);
    const bpB = await makeScratch('__probe_m3_bpB', BACKPACK_UUID);
    const item = await makeScratch('__probe_m3_potion', HEALING_POTION_UUID, {
      system: { quantity: 2, containerId: bpA.id },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: item.id,
      containerId: bpB.id,
    });
    log.info({ probe: 3, res }, 'probe 3: bpA → bpB');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 3: operation=moved', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.containerIdBefore === bpA.id,
        'probe 3: containerIdBefore=bpA.id',
        { c: res.data.item?.containerIdBefore },
      );
      assert(
        res.data.item?.containerIdAfter === bpB.id,
        'probe 3: containerIdAfter=bpB.id',
        { c: res.data.item?.containerIdAfter },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: same-destination no-op success.
  // --------------------------------------------------------------------
  {
    const bp = await makeScratch('__probe_m4_bp', BACKPACK_UUID);
    const item = await makeScratch('__probe_m4_potion', HEALING_POTION_UUID, {
      system: { quantity: 1, containerId: bp.id },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: item.id,
      containerId: bp.id,
    });
    log.info({ probe: 4, res }, 'probe 4: same-destination no-op');
    assert(res.ok === true, 'probe 4: ok (no-op is success)', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 4: operation=moved', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.containerIdBefore === bp.id,
        'probe 4: containerIdBefore=bp.id',
        { c: res.data.item?.containerIdBefore },
      );
      assert(
        res.data.item?.containerIdAfter === bp.id,
        'probe 4: containerIdAfter=bp.id',
        { c: res.data.item?.containerIdAfter },
      );
      assert(
        res.data.item?.containerIdBefore === res.data.item?.containerIdAfter,
        'probe 4: before === after signals no-op',
        { res: res.data.item },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: merge into matching sibling (default merge: true).
  //
  // Two arrows stacks: one in canonical Backpack (qty 13), one in a
  // scratch backpack (qty 4). Move the scratch into the canonical
  // backpack — should merge into the existing 13-stack, source deleted,
  // newQuantity = 13 + 4 = 17.
  // --------------------------------------------------------------------
  let probe5MergedTargetId = null;
  {
    const stay = await makeScratch('__probe_m5_arrows_stay', ARROWS_UUID, {
      system: { quantity: 13, containerId: canonicalBackpackId },
    });
    probe5MergedTargetId = stay.id;
    const movee = await makeScratch('__probe_m5_arrows_movee', ARROWS_UUID, {
      system: { quantity: 4, containerId: null },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: movee.id,
      containerId: canonicalBackpackId,
    });
    log.info({ probe: 5, res }, 'probe 5: merge into canonical-backpack arrows');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'merged', 'probe 5: operation=merged', {
        op: res.data.operation,
      });
      assert(
        res.data.mergedInto?.id === stay.id,
        'probe 5: mergedInto.id == stay.id',
        { mergedInto: res.data.mergedInto },
      );
      assert(
        res.data.mergedInto?.qtyBefore === 13,
        'probe 5: qtyBefore=13',
        { q: res.data.mergedInto?.qtyBefore },
      );
      assert(
        res.data.mergedInto?.qtyAfter === 17,
        'probe 5: qtyAfter=17',
        { q: res.data.mergedInto?.qtyAfter },
      );
    }
    // Confirm source no longer exists.
    const srcLive = await page.evaluate(
      (actorId, id) => {
        const a = globalThis.game.actors.get(actorId);
        return Boolean(a.items.get(id));
      },
      PROBE_ACTOR_ID,
      movee.id,
    );
    assert(srcLive === false, 'probe 5: source item deleted post-merge', { srcLive });
  }

  // --------------------------------------------------------------------
  // Probe 6: merge candidate exists but merge: false → plain move.
  //
  // After probe 5, canonical Backpack now has the merged 17 arrows
  // (id=probe5MergedTargetId). Add another scratch arrows stack
  // (qty 5) and try to move it in with merge: false. Expect operation
  // = "moved", both stacks coexist.
  // --------------------------------------------------------------------
  {
    const movee = await makeScratch('__probe_m6_arrows_nomerge', ARROWS_UUID, {
      system: { quantity: 5, containerId: null },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: movee.id,
      containerId: canonicalBackpackId,
      merge: false,
    });
    log.info({ probe: 6, res }, 'probe 6: merge:false → plain move');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 6: operation=moved', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.containerIdAfter === canonicalBackpackId,
        'probe 6: containerIdAfter=canonicalBackpackId',
        { c: res.data.item?.containerIdAfter },
      );
    }
    // Both items should still exist.
    const both = await page.evaluate(
      (actorId, mergedId, moveeId) => {
        const a = globalThis.game.actors.get(actorId);
        return {
          mergedSurvived: Boolean(a.items.get(mergedId)),
          moveeSurvived: Boolean(a.items.get(moveeId)),
          mergedQty: a.items.get(mergedId)?.system?.quantity ?? null,
          moveeQty: a.items.get(moveeId)?.system?.quantity ?? null,
        };
      },
      PROBE_ACTOR_ID,
      probe5MergedTargetId,
      movee.id,
    );
    assert(
      both.mergedSurvived && both.moveeSurvived,
      'probe 6: both stacks coexist after merge:false move',
      both,
    );
    assert(both.mergedQty === 17, 'probe 6: pre-existing stack quantity unchanged', both);
    assert(both.moveeQty === 5, 'probe 6: moved stack quantity unchanged', both);
  }

  // --------------------------------------------------------------------
  // Probe 7: move a container with contents → contents stay inside.
  //
  // Set up: scratch backpack with two items inside it. Move the
  // backpack into canonical Backpack. Inner items' containerId
  // references should remain pointing at the scratch backpack.
  // --------------------------------------------------------------------
  {
    const innerBp = await makeScratch('__probe_m7_innerBp', BACKPACK_UUID, {
      system: { containerId: null },
    });
    const innerA = await makeScratch('__probe_m7_innerA', HEALING_POTION_UUID, {
      system: { quantity: 1, containerId: innerBp.id },
    });
    const innerB = await makeScratch('__probe_m7_innerB', HEALING_POTION_UUID, {
      system: { quantity: 1, containerId: innerBp.id },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: innerBp.id,
      containerId: canonicalBackpackId,
    });
    log.info({ probe: 7, res }, 'probe 7: move container with contents');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'moved', 'probe 7: operation=moved', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.containerIdAfter === canonicalBackpackId,
        'probe 7: container moved',
        { c: res.data.item?.containerIdAfter },
      );
    }
    const inner = await page.evaluate(
      (actorId, innerBpId, aId, bId) => {
        const actor = globalThis.game.actors.get(actorId);
        return {
          aContainerId: actor.items.get(aId)?.system?.containerId ?? null,
          bContainerId: actor.items.get(bId)?.system?.containerId ?? null,
          innerBpContainerId: actor.items.get(innerBpId)?.system?.containerId ?? null,
        };
      },
      PROBE_ACTOR_ID,
      innerBp.id,
      innerA.id,
      innerB.id,
    );
    assert(
      inner.aContainerId === innerBp.id && inner.bContainerId === innerBp.id,
      'probe 7: inner items still reference scratch backpack',
      inner,
    );
    assert(
      inner.innerBpContainerId === canonicalBackpackId,
      'probe 7: scratch backpack now inside canonical',
      inner,
    );
  }

  // --------------------------------------------------------------------
  // Probe 8: identification mismatch defeats merge.
  //
  // Two arrows stacks in the same destination, same compendium source,
  // but ONE is unidentified. With merge: true (default), Foundry should
  // do a plain move, NOT merge — identification status is part of the
  // merge identity.
  // --------------------------------------------------------------------
  {
    const bp = await makeScratch('__probe_m8_bp', BACKPACK_UUID);
    const identifiedSibling = await makeScratch(
      '__probe_m8_arrows_ident',
      ARROWS_UUID,
      {
        system: { quantity: 8, containerId: bp.id, identification: { status: 'identified' } },
      },
    );
    const unidentifiedMovee = await makeScratch(
      '__probe_m8_arrows_unident',
      ARROWS_UUID,
      {
        system: { quantity: 3, containerId: null, identification: { status: 'unidentified' } },
      },
    );
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: unidentifiedMovee.id,
      containerId: bp.id,
    });
    log.info({ probe: 8, res }, 'probe 8: identification mismatch → plain move');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'moved',
        'probe 8: operation=moved (identification mismatch defeats merge)',
        { op: res.data.operation },
      );
    }
    const both = await page.evaluate(
      (actorId, identId, unidentId) => {
        const a = globalThis.game.actors.get(actorId);
        return {
          identSurvived: Boolean(a.items.get(identId)),
          unidentSurvived: Boolean(a.items.get(unidentId)),
        };
      },
      PROBE_ACTOR_ID,
      identifiedSibling.id,
      unidentifiedMovee.id,
    );
    assert(
      both.identSurvived && both.unidentSurvived,
      'probe 8: both stacks survive (no merge)',
      both,
    );
  }

  // --------------------------------------------------------------------
  // Probe 9: ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: 'deadbeefdeadbeef',
      itemId: 'whatever',
      containerId: null,
    });
    log.info({ probe: 9, res }, 'probe 9: bogus actorId');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 9: reason=ACTOR_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 10: ITEM_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: 'deadbeefdeadbeef',
      containerId: null,
    });
    log.info({ probe: 10, res }, 'probe 10: bogus itemId');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(res.error?.details?.reason === 'ITEM_NOT_FOUND', 'probe 10: reason=ITEM_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 11: CONTAINER_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const item = await makeScratch('__probe_m11_potion', HEALING_POTION_UUID);
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: item.id,
      containerId: 'deadbeefdeadbeef',
    });
    log.info({ probe: 11, res }, 'probe 11: bogus containerId');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      res.error?.details?.reason === 'CONTAINER_NOT_FOUND',
      'probe 11: reason=CONTAINER_NOT_FOUND',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 12: TARGET_NOT_CONTAINER (containerId points at a weapon).
  // --------------------------------------------------------------------
  {
    const sword = await makeScratch('__probe_m12_sword', LONGSWORD_UUID);
    const item = await makeScratch('__probe_m12_potion', HEALING_POTION_UUID);
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: item.id,
      containerId: sword.id,
    });
    log.info({ probe: 12, res }, 'probe 12: target=weapon');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(
      res.error?.details?.reason === 'TARGET_NOT_CONTAINER',
      'probe 12: reason=TARGET_NOT_CONTAINER',
      { d: res.error?.details },
    );
    assert(
      typeof res.error?.message === 'string' && /weapon/.test(res.error.message),
      'probe 12: message names the wrong type',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 13: MOVE_ON_NON_PHYSICAL (synthetic feat).
  // --------------------------------------------------------------------
  {
    const feat = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors.get(actorId);
      const created = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe_m13_feat',
          type: 'feat',
          system: { description: { value: '' } },
        },
      ]);
      return { id: created[0].id };
    }, PROBE_ACTOR_ID);
    const bp = await makeScratch('__probe_m13_bp', BACKPACK_UUID);
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: feat.id,
      containerId: bp.id,
    });
    log.info({ probe: 13, res }, 'probe 13: move feat');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(
      res.error?.details?.reason === 'MOVE_ON_NON_PHYSICAL',
      'probe 13: reason=MOVE_ON_NON_PHYSICAL',
      { d: res.error?.details },
    );
    assert(
      typeof res.error?.message === 'string' && /foundry_eval/.test(res.error.message),
      'probe 13: message points at foundry_eval',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 14: CYCLE_DETECTED — item moved into itself.
  // --------------------------------------------------------------------
  {
    const bp = await makeScratch('__probe_m14_bp', BACKPACK_UUID);
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: bp.id,
      containerId: bp.id,
    });
    log.info({ probe: 14, res }, 'probe 14: self-cycle');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'CYCLE_DETECTED',
      'probe 14: reason=CYCLE_DETECTED',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 15: CYCLE_DETECTED — parent moved into its own child.
  //
  // Setup: parent contains child; attempt to move parent into child.
  // --------------------------------------------------------------------
  {
    const parent = await makeScratch('__probe_m15_parent', BACKPACK_UUID);
    const child = await makeScratch('__probe_m15_child', BACKPACK_UUID, {
      system: { containerId: parent.id },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: parent.id,
      containerId: child.id,
    });
    log.info({ probe: 15, res }, 'probe 15: parent into own child');
    assert(res.isError === true, 'probe 15: error', { res });
    assert(
      res.error?.details?.reason === 'CYCLE_DETECTED',
      'probe 15: reason=CYCLE_DETECTED',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Teardown — restore actor to start-of-probe snapshot signature.
  //
  //   1. Neutralize all containerId references on orphans (so cycles
  //      from a partial cycle-failed probe don't trip cleanup).
  //   2. Delete orphans.
  //   3. Recreate snapshot items missing from the actor (Foundry
  //      assigns fresh ids — assertion is on signature multiset).
  //   4. Restore drifted quantities AND drifted containerIds for
  //      surviving snapshot ids.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapIds = new Set(snapshot.items.map((s) => s.id));

      const orphans = actor.items.contents.filter((i) => !snapIds.has(i.id)).map((i) => i.id);
      // Neutralize containerId on orphans first (handles parent-with-
      // contents survival and any cycle-attempt residue).
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
    PROBE_ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');

  // --------------------------------------------------------------------
  // Probe 16: post-teardown signature equality.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 16: item count equals snapshot',
    { snap: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(
    teardown.signaturesMatch === true,
    'probe 16: name+type+qty+containerId multiset matches snapshot',
    { missing: teardown.missing, extras: teardown.extras },
  );
  assert(teardown.deleteFailures.length === 0, 'probe 16: no orphan-delete failures', {
    failures: teardown.deleteFailures,
  });
  assert(teardown.recreateFailures.length === 0, 'probe 16: no recreate failures', {
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
