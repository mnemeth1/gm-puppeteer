/**
 * Phase-2 probe for dnd5e_use_item — settles the ONE open question from
 * phase 1: the spell-scroll `cast` activity hung when used via
 * `item.use({}, {configure:false}, {})`. Throwaway.
 *
 * Discovers: the cast-activity use source, the dialog-bypass that does
 * NOT hang the headless client, and what a successful scroll cast does
 * to the item (charge/quantity/autoDestroy) and the chat log.
 *
 *   npm run build && node scripts/probe-dnd5e-use-item-phase2.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const baseMsgIds = await page.evaluate(() => globalThis.game.messages.contents.map((m) => m.id));

  // -- Stage A: bake a scroll, dump the cast-activity use source. ------
  const stageA = await page.evaluate(async () => {
    const game = globalThis.game;
    const fromUuid = globalThis.fromUuid;
    const Item5e = globalThis.dnd5e?.documents?.Item5e ?? globalThis.CONFIG?.Item?.documentClass;
    const actor = game.actors.find((a) => a.type === 'character');
    const spell = await fromUuid('Compendium.dnd5e.spells.Item.0xmXiPiuYws1OGcX');
    const scrollDoc = await Item5e.createScrollFromSpell(spell, {}, { dialog: false });
    const created = await actor.createEmbeddedDocuments('Item', [scrollDoc.toObject()]);
    const scroll = created[0];
    const activity = scroll.system.activities.contents[0];
    return {
      actorId: actor.id,
      scrollId: scroll.id,
      activity: {
        id: activity.id,
        type: activity.type,
        ctor: activity.constructor?.name ?? null,
        useSource: typeof activity.use === 'function' ? String(activity.use) : null,
        protoUseSource: (() => {
          const proto = Object.getPrototypeOf(activity);
          const protoProto = proto ? Object.getPrototypeOf(proto) : null;
          const fn = protoProto?.use ?? proto?.use;
          return typeof fn === 'function' ? String(fn).slice(0, 2000) : null;
        })(),
        protoChain: (() => {
          const chain = [];
          let p = Object.getPrototypeOf(activity);
          while (p && p.constructor && p.constructor.name !== 'Object') {
            chain.push(p.constructor.name);
            p = Object.getPrototypeOf(p);
          }
          return chain;
        })(),
      },
    };
  });

  log.info('stage A complete');
  console.error('=== STAGE A (cast-activity source) ===');
  console.error(JSON.stringify(stageA, null, 2));

  // -- Stage B: try invocation variants, each raced at 35s. ------------
  const stageB = await page.evaluate(
    async (actorId, scrollId) => {
      const game = globalThis.game;
      const actor = game.actors.get(actorId);
      const report = { attempts: [] };

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
        };
      };

      const describe = (v) => {
        if (v == null) return { value: String(v) };
        return {
          ctor: v?.constructor?.name ?? null,
          keys: typeof v === 'object' ? Object.keys(v).slice(0, 12) : null,
          messageId: v?.message?.id ?? v?.id ?? null,
        };
      };

      // The scroll is single-quantity / single-use; re-bake before each
      // attempt that consumes it. We only have one scroll, so attempt
      // them in order and re-bake as needed.
      const attempt = async (label, invoke) => {
        const item = actor.items.get(scrollId);
        if (!item) {
          report.attempts.push({ label, scrollMissing: true });
          return;
        }
        const before = snap(item);
        const msgBefore = game.messages.size;
        const raced = await withTimeout(invoke(item), 35000);
        const after = snap(actor.items.get(scrollId));
        const entry = {
          label,
          before,
          after,
          deleted: !actor.items.get(scrollId),
          msgDelta: game.messages.size - msgBefore,
        };
        if (raced.timedOut) entry.timedOut = true;
        else if (raced.error) entry.threw = raced.error;
        else {
          entry.ok = true;
          entry.returnShape = describe(raced.value);
        }
        report.attempts.push(entry);
      };

      // Variant 1: item.use with shiftKey event + dialog configure:false.
      await attempt('item.use({event:{shiftKey:true}},{configure:false},{})', (item) =>
        item.use({ event: { shiftKey: true } }, { configure: false }, {}),
      );

      return report;
    },
    stageA.actorId,
    stageA.scrollId,
  );

  log.info('stage B complete');
  console.error('=== STAGE B (invocation variants) ===');
  console.error(JSON.stringify(stageB, null, 2));

  // -- Teardown --------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, baseIds) => {
      const game = globalThis.game;
      const actor = game.actors.get(actorId);
      let itemsDeleted = 0;
      for (const i of [...actor.items.contents]) {
        if (/^Spell Scroll:/.test(i.name ?? '')) {
          await i.delete();
          itemsDeleted++;
        }
      }
      const base = new Set(baseIds);
      const newMsgs = game.messages.contents.filter((m) => !base.has(m.id)).map((m) => m.id);
      if (newMsgs.length) await globalThis.ChatMessage.deleteDocuments(newMsgs);
      // Also clean up any orphaned measured templates on the active scene.
      let templatesDeleted = 0;
      const scene = game.scenes?.active;
      if (scene) {
        const tids = scene.templates?.contents?.map((t) => t.id) ?? [];
        if (tids.length) {
          await scene.deleteEmbeddedDocuments('MeasuredTemplate', tids);
          templatesDeleted = tids.length;
        }
      }
      return { itemsDeleted, messagesDeleted: newMsgs.length, templatesDeleted };
    },
    stageA.actorId,
    baseMsgIds,
  );
  log.info({ teardown }, 'teardown complete');
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
