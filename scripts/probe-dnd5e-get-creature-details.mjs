/**
 * Probe for `dnd5e_get_creature_details`. Two phases in one file.
 *
 * Read-only — `fromUuid` only, no mutation, no world teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-get-creature-details.mjs
 *
 * PHASE 1 — raw-shape discovery. Dumps the live dnd5e 5.x actor/item
 * schema so the evaluator's field paths are probe-verified, not ported
 * from the PF2e sibling on faith. Asserts the load-bearing invariants:
 * traits.di/ci `.value` are `Set`s, `item.system.activities` is a Map-like
 * `ActivityCollection`, `item.labels` is populated post-`fromUuid`.
 *
 * PHASE 2 — evaluator exercise. Runs the compiled evaluator
 * (`dist/evaluators/dnd5e-get-creature-details.js`) inside the headless
 * Foundry client exactly as the MCP tool handler does, and asserts the
 * NPC / vehicle projections plus every error path.
 *
 * Targets (compendium-resident — the probe does not assume a world actor):
 *   NPC 2014   Goblin        Compendium.dnd5e.monsters.Actor.TjWQOgI3A4UAl7lC
 *   NPC 2024   Goblin Warrior Compendium.dnd5e.actors24.Actor.mmGoblinWarrior0
 *   Caster     Mage          Compendium.dnd5e.monsters.Actor.mQnsXanewsPiV7QE
 *   Immunities Skeleton      Compendium.dnd5e.monsters.Actor.nU8GN8La8DCt8SDb
 *   Vehicle    Longship      Compendium.dnd5e.actors24.Actor.phbmobLongship00
 *   Item       Leather Armor Compendium.dnd5e.items.WwdpHLXGX5r8uZu5
 *   PC         resolved live from game.actors (skipped if none exist)
 */
import { BrowserSession } from '../dist/browser/session.js';
import { dnd5eGetCreatureDetailsBody } from '../dist/evaluators/dnd5e-get-creature-details.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const NPC_2014 = 'Compendium.dnd5e.monsters.Actor.TjWQOgI3A4UAl7lC';
const NPC_2024 = 'Compendium.dnd5e.actors24.Actor.mmGoblinWarrior0';
const CASTER = 'Compendium.dnd5e.monsters.Actor.mQnsXanewsPiV7QE';
const IMMUNE = 'Compendium.dnd5e.monsters.Actor.nU8GN8La8DCt8SDb';
const VEHICLE = 'Compendium.dnd5e.actors24.Actor.phbmobLongship00';
const ITEM_UUID = 'Compendium.dnd5e.items.WwdpHLXGX5r8uZu5';
const BOGUS_UUID = 'Actor.deadbeefdeadbeef';

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

  const shapes = await page.evaluate(
    async (uuids) => {
      const npc = await fromUuid(uuids.npc);
      const sk = await fromUuid(uuids.immune);
      const veh = await fromUuid(uuids.vehicle);
      const wpn = npc.items.find((i) => i.type === 'weapon');
      const acts = wpn?.system?.activities;
      const t = sk.system.traits;
      return {
        actorDataModels: Object.keys(CONFIG.Actor.dataModels),
        npc: {
          type: npc.type,
          sysKeys: Object.keys(npc.system),
          crType: typeof npc.system.details.cr,
          detailsTypeIsObject:
            npc.system.details.type !== null && typeof npc.system.details.type === 'object',
          abilityStrKeys: Object.keys(npc.system.abilities.str),
          skillSteKeys: Object.keys(npc.system.skills.ste),
          sourceLabel: npc.system.source?.label,
        },
        traitsAreSets: {
          diIsSet: t.di.value instanceof Set,
          ciIsSet: t.ci.value instanceof Set,
          diArr: Array.from(t.di.value || []),
          ciArr: Array.from(t.ci.value || []),
        },
        weapon: {
          name: wpn?.name,
          activitiesIsMapLike:
            typeof acts?.getByType === 'function' && typeof acts?.size === 'number',
          activitiesObjKeysEmpty: Object.keys(acts || {}).length === 0,
          labelsPopulated: Array.isArray(wpn?.labels?.attacks) && wpn.labels.attacks.length > 0,
        },
        vehicle: {
          type: veh.type,
          detailsTypeIsString: typeof veh.system.details.type === 'string',
          hpKeys: Object.keys(veh.system.attributes.hp),
          hasCapacity: !!veh.system.attributes.capacity,
        },
      };
    },
    { npc: NPC_2014, immune: IMMUNE, vehicle: VEHICLE },
  );

  log.info({ shapes }, 'phase-1 raw shapes');
  check(
    'P1 actor data models include npc + vehicle',
    shapes.actorDataModels.includes('npc') && shapes.actorDataModels.includes('vehicle'),
    shapes.actorDataModels,
  );
  check('P1 NPC details.cr is a number', shapes.npc.crType === 'number');
  check('P1 NPC details.type is an object', shapes.npc.detailsTypeIsObject);
  check(
    'P1 NPC ability carries score+mod+save+proficient',
    ['value', 'mod', 'save', 'proficient'].every((k) => shapes.npc.abilityStrKeys.includes(k)),
    shapes.npc.abilityStrKeys,
  );
  check(
    'P1 NPC skill carries proficient+total+passive',
    ['proficient', 'total', 'passive'].every((k) => shapes.npc.skillSteKeys.includes(k)),
    shapes.npc.skillSteKeys,
  );
  check(
    'P1 traits.di/ci .value are Sets',
    shapes.traitsAreSets.diIsSet && shapes.traitsAreSets.ciIsSet,
  );
  check(
    'P1 Skeleton immunities populate (poison / poisoned)',
    shapes.traitsAreSets.diArr.includes('poison') &&
      shapes.traitsAreSets.ciArr.includes('poisoned'),
    shapes.traitsAreSets,
  );
  check(
    'P1 item.system.activities is a Map-like ActivityCollection',
    shapes.weapon.activitiesIsMapLike && shapes.weapon.activitiesObjKeysEmpty,
  );
  check('P1 item.labels populated post-fromUuid', shapes.weapon.labelsPopulated);
  check('P1 vehicle details.type is a bare string', shapes.vehicle.detailsTypeIsString);
  check(
    'P1 vehicle hp carries dt (damage threshold)',
    shapes.vehicle.hpKeys.includes('dt'),
    shapes.vehicle.hpKeys,
  );

  // Resolve a world PC for the ACTOR_TYPE_UNSUPPORTED path.
  const pcUuid = await page.evaluate(() => {
    const pc = game.actors.find((a) => a.type === 'character');
    return pc ? pc.uuid : null;
  });

  // ======================================================================
  // PHASE 2 — evaluator exercise.
  // ======================================================================
  log.info('=== PHASE 2: evaluator exercise ===');

  const run = (uuid, opts = {}) =>
    page.evaluate(dnd5eGetCreatureDetailsBody, {
      uuid,
      descriptionFormat: opts.descriptionFormat ?? 'both',
      includeEffects: opts.includeEffects ?? false,
      includeRawSystem: opts.includeRawSystem ?? false,
    });

  // S1 — NPC base projection.
  const s1 = await run(NPC_2014);
  check(
    'S1 NPC ok + npc block populated',
    s1.ok &&
      !!s1.npc &&
      typeof s1.npc.ac.value === 'number' &&
      s1.npc.hp.max > 0 &&
      s1.npc.abilities.str.score > 0 &&
      Array.isArray(s1.npc.saves) &&
      s1.npc.saves.length === 6,
    s1.ok ? { name: s1.name, cr: s1.cr, ac: s1.npc.ac, hp: s1.npc.hp } : s1,
  );
  check(
    'S1 NPC attacks projected from item labels',
    s1.ok && s1.npc.attacks.length > 0 && typeof s1.npc.attacks[0].attackBonus === 'string',
    s1.ok ? s1.npc.attacks : null,
  );
  check(
    'S1 NPC features projected (Nimble Escape)',
    s1.ok && s1.npc.features.some((f) => /nimble/i.test(f.name)),
    s1.ok ? s1.npc.features.map((f) => f.name) : null,
  );
  check(
    'S1 NPC creatureType + size populated',
    s1.ok && s1.creatureType?.value === 'humanoid' && s1.size === 'sm',
    s1.ok ? { creatureType: s1.creatureType, size: s1.size } : null,
  );

  // S2 — 2024-ruleset NPC parses on the same field paths.
  const s2 = await run(NPC_2024);
  check(
    'S2 2024-ruleset NPC parses identically',
    s2.ok && !!s2.npc && s2.npc.hp.max > 0 && s2.npc.abilities.dex.score > 0,
    s2.ok ? { name: s2.name, source: s2.source } : s2,
  );

  // S3 — caster spellcasting.
  const s3 = await run(CASTER);
  check(
    'S3 caster spellcasting populated',
    s3.ok &&
      s3.npc?.spellcasting &&
      s3.npc.spellcasting.ability === 'int' &&
      s3.npc.spellcasting.saveDc > 0 &&
      s3.npc.spellcasting.slots.length > 0 &&
      s3.npc.spellcasting.knownSpellCount > 0,
    s3.ok ? s3.npc.spellcasting : s3,
  );

  // S4 — immunity creature damage interactions.
  const s4 = await run(IMMUNE);
  check(
    'S4 damage interactions resolve Sets to arrays',
    s4.ok &&
      s4.npc.damageInteractions.immunities.includes('poison') &&
      s4.npc.damageInteractions.conditionImmunities.includes('poisoned'),
    s4.ok ? s4.npc.damageInteractions : s4,
  );

  // S5 — vehicle projection.
  const s5 = await run(VEHICLE);
  check(
    'S5 vehicle ok + vehicle block populated',
    s5.ok &&
      !!s5.vehicle &&
      s5.vehicle.vehicleType.length > 0 &&
      s5.vehicle.hp.max > 0 &&
      typeof s5.vehicle.hp.damageThreshold === 'number' &&
      !!s5.vehicle.capacity,
    s5.ok ? { name: s5.name, vehicle: s5.vehicle } : s5,
  );

  // S6 — error paths.
  const s6a = await run(BOGUS_UUID);
  check('S6a bogus UUID → NOT_FOUND', !s6a.ok && s6a.error.code === 'NOT_FOUND', s6a);
  const s6b = await run(ITEM_UUID);
  check(
    'S6b Item UUID → WRONG_DOCUMENT_TYPE',
    !s6b.ok && s6b.error.code === 'WRONG_DOCUMENT_TYPE',
    s6b,
  );
  if (pcUuid) {
    const s6c = await run(pcUuid);
    check(
      'S6c PC actor → ACTOR_TYPE_UNSUPPORTED (points at dnd5e_get_actor_state)',
      !s6c.ok &&
        s6c.error.code === 'ACTOR_TYPE_UNSUPPORTED' &&
        /dnd5e_get_actor_state/.test(s6c.error.message),
      s6c,
    );
  } else {
    log.warn('S6c skipped — no world PC actor to test ACTOR_TYPE_UNSUPPORTED');
  }

  // S7 — descriptionFormat field-presence.
  const s7h = await run(NPC_2014, { descriptionFormat: 'html' });
  const s7t = await run(NPC_2014, { descriptionFormat: 'text' });
  check(
    'S7 descriptionFormat html → description only',
    s7h.ok && s7h.description !== undefined && s7h.descriptionText === undefined,
  );
  check(
    'S7 descriptionFormat text → descriptionText only',
    s7t.ok && s7t.descriptionText !== undefined && s7t.description === undefined,
  );

  // S8 — opt-ins.
  const s8 = await run(NPC_2014, { includeEffects: true, includeRawSystem: true });
  check('S8 includeEffects → effects array present', s8.ok && Array.isArray(s8.effects));
  check(
    'S8 includeRawSystem → rawSystem object present',
    s8.ok && s8.rawSystem !== undefined && typeof s8.rawSystem === 'object',
  );

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
