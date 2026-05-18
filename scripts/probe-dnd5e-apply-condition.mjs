/**
 * Probe + acceptance script for dnd5e_apply_condition. Drives the live
 * headless Foundry against the dnd5e test world and exercises:
 *
 *   1.  Apply non-valued condition (prone) to a clean character →
 *       operation: "applied", valued: false, existedBefore: false,
 *       value: null, previousValue: null, effectId is a string.
 *   2.  Apply the same non-valued condition again → operation: "noop",
 *       reason: "already_present".
 *   3.  Apply exhaustion with default value (no value) → applied,
 *       valueApplied: 1, previousValue: 0, existedBefore: false.
 *   4.  Raise exhaustion (1 present, apply 4) → applied, value: 4,
 *       previousValue: 1, existedBefore: true, clamped: false.
 *   5.  Apply exhaustion at equal value (4 → apply 4) → noop,
 *       reason: "already_at_or_above_requested_value".
 *   6.  Apply exhaustion at lower value (4 → apply 2) → noop.
 *   7.  Apply exhaustion from clean with value 9 → valueApplied: 6,
 *       clamped: true.
 *   8.  Apply unconscious → applied; cascadeApplied includes the
 *       incapacitated rider.
 *   9.  Apply a pseudo-condition (bleeding) → applied.
 *   10. Apply a condition to the npc (poisoned) — actor-type parity.
 *   11. Error: bogus actorId → ACTOR_NOT_FOUND.
 *   12. Error: unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped
 *       if the world has no vehicle/group/encounter actor).
 *   13. Error: bogus statusId → STATUS_NOT_FOUND.
 *   14. Error: value on a non-valued status → VALUE_ON_NON_VALUED_CONDITION.
 *   15. Teardown verification: post-teardown statuses set + exhaustion
 *       level + effect-name multiset equal the start-of-probe snapshot on
 *       both actors.
 *
 * State restoration model:
 *  - `scrubActor` converges an actor to condition-free state: exhaustion
 *    0, every status toggled off, every status-backed ActiveEffect (one
 *    with a non-empty `statuses` set) deleted. Item/spell effects (empty
 *    `statuses`) are left untouched. It is idempotent and crash-proof
 *    (delete failures on already-gone ids are swallowed).
 *  - The probe scrubs both actors FIRST (converging away any pollution
 *    from earlier runs — per CLAUDE.md's canonical-state-scrub guidance),
 *    then snapshots that clean state, scrubs between happy-path probes,
 *    and scrubs again at teardown. The post-teardown assertion checks the
 *    status-id set, exhaustion level, and effect-name multiset.
 *
 *   npm run build && node scripts/probe-dnd5e-apply-condition.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_apply_condition');
if (!tool) {
  log.error('dnd5e_apply_condition not registered');
  process.exit(2);
}

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
  // Resolve test actors live: one character, one npc, and (optionally)
  // one unsupported-type actor for the error path.
  // --------------------------------------------------------------------
  const actorIds = await page.evaluate(() => {
    const pc = globalThis.game.actors.find((a) => a.type === 'character');
    const npc = globalThis.game.actors.find((a) => a.type === 'npc');
    const other = globalThis.game.actors.find((a) => a.type !== 'character' && a.type !== 'npc');
    return {
      pc: pc ? { id: pc.id, name: pc.name } : null,
      npc: npc ? { id: npc.id, name: npc.name } : null,
      other: other ? { id: other.id, name: other.name, type: other.type } : null,
    };
  });
  if (!actorIds.pc || !actorIds.npc) {
    log.error({ actorIds }, 'probe aborted: world needs a character AND an npc actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  const PC_ID = actorIds.pc.id;
  const NPC_ID = actorIds.npc.id;
  log.info({ actorIds }, 'resolved test actors');

  // --------------------------------------------------------------------
  // scrubActor — converge an actor to condition-free state. Idempotent,
  // crash-proof. Returns the post-scrub {statuses, exhaustion, effects}.
  // --------------------------------------------------------------------
  async function scrubActor(actorId) {
    return page.evaluate(async (id) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const setArr = (s) => (s && typeof s[Symbol.iterator] === 'function' ? Array.from(s) : []);
      const actor = globalThis.game.actors.get(id);
      if (!actor) return { error: `actor ${id} not found` };

      // Exhaustion is managed via system.attributes.exhaustion — clear it
      // through update(), never toggleStatusEffect (toggling the
      // exhaustion status races the system's own effect deletion).
      await actor.update({ 'system.attributes.exhaustion': 0 });
      await sleep(120);

      let iterations = 0;
      let statuses = setArr(actor.statuses).filter((s) => s !== 'exhaustion');
      while (statuses.length > 0 && iterations < 10) {
        for (const s of statuses) {
          try {
            await actor.toggleStatusEffect(s, { active: false });
          } catch {
            /* racing rider/system cleanup — re-swept next iteration */
          }
        }
        await sleep(120);
        statuses = setArr(actor.statuses).filter((s) => s !== 'exhaustion');
        iterations += 1;
      }

      // Delete leftover status-backed effects (non-empty `statuses` set).
      // Item/spell effects (empty `statuses`) are left alone. Re-fetch ids
      // fresh and delete one-by-one so an already-removed id can't abort.
      const condEffectIds = actor.effects.contents
        .filter((e) => setArr(e.statuses).length > 0)
        .map((e) => e.id);
      for (const eid of condEffectIds) {
        try {
          await actor.deleteEmbeddedDocuments('ActiveEffect', [eid]);
        } catch {
          /* already gone — system-managed effect removed during prep */
        }
      }
      await sleep(80);

      return {
        name: actor.name,
        type: actor.type,
        statuses: setArr(actor.statuses).sort(),
        exhaustion: actor._source?.system?.attributes?.exhaustion ?? 0,
        effects: actor.effects.contents.map((e) => e.name).sort(),
      };
    }, actorId);
  }

  // --------------------------------------------------------------------
  // Scrub both actors, then snapshot the clean baseline.
  // --------------------------------------------------------------------
  const startSnapshot = {
    [PC_ID]: await scrubActor(PC_ID),
    [NPC_ID]: await scrubActor(NPC_ID),
  };
  log.info({ startSnapshot }, 'snapshot: clean baseline captured');

  // --------------------------------------------------------------------
  // Probe 1: apply non-valued (prone) on a clean character.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'prone' });
    log.info({ probe: 1, res }, 'probe 1: apply prone (non-valued)');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 1: applied', { op: res.data.operation });
      assert(res.data.condition.statusId === 'prone', 'probe 1: statusId echoed', {
        statusId: res.data.condition.statusId,
      });
      assert(res.data.condition.valued === false, 'probe 1: valued=false', {
        valued: res.data.condition.valued,
      });
      assert(res.data.condition.existedBefore === false, 'probe 1: existedBefore=false', {
        existedBefore: res.data.condition.existedBefore,
      });
      assert(res.data.condition.value === null, 'probe 1: value=null', {
        value: res.data.condition.value,
      });
      assert(typeof res.data.effectId === 'string', 'probe 1: effectId is a string', {
        effectId: res.data.effectId,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: apply prone again → noop "already_present".
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'prone' });
    log.info({ probe: 2, res }, 'probe 2: apply prone already present (noop)');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 2: noop', { op: res.data.operation });
      assert(res.data.reason === 'already_present', 'probe 2: reason=already_present', {
        reason: res.data.reason,
      });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 3: apply exhaustion with default value (no value) → level 1.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'exhaustion' });
    log.info({ probe: 3, res }, 'probe 3: apply exhaustion (default level=1)');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 3: applied', { op: res.data.operation });
      assert(res.data.condition.valued === true, 'probe 3: valued=true', {
        valued: res.data.condition.valued,
      });
      assert(res.data.condition.value === 1, 'probe 3: value=1', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.previousValue === 0, 'probe 3: previousValue=0', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.valueApplied === 1, 'probe 3: valueApplied=1', {
        valueApplied: res.data.condition.valueApplied,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: raise exhaustion (1 present, apply 4).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'exhaustion', value: 4 });
    log.info({ probe: 4, res }, 'probe 4: raise exhaustion 1 → 4');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 4: applied', { op: res.data.operation });
      assert(res.data.condition.previousValue === 1, 'probe 4: previousValue=1', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.existedBefore === true, 'probe 4: existedBefore=true', {
        existedBefore: res.data.condition.existedBefore,
      });
      assert(res.data.condition.value === 4, 'probe 4: value=4', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.clamped === false, 'probe 4: clamped=false', {
        clamped: res.data.condition.clamped,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: equal value → noop.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'exhaustion', value: 4 });
    log.info({ probe: 5, res }, 'probe 5: apply exhaustion 4 on 4 (noop)');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 5: noop', { op: res.data.operation });
      assert(
        res.data.reason === 'already_at_or_above_requested_value',
        'probe 5: reason=already_at_or_above_requested_value',
        { reason: res.data.reason },
      );
      assert(res.data.condition.value === 4, 'probe 5: value=4', {
        value: res.data.condition.value,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: lower value → noop.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'exhaustion', value: 2 });
    log.info({ probe: 6, res }, 'probe 6: apply exhaustion 2 on 4 (noop)');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 6: noop', { op: res.data.operation });
      assert(res.data.condition.value === 4, 'probe 6: value still 4', {
        value: res.data.condition.value,
      });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 7: exhaustion value 9 from clean → clamped to 6.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'exhaustion', value: 9 });
    log.info({ probe: 7, res }, 'probe 7: exhaustion value=9 → clamped to 6');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 7: applied', { op: res.data.operation });
      assert(res.data.condition.valueRequested === 9, 'probe 7: valueRequested=9', {
        valueRequested: res.data.condition.valueRequested,
      });
      assert(res.data.condition.valueApplied === 6, 'probe 7: valueApplied=6', {
        valueApplied: res.data.condition.valueApplied,
      });
      assert(res.data.condition.clamped === true, 'probe 7: clamped=true', {
        clamped: res.data.condition.clamped,
      });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 8: apply unconscious → cascadeApplied includes incapacitated.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'unconscious' });
    log.info({ probe: 8, res }, 'probe 8: apply unconscious — rider cascade');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 8: applied', { op: res.data.operation });
      const cascade = res.data.cascadeApplied ?? [];
      assert(
        cascade.includes('incapacitated'),
        'probe 8: cascadeApplied includes incapacitated rider',
        { cascade },
      );
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 9: apply a pseudo-condition (bleeding).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'bleeding' });
    log.info({ probe: 9, res }, 'probe 9: apply pseudo-condition bleeding');
    assert(res.ok === true, 'probe 9: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 9: applied', { op: res.data.operation });
      assert(res.data.condition.category === 'pseudo-condition', 'probe 9: category', {
        category: res.data.condition.category,
      });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 10: apply a condition to the npc — actor-type parity.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: NPC_ID, statusId: 'poisoned' });
    log.info({ probe: 10, res }, 'probe 10: apply poisoned to npc');
    assert(res.ok === true, 'probe 10: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 10: applied', { op: res.data.operation });
      assert(res.data.actor.id === NPC_ID, 'probe 10: actor id echoed', {
        actorId: res.data.actor.id,
      });
    }
  }

  await scrubActor(NPC_ID);

  // --------------------------------------------------------------------
  // Probe 11: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeefdeadbeef', statusId: 'prone' });
    log.info({ probe: 11, res }, 'probe 11: bogus actorId');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 11: reason=ACTOR_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 12: unsupported actor type (skip if none in world).
  // --------------------------------------------------------------------
  if (actorIds.other) {
    const res = await call({ actorId: actorIds.other.id, statusId: 'prone' });
    log.info({ probe: 12, res, otherType: actorIds.other.type }, 'probe 12: unsupported type');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 12: reason=ACTOR_TYPE_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 12 }, 'probe 12: skipped — no vehicle/group/encounter actor in world');
  }

  // --------------------------------------------------------------------
  // Probe 13: bogus statusId → STATUS_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'pronified' });
    log.info({ probe: 13, res }, 'probe 13: bogus statusId');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(res.error?.details?.reason === 'STATUS_NOT_FOUND', 'probe 13: reason=STATUS_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 14: value on a non-valued status → VALUE_ON_NON_VALUED_CONDITION.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PC_ID, statusId: 'prone', value: 2 });
    log.info({ probe: 14, res }, 'probe 14: value on non-valued');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'VALUE_ON_NON_VALUED_CONDITION',
      'probe 14: reason=VALUE_ON_NON_VALUED_CONDITION',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Teardown: scrub both actors back to the clean baseline.
  // --------------------------------------------------------------------
  const teardown = {
    [PC_ID]: await scrubActor(PC_ID),
    [NPC_ID]: await scrubActor(NPC_ID),
  };
  log.info({ teardown }, 'teardown: scrubbed both actors');

  // --------------------------------------------------------------------
  // Probe 15: teardown verification per actor.
  // --------------------------------------------------------------------
  for (const id of [PC_ID, NPC_ID]) {
    const snap = startSnapshot[id];
    const post = teardown[id];
    assert(
      JSON.stringify(post.statuses) === JSON.stringify(snap.statuses),
      `probe 15: ${snap.name} status set restored`,
      { actor: snap.name, post: post.statuses, expected: snap.statuses },
    );
    assert(post.exhaustion === snap.exhaustion, `probe 15: ${snap.name} exhaustion restored`, {
      actor: snap.name,
      post: post.exhaustion,
      expected: snap.exhaustion,
    });
    assert(
      JSON.stringify(post.effects) === JSON.stringify(snap.effects),
      `probe 15: ${snap.name} effect-name multiset restored`,
      { actor: snap.name, post: post.effects, expected: snap.effects },
    );
  }

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
