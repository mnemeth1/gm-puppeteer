/**
 * Probe for `dnd5e_get_actor_state`. Two phases in one file.
 *
 * Read-only — `game.actors.get` only, NO mutation, NO world teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-get-actor-state.mjs
 *
 * PRECONDITION: the live dnd5e world must contain at least one `character`
 * actor (a PC). The probe resolves PCs/NPCs live from `game.actors` — it
 * does not assume compendium UUIDs. If no PC exists, the probe errors out.
 *
 * PHASE 1 — raw-shape discovery. Dumps the live dnd5e 5.x character/npc
 * runtime-state schema so the evaluator's field paths are probe-verified,
 * not ported from the PF2e sibling on faith. Pins the load-bearing
 * unknowns: character level field, class/race/background item shapes,
 * `actor.statuses` Set, the Active-Effect ↔ status linkage, death-save key
 * names, exhaustion/inspiration, `system.resources`, the `hd` hit-dice
 * data model.
 *
 * PHASE 2 — evaluator exercise. Runs the compiled evaluator
 * (`dist/evaluators/dnd5e-get-actor-state.js`) inside the headless Foundry
 * client exactly as the MCP tool handler does, and asserts the
 * character / npc projections, the opt-in flags, and every error path.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { dnd5eGetActorStateBody } from '../dist/evaluators/dnd5e-get-actor-state.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const BOGUS_ID = 'deadbeefdeadbeef';

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

  const shapes = await page.evaluate(() => {
    const pc = game.actors.find((a) => a.type === 'character');
    const npc = game.actors.find((a) => a.type === 'npc');
    if (!pc) return { noPc: true };

    const dump = (actor) => {
      if (!actor) return null;
      const sys = actor.system;
      const itemTypes = {};
      for (const it of actor.items.contents) {
        itemTypes[it.type] = (itemTypes[it.type] ?? 0) + 1;
      }
      const classItem = actor.items.find((i) => i.type === 'class');
      const subclassItem = actor.items.find((i) => i.type === 'subclass');
      const raceItem = actor.items.find((i) => i.type === 'race');
      const bgItem = actor.items.find((i) => i.type === 'background');
      const hd = sys.attributes?.hd;
      return {
        type: actor.type,
        sysKeys: Object.keys(sys),
        detailsKeys: Object.keys(sys.details ?? {}),
        levelType: typeof sys.details?.level,
        levelValue: sys.details?.level,
        crType: typeof sys.details?.cr,
        xp: sys.details?.xp ?? null,
        detailsType: sys.details?.type,
        itemTypes,
        classItem: classItem
          ? { name: classItem.name, sysKeys: Object.keys(classItem.system) }
          : null,
        subclassItem: subclassItem
          ? { name: subclassItem.name, sysKeys: Object.keys(subclassItem.system) }
          : null,
        raceName: raceItem?.name ?? null,
        backgroundName: bgItem?.name ?? null,
        statusesIsSet: actor.statuses instanceof Set,
        statuses: Array.from(actor.statuses ?? []),
        effects: actor.effects.contents.map((e) => ({
          id: e.id,
          name: e.name,
          disabled: e.disabled,
          statuses: Array.from(e.statuses ?? []),
          durationSeconds: e.duration?.seconds ?? null,
        })),
        hasAppliedEffects: Array.isArray(actor.appliedEffects),
        exhaustionType: typeof sys.attributes?.exhaustion,
        exhaustionValue: sys.attributes?.exhaustion,
        death: sys.attributes?.death ?? null,
        deathKeys: Object.keys(sys.attributes?.death ?? {}),
        inspirationType: typeof sys.attributes?.inspiration,
        resources: sys.resources ?? null,
        resourceKeys: Object.keys(sys.resources ?? {}),
        hdTypeof: typeof hd,
        hdCtor: hd?.constructor?.name ?? null,
        hdValue: hd?.value,
        hdMax: hd?.max,
        abilityStrKeys: Object.keys(sys.abilities?.str ?? {}),
        skillPrcKeys: Object.keys(sys.skills?.prc ?? {}),
        sensesKeys: Object.keys(sys.attributes?.senses ?? {}),
        movementKeys: Object.keys(sys.attributes?.movement ?? {}),
        hp: sys.attributes?.hp ?? null,
        ac: sys.attributes?.ac ?? null,
        spellcastingAbility: sys.attributes?.spellcasting,
        spellKeys: Object.keys(sys.spells ?? {}),
        hasCombatant: actor.combatant != null,
        inCombat: actor.inCombat,
      };
    };

    return {
      actorDataModels: Object.keys(CONFIG.Actor.dataModels),
      pcId: pc.id,
      pcName: pc.name,
      npcId: npc?.id ?? null,
      npcName: npc?.name ?? null,
      pc: dump(pc),
      npc: dump(npc),
    };
  });

  if (shapes.noPc) {
    log.error('PRECONDITION FAILED — no `character` actor in the world; cannot probe');
    process.exitCode = 1;
    throw new Error('no PC actor');
  }

  log.info({ shapes }, 'phase-1 raw shapes');
  check(
    'P1 actor data models include character + npc',
    shapes.actorDataModels.includes('character') && shapes.actorDataModels.includes('npc'),
    shapes.actorDataModels,
  );
  check('P1 PC details.level is a number', shapes.pc.levelType === 'number', shapes.pc.levelValue);
  check('P1 PC has a class item', !!shapes.pc.classItem, shapes.pc.classItem);
  check(
    'P1 PC statuses is a Set',
    shapes.pc.statusesIsSet,
    { statuses: shapes.pc.statuses },
  );
  check(
    'P1 PC ability carries value+mod+save+proficient',
    ['value', 'mod', 'save', 'proficient'].every((k) => shapes.pc.abilityStrKeys.includes(k)),
    shapes.pc.abilityStrKeys,
  );
  check(
    'P1 PC skill carries proficient+total+passive',
    ['proficient', 'total', 'passive'].every((k) => shapes.pc.skillPrcKeys.includes(k)),
    shapes.pc.skillPrcKeys,
  );
  check(
    'P1 PC death-save block present',
    shapes.pc.death !== null,
    { death: shapes.pc.death, keys: shapes.pc.deathKeys },
  );
  check('P1 PC exhaustion is numeric', shapes.pc.exhaustionType === 'number', shapes.pc.exhaustionValue);
  check('P1 PC hd hit-dice block', shapes.pc.hdTypeof !== 'undefined', {
    ctor: shapes.pc.hdCtor,
    value: shapes.pc.hdValue,
    max: shapes.pc.hdMax,
  });
  log.info(
    {
      death: shapes.pc.death,
      resources: shapes.pc.resources,
      inspirationType: shapes.pc.inspirationType,
      hd: { ctor: shapes.pc.hdCtor, value: shapes.pc.hdValue, max: shapes.pc.hdMax },
      itemTypes: shapes.pc.itemTypes,
      classSysKeys: shapes.pc.classItem?.sysKeys,
      subclassSysKeys: shapes.pc.subclassItem?.sysKeys,
    },
    'phase-1 KEY UNKNOWNS — inspect before writing the evaluator',
  );

  // ======================================================================
  // PHASE 2 — evaluator exercise.
  // ======================================================================
  log.info('=== PHASE 2: evaluator exercise ===');

  const run = (actorId, opts = {}) =>
    page.evaluate(dnd5eGetActorStateBody, {
      actorId,
      includeSkills: opts.includeSkills ?? false,
      includeSpellcasting: opts.includeSpellcasting ?? false,
      includeEncounterState: opts.includeEncounterState ?? false,
      includeRawSystem: opts.includeRawSystem ?? false,
    });

  // S1 — PC base projection.
  const s1 = await run(shapes.pcId);
  check(
    'S1 PC ok + base projection populated',
    s1.ok &&
      s1.actor.type === 'character' &&
      s1.actor.level > 0 &&
      Array.isArray(s1.actor.classes) &&
      s1.actor.classes.length >= 1 &&
      s1.hp.max > 0 &&
      typeof s1.ac.value === 'number' &&
      s1.abilities.str.score > 0 &&
      Array.isArray(s1.saves) &&
      s1.saves.length === 6 &&
      Array.isArray(s1.conditions) &&
      Array.isArray(s1.effects) &&
      !!s1.vitals.deathSaves &&
      !!s1.resources,
    s1.ok ? { actor: s1.actor, hp: s1.hp, ac: s1.ac, vitals: s1.vitals } : s1,
  );
  check(
    'S1 PC encounter is the default {inCombat} shape',
    s1.ok && typeof s1.encounter.inCombat === 'boolean' && s1.encounter.combatId === undefined,
    s1.ok ? s1.encounter : null,
  );

  // S2 — NPC base projection (resources/vitals degrade cleanly).
  if (shapes.npcId) {
    const s2 = await run(shapes.npcId);
    check(
      'S2 NPC ok + cr populated + blocks degrade cleanly',
      s2.ok &&
        s2.actor.type === 'npc' &&
        typeof s2.actor.cr === 'number' &&
        s2.hp.max > 0 &&
        Array.isArray(s2.conditions) &&
        !!s2.resources &&
        !!s2.vitals,
      s2.ok ? { actor: s2.actor, resources: s2.resources, vitals: s2.vitals } : s2,
    );
  } else {
    log.warn('S2 skipped — no world NPC actor');
  }

  // S3 — includeSkills.
  const s3 = await run(shapes.pcId, { includeSkills: true });
  check(
    'S3 includeSkills → 18-skill array, prc has numeric passive',
    s3.ok &&
      Array.isArray(s3.skills) &&
      s3.skills.length === 18 &&
      typeof s3.skills.find((sk) => sk.key === 'prc')?.passive === 'number',
    s3.ok ? s3.skills.map((sk) => sk.key) : s3,
  );

  // S4 — includeSpellcasting.
  const s4 = await run(shapes.pcId, { includeSpellcasting: true });
  check(
    'S4 includeSpellcasting → spellcasting block present',
    s4.ok && s4.spellcasting !== undefined,
    s4.ok ? s4.spellcasting : s4,
  );

  // S5 — includeEncounterState.
  const s5 = await run(shapes.pcId, { includeEncounterState: true });
  check(
    'S5 includeEncounterState → full combatant shape',
    s5.ok && 'combatId' in s5.encounter && 'isCurrentTurn' in s5.encounter,
    s5.ok ? s5.encounter : s5,
  );

  // S6 — includeRawSystem.
  const s6 = await run(shapes.pcId, { includeRawSystem: true });
  check(
    'S6 includeRawSystem → rawSystem object present',
    s6.ok && s6.rawSystem !== undefined && typeof s6.rawSystem === 'object',
    s6.ok ? Object.keys(s6.rawSystem) : s6,
  );

  // S7 — conditions (read-only: assert observed live state, warn if none).
  const observed = shapes.pc.statuses;
  if (observed.length > 0 || shapes.pc.exhaustionValue > 0) {
    check(
      'S7 conditions reflect live actor.statuses + exhaustion',
      s1.ok &&
        observed.every((st) => s1.conditions.some((c) => c.statusId === st)) &&
        (shapes.pc.exhaustionValue > 0
          ? s1.conditions.some((c) => c.statusId === 'exhaustion' && c.value > 0)
          : true),
      s1.ok ? s1.conditions : null,
    );
  } else {
    log.warn('S7 skipped — probed PC carries no conditions/exhaustion (read-only probe)');
  }

  // S8 — error paths.
  const s8a = await run(BOGUS_ID);
  check('S8a bogus actorId → ACTOR_NOT_FOUND', !s8a.ok && s8a.error.code === 'ACTOR_NOT_FOUND', s8a);
  const unsupported = await page.evaluate(() => {
    const a = game.actors.find((x) => x.type === 'vehicle' || x.type === 'group');
    return a ? a.id : null;
  });
  if (unsupported) {
    const s8b = await run(unsupported);
    check(
      'S8b vehicle/group actor → ACTOR_TYPE_UNSUPPORTED',
      !s8b.ok && s8b.error.code === 'ACTOR_TYPE_UNSUPPORTED',
      s8b,
    );
  } else {
    log.warn('S8b skipped — no vehicle/group actor in the world');
  }

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
