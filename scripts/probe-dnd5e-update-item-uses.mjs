/**
 * Probe + acceptance script for dnd5e_update_item_uses. Drives the live
 * headless Foundry against the dnd5e test world (Foundry v14.361 /
 * dnd5e 5.3.3).
 *
 * The 5e uses model (confirmed by a live read-only probe before this tool
 * was written): `system.uses` stores `{spent, max, recovery, autoDestroy}`;
 * `uses.value` is a DERIVED getter (= max − spent); `uses.max` is a stored
 * formula string resolved to a number on the prepared document. The tool
 * takes a desired REMAINING count and writes `system.uses.spent`.
 *
 * Acceptance probes (run against the tool):
 *   1.  Happy: charges down (consumable max 10, remaining → 4; spent=6).
 *   2.  Happy: recharge to full (remaining → 10; spent=0).
 *   3.  Happy: set-equal (remaining 10 → 10; remainingBefore ===
 *       remainingAfter signals no-op, operation still "updated").
 *   4.  Happy: deplete (remaining → 0; spent=10, item still exists,
 *       autoDestroy did NOT fire even though the item has autoDestroy:true).
 *   5.  Happy: feat with uses (synthetic feat, max 3; remaining → 1).
 *   6.  Happy: spell with uses (synthetic spell, max 1; remaining → 0).
 *   7.  Reject: remaining > max → REMAINING_EXCEEDS_MAX.
 *   8.  Reject: value -1 via raw handler (bypass zod) → INVALID_VALUE.
 *   9.  Reject: value 1.5 → zod validation rejection.
 *   10. Reject: item with no uses tracker (synthetic weapon) →
 *       ITEM_HAS_NO_USES_TRACKER.
 *   11. Reject: bogus actorId → ACTOR_NOT_FOUND; bogus itemId →
 *       ITEM_NOT_FOUND_ON_ACTOR.
 *   12. Reject: unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped
 *       if the world has no vehicle/group/encounter actor).
 *   13. Teardown verification: post-teardown name|type|qty|uses-spent
 *       signature multiset equals the start snapshot.
 *
 * State restoration: the probe only ever creates temp items (deleted in
 * teardown) — it never mutates a canonical item. Teardown still runs the
 * full snapshot/recreate/restore pattern as a safety net.
 *
 *   npm run build && node scripts/probe-dnd5e-update-item-uses.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_update_item_uses');
if (!tool) {
  log.error('dnd5e_update_item_uses not registered');
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
  return invoke(parsed.data);
}

// Bypass zod — reaches the evaluator's defensive checks (INVALID_VALUE).
async function callRaw(args) {
  return invoke(args);
}

async function invoke(args) {
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

// Create temp items on the actor with a full system override.
async function createItems(page, actorId, specs) {
  return page.evaluate(
    async (aId, itemSpecs) => {
      const actor = globalThis.game.actors.get(aId);
      const datas = itemSpecs.map((spec) => ({
        name: spec.name,
        type: spec.type,
        system: { ...(spec.system ?? {}) },
      }));
      const created = await actor.createEmbeddedDocuments('Item', datas);
      return created.map((i) => i.id);
    },
    actorId,
    specs,
  );
}

// Read the live (prepared) uses block, or {exists:false} if the item is gone.
async function liveUses(page, actorId, itemId) {
  return page.evaluate(
    (aId, id) => {
      const item = globalThis.game.actors.get(aId).items.get(id);
      if (!item) return { exists: false };
      const u = item.system?.uses ?? {};
      return { exists: true, spent: u.spent, max: u.max, value: u.value };
    },
    actorId,
    itemId,
  );
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

  // --------------------------------------------------------------------
  // Snapshot: full toObject() payload per item.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors.get(actorId);
    return {
      itemCount: actor.items.size,
      items: actor.items.contents.map((i) => ({
        id: i.id,
        name: i.name ?? '',
        type: i.type ?? '',
        qty: typeof i.system?.quantity === 'number' ? i.system.quantity : 1,
        usesSpent: typeof i.system?.uses?.spent === 'number' ? i.system.uses.spent : null,
        payload: i.toObject(),
      })),
    };
  }, ACTOR_ID);
  log.info({ itemCount: startSnapshot.itemCount }, 'snapshot captured');

  // --------------------------------------------------------------------
  // Probes 1-4: a consumable with a 10-charge pool and autoDestroy:true.
  // --------------------------------------------------------------------
  const [tempWand] = await createItems(page, ACTOR_ID, [
    {
      name: '__probe_uses_wand__',
      type: 'consumable',
      system: { quantity: 1, uses: { max: '10', spent: 0, recovery: [], autoDestroy: true } },
    },
  ]);
  const wandStart = await liveUses(page, ACTOR_ID, tempWand);
  log.info({ wandStart }, 'temp consumable created');
  assert(
    wandStart.exists && wandStart.max === 10 && wandStart.value === 10,
    'setup: temp consumable resolved uses.max=10, value=10',
    { wandStart },
  );

  // Probe 1: charges down (remaining → 4).
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempWand, value: 4 });
    log.info({ probe: 1, res }, 'probe 1: remaining 10 → 4');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 1: operation=updated', {
        op: res.data.operation,
      });
      assert(res.data.item?.remainingBefore === 10, 'probe 1: remainingBefore=10', {
        v: res.data.item?.remainingBefore,
      });
      assert(res.data.item?.remainingAfter === 4, 'probe 1: remainingAfter=4', {
        v: res.data.item?.remainingAfter,
      });
      assert(res.data.item?.max === 10, 'probe 1: max=10', { v: res.data.item?.max });
      assert(res.data.item?.spentBefore === 0, 'probe 1: spentBefore=0', {
        v: res.data.item?.spentBefore,
      });
      assert(res.data.item?.spentAfter === 6, 'probe 1: spentAfter=6 (max-value)', {
        v: res.data.item?.spentAfter,
      });
    }
    const live = await liveUses(page, ACTOR_ID, tempWand);
    assert(
      live.spent === 6 && live.value === 4,
      'probe 1: live uses.spent=6, derived uses.value=4',
      { live },
    );
  }

  // Probe 2: recharge to full (remaining → 10).
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempWand, value: 10 });
    log.info({ probe: 2, res }, 'probe 2: remaining 4 → 10 (recharge)');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.remainingBefore === 4, 'probe 2: remainingBefore=4', {
        v: res.data.item?.remainingBefore,
      });
      assert(res.data.item?.remainingAfter === 10, 'probe 2: remainingAfter=10', {
        v: res.data.item?.remainingAfter,
      });
      assert(res.data.item?.spentAfter === 0, 'probe 2: spentAfter=0', {
        v: res.data.item?.spentAfter,
      });
    }
    const live = await liveUses(page, ACTOR_ID, tempWand);
    assert(live.spent === 0 && live.value === 10, 'probe 2: live spent=0, value=10', { live });
  }

  // Probe 3: set-equal (remaining 10 → 10).
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempWand, value: 10 });
    log.info({ probe: 3, res }, 'probe 3: remaining 10 → 10 (set-equal)');
    assert(res.ok === true, 'probe 3: ok (set-equal does not throw)', { res });
    if (res.ok) {
      assert(res.data.operation === 'updated', 'probe 3: operation=updated', {
        op: res.data.operation,
      });
      assert(
        res.data.item?.remainingBefore === 10 && res.data.item?.remainingAfter === 10,
        'probe 3: remainingBefore === remainingAfter signals no-op',
        { before: res.data.item?.remainingBefore, after: res.data.item?.remainingAfter },
      );
    }
  }

  // Probe 4: deplete (remaining → 0); autoDestroy must NOT fire.
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempWand, value: 0 });
    log.info({ probe: 4, res }, 'probe 4: remaining 10 → 0 (deplete)');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.item?.remainingAfter === 0, 'probe 4: remainingAfter=0', {
        v: res.data.item?.remainingAfter,
      });
      assert(res.data.item?.spentAfter === 10, 'probe 4: spentAfter=10', {
        v: res.data.item?.spentAfter,
      });
    }
    const live = await liveUses(page, ACTOR_ID, tempWand);
    assert(
      live.exists === true,
      'probe 4: item still exists — direct spent write did NOT trigger autoDestroy',
      { live },
    );
    assert(live.spent === 10 && live.value === 0, 'probe 4: live spent=10, value=0', { live });
  }

  // --------------------------------------------------------------------
  // Probe 5: feat with uses (synthetic feat, max 3).
  // --------------------------------------------------------------------
  {
    const [tempFeat] = await createItems(page, ACTOR_ID, [
      {
        name: '__probe_uses_feat__',
        type: 'feat',
        system: { uses: { max: '3', spent: 0, recovery: [] } },
      },
    ]);
    const featStart = await liveUses(page, ACTOR_ID, tempFeat);
    assert(featStart.max === 3, 'probe 5: temp feat resolved uses.max=3', { featStart });
    const res = await call({ actorId: ACTOR_ID, itemId: tempFeat, value: 1 });
    log.info({ probe: 5, res }, 'probe 5: feat remaining 3 → 1');
    assert(res.ok === true, 'probe 5: ok (non-physical item with uses is accepted)', { res });
    if (res.ok) {
      assert(res.data.item?.type === 'feat', 'probe 5: type=feat', { t: res.data.item?.type });
      assert(res.data.item?.remainingAfter === 1, 'probe 5: remainingAfter=1', {
        v: res.data.item?.remainingAfter,
      });
      assert(res.data.item?.spentAfter === 2, 'probe 5: spentAfter=2', {
        v: res.data.item?.spentAfter,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: spell with uses (synthetic spell, max 1).
  // --------------------------------------------------------------------
  {
    const [tempSpell] = await createItems(page, ACTOR_ID, [
      {
        name: '__probe_uses_spell__',
        type: 'spell',
        system: { level: 1, uses: { max: '1', spent: 0, recovery: [] } },
      },
    ]);
    const spellStart = await liveUses(page, ACTOR_ID, tempSpell);
    assert(spellStart.max === 1, 'probe 6: temp spell resolved uses.max=1', { spellStart });
    const res = await call({ actorId: ACTOR_ID, itemId: tempSpell, value: 0 });
    log.info({ probe: 6, res }, 'probe 6: spell remaining 1 → 0');
    assert(res.ok === true, 'probe 6: ok (spell with uses is accepted)', { res });
    if (res.ok) {
      assert(res.data.item?.type === 'spell', 'probe 6: type=spell', { t: res.data.item?.type });
      assert(res.data.item?.remainingAfter === 0, 'probe 6: remainingAfter=0', {
        v: res.data.item?.remainingAfter,
      });
      assert(res.data.item?.spentAfter === 1, 'probe 6: spentAfter=1', {
        v: res.data.item?.spentAfter,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: remaining > max → REMAINING_EXCEEDS_MAX.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempWand, value: 99 });
    log.info({ probe: 7, res }, 'probe 7: remaining 99 on a max-10 item');
    assert(res.isError === true, 'probe 7: error', { res });
    assert(
      res.error?.details?.reason === 'REMAINING_EXCEEDS_MAX',
      'probe 7: reason=REMAINING_EXCEEDS_MAX',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 8: value -1 via raw handler (bypass zod) → INVALID_VALUE.
  // --------------------------------------------------------------------
  {
    const res = await callRaw({ actorId: ACTOR_ID, itemId: tempWand, value: -1 });
    log.info({ probe: 8, res }, 'probe 8: value -1 via raw handler');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(res.error?.details?.reason === 'INVALID_VALUE', 'probe 8: reason=INVALID_VALUE', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 9: value 1.5 → zod rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, itemId: tempWand, value: 1.5 });
    log.info({ probe: 9, res }, 'probe 9: value 1.5');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(Array.isArray(res.validation), 'probe 9: zod validation error', { v: res.validation });
  }

  // --------------------------------------------------------------------
  // Probe 10: item with no uses tracker → ITEM_HAS_NO_USES_TRACKER.
  // --------------------------------------------------------------------
  {
    const [tempWeapon] = await createItems(page, ACTOR_ID, [
      { name: '__probe_uses_weapon__', type: 'weapon', system: {} },
    ]);
    const res = await call({ actorId: ACTOR_ID, itemId: tempWeapon, value: 1 });
    log.info({ probe: 10, res }, 'probe 10: weapon with no uses pool');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'ITEM_HAS_NO_USES_TRACKER',
      'probe 10: reason=ITEM_HAS_NO_USES_TRACKER',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: bogus actorId / itemId.
  // --------------------------------------------------------------------
  {
    const resActor = await call({ actorId: 'deadbeefdeadbeef', itemId: 'whatever', value: 1 });
    log.info({ probe: 11, resActor }, 'probe 11a: bogus actorId');
    assert(
      resActor.error?.details?.reason === 'ACTOR_NOT_FOUND',
      'probe 11a: reason=ACTOR_NOT_FOUND',
      { d: resActor.error?.details },
    );
    const resItem = await call({ actorId: ACTOR_ID, itemId: 'deadbeefdeadbeef', value: 1 });
    log.info({ probe: 11, resItem }, 'probe 11b: bogus itemId');
    assert(
      resItem.error?.details?.reason === 'ITEM_NOT_FOUND_ON_ACTOR',
      'probe 11b: reason=ITEM_NOT_FOUND_ON_ACTOR',
      { d: resItem.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // Probe 12: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
  // --------------------------------------------------------------------
  if (actorIds.other) {
    const res = await call({ actorId: actorIds.other.id, itemId: 'whatever', value: 1 });
    log.info({ probe: 12, res, otherType: actorIds.other.type }, 'probe 12: unsupported actor');
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 12: reason=ACTOR_TYPE_UNSUPPORTED',
      { d: res.error?.details },
    );
  } else {
    log.info({ probe: 12 }, 'probe 12 skipped: no vehicle/group/encounter actor in world');
  }

  // --------------------------------------------------------------------
  // Teardown: delete orphans, recreate missing snapshot ids, restore
  // drifted quantities, assert signature-multiset equality.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors.get(actorId);
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
          recreated.push({ originalId: snap.id, newId: c[0]?.id ?? null });
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

      const sigOf = (name, type, qty, spent) => `${name}|${type}|${qty}|${spent ?? ''}`;
      const postSig = new Map();
      for (const item of actor.items.contents) {
        const qty = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        const spent =
          typeof item.system?.uses?.spent === 'number' ? item.system.uses.spent : null;
        const k = sigOf(item.name ?? '', item.type ?? '', qty, spent);
        postSig.set(k, (postSig.get(k) ?? 0) + 1);
      }
      const snapSig = new Map();
      for (const s of snapshot.items) {
        const k = sigOf(s.name, s.type, s.qty, s.usesSpent);
        snapSig.set(k, (snapSig.get(k) ?? 0) + 1);
      }
      const missingSigs = [];
      for (const [sig, count] of snapSig) {
        if ((postSig.get(sig) ?? 0) !== count) {
          missingSigs.push({ sig, expected: count, actual: postSig.get(sig) ?? 0 });
        }
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
    ACTOR_ID,
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
  assert(teardown.signaturesMatch === true, 'probe 13: signature multiset matches snapshot', {
    missing: teardown.missingSigs,
    extra: teardown.extraSigs,
  });
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
