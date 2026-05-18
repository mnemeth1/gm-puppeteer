/**
 * Phase-1 design probe for the D&D 5e inventory-graph mutation tools
 * (`dnd5e_move_item_to_container`, `dnd5e_transfer_item_between_actors`).
 *
 * Drives the live headless Foundry against the dnd5e test world via raw
 * `createEmbeddedDocuments` / `updateEmbeddedDocuments` /
 * `deleteEmbeddedDocuments` — the tools do not exist yet. It answers the
 * design-blocking questions about 5e's container relational field so the
 * evaluators are written against confirmed behavior, not ported PF2e facts.
 *
 * Questions:
 *   Q1  `system.container` shape at inventory root (null / "" / absent).
 *   Q2  Write path: does setting `system.container` drift any sibling field?
 *   Q3  Same-destination set — clean no-op (returns [], no throw)?
 *   Q4  Self-cycle (depth 1) — accepted, clamped, or rejected?
 *   Q5  Depth-2 cycle (A→B then B→A) — accepted?
 *   Q6  Non-container target id (a weapon's id) — accepted?
 *   Q7  Moving a populated container — do children's refs stay intact?
 *   Q8  `system.equipped` shape — bare boolean?
 *   Q9  Attunement: `system.attuned` / `system.attunement` field shapes.
 *   Q10 `createEmbeddedDocuments(..., {keepId:true})` with pre-generated
 *       `foundry.utils.randomID()` ids — preserves ids + subtree shape?
 *   Q11 Bulk-delete of a [container, child, child] subtree — clean, no
 *       dangling-ref drift on unrelated items?
 *   Q12 `_stats.compendiumSource` survives a `toObject()` → create round-trip?
 *
 * State restoration model (additive — the probe only ever CREATES scratch
 * items): snapshot every item id on the actor at start; on teardown delete
 * every item whose id is not in the snapshot, restore any drifted snapshot
 * quantity, then assert the post-teardown id set equals the snapshot set.
 *
 *   npm run build && node scripts/probe-dnd5e-inventory-graph-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const findings = {};
const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}
function record(q, data) {
  findings[q] = data;
  log.info({ q, ...data }, `Q${q}`);
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Resolve a probe-target character actor.
  // --------------------------------------------------------------------
  const actorInfo = await page.evaluate(() => {
    const pc = globalThis.game.actors.find((a) => a.type === 'character');
    return pc ? { id: pc.id, name: pc.name } : null;
  });
  if (!actorInfo) {
    log.error('probe aborted: world needs a character actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const ACTOR_ID = actorInfo.id;
  log.info({ actorInfo }, 'resolved probe actor');

  // --------------------------------------------------------------------
  // Discovery: compendium UUIDs — two distinct container sources, a
  // weapon, and an equippable equipment item.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(async () => {
    const game = globalThis.game;
    const itemPacks = game.packs.filter((p) => p.documentName === 'Item');
    const containers = [];
    let weapon = null;
    let equipment = null;
    let anyPhysical = null;
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
        if (type === 'container' && containers.length < 4) {
          containers.push({ uuid, name: e.name ?? '', type });
        }
        if (!weapon && type === 'weapon') weapon = { uuid, name: e.name ?? '', type };
        if (!equipment && type === 'equipment') equipment = { uuid, name: e.name ?? '', type };
        if (
          !anyPhysical &&
          ['weapon', 'equipment', 'consumable', 'tool', 'loot'].includes(type)
        ) {
          anyPhysical = { uuid, name: e.name ?? '', type };
        }
      }
    }
    return { containerCount: containers.length, containers, weapon, equipment, anyPhysical };
  });
  log.info({ discovery }, 'discovered probe targets');
  if (discovery.containerCount < 1 || !discovery.weapon) {
    log.error('probe aborted: world needs at least 1 container + 1 weapon compendium item');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const CONTAINER_UUID = discovery.containers[0].uuid;
  const WEAPON_UUID = discovery.weapon.uuid;
  const EQUIPMENT_UUID = (discovery.equipment ?? discovery.anyPhysical ?? discovery.weapon).uuid;

  // --------------------------------------------------------------------
  // Snapshot: start-of-probe item ids + quantities.
  // --------------------------------------------------------------------
  const snapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors.get(actorId);
    return {
      ids: actor.items.contents.map((i) => i.id),
      qty: actor.items.contents.map((i) => ({
        id: i.id,
        qty: typeof i.system?.quantity === 'number' ? i.system.quantity : null,
      })),
    };
  }, ACTOR_ID);
  log.info({ itemCount: snapshot.ids.length }, 'snapshot captured');

  // --------------------------------------------------------------------
  // The single probe run — all scratch items created here, swept in
  // teardown. Returns one findings object per question.
  // --------------------------------------------------------------------
  const result = await page.evaluate(
    async (actorId, containerUuid, weaponUuid, equipmentUuid) => {
      const actor = globalThis.game.actors.get(actorId);
      const out = {};

      // Helpers ---------------------------------------------------------
      const grant = async (uuid, role, overrides) => {
        const src = await fromUuid(uuid);
        const d = src.toObject();
        delete d._id;
        d.name = `__probe_ig ${role}`;
        d._stats = { ...(d._stats ?? {}), compendiumSource: uuid };
        if (overrides) Object.assign(d, overrides);
        const [created] = await actor.createEmbeddedDocuments('Item', [d]);
        return created;
      };
      const containerOf = (item) => {
        const raw = item?.system?.container;
        return typeof raw === 'string' && raw.length > 0 ? raw : null;
      };
      const flat = (obj, prefix, acc) => {
        for (const [k, v] of Object.entries(obj ?? {})) {
          const p = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, p, acc);
          else acc[p] = JSON.stringify(v ?? null);
        }
        return acc;
      };
      const diffPaths = (before, after) => {
        const fb = flat(before, '', {});
        const fa = flat(after, '', {});
        const keys = new Set([...Object.keys(fb), ...Object.keys(fa)]);
        const changed = [];
        for (const k of keys) if (fb[k] !== fa[k]) changed.push(k);
        return changed;
      };

      // Q1 — system.container shape at root -----------------------------
      const w1 = await grant(weaponUuid, 'w1');
      {
        const raw = w1.system?.container;
        out.q1 = {
          rawValue: raw === undefined ? '<undefined>' : raw,
          typeofRaw: typeof raw,
          isNull: raw === null,
          isUndefined: raw === undefined,
          isEmptyString: raw === '',
          hasOwnContainer: Object.prototype.hasOwnProperty.call(w1.system ?? {}, 'container'),
        };
      }

      // Q2 — write path: drift check ------------------------------------
      const c1 = await grant(containerUuid, 'c1');
      {
        const before = w1.toObject();
        await actor.updateEmbeddedDocuments('Item', [
          { _id: w1.id, 'system.container': c1.id },
        ]);
        const after = actor.items.get(w1.id).toObject();
        const changed = diffPaths(before, after).filter(
          (p) => !p.startsWith('_stats'),
        );
        out.q2 = {
          changedPaths: changed,
          containerAfter: containerOf(actor.items.get(w1.id)),
          onlyContainerFieldChanged:
            changed.length === 1 && changed[0] === 'system.container',
        };
      }

      // Q3 — same-destination set is a no-op ----------------------------
      {
        let threw = false;
        let returnLen = -1;
        try {
          const r = await actor.updateEmbeddedDocuments('Item', [
            { _id: w1.id, 'system.container': c1.id },
          ]);
          returnLen = Array.isArray(r) ? r.length : -1;
        } catch (err) {
          threw = true;
          out.q3error = String(err?.message ?? err);
        }
        out.q3 = { threw, returnLen, containerStillC1: containerOf(actor.items.get(w1.id)) === c1.id };
      }

      // Q4 — self-cycle (depth 1) ---------------------------------------
      const a = await grant(containerUuid, 'a');
      {
        let threw = false;
        try {
          await actor.updateEmbeddedDocuments('Item', [
            { _id: a.id, 'system.container': a.id },
          ]);
        } catch (err) {
          threw = true;
          out.q4error = String(err?.message ?? err);
        }
        const persisted = containerOf(actor.items.get(a.id));
        out.q4 = {
          threw,
          persistedValue: persisted,
          selfCycleAccepted: persisted === a.id,
          clampedToNull: persisted === null,
        };
        // reset a back to root for Q5
        await actor.updateEmbeddedDocuments('Item', [{ _id: a.id, 'system.container': null }]);
      }

      // Q5 — depth-2 cycle (A→B then B→A) -------------------------------
      const b = await grant(containerUuid, 'b');
      {
        let threw = false;
        try {
          // B's parent = A
          await actor.updateEmbeddedDocuments('Item', [
            { _id: b.id, 'system.container': a.id },
          ]);
          // A's parent = B  → cycle
          await actor.updateEmbeddedDocuments('Item', [
            { _id: a.id, 'system.container': b.id },
          ]);
        } catch (err) {
          threw = true;
          out.q5error = String(err?.message ?? err);
        }
        const aParent = containerOf(actor.items.get(a.id));
        const bParent = containerOf(actor.items.get(b.id));
        out.q5 = {
          threw,
          aParent,
          bParent,
          depth2CycleAccepted: aParent === b.id && bParent === a.id,
        };
        // break the cycle
        await actor.updateEmbeddedDocuments('Item', [
          { _id: a.id, 'system.container': null },
          { _id: b.id, 'system.container': null },
        ]);
      }

      // Q6 — non-container target (a weapon's id) -----------------------
      const w2 = await grant(weaponUuid, 'w2');
      {
        let threw = false;
        try {
          await actor.updateEmbeddedDocuments('Item', [
            { _id: w2.id, 'system.container': w1.id },
          ]);
        } catch (err) {
          threw = true;
          out.q6error = String(err?.message ?? err);
        }
        const persisted = containerOf(actor.items.get(w2.id));
        out.q6 = {
          threw,
          persistedValue: persisted,
          nonContainerTargetAccepted: persisted === w1.id,
        };
        await actor.updateEmbeddedDocuments('Item', [{ _id: w2.id, 'system.container': null }]);
      }

      // Q7 — moving a populated container -------------------------------
      const parent = await grant(containerUuid, 'parent');
      const child = await grant(weaponUuid, 'child');
      const grandParent = await grant(containerUuid, 'grandparent');
      {
        // child lives in parent
        await actor.updateEmbeddedDocuments('Item', [
          { _id: child.id, 'system.container': parent.id },
        ]);
        const childBefore = containerOf(actor.items.get(child.id));
        // move parent into grandParent
        await actor.updateEmbeddedDocuments('Item', [
          { _id: parent.id, 'system.container': grandParent.id },
        ]);
        const childAfter = containerOf(actor.items.get(child.id));
        out.q7 = {
          childBefore,
          childAfter,
          childRefIntact: childBefore === parent.id && childAfter === parent.id,
          parentMoved: containerOf(actor.items.get(parent.id)) === grandParent.id,
        };
      }

      // Q8 — system.equipped shape --------------------------------------
      const eq = await grant(equipmentUuid, 'eq');
      {
        const rawBefore = eq.system?.equipped;
        let threw = false;
        try {
          await actor.updateEmbeddedDocuments('Item', [
            { _id: eq.id, 'system.equipped': true },
          ]);
        } catch (err) {
          threw = true;
          out.q8error = String(err?.message ?? err);
        }
        const rawAfter = actor.items.get(eq.id).system?.equipped;
        out.q8 = {
          typeofBefore: typeof rawBefore,
          valueBefore: rawBefore ?? null,
          threw,
          typeofAfter: typeof rawAfter,
          valueAfter: rawAfter ?? null,
          isBareBoolean: typeof rawAfter === 'boolean',
        };
      }

      // Q9 — attunement field shapes ------------------------------------
      {
        const item = actor.items.get(eq.id);
        const sys = item.system ?? {};
        const obj = item.toObject();
        out.q9 = {
          hasAttunement: Object.prototype.hasOwnProperty.call(sys, 'attunement'),
          attunementValue: sys.attunement ?? null,
          typeofAttunement: typeof sys.attunement,
          hasAttuned: Object.prototype.hasOwnProperty.call(sys, 'attuned'),
          attunedValue: sys.attuned ?? null,
          typeofAttuned: typeof sys.attuned,
          attunedInToObject: Object.prototype.hasOwnProperty.call(obj.system ?? {}, 'attuned'),
          attunementInToObject: Object.prototype.hasOwnProperty.call(
            obj.system ?? {},
            'attunement',
          ),
        };
      }

      // Q10 — createEmbeddedDocuments {keepId:true} + pre-generated ids --
      {
        const contSrc = await fromUuid(containerUuid);
        const weapSrc = await fromUuid(weaponUuid);
        const rootId = foundry.utils.randomID(16);
        const childAId = foundry.utils.randomID(16);
        const childBId = foundry.utils.randomID(16);
        const mk = (src, _id, container, role) => {
          const d = src.toObject();
          d._id = _id;
          d.name = `__probe_ig kid-${role}`;
          d.system = { ...(d.system ?? {}), container };
          d._stats = { ...(d._stats ?? {}), compendiumSource: src.uuid };
          return d;
        };
        // Deliberately pass children BEFORE the root to test that keepId
        // does not depend on input order.
        const payloads = [
          mk(weapSrc, childAId, rootId, 'a'),
          mk(weapSrc, childBId, rootId, 'b'),
          mk(contSrc, rootId, null, 'root'),
        ];
        let threw = false;
        try {
          await actor.createEmbeddedDocuments('Item', payloads, { keepId: true });
        } catch (err) {
          threw = true;
          out.q10error = String(err?.message ?? err);
        }
        const root = actor.items.get(rootId);
        const ca = actor.items.get(childAId);
        const cb = actor.items.get(childBId);
        out.q10 = {
          threw,
          rootKept: Boolean(root),
          childAKept: Boolean(ca),
          childBKept: Boolean(cb),
          childAParent: containerOf(ca),
          childBParent: containerOf(cb),
          treeShapeCorrect:
            Boolean(root) &&
            containerOf(ca) === rootId &&
            containerOf(cb) === rootId &&
            containerOf(root) === null,
          q10Ids: { rootId, childAId, childBId },
        };
      }

      // Q11 — bulk-delete of a container subtree ------------------------
      {
        const { rootId, childAId, childBId } = out.q10.q10Ids;
        const controlBefore = containerOf(actor.items.get(w1.id)); // unrelated item
        let threw = false;
        try {
          await actor.deleteEmbeddedDocuments('Item', [rootId, childAId, childBId]);
        } catch (err) {
          threw = true;
          out.q11error = String(err?.message ?? err);
        }
        out.q11 = {
          threw,
          allGone:
            !actor.items.get(rootId) &&
            !actor.items.get(childAId) &&
            !actor.items.get(childBId),
          controlUnaffected: containerOf(actor.items.get(w1.id)) === controlBefore,
        };
      }

      // Q12 — _stats.compendiumSource survives toObject() → create ------
      {
        const item = actor.items.get(w1.id);
        const payloadSource = item.toObject()?._stats?.compendiumSource ?? null;
        const copy = item.toObject();
        delete copy._id;
        copy.name = '__probe_ig q12copy';
        const [created] = await actor.createEmbeddedDocuments('Item', [copy]);
        out.q12 = {
          sourceItemHasCompendiumSource: typeof payloadSource === 'string',
          payloadCompendiumSource: payloadSource,
          createdCompendiumSource: created._stats?.compendiumSource ?? null,
          survivesRoundTrip:
            typeof created._stats?.compendiumSource === 'string' &&
            created._stats.compendiumSource === payloadSource,
        };
      }

      return out;
    },
    ACTOR_ID,
    CONTAINER_UUID,
    WEAPON_UUID,
    EQUIPMENT_UUID,
  );

  record('1', result.q1);
  record('2', result.q2);
  record('3', result.q3);
  record('4', result.q4);
  record('5', result.q5);
  record('6', result.q6);
  record('7', result.q7);
  record('8', result.q8);
  record('9', result.q9);
  record('10', result.q10);
  record('11', result.q11);
  record('12', result.q12);

  // Sanity assertions — surface anything that contradicts the plan.
  assert(result.q1.isNull || result.q1.isUndefined, 'Q1: root container is null/absent', result.q1);
  assert(result.q2.onlyContainerFieldChanged, 'Q2: only system.container drifts on a move', result.q2);
  assert(result.q3.threw === false, 'Q3: same-destination set does not throw', result.q3);
  assert(result.q7.childRefIntact, 'Q7: children survive a populated-container move', result.q7);
  assert(result.q8.isBareBoolean, 'Q8: system.equipped is a bare boolean', result.q8);
  assert(result.q10.treeShapeCorrect, 'Q10: keepId preserves the subtree shape', result.q10);
  assert(result.q10.threw === false, 'Q10: keepId create did not throw', result.q10);
  assert(result.q11.allGone && !result.q11.threw, 'Q11: bulk-delete clears the subtree', result.q11);
  assert(result.q12.survivesRoundTrip, 'Q12: compendiumSource survives toObject→create', result.q12);

  // --------------------------------------------------------------------
  // Teardown: delete every item not in the start snapshot.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snap) => {
      const actor = globalThis.game.actors.get(actorId);
      const snapIds = new Set(snap.ids);
      const orphanIds = actor.items.contents.filter((i) => !snapIds.has(i.id)).map((i) => i.id);
      const deleteFailures = [];
      for (const id of orphanIds) {
        const existing = actor.items.get(id);
        if (!existing) continue;
        try {
          await existing.delete();
        } catch (err) {
          deleteFailures.push(`${id}:${err?.message ?? String(err)}`);
        }
      }
      // restore drifted quantities
      const qtyMap = new Map(snap.qty.map((q) => [q.id, q.qty]));
      const updates = [];
      for (const item of actor.items.contents) {
        const expected = qtyMap.get(item.id);
        if (expected == null) continue;
        const current = typeof item.system?.quantity === 'number' ? item.system.quantity : null;
        if (current !== expected) updates.push({ _id: item.id, 'system.quantity': expected });
      }
      if (updates.length > 0) await actor.updateEmbeddedDocuments('Item', updates);
      const finalIds = new Set(actor.items.contents.map((i) => i.id));
      const extra = [...finalIds].filter((id) => !snapIds.has(id));
      const missing = [...snapIds].filter((id) => !finalIds.has(id));
      return { deleteFailures, restored: updates.length, extra, missing };
    },
    ACTOR_ID,
    snapshot,
  );
  log.info({ teardown }, 'teardown complete');
  assert(teardown.deleteFailures.length === 0, 'teardown: no orphan delete failures', teardown);
  assert(
    teardown.extra.length === 0 && teardown.missing.length === 0,
    'teardown: item-id set restored to snapshot',
    teardown,
  );

  log.info({ findings }, 'PHASE-1 FINDINGS');
  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all phase-1 assertions passed');
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
