/**
 * Probe + acceptance script for update_item_uses. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Happy: wand value-down (uses.value 10 → 4).
 *   2.  Happy: wand value-up / recharge (uses.value 4 → 10).
 *   3.  Happy: set-equal (uses.value 10 → 10; verify usesBefore ===
 *       usesAfter and the response is still operation: "updated").
 *   4.  Happy: depleted (uses.value 10 → 0; verify item still exists,
 *       autoDestroy did NOT fire — proves divergence from consume()).
 *   5.  Happy: over-set (uses.value 99 on usesMax=10 wand; verify
 *       Foundry stored the literal value, no clamping at any layer,
 *       and response.usesMax still reflects the snapshot value=10).
 *   6.  Happy: equipment with uses (synthetic equipment with
 *       `uses: {value: 1, max: 3, autoDestroy: false}`; set value=3;
 *       confirms the equipment branch, not just consumables).
 *   7.  Happy: potion with `uses.max === 1` (the gotcha case — temp
 *       Minor Healing Potion, set value=1; verify `system.quantity`
 *       is unchanged, proving the tool only writes uses.value).
 *   8.  Reject: value=-1 via raw handler (bypass zod) → INVALID_VALUE.
 *       The eval-layer defensive check; zod's .min(0) catches the
 *       boundary.
 *   9.  Reject: value=1.5 → zod validation rejection at the MCP edge.
 *   10. Reject: item without system.uses (longsword) →
 *       ITEM_HAS_NO_USES_FIELD.
 *   11. Reject: non-physical item (synthetic rules-free feat) →
 *       UPDATE_ON_NON_PHYSICAL.
 *   12. Reject: bogus actorId → ACTOR_NOT_FOUND, plus bogus itemId →
 *       ITEM_NOT_FOUND_ON_ACTOR.
 *   13. Teardown verification: post-teardown signature multiset
 *       (name|type|qty|containerId|usesValue) equals start-of-probe
 *       snapshot. The signature includes usesValue so that any drift
 *       in uses.value on a non-temp item would be caught — today the
 *       probe only mutates temps that get cleaned up, but the check
 *       is a cheap safety net for future variants of this probe that
 *       might target permanent items with uses.
 *
 * State restoration model: mirrors probe-update-item-quantity.mjs.
 * Snapshot every item as full toObject() payload at start. Teardown
 * deletes orphans, recreates missing snapshot ids (Foundry assigns
 * fresh ids — assertion is on signature multiset, not id-equality),
 * and restores drifted quantities AND drifted uses.value.
 *
 *   npm run build && node scripts/probe-update-item-uses.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'update_item_uses');
if (!tool) {
  log.error('update_item_uses not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const WAND_UUID = 'Compendium.pf2e.equipment-srd.Item.0KaC1NryNfckdS7T';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';

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
// reach the evaluator's defensive checks (e.g. INVALID_VALUE) that
// the zod schema otherwise rejects at the boundary.
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
  // Pre-probe scrub. Delete any __probe_uius_* orphans on Test Valeros
  // left over from previous failed runs. No canonical-state restoration
  // needed — every uses exercise creates a temp item.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: `actor ${actorId} not found` };
    const orphans = actor.items.contents
      .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe_uius'))
      .map((i) => i.id);
    if (orphans.length > 0) await actor.deleteEmbeddedDocuments('Item', orphans);
    return { deleted: orphans.length, itemCount: actor.items.size };
  }, PROBE_ACTOR_ID);
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot: full toObject() payload per item, plus usesValue alongside
  // qty/containerId so teardown can restore drifted uses (in addition
  // to drifted quantity).
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
        usesValue: typeof i.system?.uses?.value === 'number' ? i.system.uses.value : null,
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

  // ====================================================================
  // Set up the wand used by probes 1-5. Override uses to known values
  // so the test is deterministic regardless of compendium defaults.
  // ====================================================================
  const wand = await makeTempFromCompendium('__probe_uius_p1_wand__', WAND_UUID, {
    uses: { value: 10, max: 10, autoDestroy: false },
  });
  log.info({ wand }, 'created temp wand for probes 1-5');

  // --------------------------------------------------------------------
  // Probe 1: wand value-down (10 → 4).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: 4,
    });
    log.info({ probe: 1, res }, 'probe 1: wand uses.value 10 → 4');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 1: operation=updated', {
        op: res.data.operation,
      });
      assert(res.data.item?.id === wand.id, 'probe 1: id matches', {
        id: res.data.item?.id,
      });
      assert(res.data.item?.usesBefore === 10, 'probe 1: usesBefore=10', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 4, 'probe 1: usesAfter=4', {
        u: res.data.item?.usesAfter,
      });
      assert(res.data.item?.usesMax === 10, 'probe 1: usesMax=10', {
        u: res.data.item?.usesMax,
      });
    }
    const liveValue = await page.evaluate(
      (actorId, id) => globalThis.game.actors.get(actorId).items.get(id)?.system?.uses?.value,
      PROBE_ACTOR_ID,
      wand.id,
    );
    assert(liveValue === 4, 'probe 1: live uses.value actually updated to 4', {
      liveValue,
    });
  }

  // --------------------------------------------------------------------
  // Probe 2: wand value-up / recharge (4 → 10).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: 10,
    });
    log.info({ probe: 2, res }, 'probe 2: wand uses.value 4 → 10 (recharge)');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.usesBefore === 4, 'probe 2: usesBefore=4', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 10, 'probe 2: usesAfter=10', {
        u: res.data.item?.usesAfter,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: set-equal (10 → 10). Confirms response shape carries
  // usesBefore === usesAfter rather than introducing a noop flag.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: 10,
    });
    log.info({ probe: 3, res }, 'probe 3: wand 10 → 10 (set-equal)');
    assert(res.ok === true, 'probe 3: ok (set-equal does not throw)', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 3: operation=updated', {
        op: res.data.operation,
      });
      assert(res.data.item?.usesBefore === 10, 'probe 3: usesBefore=10', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 10, 'probe 3: usesAfter=10', {
        u: res.data.item?.usesAfter,
      });
      assert(
        res.data.item?.usesBefore === res.data.item?.usesAfter,
        'probe 3: usesBefore === usesAfter signals no-op',
        { before: res.data.item?.usesBefore, after: res.data.item?.usesAfter },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: depleted (10 → 0). Verify item still exists on actor —
  // autoDestroy must NOT fire from a direct write (it's gated on the
  // consume() pipeline).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: 0,
    });
    log.info({ probe: 4, res }, 'probe 4: wand 10 → 0 (depleted, no autoDestroy)');
    assert(res.ok === true, 'probe 4: ok (zero is legitimate)', { res });
    if (res.ok) {
      assert(res.data.item?.usesBefore === 10, 'probe 4: usesBefore=10', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 0, 'probe 4: usesAfter=0', {
        u: res.data.item?.usesAfter,
      });
    }
    const stillExists = await page.evaluate(
      (actorId, id) => !!globalThis.game.actors.get(actorId).items.get(id),
      PROBE_ACTOR_ID,
      wand.id,
    );
    assert(stillExists === true, 'probe 4: wand still exists on actor (autoDestroy did NOT fire)', {
      stillExists,
    });
  }

  // --------------------------------------------------------------------
  // Probe 5: over-set (value=99 on a usesMax=10 wand). Verify Foundry
  // stored the literal value (no clamping) and the response.usesMax
  // still reflects the unchanged max snapshot.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: 99,
    });
    log.info({ probe: 5, res }, 'probe 5: wand 0 → 99 (over-set, no clamp)');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.item?.usesBefore === 0, 'probe 5: usesBefore=0', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 99, 'probe 5: usesAfter=99 (no clamp)', {
        u: res.data.item?.usesAfter,
      });
      assert(res.data.item?.usesMax === 10, 'probe 5: usesMax still 10 (unchanged)', {
        u: res.data.item?.usesMax,
      });
    }
    const liveValue = await page.evaluate(
      (actorId, id) => globalThis.game.actors.get(actorId).items.get(id)?.system?.uses?.value,
      PROBE_ACTOR_ID,
      wand.id,
    );
    assert(liveValue === 99, 'probe 5: live uses.value=99 (no clamp at any layer)', {
      liveValue,
    });
  }

  // --------------------------------------------------------------------
  // Probe 6: equipment with uses (synthetic). Confirms the equipment
  // branch, not just consumables. Mirrors probe-use-item.mjs Probe 7
  // shape.
  // --------------------------------------------------------------------
  {
    const equip = await makeTempSynthetic({
      name: '__probe_uius_p6_equip__',
      type: 'equipment',
      system: {
        description: { value: '' },
        quantity: 1,
        uses: { value: 1, max: 3, autoDestroy: false },
      },
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: equip.id,
      value: 3,
    });
    log.info({ probe: 6, res }, 'probe 6: equipment uses 1 → 3');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.item?.type === 'equipment', 'probe 6: type=equipment', {
        type: res.data.item?.type,
      });
      assert(res.data.item?.usesBefore === 1, 'probe 6: usesBefore=1', {
        u: res.data.item?.usesBefore,
      });
      assert(res.data.item?.usesAfter === 3, 'probe 6: usesAfter=3', {
        u: res.data.item?.usesAfter,
      });
      assert(res.data.item?.usesMax === 3, 'probe 6: usesMax=3', {
        u: res.data.item?.usesMax,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: potion with uses.max === 1 (the gotcha case). The tool
  // writes uses.value faithfully even though use_item would decrement
  // quantity for this item type. Verify quantity is unchanged after
  // the write.
  // --------------------------------------------------------------------
  {
    const potion = await makeTempFromCompendium('__probe_uius_p7_potion__', HEALING_POTION_UUID, {
      quantity: 2,
    });
    // Sanity: confirm the compendium potion ships with uses.max === 1.
    assert(potion.usesMax === 1, 'probe 7: precondition — potion uses.max === 1', {
      max: potion.usesMax,
    });
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: potion.id,
      value: 1,
    });
    log.info({ probe: 7, res }, 'probe 7: potion uses.value set (max=1 gotcha)');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.item?.usesAfter === 1, 'probe 7: usesAfter=1', {
        u: res.data.item?.usesAfter,
      });
      assert(res.data.item?.usesMax === 1, 'probe 7: usesMax=1', {
        u: res.data.item?.usesMax,
      });
    }
    // Verify quantity untouched — the tool only writes uses.value.
    const liveQty = await page.evaluate(
      (actorId, id) => globalThis.game.actors.get(actorId).items.get(id)?.system?.quantity,
      PROBE_ACTOR_ID,
      potion.id,
    );
    assert(liveQty === 2, 'probe 7: system.quantity unchanged (tool writes only uses.value)', {
      liveQty,
    });
  }

  // --------------------------------------------------------------------
  // Probe 8: value=-1 via raw handler (bypass zod) → INVALID_VALUE.
  // Reaches the eval-layer defensive check.
  // --------------------------------------------------------------------
  {
    const res = await callRaw({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: -1,
    });
    log.info({ probe: 8, res }, 'probe 8: value=-1 via raw handler');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 8: INVALID_INPUT', {
      code: res.error?.code,
    });
    assert(res.error?.details?.reason === 'INVALID_VALUE', 'probe 8: reason=INVALID_VALUE', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 9: value=1.5 → zod rejection at the MCP boundary.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: wand.id,
      value: 1.5,
    });
    log.info({ probe: 9, res }, 'probe 9: value=1.5');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(Array.isArray(res.validation), 'probe 9: zod validation error', {
      v: res.validation,
    });
  }

  // --------------------------------------------------------------------
  // Probe 10: longsword (no system.uses) → ITEM_HAS_NO_USES_FIELD.
  // --------------------------------------------------------------------
  {
    const longsword = await makeTempFromCompendium('__probe_uius_p10_longsword__', LONGSWORD_UUID);
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: longsword.id,
      value: 1,
    });
    log.info({ probe: 10, res }, 'probe 10: longsword has no uses field');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_HAS_NO_USES_FIELD',
      'probe 10: reason=ITEM_HAS_NO_USES_FIELD',
      { d: res.error?.details },
    );
    assert(
      typeof res.error?.message === 'string' && res.error.message.includes('get_item_details'),
      'probe 10: message points at get_item_details',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: non-physical item (synthetic feat) → UPDATE_ON_NON_PHYSICAL.
  // Same rules-free-feat pattern as probe-update-item-quantity.mjs Probe
  // 11 (avoids PF2e GrantItem cascades that hang in headless context).
  // --------------------------------------------------------------------
  {
    const tempFeat = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const created = await actor.createEmbeddedDocuments('Item', [
        {
          name: '__probe_uius_p11_feat__',
          type: 'feat',
          system: { description: { value: '' } },
        },
      ]);
      return { id: created[0].id, name: created[0].name, type: created[0].type };
    }, PROBE_ACTOR_ID);

    const res = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: tempFeat.id,
      value: 1,
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
  // Probe 12: bogus actorId → ACTOR_NOT_FOUND, plus bogus itemId →
  // ITEM_NOT_FOUND_ON_ACTOR. Two cheap resolution failures bundled.
  // --------------------------------------------------------------------
  {
    const resActor = await call({
      actorId: 'deadbeefdeadbeef',
      itemId: 'whatever',
      value: 1,
    });
    log.info({ probe: 12, sub: 'actor', res: resActor }, 'probe 12a: bogus actorId');
    assert(resActor.isError === true, 'probe 12a: error', { res: resActor });
    assert(
      resActor.error?.details?.reason === 'ACTOR_NOT_FOUND',
      'probe 12a: reason=ACTOR_NOT_FOUND',
      { d: resActor.error?.details },
    );

    const resItem = await call({
      actorId: PROBE_ACTOR_ID,
      itemId: 'deadbeefdeadbeef',
      value: 1,
    });
    log.info({ probe: 12, sub: 'item', res: resItem }, 'probe 12b: bogus itemId');
    assert(resItem.isError === true, 'probe 12b: error', { res: resItem });
    assert(
      resItem.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 12b: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { d: resItem.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Teardown. Mirrors probe-update-item-quantity.mjs but extends the
  // fixup loop to also restore drifted `system.uses.value` for surviving
  // snapshot ids, and the signature multiset to include usesValue so
  // any uses-field drift on a permanent item would be caught.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapIds = new Set(snapshot.items.map((s) => s.id));
      const snapQty = new Map(snapshot.items.map((s) => [s.id, s.qty]));
      const snapUses = new Map(snapshot.items.map((s) => [s.id, s.usesValue]));

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

      // Fix up surviving snapshot ids: both quantity and uses.value
      // can have drifted. Build one updates entry per item with
      // whichever fields need restoring.
      const updates = [];
      for (const item of actor.items.contents) {
        if (!snapIds.has(item.id)) continue;
        const expectedQty = snapQty.get(item.id);
        const expectedUses = snapUses.get(item.id);
        const currentQty = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        const currentUses =
          typeof item.system?.uses?.value === 'number' ? item.system.uses.value : null;
        const entry = { _id: item.id };
        let needs = false;
        if (expectedQty !== undefined && currentQty !== expectedQty) {
          entry['system.quantity'] = expectedQty;
          needs = true;
        }
        if (expectedUses !== null && currentUses !== expectedUses) {
          entry['system.uses.value'] = expectedUses;
          needs = true;
        }
        if (needs) updates.push(entry);
      }
      if (updates.length > 0) await actor.updateEmbeddedDocuments('Item', updates);

      const sigOf = (item) => {
        const qty = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        const containerId = item.system?.containerId ?? '';
        const usesValue =
          typeof item.system?.uses?.value === 'number' ? item.system.uses.value : '';
        return `${item.name ?? ''}|${item.type ?? ''}|${qty}|${containerId}|${usesValue}`;
      };
      const postSig = new Map();
      for (const item of actor.items.contents) {
        const k = sigOf(item);
        postSig.set(k, (postSig.get(k) ?? 0) + 1);
      }
      const snapSig = new Map();
      for (const s of snapshot.items) {
        const k = `${s.name}|${s.type}|${s.qty}|${s.containerId ?? ''}|${s.usesValue ?? ''}`;
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
        fieldsUpdated: updates.length,
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
  // Probe 13: post-teardown signature equality.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 13: item count equals snapshot',
    { snap: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(
    teardown.signaturesMatch === true,
    'probe 13: name+type+qty+containerId+usesValue multiset matches snapshot',
    { missing: teardown.missingSigs, extra: teardown.extraSigs },
  );
  assert(teardown.deleteFailures.length === 0, 'probe 13: no orphan-delete failures', {
    failures: teardown.deleteFailures,
  });
  assert(teardown.recreateFailures.length === 0, 'probe 13: no recreation failures', {
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
