/**
 * Phase-1 exploratory probe for dnd5e_create_scroll_or_wand. Confirms the
 * dnd5e spell-scroll generation API against the live headless Foundry
 * BEFORE the evaluator is written. Throwaway — does not exercise a tool.
 *
 * D&D 5e spell scrolls differ fundamentally from PF2e: there is no
 * per-rank template registry, no embedded nested spell Item — the SRD
 * ships finished "Spell Scroll" consumables and the system carries a
 * factory. Nothing here is assumed.
 *
 * Runs in stages, each its own page.evaluate, so a hang in one segment
 * (e.g. a factory call that opens a dialog) does not wedge the rest.
 * Factory calls are raced against a timeout.
 *
 * Questions:
 *   Q1. Does the system expose a scroll factory? (Item5e.createScrollFromSpell)
 *   Q2. What does createScrollFromSpell(spell, options) RETURN?
 *   Q3. The spell-level → scroll table (CONFIG.DND5E.spellScrollIds /
 *       spellScrollValues); dnd5e.rulesVersion / edition.
 *   Q4. A finished SRD "Spell Scroll" consumable's shape.
 *   Q5. Any per-spell WAND generation path?
 *   Q6. Can a scroll be made of a cantrip (spell level 0)?
 *   Q7. Upcast: does createScrollFromSpell accept a target level?
 *   Q8. Container field on consumables / identified flag.
 *   Q9. Which actor types accept embedded consumables.
 *
 *   npm run build && node scripts/probe-dnd5e-create-scroll-or-wand-phase1.mjs
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
  // Stage A — discovery: factory existence, scroll table, spell sources,
  // SRD scroll/wand samples, actor types. No factory calls here.
  // ====================================================================
  const stageA = await page.evaluate(async () => {
    const game = globalThis.game;
    const CONFIG = globalThis.CONFIG;
    const dnd5e = globalThis.dnd5e;
    const fromUuid = globalThis.fromUuid;
    const report = {
      system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
    };

    const describeDoc = (doc) => {
      if (!doc || typeof doc !== 'object') return { value: doc };
      const sys = doc.system ?? {};
      let activitySummaries = null;
      try {
        const act = sys.activities;
        const list = act && typeof act.contents !== 'undefined' ? act.contents : null;
        if (Array.isArray(list)) {
          activitySummaries = list.map((a) => ({
            id: a?.id ?? null,
            type: a?.type ?? null,
            name: a?.name ?? null,
            ctor: a?.constructor?.name ?? null,
            keys: a && typeof a === 'object' ? Object.keys(a) : null,
          }));
        }
      } catch {
        activitySummaries = 'unreadable';
      }
      return {
        ctor: doc.constructor?.name ?? null,
        documentName: doc.documentName ?? null,
        hasId: typeof doc.id === 'string' && doc.id.length > 0,
        id: doc.id ?? null,
        name: doc.name ?? null,
        type: doc.type ?? null,
        sysTypeValue: sys.type?.value ?? null,
        sysLevel: sys.level ?? null,
        quantity: sys.quantity ?? null,
        identified: sys.identified ?? null,
        container: sys.container ?? null,
        uses: sys.uses ?? null,
        price: sys.price ?? null,
        rarity: sys.rarity ?? null,
        activitySummaries,
        systemKeys: Object.keys(sys),
      };
    };

    // Q1: scroll factory.
    const Item5eFromConfig = CONFIG?.Item?.documentClass ?? null;
    const Item5eFromDnd5e = dnd5e?.documents?.Item5e ?? null;
    const Item5e = Item5eFromDnd5e ?? Item5eFromConfig;
    report.factory = {
      dnd5eGlobalExists: !!dnd5e,
      dnd5eDocumentsKeys: dnd5e?.documents ? Object.keys(dnd5e.documents) : null,
      configItemClassName: Item5eFromConfig?.name ?? null,
      dnd5eItem5eClassName: Item5eFromDnd5e?.name ?? null,
      sameClass: Item5eFromConfig === Item5eFromDnd5e,
      createScrollFromSpell: typeof Item5e?.createScrollFromSpell,
      scrollRelatedStatics: Item5e
        ? Object.getOwnPropertyNames(Item5e).filter(
            (n) => /scroll/i.test(n) || /fromSpell/i.test(n),
          )
        : null,
    };
    try {
      report.factory.createScrollSource =
        typeof Item5e?.createScrollFromSpell === 'function'
          ? String(Item5e.createScrollFromSpell)
          : null;
    } catch {
      report.factory.createScrollSource = 'unreadable';
    }

    // Q3: scroll table + edition.
    const D5 = CONFIG?.DND5E ?? {};
    report.scrollTable = {
      rulesVersion: dnd5e?.rulesVersion ?? null,
      settingsRulesVersion: (() => {
        try {
          return game.settings?.get?.('dnd5e', 'rulesVersion') ?? null;
        } catch {
          return 'unreadable';
        }
      })(),
      spellScrollIds: D5.spellScrollIds ?? null,
      spellScrollValues: D5.spellScrollValues ?? null,
      spellLevelKeys: D5.spellLevels ? Object.keys(D5.spellLevels) : null,
      consumableTypes: D5.consumableTypes ? Object.keys(D5.consumableTypes) : null,
    };

    // Spell discovery — prefer dnd5e.spells, fall back to any Item pack.
    const itemPacks = game.packs.filter((p) => p.metadata?.type === 'Item');
    report.itemPacks = itemPacks.map((p) => p.collection);
    const spellPackOrder = [
      game.packs.get('dnd5e.spells'),
      ...itemPacks.filter((p) => p.collection !== 'dnd5e.spells'),
    ].filter(Boolean);

    let leveledSpellUuid = null;
    let cantripUuid = null;
    let highLevelSpellUuid = null;
    let spellPackUsed = null;
    for (const pack of spellPackOrder) {
      let index;
      try {
        index = await pack.getIndex({ fields: ['system.level'] });
      } catch {
        continue;
      }
      const spells = index.filter((e) => e.type === 'spell');
      if (spells.length === 0) continue;
      spellPackUsed = pack.collection;
      for (const e of spells) {
        const lvl = e.system?.level;
        if (lvl === 0 && !cantripUuid) cantripUuid = e.uuid;
        if (lvl === 1 && !leveledSpellUuid) leveledSpellUuid = e.uuid;
        if (typeof lvl === 'number' && lvl >= 3 && !highLevelSpellUuid) highLevelSpellUuid = e.uuid;
      }
      if (leveledSpellUuid && cantripUuid && highLevelSpellUuid) break;
    }
    report.spellSources = {
      spellPackUsed,
      leveledSpellUuid,
      cantripUuid,
      highLevelSpellUuid,
    };
    const leveledSpell = leveledSpellUuid ? await fromUuid(leveledSpellUuid) : null;
    const cantripSpell = cantripUuid ? await fromUuid(cantripUuid) : null;
    report.resolvedSpells = {
      leveled: leveledSpell
        ? {
            name: leveledSpell.name,
            level: leveledSpell.system?.level,
            uuid: leveledSpellUuid,
            sysKeys: Object.keys(leveledSpell.system ?? {}),
          }
        : null,
      cantrip: cantripSpell
        ? { name: cantripSpell.name, level: cantripSpell.system?.level, uuid: cantripUuid }
        : null,
    };

    // Q4/Q5: SRD scroll + wand samples.
    let srdScroll = null;
    let wandSample = null;
    for (const pack of itemPacks) {
      if (srdScroll && wandSample) break;
      let index;
      try {
        index = await pack.getIndex({ fields: ['system.type.value'] });
      } catch {
        continue;
      }
      if (!srdScroll) {
        const hit = index.find(
          (e) =>
            e.type === 'consumable' &&
            (/spell scroll/i.test(e.name ?? '') || e.system?.type?.value === 'scroll'),
        );
        if (hit) {
          const doc = await fromUuid(hit.uuid);
          if (doc) srdScroll = { uuid: hit.uuid, pack: pack.collection, ...describeDoc(doc) };
        }
      }
      if (!wandSample) {
        const hit = index.find((e) => e.type === 'consumable' && e.system?.type?.value === 'wand');
        if (hit) {
          const doc = await fromUuid(hit.uuid);
          if (doc) wandSample = { uuid: hit.uuid, pack: pack.collection, ...describeDoc(doc) };
        }
      }
    }
    report.srdScrollSample = srdScroll;
    report.wandSample = wandSample;

    // Q9: actor types.
    report.actors = {
      allTypes: [...new Set(game.actors?.contents.map((a) => a.type) ?? [])],
      character: game.actors?.contents.find((a) => a.type === 'character')?.id ?? null,
      npc: game.actors?.contents.find((a) => a.type === 'npc')?.id ?? null,
      other:
        game.actors?.contents.find((a) => a.type !== 'character' && a.type !== 'npc')?.id ?? null,
    };
    report.worldItemCount = game.items?.size ?? 0;
    return report;
  });

  log.info('stage A (discovery) complete');
  console.error('=== STAGE A ===');
  console.error(JSON.stringify(stageA, null, 2));

  // ====================================================================
  // Stage B — factory calls, each raced against a timeout.
  // Signature: createScrollFromSpell(spell, options={}, config={}).
  // The dialog-bypass and level live in CONFIG (3rd arg).
  // ====================================================================
  const stageB = await page.evaluate(async (spellSources) => {
    const CONFIG = globalThis.CONFIG;
    const dnd5e = globalThis.dnd5e;
    const fromUuid = globalThis.fromUuid;
    const Item5e = dnd5e?.documents?.Item5e ?? CONFIG?.Item?.documentClass ?? null;
    const report = {};
    try {
      report.createScrollFromCompendiumSpellSource =
        typeof Item5e?.createScrollFromCompendiumSpell === 'function'
          ? String(Item5e.createScrollFromCompendiumSpell)
          : null;
    } catch {
      report.createScrollFromCompendiumSpellSource = 'unreadable';
    }

    const describeDoc = (doc) => {
      if (!doc || typeof doc !== 'object') return { value: String(doc) };
      const sys = doc.system ?? {};
      let activitySummaries = null;
      try {
        const act = sys.activities;
        const list = act && typeof act.contents !== 'undefined' ? act.contents : null;
        if (Array.isArray(list)) {
          activitySummaries = list.map((a) => ({
            id: a?.id ?? null,
            type: a?.type ?? null,
            name: a?.name ?? null,
            ctor: a?.constructor?.name ?? null,
          }));
        }
      } catch {
        activitySummaries = 'unreadable';
      }
      let toObjectKeys = null;
      try {
        toObjectKeys = typeof doc.toObject === 'function' ? Object.keys(doc.toObject()) : null;
      } catch {
        toObjectKeys = 'unreadable';
      }
      return {
        ctor: doc.constructor?.name ?? null,
        documentName: doc.documentName ?? null,
        hasId: typeof doc.id === 'string' && doc.id.length > 0,
        inWorldItems: doc.id ? !!globalThis.game.items?.get(doc.id) : false,
        name: doc.name ?? null,
        type: doc.type ?? null,
        sysTypeValue: sys.type?.value ?? null,
        sysLevel: sys.level ?? null,
        quantity: sys.quantity ?? null,
        uses: sys.uses ?? null,
        container: sys.container ?? null,
        identified: sys.identified ?? null,
        properties: sys.properties ?? null,
        flagsDnd5e: doc.flags?.dnd5e ?? null,
        activitySummaries,
        toObjectKeys,
      };
    };

    const withTimeout = (p, ms) =>
      Promise.race([
        Promise.resolve(p)
          .then((v) => ({ settled: true, value: v }))
          .catch((e) => ({ settled: true, error: e?.message ?? String(e) })),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), ms)),
      ]);

    const attempts = [];
    const tryScroll = async (label, uuid, cfg) => {
      if (!uuid || typeof Item5e?.createScrollFromSpell !== 'function') {
        attempts.push({ label, skipped: true, uuidPresent: !!uuid });
        return;
      }
      const spell = await fromUuid(uuid);
      const raced = await withTimeout(Item5e.createScrollFromSpell(spell, {}, cfg ?? {}), 15000);
      if (raced.timedOut) {
        attempts.push({ label, timedOut: true, config: cfg ?? {} });
      } else if (raced.error) {
        attempts.push({ label, threw: raced.error, config: cfg ?? {} });
      } else {
        attempts.push({
          label,
          ok: true,
          config: cfg ?? {},
          result: describeDoc(raced.value),
        });
      }
    };

    await tryScroll('leveled spell, {dialog:false}', spellSources.leveledSpellUuid, {
      dialog: false,
    });
    await tryScroll('cantrip, {dialog:false}', spellSources.cantripUuid, {
      dialog: false,
    });
    await tryScroll(
      'leveled (lvl1) spell, {dialog:false, level:5}',
      spellSources.leveledSpellUuid,
      { dialog: false, level: 5 },
    );
    await tryScroll(
      'high (lvl3+) spell, {dialog:false, level:1} (downcast?)',
      spellSources.highLevelSpellUuid,
      { dialog: false, level: 1 },
    );
    await tryScroll(
      'leveled spell, {dialog:false, explanation:"none"}',
      spellSources.leveledSpellUuid,
      { dialog: false, explanation: 'none' },
    );

    report.attempts = attempts;
    report.worldItemCountAfter = globalThis.game.items?.size ?? 0;
    return report;
  }, stageA.spellSources);

  log.info('stage B (factory) complete');
  console.error('=== STAGE B ===');
  console.error(JSON.stringify(stageB, null, 2));
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
