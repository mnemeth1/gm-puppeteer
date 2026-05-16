/**
 * Acceptance probe for get_creature_details. Non-destructive: targets
 * compendium-resident creatures via `fromUuid` plus the sandbox PC for
 * the ACTOR_TYPE_UNSUPPORTED case.
 *
 * Coverage:
 *   1. One NPC (Goblin Warrior or first npc in pathfinder-monster-core).
 *   2. A caster NPC (Lich) — verify spellcasting[] populated.
 *   3. A simple hazard (isComplex: false).
 *   4. A complex hazard (isComplex: true).
 *   5. A familiar — verify abilities: null, master pointer present.
 *   6. NOT_FOUND on a bogus UUID.
 *   7. WRONG_DOCUMENT_TYPE on an Item UUID.
 *   8. ACTOR_TYPE_UNSUPPORTED on a PC actor UUID (Valeros).
 *   9. descriptionFormat: 'html' | 'text' | 'both' field-presence.
 *  10. includeRules: true and includeRawSystem: true opt-ins.
 *
 *   npm run build && node scripts/probe-get-creature-details.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'get_creature_details');
if (!tool) {
  log.error('get_creature_details not registered');
  process.exit(2);
}

const PC_ACTOR_ID = 'tLhy0qgJyw31QaEy'; // Valeros in sandbox
const PC_UUID = `Actor.${PC_ACTOR_ID}`;
const ITEM_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi'; // Longsword
const BOGUS_UUID = 'Actor.deadbeef';

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
    __throw: err instanceof Error
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

  // ----- Discover concrete probe targets via pack indexes -----
  const targets = await page.evaluate(async () => {
    const findInPack = async (collection, predicate) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return null;
      const idx = await pack.getIndex();
      const hit = idx.contents.find(predicate);
      if (!hit) return null;
      return {
        uuid: hit.uuid ?? `Compendium.${pack.collection}.Actor.${hit._id}`,
        name: hit.name,
      };
    };

    // Pre-load each pack's index so type field is populated.
    const npc = await findInPack(
      'pf2e.pathfinder-monster-core',
      (e) => e.type === 'npc' && (e.name ?? '').toLowerCase() === 'goblin warrior',
    ) ?? await findInPack('pf2e.pathfinder-monster-core', (e) => e.type === 'npc');

    const casterNpc = await findInPack(
      'pf2e.pathfinder-monster-core',
      (e) => e.type === 'npc' && (e.name ?? '').toLowerCase() === 'lich',
    ) ?? await findInPack(
      'pf2e.pathfinder-monster-core',
      (e) => e.type === 'npc' && /lich|sorcer|wizard|druid|cleric|priest/i.test(e.name ?? ''),
    );

    // For hazards, getDocument is required to discriminate complex vs
    // simple (the index doesn't carry isComplex).
    const hazardCandidates = [];
    {
      const pack = globalThis.game.packs?.get('pf2e.hazards');
      if (pack) {
        const idx = await pack.getIndex();
        for (const e of idx.contents) {
          if (e.type === 'hazard') hazardCandidates.push(e);
        }
      }
    }
    let simpleHazard = null;
    let complexHazard = null;
    for (const e of hazardCandidates) {
      if (simpleHazard && complexHazard) break;
      const pack = globalThis.game.packs?.get('pf2e.hazards');
      const doc = await pack.getDocument(e._id);
      const isComplex = doc?.system?.details?.isComplex === true;
      if (isComplex && !complexHazard) {
        complexHazard = {
          uuid: doc.uuid,
          name: doc.name,
        };
      } else if (!isComplex && !simpleHazard) {
        simpleHazard = {
          uuid: doc.uuid,
          name: doc.name,
        };
      }
    }

    const familiar = await findInPack(
      'pf2e.iconics',
      (e) => e.type === 'familiar',
    );

    // PC actor uuid (Valeros).
    const valeros = globalThis.game.actors?.get('tLhy0qgJyw31QaEy');
    const valerosUuid = valeros ? valeros.uuid : null;

    return { npc, casterNpc, simpleHazard, complexHazard, familiar, valerosUuid };
  });
  log.info({ targets }, 'discovered probe targets');

  if (!targets.npc) {
    log.error('no NPC target found; aborting');
    process.exit(2);
  }

  // ======================================================================
  // Test 1: NPC stat block.
  // ======================================================================
  {
    const res = await call({ uuid: targets.npc.uuid });
    assert(res.ok === true, 'NPC: result.ok', { res });
    if (res.ok) {
      const d = res.data;
      log.info(
        {
          name: d.name,
          level: d.level,
          type: d.type,
          ac: d.npc?.ac.value,
          hp: d.npc?.hp,
          saves: d.npc?.saves,
          perceptionMod: d.npc?.perception.modifier,
          sensesCount: d.npc?.perception.senses.length,
          abilitiesPresent: d.npc?.abilities !== null,
          speeds: d.npc?.speeds,
          skillCount: d.npc?.skills.length,
          strikeCount: d.npc?.strikes.length,
          actionCount: d.npc?.actions.length,
          spellcastingCount: d.npc?.spellcasting.length,
          languagesLen: d.npc?.languages.length,
        },
        'NPC projection',
      );
      assert(d.type === 'npc', 'NPC: type is npc');
      assert(d.npc !== undefined, 'NPC: npc block populated');
      assert(!d.hazard && !d.familiar, 'NPC: hazard/familiar blocks absent');
      assert(typeof d.npc?.ac.value === 'number' && d.npc.ac.value > 0, 'NPC: ac.value > 0');
      assert(d.npc?.hp.max > 0, 'NPC: hp.max > 0');
      assert(Array.isArray(d.npc?.skills), 'NPC: skills is array');
      assert(Array.isArray(d.npc?.strikes), 'NPC: strikes is array');
      assert(Array.isArray(d.npc?.spellcasting), 'NPC: spellcasting is array');
      assert(d.npc?.abilities !== undefined, 'NPC: abilities key present (may be null)');
    }
  }

  // ======================================================================
  // Test 2: Caster NPC — spellcasting populated.
  // ======================================================================
  if (targets.casterNpc) {
    const res = await call({ uuid: targets.casterNpc.uuid });
    assert(res.ok === true, 'Caster: result.ok', { res });
    if (res.ok) {
      const sc = res.data.npc?.spellcasting ?? [];
      log.info(
        {
          name: res.data.name,
          spellcastingCount: sc.length,
          firstEntry: sc[0],
        },
        'Caster NPC spellcasting',
      );
      assert(sc.length > 0, 'Caster: at least one spellcasting entry');
      if (sc.length > 0) {
        assert(typeof sc[0].name === 'string' && sc[0].name.length > 0, 'Caster: entry.name set');
        assert(typeof sc[0].category === 'string', 'Caster: entry.category set');
        assert(Array.isArray(sc[0].slots), 'Caster: entry.slots is array');
      }
    }
  } else {
    log.warn('no caster NPC found in pathfinder-monster-core — skipping Test 2');
  }

  // ======================================================================
  // Test 3: Simple hazard.
  // ======================================================================
  if (targets.simpleHazard) {
    const res = await call({ uuid: targets.simpleHazard.uuid });
    assert(res.ok === true, 'SimpleHazard: result.ok', { res });
    if (res.ok) {
      const d = res.data;
      log.info(
        {
          name: d.name,
          isComplex: d.hazard?.isComplex,
          hardness: d.hazard?.hardness,
          hp: d.hazard?.hp,
          stealthDc: d.hazard?.stealth.dc,
          disableLen: d.hazard?.disableText?.length ?? 0,
        },
        'Simple hazard projection',
      );
      assert(d.type === 'hazard', 'SimpleHazard: type is hazard');
      assert(d.hazard !== undefined, 'SimpleHazard: hazard block populated');
      assert(d.hazard?.isComplex === false, 'SimpleHazard: isComplex false');
      assert(!d.npc && !d.familiar, 'SimpleHazard: npc/familiar blocks absent');
    }
  } else {
    log.warn('no simple hazard found — skipping Test 3');
  }

  // ======================================================================
  // Test 4: Complex hazard.
  // ======================================================================
  if (targets.complexHazard) {
    const res = await call({ uuid: targets.complexHazard.uuid });
    assert(res.ok === true, 'ComplexHazard: result.ok', { res });
    if (res.ok) {
      const d = res.data;
      log.info(
        {
          name: d.name,
          isComplex: d.hazard?.isComplex,
          hardness: d.hazard?.hardness,
          hp: d.hazard?.hp,
          stealthDc: d.hazard?.stealth.dc,
          routineLen: d.hazard?.routineText?.length ?? 0,
        },
        'Complex hazard projection',
      );
      assert(d.hazard?.isComplex === true, 'ComplexHazard: isComplex true');
    }
  } else {
    log.warn('no complex hazard found — skipping Test 4');
  }

  // ======================================================================
  // Test 5: Familiar.
  // ======================================================================
  if (targets.familiar) {
    const res = await call({ uuid: targets.familiar.uuid });
    assert(res.ok === true, 'Familiar: result.ok', { res });
    if (res.ok) {
      const d = res.data;
      log.info(
        {
          name: d.name,
          type: d.type,
          master: d.familiar?.master,
          ac: d.familiar?.ac.value,
          hp: d.familiar?.hp,
          reach: d.familiar?.reach,
          actions: d.familiar?.actions.length,
        },
        'Familiar projection',
      );
      assert(d.type === 'familiar', 'Familiar: type is familiar');
      assert(d.familiar !== undefined, 'Familiar: familiar block populated');
      assert(d.familiar?.abilities === null, 'Familiar: abilities is null (not zero-filled)');
      assert(d.familiar?.master !== undefined, 'Familiar: master key present');
      assert(!d.npc && !d.hazard, 'Familiar: npc/hazard blocks absent');
    }
  } else {
    log.warn('no familiar found in pf2e.iconics — skipping Test 5');
  }

  // ======================================================================
  // Test 6: NOT_FOUND on bogus UUID.
  // ======================================================================
  {
    const res = await call({ uuid: BOGUS_UUID });
    assert(res.isError === true, 'NOT_FOUND: error path taken', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'NOT_FOUND: ToolError code INVALID_INPUT', {
      res,
    });
    assert(
      typeof res.error?.message === 'string' && res.error.message.includes(BOGUS_UUID),
      'NOT_FOUND: message includes bogus UUID',
      { res },
    );
  }

  // ======================================================================
  // Test 7: WRONG_DOCUMENT_TYPE on Item UUID.
  // ======================================================================
  {
    const res = await call({ uuid: ITEM_UUID });
    assert(res.isError === true, 'WRONG_DOCUMENT_TYPE: error path taken', { res });
    assert(
      typeof res.error?.message === 'string' && /expected Actor/i.test(res.error.message),
      "WRONG_DOCUMENT_TYPE: message says 'expected Actor'",
      { res },
    );
  }

  // ======================================================================
  // Test 8: ACTOR_TYPE_UNSUPPORTED on PC actor.
  // ======================================================================
  {
    const res = await call({ uuid: targets.valerosUuid ?? PC_UUID });
    assert(res.isError === true, 'ACTOR_TYPE_UNSUPPORTED: error path taken', { res });
    assert(
      typeof res.error?.message === 'string' &&
        /get_actor_state|character/i.test(res.error.message),
      'ACTOR_TYPE_UNSUPPORTED: message points at get_actor_state',
      { res },
    );
  }

  // ======================================================================
  // Test 9: descriptionFormat field-presence on one NPC.
  // ======================================================================
  {
    const htmlRes = await call({ uuid: targets.npc.uuid, descriptionFormat: 'html' });
    const textRes = await call({ uuid: targets.npc.uuid, descriptionFormat: 'text' });
    const bothRes = await call({ uuid: targets.npc.uuid, descriptionFormat: 'both' });
    assert(
      htmlRes.ok && htmlRes.data.description !== undefined && htmlRes.data.descriptionText === undefined,
      "descriptionFormat='html': only description present",
    );
    assert(
      textRes.ok && textRes.data.descriptionText !== undefined && textRes.data.description === undefined,
      "descriptionFormat='text': only descriptionText present",
    );
    assert(
      bothRes.ok && bothRes.data.description !== undefined && bothRes.data.descriptionText !== undefined,
      "descriptionFormat='both': both fields present",
    );
  }

  // ======================================================================
  // Test 10: includeRules / includeRawSystem opt-ins.
  // ======================================================================
  {
    const baseRes = await call({ uuid: targets.npc.uuid });
    const rulesRes = await call({ uuid: targets.npc.uuid, includeRules: true });
    const rawRes = await call({ uuid: targets.npc.uuid, includeRawSystem: true });
    assert(baseRes.ok && baseRes.data.rules === undefined, 'opt-in: rules absent by default');
    assert(baseRes.ok && baseRes.data.rawSystem === undefined, 'opt-in: rawSystem absent by default');
    assert(rulesRes.ok && Array.isArray(rulesRes.data.rules), 'opt-in: includeRules → rules array');
    assert(rawRes.ok && rawRes.data.rawSystem !== undefined, 'opt-in: includeRawSystem → rawSystem present');
    assert(
      rawRes.ok && typeof rawRes.data.rawSystem === 'object',
      'opt-in: rawSystem is object',
    );
  }

  // ======================================================================
  // Summary.
  // ======================================================================
  log.info({ failureCount: failures.length, failures }, 'PROBE SUMMARY');
  if (failures.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
