/**
 * Phase-1 exploratory probe for dnd5e_use_item. Confirms the dnd5e
 * item-use / activity pipeline against the live headless Foundry BEFORE
 * the evaluator is written. Throwaway — does not exercise a tool.
 *
 * D&D 5e has no PF2e consume()/toMessage() split — items carry
 * `system.activities` (a Map of activity definitions) and use runs
 * through `Item5e#use` / `Activity#use`. The method, the triad argument
 * shape, the dialog-bypass, and charge bookkeeping are version-specific
 * to dnd5e 5.3.3 and observed live here.
 *
 * Runs in stages, each its own page.evaluate. Every use-pipeline call is
 * raced against a timeout so a dialog hang is recorded, never wedged.
 *
 * Questions:
 *   Q1. The use entrypoint — Item5e#use vs Activity#use; the
 *       (usage, dialog, message) triad; the dialog-bypass option.
 *   Q2. Activity selection — how system.activities is keyed; does use()
 *       auto-pick the primary or need an explicit activity id.
 *   Q3. Charge decrement — does use() auto-decrement uses.spent and/or
 *       quantity.
 *   Q4. autoDestroy firing on last charge/quantity → item deletion.
 *   Q5. Chat-card id recovery — return value or game.messages.size diff.
 *   Q6. Silent no-op — depleted item, item with no activities.
 *   Q7. Which item types carry activities.
 *   Q8. Spell-scroll cast on a character without the spell prepared.
 *   Q9. Actor type support.
 *
 * Cleans up temp items and chat messages it creates.
 *
 *   npm run build && node scripts/probe-dnd5e-use-item-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  // ====================================================================
  // Stage A — discovery: actor, item-use method surface, a potion UUID,
  // activity-bearing compendium item types.
  // ====================================================================
  const stageA = await page.evaluate(async () => {
    const game = globalThis.game;
    const fromUuid = globalThis.fromUuid;
    const report = {
      system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
    };

    const pc = game.actors?.contents.find((a) => a.type === 'character');
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    const other = game.actors?.contents.find(
      (a) => a.type !== 'character' && a.type !== 'npc',
    );
    report.actors = {
      pc: pc ? { id: pc.id, name: pc.name } : null,
      npc: npc ? { id: npc.id, name: npc.name } : null,
      other: other ? { id: other.id, name: other.name, type: other.type } : null,
    };

    // Q1: item-use method surface on a freshly-built consumable.
    const Item5e = globalThis.dnd5e?.documents?.Item5e ?? globalThis.CONFIG?.Item?.documentClass;
    const probeItem = new Item5e({ name: '__m__', type: 'consumable' });
    report.itemUseSurface = {
      use: typeof probeItem.use,
      activitiesGetter: typeof probeItem.system?.activities,
      useSource:
        typeof probeItem.use === 'function' ? String(probeItem.use).slice(0, 900) : null,
    };

    // Discover a Potion of Healing + a generic potion.
    const itemPacks = game.packs.filter((p) => p.metadata?.type === 'Item');
    let potionUuid = null;
    let potionName = null;
    for (const pack of itemPacks) {
      let index;
      try {
        index = await pack.getIndex({ fields: ['system.type.value'] });
      } catch {
        continue;
      }
      const hit =
        index.find(
          (e) => e.type === 'consumable' && /potion of healing/i.test(e.name ?? ''),
        ) ?? index.find((e) => e.type === 'consumable' && e.system?.type?.value === 'potion');
      if (hit) {
        potionUuid = hit.uuid;
        potionName = hit.name;
        break;
      }
    }
    report.potion = { uuid: potionUuid, name: potionName };
    if (potionUuid) {
      const potion = await fromUuid(potionUuid);
      const acts = potion?.system?.activities;
      report.potionShape = {
        type: potion?.type,
        quantity: potion?.system?.quantity,
        uses: potion?.system?.uses,
        activities: acts?.contents
          ? acts.contents.map((a) => ({
              id: a.id,
              type: a.type,
              name: a.name,
              consumptionTargets: a.consumption?.targets ?? null,
            }))
          : null,
      };
    }

    // A leveled spell for scroll-baking.
    const spellPack = game.packs.get('dnd5e.spells');
    let leveledSpellUuid = null;
    if (spellPack) {
      const idx = await spellPack.getIndex({ fields: ['system.level'] });
      const s = idx.find((e) => e.type === 'spell' && e.system?.level === 1);
      leveledSpellUuid = s?.uuid ?? null;
    }
    report.leveledSpellUuid = leveledSpellUuid;

    return report;
  });

  log.info('stage A (discovery) complete');
  console.error('=== STAGE A ===');
  console.error(JSON.stringify(stageA, null, 2));

  if (!stageA.actors.pc) {
    throw new Error('no character actor in world');
  }

  // Baseline chat-message ids so teardown can delete only what we post.
  const baseMsgIds = await page.evaluate(() =>
    globalThis.game.messages.contents.map((m) => m.id),
  );

  // ====================================================================
  // Stage B — create temp items, run the use pipeline, observe.
  // ====================================================================
  const stageB = await page.evaluate(
    async (pcId, potionUuid, spellUuid) => {
      const game = globalThis.game;
      const fromUuid = globalThis.fromUuid;
      const Item5e =
        globalThis.dnd5e?.documents?.Item5e ?? globalThis.CONFIG?.Item?.documentClass;
      const actor = game.actors.get(pcId);
      const report = { created: [], attempts: [] };

      const withTimeout = (p, ms) =>
        Promise.race([
          Promise.resolve(p)
            .then((v) => ({ settled: true, value: v }))
            .catch((e) => ({ settled: true, error: e?.message ?? String(e) })),
          new Promise((res) => setTimeout(() => res({ timedOut: true }), ms)),
        ]);

      const snap = (item) => {
        if (!item) return { exists: false };
        const u = item.system?.uses ?? {};
        return {
          exists: true,
          quantity: item.system?.quantity ?? null,
          usesSpent: u.spent ?? null,
          usesValue: u.value ?? null,
          usesMax: u.max ?? null,
        };
      };

      const describeUse = (val) => {
        if (val == null) return { returnValue: String(val) };
        return {
          returnCtor: val?.constructor?.name ?? null,
          isArray: Array.isArray(val),
          length: Array.isArray(val) ? val.length : null,
          keys: typeof val === 'object' ? Object.keys(val).slice(0, 20) : null,
          messageId:
            val?.message?.id ?? (Array.isArray(val) ? val[0]?.id ?? null : val?.id ?? null),
        };
      };

      // -- Build temp items ------------------------------------------
      // 1. Baked spell scroll (real cast activity).
      let scrollId = null;
      try {
        const spell = await fromUuid(spellUuid);
        const scrollDoc = await Item5e.createScrollFromSpell(spell, {}, { dialog: false });
        const created = await actor.createEmbeddedDocuments('Item', [scrollDoc.toObject()]);
        scrollId = created[0]?.id ?? null;
      } catch (e) {
        report.scrollBakeError = e?.message ?? String(e);
      }
      // 2. Potion of Healing (qty 3).
      let potionId = null;
      try {
        const potion = await fromUuid(potionUuid);
        const data = potion.toObject();
        data.system.quantity = 3;
        const created = await actor.createEmbeddedDocuments('Item', [data]);
        potionId = created[0]?.id ?? null;
      } catch (e) {
        report.potionCloneError = e?.message ?? String(e);
      }
      // 3. Synthetic consumable with NO activities.
      const [noActId] = (
        await actor.createEmbeddedDocuments('Item', [
          { name: '__probe_noact__', type: 'consumable', system: { quantity: 1 } },
        ])
      ).map((i) => i.id);
      report.created = [scrollId, potionId, noActId].filter(Boolean);

      // Inspect activity collections on the temp items.
      const describeActs = (item) => {
        const acts = item?.system?.activities;
        if (!acts) return null;
        const contents = acts.contents ?? [];
        return {
          collectionCtor: acts.constructor?.name ?? null,
          count: contents.length,
          activities: contents.map((a) => ({
            id: a.id,
            type: a.type,
            name: a.name,
            useType: typeof a.use,
            consumptionTargets: a.consumption?.targets ?? null,
          })),
        };
      };
      report.scrollActivities = scrollId
        ? describeActs(actor.items.get(scrollId))
        : null;
      report.potionActivities = potionId
        ? describeActs(actor.items.get(potionId))
        : null;
      report.noActActivities = describeActs(actor.items.get(noActId));

      // -- Q1/Q2/Q3/Q5: run use() on the potion ---------------------
      const runUse = async (label, itemId, invoke) => {
        const item = actor.items.get(itemId);
        if (!item) {
          report.attempts.push({ label, itemMissing: true });
          return;
        }
        const before = snap(item);
        const msgBefore = game.messages.size;
        const raced = await withTimeout(invoke(item), 12000);
        const liveAfter = actor.items.get(itemId);
        const after = snap(liveAfter);
        const msgDelta = game.messages.size - msgBefore;
        const entry = { label, before, after, msgDelta, deleted: !liveAfter };
        if (raced.timedOut) entry.timedOut = true;
        else if (raced.error) entry.threw = raced.error;
        else {
          entry.ok = true;
          entry.returnShape = describeUse(raced.value);
        }
        report.attempts.push(entry);
      };

      // Potion, qty 3 → use one. Triad with dialog bypass.
      await runUse('potion use({},{configure:false},{})', potionId, (item) =>
        item.use({}, { configure: false }, {}),
      );
      // Potion again — second use.
      await runUse('potion use() 2nd', potionId, (item) =>
        item.use({}, { configure: false }, {}),
      );

      // Q8: spell-scroll cast.
      await runUse('scroll cast use({},{configure:false},{})', scrollId, (item) =>
        item.use({}, { configure: false }, {}),
      );

      // Q6: no-activity consumable.
      await runUse('no-activity consumable use()', noActId, (item) =>
        item.use({}, { configure: false }, {}),
      );

      return report;
    },
    stageA.actors.pc.id,
    stageA.potion.uuid,
    stageA.leveledSpellUuid,
  );

  log.info('stage B (use pipeline) complete');
  console.error('=== STAGE B ===');
  console.error(JSON.stringify(stageB, null, 2));

  // ====================================================================
  // Stage C — teardown: delete the exact temp items created, plus any
  // probe-named orphans, plus chat messages posted during the probe.
  // ====================================================================
  const stageC = await page.evaluate(
    async (pcId, createdIds, baseIds) => {
      const game = globalThis.game;
      const actor = game.actors.get(pcId);
      const toDelete = new Set(createdIds);
      for (const i of actor.items.contents) {
        if (/^__probe_/.test(i.name ?? '') || /^Spell Scroll:/.test(i.name ?? '')) {
          toDelete.add(i.id);
        }
      }
      let itemsDeleted = 0;
      for (const id of toDelete) {
        const it = actor.items.get(id);
        if (it) {
          await it.delete();
          itemsDeleted++;
        }
      }
      const base = new Set(baseIds);
      const newMsgs = game.messages.contents.filter((m) => !base.has(m.id)).map((m) => m.id);
      if (newMsgs.length > 0) await globalThis.ChatMessage.deleteDocuments(newMsgs);
      return { itemsDeleted, messagesDeleted: newMsgs.length };
    },
    stageA.actors.pc.id,
    stageB.created,
    baseMsgIds,
  );

  log.info({ stageC }, 'stage C (teardown) complete');
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
