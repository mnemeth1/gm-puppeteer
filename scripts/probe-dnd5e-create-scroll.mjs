/**
 * Probe + acceptance script for dnd5e_create_scroll. Drives the live
 * headless Foundry against the dnd5e test world (Foundry v14.361 /
 * dnd5e 5.3.3).
 *
 * The dnd5e scroll API (settled by
 * scripts/probe-dnd5e-create-scroll-or-wand-phase1.mjs and encoded in
 * the evaluator JSDoc): Item5e.createScrollFromSpell(spell, {},
 * {dialog:false, level}) returns an unsaved consumable; the tool persists
 * it with quantity / container / identification overrides. D&D 5e has no
 * per-spell wand generation — this tool is scroll-only.
 *
 * SAFETY MODEL (see CLAUDE.md "Pipeline-tool probes run on a disposable
 * actor"): all probe work runs on a DISPOSABLE actor created at start;
 * teardown is `actor.delete()` in a `finally`, so a thrown probe still
 * cleans up and no canonical actor is ever mutated. Every tool call is
 * timeout-raced. A start-of-run scrub clears leftover probe actors.
 *
 * Acceptance probes:
 *   1.  Happy: scroll of a level-1 spell, default level → castLevel=base.
 *   2.  Happy: upcast — level 5 → castLevel=5, baseSpellLevel unchanged.
 *   3.  Happy: quantity > 1.
 *   4.  Happy: into a container → containerId set.
 *   5.  Happy: unidentified → identified=false.
 *   6.  Happy: cantrip scroll (base level 0) → castLevel=0.
 *   7.  Reject: bogus actorId → ACTOR_NOT_FOUND.
 *   8.  Reject: spellUuid pointing at a non-spell → NOT_A_SPELL.
 *   9.  Reject: level below the spell's base → LEVEL_BELOW_SPELL_BASE.
 *   10. Reject: bogus containerId → CONTAINER_NOT_FOUND.
 *   11. Reject: containerId pointing at a non-container → NOT_A_CONTAINER.
 *   12. Reject: unsupported actor type → ACTOR_TYPE_UNSUPPORTED.
 *   13. Reject: cantrip upcast → CANTRIP_NOT_UPCASTABLE.
 *   14. Teardown verification: disposable actors are gone.
 *
 *   npm run build && node scripts/probe-dnd5e-create-scroll.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const CALL_TIMEOUT_MS = 90000;
const PROBE_ACTOR_NAME = '__probe_create_scroll_actor__';
const PROBE_VEHICLE_NAME = '__probe_create_scroll_vehicle__';

const tool = tools.find((t) => t.name === 'dnd5e_create_scroll');
if (!tool) {
  log.error('dnd5e_create_scroll not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

async function invoke(args) {
  const raced = await Promise.race([
    tool
      .handler(args, { browser: session, log })
      .then((blocks) => ({ blocks }))
      .catch((err) => ({
        err:
          err instanceof Error
            ? { code: err.code, message: err.message, details: err.details }
            : { message: String(err) },
      })),
    new Promise((res) => setTimeout(() => res({ timedOut: true }), CALL_TIMEOUT_MS)),
  ]);
  if (raced.timedOut) {
    return { isError: true, error: { message: `tool call exceeded ${CALL_TIMEOUT_MS}ms` } };
  }
  if (raced.err) return { isError: true, error: raced.err };
  const block = raced.blocks?.[0];
  if (!block || block.type !== 'text') return { isError: true, raw: raced.blocks };
  try {
    return { ok: true, data: JSON.parse(block.text) };
  } catch {
    return { isError: true, raw: block.text };
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { isError: true, validation: parsed.error.issues };
  return invoke(parsed.data);
}

async function scrubAndCreateActors(page) {
  return page.evaluate(
    async (charName, vehName) => {
      const stale = globalThis.game.actors.contents.filter(
        (a) => a.name === charName || a.name === vehName,
      );
      for (const a of stale) await a.delete();
      const char = await globalThis.Actor.create({ name: charName, type: 'character' });
      const veh = await globalThis.Actor.create({ name: vehName, type: 'vehicle' });
      return { charId: char.id, vehId: veh.id, scrubbed: stale.length };
    },
    PROBE_ACTOR_NAME,
    PROBE_VEHICLE_NAME,
  );
}

async function deleteActors(page, ids) {
  return page.evaluate(async (actorIds) => {
    const result = { deleted: 0, stillPresent: [] };
    for (const id of actorIds) {
      const a = globalThis.game.actors.get(id);
      if (a) {
        await a.delete();
        result.deleted++;
      }
    }
    for (const id of actorIds) {
      if (globalThis.game.actors.get(id)) result.stillPresent.push(id);
    }
    return result;
  }, ids);
}

async function createItem(page, actorId, spec) {
  return page.evaluate(
    async (aId, itemSpec) => {
      const actor = globalThis.game.actors.get(aId);
      const [item] = await actor.createEmbeddedDocuments('Item', [itemSpec]);
      return item.id;
    },
    actorId,
    spec,
  );
}

let actorIds = [];

try {
  const { page } = await session.ensureStarted();

  // -- Discover spell / item fixtures. --------------------------------
  const fixtures = await page.evaluate(async () => {
    const game = globalThis.game;
    const spellPack = game.packs.get('dnd5e.spells');
    const idx = await spellPack.getIndex({ fields: ['system.level'] });
    const lvl1 = idx.find((e) => e.type === 'spell' && e.system?.level === 1);
    const cantrip = idx.find((e) => e.type === 'spell' && e.system?.level === 0);
    const high = idx.find((e) => e.type === 'spell' && (e.system?.level ?? 0) >= 3);
    const itemsPack = game.packs.get('dnd5e.items');
    const itemIdx = await itemsPack.getIndex();
    const nonSpell = itemIdx.find((e) => e.type === 'consumable');
    return {
      lvl1: lvl1 ? { uuid: lvl1.uuid, name: lvl1.name } : null,
      cantrip: cantrip ? { uuid: cantrip.uuid, name: cantrip.name } : null,
      high: high ? { uuid: high.uuid, level: high.system?.level } : null,
      nonSpellUuid: nonSpell?.uuid ?? null,
    };
  });
  log.info({ fixtures }, 'discovered fixtures');
  if (!fixtures.lvl1 || !fixtures.cantrip || !fixtures.high) {
    throw new Error('precondition failed: missing spell fixtures');
  }

  // -- Disposable actors. ---------------------------------------------
  const created = await scrubAndCreateActors(page);
  actorIds = [created.charId, created.vehId];
  const ACTOR_ID = created.charId;
  log.info({ created }, 'disposable actors created');

  // -- Probe 1: level-1 scroll, default level. ------------------------
  {
    const res = await call({ actorId: ACTOR_ID, spellUuid: fixtures.lvl1.uuid });
    log.info({ probe: 1, res }, 'probe 1: level-1 scroll, default level');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.item?.type === 'consumable', 'probe 1: type=consumable', {
        t: res.data.item?.type,
      });
      assert(res.data.item?.subtype === 'scroll', 'probe 1: subtype=scroll', {
        s: res.data.item?.subtype,
      });
      assert(res.data.item?.castLevel === 1, 'probe 1: castLevel=1', {
        v: res.data.item?.castLevel,
      });
      assert(res.data.item?.baseSpellLevel === 1, 'probe 1: baseSpellLevel=1', {
        v: res.data.item?.baseSpellLevel,
      });
      assert(res.data.item?.quantity === 1, 'probe 1: quantity=1', {
        v: res.data.item?.quantity,
      });
      assert(res.data.item?.identified === true, 'probe 1: identified=true', {
        v: res.data.item?.identified,
      });
      assert(
        typeof res.data.item?.spellName === 'string' && res.data.item.spellName.length > 0,
        'probe 1: spellName populated',
        { v: res.data.item?.spellName },
      );
    }
  }

  // -- Probe 2: upcast — level 5. -------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, spellUuid: fixtures.lvl1.uuid, level: 5 });
    log.info({ probe: 2, res }, 'probe 2: upcast to level 5');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.castLevel === 5, 'probe 2: castLevel=5', {
        v: res.data.item?.castLevel,
      });
      assert(res.data.item?.baseSpellLevel === 1, 'probe 2: baseSpellLevel still 1', {
        v: res.data.item?.baseSpellLevel,
      });
    }
  }

  // -- Probe 3: quantity > 1. -----------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, spellUuid: fixtures.lvl1.uuid, quantity: 4 });
    log.info({ probe: 3, res }, 'probe 3: quantity 4');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.item?.quantity === 4, 'probe 3: quantity=4', {
        v: res.data.item?.quantity,
      });
    }
  }

  // -- Probe 4: into a container. -------------------------------------
  {
    const containerId = await createItem(page, ACTOR_ID, {
      name: '__probe_container__',
      type: 'container',
    });
    const res = await call({
      actorId: ACTOR_ID,
      spellUuid: fixtures.lvl1.uuid,
      containerId,
    });
    log.info({ probe: 4, res }, 'probe 4: scroll into a container');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.item?.containerId === containerId, 'probe 4: containerId set', {
        expected: containerId,
        got: res.data.item?.containerId,
      });
    }
  }

  // -- Probe 5: unidentified. -----------------------------------------
  {
    const res = await call({
      actorId: ACTOR_ID,
      spellUuid: fixtures.lvl1.uuid,
      identified: false,
    });
    log.info({ probe: 5, res }, 'probe 5: unidentified scroll');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.item?.identified === false, 'probe 5: identified=false', {
        v: res.data.item?.identified,
      });
    }
  }

  // -- Probe 6: cantrip scroll. ---------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, spellUuid: fixtures.cantrip.uuid });
    log.info({ probe: 6, res }, 'probe 6: cantrip scroll');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.item?.castLevel === 0, 'probe 6: castLevel=0', {
        v: res.data.item?.castLevel,
      });
      assert(res.data.item?.baseSpellLevel === 0, 'probe 6: baseSpellLevel=0', {
        v: res.data.item?.baseSpellLevel,
      });
    }
  }

  // -- Probe 7: bogus actorId. ----------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef', spellUuid: fixtures.lvl1.uuid });
    log.info({ probe: 7, res }, 'probe 7: bogus actorId');
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 7: reason=ACTOR_NOT_FOUND', {
      d: res.error?.details,
    });
  }

  // -- Probe 8: non-spell UUID. ---------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, spellUuid: fixtures.nonSpellUuid });
    log.info({ probe: 8, res }, 'probe 8: non-spell UUID');
    assert(res.error?.details?.reason === 'NOT_A_SPELL', 'probe 8: reason=NOT_A_SPELL', {
      d: res.error?.details,
    });
  }

  // -- Probe 9: level below base. -------------------------------------
  {
    const res = await call({ actorId: ACTOR_ID, spellUuid: fixtures.high.uuid, level: 1 });
    log.info({ probe: 9, res, highLevel: fixtures.high.level }, 'probe 9: level below base');
    assert(
      res.error?.details?.reason === 'LEVEL_BELOW_SPELL_BASE',
      'probe 9: reason=LEVEL_BELOW_SPELL_BASE',
      { d: res.error?.details },
    );
  }

  // -- Probe 10: bogus containerId. -----------------------------------
  {
    const res = await call({
      actorId: ACTOR_ID,
      spellUuid: fixtures.lvl1.uuid,
      containerId: 'deadbeefdeadbeef',
    });
    log.info({ probe: 10, res }, 'probe 10: bogus containerId');
    assert(
      res.error?.details?.reason === 'CONTAINER_NOT_FOUND',
      'probe 10: reason=CONTAINER_NOT_FOUND',
      { d: res.error?.details },
    );
  }

  // -- Probe 11: containerId points at a non-container. ---------------
  {
    const weaponId = await createItem(page, ACTOR_ID, {
      name: '__probe_weapon__',
      type: 'weapon',
    });
    const res = await call({
      actorId: ACTOR_ID,
      spellUuid: fixtures.lvl1.uuid,
      containerId: weaponId,
    });
    log.info({ probe: 11, res }, 'probe 11: containerId is a weapon');
    assert(res.error?.details?.reason === 'NOT_A_CONTAINER', 'probe 11: reason=NOT_A_CONTAINER', {
      d: res.error?.details,
    });
  }

  // -- Probe 12: unsupported actor type (disposable vehicle). ---------
  {
    const res = await call({ actorId: created.vehId, spellUuid: fixtures.lvl1.uuid });
    log.info({ probe: 12, res }, 'probe 12: unsupported actor type (vehicle)');
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 12: reason=ACTOR_TYPE_UNSUPPORTED',
      { d: res.error?.details },
    );
  }

  // -- Probe 13: cantrip upcast. --------------------------------------
  {
    const res = await call({
      actorId: ACTOR_ID,
      spellUuid: fixtures.cantrip.uuid,
      level: 3,
    });
    log.info({ probe: 13, res }, 'probe 13: cantrip upcast');
    assert(
      res.error?.details?.reason === 'CANTRIP_NOT_UPCASTABLE',
      'probe 13: reason=CANTRIP_NOT_UPCASTABLE',
      { d: res.error?.details },
    );
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe run threw',
  );
  failures.push({ label: 'probe run threw', ctx: { message: String(err?.message ?? err) } });
} finally {
  // -- Teardown ALWAYS runs: delete the disposable actors wholesale.
  try {
    const { page } = await session.ensureStarted();
    const td = await deleteActors(page, actorIds);
    log.info({ teardown: td }, 'teardown complete');
    assert(td.stillPresent.length === 0, 'probe 14: disposable actors deleted', {
      stillPresent: td.stillPresent,
    });
  } catch (tdErr) {
    log.error({ tdErr: String(tdErr?.message ?? tdErr) }, 'TEARDOWN FAILED');
    failures.push({ label: 'teardown failed', ctx: { message: String(tdErr) } });
  }

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all acceptance assertions passed');
    process.exitCode = 0;
  }
  await session.stop().catch(() => undefined);
}
