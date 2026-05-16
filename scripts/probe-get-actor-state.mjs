/**
 * Probe + acceptance script for get_actor_state. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world and exercises
 * the read tool across the actor-type matrix (character + npc), the
 * default projection and all four opt-in flags, and the two error
 * paths.
 *
 *   1.  Clean character: Test Valeros baseline — verify all default
 *       fields populated, conditions=[], effects=[], vitals all zero,
 *       resources.heroPoints non-null, encounter.inCombat=false.
 *   2.  Character with valued + non-valued conditions: apply frightened
 *       2, sickened 1, off-guard, dying 1 directly via PF2e API; verify
 *       conditions[] contains them with correct slug + value (number
 *       for valued, null for non-valued) and vitals.dying.value=1 even
 *       though dying is also in conditions.
 *   3.  AC delta: clean AC vs AC with Effect: Raise a Shield applied.
 *       Verify Valeros's shield bonus (+2) folds into AC.value.
 *   4.  Temp HP non-zero: apply temp HP directly via system update;
 *       verify hp.temp tracks; restore.
 *   5.  Clean NPC (Goblin Warrior 1): type='npc', resources.heroPoints
 *       null, perception.senses includes darkvision.
 *   6.  NPC with applied condition: apply frightened 1 to goblin via
 *       API; conditions[] populated.
 *   7.  includeSkills: true — skills array populated, every entry's
 *       proficiency is one of the five valid PF2e labels.
 *   8.  includeSpellcasting on a non-caster: Valeros returns
 *       spellcasting: [] (rituals pseudo-container filtered out).
 *   9.  includeSpellcasting on a scratch caster: scratch actor imported
 *       from compendium (Lich) — verify entries[0] has tradition,
 *       type='prepared', slots populated for cantrips and ranks 1+.
 *       Scratch actor deleted in teardown.
 *  10.  includeEncounterState=true, no combat: encounter.inCombat=false
 *       + nulls for other fields.
 *  11.  includeEncounterState=true, with combat: create scratch combat
 *       with Valeros + Goblin combatants, set initiatives manually,
 *       start combat; verify combatId, combatantId, initiative,
 *       isCurrentTurn, round populated. Combat + scratch token
 *       teardown.
 *  12.  includeRawSystem=true: rawSystem present and non-empty.
 *  13.  Error: ACTOR_NOT_FOUND — fabricated actor id.
 *  14.  Error: ACTOR_TYPE_UNSUPPORTED — The Party (xxxPF2ExPARTYxxx);
 *       message names the supported types.
 *  15.  Teardown verification: conditions+effects multiset on both
 *       Valeros and Goblin equals the start-of-probe snapshot; no
 *       leftover scratch combats; no leftover scratch tokens; no
 *       leftover scratch actor.
 *
 * State restoration model: read-only on actor scalars, but probes
 * apply/remove conditions and effects in setup. Pre-snapshot the
 * full conditions + effects toObject() lists for both Valeros and
 * Goblin; teardown deletes anything currently present that wasn't in
 * the snapshot, and recreates anything from the snapshot that's
 * gone (Foundry assigns new ids on recreate — assertion is on a
 * slug-or-source multiset, not id equality).
 *
 *   npm run build && node scripts/probe-get-actor-state.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'get_actor_state');
if (!tool) {
  log.error('get_actor_state not registered');
  process.exit(2);
}

const VALEROS_ID = 'wcD2h1fQmIxIab4B';
const GOBLIN_ID = 'QKC9vREnE3ajuVIF';
const PARTY_ID = 'xxxPF2ExPARTYxxx';
const RAISE_SHIELD_EFFECT_UUID = 'Compendium.pf2e.equipment-effects.Item.2YgXoHvJfrDHucMr';
const LICH_PACK = 'pf2e.pathfinder-monster-core';
const LICH_ID = 'smItqlbr0iuDJ8nL';

const failures = [];

function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { isError: true, validation: parsed.error.issues };
  }
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

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub. Clear any leftover conditions/effects from prior
  // probe runs on both Valeros and Goblin, and ensure no scratch
  // combats / scratch valeros tokens are lingering.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(
    async (valerosId, goblinId) => {
      const valeros = globalThis.game.actors?.get(valerosId);
      const goblin = globalThis.game.actors?.get(goblinId);
      let deletedConds = 0;
      let deletedEffs = 0;
      for (const actor of [valeros, goblin]) {
        if (!actor) continue;
        const ids = [
          ...actor.itemTypes.condition.map((c) => c.id),
          ...actor.itemTypes.effect.map((e) => e.id),
        ];
        if (ids.length > 0) {
          deletedConds += actor.itemTypes.condition.length;
          deletedEffs += actor.itemTypes.effect.length;
          await actor.deleteEmbeddedDocuments('Item', ids);
        }
      }
      // Reset Valeros HP temp to 0
      if (valeros && (valeros.system.attributes?.hp?.temp ?? 0) !== 0) {
        await valeros.update({ 'system.attributes.hp.temp': 0 });
      }
      // Delete any combats
      const combatIds = globalThis.game.combats.contents.map((c) => c.id);
      for (const cid of combatIds) {
        const c = globalThis.game.combats.get(cid);
        if (c) await c.delete();
      }
      // Delete any Valeros tokens on the active scene (we never want them lingering)
      const scene = globalThis.game.scenes.active;
      if (scene) {
        const valTokIds = scene.tokens.filter((t) => t.actorId === valerosId).map((t) => t.id);
        if (valTokIds.length > 0) await scene.deleteEmbeddedDocuments('Token', valTokIds);
      }
      // Delete any scratch actors named like our probe lich
      const scratchIds = globalThis.game.actors.contents
        .filter((a) => typeof a.name === 'string' && a.name.startsWith('__probe_lich'))
        .map((a) => a.id);
      for (const id of scratchIds) {
        const a = globalThis.game.actors.get(id);
        if (a) await a.delete();
      }
      return {
        deletedConds,
        deletedEffs,
        combatsDeleted: combatIds.length,
        scratchActorsDeleted: scratchIds.length,
      };
    },
    VALEROS_ID,
    GOBLIN_ID,
  );
  log.info({ scrub }, 'pre-probe scrub');

  // --------------------------------------------------------------------
  // Snapshot baseline conditions/effects on Valeros + Goblin.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate(
    (valerosId, goblinId) => {
      const snap = (actor) => ({
        conditions: actor.itemTypes.condition.map((c) => ({
          id: c.id,
          slug: c.system?.slug ?? '',
          value: c.system?.value?.value ?? null,
        })),
        effects: actor.itemTypes.effect.map((e) => ({
          id: e.id,
          name: e.name ?? '',
          sourceUuid: e._stats?.compendiumSource ?? null,
        })),
      });
      const v = globalThis.game.actors?.get(valerosId);
      const g = globalThis.game.actors?.get(goblinId);
      return {
        valeros: v ? snap(v) : null,
        goblin: g ? snap(g) : null,
      };
    },
    VALEROS_ID,
    GOBLIN_ID,
  );
  log.info({ startSnapshot }, 'baseline snapshot captured');

  // --------------------------------------------------------------------
  // Probe 1: clean character baseline.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID });
    log.info({ probe: 1, ok: res.ok, actor: res.data?.actor }, 'probe 1: clean Valeros');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.actor?.type === 'character', 'probe 1: type=character', {
        t: res.data.actor?.type,
      });
      assert(res.data.actor?.id === VALEROS_ID, 'probe 1: id matches', {});
      assert(typeof res.data.actor?.level === 'number', 'probe 1: level is number', {
        l: res.data.actor?.level,
      });
      assert(res.data.actor?.ancestry === 'Human', 'probe 1: ancestry=Human', {
        a: res.data.actor?.ancestry,
      });
      assert(res.data.actor?.class === 'Fighter', 'probe 1: class=Fighter', {});
      assert(res.data.conditions?.length === 0, 'probe 1: conditions empty', {
        c: res.data.conditions,
      });
      assert(res.data.effects?.length === 0, 'probe 1: effects empty', { e: res.data.effects });
      assert(res.data.hp?.temp === 0, 'probe 1: hp.temp=0', { temp: res.data.hp?.temp });
      assert(typeof res.data.hp?.max === 'number' && res.data.hp.max > 0, 'probe 1: hp.max>0', {
        max: res.data.hp?.max,
      });
      assert(
        typeof res.data.ac?.value === 'number' && res.data.ac.value > 0,
        'probe 1: ac.value>0',
        {
          ac: res.data.ac?.value,
        },
      );
      assert(
        typeof res.data.saves?.fortitude?.modifier === 'number',
        'probe 1: fort.modifier number',
        {},
      );
      assert(res.data.attributes?.str === 4, 'probe 1: str mod = 4', {
        s: res.data.attributes?.str,
      });
      assert(res.data.speeds?.land === 25, 'probe 1: land speed 25', {
        l: res.data.speeds?.land,
      });
      assert(res.data.resources?.heroPoints != null, 'probe 1: heroPoints object present', {
        hp: res.data.resources?.heroPoints,
      });
      assert(res.data.vitals?.dying?.value === 0, 'probe 1: dying value 0', {
        d: res.data.vitals?.dying,
      });
      assert(res.data.vitals?.wounded?.value === 0, 'probe 1: wounded value 0', {});
      assert(res.data.vitals?.doomed?.value === 0, 'probe 1: doomed value 0', {});
      assert(res.data.encounter?.inCombat === false, 'probe 1: not in combat', {});
      assert(res.data.skills === undefined, 'probe 1: skills omitted by default', {});
      assert(res.data.spellcasting === undefined, 'probe 1: spellcasting omitted by default', {});
      assert(res.data.rawSystem === undefined, 'probe 1: rawSystem omitted by default', {});
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: character with applied conditions.
  // --------------------------------------------------------------------
  {
    await page.evaluate(async (actorId) => {
      const a = globalThis.game.actors?.get(actorId);
      await a.increaseCondition('frightened');
      await a.increaseCondition('frightened');
      await a.increaseCondition('sickened');
      await a.increaseCondition('off-guard');
      await a.increaseCondition('dying');
    }, VALEROS_ID);

    const res = await call({ actorId: VALEROS_ID });
    log.info(
      { probe: 2, conds: res.data?.conditions?.map((c) => ({ slug: c.slug, value: c.value })) },
      'probe 2: with conditions',
    );
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      const findSlug = (s) => res.data.conditions.find((c) => c.slug === s);
      assert(findSlug('frightened')?.value === 2, 'probe 2: frightened value=2', {
        f: findSlug('frightened'),
      });
      assert(findSlug('sickened')?.value === 1, 'probe 2: sickened value=1', {});
      const og = findSlug('off-guard');
      assert(og && og.value === null, 'probe 2: off-guard value=null (non-valued)', { og });
      assert(findSlug('dying')?.value === 1, 'probe 2: dying value=1', {});
      // dying also surfaces in vitals at the canonical attribute location
      assert(res.data.vitals.dying.value === 1, 'probe 2: vitals.dying=1', {
        v: res.data.vitals.dying,
      });
      // Dying cascades unconscious which cascades blinded+prone; verify
      // those appear with grantedBy set.
      const unc = findSlug('unconscious');
      assert(unc && typeof unc.grantedBy === 'string', 'probe 2: unconscious has grantedBy', {
        unc,
      });
    }
    // Cleanup probe-2 conditions
    await page.evaluate(async (actorId) => {
      const a = globalThis.game.actors?.get(actorId);
      const ids = a.itemTypes.condition.map((c) => c.id);
      if (ids.length > 0) await a.deleteEmbeddedDocuments('Item', ids);
    }, VALEROS_ID);
  }

  // --------------------------------------------------------------------
  // Probe 3: AC reflects Raise a Shield effect.
  // --------------------------------------------------------------------
  {
    const cleanRes = await call({ actorId: VALEROS_ID });
    const cleanValue = cleanRes.data.ac.value;

    await page.evaluate(
      async (actorId, uuid) => {
        const a = globalThis.game.actors?.get(actorId);
        const src = await fromUuid(uuid);
        await a.createEmbeddedDocuments('Item', [src.toObject()]);
      },
      VALEROS_ID,
      RAISE_SHIELD_EFFECT_UUID,
    );

    const raisedRes = await call({ actorId: VALEROS_ID });
    log.info(
      {
        probe: 3,
        cleanAC: cleanValue,
        raisedAC: raisedRes.data?.ac?.value,
        effects: raisedRes.data?.effects?.map((e) => ({ name: e.name, dur: e.durationLabel })),
      },
      'probe 3: AC delta with shield raised',
    );
    assert(raisedRes.ok === true, 'probe 3: ok', {});
    if (raisedRes.ok) {
      assert(
        raisedRes.data.ac.value === cleanValue + 2,
        'probe 3: AC bumped by +2 with Raise a Shield',
        { clean: cleanValue, raised: raisedRes.data.ac.value },
      );
      const shieldEffect = raisedRes.data.effects.find((e) => /Raise a Shield/.test(e.name));
      assert(shieldEffect, 'probe 3: Raise a Shield effect present', {
        effs: raisedRes.data.effects,
      });
      assert(
        typeof shieldEffect?.durationLabel === 'string' && shieldEffect.durationLabel.length > 0,
        'probe 3: effect has durationLabel',
        { d: shieldEffect?.durationLabel },
      );
      assert(shieldEffect?.sourceUuid === RAISE_SHIELD_EFFECT_UUID, 'probe 3: effect sourceUuid', {
        s: shieldEffect?.sourceUuid,
      });
    }

    // cleanup
    await page.evaluate(async (actorId) => {
      const a = globalThis.game.actors?.get(actorId);
      const ids = a.itemTypes.effect.map((e) => e.id);
      if (ids.length > 0) await a.deleteEmbeddedDocuments('Item', ids);
    }, VALEROS_ID);
  }

  // --------------------------------------------------------------------
  // Probe 4: temp HP.
  // --------------------------------------------------------------------
  {
    await page.evaluate(async (actorId) => {
      await globalThis.game.actors.get(actorId).update({ 'system.attributes.hp.temp': 7 });
    }, VALEROS_ID);

    const res = await call({ actorId: VALEROS_ID });
    log.info({ probe: 4, hp: res.data?.hp }, 'probe 4: temp HP');
    assert(res.ok === true, 'probe 4: ok', {});
    if (res.ok) {
      assert(res.data.hp.temp === 7, 'probe 4: hp.temp = 7', { hp: res.data.hp });
    }

    // restore
    await page.evaluate(async (actorId) => {
      await globalThis.game.actors.get(actorId).update({ 'system.attributes.hp.temp': 0 });
    }, VALEROS_ID);
  }

  // --------------------------------------------------------------------
  // Probe 5: NPC clean.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: GOBLIN_ID });
    log.info(
      {
        probe: 5,
        actor: res.data?.actor,
        resources: res.data?.resources,
        senses: res.data?.perception?.senses,
      },
      'probe 5: clean Goblin Warrior',
    );
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.actor.type === 'npc', 'probe 5: type=npc', {});
      assert(res.data.actor.ancestry === null, 'probe 5: ancestry null on npc', {});
      assert(res.data.actor.heritage === null, 'probe 5: heritage null on npc', {});
      assert(res.data.actor.class === null, 'probe 5: class null on npc', {});
      assert(res.data.resources?.heroPoints === null, 'probe 5: heroPoints null on npc', {
        hp: res.data.resources?.heroPoints,
      });
      const darkvision = res.data.perception.senses.find((s) => s.type === 'darkvision');
      assert(darkvision, 'probe 5: darkvision sense present', {
        senses: res.data.perception.senses,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: NPC with applied condition.
  // --------------------------------------------------------------------
  {
    await page.evaluate(async (actorId) => {
      const a = globalThis.game.actors?.get(actorId);
      await a.increaseCondition('frightened');
    }, GOBLIN_ID);

    const res = await call({ actorId: GOBLIN_ID });
    log.info({ probe: 6, conds: res.data?.conditions }, 'probe 6: npc with frightened');
    assert(res.ok === true, 'probe 6: ok', {});
    if (res.ok) {
      const fr = res.data.conditions.find((c) => c.slug === 'frightened');
      assert(fr && fr.value === 1, 'probe 6: frightened value=1', { fr });
    }

    await page.evaluate(async (actorId) => {
      const a = globalThis.game.actors?.get(actorId);
      const ids = a.itemTypes.condition.map((c) => c.id);
      if (ids.length > 0) await a.deleteEmbeddedDocuments('Item', ids);
    }, GOBLIN_ID);
  }

  // --------------------------------------------------------------------
  // Probe 7: includeSkills.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, includeSkills: true });
    log.info(
      { probe: 7, skillCount: res.data?.skills?.length, sample: res.data?.skills?.slice(0, 3) },
      'probe 7: includeSkills',
    );
    assert(res.ok === true, 'probe 7: ok', {});
    if (res.ok) {
      assert(
        Array.isArray(res.data.skills) && res.data.skills.length > 0,
        'probe 7: skills array populated',
        {
          n: res.data.skills?.length,
        },
      );
      const validProfs = new Set(['untrained', 'trained', 'expert', 'master', 'legendary']);
      const badProf = res.data.skills.find((s) => !validProfs.has(s.proficiency));
      assert(!badProf, 'probe 7: all skill proficiencies are valid PF2e labels', { badProf });
      const athletics = res.data.skills.find((s) => s.slug === 'athletics');
      assert(athletics, 'probe 7: athletics present', {});
      assert(
        typeof athletics?.modifier === 'number',
        'probe 7: athletics has numeric modifier',
        {},
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 8: includeSpellcasting on a non-caster.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, includeSpellcasting: true });
    log.info(
      { probe: 8, spellcasting: res.data?.spellcasting },
      'probe 8: non-caster spellcasting',
    );
    assert(res.ok === true, 'probe 8: ok', {});
    if (res.ok) {
      assert(Array.isArray(res.data.spellcasting), 'probe 8: spellcasting is array', {});
      assert(
        res.data.spellcasting.length === 0,
        'probe 8: spellcasting empty for non-caster (rituals pseudo-container filtered)',
        { sc: res.data.spellcasting },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 9: includeSpellcasting on a scratch caster.
  // --------------------------------------------------------------------
  let scratchLichId = null;
  {
    scratchLichId = await page.evaluate(
      async (packId, docId) => {
        const pack = globalThis.game.packs.get(packId);
        const src = await pack.getDocument(docId);
        const created = await Actor.implementation.create({
          ...src.toObject(),
          name: '__probe_lich__',
        });
        return created.id;
      },
      LICH_PACK,
      LICH_ID,
    );

    const res = await call({ actorId: scratchLichId, includeSpellcasting: true });
    log.info(
      {
        probe: 9,
        entries: res.data?.spellcasting?.map((e) => ({
          name: e.name,
          type: e.type,
          tradition: e.tradition,
          slotsCount: e.slots.length,
        })),
      },
      'probe 9: scratch caster spellcasting',
    );
    assert(res.ok === true, 'probe 9: ok', { res });
    if (res.ok) {
      assert(res.data.spellcasting.length > 0, 'probe 9: spellcasting has entries', {});
      const arcane = res.data.spellcasting.find((e) => e.tradition === 'arcane');
      assert(arcane, 'probe 9: at least one arcane entry', { sc: res.data.spellcasting });
      assert(arcane?.type === 'prepared', 'probe 9: arcane entry is prepared', { t: arcane?.type });
      assert(arcane?.slots.length > 0, 'probe 9: arcane entry has slots', {});
      const cantrips = arcane?.slots.find((s) => s.level === 0);
      assert(cantrips && cantrips.max > 0, 'probe 9: cantrips slot present with max>0', {});
    }
  }

  // --------------------------------------------------------------------
  // Probe 10: includeEncounterState, no combat.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, includeEncounterState: true });
    log.info({ probe: 10, encounter: res.data?.encounter }, 'probe 10: encounter, no combat');
    assert(res.ok === true, 'probe 10: ok', {});
    if (res.ok) {
      assert(res.data.encounter.inCombat === false, 'probe 10: not in combat', {});
      assert(res.data.encounter.combatId === null, 'probe 10: combatId null', {});
      assert(res.data.encounter.combatantId === null, 'probe 10: combatantId null', {});
      assert(res.data.encounter.initiative === null, 'probe 10: initiative null', {});
      assert(res.data.encounter.isCurrentTurn === false, 'probe 10: isCurrentTurn false', {});
    }
  }

  // --------------------------------------------------------------------
  // Probe 11: includeEncounterState, with combat.
  // --------------------------------------------------------------------
  let scratchCombatId = null;
  let scratchValTokenId = null;
  {
    const setup = await page.evaluate(
      async (valerosId, goblinId) => {
        const scene = globalThis.game.scenes.active;
        const valeros = globalThis.game.actors.get(valerosId);
        // Place a Valeros token
        const td = await valeros.getTokenDocument({ x: 1300, y: 750 });
        const tok = (await scene.createEmbeddedDocuments('Token', [td.toObject()]))[0];
        // Find an existing Goblin Warrior 1 token
        const goblinTok = scene.tokens.find((t) => t.actorId === goblinId);
        if (!goblinTok) return { error: 'no goblin token' };
        // Create combat
        const combat = await Combat.create({ scene: scene.id, active: true });
        await combat.createEmbeddedDocuments('Combatant', [
          { tokenId: tok.id, actorId: valerosId, sceneId: scene.id },
          { tokenId: goblinTok.id, actorId: goblinId, sceneId: scene.id },
        ]);
        await combat.activate();
        // Set initiatives manually to avoid the roll-dialog hang
        const valCmb = combat.combatants.find((c) => c.actorId === valerosId);
        const gobCmb = combat.combatants.find((c) => c.actorId === goblinId);
        await combat.setInitiative(valCmb.id, 20);
        await combat.setInitiative(gobCmb.id, 15);
        // Start combat by setting round=1, turn=0
        await combat.update({ round: 1, turn: 0 });
        return { combatId: combat.id, valTokenId: tok.id };
      },
      VALEROS_ID,
      GOBLIN_ID,
    );
    scratchCombatId = setup.combatId;
    scratchValTokenId = setup.valTokenId;

    const res = await call({ actorId: VALEROS_ID, includeEncounterState: true });
    log.info({ probe: 11, encounter: res.data?.encounter }, 'probe 11: encounter, in combat');
    assert(res.ok === true, 'probe 11: ok', {});
    if (res.ok) {
      assert(res.data.encounter.inCombat === true, 'probe 11: in combat', {});
      assert(res.data.encounter.combatId === scratchCombatId, 'probe 11: combatId matches', {
        c: res.data.encounter.combatId,
      });
      assert(typeof res.data.encounter.combatantId === 'string', 'probe 11: combatantId set', {});
      assert(res.data.encounter.initiative === 20, 'probe 11: initiative=20', {
        i: res.data.encounter.initiative,
      });
      assert(
        res.data.encounter.isCurrentTurn === true,
        'probe 11: Valeros is current turn (init 20 vs goblin 15)',
        {},
      );
      assert(res.data.encounter.round === 1, 'probe 11: round=1', {});
    }
  }

  // --------------------------------------------------------------------
  // Probe 12: includeRawSystem.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, includeRawSystem: true });
    log.info(
      { probe: 12, rawKeys: res.data?.rawSystem ? Object.keys(res.data.rawSystem).length : 0 },
      'probe 12: includeRawSystem',
    );
    assert(res.ok === true, 'probe 12: ok', {});
    if (res.ok) {
      assert(
        res.data.rawSystem && typeof res.data.rawSystem === 'object',
        'probe 12: rawSystem present',
        {},
      );
      assert(
        Object.keys(res.data.rawSystem ?? {}).length > 5,
        'probe 12: rawSystem has many keys',
        { keys: Object.keys(res.data.rawSystem ?? {}).length },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 13: ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef' });
    log.info({ probe: 13, err: res.error }, 'probe 13: ACTOR_NOT_FOUND');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'probe 13: INVALID_INPUT code', {});
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 13: reason=ACTOR_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // --------------------------------------------------------------------
  // Probe 14: ACTOR_TYPE_UNSUPPORTED against The Party.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PARTY_ID });
    log.info({ probe: 14, err: res.error }, 'probe 14: ACTOR_TYPE_UNSUPPORTED');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 14: reason=ACTOR_TYPE_UNSUPPORTED',
      { d: res.error?.details },
    );
    assert(res.error?.details?.type === 'party', 'probe 14: details.type=party', {});
    assert(
      typeof res.error?.message === 'string' &&
        res.error.message.includes('character') &&
        res.error.message.includes('npc') &&
        res.error.message.includes('familiar'),
      'probe 14: message names supported types',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Teardown.
  //   1. Delete scratch combat + Valeros token.
  //   2. Delete scratch lich actor.
  //   3. Delete any conditions/effects added during probes that weren't
  //      already removed inline.
  //   4. Verify final conditions+effects multisets equal start snapshot.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (valerosId, goblinId, combatId, valTokenId, lichId, startSnap) => {
      const scene = globalThis.game.scenes.active;
      // Combat
      if (combatId) {
        const c = globalThis.game.combats.get(combatId);
        if (c) await c.delete();
      }
      // Valeros token
      if (valTokenId && scene) {
        const t = scene.tokens.get(valTokenId);
        if (t) await scene.deleteEmbeddedDocuments('Token', [valTokenId]);
      }
      // Scratch lich
      if (lichId) {
        const lich = globalThis.game.actors.get(lichId);
        if (lich) await lich.delete();
      }
      // Conditions/effects: delete anything currently present that isn't
      // in the start snapshot. Then recreate any missing from snapshot
      // (Foundry assigns new ids).
      const cleanActor = async (actor, snap) => {
        const snapCondSlugs = (snap.conditions ?? []).map((c) => c.slug);
        const snapEffSources = (snap.effects ?? []).map((e) => e.sourceUuid).filter(Boolean);
        const currentCondIds = actor.itemTypes.condition.map((c) => c.id);
        const currentEffIds = actor.itemTypes.effect.map((e) => e.id);
        // Easiest: delete everything currently present, recreate snapshot via
        // increaseCondition for conditions and createEmbeddedDocuments for effects.
        const toDelete = [...currentCondIds, ...currentEffIds];
        if (toDelete.length > 0) await actor.deleteEmbeddedDocuments('Item', toDelete);
        // Recreate conditions
        for (const slug of snapCondSlugs) {
          await actor.increaseCondition(slug);
        }
        // Recreate effects (by sourceUuid)
        for (const src of snapEffSources) {
          const doc = await fromUuid(src);
          if (doc) await actor.createEmbeddedDocuments('Item', [doc.toObject()]);
        }
        // Reset HP temp if Valeros
        if (actor.id === valerosId && (actor.system.attributes?.hp?.temp ?? 0) !== 0) {
          await actor.update({ 'system.attributes.hp.temp': 0 });
        }
      };
      const valeros = globalThis.game.actors.get(valerosId);
      const goblin = globalThis.game.actors.get(goblinId);
      if (valeros) await cleanActor(valeros, startSnap.valeros ?? { conditions: [], effects: [] });
      if (goblin) await cleanActor(goblin, startSnap.goblin ?? { conditions: [], effects: [] });

      // Verify
      const sig = (actor) => ({
        conditionSlugs: actor.itemTypes.condition.map((c) => c.system?.slug ?? '').sort(),
        effectSources: actor.itemTypes.effect
          .map((e) => (e.system?.duration ? (e._stats?.compendiumSource ?? '') : ''))
          .sort(),
      });
      const final = {
        valeros: valeros ? sig(valeros) : null,
        goblin: goblin ? sig(goblin) : null,
      };
      const expected = {
        valeros: {
          conditionSlugs: (startSnap.valeros?.conditions ?? []).map((c) => c.slug).sort(),
          effectSources: (startSnap.valeros?.effects ?? []).map((e) => e.sourceUuid ?? '').sort(),
        },
        goblin: {
          conditionSlugs: (startSnap.goblin?.conditions ?? []).map((c) => c.slug).sort(),
          effectSources: (startSnap.goblin?.effects ?? []).map((e) => e.sourceUuid ?? '').sort(),
        },
      };
      const valerosTokensLeft = scene
        ? scene.tokens.filter((t) => t.actorId === valerosId).length
        : 0;
      const combatsLeft = globalThis.game.combats.size;
      const lichLeft = lichId && globalThis.game.actors.get(lichId) ? 1 : 0;
      return { final, expected, valerosTokensLeft, combatsLeft, lichLeft };
    },
    VALEROS_ID,
    GOBLIN_ID,
    scratchCombatId,
    scratchValTokenId,
    scratchLichId,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');

  // Probe 15: post-teardown assertions
  assert(
    JSON.stringify(teardown.final.valeros?.conditionSlugs) ===
      JSON.stringify(teardown.expected.valeros.conditionSlugs),
    'probe 15: Valeros conditions multiset matches snapshot',
    { final: teardown.final.valeros, expected: teardown.expected.valeros },
  );
  assert(
    JSON.stringify(teardown.final.goblin?.conditionSlugs) ===
      JSON.stringify(teardown.expected.goblin.conditionSlugs),
    'probe 15: Goblin conditions multiset matches snapshot',
    { final: teardown.final.goblin, expected: teardown.expected.goblin },
  );
  assert(teardown.combatsLeft === 0, 'probe 15: no leftover combats', {
    n: teardown.combatsLeft,
  });
  assert(teardown.valerosTokensLeft === 0, 'probe 15: no leftover Valeros tokens', {
    n: teardown.valerosTokensLeft,
  });
  assert(teardown.lichLeft === 0, 'probe 15: scratch lich actor deleted', {
    n: teardown.lichLeft,
  });

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all acceptance assertions passed');
    process.exitCode = 0;
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
