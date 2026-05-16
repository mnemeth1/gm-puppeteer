/**
 * Phase 1 design-blocking probes for get_creature_details. Run BEFORE
 * the evaluator is written; the projection paths hang on the answers.
 *
 * Read-only: no actor/item mutations. All targets resolved from the
 * compendium via `fromUuid` or `pack.getDocument`.
 *
 * Findings expected:
 *   Q0. Pack discovery — which compendium collections hold actors of
 *       type npc / hazard / familiar.
 *   Q1. NPC mixed-weapon shape — does a creature with both melee and
 *       ranged attacks store BOTH as embedded items of type 'melee'
 *       with a `ranged` trait, or differently on v14/PF2e 8.1.2?
 *   Q2. Hazard shape — paths for hardness, hp/bt, stealth, disable,
 *       routine, reset, isComplex, saves, attacks (simple + complex).
 *   Q3. Familiar shape — `system.master` path, presence/absence of
 *       `system.abilities`, hp/ac/speed paths.
 *   Q4. NPC HP path — confirm `system.attributes.hp.{value, max, temp}`
 *       across 3 bestiary NPCs.
 *   Q5. NPC spellcasting shape — compare `entry.type`,
 *       `system.prepared.value`, `system.tradition.value`, slot shape
 *       to PC casters.
 *   Q6. NPC skills shape — curated vs exhaustive, `value`/`label`/`slug`.
 *
 *   npm run build && node scripts/probe-get-creature-details-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

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

  // ====================================================================
  // Q0. Pack discovery.
  //
  // List every Actor-type compendium pack and characterize the actor
  // types it carries. Used to pick concrete targets for the later probes.
  // ====================================================================
  const packDiscovery = await page.evaluate(async () => {
    const out = [];
    const packs = globalThis.game?.packs ? Array.from(globalThis.game.packs) : [];
    for (const pack of packs) {
      if (pack.documentName !== 'Actor') continue;
      let typesSeen = {};
      let total = 0;
      try {
        const idx = await pack.getIndex();
        total = idx.contents.length;
        for (const e of idx.contents) {
          const t = e.type ?? '?';
          typesSeen[t] = (typesSeen[t] ?? 0) + 1;
        }
      } catch (err) {
        typesSeen = { __error: err?.message ?? String(err) };
      }
      out.push({ collection: pack.collection, title: pack.title, total, typesSeen });
    }
    return out;
  });
  record('Q0', 'Actor-type pack inventory', packDiscovery);

  // Pick concrete targets from the discovery results.
  const findPackByTypes = (predicate) => packDiscovery.find((p) => predicate(p.typesSeen ?? {}));
  const bestiaryPack = findPackByTypes((t) => (t.npc ?? 0) > 50);
  const hazardPack = findPackByTypes((t) => (t.hazard ?? 0) > 0);
  const familiarPack = findPackByTypes((t) => (t.familiar ?? 0) > 0);

  log.info(
    {
      bestiary: bestiaryPack?.collection,
      hazards: hazardPack?.collection,
      familiars: familiarPack?.collection,
    },
    'chosen probe targets',
  );

  if (!bestiaryPack) {
    fail('Q0', 'no bestiary-shaped pack found', { packDiscovery });
  }

  // ====================================================================
  // Q1 + Q4 + Q5 + Q6. NPC shape probes.
  //
  // Pull 3 bestiary NPCs spanning a level range. For each: HP path,
  // skills shape, strikes shape, spellcasting shape (if caster).
  // Look for one with both melee + ranged attacks (Q1).
  // ====================================================================
  if (bestiaryPack) {
    const npcShape = await page.evaluate(async (collection) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };
      const idx = await pack.getIndex();

      // Pick three by name where possible to make the probe reproducible.
      const wantNames = ['goblin warrior', 'lich', 'orc warrior'];
      const targets = [];
      for (const want of wantNames) {
        const hit = idx.contents.find(
          (e) => e.type === 'npc' && (e.name ?? '').toLowerCase() === want,
        );
        if (hit) targets.push(hit);
      }
      // Fallback: any 3 NPCs (first by index).
      if (targets.length < 3) {
        for (const e of idx.contents) {
          if (e.type !== 'npc') continue;
          if (targets.find((t) => t._id === e._id)) continue;
          targets.push(e);
          if (targets.length >= 3) break;
        }
      }

      const results = [];
      for (const t of targets) {
        const doc = await pack.getDocument(t._id);
        if (!doc) continue;
        const sys = doc.system ?? {};

        // HP path
        const hpRaw = sys.attributes?.hp;
        const hpProbe = {
          value: hpRaw?.value ?? null,
          max: hpRaw?.max ?? null,
          temp: hpRaw?.temp ?? null,
          tempHpField: hpRaw?.tempHp ?? null,
          hasTempField: hpRaw && 'temp' in hpRaw,
          allKeys: hpRaw ? Object.keys(hpRaw) : [],
        };

        // AC path
        const acRaw = sys.attributes?.ac;

        // Saves
        const saves = sys.saves ?? {};

        // Skills (Q6 — curated vs exhaustive)
        const skillsRaw = sys.skills ?? {};
        const skillEntries = Object.entries(skillsRaw).map(([slug, raw]) => ({
          slug,
          label: raw?.label ?? null,
          value: raw?.value ?? null,
          totalModifier: raw?.totalModifier ?? null,
          base: raw?.base ?? null,
          rank: raw?.rank ?? null,
          allKeys: Object.keys(raw ?? {}),
        }));

        // Strikes from system.actions[]
        const actionsArr = Array.isArray(sys.actions) ? sys.actions : [];
        const strikeProjections = actionsArr.slice(0, 6).map((a) => ({
          slug: a?.slug ?? null,
          label: a?.label ?? null,
          type: a?.type ?? null,
          weaponType: a?.weaponType ?? null,
          item: a?.item ? { id: a.item.id, type: a.item.type, name: a.item.name } : null,
          itemId: a?.item?.id ?? null,
          attackBonus: a?.totalModifier ?? a?.modifier ?? null,
          variantsCount: Array.isArray(a?.variants) ? a.variants.length : null,
          variantModifiers: Array.isArray(a?.variants)
            ? a.variants.map((v) => v?.label ?? null).slice(0, 3)
            : null,
          allKeys: a ? Object.keys(a).slice(0, 20) : [],
        }));

        // Embedded melee-type items (Q1 — also covers ranged strikes?)
        const meleeItems = doc.items.contents.filter((i) => i.type === 'melee');
        const meleeShapes = meleeItems.slice(0, 6).map((i) => ({
          name: i.name,
          type: i.type,
          weaponType: i.system?.weaponType?.value ?? i.system?.weaponType ?? null,
          range: i.system?.weaponType?.value === 'ranged' ? (i.system?.range ?? null) : null,
          traits: i.system?.traits?.value ?? null,
          allSystemKeys: Object.keys(i.system ?? {}),
          damageRolls: i.system?.damageRolls
            ? Object.values(i.system.damageRolls).slice(0, 3)
            : null,
          attackModifier: i.system?.bonus?.value ?? null,
        }));

        // Other item types on actor
        const itemTypeCounts = {};
        for (const i of doc.items.contents) {
          itemTypeCounts[i.type] = (itemTypeCounts[i.type] ?? 0) + 1;
        }

        // Spellcasting (Q5)
        let spellcastingProbe = null;
        try {
          const sc = [];
          if (doc.spellcasting && typeof doc.spellcasting[Symbol.iterator] === 'function') {
            for (const entry of doc.spellcasting) {
              sc.push({
                id: entry?.id ?? null,
                name: entry?.name ?? null,
                type: entry?.type ?? null,
                category: entry?.system?.prepared?.value ?? null,
                tradition: entry?.system?.tradition?.value ?? null,
                slotKeys: entry?.system?.slots ? Object.keys(entry.system.slots) : [],
                slot0Max: entry?.system?.slots?.slot0?.max ?? null,
                slot1Max: entry?.system?.slots?.slot1?.max ?? null,
                slot1Prepared: Array.isArray(entry?.system?.slots?.slot1?.prepared)
                  ? entry.system.slots.slot1.prepared.length
                  : null,
                isRitual: entry?.type === 'rituals' || entry?.id?.endsWith?.('-rituals') === true,
              });
            }
          }
          spellcastingProbe = sc;
        } catch (err) {
          spellcastingProbe = { __error: err?.message ?? String(err) };
        }

        // Action items (passive/free/reaction abilities)
        const actionItems = doc.items.contents.filter((i) => i.type === 'action');
        const actionShapes = actionItems.slice(0, 4).map((i) => ({
          name: i.name,
          actionType: i.system?.actionType?.value ?? null,
          actions: i.system?.actions?.value ?? null,
          category: i.system?.category ?? null,
          traits: i.system?.traits?.value ?? null,
          allSystemKeys: Object.keys(i.system ?? {}),
        }));

        results.push({
          name: doc.name,
          level: sys.details?.level?.value ?? null,
          uuid: doc.uuid,
          itemTypeCounts,
          hp: hpProbe,
          ac: { value: acRaw?.value ?? null, allKeys: acRaw ? Object.keys(acRaw) : [] },
          savesKeys: Object.keys(saves),
          fortitudeShape: saves.fortitude ? Object.keys(saves.fortitude) : [],
          fortitudeValue: saves.fortitude?.value ?? null,
          perceptionKeys: Object.keys(sys.perception ?? {}),
          perceptionValue: sys.perception?.value ?? null,
          sensesShape: Array.isArray(sys.perception?.senses)
            ? sys.perception.senses.slice(0, 4)
            : null,
          languagesPath: sys.details?.languages?.value ?? null,
          speedsKeys: Object.keys(sys.attributes?.speed ?? sys.movement?.speeds ?? {}),
          speedShape: sys.attributes?.speed ?? sys.movement?.speeds ?? null,
          traits: sys.traits?.value ?? null,
          rarity: sys.traits?.rarity ?? null,
          size: sys.traits?.size?.value ?? null,
          publication: sys.details?.publication ?? sys.publication ?? null,
          slugPath1: sys.slug ?? null,
          slugPath2: sys.details?.slug ?? null,
          skillCount: skillEntries.length,
          skillSample: skillEntries.slice(0, 6),
          strikeCount: actionsArr.length,
          strikeSample: strikeProjections,
          meleeItemCount: meleeItems.length,
          meleeItemShapes: meleeShapes,
          spellcasting: spellcastingProbe,
          actionItemCount: actionItems.length,
          actionItemShapes: actionShapes,
        });
      }
      return { results };
    }, bestiaryPack.collection);
    record('Q1_Q4_Q5_Q6', 'NPC shape (3 samples)', npcShape);
  }

  // ====================================================================
  // Q2. Hazard shape (simple + complex).
  // ====================================================================
  if (hazardPack) {
    const hazardShape = await page.evaluate(async (collection) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };
      const idx = await pack.getIndex();
      const all = idx.contents.filter((e) => e.type === 'hazard');

      // Load first ~5 to identify a simple vs complex pair.
      const probes = [];
      for (const e of all.slice(0, 8)) {
        const doc = await pack.getDocument(e._id);
        if (!doc) continue;
        const sys = doc.system ?? {};
        probes.push({
          name: doc.name,
          uuid: doc.uuid,
          level: sys.details?.level?.value ?? null,
          isComplex: sys.details?.isComplex ?? null,
          allDetailsKeys: Object.keys(sys.details ?? {}),
          allAttributesKeys: Object.keys(sys.attributes ?? {}),
          allSystemKeys: Object.keys(sys),
          hardness: sys.attributes?.hardness ?? null,
          hardnessShape:
            typeof sys.attributes?.hardness === 'object'
              ? Object.keys(sys.attributes.hardness)
              : null,
          hp: sys.attributes?.hp ?? null,
          stealth: sys.attributes?.stealth ?? null,
          stealthDC: sys.attributes?.stealth?.dc ?? null,
          stealthValue: sys.attributes?.stealth?.value ?? null,
          disable:
            typeof sys.details?.disable === 'string'
              ? sys.details.disable.slice(0, 120)
              : (sys.details?.disable ?? null),
          routine:
            typeof sys.details?.routine === 'string'
              ? sys.details.routine.slice(0, 120)
              : (sys.details?.routine ?? null),
          reset:
            typeof sys.details?.reset === 'string'
              ? sys.details.reset.slice(0, 120)
              : (sys.details?.reset ?? null),
          saves: sys.saves ?? null,
          actionsCount: Array.isArray(sys.actions) ? sys.actions.length : null,
          itemTypeCounts: doc.items.contents.reduce((m, i) => {
            m[i.type] = (m[i.type] ?? 0) + 1;
            return m;
          }, {}),
          publication: sys.details?.publication ?? null,
          slug: sys.details?.slug ?? null,
          traits: sys.traits?.value ?? null,
        });
      }
      return { totalHazards: all.length, sampled: probes.length, probes };
    }, hazardPack.collection);
    record('Q2', 'Hazard shape (sampled)', hazardShape);
  } else {
    record('Q2', 'no hazard pack found — skipped', null);
  }

  // ====================================================================
  // Q3. Familiar shape.
  // ====================================================================
  if (familiarPack) {
    const familiarShape = await page.evaluate(async (collection) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };
      const idx = await pack.getIndex();
      const all = idx.contents.filter((e) => e.type === 'familiar');

      const probes = [];
      for (const e of all.slice(0, 3)) {
        const doc = await pack.getDocument(e._id);
        if (!doc) continue;
        const sys = doc.system ?? {};
        probes.push({
          name: doc.name,
          uuid: doc.uuid,
          level: sys.details?.level?.value ?? null,
          allSystemKeys: Object.keys(sys),
          allAttributesKeys: Object.keys(sys.attributes ?? {}),
          allDetailsKeys: Object.keys(sys.details ?? {}),
          master: sys.master ?? null,
          masterPath2: sys.details?.master ?? null,
          hasAbilities: 'abilities' in sys,
          abilitiesShape: sys.abilities ? Object.keys(sys.abilities) : null,
          hp: sys.attributes?.hp ?? null,
          ac: sys.attributes?.ac ?? null,
          speedShape: sys.attributes?.speed ?? sys.movement?.speeds ?? null,
          perception: sys.perception ?? null,
          sensesShape: Array.isArray(sys.perception?.senses)
            ? sys.perception.senses.slice(0, 4)
            : null,
          itemTypeCounts: doc.items.contents.reduce((m, i) => {
            m[i.type] = (m[i.type] ?? 0) + 1;
            return m;
          }, {}),
          traits: sys.traits?.value ?? null,
          size: sys.traits?.size?.value ?? null,
        });
      }
      return { totalFamiliars: all.length, sampled: probes.length, probes };
    }, familiarPack.collection);
    record('Q3', 'Familiar shape (sampled)', familiarShape);
  } else {
    record('Q3', 'no familiar pack found — sampling bestiary instead', null);

    // Fallback: bestiary may have type=familiar entries.
    if (bestiaryPack) {
      const fallback = await page.evaluate(async (collection) => {
        const pack = globalThis.game.packs?.get(collection);
        if (!pack) return { error: `pack ${collection} not loaded` };
        const idx = await pack.getIndex();
        const all = idx.contents.filter((e) => e.type === 'familiar');
        return {
          count: all.length,
          sample: all.slice(0, 3).map((e) => ({ name: e.name, uuid: e.uuid })),
        };
      }, bestiaryPack.collection);
      record('Q3_fallback', 'familiars in bestiary?', fallback);
    }
  }

  // ====================================================================
  // Summary.
  // ====================================================================
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
