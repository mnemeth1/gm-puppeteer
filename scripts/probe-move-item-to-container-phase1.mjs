/**
 * Phase 1 design-blocking probes for move_item_to_container. Run BEFORE
 * any tool code is written; the spec hangs on the answers. Each probe
 * mutates state, snapshots the affected scope, then restores exactly
 * (multiset signature: name|type|qty|containerId).
 *
 * Targets sandbox world. Test Valeros (wcD2h1fQmIxIab4B) + canonical
 * Backpack (T0wPTa6cZ5cGjmSL). Scratch containers/items are created and
 * destroyed in-probe.
 *
 * Findings expected:
 *   1. containerId field shape at root (null vs "" vs absent).
 *   2. Field path for the move (system.containerId on its own, or
 *      additional fields needed in parallel).
 *   3. Same-destination no-op (does updateEmbeddedDocuments throw or
 *      silently no-op).
 *   4. Cross-container "merge": does Foundry auto-merge two stacks when
 *      their containerId aligns?
 *   5. Container with contents: do contents stay inside (referenced by
 *      containerId pointer) when their parent container moves?
 *   6. Cycle detection (3 sub-probes 6a, 6b, 6c).
 *   7. Containers must be containers — does Foundry reject targeting a
 *      non-container item id, or accept and corrupt?
 *   8. Non-physical item: Foundry behavior when setting containerId on
 *      a feat (informs whether MOVE_ON_NON_PHYSICAL is safety-net or
 *      strictly necessary).
 *
 *   npm run build && node scripts/probe-move-item-to-container-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const ARROWS_UUID = 'Compendium.pf2e.equipment-srd.Item.w2ENw2VMPcsbif8g';
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';
const BACKPACK_UUID = 'Compendium.pf2e.equipment-srd.Item.3lgwjrFEsQVKzhh7';

const findings = [];
const errors = [];

function record(probeId, label, value) {
  findings.push({ probeId, label, value });
  log.info({ probeId, label, value }, 'finding');
}

function fail(probeId, label, ctx) {
  errors.push({ probeId, label, ctx });
  log.error({ probeId, label, ctx }, 'PROBE FAILURE');
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub: remove __probe_p1_* leftovers from any earlier run.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    const orphans = actor.items.contents
      .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe_p1'))
      .map((i) => i.id);
    if (orphans.length > 0) {
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
  // Snapshot full toObject() payloads — Phase 1 mutates aggressively.
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
  log.info({ itemCount: startSnapshot.itemCount }, 'snapshot captured');

  // ====================================================================
  // Phase 1 / Q1: containerId shape at root.
  //
  // Pull a top-level item from canonical actor state. Check whether
  // system.containerId is null, "", or undefined/absent.
  // ====================================================================
  {
    const probe = await page.evaluate((actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const topLevel = actor.items.contents.find(
        (i) =>
          (i.system?.containerId === null ||
            i.system?.containerId === undefined ||
            i.system?.containerId === '') &&
          i.type !== 'feat' &&
          i.type !== 'spell' &&
          i.type !== 'class',
      );
      if (!topLevel) return { error: 'no top-level item found' };
      const sys = topLevel.system ?? {};
      return {
        sampleName: topLevel.name,
        sampleType: topLevel.type,
        rawValue: sys.containerId,
        rawType: typeof sys.containerId,
        isNull: sys.containerId === null,
        isUndefined: sys.containerId === undefined,
        isEmptyString: sys.containerId === '',
        hasOwnContainerId: Object.prototype.hasOwnProperty.call(sys, 'containerId'),
      };
    }, PROBE_ACTOR_ID);
    record('Q1', 'containerId shape at root for top-level item', probe);
  }

  // ====================================================================
  // Phase 1 / Q2 + Q3: field path + same-destination no-op.
  //
  // Take the canonical Arrows (top-level), call
  // updateEmbeddedDocuments setting system.containerId to its current
  // value (null). Confirm: empty array result, no throw, no field drift.
  // Also captures pre/post `toObject()` for diff inspection — anything
  // mutated besides the field we set is significant for the spec.
  // ====================================================================
  {
    const probe = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      // Pick a stable top-level item: Arrows (qty 20).
      const arrows = actor.items.contents.find((i) => (i.name ?? '') === 'Arrows');
      if (!arrows) return { error: 'arrows not found' };
      const before = arrows.toObject();
      let result;
      let threw = null;
      try {
        result = await actor.updateEmbeddedDocuments('Item', [
          { _id: arrows.id, 'system.containerId': arrows.system?.containerId ?? null },
        ]);
      } catch (err) {
        threw = err?.message ?? String(err);
      }
      const refetched = actor.items.get(arrows.id);
      const after = refetched?.toObject();
      // Diff fields between before and after at the system level (shallow).
      const diff = [];
      const keys = new Set([
        ...Object.keys(before.system ?? {}),
        ...Object.keys(after?.system ?? {}),
      ]);
      for (const k of keys) {
        const b = JSON.stringify(before.system?.[k] ?? null);
        const a = JSON.stringify(after?.system?.[k] ?? null);
        if (b !== a) diff.push({ key: k, before: b, after: a });
      }
      return {
        threw,
        resultLength: Array.isArray(result) ? result.length : null,
        resultIsArray: Array.isArray(result),
        diffCount: diff.length,
        diffSample: diff.slice(0, 5),
        beforeContainerId: before.system?.containerId ?? null,
        afterContainerId: after?.system?.containerId ?? null,
      };
    }, PROBE_ACTOR_ID);
    record('Q2_Q3', 'updateEmbeddedDocuments same-destination no-op + field-path purity', probe);
    if (probe?.threw) fail('Q2_Q3', 'unexpectedly threw', probe);
    if (probe?.diffCount && probe.diffCount > 0) {
      // Surfacing for inspection; not necessarily a failure — it answers
      // "what fields move with a containerId update".
      log.warn({ diff: probe.diffSample }, 'fields drifted on no-op set');
    }
  }

  // ====================================================================
  // Phase 1 / Q4: cross-container "merge" behavior.
  //
  // Setup: two scratch containers; create __probe_p1_arrows_a in
  // container A (qty 5), __probe_p1_arrows_b in container B (qty 3) —
  // both from the same compendium source, both identified. Move
  // __probe_p1_arrows_b's containerId to match A's containerId. Foundry
  // is expected NOT to auto-merge them (matching add_item_to_actor
  // finding); confirm with both stacks surviving as separate entries.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, backpackUuid, arrowsUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const bp = await fromUuid(backpackUuid);
        const arrows = await fromUuid(arrowsUuid);
        const containerA = (
          await actor.createEmbeddedDocuments('Item', [
            { ...bp.toObject(), name: '__probe_p1_containerA' },
          ])
        )[0];
        const containerB = (
          await actor.createEmbeddedDocuments('Item', [
            { ...bp.toObject(), name: '__probe_p1_containerB' },
          ])
        )[0];
        const stackA = (
          await actor.createEmbeddedDocuments('Item', [
            {
              ...arrows.toObject(),
              name: '__probe_p1_arrows_a',
              system: { ...arrows.toObject().system, quantity: 5, containerId: containerA.id },
            },
          ])
        )[0];
        const stackB = (
          await actor.createEmbeddedDocuments('Item', [
            {
              ...arrows.toObject(),
              name: '__probe_p1_arrows_b',
              system: { ...arrows.toObject().system, quantity: 3, containerId: containerB.id },
            },
          ])
        )[0];
        // Move stackB into containerA. Both have the same compendiumSource,
        // both identified, soon to share containerId. Foundry MAY auto-merge.
        await actor.updateEmbeddedDocuments('Item', [
          { _id: stackB.id, 'system.containerId': containerA.id },
        ]);
        const aLive = actor.items.get(stackA.id);
        const bLive = actor.items.get(stackB.id);
        const out = {
          aSurvived: !!aLive,
          bSurvived: !!bLive,
          aQty: aLive?.system?.quantity ?? null,
          bQty: bLive?.system?.quantity ?? null,
          aContainerId: aLive?.system?.containerId ?? null,
          bContainerId: bLive?.system?.containerId ?? null,
        };
        // Cleanup scratch state.
        const ids = [stackA.id, stackB.id, containerA.id, containerB.id].filter((id) =>
          actor.items.get(id),
        );
        if (ids.length > 0) {
          await actor.deleteEmbeddedDocuments('Item', ids);
        }
        return out;
      },
      PROBE_ACTOR_ID,
      BACKPACK_UUID,
      ARROWS_UUID,
    );
    record('Q4', 'cross-container "merge" via containerId update', probe);
  }

  // ====================================================================
  // Phase 1 / Q5: container with contents — moving the parent.
  //
  // Setup: scratch backpack B with one __probe_p1_inner_potion inside.
  // Move B itself into the canonical Backpack. Confirm: inner item's
  // containerId still points to B (not promoted to root, not orphaned),
  // and B's containerId now points to the canonical backpack.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, backpackUuid, potionUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const bp = await fromUuid(backpackUuid);
        const potion = await fromUuid(potionUuid);
        const canonical = actor.items.contents.find((i) => i.type === 'backpack');
        if (!canonical) return { error: 'no canonical backpack found' };
        const scratchBp = (
          await actor.createEmbeddedDocuments('Item', [
            { ...bp.toObject(), name: '__probe_p1_scratchBp' },
          ])
        )[0];
        const inner = (
          await actor.createEmbeddedDocuments('Item', [
            {
              ...potion.toObject(),
              name: '__probe_p1_inner_potion',
              system: { ...potion.toObject().system, quantity: 1, containerId: scratchBp.id },
            },
          ])
        )[0];
        // Move scratchBp into the canonical backpack.
        await actor.updateEmbeddedDocuments('Item', [
          { _id: scratchBp.id, 'system.containerId': canonical.id },
        ]);
        const scratchLive = actor.items.get(scratchBp.id);
        const innerLive = actor.items.get(inner.id);
        const out = {
          scratchBpContainerId: scratchLive?.system?.containerId ?? null,
          scratchBpEqualsCanonical: (scratchLive?.system?.containerId ?? null) === canonical.id,
          innerContainerIdStillScratch: (innerLive?.system?.containerId ?? null) === scratchBp.id,
          innerContainerIdNow: innerLive?.system?.containerId ?? null,
        };
        // Cleanup.
        const ids = [inner.id, scratchBp.id].filter((id) => actor.items.get(id));
        if (ids.length > 0) await actor.deleteEmbeddedDocuments('Item', ids);
        return out;
      },
      PROBE_ACTOR_ID,
      BACKPACK_UUID,
      HEALING_POTION_UUID,
    );
    record('Q5', 'container with contents — moving the parent', probe);
  }

  // ====================================================================
  // Phase 1 / Q6: cycle detection.
  //
  // 6a: container -> self
  // 6b: parent -> child (A contains B; set A.containerId = B.id)
  // 6c: deeper (A -> B -> C; set A.containerId = C.id)
  //
  // For each: did the update throw? did Foundry write the value? after,
  // is the actor in a corrupt state (the inventory aggregator throws,
  // or items.contents iteration breaks)?
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, backpackUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const bp = await fromUuid(backpackUuid);

        const make = async (name) => {
          return (await actor.createEmbeddedDocuments('Item', [{ ...bp.toObject(), name }]))[0];
        };

        const reportInventoryHealth = () => {
          let coinsErr = null;
          try {
            const _ = actor.inventory?.coins;
            void _;
          } catch (e) {
            coinsErr = e?.message ?? String(e);
          }
          let iterErr = null;
          let iterCount = 0;
          try {
            actor.items.contents.forEach(() => {
              iterCount += 1;
            });
          } catch (e) {
            iterErr = e?.message ?? String(e);
          }
          return { coinsErr, iterErr, iterCount };
        };

        const out = {};

        // 6a: A.containerId = A.id (self-cycle).
        {
          const a = await make('__probe_p1_cyc_a_self');
          let threw = null;
          try {
            await actor.updateEmbeddedDocuments('Item', [
              { _id: a.id, 'system.containerId': a.id },
            ]);
          } catch (e) {
            threw = e?.message ?? String(e);
          }
          const live = actor.items.get(a.id);
          out.cyc6a = {
            threw,
            persisted: live?.system?.containerId ?? null,
            equalsSelf: (live?.system?.containerId ?? null) === a.id,
            inventoryHealth: reportInventoryHealth(),
          };
          // Repair: clear containerId so cleanup deletion doesn't trip.
          if (live) {
            try {
              await actor.updateEmbeddedDocuments('Item', [
                { _id: a.id, 'system.containerId': null },
              ]);
            } catch {
              /* ignore */
            }
          }
          if (actor.items.get(a.id)) await actor.deleteEmbeddedDocuments('Item', [a.id]);
        }

        // 6b: A contains B; try to set A.containerId = B.id (parent into
        // its own child).
        {
          const a = await make('__probe_p1_cyc_b_parent');
          const bi = await make('__probe_p1_cyc_b_child');
          await actor.updateEmbeddedDocuments('Item', [{ _id: bi.id, 'system.containerId': a.id }]);
          let threw = null;
          try {
            await actor.updateEmbeddedDocuments('Item', [
              { _id: a.id, 'system.containerId': bi.id },
            ]);
          } catch (e) {
            threw = e?.message ?? String(e);
          }
          const aLive = actor.items.get(a.id);
          const bLive = actor.items.get(bi.id);
          out.cyc6b = {
            threw,
            aPersisted: aLive?.system?.containerId ?? null,
            bPersisted: bLive?.system?.containerId ?? null,
            inventoryHealth: reportInventoryHealth(),
          };
          // Repair before delete.
          for (const id of [a.id, bi.id]) {
            const live = actor.items.get(id);
            if (live)
              await actor
                .updateEmbeddedDocuments('Item', [{ _id: id, 'system.containerId': null }])
                .catch(() => undefined);
          }
          await actor
            .deleteEmbeddedDocuments(
              'Item',
              [a.id, bi.id].filter((id) => actor.items.get(id)),
            )
            .catch(() => undefined);
        }

        // 6c: A -> B -> C, set A.containerId = C.id.
        {
          const a = await make('__probe_p1_cyc_c_a');
          const bi = await make('__probe_p1_cyc_c_b');
          const c = await make('__probe_p1_cyc_c_c');
          await actor.updateEmbeddedDocuments('Item', [
            { _id: bi.id, 'system.containerId': a.id },
            { _id: c.id, 'system.containerId': bi.id },
          ]);
          let threw = null;
          try {
            await actor.updateEmbeddedDocuments('Item', [
              { _id: a.id, 'system.containerId': c.id },
            ]);
          } catch (e) {
            threw = e?.message ?? String(e);
          }
          const aLive = actor.items.get(a.id);
          const bLive = actor.items.get(bi.id);
          const cLive = actor.items.get(c.id);
          out.cyc6c = {
            threw,
            aPersisted: aLive?.system?.containerId ?? null,
            bPersisted: bLive?.system?.containerId ?? null,
            cPersisted: cLive?.system?.containerId ?? null,
            inventoryHealth: reportInventoryHealth(),
          };
          // Repair.
          for (const id of [a.id, bi.id, c.id]) {
            const live = actor.items.get(id);
            if (live)
              await actor
                .updateEmbeddedDocuments('Item', [{ _id: id, 'system.containerId': null }])
                .catch(() => undefined);
          }
          await actor
            .deleteEmbeddedDocuments(
              'Item',
              [a.id, bi.id, c.id].filter((id) => actor.items.get(id)),
            )
            .catch(() => undefined);
        }

        return out;
      },
      PROBE_ACTOR_ID,
      BACKPACK_UUID,
    );
    record('Q6', 'cycle detection (self / parent-into-child / deeper)', probe);
  }

  // ====================================================================
  // Phase 1 / Q7: containers must be containers.
  //
  // Set containerId to the id of a non-container physical item (a
  // weapon). Does Foundry reject? Or accept (and corrupt)?
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, longswordUuid, potionUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const ls = await fromUuid(longswordUuid);
        const potion = await fromUuid(potionUuid);
        const sword = (
          await actor.createEmbeddedDocuments('Item', [
            { ...ls.toObject(), name: '__probe_p1_sword_target' },
          ])
        )[0];
        const movee = (
          await actor.createEmbeddedDocuments('Item', [
            { ...potion.toObject(), name: '__probe_p1_potion_movee' },
          ])
        )[0];
        let threw = null;
        try {
          await actor.updateEmbeddedDocuments('Item', [
            { _id: movee.id, 'system.containerId': sword.id },
          ]);
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const moveeLive = actor.items.get(movee.id);
        const out = {
          threw,
          moveePersistedContainerId: moveeLive?.system?.containerId ?? null,
          equalsSwordId: (moveeLive?.system?.containerId ?? null) === sword.id,
        };
        // Cleanup.
        for (const id of [movee.id, sword.id]) {
          const live = actor.items.get(id);
          if (live)
            await actor
              .updateEmbeddedDocuments('Item', [{ _id: id, 'system.containerId': null }])
              .catch(() => undefined);
        }
        await actor
          .deleteEmbeddedDocuments(
            'Item',
            [movee.id, sword.id].filter((id) => actor.items.get(id)),
          )
          .catch(() => undefined);
        return out;
      },
      PROBE_ACTOR_ID,
      LONGSWORD_UUID,
      HEALING_POTION_UUID,
    );
    record('Q7', 'containers must be containers (target=weapon)', probe);
  }

  // ====================================================================
  // Phase 1 / Q8: non-physical item containerId behavior.
  //
  // Create a synthetic feat (rules-free, no GrantItem cascade), call
  // updateEmbeddedDocuments setting system.containerId to a real
  // backpack id. Does Foundry coerce, accept, or silently drop?
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, backpackUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const bp = await fromUuid(backpackUuid);
        const scratchBp = (
          await actor.createEmbeddedDocuments('Item', [
            { ...bp.toObject(), name: '__probe_p1_q8_bp' },
          ])
        )[0];
        const feat = (
          await actor.createEmbeddedDocuments('Item', [
            {
              name: '__probe_p1_q8_feat',
              type: 'feat',
              system: { description: { value: '' } },
            },
          ])
        )[0];
        let threw = null;
        try {
          await actor.updateEmbeddedDocuments('Item', [
            { _id: feat.id, 'system.containerId': scratchBp.id },
          ]);
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const featLive = actor.items.get(feat.id);
        const featSys = featLive?.system ?? {};
        const out = {
          threw,
          featContainerIdPersisted: featSys.containerId ?? null,
          featHasContainerIdField: Object.prototype.hasOwnProperty.call(featSys, 'containerId'),
          featTypeUnchanged: featLive?.type === 'feat',
        };
        // Cleanup.
        await actor
          .deleteEmbeddedDocuments(
            'Item',
            [feat.id, scratchBp.id].filter((id) => actor.items.get(id)),
          )
          .catch(() => undefined);
        return out;
      },
      PROBE_ACTOR_ID,
      BACKPACK_UUID,
    );
    record('Q8', 'non-physical item containerId behavior (feat)', probe);
  }

  // --------------------------------------------------------------------
  // Teardown — restore actor to start-of-probe snapshot signature.
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
        // Repair containerId to null first to neutralize any cycles.
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
        if ((liveSig.get(k) ?? 0) !== n)
          missing.push({ k, expected: n, actual: liveSig.get(k) ?? 0 });
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
    fail('teardown', 'multiset signature mismatch', teardown);
  }

  // --------------------------------------------------------------------
  // Final report.
  // --------------------------------------------------------------------
  log.info({ findings, errors, errorCount: errors.length }, 'PHASE 1 SUMMARY');
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'phase 1 probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
