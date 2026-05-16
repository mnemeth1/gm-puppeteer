/**
 * Phase 1 design-blocking probes for use_item. Run BEFORE any tool code
 * is written; the spec hangs on the answers.
 *
 * Each probe mutates state, then restores it via a full-payload
 * signature-multiset teardown (name|type|qty|containerId). Temp items
 * are tagged with names beginning `__probe_use_item_` so a pre-probe
 * scrub catches leftovers from failed runs.
 *
 * Targets sandbox world. Test Valeros (wcD2h1fQmIxIab4B) is a fighter
 * with no spellcasting entry — Q6 (embedded-spell cast) exercises the
 * no-caster path on purpose; the happy-path caster behavior is left to
 * the v1 behavioral probe with a synthetic spellcasting entry if
 * needed.
 *
 * Findings the probe must answer (drives tool-code branching):
 *
 *   Q1.  Does `item.consume` exist on a ConsumablePF2e instance in
 *        v14.361 + PF2e 8.1.2? typeof returns what?
 *   Q2.  Return shape of `await item.consume(1)` — ChatMessage doc,
 *        undefined, an object?
 *   Q3.  Decrement target: stack with uses.max === 1 (potion) — does
 *        consume decrement quantity? Stack with uses.max > 1 (wand)
 *        — does it decrement uses.value?
 *   Q4.  autoDestroy delete: 1-qty consumable + autoDestroy:true,
 *        consume → item id gone from actor.items.
 *   Q5.  Chat message production: does game.messages.size grow by 1?
 *        Can we recover the latest message id?
 *   Q6.  Embedded-spell cast: consume a Scroll on a non-caster — does
 *        consume throw, return early, or attempt Trick Magic Item?
 *   Q7.  Equipment activation: equipment-type item with system.uses
 *        or system.frequency — does it expose consume/use/toMessage?
 *        What ItemPF2e methods exist as generic activation entrypoints?
 *   Q8.  Zero-charge guard: consume an item with uses.value === 0 or
 *        quantity === 0 — throw, no-op, or post a UI notification?
 *   Q9.  Non-consumable rejection: typeof consume on a weapon. Confirm
 *        absent (drives the ITEM_TYPE_UNSUPPORTED branch).
 *
 *   npm run build && node scripts/probe-use-item-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const HEALING_POTION_UUID = 'Compendium.pf2e.equipment-srd.Item.2RuepCemJhrpKKao';
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';

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
  // Pre-probe scrub: remove __probe_use_item_* leftovers from any prior
  // run. The teardown signature-multiset check will surface any
  // leftover state otherwise.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    const orphans = actor.items.contents
      .filter((i) => typeof i.name === 'string' && i.name.startsWith('__probe_use_item_'))
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
  // Snapshot full toObject() payloads — Phase 1 mutates aggressively,
  // including autoDestroy paths that delete items entirely.
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

  // --------------------------------------------------------------------
  // Discovery: sample compendium UUIDs the probe needs.
  //  - scroll-bearing consumable (any rank-1 spell scroll).
  //  - wand-bearing consumable (any rank-1 wand).
  //  - equipment item with uses or frequency (for Q7).
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(async () => {
    const pack = globalThis.game.packs?.get('pf2e.equipment-srd');
    if (!pack) return { error: 'equipment-srd not found' };
    const idx = await pack.getIndex({ fields: ['type', 'system.category'] });
    const entries = idx.contents ?? [];
    // Scrolls: type=consumable, system.category=scroll.
    const scrollEntry = entries.find(
      (e) => e.type === 'consumable' && e.system?.category === 'scroll',
    );
    // Wands: type=consumable, system.category=wand.
    const wandEntry = entries.find((e) => e.type === 'consumable' && e.system?.category === 'wand');
    // Equipment-with-uses: type=equipment. We probe the full doc for
    // each candidate to find one with system.uses.max > 0 or
    // system.frequency.max > 0. Scan up to first 40 to bound time.
    const equipmentCandidates = entries.filter((e) => e.type === 'equipment').slice(0, 40);
    let equipmentWithUses = null;
    for (const cand of equipmentCandidates) {
      const doc = await pack.getDocument(cand._id);
      const sys = doc?.system ?? {};
      const usesMax =
        typeof sys.uses?.max === 'number'
          ? sys.uses.max
          : Number.parseInt(String(sys.uses?.max ?? ''), 10);
      const freqMax =
        typeof sys.frequency?.max === 'number'
          ? sys.frequency.max
          : Number.parseInt(String(sys.frequency?.max ?? ''), 10);
      if ((Number.isFinite(usesMax) && usesMax > 0) || (Number.isFinite(freqMax) && freqMax > 0)) {
        equipmentWithUses = {
          uuid: doc.uuid,
          name: doc.name,
          usesMax: Number.isFinite(usesMax) ? usesMax : null,
          frequencyMax: Number.isFinite(freqMax) ? freqMax : null,
        };
        break;
      }
    }
    return {
      scrollUuid: scrollEntry ? `Compendium.pf2e.equipment-srd.Item.${scrollEntry._id}` : null,
      scrollName: scrollEntry?.name ?? null,
      wandUuid: wandEntry ? `Compendium.pf2e.equipment-srd.Item.${wandEntry._id}` : null,
      wandName: wandEntry?.name ?? null,
      equipmentWithUses,
      equipmentScanned: equipmentCandidates.length,
    };
  });
  log.info({ discovery }, 'discovery: probe target UUIDs');
  record('discovery', 'sampled compendium targets', discovery);

  // ====================================================================
  // Q1: typeof item.consume on a real consumable instance.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, potionUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(potionUuid);
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...src.toObject(),
            name: '__probe_use_item_q1_potion',
            system: { ...src.toObject().system, quantity: 2 },
          },
        ]);
        const item = created[0];
        const out = {
          itemType: item.type,
          subtype: item.system?.category ?? null,
          typeofConsume: typeof item.consume,
          consumeIsAsync:
            typeof item.consume === 'function' &&
            item.consume.constructor?.name === 'AsyncFunction',
          // What methods exist on the item? Filter to candidates.
          relevantMethods: [
            'consume',
            'use',
            'toMessage',
            'toChat',
            'castEmbeddedSpell',
            'activate',
          ].map((m) => ({ method: m, type: typeof item[m] })),
        };
        // Cleanup.
        await actor.deleteEmbeddedDocuments('Item', [item.id]);
        return out;
      },
      PROBE_ACTOR_ID,
      HEALING_POTION_UUID,
    );
    record('Q1', 'typeof item.consume + relevant methods on a consumable', probe);
    if (probe.typeofConsume !== 'function') {
      fail('Q1', 'item.consume is not a function on a ConsumablePF2e', probe);
    }
  }

  // ====================================================================
  // Q2 + Q3 (potion) + Q5: return shape, decrement target (multi-qty
  // stack, uses.max === 1), chat message production.
  //
  // Use a 2-qty potion; consume(1) should decrement quantity from 2→1
  // (uses.max === 1 for potions, so the quantity path is the right
  // target). Capture game.messages.size before/after to detect chat.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, potionUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(potionUuid);
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...src.toObject(),
            name: '__probe_use_item_q2_potion',
            system: { ...src.toObject().system, quantity: 2 },
          },
        ]);
        const item = created[0];
        const before = {
          quantity: item.system?.quantity ?? null,
          usesValue: item.system?.uses?.value ?? null,
          usesMax: item.system?.uses?.max ?? null,
          autoDestroy: item.system?.uses?.autoDestroy ?? null,
        };
        const msgCountBefore = globalThis.game.messages?.size ?? 0;
        let returnValue = null;
        let returnType = 'undefined';
        let returnConstructor = null;
        let threw = null;
        try {
          const r = await item.consume(1);
          returnType = typeof r;
          if (r != null) {
            returnConstructor = r.constructor?.name ?? null;
            // Probe a few likely shapes without depending on which we get.
            returnValue = {
              hasId: typeof r.id === 'string',
              id: typeof r.id === 'string' ? r.id : null,
              hasContent: typeof r.content === 'string',
            };
          }
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const msgCountAfter = globalThis.game.messages?.size ?? 0;
        const liveAfter = actor.items.get(item.id);
        const after = liveAfter
          ? {
              quantity: liveAfter.system?.quantity ?? null,
              usesValue: liveAfter.system?.uses?.value ?? null,
              survived: true,
            }
          : { survived: false };
        // Capture the latest message's id for the audit-trail design.
        const allMessages = Array.from(globalThis.game.messages?.values?.() ?? []);
        const latest = allMessages[allMessages.length - 1];
        const latestMessage = latest
          ? {
              id: latest.id,
              speaker: latest.speaker?.actor ?? null,
              flavor: typeof latest.flavor === 'string' ? latest.flavor.slice(0, 80) : null,
            }
          : null;
        // Cleanup: delete the temp item if it survived.
        if (liveAfter) {
          await actor.deleteEmbeddedDocuments('Item', [item.id]);
        }
        return {
          before,
          after,
          msgCountBefore,
          msgCountAfter,
          msgDelta: msgCountAfter - msgCountBefore,
          threw,
          returnType,
          returnConstructor,
          returnValue,
          latestMessage,
        };
      },
      PROBE_ACTOR_ID,
      HEALING_POTION_UUID,
    );
    record(
      'Q2_Q3_Q5',
      'consume(1) on potion qty=2: return shape, quantity decrement, chat msg',
      probe,
    );
    if (probe.threw) fail('Q2_Q3_Q5', 'consume threw', probe);
    if (probe.after?.quantity !== 1) {
      fail('Q2_Q3_Q5', 'quantity did not decrement 2→1 as expected', probe);
    }
  }

  // ====================================================================
  // Q3 (wand): decrement target on uses.max > 1.
  //
  // Wand items have system.uses.max > 1 — consume should decrement
  // uses.value, not quantity. (Standard PF2e wand: 1 charge per day; v1
  // probe just confirms uses-based decrement happens.)
  // ====================================================================
  if (discovery?.wandUuid) {
    const probe = await page.evaluate(
      async (actorId, wandUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(wandUuid);
        const data = src.toObject();
        // Ensure uses.value starts at uses.max so we can observe a
        // decrement, regardless of source defaults.
        const usesMax = data.system?.uses?.max ?? 1;
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name: '__probe_use_item_q3_wand',
            system: {
              ...data.system,
              quantity: 1,
              uses: { ...(data.system?.uses ?? {}), value: usesMax, max: usesMax },
            },
          },
        ]);
        const item = created[0];
        const before = {
          quantity: item.system?.quantity ?? null,
          usesValue: item.system?.uses?.value ?? null,
          usesMax: item.system?.uses?.max ?? null,
          autoDestroy: item.system?.uses?.autoDestroy ?? null,
          category: item.system?.category ?? null,
        };
        let threw = null;
        try {
          await item.consume(1);
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const liveAfter = actor.items.get(item.id);
        const after = liveAfter
          ? {
              survived: true,
              quantity: liveAfter.system?.quantity ?? null,
              usesValue: liveAfter.system?.uses?.value ?? null,
            }
          : { survived: false };
        if (liveAfter) await actor.deleteEmbeddedDocuments('Item', [item.id]);
        return { before, after, threw };
      },
      PROBE_ACTOR_ID,
      discovery.wandUuid,
    );
    record('Q3_wand', 'consume(1) on wand: uses.value decrement', probe);
    if (probe.threw) fail('Q3_wand', 'consume threw', probe);
  } else {
    record('Q3_wand', 'SKIPPED: no wand UUID discovered in equipment-srd', null);
  }

  // ====================================================================
  // Q4: autoDestroy delete on last consumable. Temp potion qty=1,
  // autoDestroy:true (the consumable default). consume(1) should delete.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, potionUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(potionUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name: '__probe_use_item_q4_lastpotion',
            system: {
              ...data.system,
              quantity: 1,
              uses: { ...(data.system?.uses ?? {}), autoDestroy: true },
            },
          },
        ]);
        const item = created[0];
        const tempId = item.id;
        const msgCountBefore = globalThis.game.messages?.size ?? 0;
        let threw = null;
        try {
          await item.consume(1);
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const msgCountAfter = globalThis.game.messages?.size ?? 0;
        const liveAfter = actor.items.get(tempId);
        // Cleanup if somehow still alive.
        if (liveAfter) await actor.deleteEmbeddedDocuments('Item', [tempId]);
        return {
          deletedById: !liveAfter,
          msgDelta: msgCountAfter - msgCountBefore,
          threw,
        };
      },
      PROBE_ACTOR_ID,
      HEALING_POTION_UUID,
    );
    record('Q4', 'autoDestroy on last consumable: item deleted', probe);
    if (probe.threw) fail('Q4', 'consume threw on last-charge', probe);
    if (!probe.deletedById) {
      fail('Q4', 'expected autoDestroy to delete the item but it survived', probe);
    }
  }

  // ====================================================================
  // Q6: embedded-spell cast on a non-caster (Test Valeros).
  //
  // Create a temp scroll, consume it. Test Valeros has no spellcasting
  // entry, so this exercises the no-caster path. Capture: does consume
  // throw, return undefined, post a UI notification, or attempt Trick
  // Magic Item?
  // ====================================================================
  if (discovery?.scrollUuid) {
    const probe = await page.evaluate(
      async (actorId, scrollUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(scrollUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name: '__probe_use_item_q6_scroll',
            system: { ...data.system, quantity: 1 },
          },
        ]);
        const item = created[0];
        const tempId = item.id;
        const msgCountBefore = globalThis.game.messages?.size ?? 0;
        const before = {
          quantity: item.system?.quantity ?? null,
          category: item.system?.category ?? null,
          hasEmbeddedSpell: item.system?.spell != null,
          embeddedSpellName: item.system?.spell?.name ?? null,
        };
        let threw = null;
        let returnType = 'undefined';
        try {
          const r = await item.consume(1);
          returnType = typeof r;
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const msgCountAfter = globalThis.game.messages?.size ?? 0;
        const liveAfter = actor.items.get(tempId);
        const after = liveAfter
          ? {
              survived: true,
              quantity: liveAfter.system?.quantity ?? null,
            }
          : { survived: false };
        // Inspect latest message for clues (was a spell card posted?
        // a "no caster" notification ends up as a UI toast, not a chat
        // message — so msgDelta === 0 is meaningful).
        const allMessages = Array.from(globalThis.game.messages?.values?.() ?? []);
        const latest = allMessages[allMessages.length - 1];
        const latestSnippet = latest
          ? typeof latest.content === 'string'
            ? latest.content.slice(0, 200)
            : null
          : null;
        if (liveAfter) await actor.deleteEmbeddedDocuments('Item', [tempId]);
        return {
          before,
          after,
          threw,
          returnType,
          msgDelta: msgCountAfter - msgCountBefore,
          latestSnippet,
        };
      },
      PROBE_ACTOR_ID,
      discovery.scrollUuid,
    );
    record('Q6', 'consume scroll on non-caster: behavior', probe);
    // Not a hard fail — this is discovery; we just need to know what
    // happens so the tool can branch correctly.
  } else {
    record('Q6', 'SKIPPED: no scroll UUID discovered in equipment-srd', null);
  }

  // ====================================================================
  // Q7: equipment activation path.
  //
  // For an equipment item with system.uses.max > 0 or
  // system.frequency.max > 0, probe what activation methods exist. If
  // we found a candidate in discovery, instantiate it; otherwise fall
  // back to creating a minimal synthetic equipment item and probing
  // typeof on candidate method names.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, equipmentUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        let item;
        let source;
        if (equipmentUuid) {
          const src = await fromUuid(equipmentUuid);
          const data = src.toObject();
          const created = await actor.createEmbeddedDocuments('Item', [
            {
              ...data,
              name: '__probe_use_item_q7_equipment',
              system: { ...data.system, quantity: 1 },
            },
          ]);
          item = created[0];
          source = 'compendium';
        } else {
          const created = await actor.createEmbeddedDocuments('Item', [
            {
              name: '__probe_use_item_q7_synthetic_equipment',
              type: 'equipment',
              system: {
                description: { value: '' },
                quantity: 1,
                uses: { value: 1, max: 1, autoDestroy: false },
              },
            },
          ]);
          item = created[0];
          source = 'synthetic';
        }
        const methods = [
          'consume',
          'use',
          'toMessage',
          'toChat',
          'castEmbeddedSpell',
          'activate',
          'roll',
        ].map((m) => ({ method: m, type: typeof item[m] }));
        // Walk up the prototype chain to surface what class this is.
        let proto = Object.getPrototypeOf(item);
        const chain = [];
        while (proto && proto.constructor && proto.constructor.name !== 'Object') {
          chain.push(proto.constructor.name);
          proto = Object.getPrototypeOf(proto);
        }
        const out = {
          source,
          itemType: item.type,
          ctorChain: chain,
          hasUses: typeof item.system?.uses?.max === 'number' && item.system.uses.max > 0,
          hasFrequency:
            typeof item.system?.frequency?.max === 'number' && item.system.frequency.max > 0,
          methods,
        };
        // If consume exists on equipment, try it and see what happens.
        if (typeof item.consume === 'function') {
          try {
            const r = await item.consume(1);
            out.consumeReturnType = typeof r;
            out.consumeThrew = null;
          } catch (e) {
            out.consumeThrew = e?.message ?? String(e);
          }
        }
        await actor.deleteEmbeddedDocuments('Item', [item.id]).catch(() => undefined);
        return out;
      },
      PROBE_ACTOR_ID,
      discovery?.equipmentWithUses?.uuid ?? null,
    );
    record('Q7', 'equipment activation API surface', probe);
  }

  // ====================================================================
  // Q8: zero-charge guard.
  //
  // Create a temp potion, manually set quantity to 0 (Foundry will
  // clamp negatives but accepts 0), then call consume. Observe.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, potionUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(potionUuid);
        const data = src.toObject();
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...data,
            name: '__probe_use_item_q8_emptypotion',
            system: {
              ...data.system,
              quantity: 0,
              uses: { ...(data.system?.uses ?? {}), autoDestroy: false },
            },
          },
        ]);
        const item = created[0];
        const tempId = item.id;
        const before = {
          quantity: item.system?.quantity ?? null,
          usesValue: item.system?.uses?.value ?? null,
        };
        const msgCountBefore = globalThis.game.messages?.size ?? 0;
        let threw = null;
        let returnType = 'undefined';
        try {
          const r = await item.consume(1);
          returnType = typeof r;
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const msgCountAfter = globalThis.game.messages?.size ?? 0;
        const liveAfter = actor.items.get(tempId);
        const after = liveAfter
          ? {
              survived: true,
              quantity: liveAfter.system?.quantity ?? null,
            }
          : { survived: false };
        if (liveAfter) await actor.deleteEmbeddedDocuments('Item', [tempId]);
        return {
          before,
          after,
          threw,
          returnType,
          msgDelta: msgCountAfter - msgCountBefore,
        };
      },
      PROBE_ACTOR_ID,
      HEALING_POTION_UUID,
    );
    record('Q8', 'consume on quantity=0 potion: behavior', probe);
  }

  // ====================================================================
  // Q9: typeof consume on a weapon (non-consumable rejection branch).
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, longswordUuid) => {
        const actor = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(longswordUuid);
        const created = await actor.createEmbeddedDocuments('Item', [
          {
            ...src.toObject(),
            name: '__probe_use_item_q9_weapon',
            system: { ...src.toObject().system, quantity: 1 },
          },
        ]);
        const item = created[0];
        const out = {
          itemType: item.type,
          typeofConsume: typeof item.consume,
          typeofUse: typeof item.use,
          typeofToMessage: typeof item.toMessage,
        };
        await actor.deleteEmbeddedDocuments('Item', [item.id]);
        return out;
      },
      PROBE_ACTOR_ID,
      LONGSWORD_UUID,
    );
    record('Q9', 'typeof consume/use/toMessage on a weapon', probe);
  }

  // --------------------------------------------------------------------
  // Teardown — restore actor to start-of-probe snapshot signature.
  //
  // All Q-probes delete their temps inline; teardown handles any
  // leftovers (e.g., from a probe that threw before cleanup) and
  // restores canonical quantities. Pattern lifted from
  // probe-move-item-to-container-phase1.mjs:622-715.
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
