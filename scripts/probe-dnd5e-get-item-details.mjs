/**
 * Probe for `dnd5e_get_item_details`. Two phases in one file.
 *
 * Read-only — `fromUuid` only, no mutation, no world teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-get-item-details.mjs
 *
 * PHASE 1 — raw-shape discovery. Dumps the live dnd5e 5.x Item schema so
 * the evaluator's field paths are probe-verified, not ported from the PF2e
 * sibling on faith. Asserts the load-bearing invariants: `system.properties`
 * and `system.damage.base.types` are `Set`s, `system.advancement` is a
 * Map-like `AdvancementCollection`, `item.labels` is populated post-fromUuid,
 * the physical-vs-non-physical `system.quantity` split.
 *
 * PHASE 2 — evaluator exercise. Runs the compiled evaluator
 * (`dist/evaluators/dnd5e-get-item-details.js`) inside the headless Foundry
 * client exactly as the MCP tool handler does, and asserts every per-type
 * projection plus the error / descriptionFormat / opt-in paths.
 *
 * Targets (compendium-resident — the probe does not assume a world item):
 *   weapon      Frost Brand Scimitar   Compendium.dnd5e.items.Item.07R6JFioylOCpVoL
 *   equipment   Studded Leather +3     Compendium.dnd5e.items.Item.00BggOkChWztQx6R
 *   consumable  Candle                 Compendium.dnd5e.items.Item.0NoBBP3MMkvJlwZY
 *   scroll      Spell Scroll 1st Level Compendium.dnd5e.items.Item.9GSfMg0VOA2b4uFN
 *   container   Jug                    Compendium.dnd5e.items.Item.0ZBWwjFz3nIAXMLW
 *   tool        Tinker's Tools         Compendium.dnd5e.items.Item.0d08g1i5WXnNrCNA
 *   loot        Paper                  Compendium.dnd5e.items.Item.0huCWvOncUsme84v
 *   spell       Polymorph              Compendium.dnd5e.spells.Item.04nMsTWkIFvkbXlY
 *   feat        Shelter of the Faithful Compendium.dnd5e.backgrounds.Item.64N1NWh9kC1dI7zN
 *   background  Acolyte                Compendium.dnd5e.backgrounds.Item.IgJkSnLiLJOWH7eK
 *   class       Sorcerer               Compendium.dnd5e.classes.Item.6T08zzKtmmpVwlXU
 *   subclass    Draconic Bloodline     Compendium.dnd5e.subclasses.Item.2nadB2MBSHTQ0kcl
 *   race        High Elf               Compendium.dnd5e.races.Item.A69KxdH1renVPrQV
 *   facility    resolved live (skipped if no facility item exists)
 *   actor       Goblin (WRONG_DOCUMENT_TYPE) Compendium.dnd5e.monsters.Actor.TjWQOgI3A4UAl7lC
 */
import { BrowserSession } from '../dist/browser/session.js';
import { dnd5eGetItemDetailsBody } from '../dist/evaluators/dnd5e-get-item-details.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const UUID = {
  weapon: 'Compendium.dnd5e.items.Item.07R6JFioylOCpVoL',
  equipment: 'Compendium.dnd5e.items.Item.00BggOkChWztQx6R',
  consumable: 'Compendium.dnd5e.items.Item.0NoBBP3MMkvJlwZY',
  scroll: 'Compendium.dnd5e.items.Item.9GSfMg0VOA2b4uFN',
  container: 'Compendium.dnd5e.items.Item.0ZBWwjFz3nIAXMLW',
  tool: 'Compendium.dnd5e.items.Item.0d08g1i5WXnNrCNA',
  loot: 'Compendium.dnd5e.items.Item.0huCWvOncUsme84v',
  spell: 'Compendium.dnd5e.spells.Item.04nMsTWkIFvkbXlY',
  feat: 'Compendium.dnd5e.backgrounds.Item.64N1NWh9kC1dI7zN',
  background: 'Compendium.dnd5e.backgrounds.Item.IgJkSnLiLJOWH7eK',
  class: 'Compendium.dnd5e.classes.Item.6T08zzKtmmpVwlXU',
  subclass: 'Compendium.dnd5e.subclasses.Item.2nadB2MBSHTQ0kcl',
  race: 'Compendium.dnd5e.races.Item.A69KxdH1renVPrQV',
};
const ACTOR_UUID = 'Compendium.dnd5e.monsters.Actor.TjWQOgI3A4UAl7lC';
const BOGUS_UUID = 'Item.deadbeefdeadbeef';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    log.info({ detail }, `PASS — ${name}`);
  } else {
    failures += 1;
    log.error({ detail }, `FAIL — ${name}`);
  }
};

try {
  const { page } = await session.ensureStarted();

  // ======================================================================
  // PHASE 1 — raw-shape discovery.
  // ======================================================================
  log.info('=== PHASE 1: raw-shape discovery ===');

  const shapes = await page.evaluate(async (uuids) => {
    const wpn = await fromUuid(uuids.weapon);
    const spell = await fromUuid(uuids.spell);
    const cls = await fromUuid(uuids.class);
    const container = await fromUuid(uuids.container);
    const adv = cls.system.advancement;
    return {
      itemDataModels: Object.keys(CONFIG.Item.dataModels).sort(),
      weapon: {
        propertiesIsSet: wpn.system.properties instanceof Set,
        damageTypesIsSet: wpn.system.damage?.base?.types instanceof Set,
        labelsPopulated: !!wpn.labels && typeof wpn.labels.damage === 'string',
        hasQuantity: typeof wpn.system.quantity === 'number',
        priceKeys: Object.keys(wpn.system.price || {}).sort(),
        usesKeys: Object.keys(wpn.system.uses || {}).sort(),
        typeFieldIsObject: !!wpn.system.type && typeof wpn.system.type === 'object',
      },
      spell: {
        labelsPopulated: !!spell.labels && typeof spell.labels.level === 'string',
        hasQuantity: typeof spell.system.quantity === 'number',
        hasTypeField: typeof spell.system.type !== 'undefined',
      },
      class: {
        advancementMapLike: typeof adv?.size === 'number' && Array.isArray(adv?.contents),
        advancementSize: typeof adv?.size === 'number' ? adv.size : null,
      },
      container: {
        hasQuantity: typeof container.system.quantity === 'number',
        hasUses: typeof container.system.uses !== 'undefined',
      },
    };
  }, UUID);

  log.info({ shapes }, 'phase-1 raw shapes');
  const EXPECTED_TYPES = [
    'background', 'class', 'consumable', 'container', 'equipment', 'facility',
    'feat', 'loot', 'race', 'spell', 'subclass', 'tool', 'weapon',
  ];
  check('P1 CONFIG.Item.dataModels covers the 13 expected types',
    EXPECTED_TYPES.every((t) => shapes.itemDataModels.includes(t)),
    shapes.itemDataModels);
  check('P1 weapon system.properties is a Set', shapes.weapon.propertiesIsSet);
  check('P1 weapon damage.base.types is a Set', shapes.weapon.damageTypesIsSet);
  check('P1 weapon item.labels populated post-fromUuid', shapes.weapon.labelsPopulated);
  check('P1 weapon price is {value, denomination, valueInGP}',
    ['denomination', 'value', 'valueInGP'].every((k) => shapes.weapon.priceKeys.includes(k)),
    shapes.weapon.priceKeys);
  check('P1 weapon uses carries spent/max/recovery/value',
    ['max', 'recovery', 'spent', 'value'].every((k) => shapes.weapon.usesKeys.includes(k)),
    shapes.weapon.usesKeys);
  check('P1 weapon system.type is an object', shapes.weapon.typeFieldIsObject);
  check('P1 spell item.labels populated', shapes.spell.labelsPopulated);
  check('P1 physical/non-physical split: weapon has quantity, spell does not',
    shapes.weapon.hasQuantity && !shapes.spell.hasQuantity);
  check('P1 spell has no system.type field', !shapes.spell.hasTypeField);
  check('P1 class system.advancement is a Map-like AdvancementCollection',
    shapes.class.advancementMapLike && shapes.class.advancementSize > 0,
    shapes.class);
  check('P1 container has no system.uses', !shapes.container.hasUses);

  // Resolve a facility item if the world has one.
  const facilityUuid = await page.evaluate(async () => {
    for (const pack of game.packs.filter((p) => p.documentName === 'Item')) {
      const idx = await pack.getIndex();
      const hit = idx.find((e) => e.type === 'facility');
      if (hit) return `Compendium.${pack.collection}.Item.${hit._id}`;
    }
    return null;
  });

  // ======================================================================
  // PHASE 2 — evaluator exercise.
  // ======================================================================
  log.info('=== PHASE 2: evaluator exercise ===');

  const run = (uuid, opts = {}) =>
    page.evaluate(dnd5eGetItemDetailsBody, {
      uuid,
      descriptionFormat: opts.descriptionFormat ?? 'both',
      includeEffects: opts.includeEffects ?? false,
      includeRawSystem: opts.includeRawSystem ?? false,
    });

  // S1 — weapon.
  const s1 = await run(UUID.weapon);
  check('S1 weapon ok + weapon block + physical block',
    s1.ok && !!s1.weapon && !!s1.physical && s1.type === 'weapon' &&
      Array.isArray(s1.weapon.damage.parts) && s1.weapon.damage.parts.length > 0 &&
      s1.physical.priceFormatted.length > 0,
    s1.ok ? { name: s1.name, weapon: s1.weapon, physical: s1.physical, uses: s1.uses } : s1);
  check('S1 weapon damage.base.types resolved from Set',
    s1.ok && Array.isArray(s1.weapon.damage.base.types),
    s1.ok ? s1.weapon.damage.base : s1);

  // S2 — equipment (armor).
  const s2 = await run(UUID.equipment);
  check('S2 equipment ok + armor projection + physical block',
    s2.ok && !!s2.equipment && s2.equipment.armor && typeof s2.equipment.armor.value === 'number' &&
      !!s2.physical && s2.rarity === 'legendary',
    s2.ok ? { name: s2.name, equipment: s2.equipment } : s2);

  // S3 — consumable + scroll subtype.
  const s3 = await run(UUID.consumable);
  check('S3 consumable ok + consumable block + physical block',
    s3.ok && !!s3.consumable && !!s3.physical && typeof s3.consumable.consumableType === 'string',
    s3.ok ? { name: s3.name, consumable: s3.consumable } : s3);
  const s3b = await run(UUID.scroll);
  check('S3b spell scroll → consumableType "scroll"',
    s3b.ok && s3b.consumable?.consumableType === 'scroll',
    s3b.ok ? s3b.consumable : s3b);

  // S4 — tool.
  const s4 = await run(UUID.tool);
  check('S4 tool ok + tool block (ability=int) + physical block',
    s4.ok && !!s4.tool && s4.tool.ability === 'int' && !!s4.physical,
    s4.ok ? { name: s4.name, tool: s4.tool } : s4);

  // S5 — loot.
  const s5 = await run(UUID.loot);
  check('S5 loot ok + loot block + physical block (equipped false)',
    s5.ok && !!s5.loot && !!s5.physical && s5.physical.equipped === false,
    s5.ok ? { name: s5.name, loot: s5.loot, physical: s5.physical } : s5);

  // S6 — container.
  const s6 = await run(UUID.container);
  check('S6 container ok + capacity/currency + physical block + no uses',
    s6.ok && !!s6.container && !!s6.container.capacity && !!s6.container.currency &&
      !!s6.physical && s6.uses === undefined,
    s6.ok ? { name: s6.name, container: s6.container } : s6);

  // S7 — spell (no physical block).
  const s7 = await run(UUID.spell);
  check('S7 spell ok + spell block (level 4, school trs) + NO physical block',
    s7.ok && !!s7.spell && s7.spell.level === 4 && s7.spell.school === 'trs' &&
      !!s7.spell.components && s7.physical === undefined,
    s7.ok ? { name: s7.name, spell: s7.spell } : s7);

  // S8 — feat.
  const s8 = await run(UUID.feat);
  check('S8 feat ok + feat block (featType, advancement summary)',
    s8.ok && !!s8.feat && typeof s8.feat.featType === 'string' && Array.isArray(s8.feat.advancement),
    s8.ok ? { name: s8.name, feat: s8.feat } : s8);

  // S9 — background.
  const s9 = await run(UUID.background);
  check('S9 background ok + startingEquipment array + advancement',
    s9.ok && !!s9.background && Array.isArray(s9.background.startingEquipment) &&
      Array.isArray(s9.background.advancement),
    s9.ok ? { name: s9.name, background: s9.background } : s9);

  // S10 — class.
  const s10 = await run(UUID.class);
  check('S10 class ok + hitDice + spellcasting + non-empty advancement summary',
    s10.ok && !!s10.class && s10.class.hitDice === 'd6' && !!s10.class.spellcasting &&
      Array.isArray(s10.class.advancement) && s10.class.advancement.length > 0,
    s10.ok ? { name: s10.name, class: s10.class } : s10);

  // S11 — subclass.
  const s11 = await run(UUID.subclass);
  check('S11 subclass ok + classIdentifier "sorcerer"',
    s11.ok && !!s11.subclass && s11.subclass.classIdentifier === 'sorcerer',
    s11.ok ? { name: s11.name, subclass: s11.subclass } : s11);

  // S12 — race.
  const s12 = await run(UUID.race);
  check('S12 race ok + creatureType + senses (darkvision 60)',
    s12.ok && !!s12.race && s12.race.creatureType?.value === 'humanoid' &&
      s12.race.senses.darkvision === 60,
    s12.ok ? { name: s12.name, race: s12.race } : s12);

  // S13 — facility (skipped if the world has none).
  if (facilityUuid) {
    const s13 = await run(facilityUuid);
    check('S13 facility ok + facility block projected',
      s13.ok && s13.type === 'facility' && !!s13.facility,
      s13.ok ? { name: s13.name, facility: s13.facility } : s13);
  } else {
    log.warn('S13 skipped — no facility item in the world compendia');
  }

  // S14 — error paths.
  const s14a = await run(BOGUS_UUID);
  check('S14a bogus UUID → NOT_FOUND', !s14a.ok && s14a.error.code === 'NOT_FOUND', s14a);
  const s14b = await run(ACTOR_UUID);
  check('S14b Actor UUID → WRONG_DOCUMENT_TYPE',
    !s14b.ok && s14b.error.code === 'WRONG_DOCUMENT_TYPE', s14b);

  // S15 — descriptionFormat field-presence.
  const s15h = await run(UUID.weapon, { descriptionFormat: 'html' });
  const s15t = await run(UUID.weapon, { descriptionFormat: 'text' });
  check('S15 descriptionFormat html → description only',
    s15h.ok && s15h.description !== undefined && s15h.descriptionText === undefined);
  check('S15 descriptionFormat text → descriptionText only',
    s15t.ok && s15t.descriptionText !== undefined && s15t.description === undefined);

  // S16 — opt-ins.
  const s16 = await run(UUID.weapon, { includeEffects: true, includeRawSystem: true });
  check('S16 includeEffects → effects array present', s16.ok && Array.isArray(s16.effects));
  check('S16 includeRawSystem → rawSystem object present',
    s16.ok && s16.rawSystem !== undefined && typeof s16.rawSystem === 'object');
  const s16b = await run(UUID.spell);
  check('S16b rawSystem omitted by default for a projected type',
    s16b.ok && s16b.rawSystem === undefined);

  if (failures > 0) {
    log.error({ failures }, 'probe completed with failures');
    process.exitCode = 1;
  } else {
    log.info('probe completed — all scenarios passed');
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
