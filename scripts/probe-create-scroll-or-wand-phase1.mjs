/**
 * Phase 1 design-blocking probes for create_scroll_or_wand. Run BEFORE
 * any tool code is written; the spec hangs on the answers.
 *
 * The tool will generate a spell-specific scroll or wand consumable from
 * a Spell UUID, mirroring PF2e's "drag a spell onto an actor" UI. The
 * underlying API is unknown today. Candidates per the TODO sketch:
 *   - `ConsumablePF2e.fromSpell(spell, {kind, rank})` static method.
 *   - `CONFIG.PF2E.scroll*` / `CONFIG.PF2E.wand*` factory references.
 *   - The drag handler in `module/item/consumable/document.ts`.
 *   - The actor sheet's drop handler.
 * This probe enumerates the live surface, picks a working path, and
 * captures the resulting item shape, rank/type constraints, and stack
 * behavior the tool layer needs to enforce or expose.
 *
 * Targets sandbox world. Test Valeros (wcD2h1fQmIxIab4B) is the
 * canonical victim. Test Valeros is a fighter with no spellcasting
 * entry — Q10 confirms get_item_details projects the create result;
 * the full use_item integration check is deferred to the Phase 3
 * mutation probe (or a campaign-time end-to-end test).
 *
 * Temp items are tagged with names beginning `__probe_create_scroll_or_wand_`
 * so the pre-probe scrub catches leftovers from interrupted prior runs.
 *
 * Findings the probe must answer (drives tool-code branching):
 *
 *   Q1.  Enumerate `globalThis.game.pf2e` top-level keys; flag any
 *        scroll/wand/consumable/spell-related entries.
 *   Q2.  Dump `CONFIG.PF2E` keys; identify any scroll/wand/consumable
 *        factory references or template-UUID config.
 *   Q3.  Walk the prototype chain of a sample ConsumablePF2e instance
 *        and enumerate static methods on its constructor. Specifically
 *        look for `fromSpell` (or anything matching /spell|scroll|wand|
 *        from/i).
 *   Q4.  Search `pf2e.equipment-srd` for generic template items named
 *        "Scroll", "Magic Wand", "Wand of …", etc. Capture UUIDs and
 *        the shape of their `system.spell` placeholder.
 *   Q5.  Drive the discovered creation API with Magic Missile (a known
 *        non-cantrip 1st-rank standard spell). Capture the resulting
 *        item's full `toObject()` payload, with attention to:
 *        - `system.spell` (UUID? embedded item? reference object?)
 *        - `system.level`, `system.price`, `system.uses`
 *        - `name` formatting
 *   Q6.  Heightening — try ranks 1, 3, 5 on Magic Missile. Note which
 *        succeed and how `system.spell.system.location.heightenedLevel`
 *        (or equivalent) reads back.
 *   Q7.  Spell-type exclusions — try Detect Magic (cantrip), a focus
 *        spell, a ritual. Capture how each fails or succeeds.
 *   Q8.  Rank bounds — rank 0, rank 11. Capture the failure mode.
 *   Q9.  Stacking — create two identical scrolls and two identical
 *        wands on the actor. Do they auto-merge, or stay separate?
 *   Q10. Sanity: feed the freshly-created scroll/wand back through the
 *        registered `get_item_details` tool and confirm `consumable.spell`
 *        populates correctly.
 *
 *   npm run build && node scripts/probe-create-scroll-or-wand-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';

const getItemDetailsTool = tools.find((t) => t.name === 'get_item_details');

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

async function callTool(tool, input) {
  if (!tool) return { isError: true, error: { message: 'tool not registered' } };
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { isError: true, validation: parsed.error.issues };
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

// Populated from Q2 (CONFIG.PF2E.spellcastingItems[kind].compendiumUuids).
// Downstream probes (Q5–Q10) read these to pick the rank-correct
// template for the manual-clone path.
let scrollByRank = {};
let wandByRank = {};

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub: remove __probe_create_scroll_or_wand_* leftovers
  // from prior runs.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    const orphans = actor.items.contents
      .filter(
        (i) =>
          typeof i.name === 'string' && i.name.startsWith('__probe_create_scroll_or_wand_'),
      )
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
  // Snapshot full toObject() payloads — Phase 1 may delete items via
  // autoDestroy paths, and teardown needs to recreate anything missing.
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
  // Discovery: locate spell UUIDs the probes need.
  //
  // The primary test spell is a rank-1 non-cantrip standard spell. PF2e
  // remaster renamed Magic Missile to Force Barrage, so we try both
  // names. As a final fallback, Heal works just as well — the spell
  // identity doesn't matter for API probing, only its category (standard,
  // not cantrip/focus/ritual) and rank (so we have headroom to probe
  // heightening at ranks 1/3/5).
  //
  // Also discovered:
  //  - Heal: rank-1 standard spell (Q9 stacking variety).
  //  - Fireball: rank-3 spell (heightening test ceiling for Q6).
  //  - Detect Magic: cantrip (Q7 exclusion test).
  //  - A focus spell + a ritual if findable (Q7).
  //  - Generic scroll/wand templates in equipment-srd (Q4).
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(async () => {
    const out = {
      spellsPackId: 'pf2e.spells-srd',
      equipmentPackId: 'pf2e.equipment-srd',
      primarySpellUuid: null,
      primarySpellName: null,
      primarySpellRank: null,
      healUuid: null,
      healRank: null,
      fireballUuid: null,
      fireballRank: null,
      detectMagicUuid: null,
      detectMagicIsCantrip: null,
      focusSpellUuid: null,
      ritualUuid: null,
      scrollTemplates: [],
      wandTemplates: [],
    };

    const spellsPack = globalThis.game.packs?.get(out.spellsPackId);
    if (spellsPack) {
      const idx = await spellsPack.getIndex({ fields: ['system.level', 'system.traits'] });
      const entries = idx.contents ?? [];

      const findByName = async (needle) => {
        const hit = entries.find(
          (e) => (e.name ?? '').toLowerCase() === needle.toLowerCase(),
        );
        if (!hit) return null;
        return {
          uuid: hit.uuid ?? `Compendium.${spellsPack.collection}.Item.${hit._id}`,
          name: hit.name,
          rank: hit.system?.level?.value ?? null,
          traits: hit.system?.traits?.value ?? [],
          isCantrip: Array.isArray(hit.system?.traits?.value)
            ? hit.system.traits.value.includes('cantrip')
            : false,
        };
      };

      const heal = await findByName('Heal');
      out.healUuid = heal?.uuid ?? null;
      out.healRank = heal?.rank ?? null;

      const fb = await findByName('Fireball');
      out.fireballUuid = fb?.uuid ?? null;
      out.fireballRank = fb?.rank ?? null;

      const dm = await findByName('Detect Magic');
      out.detectMagicUuid = dm?.uuid ?? null;
      out.detectMagicIsCantrip = dm?.isCantrip ?? null;

      // Primary spell: try Force Barrage (post-remaster) then Magic
      // Missile (legacy) then Heal (always-present fallback).
      const candidates = ['Force Barrage', 'Magic Missile'];
      for (const name of candidates) {
        const hit = await findByName(name);
        if (hit && hit.rank === 1 && !hit.isCantrip) {
          out.primarySpellUuid = hit.uuid;
          out.primarySpellName = hit.name;
          out.primarySpellRank = hit.rank;
          break;
        }
      }
      if (!out.primarySpellUuid && heal && heal.rank === 1 && !heal.isCantrip) {
        out.primarySpellUuid = heal.uuid;
        out.primarySpellName = heal.name;
        out.primarySpellRank = heal.rank;
      }

      // Focus spell: find any entry tagged 'focus' in traits. Scan the
      // first 200 entries to bound time.
      for (const e of entries.slice(0, 200)) {
        const traits = e.system?.traits?.value ?? [];
        if (Array.isArray(traits) && traits.includes('focus')) {
          out.focusSpellUuid = e.uuid ?? `Compendium.${spellsPack.collection}.Item.${e._id}`;
          break;
        }
      }

      // Ritual: PF2e splits rituals into their own pack pf2e.spells-srd
      // OR an entry with category 'ritual'. Look for `system.category ===
      // 'ritual'` first; fall back to scanning the dedicated rituals pack.
      const ritPack = globalThis.game.packs?.get('pf2e.rituals-srd');
      if (ritPack) {
        const ridx = await ritPack.getIndex();
        const rfirst = ridx.contents?.[0];
        if (rfirst) {
          out.ritualUuid =
            rfirst.uuid ?? `Compendium.${ritPack.collection}.Item.${rfirst._id}`;
        }
      }
    }

    const equipPack = globalThis.game.packs?.get(out.equipmentPackId);
    if (equipPack) {
      const idx = await equipPack.getIndex({ fields: ['type', 'system.category'] });
      const entries = idx.contents ?? [];

      // Scrolls: type=consumable, category=scroll. Capture every entry
      // that looks like a generic-rank template.
      const scrollEntries = entries.filter(
        (e) => e.type === 'consumable' && e.system?.category === 'scroll',
      );
      const wandEntries = entries.filter(
        (e) => e.type === 'consumable' && e.system?.category === 'wand',
      );
      // Generic templates: names typically include "Scroll of" / "Magic
      // Wand". Capture the first ~10 of each for inspection.
      out.scrollTemplates = scrollEntries.slice(0, 12).map((e) => ({
        name: e.name,
        uuid: e.uuid ?? `Compendium.${equipPack.collection}.Item.${e._id}`,
      }));
      out.wandTemplates = wandEntries.slice(0, 12).map((e) => ({
        name: e.name,
        uuid: e.uuid ?? `Compendium.${equipPack.collection}.Item.${e._id}`,
      }));
    }

    return out;
  });
  log.info({ discovery }, 'discovery: located spell + template UUIDs');
  record('discovery', 'spell + template UUIDs', discovery);

  if (!discovery.primarySpellUuid) {
    fail('discovery', 'no rank-1 standard spell found in pf2e.spells-srd — probe cannot continue', {
      discovery,
    });
    throw new Error('discovery failed');
  }

  // ====================================================================
  // Q1: enumerate game.pf2e for scroll/wand-related entries.
  // ====================================================================
  {
    const probe = await page.evaluate(() => {
      const pf2e = globalThis.game?.pf2e;
      if (!pf2e || typeof pf2e !== 'object') {
        return { error: 'game.pf2e not present' };
      }
      const topKeys = Object.keys(pf2e).sort();
      const interesting = topKeys.filter((k) =>
        /scroll|wand|consumable|spell|item|trick/i.test(k),
      );
      // For each interesting key, dump its type and (if function) its
      // own static method names.
      const detail = {};
      for (const k of interesting) {
        const v = pf2e[k];
        const type = typeof v;
        if (type === 'function') {
          const ownNames = Object.getOwnPropertyNames(v).filter(
            (n) => !['length', 'name', 'prototype'].includes(n),
          );
          detail[k] = { type, ownNames };
        } else if (type === 'object' && v !== null) {
          detail[k] = { type, keys: Object.keys(v).slice(0, 40) };
        } else {
          detail[k] = { type };
        }
      }
      return { topKeyCount: topKeys.length, interesting, detail };
    });
    record('Q1', 'game.pf2e surface (filtered to scroll|wand|consumable|spell|item|trick)', probe);
  }

  // ====================================================================
  // Q2: dump CONFIG.PF2E top-level keys; look for scroll/wand factories.
  // ====================================================================
  {
    const probe = await page.evaluate(() => {
      const cfg = globalThis.CONFIG?.PF2E;
      if (!cfg || typeof cfg !== 'object') return { error: 'CONFIG.PF2E not present' };
      const keys = Object.keys(cfg).sort();
      const interesting = keys.filter((k) => /scroll|wand|consumable|spell|trick|item/i.test(k));
      const detail = {};
      for (const k of interesting) {
        const v = cfg[k];
        if (typeof v === 'function') {
          detail[k] = { type: 'function', ownNames: Object.getOwnPropertyNames(v) };
        } else if (typeof v === 'object' && v !== null) {
          detail[k] = { type: 'object', keys: Object.keys(v).slice(0, 30) };
        } else {
          detail[k] = { type: typeof v, value: v };
        }
      }
      // Deep-dump CONFIG.PF2E.spellcastingItems — the canonical per-rank
      // template registry. Keys observed: ["scroll", "wand"]. Each
      // value has shape { name, nameTemplate, compendiumUuids } where
      // compendiumUuids is the per-rank template map we need.
      const spellcastingItems = cfg.spellcastingItems;
      let spellcastingDump = null;
      let scrollTemplatesByRank = null;
      let wandTemplatesByRank = null;
      if (spellcastingItems && typeof spellcastingItems === 'object') {
        spellcastingDump = {};
        for (const k of Object.keys(spellcastingItems)) {
          const v = spellcastingItems[k];
          if (typeof v === 'function') {
            spellcastingDump[k] = { type: 'function', name: v.name };
          } else if (typeof v === 'object' && v !== null) {
            const sub = {};
            for (const k2 of Object.keys(v)) {
              const v2 = v[k2];
              if (typeof v2 === 'string') {
                sub[k2] = { type: 'string', value: v2 };
              } else if (typeof v2 === 'object' && v2 !== null) {
                // Fully-dump the inner map (compendiumUuids et al).
                const inner = {};
                for (const k3 of Object.keys(v2)) {
                  inner[k3] = v2[k3];
                }
                sub[k2] = { type: 'object', entries: inner };
              } else {
                sub[k2] = { type: typeof v2, value: v2 };
              }
            }
            spellcastingDump[k] = { type: 'object', sample: sub };
          } else {
            spellcastingDump[k] = { type: typeof v, value: v };
          }
        }
        // Extract the rank-keyed UUID maps.
        const scrollEntry = spellcastingItems.scroll;
        const wandEntry = spellcastingItems.wand;
        if (scrollEntry?.compendiumUuids && typeof scrollEntry.compendiumUuids === 'object') {
          scrollTemplatesByRank = { ...scrollEntry.compendiumUuids };
        }
        if (wandEntry?.compendiumUuids && typeof wandEntry.compendiumUuids === 'object') {
          wandTemplatesByRank = { ...wandEntry.compendiumUuids };
        }
      }
      // Also look specifically at CONFIG.PF2E.Item.documentClasses for the
      // ConsumablePF2e class (the conventional path).
      const docClasses = cfg.Item?.documentClasses;
      const consumableClassName = docClasses?.consumable?.name ?? null;
      const consumableStatics = docClasses?.consumable
        ? Object.getOwnPropertyNames(docClasses.consumable).filter(
            (n) => !['length', 'name', 'prototype'].includes(n),
          )
        : null;
      return {
        topKeyCount: keys.length,
        interesting,
        detail,
        spellcastingDump,
        scrollTemplatesByRank,
        wandTemplatesByRank,
        consumableClassName,
        consumableStatics,
      };
    });
    record('Q2', 'CONFIG.PF2E surface (filtered)', probe);
    // Capture rank→UUID maps for downstream probes.
    scrollByRank = probe?.scrollTemplatesByRank ?? {};
    wandByRank = probe?.wandTemplatesByRank ?? {};
    log.info(
      {
        scrollByRankKeys: Object.keys(scrollByRank),
        wandByRankKeys: Object.keys(wandByRank),
      },
      'Q2: rank→template UUID maps extracted',
    );
  }

  // ====================================================================
  // Q3: ConsumablePF2e prototype + statics from a live instance.
  //
  // Create a throwaway healing potion on the actor, walk its prototype
  // chain, dump static method names on the constructor.
  // ====================================================================
  {
    const probe = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      // Use any consumable from the spells-srd compendium isn't right —
      // we need a *consumable*. Use a known potion UUID; if missing,
      // pull the first consumable index entry.
      const equipPack = globalThis.game.packs?.get('pf2e.equipment-srd');
      if (!equipPack) return { error: 'equipment-srd pack missing' };
      const idx = await equipPack.getIndex({ fields: ['type'] });
      const sampleConsumable = idx.contents?.find((e) => e.type === 'consumable');
      if (!sampleConsumable) return { error: 'no consumable found in equipment-srd' };
      const uuid =
        sampleConsumable.uuid ??
        `Compendium.${equipPack.collection}.Item.${sampleConsumable._id}`;
      const src = await fromUuid(uuid);
      const created = await actor.createEmbeddedDocuments('Item', [
        {
          ...src.toObject(),
          name: '__probe_create_scroll_or_wand_q3_consumable',
          system: { ...src.toObject().system, quantity: 1 },
        },
      ]);
      const item = created[0];

      // Walk the prototype chain — but stop before Foundry's base
      // `Document` class. Its `schema` getter (and other internals)
      // throw if invoked before the document subclass is fully
      // initialized, so probing past `Item` (the Foundry side) into
      // `Document` halts the whole probe.
      const STOP_AT = new Set(['Object', 'Function', 'Document', 'ClientDocument', 'DataModel']);
      const protoChain = [];
      let proto = Object.getPrototypeOf(item);
      while (proto && proto.constructor) {
        const n = proto.constructor.name;
        protoChain.push(n);
        if (STOP_AT.has(n)) break;
        proto = Object.getPrototypeOf(proto);
      }
      const ctor = item.constructor;
      // Static method names on ConsumablePF2e (and any inherited class
      // up to but not into the Foundry Document base).
      const collectStatics = (cls) => {
        const names = [];
        const dangerous = []; // property names whose getter threw
        let c = cls;
        while (c && c.name && !STOP_AT.has(c.name)) {
          let own;
          try {
            own = Object.getOwnPropertyNames(c).filter(
              (nm) => !['length', 'name', 'prototype'].includes(nm),
            );
          } catch {
            break;
          }
          for (const nm of own) {
            // typeof can invoke a getter, which throws on certain
            // Foundry internals — guard each access.
            let isFn = false;
            try {
              isFn = typeof c[nm] === 'function';
            } catch {
              dangerous.push(`${c.name}.${nm}`);
              continue;
            }
            if (isFn && !names.includes(`${c.name}.${nm}`)) {
              names.push(`${c.name}.${nm}`);
            }
          }
          c = Object.getPrototypeOf(c);
        }
        return { names, dangerous };
      };
      const collected = collectStatics(ctor);
      // Highlight anything matching /spell|scroll|wand|from|create/i.
      const interesting = collected.names.filter((n) =>
        /spell|scroll|wand|from|create/i.test(n),
      );

      await actor.deleteEmbeddedDocuments('Item', [item.id]);
      return {
        sampleUuid: uuid,
        protoChain,
        constructorName: ctor.name,
        staticsTotal: collected.names.length,
        statics: collected.names,
        dangerous: collected.dangerous,
        interesting,
      };
    }, PROBE_ACTOR_ID);
    record('Q3', 'ConsumablePF2e prototype chain + statics', probe);
    if (probe?.interesting && probe.interesting.length === 0) {
      log.warn(
        { probe },
        'Q3: no scroll/wand/spell/from/create statics on ConsumablePF2e — fallback path may be required',
      );
    }
  }

  // ====================================================================
  // Q4: generic scroll/wand template payloads from equipment-srd.
  //
  // Pull the toObject() shape of the first scroll and first wand
  // template item so we can see system.spell placeholders, system.level,
  // system.price tier, etc.
  // ====================================================================
  {
    if (discovery.scrollTemplates.length === 0 && discovery.wandTemplates.length === 0) {
      record('Q4', 'no scroll/wand templates found in equipment-srd', null);
    } else {
      const sampleScrollUuid = discovery.scrollTemplates[0]?.uuid ?? null;
      const sampleWandUuid = discovery.wandTemplates[0]?.uuid ?? null;
      const probe = await page.evaluate(
        async (scrollUuid, wandUuid) => {
          const inspect = async (uuid) => {
            if (!uuid) return null;
            const src = await fromUuid(uuid);
            const obj = src.toObject();
            return {
              uuid: src.uuid,
              name: src.name,
              type: src.type,
              category: obj.system?.category ?? null,
              level: obj.system?.level ?? null,
              levelValue: obj.system?.level?.value ?? null,
              spellShape: obj.system?.spell === null ? 'null' : typeof obj.system?.spell,
              spell: obj.system?.spell ?? null,
              priceShape: obj.system?.price ?? null,
              uses: obj.system?.uses ?? null,
              traits: obj.system?.traits?.value ?? [],
            };
          };
          return {
            scroll: await inspect(scrollUuid),
            wand: await inspect(wandUuid),
          };
        },
        sampleScrollUuid,
        sampleWandUuid,
      );
      record('Q4', 'generic scroll/wand template toObject shape', probe);
    }
  }

  // ====================================================================
  // Q5: drive the discovered API with the primary spell at its base rank.
  //
  // The probe attempts each candidate API path in order; whichever
  // produces a valid consumable on the actor is the path the tool will
  // use. Candidates (in priority order):
  //   A. CONFIG.PF2E.Item.documentClasses.consumable.fromSpell(spell, ...)
  //   B. game.pf2e.ConsumablePF2e.fromSpell(spell, ...)
  //   C. Manual: clone the rank-1 scroll template (from Q2's
  //      compendiumUuids map) + set system.spell to spell.toObject() with
  //      system.location.heightenedLevel.
  // ====================================================================
  let workingApi = null; // { name, options? }
  let createdItemShape = null;
  {
    if (!discovery.primarySpellUuid) {
      record('Q5', 'SKIPPED: primary spell UUID missing', null);
    } else {
      // Use the rank-1 scroll template from CONFIG.PF2E.spellcastingItems.
      // Fall back to the first discovery.scrollTemplates entry if the
      // map didn't populate (defensive).
      const rank1ScrollUuid =
        scrollByRank[1] ??
        scrollByRank['1'] ??
        discovery.scrollTemplates[0]?.uuid ??
        null;
      log.info({ rank1ScrollUuid }, 'Q5: using rank-1 scroll template');
      const probe = await page.evaluate(
        async (actorId, spellUuid, sampleScrollUuid) => {
          const actor = globalThis.game.actors?.get(actorId);
          const spell = await fromUuid(spellUuid);

          // Get a reference to the ConsumablePF2e class.
          const docClasses = globalThis.CONFIG?.PF2E?.Item?.documentClasses ?? {};
          const ConsumablePF2e = docClasses.consumable ?? null;
          const consumableClassName = ConsumablePF2e?.name ?? null;

          const tryFromSpell = async (cls, ctxLabel) => {
            if (!cls || typeof cls.fromSpell !== 'function') {
              return { ctxLabel, attempted: false, reason: 'no fromSpell static' };
            }
            try {
              // PF2e's signature has changed historically. Try the most
              // common shape: fromSpell(spell, heightenedLevel).
              const item = await cls.fromSpell(spell, spell.baseRank ?? spell.rank ?? 1);
              if (item && typeof item.toObject === 'function') {
                return {
                  ctxLabel,
                  attempted: true,
                  ok: true,
                  signatureUsed: 'fromSpell(spell, rank)',
                  toObject: item.toObject(),
                };
              }
              return { ctxLabel, attempted: true, ok: false, returnType: typeof item };
            } catch (e) {
              // Retry with options-object signature.
              try {
                const item = await cls.fromSpell(spell, {
                  heightenedLevel: spell.baseRank ?? spell.rank ?? 1,
                });
                if (item && typeof item.toObject === 'function') {
                  return {
                    ctxLabel,
                    attempted: true,
                    ok: true,
                    signatureUsed: 'fromSpell(spell, {heightenedLevel})',
                    toObject: item.toObject(),
                  };
                }
                return { ctxLabel, attempted: true, ok: false, returnType: typeof item };
              } catch (e2) {
                return {
                  ctxLabel,
                  attempted: true,
                  ok: false,
                  firstErr: e?.message ?? String(e),
                  secondErr: e2?.message ?? String(e2),
                };
              }
            }
          };

          // Candidate A: CONFIG.PF2E.Item.documentClasses.consumable
          const candidateA = await tryFromSpell(ConsumablePF2e, 'CONFIG.PF2E.Item.documentClasses.consumable');

          // Candidate B: game.pf2e.ConsumablePF2e (if exposed there).
          const exposedConsumable = globalThis.game?.pf2e?.ConsumablePF2e ?? null;
          const candidateB = await tryFromSpell(exposedConsumable, 'game.pf2e.ConsumablePF2e');

          // Candidate C: manual clone — load a rank-1 scroll template
          // from equipment-srd, copy its toObject(), splice in the spell
          // payload as system.spell. This is the fallback if neither
          // fromSpell candidate works.
          let candidateC = { ctxLabel: 'manual-clone-rank1-scroll-template', attempted: false };
          if (sampleScrollUuid) {
            try {
              const template = await fromUuid(sampleScrollUuid);
              const tmpl = template.toObject();
              const spellObj = spell.toObject();
              // Force heightened level on the embedded spell. The
              // location.heightenedLevel field is what PF2e reads on
              // consume to determine cast rank.
              if (spellObj.system) {
                spellObj.system.location = {
                  ...(spellObj.system.location ?? {}),
                  heightenedLevel: spell.baseRank ?? spell.rank ?? 1,
                };
              }
              tmpl.system = { ...(tmpl.system ?? {}) };
              tmpl.system.spell = spellObj;
              candidateC = {
                ctxLabel: 'manual-clone-rank1-scroll-template',
                attempted: true,
                ok: true,
                signatureUsed: 'manual-clone-template+inject-spell',
                toObject: tmpl,
              };
            } catch (e) {
              candidateC = {
                ctxLabel: 'manual-clone-rank1-scroll-template',
                attempted: true,
                ok: false,
                err: e?.message ?? String(e),
              };
            }
          }

          // If any candidate produced a toObject, create the item on
          // the actor so we can verify the persisted shape too.
          let persisted = null;
          const winningPayload =
            candidateA?.toObject ?? candidateB?.toObject ?? candidateC?.toObject ?? null;
          let winningSignature = candidateA?.toObject
            ? candidateA.signatureUsed
            : candidateB?.toObject
              ? candidateB.signatureUsed
              : candidateC?.toObject
                ? candidateC.signatureUsed
                : null;
          let winningCtxLabel = candidateA?.toObject
            ? candidateA.ctxLabel
            : candidateB?.toObject
              ? candidateB.ctxLabel
              : candidateC?.toObject
                ? candidateC.ctxLabel
                : null;
          if (winningPayload) {
            const data = { ...winningPayload };
            const sys = { ...(data.system ?? {}) };
            sys.quantity = 1;
            data.system = sys;
            data.name = `__probe_create_scroll_or_wand_q5_${winningCtxLabel.replace(/[^a-z0-9]/gi, '_')}`;
            const created = await actor.createEmbeddedDocuments('Item', [data]);
            const item = created[0];
            persisted = {
              id: item.id,
              uuid: item.uuid,
              name: item.name,
              type: item.type,
              category: item.system?.category ?? null,
              levelValue: item.system?.level?.value ?? null,
              spellPresent: item.system?.spell != null,
              spellName: item.system?.spell?.name ?? null,
              spellLevel: item.system?.spell?.system?.location?.heightenedLevel ?? null,
              quantity: item.system?.quantity ?? null,
              usesValue: item.system?.uses?.value ?? null,
              usesMax: item.system?.uses?.max ?? null,
              toObject: item.toObject(),
            };
            await actor.deleteEmbeddedDocuments('Item', [item.id]);
          }

          return {
            consumableClassName,
            spellInfo: {
              name: spell.name,
              uuid: spell.uuid,
              type: spell.type,
              baseRank: spell.baseRank ?? null,
              rank: spell.rank ?? null,
              traits: spell.system?.traits?.value ?? [],
            },
            candidateA,
            candidateB,
            candidateC,
            winningSignature,
            winningCtxLabel,
            persisted,
          };
        },
        PROBE_ACTOR_ID,
        discovery.primarySpellUuid,
        rank1ScrollUuid,
      );
      record('Q5', 'fromSpell candidate trials + persisted shape', probe);
      if (probe.persisted) {
        workingApi = {
          name: 'fromSpell',
          ctxLabel: probe.winningCtxLabel,
          signature: probe.winningSignature,
        };
        createdItemShape = probe.persisted;
        log.info(
          { workingApi, persistedSummary: { name: probe.persisted.name, category: probe.persisted.category } },
          'Q5: working API path identified',
        );
      } else {
        fail('Q5', 'no fromSpell candidate produced a valid item — fallback path required', probe);
      }
    }
  }

  // ====================================================================
  // Q6: heightening — Magic Missile at ranks 1, 3, 5 as scrolls.
  //
  // Skips if Q5 didn't find a working API. Captures the
  // system.spell.system.location.heightenedLevel readback for each.
  // ====================================================================
  if (workingApi && discovery.primarySpellUuid) {
    try {
      const probe = await page.evaluate(
        async (actorId, spellUuid, scrollMap) => {
          const actor = globalThis.game.actors?.get(actorId);
          const spell = await fromUuid(spellUuid);
          // Inlined manual-clone helper.
          const makeScroll = async (rank) => {
            const templateUuid = scrollMap[rank] ?? scrollMap[String(rank)] ?? null;
            if (!templateUuid) {
              return { ok: false, err: `no scroll template for rank ${rank}` };
            }
            const template = await fromUuid(templateUuid);
            if (!template) {
              return { ok: false, err: `template UUID ${templateUuid} did not resolve` };
            }
            const data = template.toObject();
            data.system = { ...(data.system ?? {}), quantity: 1 };
            const spellObj = spell.toObject();
            if (spellObj.system) {
              spellObj.system.location = {
                ...(spellObj.system.location ?? {}),
                heightenedLevel: rank,
              };
            }
            data.system.spell = spellObj;
            data.name = `__probe_create_scroll_or_wand_q6_rank${rank}`;
            const created = await actor.createEmbeddedDocuments('Item', [data]);
            const persisted = created[0];
            const result = {
              ok: true,
              templateUuid,
              persistedId: persisted.id,
              name: persisted.name,
              templateLevel: persisted.system?.level?.value ?? null,
              spellHeightenedLevel:
                persisted.system?.spell?.system?.location?.heightenedLevel ?? null,
              spellBaseLevel: persisted.system?.spell?.system?.level?.value ?? null,
            };
            await actor.deleteEmbeddedDocuments('Item', [persisted.id]);
            return result;
          };
          const results = {};
          for (const rank of [1, 3, 5]) {
            try {
              results[rank] = await makeScroll(rank);
            } catch (e) {
              results[rank] = { ok: false, err: e?.message ?? String(e) };
            }
          }
          return results;
        },
        PROBE_ACTOR_ID,
        discovery.primarySpellUuid,
        scrollByRank,
      );
      record('Q6', 'heightening: scroll of rank 1/3/5', probe);
    } catch (e) {
      record('Q6', 'EXCEPTION', { err: e?.message ?? String(e) });
    }
  } else {
    record('Q6', 'SKIPPED: no working API or spell UUID', null);
  }

  // ====================================================================
  // Q7: spell-type exclusions — cantrip, focus spell, ritual.
  //
  // For each, manually clone a rank-1 scroll template and inject the
  // spell. PF2e doesn't natively prevent us from creating these in the
  // document layer (the schema layer accepts any spell), but the
  // resulting item may produce a UI warning at use time or behave
  // unexpectedly. The tool's policy decision lives in the evaluator —
  // reject cantrip/focus/ritual at the validation layer because they
  // don't have a meaningful scroll/wand equivalent in PF2e rules.
  // ====================================================================
  if (workingApi) {
    try {
      const probe = await page.evaluate(
        async (actorId, scrollMap, cantripUuid, focusUuid, ritualUuid) => {
          const actor = globalThis.game.actors?.get(actorId);
          const templateUuid = scrollMap[1] ?? scrollMap['1'] ?? null;
          if (!templateUuid) return { error: 'no rank-1 scroll template available' };
          const attempt = async (label, uuid) => {
            if (!uuid) return { label, skipped: 'no UUID' };
            let spell;
            try {
              spell = await fromUuid(uuid);
            } catch (e) {
              return { label, lookupErr: e?.message ?? String(e) };
            }
            const spellInfo = {
              name: spell?.name ?? null,
              type: spell?.type ?? null,
              traits: spell?.system?.traits?.value ?? [],
              category: spell?.system?.category ?? null,
              baseRank: spell?.baseRank ?? null,
              spellRank: spell?.rank ?? null,
              isCantrip: Array.isArray(spell?.system?.traits?.value)
                ? spell.system.traits.value.includes('cantrip')
                : false,
              isFocus: Array.isArray(spell?.system?.traits?.value)
                ? spell.system.traits.value.includes('focus')
                : false,
              isRitual: spell?.system?.category === 'ritual' || spell?.type === 'ritual',
            };
            // Try to manually clone-inject; observe whether the
            // document layer accepts it.
            const template = await fromUuid(templateUuid);
            const data = template.toObject();
            const spellObj = spell.toObject();
            if (spellObj.system) {
              spellObj.system.location = {
                ...(spellObj.system.location ?? {}),
                heightenedLevel: spell?.baseRank ?? 1,
              };
            }
            data.system = { ...(data.system ?? {}), quantity: 1, spell: spellObj };
            data.name = `__probe_create_scroll_or_wand_q7_${label}`;
            let createErr = null;
            let createdId = null;
            try {
              const created = await actor.createEmbeddedDocuments('Item', [data]);
              createdId = created[0]?.id ?? null;
            } catch (e) {
              createErr = e?.message ?? String(e);
            }
            if (createdId) {
              await actor.deleteEmbeddedDocuments('Item', [createdId]).catch(() => undefined);
            }
            return {
              label,
              spellInfo,
              persisted: !!createdId,
              createErr,
            };
          };

          return {
            cantrip: await attempt('cantrip', cantripUuid),
            focus: await attempt('focus', focusUuid),
            ritual: await attempt('ritual', ritualUuid),
          };
        },
        PROBE_ACTOR_ID,
        scrollByRank,
        discovery.detectMagicUuid,
        discovery.focusSpellUuid,
        discovery.ritualUuid,
      );
      record('Q7', 'spell-type exclusions (cantrip / focus / ritual)', probe);
    } catch (e) {
      record('Q7', 'EXCEPTION', { err: e?.message ?? String(e) });
    }
  } else {
    record('Q7', 'SKIPPED: no working API', null);
  }

  // ====================================================================
  // Q8: rank bounds — rank 0, rank 11. The tool layer will validate via
  // zod, but the probe documents what the manual-clone path does when
  // given an out-of-bounds rank: typically the template lookup just
  // returns undefined and creation never starts.
  // ====================================================================
  if (workingApi && discovery.primarySpellUuid) {
    try {
      const probe = await page.evaluate(
        async (actorId, spellUuid, scrollMap) => {
          const scrollKeys = Object.keys(scrollMap);
          const mapHasRank = (rank) =>
            scrollMap[rank] != null || scrollMap[String(rank)] != null;
          return {
            scrollMapKeys: scrollKeys,
            rank0HasTemplate: mapHasRank(0),
            rank11HasTemplate: mapHasRank(11),
            rank20HasTemplate: mapHasRank(20),
            rank1HasTemplate: mapHasRank(1),
            rank10HasTemplate: mapHasRank(10),
          };
        },
        PROBE_ACTOR_ID,
        discovery.primarySpellUuid,
        scrollByRank,
      );
      record('Q8', 'rank bounds — scrollMap coverage', probe);
    } catch (e) {
      record('Q8', 'EXCEPTION', { err: e?.message ?? String(e) });
    }
  } else {
    record('Q8', 'SKIPPED: no working API or spell UUID', null);
  }

  // ====================================================================
  // Q9: stacking — two identical scrolls. The add_item_to_actor
  // evaluator already documents that PF2e does NOT auto-merge on
  // createEmbeddedDocuments — we expect the same here, since manual-
  // clone uses the same API. Confirm.
  // ====================================================================
  if (workingApi && discovery.primarySpellUuid) {
    try {
      const probe = await page.evaluate(
        async (actorId, spellUuid, scrollMap) => {
          const actor = globalThis.game.actors?.get(actorId);
          const templateUuid = scrollMap[1] ?? scrollMap['1'] ?? null;
          if (!templateUuid) return { error: 'no rank-1 scroll template available' };
          const spell = await fromUuid(spellUuid);
          const template = await fromUuid(templateUuid);

          const buildPayload = (label) => {
            const data = template.toObject();
            const spellObj = spell.toObject();
            if (spellObj.system) {
              spellObj.system.location = {
                ...(spellObj.system.location ?? {}),
                heightenedLevel: 1,
              };
            }
            data.system = { ...(data.system ?? {}), quantity: 1, spell: spellObj };
            data.name = `__probe_create_scroll_or_wand_q9_${label}`;
            return data;
          };

          const beforeCount = actor.items.size;
          const created = await actor.createEmbeddedDocuments('Item', [
            buildPayload('scrollA'),
            buildPayload('scrollB'),
          ]);
          const afterCount = actor.items.size;
          const summary = created.map((c) => ({
            id: c.id,
            name: c.name,
            category: c.system?.category ?? null,
            quantity: c.system?.quantity ?? null,
            sourceUuid: c._stats?.compendiumSource ?? null,
          }));
          await actor.deleteEmbeddedDocuments(
            'Item',
            created.map((c) => c.id),
          );
          return {
            beforeCount,
            afterCount,
            deltaCount: afterCount - beforeCount,
            createdAsSeparateEntries: created.length === 2,
            summary,
          };
        },
        PROBE_ACTOR_ID,
        discovery.primarySpellUuid,
        scrollByRank,
      );
      record('Q9', 'two identical scrolls — stacking behavior', probe);
    } catch (e) {
      record('Q9', 'EXCEPTION', { err: e?.message ?? String(e) });
    }
  } else {
    record('Q9', 'SKIPPED: no working API or spell UUID', null);
  }

  // ====================================================================
  // Q10: sanity — create a rank-1 scroll, run get_item_details against
  // it, confirm the consumable.spell projection populates.
  // ====================================================================
  if (workingApi && discovery.primarySpellUuid) {
    try {
      const setup = await page.evaluate(
        async (actorId, spellUuid, scrollMap) => {
          const actor = globalThis.game.actors?.get(actorId);
          const templateUuid = scrollMap[1] ?? scrollMap['1'] ?? null;
          if (!templateUuid) return { error: 'no rank-1 scroll template available' };
          const spell = await fromUuid(spellUuid);
          const template = await fromUuid(templateUuid);
          const data = template.toObject();
          const spellObj = spell.toObject();
          if (spellObj.system) {
            spellObj.system.location = {
              ...(spellObj.system.location ?? {}),
              heightenedLevel: 1,
            };
          }
          data.system = { ...(data.system ?? {}), quantity: 1, spell: spellObj };
          data.name = '__probe_create_scroll_or_wand_q10_scroll';
          const created = await actor.createEmbeddedDocuments('Item', [data]);
          return { id: created[0].id, uuid: created[0].uuid, name: created[0].name };
        },
        PROBE_ACTOR_ID,
        discovery.primarySpellUuid,
        scrollByRank,
      );

      if (setup?.error) {
        record('Q10', 'setup error', setup);
      } else {
        const details = await callTool(getItemDetailsTool, { uuid: setup.uuid });

        record('Q10', 'get_item_details on freshly-created scroll', {
          createdId: setup.id,
          createdName: setup.name,
          detailsOk: details.ok === true,
          consumablePresent: details.ok && details.data?.consumable != null,
          consumableSpellPresent: details.ok && details.data?.consumable?.spell != null,
          consumableSpellName: details.ok ? details.data?.consumable?.spell?.name ?? null : null,
          consumableCategory: details.ok ? details.data?.consumable?.category ?? null : null,
          consumableUses: details.ok ? details.data?.consumable?.uses ?? null : null,
        });

        // Cleanup the Q10 scroll.
        await page.evaluate(
          async (actorId, itemId) => {
            const actor = globalThis.game.actors?.get(actorId);
            if (actor.items.get(itemId)) {
              await actor.deleteEmbeddedDocuments('Item', [itemId]);
            }
          },
          PROBE_ACTOR_ID,
          setup.id,
        );
      }
    } catch (e) {
      record('Q10', 'EXCEPTION', { err: e?.message ?? String(e) });
    }
  } else {
    record('Q10', 'SKIPPED: no working API', null);
  }

  // --------------------------------------------------------------------
  // Teardown — restore actor to start-of-probe snapshot signature.
  //
  // Each Q-probe deletes its temps inline; teardown sweeps leftovers
  // (probes that threw before cleanup) and restores any drifted
  // quantities or container assignments. Pattern lifted from
  // probe-use-item-phase1.mjs teardown.
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
    fail('teardown', 'multiset signature mismatch', teardown);
  }

  // --------------------------------------------------------------------
  // Final report.
  // --------------------------------------------------------------------
  log.info(
    {
      workingApi,
      createdItemSummary: createdItemShape
        ? {
            name: createdItemShape.name,
            category: createdItemShape.category,
            spellPresent: createdItemShape.spellPresent,
            spellName: createdItemShape.spellName,
          }
        : null,
      findingCount: findings.length,
      errorCount: errors.length,
    },
    'PHASE 1 SUMMARY',
  );
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
