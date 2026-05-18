/**
 * Probe + acceptance script for dnd5e_remove_condition. Drives the live
 * headless Foundry against the dnd5e test world and exercises:
 *
 *   1.  Remove a non-valued condition (apply prone, then remove) →
 *       operation: "removed", valued: false, previousValue: null,
 *       effectId is a string.
 *   2.  Remove a non-valued condition not present → operation: "noop",
 *       reason: "not_present".
 *   3.  Decrement exhaustion from level > 1 (apply 3, decrement) →
 *       operation: "decremented", previousValue: 3, value: 2.
 *   4.  Decrement exhaustion from level 1 (apply 1, decrement) →
 *       operation: "removed", previousValue: 1.
 *   5.  Remove exhaustion with mode "remove" from level > 1 (apply 4,
 *       remove) → operation: "removed", previousValue: 4.
 *   6.  Decrement exhaustion already at 0 → operation: "noop",
 *       reason: "not_present".
 *   7.  Cascade: apply unconscious (rider incapacitated), remove
 *       unconscious → removed; cascadeRemoved includes incapacitated and
 *       the rider is gone from actor.statuses afterward.
 *   8.  Remove a condition on the npc (apply poisoned, remove) —
 *       actor-type parity.
 *   9.  Error: bogus actorId → ACTOR_NOT_FOUND.
 *   10. Error: unsupported actor type → ACTOR_TYPE_UNSUPPORTED (skipped
 *       if the world has no vehicle/group/encounter actor).
 *   11. Error: bogus statusId → STATUS_NOT_FOUND.
 *   12. Teardown verification: post-teardown statuses set + exhaustion
 *       level + effect-name multiset equal the start-of-probe snapshot on
 *       both actors.
 *
 * State restoration model: identical to probe-dnd5e-apply-condition.mjs —
 * `scrubActor` converges an actor to condition-free state (exhaustion 0,
 * every status toggled off, every status-backed ActiveEffect deleted). The
 * probe scrubs both actors FIRST, snapshots that clean baseline, scrubs
 * between probes, and scrubs again at teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-remove-condition.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const removeTool = tools.find((t) => t.name === 'dnd5e_remove_condition');
const applyTool = tools.find((t) => t.name === 'dnd5e_apply_condition');
if (!removeTool || !applyTool) {
  log.error('dnd5e_remove_condition or dnd5e_apply_condition not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

function makeCall(tool) {
  return async function call(input) {
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
  };
}

const callRemove = makeCall(removeTool);
const callApply = makeCall(applyTool);

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Resolve test actors live.
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

  // Read live {statuses, exhaustion} for a post-call assertion.
  async function readActor(actorId) {
    return page.evaluate(async (id) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(120);
      const setArr = (s) => (s && typeof s[Symbol.iterator] === 'function' ? Array.from(s) : []);
      const actor = globalThis.game.actors.get(id);
      return {
        statuses: setArr(actor.statuses).sort(),
        exhaustion: actor._source?.system?.attributes?.exhaustion ?? 0,
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
  // Probe 1: remove a non-valued status (prone).
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: PC_ID, statusId: 'prone' });
    const res = await callRemove({ actorId: PC_ID, statusId: 'prone' });
    log.info({ probe: 1, res }, 'probe 1: remove prone (non-valued)');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 1: removed', { op: res.data.operation });
      assert(res.data.condition.valued === false, 'probe 1: valued=false', {
        valued: res.data.condition.valued,
      });
      assert(res.data.condition.previousValue === null, 'probe 1: previousValue=null', {
        previousValue: res.data.condition.previousValue,
      });
      assert(typeof res.data.effectId === 'string', 'probe 1: effectId is a string', {
        effectId: res.data.effectId,
      });
      const post = await readActor(PC_ID);
      assert(!post.statuses.includes('prone'), 'probe 1: prone gone from actor', { post });
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: remove a non-valued status not present → noop.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: PC_ID, statusId: 'prone' });
    log.info({ probe: 2, res }, 'probe 2: remove prone not present (noop)');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 2: noop', { op: res.data.operation });
      assert(res.data.reason === 'not_present', 'probe 2: reason=not_present', {
        reason: res.data.reason,
      });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 3: decrement exhaustion from level > 1 (apply 3, decrement).
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: PC_ID, statusId: 'exhaustion', value: 3 });
    const res = await callRemove({ actorId: PC_ID, statusId: 'exhaustion', mode: 'decrement' });
    log.info({ probe: 3, res }, 'probe 3: decrement exhaustion 3 → 2');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 3: decremented', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === 3, 'probe 3: previousValue=3', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.value === 2, 'probe 3: value=2', {
        value: res.data.condition.value,
      });
      const post = await readActor(PC_ID);
      assert(post.exhaustion === 2, 'probe 3: exhaustion=2 on actor', { post });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 4: decrement exhaustion from level 1 → removed.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: PC_ID, statusId: 'exhaustion', value: 1 });
    const res = await callRemove({ actorId: PC_ID, statusId: 'exhaustion', mode: 'decrement' });
    log.info({ probe: 4, res }, 'probe 4: decrement exhaustion 1 → removed');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 4: removed', { op: res.data.operation });
      assert(res.data.condition.previousValue === 1, 'probe 4: previousValue=1', {
        previousValue: res.data.condition.previousValue,
      });
      const post = await readActor(PC_ID);
      assert(post.exhaustion === 0, 'probe 4: exhaustion=0 on actor', { post });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 5: remove exhaustion with mode "remove" from level > 1.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: PC_ID, statusId: 'exhaustion', value: 4 });
    const res = await callRemove({ actorId: PC_ID, statusId: 'exhaustion', mode: 'remove' });
    log.info({ probe: 5, res }, 'probe 5: remove exhaustion 4 (mode=remove) → 0');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 5: removed', { op: res.data.operation });
      assert(res.data.condition.previousValue === 4, 'probe 5: previousValue=4', {
        previousValue: res.data.condition.previousValue,
      });
      const post = await readActor(PC_ID);
      assert(post.exhaustion === 0, 'probe 5: exhaustion=0 on actor', { post });
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 6: decrement exhaustion already at 0 → noop.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: PC_ID, statusId: 'exhaustion', mode: 'decrement' });
    log.info({ probe: 6, res }, 'probe 6: decrement exhaustion at 0 (noop)');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 6: noop', { op: res.data.operation });
      assert(res.data.reason === 'not_present', 'probe 6: reason=not_present', {
        reason: res.data.reason,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: cascade — remove unconscious, rider incapacitated drops too.
  // --------------------------------------------------------------------
  {
    const applied = await callApply({ actorId: PC_ID, statusId: 'unconscious' });
    log.info({ probe: 7, applied }, 'probe 7: setup — apply unconscious');
    const res = await callRemove({ actorId: PC_ID, statusId: 'unconscious' });
    log.info({ probe: 7, res }, 'probe 7: remove unconscious — rider cascade');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 7: removed', { op: res.data.operation });
      const cascade = res.data.cascadeRemoved ?? [];
      assert(
        cascade.includes('incapacitated'),
        'probe 7: cascadeRemoved includes incapacitated rider',
        { cascade },
      );
      const post = await readActor(PC_ID);
      assert(
        !post.statuses.includes('incapacitated') && !post.statuses.includes('unconscious'),
        'probe 7: unconscious + incapacitated both gone from actor',
        { post },
      );
    }
  }

  await scrubActor(PC_ID);

  // --------------------------------------------------------------------
  // Probe 8: remove a condition on the npc — actor-type parity.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: NPC_ID, statusId: 'poisoned' });
    const res = await callRemove({ actorId: NPC_ID, statusId: 'poisoned' });
    log.info({ probe: 8, res }, 'probe 8: remove poisoned from npc');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 8: removed', { op: res.data.operation });
      assert(res.data.actor.id === NPC_ID, 'probe 8: actor id echoed', {
        actorId: res.data.actor.id,
      });
    }
  }

  await scrubActor(NPC_ID);

  // --------------------------------------------------------------------
  // Probe 9: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: 'deadbeefdeadbeef', statusId: 'prone' });
    log.info({ probe: 9, res }, 'probe 9: bogus actorId');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 9: reason=ACTOR_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 10: unsupported actor type (skip if none in world).
  // --------------------------------------------------------------------
  if (actorIds.other) {
    const res = await callRemove({ actorId: actorIds.other.id, statusId: 'prone' });
    log.info({ probe: 10, res, otherType: actorIds.other.type }, 'probe 10: unsupported type');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 10: reason=ACTOR_TYPE_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  } else {
    log.info({ probe: 10 }, 'probe 10: skipped — no vehicle/group/encounter actor in world');
  }

  // --------------------------------------------------------------------
  // Probe 11: bogus statusId → STATUS_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: PC_ID, statusId: 'pronified' });
    log.info({ probe: 11, res }, 'probe 11: bogus statusId');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(res.error?.details?.reason === 'STATUS_NOT_FOUND', 'probe 11: reason=STATUS_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
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
  // Probe 12: teardown verification per actor.
  // --------------------------------------------------------------------
  for (const id of [PC_ID, NPC_ID]) {
    const snap = startSnapshot[id];
    const post = teardown[id];
    assert(
      JSON.stringify(post.statuses) === JSON.stringify(snap.statuses),
      `probe 12: ${snap.name} status set restored`,
      { actor: snap.name, post: post.statuses, expected: snap.statuses },
    );
    assert(post.exhaustion === snap.exhaustion, `probe 12: ${snap.name} exhaustion restored`, {
      actor: snap.name,
      post: post.exhaustion,
      expected: snap.exhaustion,
    });
    assert(
      JSON.stringify(post.effects) === JSON.stringify(snap.effects),
      `probe 12: ${snap.name} effect-name multiset restored`,
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
