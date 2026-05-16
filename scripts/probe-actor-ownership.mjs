/**
 * End-to-end probe for the actor-ownership tool cluster. Runs each
 * tool's `handler()` against the live headless Foundry, covering
 * happy paths, edge cases, and error paths.
 *
 * Test target: Test Valeros (wcD2h1fQmIxIab4B). Sandbox users:
 *   - Claude-GM         (LakGyOkUKV8ckUqJ, role 4 GAMEMASTER, active)
 *   - Human-GM          (GMAtDqFwcISqSt2g, role 4 GAMEMASTER)
 *   - Player            (4lh5nwANHLiRFQBl, role 2 TRUSTED)
 *
 * The probe snapshots `actor.ownership` at start and restores it on exit
 * via the {recursive: false} replacement form (the only working
 * deletion mechanism per probe-actor-ownership-phase1.mjs).
 *
 *   npm run build && node scripts/probe-actor-ownership.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { listUsersTool } from '../dist/tools/list-users.js';
import { listActorOwnershipTool } from '../dist/tools/list-actor-ownership.js';
import { assignActorOwnershipTool } from '../dist/tools/assign-actor-ownership.js';
import { removeActorOwnershipTool } from '../dist/tools/remove-actor-ownership.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';
const HUMAN_GM_ID = 'GMAtDqFwcISqSt2g';
const PLAYER_ID = '4lh5nwANHLiRFQBl';
const BOGUS_ACTOR_ID = 'bogus-actor-id-xxxx';
const BOGUS_USER_ID = 'bogus-user-id-xxxxx';

const findings = [];
const errors = [];

function record(testId, label, value) {
  findings.push({ testId, label, value });
  log.info({ testId, label, value }, 'finding');
}

function fail(testId, label, ctx) {
  errors.push({ testId, label, ctx });
  log.error({ testId, label, ctx }, 'TEST FAILURE');
}

function check(testId, label, cond, ctx) {
  if (cond) {
    record(testId, label, { ok: true });
  } else {
    fail(testId, label, ctx);
  }
}

function parseToolResult(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const first = blocks[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return null;
  }
}

async function callTool(tool, input, ctx) {
  try {
    const blocks = await tool.handler(input, ctx);
    return { ok: true, value: parseToolResult(blocks) };
  } catch (err) {
    return {
      ok: false,
      err: {
        message: err?.message ?? String(err),
        code: err?.code ?? null,
        details: err?.details ?? null,
      },
    };
  }
}

try {
  await session.ensureStarted();
  const { page } = await session.ensureStarted();
  const ctx = { browser: session, log };

  // --------------------------------------------------------------------
  // Pre-probe scrub: remove any leftover scratch users, and reset
  // Test Valeros's ownership to whatever state was captured. We snapshot
  // AFTER scrubbing so a prior failed run can't pollute the baseline.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    // Delete leftover __probe_owner_* users.
    const orphans = (globalThis.game.users?.contents ?? []).filter(
      (u) => typeof u.name === 'string' && u.name.startsWith('__probe_owner_'),
    );
    const deleted = [];
    for (const u of orphans) {
      try {
        await u.delete();
        deleted.push(u.id);
      } catch (e) {
        deleted.push({ id: u.id, err: e?.message ?? String(e) });
      }
    }
    // Strip orphan keys from actor.ownership.
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    const live = actor.ownership ?? {};
    const clean = {};
    for (const k of Object.keys(live)) {
      if (k === 'default') {
        clean[k] = live[k];
        continue;
      }
      if (globalThis.game.users.get(k)) clean[k] = live[k];
    }
    await actor.update({ ownership: clean }, { recursive: false });
    return {
      deletedUsers: deleted,
      cleanOwnership: actor.ownership,
    };
  }, PROBE_ACTOR_ID);
  log.info({ scrub }, 'pre-probe scrub');

  // Snapshot ownership for teardown.
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    return { ownership: JSON.parse(JSON.stringify(actor.ownership ?? {})) };
  }, PROBE_ACTOR_ID);
  log.info({ startSnapshot }, 'snapshot captured');

  // The human GM's display name, captured from list_users in T1 and
  // reused by later userName-resolution assertions (T3/T4/T7).
  let humanGmName = null;

  // ====================================================================
  // T1: list_users — verify includes the three known sandbox users.
  // ====================================================================
  {
    const r = await callTool(listUsersTool, {}, ctx);
    check('T1', 'list_users succeeds', r.ok && Array.isArray(r.value?.users), r);
    if (r.ok && Array.isArray(r.value?.users)) {
      const byId = new Map(r.value.users.map((u) => [u.id, u]));
      const claudeGm = byId.get('LakGyOkUKV8ckUqJ');
      const humanGm = byId.get(HUMAN_GM_ID);
      humanGmName = humanGm?.name ?? null;
      const player = byId.get(PLAYER_ID);
      check('T1.a', 'Claude-GM present, isGM=true', !!claudeGm && claudeGm.isGM === true, claudeGm);
      check('T1.b', 'Human-GM present, isGM=true', !!humanGm && humanGm.isGM === true, humanGm);
      check(
        'T1.c',
        'Player present, isGM=false, role=2 (TRUSTED)',
        !!player && player.isGM === false && player.role === 2,
        player,
      );
      check(
        'T1.d',
        'all rows have id, name, role, isGM, active',
        r.value.users.every(
          (u) =>
            typeof u.id === 'string' &&
            typeof u.name === 'string' &&
            typeof u.role === 'number' &&
            typeof u.isGM === 'boolean' &&
            typeof u.active === 'boolean',
        ),
        r.value.users,
      );
    }
  }

  // ====================================================================
  // T2: list_actor_ownership baseline.
  // ====================================================================
  let baselineDefault = null;
  let baselineHumanGmLevel = null;
  {
    const r = await callTool(listActorOwnershipTool, { actorId: PROBE_ACTOR_ID }, ctx);
    check('T2', 'list_actor_ownership succeeds', r.ok && r.value?.ok === true, r);
    if (r.ok && r.value?.ok) {
      baselineDefault = r.value.default;
      const mg = (r.value.users ?? []).find((u) => u.userId === HUMAN_GM_ID);
      baselineHumanGmLevel = mg?.level ?? null;
      check('T2.a', 'actor.id matches', r.value.actor?.id === PROBE_ACTOR_ID, r.value.actor);
      check(
        'T2.b',
        'default is one of the four enum strings',
        ['NONE', 'LIMITED', 'OBSERVER', 'OWNER'].includes(r.value.default),
        r.value.default,
      );
      check('T2.c', 'users is array', Array.isArray(r.value.users), r.value.users);
      check(
        'T2.d',
        'all user entries have userId, userName, level',
        (r.value.users ?? []).every(
          (e) =>
            typeof e.userId === 'string' &&
            (typeof e.userName === 'string' || e.userName === null) &&
            ['NONE', 'LIMITED', 'OBSERVER', 'OWNER'].includes(e.level),
        ),
        r.value.users,
      );
    }
  }

  // ====================================================================
  // T3: assign_actor_ownership — assign Human-GM as OBSERVER.
  //
  // baselineHumanGmLevel may be null (no entry) or some level. Either
  // way, after this call newLevel must be OBSERVER and operation must
  // reflect whether it pre-existed.
  // ====================================================================
  {
    const r = await callTool(
      assignActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: HUMAN_GM_ID, level: 'OBSERVER' },
      ctx,
    );
    check('T3', 'assign Human-GM=OBSERVER succeeds', r.ok && r.value?.ok === true, r);
    if (r.ok && r.value?.ok) {
      check('T3.a', 'newLevel=OBSERVER', r.value.newLevel === 'OBSERVER', r.value);
      check('T3.b', 'userId matches', r.value.userId === HUMAN_GM_ID, r.value);
      check('T3.c', 'userName resolved to Human-GM', r.value.userName === humanGmName, r.value);
      check(
        'T3.d',
        'previousLevel + operation are internally consistent',
        (baselineHumanGmLevel === null &&
          r.value.previousLevel === null &&
          r.value.operation === 'created') ||
          (baselineHumanGmLevel !== null &&
            r.value.previousLevel === baselineHumanGmLevel &&
            r.value.operation === 'updated'),
        { baselineHumanGmLevel, value: r.value },
      );
    }
  }

  // ====================================================================
  // T4: list_actor_ownership reflects T3.
  // ====================================================================
  {
    const r = await callTool(listActorOwnershipTool, { actorId: PROBE_ACTOR_ID }, ctx);
    if (r.ok && r.value?.ok) {
      const mg = (r.value.users ?? []).find((u) => u.userId === HUMAN_GM_ID);
      check('T4.a', 'Human-GM appears in list', !!mg, r.value.users);
      check('T4.b', 'Human-GM level=OBSERVER', mg?.level === 'OBSERVER', mg);
      check('T4.c', 'Human-GM userName matches list_users', mg?.userName === humanGmName, mg);
    } else {
      fail('T4', 'list_actor_ownership failed', r);
    }
  }

  // ====================================================================
  // T5: assign_actor_ownership — re-assign Human-GM to LIMITED.
  //
  // Verifies the "updated" operation path: previousLevel=OBSERVER.
  // ====================================================================
  {
    const r = await callTool(
      assignActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: HUMAN_GM_ID, level: 'LIMITED' },
      ctx,
    );
    if (r.ok && r.value?.ok) {
      check('T5.a', 'operation=updated', r.value.operation === 'updated', r.value);
      check('T5.b', 'previousLevel=OBSERVER', r.value.previousLevel === 'OBSERVER', r.value);
      check('T5.c', 'newLevel=LIMITED', r.value.newLevel === 'LIMITED', r.value);
    } else {
      fail('T5', 'assign Human-GM=LIMITED failed', r);
    }
  }

  // ====================================================================
  // T6: assign_actor_ownership — set default to OBSERVER.
  //
  // Verifies the "default" sentinel write path.
  // ====================================================================
  {
    const r = await callTool(
      assignActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: 'default', level: 'OBSERVER' },
      ctx,
    );
    if (r.ok && r.value?.ok) {
      check('T6.a', 'newLevel=OBSERVER', r.value.newLevel === 'OBSERVER', r.value);
      check('T6.b', 'operation=updated', r.value.operation === 'updated', r.value);
      check(
        'T6.c',
        'previousLevel matches baseline default',
        r.value.previousLevel === baselineDefault,
        { value: r.value, baselineDefault },
      );
      check('T6.d', 'userId=default', r.value.userId === 'default', r.value);
      check('T6.e', 'userName=null for default sentinel', r.value.userName === null, r.value);
    } else {
      fail('T6', 'assign default=OBSERVER failed', r);
    }
  }

  // Verify the list reflects the new default.
  {
    const r = await callTool(listActorOwnershipTool, { actorId: PROBE_ACTOR_ID }, ctx);
    if (r.ok && r.value?.ok) {
      check('T6.list', 'list shows default=OBSERVER', r.value.default === 'OBSERVER', r.value);
    }
  }

  // ====================================================================
  // T7: remove_actor_ownership — clear Human-GM. Should fall back to
  // the actor's default (currently OBSERVER from T6).
  // ====================================================================
  {
    const r = await callTool(
      removeActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: HUMAN_GM_ID },
      ctx,
    );
    if (r.ok && r.value?.ok) {
      check('T7.a', 'previousLevel=LIMITED', r.value.previousLevel === 'LIMITED', r.value);
      check('T7.b', 'fellBackTo=OBSERVER', r.value.fellBackTo === 'OBSERVER', r.value);
      check('T7.c', 'userName=Human-GM', r.value.userName === humanGmName, r.value);
    } else {
      fail('T7', 'remove Human-GM failed', r);
    }
  }

  // Verify the list no longer contains Human-GM.
  {
    const r = await callTool(listActorOwnershipTool, { actorId: PROBE_ACTOR_ID }, ctx);
    if (r.ok && r.value?.ok) {
      const mg = (r.value.users ?? []).find((u) => u.userId === HUMAN_GM_ID);
      check('T7.list', 'Human-GM absent after remove', !mg, r.value.users);
    }
  }

  // ====================================================================
  // T8: orphan cleanup path. Create a scratch user, assign ownership,
  // delete the user, then verify list_actor_ownership surfaces it with
  // userName: null and remove_actor_ownership cleans it up.
  // ====================================================================
  {
    const scratch = await page.evaluate(async () => {
      try {
        const u = await globalThis.User.create({
          name: '__probe_owner_orphan',
          role: globalThis.CONST?.USER_ROLES?.PLAYER ?? 1,
        });
        return { ok: true, id: u.id };
      } catch (e) {
        return { ok: false, err: e?.message ?? String(e) };
      }
    });
    if (!scratch.ok) {
      fail('T8.setup', 'failed to create scratch user', scratch);
    } else {
      // Assign before user is deleted.
      const r1 = await callTool(
        assignActorOwnershipTool,
        { actorId: PROBE_ACTOR_ID, userId: scratch.id, level: 'OWNER' },
        ctx,
      );
      check('T8.a', 'assign scratch=OWNER succeeded', r1.ok && r1.value?.ok === true, r1);

      // Delete the user.
      const deleteUser = await page.evaluate(async (id) => {
        const u = globalThis.game.users.get(id);
        try {
          await u.delete();
          return { ok: true };
        } catch (e) {
          return { ok: false, err: e?.message ?? String(e) };
        }
      }, scratch.id);
      check('T8.b', 'scratch user deleted', deleteUser.ok === true, deleteUser);

      // list_actor_ownership should surface the orphan with userName=null.
      const r2 = await callTool(listActorOwnershipTool, { actorId: PROBE_ACTOR_ID }, ctx);
      if (r2.ok && r2.value?.ok) {
        const orphan = (r2.value.users ?? []).find((u) => u.userId === scratch.id);
        check('T8.c', 'orphan appears in list', !!orphan, r2.value.users);
        check('T8.d', 'orphan.userName=null', orphan?.userName === null, orphan);
        check('T8.e', 'orphan.level=OWNER', orphan?.level === 'OWNER', orphan);
      } else {
        fail('T8.list', 'list_actor_ownership failed', r2);
      }

      // remove_actor_ownership should clean up the orphan.
      const r3 = await callTool(
        removeActorOwnershipTool,
        { actorId: PROBE_ACTOR_ID, userId: scratch.id },
        ctx,
      );
      if (r3.ok && r3.value?.ok) {
        check('T8.f', 'remove orphan succeeded', true, r3.value);
        check('T8.g', 'orphan previousLevel=OWNER', r3.value.previousLevel === 'OWNER', r3.value);
        check('T8.h', 'orphan userName=null (user deleted)', r3.value.userName === null, r3.value);
      } else {
        fail('T8.remove', 'remove orphan failed', r3);
      }

      // Confirm it's gone.
      const r4 = await callTool(listActorOwnershipTool, { actorId: PROBE_ACTOR_ID }, ctx);
      if (r4.ok && r4.value?.ok) {
        const stillThere = (r4.value.users ?? []).find((u) => u.userId === scratch.id);
        check('T8.i', 'orphan absent after remove', !stillThere, r4.value.users);
      }
    }
  }

  // ====================================================================
  // T9: error paths — assign with bogus actorId.
  // ====================================================================
  {
    const r = await callTool(
      assignActorOwnershipTool,
      { actorId: BOGUS_ACTOR_ID, userId: PLAYER_ID, level: 'OBSERVER' },
      ctx,
    );
    check('T9', 'assign bogus actor rejected', r.ok === false, r);
    check('T9.a', 'error code INVALID_INPUT', r.err?.code === 'INVALID_INPUT', r.err);
    check(
      'T9.b',
      'error reason=ACTOR_NOT_FOUND',
      r.err?.details?.reason === 'ACTOR_NOT_FOUND',
      r.err,
    );
  }

  // T10: assign with bogus userId.
  {
    const r = await callTool(
      assignActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: BOGUS_USER_ID, level: 'OBSERVER' },
      ctx,
    );
    check('T10', 'assign bogus user rejected', r.ok === false, r);
    check(
      'T10.a',
      'error reason=USER_NOT_FOUND',
      r.err?.details?.reason === 'USER_NOT_FOUND',
      r.err,
    );
  }

  // T11: remove with userId=default rejected.
  {
    const r = await callTool(
      removeActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: 'default' },
      ctx,
    );
    check('T11', 'remove default rejected', r.ok === false, r);
    check(
      'T11.a',
      'error reason=CANNOT_REMOVE_DEFAULT',
      r.err?.details?.reason === 'CANNOT_REMOVE_DEFAULT',
      r.err,
    );
  }

  // T12: remove with bogus actorId.
  {
    const r = await callTool(
      removeActorOwnershipTool,
      { actorId: BOGUS_ACTOR_ID, userId: PLAYER_ID },
      ctx,
    );
    check('T12', 'remove on bogus actor rejected', r.ok === false, r);
    check(
      'T12.a',
      'error reason=ACTOR_NOT_FOUND',
      r.err?.details?.reason === 'ACTOR_NOT_FOUND',
      r.err,
    );
  }

  // T13: remove a user with no explicit entry → NOT_PRESENT.
  {
    const r = await callTool(
      removeActorOwnershipTool,
      { actorId: PROBE_ACTOR_ID, userId: PLAYER_ID },
      ctx,
    );
    check('T13', 'remove not-present rejected', r.ok === false, r);
    check('T13.a', 'error reason=NOT_PRESENT', r.err?.details?.reason === 'NOT_PRESENT', r.err);
  }

  // --------------------------------------------------------------------
  // Teardown — restore ownership exactly to start snapshot, delete any
  // remaining scratch users.
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snap) => {
      const actor = globalThis.game.actors?.get(actorId);
      await actor.update({ ownership: snap.ownership }, { recursive: false });
      const restored = JSON.parse(JSON.stringify(actor.ownership ?? {}));

      const orphans = (globalThis.game.users?.contents ?? []).filter(
        (u) => typeof u.name === 'string' && u.name.startsWith('__probe_owner_'),
      );
      const deleted = [];
      for (const u of orphans) {
        try {
          await u.delete();
          deleted.push(u.id);
        } catch (e) {
          deleted.push({ id: u.id, err: e?.message ?? String(e) });
        }
      }

      const expectedKeys = Object.keys(snap.ownership).sort();
      const liveKeys = Object.keys(restored).sort();
      const keyMatch = expectedKeys.join(',') === liveKeys.join(',');
      const valueMismatch = expectedKeys.filter((k) => restored[k] !== snap.ownership[k]);

      return {
        restoredOwnership: restored,
        keyMatch,
        valueMismatch,
        scratchUsersDeleted: deleted,
      };
    },
    PROBE_ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown complete');
  if (!teardown.keyMatch || teardown.valueMismatch.length > 0) {
    fail('teardown', 'ownership did not restore cleanly', teardown);
  }

  // --------------------------------------------------------------------
  // Final report.
  // --------------------------------------------------------------------
  log.info({ findingCount: findings.length, errorCount: errors.length, errors }, 'PROBE SUMMARY');
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
