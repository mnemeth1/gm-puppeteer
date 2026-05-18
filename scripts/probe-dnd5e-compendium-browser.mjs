/**
 * Probe: the native dnd5e Compendium Browser as a programmatic query engine
 * for `dnd5e_search_compendium` (and a future D&D 5e rules-search tool).
 *
 * Read-only — `CompendiumBrowser.fetch` / `getIndex` only, no mutation, no
 * teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-compendium-browser.mjs
 *
 * Questions answered (probed live on dnd5e 5.3.3 / Foundry v14.361):
 *   Q1  Where the browser lives + its static surface
 *       (`dnd5e.applications.CompendiumBrowser`).
 *   Q2  `fetch` / `applyFilters` / `intersectFilters` signatures + bodies.
 *   Q3  Per-type filter definitions: each data model's
 *       `compendiumBrowserFilters` getter → Map of {key → {type, config}}.
 *   Q4  `dnd5e.Filter` operator + boolean-composition vocabulary accepted
 *       in `{ k, o, v }` filter records.
 *   Q5  Does `fetch` honor the GM's Compendium Browser source settings?
 *       (`CompendiumBrowserSettingsConfig.collateSources()` vs raw pack count.)
 *   Q6  End-to-end `fetch`: name search, a range filter, a `set` filter
 *       routed through `applyFilters`, and a derived `createFilter` filter.
 *   Q7  Shape of a returned index entry (does it carry uuid / folder /
 *       derived `system.source`?).
 *
 * Findings feed `src/evaluators/dnd5e-search-compendium.ts`:
 *   - filter records are `{ k: keyPath, o: operator, v: value }`; `o` omitted
 *     means exact match. `fetch` mutates the passed `filters` array (pushes a
 *     container-exclusion filter) — always hand it a fresh array.
 *   - `applyFilters` value shapes: range → `{min,max}`; set & createFilter →
 *     `{choiceKey: 1}` include / `{choiceKey: -1}` exclude; boolean → truthy,
 *     with `v: value === 1` deciding true-vs-false match.
 *   - `fetch` returns index entries (uuid, folder, derived system.source +
 *     any requested indexFields), name-sorted, container contents excluded,
 *     scoped to packs the GM left enabled in the browser source settings.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const result = await page.evaluate(async () => {
    const game = globalThis.game;
    const CONFIG = globalThis.CONFIG;
    const dnd5e = globalThis.dnd5e;
    const CB = dnd5e?.applications?.CompendiumBrowser ?? null;

    // --- Q1 ---------------------------------------------------------------
    const q1 = {
      found: !!CB,
      staticMembers: CB
        ? Object.getOwnPropertyNames(CB).filter((k) => !['length', 'name', 'prototype'].includes(k))
        : null,
      tabs: CB?.TABS?.map((t) => ({
        tab: t.tab,
        documentClass: t.documentClass,
        types: t.types ?? null,
      })),
    };

    // --- Q2 ---------------------------------------------------------------
    const sig = (fn) => (typeof fn === 'function' ? String(fn).slice(0, 220) : null);
    const q2 = {
      fetch: sig(CB?.fetch),
      applyFilters: sig(CB?.applyFilters),
      intersectFilters: sig(CB?.intersectFilters),
    };

    // --- Q3 ---------------------------------------------------------------
    // Each data-model class exposes a `compendiumBrowserFilters` getter →
    // Map. Dump the key / type / keyPath / choice vocabulary per type.
    const dumpFilters = (model) => {
      try {
        const def = model?.compendiumBrowserFilters;
        if (!def) return null;
        const entries = def instanceof Map ? [...def.entries()] : Object.entries(def);
        return entries.map(([key, v]) => ({
          key,
          type: v?.type ?? null,
          keyPath: v?.config?.keyPath ?? null,
          multiple: v?.config?.multiple ?? false,
          hasCreateFilter: typeof v?.createFilter === 'function',
          choices:
            v?.config?.choices && typeof v.config.choices !== 'function'
              ? Object.keys(v.config.choices)
              : v?.config?.choices
                ? '<function>'
                : null,
        }));
      } catch (err) {
        return { error: String(err?.message ?? err) };
      }
    };
    const q3 = { item: {}, actor: {} };
    for (const t of Object.keys(CONFIG?.Item?.dataModels ?? {})) {
      q3.item[t] = dumpFilters(CONFIG.Item.dataModels[t]);
    }
    for (const t of Object.keys(CONFIG?.Actor?.dataModels ?? {})) {
      q3.actor[t] = dumpFilters(CONFIG.Actor.dataModels[t]);
    }

    // --- Q4 ---------------------------------------------------------------
    const F = dnd5e?.Filter ?? null;
    const q4 = {
      comparisonOperators: F?.COMPARISON_FUNCTIONS ? Object.keys(F.COMPARISON_FUNCTIONS) : null,
      booleanOperators: F?.OPERATOR_FUNCTIONS ? Object.keys(F.OPERATOR_FUNCTIONS) : null,
    };

    // --- Q5 ---------------------------------------------------------------
    let collatedSources = null;
    try {
      collatedSources =
        dnd5e.applications.settings.CompendiumBrowserSettingsConfig.collateSources().size;
    } catch (err) {
      collatedSources = { error: String(err?.message ?? err) };
    }
    const q5 = {
      collatedSourceCount: collatedSources,
      itemPacks: game.packs.filter((p) => p.metadata.type === 'Item').length,
      actorPacks: game.packs.filter((p) => p.metadata.type === 'Actor').length,
      journalPacks: game.packs.filter((p) => p.metadata.type === 'JournalEntry').length,
    };

    // --- Q6 + Q7 ----------------------------------------------------------
    const q6 = {};
    let q7 = null;
    if (CB) {
      // Name search.
      const goblins = await CB.fetch(Actor, {
        types: new Set(['npc']),
        filters: [{ k: 'name', o: 'icontains', v: 'goblin' }],
      });
      q6.nameSearch = { count: goblins.length, sample: goblins.slice(0, 4).map((d) => d.name) };

      // Range filter via applyFilters (spell level 1-3, evocation school).
      const spellDef = CONFIG.Item.dataModels.spell.compendiumBrowserFilters;
      const built = CB.applyFilters(spellDef, {
        additional: { level: { min: 1, max: 3 }, school: { evo: 1 } },
      });
      const evoSpells = await CB.fetch(Item, { types: new Set(['spell']), filters: built });
      q6.applyFilters = {
        builtRecords: built,
        count: evoSpells.length,
        sample: evoSpells.slice(0, 3).map((d) => d.name),
      };

      // Derived createFilter filter (NPC movement → can fly).
      const npcDef = CONFIG.Actor.dataModels.npc.compendiumBrowserFilters;
      const flyBuilt = CB.applyFilters(npcDef, { additional: { movement: { fly: 1 } } });
      const fliers = await CB.fetch(Actor, { types: new Set(['npc']), filters: flyBuilt });
      q6.createFilter = {
        builtRecords: flyBuilt,
        count: fliers.length,
        sample: fliers.slice(0, 4).map((d) => d.name),
      };

      // Q7: returned index-entry shape.
      const first = evoSpells[0];
      q7 = first
        ? {
            topLevelKeys: Object.keys(first),
            hasUuid: typeof first.uuid === 'string',
            hasFolder: 'folder' in first,
            sourceType: typeof first.system?.source,
            sourceKeys:
              first.system?.source && typeof first.system.source === 'object'
                ? Object.keys(first.system.source)
                : null,
          }
        : null;
    }

    return { q1, q2, q3, q4, q5, q6, q7 };
  });

  log.info({ q1: result.q1 }, 'Q1 — CompendiumBrowser location + static surface');
  log.info({ q2: result.q2 }, 'Q2 — fetch / applyFilters / intersectFilters signatures');
  log.info({ q3: result.q3 }, 'Q3 — per-type filter definitions');
  log.info({ q4: result.q4 }, 'Q4 — Filter operator vocabulary');
  log.info({ q5: result.q5 }, 'Q5 — source-settings collation vs raw pack count');
  log.info({ q6: result.q6 }, 'Q6 — end-to-end fetch (name / applyFilters / createFilter)');
  log.info({ q7: result.q7 }, 'Q7 — returned index-entry shape');
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
