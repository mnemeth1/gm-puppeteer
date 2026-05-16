/**
 * Probe + acceptance script for use_item. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Consumable happy path: temp Minor Healing Potion qty=2 →
 *       qty=1, deleted=false, mode=consume.
 *   2.  autoDestroy last consumable: temp potion qty=1 → deleted=true.
 *   3.  Wand silent no-op detection: temp wand on non-caster →
 *       USE_HAD_NO_EFFECT with wand-specific hint (Phase-1 Q3 finding).
 *   4.  Scroll without embedded spell: temp generic scroll → deleted +
 *       chatMessageId populated (Phase-1 Q6 finding).
 *   5.  Zero-quantity guard: temp potion qty=0 → NO_CHARGES_REMAINING.
 *   6.  Equipment-with-no-uses: synthetic equipment, no system.uses →
 *       mode=message, chatMessageId populated, no decrement.
 *   7.  Equipment-with-uses: synthetic equipment with uses=2/2 →
 *       mode=message, usesAfter=1, chatMessageId populated.
 *   8.  Equipment zero-uses guard: synthetic equipment uses=0/2 →
 *       NO_CHARGES_REMAINING.
 *   9.  Weapon rejection: temp Longsword → ITEM_TYPE_UNSUPPORTED.
 *   10. Non-physical rejection: synthetic feat → ITEM_TYPE_NON_PHYSICAL.
 *   11. Error: bogus actorId.
 *   12. Error: bogus itemId.
 *   13. Teardown verification: post-teardown signature multiset
 *       (name|type|qty|containerId) equals the start-of-probe set.
 *
 * State restoration model: full-payload snapshot at probe start;
 * autoDestroy deletions force recreate-from-payload during teardown
 * (Foundry assigns a fresh id, so id-equality won't hold — the
 * signature multiset is the id-independent check). Temp items are
 * tagged `__probe_use_item_*` so leftover state is caught by the
 * pre-probe scrub.
 *
 *   npm run build && node scripts/probe-use-item.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'use_item');
if (!tool) {
  log.error('use_item not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B'; // Test Valeros in sandbox
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';
// Phase-1 discovery sampled these from equipment-srd: any rank-1
// scroll-category and wand-category consumable. Stable-enough to
// hardcode here; if PF2e renames, sample at probe start instead.
const SCROLL_UUID = 'Compendium.pf2e.equipment-srd.Item.4sGIy77COooxhQuC';
const WAND_UUID = 'Compendium.pf2e.equipment-srd.Item.0KaC1NryNfckdS7T';

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
  // Pre-probe scrub: remove leftover temp items from any prior run.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: `actor ${actorId} not found` };
    const orphans = actor.items.contents
      .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe_use_item_'))
      .map((i) => i.id);
    if (orphans.length > 0) await actor.deleteEmbeddedDocuments('Item', orphans);
    return { deleted: orphans.length, itemCount: actor.items.size };
  }, PROBE_ACTOR_ID);
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub?.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot full toObject() payloads — destructive paths (autoDestroy)
  // require recreate-from-payload teardown.
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
  log.info({ itemCount: startSnapshot.itemCount }, 'snapshot: start-of-probe state captured');

  // --------------------------------------------------------------------
  // Helpers for creating temp items on the actor.
  // --------------------------------------------------------------------
  async function makeTempFromCompendium(name, sourceUuid, systemOverrides = {}) {
    return page.evaluate(
      async (actorId, name, sourceUuid, sysOver) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(sourceUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          { ...data, name, system: { ...(data.system ?? {}), ...sysOver } },
        ]);
        const c = created[0];
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          subtype: c.system?.category ?? null,
          qty: c.system?.quantity ?? null,
          usesValue: c.system?.uses?.value ?? null,
          usesMax: c.system?.uses?.max ?? null,
        };
      },
      PROBE_ACTOR_ID,
      name,
      sourceUuid,
      systemOverrides,
    );
  }

  async function makeTempSynthetic(payload) {
    return page.evaluate(
      async (actorId, payload) => {
        const actor = globalThis.game.actors?.get(actorId);
        const created = await actor.createEmbeddedDocuments('Item', [payload]);
        const c = created[0];
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          qty: c.system?.quantity ?? null,
          usesValue: c.system?.uses?.value ?? null,
          usesMax: c.system?.uses?.max ?? null,
        };
      },
      PROBE_ACTOR_ID,
      payload,
    );
  }

  async function deleteTemp(itemId) {
    return page.evaluate(
      async (actorId, id) => {
        const actor = globalThis.game.actors?.get(actorId);
        const live = actor.items.get(id);
        if (live) await actor.deleteEmbeddedDocuments('Item', [id]);
        return { existed: !!live };
      },
      PROBE_ACTOR_ID,
      itemId,
    );
  }

  // ====================================================================
  // Probe 1: consumable happy path (potion qty=2 → qty=1).
  // ====================================================================
  {
    const temp = await makeTempFromCompendium(
      '__probe_use_item_p1_potion',
      HEALING_POTION_UUID,
      { quantity: 2 },
    );
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 1, res }, 'probe 1: consumable happy path');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'used', 'probe 1: operation=used', { op: res.data.operation });
      assert(res.data.mode === 'consume', 'probe 1: mode=consume', { mode: res.data.mode });
      assert(res.data.item?.id === temp.id, 'probe 1: item.id matches', { id: res.data.item?.id });
      assert(res.data.item?.subtype === 'potion', 'probe 1: subtype=potion', { subtype: res.data.item?.subtype });
      assert(res.data.item?.qtyBefore === 2, 'probe 1: qtyBefore=2', { qty: res.data.item?.qtyBefore });
      assert(res.data.item?.qtyAfter === 1, 'probe 1: qtyAfter=1', { qty: res.data.item?.qtyAfter });
      assert(res.data.item?.deleted === false, 'probe 1: deleted=false', { d: res.data.item?.deleted });
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 2: autoDestroy last consumable (qty=1 → deleted).
  // ====================================================================
  {
    const temp = await makeTempFromCompendium(
      '__probe_use_item_p2_lastpotion',
      HEALING_POTION_UUID,
      { quantity: 1 },
    );
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 2, res }, 'probe 2: autoDestroy last consumable');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.mode === 'consume', 'probe 2: mode=consume', { mode: res.data.mode });
      assert(res.data.item?.qtyBefore === 1, 'probe 2: qtyBefore=1', { q: res.data.item?.qtyBefore });
      assert(res.data.item?.deleted === true, 'probe 2: deleted=true', { d: res.data.item?.deleted });
      // Verify item is actually gone.
      const stillThere = await page.evaluate(
        (actorId, id) => !!globalThis.game.actors?.get(actorId)?.items?.get(id),
        PROBE_ACTOR_ID,
        temp.id,
      );
      assert(stillThere === false, 'probe 2: item is gone from actor', { stillThere });
    }
    // Teardown handles snapshot-id deletion via recreate-from-payload.
  }

  // ====================================================================
  // Probe 3: wand silent no-op → USE_HAD_NO_EFFECT.
  // Phase-1 Q3 confirmed consume() on a wand on a non-caster does
  // nothing without throwing — the tool must detect this.
  // ====================================================================
  {
    const temp = await makeTempFromCompendium('__probe_use_item_p3_wand', WAND_UUID, {
      quantity: 1,
    });
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 3, res }, 'probe 3: wand silent no-op');
    assert(res.isError === true, 'probe 3: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'USE_HAD_NO_EFFECT',
        'probe 3: reason=USE_HAD_NO_EFFECT',
        { reason: res.error?.details?.reason },
      );
      assert(
        typeof res.error?.message === 'string' && res.error.message.includes('Wand'),
        'probe 3: message mentions Wand-specific hint',
        { msg: res.error?.message },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 4: scroll without embedded spell → deleted, chat posted.
  // Phase-1 Q6 confirmed consume() on a generic-rank scroll (no
  // embedded spell, on non-caster) auto-destroys and posts chat.
  // ====================================================================
  {
    const temp = await makeTempFromCompendium('__probe_use_item_p4_scroll', SCROLL_UUID, {
      quantity: 1,
    });
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 4, res }, 'probe 4: scroll no-embedded-spell');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.mode === 'consume', 'probe 4: mode=consume', { mode: res.data.mode });
      assert(res.data.item?.subtype === 'scroll', 'probe 4: subtype=scroll', {
        subtype: res.data.item?.subtype,
      });
      assert(res.data.item?.deleted === true, 'probe 4: deleted=true', {
        d: res.data.item?.deleted,
      });
      assert(
        typeof res.data.chatMessageId === 'string',
        'probe 4: chatMessageId populated',
        { id: res.data.chatMessageId },
      );
    }
    // Teardown handles snapshot-id cleanup of the deleted scroll.
  }

  // ====================================================================
  // Probe 5: zero-quantity guard.
  // ====================================================================
  {
    const temp = await makeTempFromCompendium(
      '__probe_use_item_p5_emptypotion',
      HEALING_POTION_UUID,
      { quantity: 0 },
    );
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 5, res }, 'probe 5: zero-quantity guard');
    assert(res.isError === true, 'probe 5: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'NO_CHARGES_REMAINING',
        'probe 5: reason=NO_CHARGES_REMAINING',
        { reason: res.error?.details?.reason },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 6: equipment with no uses (synthetic) → mode=message,
  // chatMessageId populated, no decrement.
  // ====================================================================
  {
    const temp = await makeTempSynthetic({
      name: '__probe_use_item_p6_equipment_nouses',
      type: 'equipment',
      system: {
        description: { value: '' },
        quantity: 1,
      },
    });
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 6, res }, 'probe 6: equipment no-uses');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.mode === 'message', 'probe 6: mode=message', { mode: res.data.mode });
      assert(res.data.item?.qtyAfter === 1, 'probe 6: qtyAfter=1 (no quantity change)', {
        qty: res.data.item?.qtyAfter,
      });
      assert(res.data.item?.deleted === false, 'probe 6: deleted=false', {
        d: res.data.item?.deleted,
      });
      assert(
        typeof res.data.chatMessageId === 'string',
        'probe 6: chatMessageId populated',
        { id: res.data.chatMessageId },
      );
      assert(
        res.data.item?.usesBefore === undefined && res.data.item?.usesAfter === undefined,
        'probe 6: no uses fields for no-uses equipment',
        { item: res.data.item },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 7: equipment with uses (synthetic) → mode=message, decrement.
  // ====================================================================
  {
    const temp = await makeTempSynthetic({
      name: '__probe_use_item_p7_equipment_uses',
      type: 'equipment',
      system: {
        description: { value: '' },
        quantity: 1,
        uses: { value: 2, max: 2, autoDestroy: false },
      },
    });
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 7, res }, 'probe 7: equipment with uses');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.mode === 'message', 'probe 7: mode=message', { mode: res.data.mode });
      assert(res.data.item?.usesBefore === 2, 'probe 7: usesBefore=2', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 1, 'probe 7: usesAfter=1', {
        u: res.data.item?.usesAfter,
      });
      assert(
        typeof res.data.chatMessageId === 'string',
        'probe 7: chatMessageId populated',
        { id: res.data.chatMessageId },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 8: equipment with zero uses → NO_CHARGES_REMAINING.
  // ====================================================================
  {
    const temp = await makeTempSynthetic({
      name: '__probe_use_item_p8_equipment_empty',
      type: 'equipment',
      system: {
        description: { value: '' },
        quantity: 1,
        uses: { value: 0, max: 2, autoDestroy: false },
      },
    });
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 8, res }, 'probe 8: equipment zero uses');
    assert(res.isError === true, 'probe 8: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'NO_CHARGES_REMAINING',
        'probe 8: reason=NO_CHARGES_REMAINING',
        { reason: res.error?.details?.reason },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 9: weapon rejection.
  // ====================================================================
  {
    const temp = await makeTempFromCompendium(
      '__probe_use_item_p9_longsword',
      LONGSWORD_UUID,
      { quantity: 1 },
    );
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 9, res }, 'probe 9: weapon rejection');
    assert(res.isError === true, 'probe 9: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'ITEM_TYPE_UNSUPPORTED',
        'probe 9: reason=ITEM_TYPE_UNSUPPORTED',
        { reason: res.error?.details?.reason },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 10: non-physical rejection (synthetic feat).
  // ====================================================================
  {
    const temp = await makeTempSynthetic({
      name: '__probe_use_item_p10_feat',
      type: 'feat',
      system: { description: { value: '' } },
    });
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: temp.id });
    log.info({ probe: 10, res }, 'probe 10: non-physical rejection');
    assert(res.isError === true, 'probe 10: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'ITEM_TYPE_NON_PHYSICAL',
        'probe 10: reason=ITEM_TYPE_NON_PHYSICAL',
        { reason: res.error?.details?.reason },
      );
    }
    await deleteTemp(temp.id);
  }

  // ====================================================================
  // Probe 11: bogus actorId.
  // ====================================================================
  {
    const res = await call({ actorId: 'nope_no_such_actor', itemId: 'whatever' });
    log.info({ probe: 11, res }, 'probe 11: bogus actorId');
    assert(res.isError === true, 'probe 11: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'ACTOR_NOT_FOUND',
        'probe 11: reason=ACTOR_NOT_FOUND',
        { reason: res.error?.details?.reason },
      );
    }
  }

  // ====================================================================
  // Probe 12: bogus itemId.
  // ====================================================================
  {
    const res = await call({ actorId: PROBE_ACTOR_ID, itemId: 'nope_no_such_item_id' });
    log.info({ probe: 12, res }, 'probe 12: bogus itemId');
    assert(res.isError === true, 'probe 12: error returned', { res });
    if (res.isError) {
      assert(
        res.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
        'probe 12: reason=ITEM_NOT_FOUND_ON_ACTOR',
        { reason: res.error?.details?.reason },
      );
    }
  }

  // --------------------------------------------------------------------
  // Teardown — restore actor to start-of-probe signature multiset.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapIds = new Set(snapshot.items.map((s) => s.id));
      const orphans = actor.items.contents.filter((i) => !snapIds.has(i.id)).map((i) => i.id);
      const deleted = [];
      for (const id of orphans) {
        const live = actor.items.get(id);
        if (!live) continue;
        await actor
          .updateEmbeddedDocuments('Item', [{ _id: id, 'system.containerId': null }])
          .catch(() => undefined);
        try {
          await actor.deleteEmbeddedDocuments('Item', [id]);
          deleted.push(id);
        } catch (e) {
          deleted.push({ id, err: e?.message ?? String(e) });
        }
      }

      const recreated = [];
      for (const snap of snapshot.items) {
        if (actor.items.get(snap.id)) continue;
        try {
          const c = await actor.createEmbeddedDocuments('Item', [snap.payload]);
          recreated.push({ originalId: snap.id, newId: c[0]?.id ?? null });
        } catch (e) {
          recreated.push({ originalId: snap.id, err: e?.message ?? String(e) });
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

      const sigOf = (s) =>
        `${s.name ?? ''}|${s.type ?? ''}|${s.qty}|${s.containerId ?? ''}`;
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
        if ((liveSig.get(k) ?? 0) !== n) missing.push({ k, expected: n, actual: liveSig.get(k) ?? 0 });
      }
      const extras = [];
      for (const [k, n] of liveSig) {
        if (!snapSig.has(k)) extras.push({ k, n });
      }
      return {
        deleted: deleted.length,
        recreated: recreated.length,
        recreatedDetails: recreated,
        updatesApplied: updates.length,
        finalCount: actor.items.size,
        signaturesMatch: missing.length === 0 && extras.length === 0,
        missing,
        extras,
      };
    },
    PROBE_ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');

  if (!teardown.signaturesMatch) {
    assert(false, 'teardown: multiset signature mismatch', teardown);
  }

  // --------------------------------------------------------------------
  // Final report.
  // --------------------------------------------------------------------
  log.info({ failureCount: failures.length, failures }, 'PROBE SUMMARY');
  if (failures.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
