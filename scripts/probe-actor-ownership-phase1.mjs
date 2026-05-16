/**
 * Phase 1 design-blocking probes for the actor-ownership tool cluster
 * (list_users, list_actor_ownership, assign_actor_ownership,
 * remove_actor_ownership). Run BEFORE any tool code is written; the
 * tool design hangs on the answers.
 *
 * Target sandbox world. Test Valeros (wcD2h1fQmIxIab4B) is the
 * canonical mutation-probe actor; here we touch its `ownership` field
 * only and snapshot+restore around every experiment. Scratch users
 * (`__probe_owner_*`) are created and destroyed in-probe.
 *
 * Findings expected:
 *   1. Shape of `actor.ownership` on a canonical actor — keys, value
 *      types, presence of `default`.
 *   2. Numeric level constants from `CONST.DOCUMENT_OWNERSHIP_LEVELS`.
 *   3a. Whole-object update semantics: does
 *      `actor.update({ownership: {x: 2}})` REPLACE the map or MERGE?
 *   3b. Dot-path update semantics:
 *      `actor.update({"ownership.<id>": 2})`. Expected: surgical merge.
 *   4. Deletion sugar: `actor.update({"ownership.-=<id>": null})`.
 *      Does the key disappear or just go null?
 *   5. Default-key handling: setting non-zero, setting back to 0,
 *      attempting -= delete on `default`.
 *   6. Orphan-user entries: create user, assign ownership, delete
 *      user, observe whether the entry persists.
 *   7. Missing-actor / missing-user lookup behavior (null vs throw).
 *   8. Shape of `game.users.contents` for the future list_users tool.
 *
 *   npm run build && node scripts/probe-actor-ownership-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B';

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

  // --------------------------------------------------------------------
  // Pre-probe scrub: remove any leftover __probe_owner_* users AND any
  // orphan-user keys still sitting on Test Valeros's ownership map from
  // a prior failed run. We use `{recursive: false}` to force a full
  // replacement — Foundry's default merge wouldn't strip orphan keys.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const users = globalThis.game.users?.contents ?? [];
    const orphans = users.filter((u) =>
      typeof u.name === 'string' && u.name.startsWith('__probe_owner_'),
    );
    const deletedUsers = [];
    for (const u of orphans) {
      try {
        await u.delete();
        deletedUsers.push(u.id);
      } catch (e) {
        deletedUsers.push({ id: u.id, err: e?.message ?? String(e) });
      }
    }
    // Now strip orphan keys from actor.ownership. Build a clean replacement
    // map containing only `default` plus keys whose user still resolves.
    const actor = globalThis.game.actors?.get(actorId);
    const live = actor?.ownership ?? {};
    const clean = {};
    for (const k of Object.keys(live)) {
      if (k === 'default') {
        clean[k] = live[k];
        continue;
      }
      const u = globalThis.game.users.get(k);
      if (u) clean[k] = live[k];
    }
    let cleanupThrew = null;
    try {
      await actor.update({ ownership: clean }, { recursive: false });
    } catch (e) {
      cleanupThrew = e?.message ?? String(e);
    }
    return {
      deletedUsers,
      cleanupThrew,
      cleanOwnership: actor?.ownership,
      totalUsers: globalThis.game.users.size,
    };
  }, PROBE_ACTOR_ID);
  log.info({ scrub }, 'pre-probe scrub');

  // --------------------------------------------------------------------
  // Snapshot actor.ownership for teardown. Plain key→number map; safe
  // to deep-copy via JSON for ownership values (all scalars).
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    return {
      ownership: JSON.parse(JSON.stringify(actor.ownership ?? {})),
    };
  }, PROBE_ACTOR_ID);
  if (startSnapshot.error) {
    log.error({ startSnapshot }, 'snapshot failed; aborting');
    process.exit(2);
  }
  log.info({ startSnapshot }, 'snapshot captured');

  // ====================================================================
  // Q1: shape of actor.ownership on a canonical actor.
  // ====================================================================
  {
    const probe = await page.evaluate((actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const own = actor.ownership ?? {};
      const keys = Object.keys(own);
      const valueTypes = {};
      for (const k of keys) valueTypes[k] = typeof own[k];
      return {
        keys,
        valueTypes,
        hasDefault: Object.prototype.hasOwnProperty.call(own, 'default'),
        defaultValue: own.default,
        isPlainObject:
          own && typeof own === 'object' && Object.getPrototypeOf(own) === Object.prototype,
        constructor: own?.constructor?.name ?? null,
      };
    }, PROBE_ACTOR_ID);
    record('Q1', 'actor.ownership shape', probe);
    if (!probe.hasDefault) fail('Q1', '`default` key absent — unexpected', probe);
  }

  // ====================================================================
  // Q2: numeric level constants from CONST.DOCUMENT_OWNERSHIP_LEVELS.
  // ====================================================================
  {
    const probe = await page.evaluate(() => {
      const C = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS;
      return {
        present: !!C,
        constants: C ? { ...C } : null,
        userRoles: globalThis.CONST?.USER_ROLES ? { ...globalThis.CONST.USER_ROLES } : null,
      };
    });
    record('Q2', 'CONST.DOCUMENT_OWNERSHIP_LEVELS + USER_ROLES', probe);
    if (!probe.present) fail('Q2', 'CONST.DOCUMENT_OWNERSHIP_LEVELS missing', probe);
  }

  // ====================================================================
  // Q8 (early): shape of game.users.contents for list_users design.
  // ====================================================================
  {
    const probe = await page.evaluate(() => {
      const users = globalThis.game.users?.contents ?? [];
      return {
        count: users.length,
        sample: users.slice(0, 5).map((u) => ({
          id: u.id,
          name: u.name ?? null,
          role: u.role ?? null,
          isGM: u.isGM === true,
          active: u.active === true,
          hasUuid: typeof u.uuid === 'string',
          uuid: typeof u.uuid === 'string' ? u.uuid : null,
        })),
      };
    });
    record('Q8', 'game.users.contents projection sample', probe);
  }

  // ====================================================================
  // Set up scratch user for the mutation experiments below. Persist
  // across Q3a..Q5; cleanup happens at probe end.
  // ====================================================================
  const scratchUser1 = await page.evaluate(async () => {
    try {
      const u = await globalThis.User.create({
        name: '__probe_owner_alpha',
        role: globalThis.CONST?.USER_ROLES?.PLAYER ?? 1,
      });
      return { ok: true, id: u.id, name: u.name, role: u.role };
    } catch (e) {
      return { ok: false, err: e?.message ?? String(e) };
    }
  });
  if (!scratchUser1.ok) {
    fail('setup', 'failed to create scratch user', scratchUser1);
    throw new Error('cannot proceed without scratch user');
  }
  log.info({ scratchUser1 }, 'scratch user 1 created');

  // ====================================================================
  // Q3a: replace-vs-merge for `actor.update({ownership: {...}})`.
  //
  // Set ownership to {[scratch1]: 2}. Does this:
  //   (A) replace the whole map, dropping `default` and the GM's owner
  //       entry, etc.?
  //   (B) merge — leaving `default` etc. alone, just adding scratch1?
  //
  // Captures the keys present *before* and *after*. After the experiment,
  // restore ownership to the start snapshot.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, scratchId) => {
        const actor = globalThis.game.actors?.get(actorId);
        const before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        let threw = null;
        try {
          await actor.update({ ownership: { [scratchId]: 2 } });
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const after = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        return {
          threw,
          beforeKeys: Object.keys(before).sort(),
          afterKeys: Object.keys(after).sort(),
          beforeDefault: before.default,
          afterDefault: after.default,
          afterScratchLevel: after[scratchId],
          replaced:
            !('default' in after) ||
            Object.keys(after).every((k) => k === scratchId),
        };
      },
      PROBE_ACTOR_ID,
      scratchUser1.id,
    );
    record('Q3a', 'actor.update({ownership: {...}}) replace vs merge', probe);
  }

  // --- restore to startSnapshot before next experiment ---
  {
    const restore = await page.evaluate(
      async (actorId, snap) => {
        const actor = globalThis.game.actors?.get(actorId);
        // Use whole-object set — we know from Q3a how this behaves.
        await actor.update({ ownership: snap.ownership });
        return { ownership: JSON.parse(JSON.stringify(actor.ownership ?? {})) };
      },
      PROBE_ACTOR_ID,
      startSnapshot,
    );
    log.info({ ownership: restore.ownership }, 'restored after Q3a');
  }

  // ====================================================================
  // Q3b: dot-path update `actor.update({"ownership.<id>": 2})`.
  //
  // Expected: surgical merge — only the targeted key changes; `default`
  // and any other entries stay.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, scratchId) => {
        const actor = globalThis.game.actors?.get(actorId);
        const before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        let threw = null;
        try {
          await actor.update({ [`ownership.${scratchId}`]: 2 });
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const after = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        const beforeOther = Object.keys(before).filter((k) => k !== scratchId).sort();
        const afterOther = Object.keys(after).filter((k) => k !== scratchId).sort();
        const beforeOtherUnchanged = beforeOther.every((k) => before[k] === after[k]);
        return {
          threw,
          beforeKeys: Object.keys(before).sort(),
          afterKeys: Object.keys(after).sort(),
          beforeDefault: before.default,
          afterDefault: after.default,
          scratchLevel: after[scratchId],
          surgicalMerge:
            after[scratchId] === 2 &&
            beforeOther.join(',') === afterOther.join(',') &&
            beforeOtherUnchanged,
        };
      },
      PROBE_ACTOR_ID,
      scratchUser1.id,
    );
    record('Q3b', 'actor.update({"ownership.<id>": 2}) surgical-merge check', probe);
  }

  // ====================================================================
  // Q4: deletion via -= sugar:
  //     actor.update({"ownership.-=<id>": null})
  //
  // After Q3b, scratch1 is set to 2. Try to delete it and confirm the
  // key disappears from the map (not just gets nulled).
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, scratchId) => {
        const actor = globalThis.game.actors?.get(actorId);
        const before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        let threw = null;
        try {
          await actor.update({ [`ownership.-=${scratchId}`]: null });
        } catch (e) {
          threw = e?.message ?? String(e);
        }
        const after = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        return {
          threw,
          beforeHasScratch: Object.prototype.hasOwnProperty.call(before, scratchId),
          beforeScratchValue: before[scratchId],
          afterHasScratch: Object.prototype.hasOwnProperty.call(after, scratchId),
          afterScratchValue: after[scratchId],
          afterKeys: Object.keys(after).sort(),
          deletionWorked: !Object.prototype.hasOwnProperty.call(after, scratchId),
        };
      },
      PROBE_ACTOR_ID,
      scratchUser1.id,
    );
    record('Q4', '-= deletion form removes the key', probe);
  }

  // ====================================================================
  // Q4b: alternate deletion strategies (since -= didn't work in Q4).
  //
  //   Q4b1: actor.update({[`ownership.${id}`]: null})            — set to null
  //   Q4b2: actor.update({ownership: {...without_id}}, {recursive: false}) — replace map
  //   Q4b3: actor.update({ownership: {...without_id}})           — default merge form
  //
  // For each, observe whether the target key is actually gone (not just
  // present-but-null) after the call. Run each against a freshly-set
  // scratch entry to keep them independent.
  // ====================================================================
  {
    const probe = await page.evaluate(
      async (actorId, scratchId) => {
        const actor = globalThis.game.actors?.get(actorId);
        const out = {};

        // Helper: ensure scratch is set to 2 before each strategy.
        async function ensureScratchPresent() {
          await actor.update({ [`ownership.${scratchId}`]: 2 });
        }

        // Q4b1: set entry to null.
        await ensureScratchPresent();
        const b1Before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        let b1Threw = null;
        try {
          await actor.update({ [`ownership.${scratchId}`]: null });
        } catch (e) {
          b1Threw = e?.message ?? String(e);
        }
        const b1After = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        out.b1 = {
          strategy: 'ownership.<id> = null',
          threw: b1Threw,
          beforeHas: Object.prototype.hasOwnProperty.call(b1Before, scratchId),
          beforeValue: b1Before[scratchId],
          afterHas: Object.prototype.hasOwnProperty.call(b1After, scratchId),
          afterValue: b1After[scratchId],
          keyRemoved: !Object.prototype.hasOwnProperty.call(b1After, scratchId),
        };

        // Q4b2: replace ownership map without scratch, recursive: false.
        await ensureScratchPresent();
        const b2Before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        const b2Replacement = { ...b2Before };
        delete b2Replacement[scratchId];
        let b2Threw = null;
        try {
          await actor.update({ ownership: b2Replacement }, { recursive: false });
        } catch (e) {
          b2Threw = e?.message ?? String(e);
        }
        const b2After = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        out.b2 = {
          strategy: 'replace ownership map with {recursive: false}',
          threw: b2Threw,
          beforeHas: Object.prototype.hasOwnProperty.call(b2Before, scratchId),
          afterHas: Object.prototype.hasOwnProperty.call(b2After, scratchId),
          keyRemoved: !Object.prototype.hasOwnProperty.call(b2After, scratchId),
          afterKeys: Object.keys(b2After).sort(),
        };

        // Q4b3: replace ownership map without scratch, default merge form.
        await ensureScratchPresent();
        const b3Before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        const b3Replacement = { ...b3Before };
        delete b3Replacement[scratchId];
        let b3Threw = null;
        try {
          await actor.update({ ownership: b3Replacement });
        } catch (e) {
          b3Threw = e?.message ?? String(e);
        }
        const b3After = JSON.parse(JSON.stringify(actor.ownership ?? {}));
        out.b3 = {
          strategy: 'replace ownership map (default merge)',
          threw: b3Threw,
          beforeHas: Object.prototype.hasOwnProperty.call(b3Before, scratchId),
          afterHas: Object.prototype.hasOwnProperty.call(b3After, scratchId),
          keyRemoved: !Object.prototype.hasOwnProperty.call(b3After, scratchId),
        };

        return out;
      },
      PROBE_ACTOR_ID,
      scratchUser1.id,
    );
    record('Q4b', 'alternate deletion strategies', probe);
  }

  // --- restore to startSnapshot before next experiment ---
  // Use {recursive: false} to actually overwrite — default merge would
  // leave any extra keys behind.
  {
    await page.evaluate(
      async (actorId, snap) => {
        const actor = globalThis.game.actors?.get(actorId);
        await actor.update({ ownership: snap.ownership }, { recursive: false });
      },
      PROBE_ACTOR_ID,
      startSnapshot,
    );
  }

  // ====================================================================
  // Q5: default-key semantics.
  //
  //   Q5a: set ownership.default to OBSERVER (2).
  //   Q5b: set it back to NONE (0).
  //   Q5c: attempt -= delete of default. Foundry should either reject or
  //        silently re-add it as 0 (the implicit default).
  // ====================================================================
  {
    const probe = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const before = JSON.parse(JSON.stringify(actor.ownership ?? {}));
      const out = { before };

      // Q5a: set default to 2
      let threwA = null;
      try {
        await actor.update({ 'ownership.default': 2 });
      } catch (e) {
        threwA = e?.message ?? String(e);
      }
      out.afterA = JSON.parse(JSON.stringify(actor.ownership ?? {}));
      out.threwA = threwA;

      // Q5b: set default back to 0
      let threwB = null;
      try {
        await actor.update({ 'ownership.default': 0 });
      } catch (e) {
        threwB = e?.message ?? String(e);
      }
      out.afterB = JSON.parse(JSON.stringify(actor.ownership ?? {}));
      out.threwB = threwB;

      // Q5c: try -= delete on default
      let threwC = null;
      try {
        await actor.update({ 'ownership.-=default': null });
      } catch (e) {
        threwC = e?.message ?? String(e);
      }
      out.afterC = JSON.parse(JSON.stringify(actor.ownership ?? {}));
      out.threwC = threwC;
      out.defaultStillPresent = Object.prototype.hasOwnProperty.call(out.afterC, 'default');
      out.defaultValueAfterC = out.afterC.default;

      return out;
    }, PROBE_ACTOR_ID);
    record('Q5', 'default-key set/clear/delete semantics', probe);
  }

  // --- restore to startSnapshot before next experiment ---
  {
    await page.evaluate(
      async (actorId, snap) => {
        const actor = globalThis.game.actors?.get(actorId);
        await actor.update({ ownership: snap.ownership }, { recursive: false });
      },
      PROBE_ACTOR_ID,
      startSnapshot,
    );
  }

  // ====================================================================
  // Q6: orphan-user entries.
  //
  // Create a second scratch user, assign ownership level 3 to it on the
  // actor, delete the user, then observe:
  //   - Does actor.ownership still contain the deleted user's id?
  //   - Does game.users.get(deletedId) return null?
  //   - Does the orphan key prevent .update() from working?
  // ====================================================================
  {
    const scratchUser2 = await page.evaluate(async () => {
      try {
        const u = await globalThis.User.create({
          name: '__probe_owner_beta',
          role: globalThis.CONST?.USER_ROLES?.PLAYER ?? 1,
        });
        return { ok: true, id: u.id };
      } catch (e) {
        return { ok: false, err: e?.message ?? String(e) };
      }
    });
    if (!scratchUser2.ok) {
      fail('Q6', 'failed to create scratch user 2', scratchUser2);
    } else {
      const probe = await page.evaluate(
        async (actorId, victimId) => {
          const actor = globalThis.game.actors?.get(actorId);
          // Assign ownership
          await actor.update({ [`ownership.${victimId}`]: 3 });
          const afterAssign = JSON.parse(JSON.stringify(actor.ownership ?? {}));

          // Delete the user
          const victim = globalThis.game.users.get(victimId);
          let deleteThrew = null;
          try {
            await victim.delete();
          } catch (e) {
            deleteThrew = e?.message ?? String(e);
          }
          const afterDelete = JSON.parse(JSON.stringify(actor.ownership ?? {}));
          const lookupAfter = globalThis.game.users.get(victimId);

          // Probe whether we can still .update() the actor with an orphan key present.
          let updateThrew = null;
          try {
            await actor.update({ 'ownership.default': 0 });
          } catch (e) {
            updateThrew = e?.message ?? String(e);
          }

          // Probe whether we can delete the orphan entry via -=.
          let orphanDeleteThrew = null;
          try {
            await actor.update({ [`ownership.-=${victimId}`]: null });
          } catch (e) {
            orphanDeleteThrew = e?.message ?? String(e);
          }
          const afterOrphanDelete = JSON.parse(JSON.stringify(actor.ownership ?? {}));

          return {
            deleteThrew,
            afterAssignHasVictim: Object.prototype.hasOwnProperty.call(afterAssign, victimId),
            afterDeleteHasVictim: Object.prototype.hasOwnProperty.call(afterDelete, victimId),
            afterDeleteVictimValue: afterDelete[victimId],
            userLookupReturned: lookupAfter ?? null,
            userLookupType: typeof lookupAfter,
            updateThrew,
            orphanDeleteThrew,
            orphanDeletedSuccessfully:
              !Object.prototype.hasOwnProperty.call(afterOrphanDelete, victimId),
          };
        },
        PROBE_ACTOR_ID,
        scratchUser2.id,
      );
      record('Q6', 'orphan-user entry behavior', probe);
    }
  }

  // --- restore to startSnapshot before next experiment ---
  {
    await page.evaluate(
      async (actorId, snap) => {
        const actor = globalThis.game.actors?.get(actorId);
        await actor.update({ ownership: snap.ownership }, { recursive: false });
      },
      PROBE_ACTOR_ID,
      startSnapshot,
    );
  }

  // ====================================================================
  // Q7: missing-actor / missing-user lookups.
  //
  // Confirm game.actors.get('bogus') and game.users.get('bogus') return
  // null/undefined cleanly (no throw). Drives the INVALID_INPUT error
  // paths in the tool layer.
  // ====================================================================
  {
    const probe = await page.evaluate(() => {
      let actorLookup = 'unset';
      let userLookup = 'unset';
      let actorLookupThrew = null;
      let userLookupThrew = null;
      try {
        actorLookup = globalThis.game.actors?.get('bogus-actor-id-xxxxxxxx') ?? null;
      } catch (e) {
        actorLookupThrew = e?.message ?? String(e);
      }
      try {
        userLookup = globalThis.game.users?.get('bogus-user-id-xxxxxxxx') ?? null;
      } catch (e) {
        userLookupThrew = e?.message ?? String(e);
      }
      return {
        actorLookupIsNull: actorLookup === null,
        userLookupIsNull: userLookup === null,
        actorLookupThrew,
        userLookupThrew,
      };
    });
    record('Q7', 'missing-actor / missing-user lookup behavior', probe);
  }

  // --------------------------------------------------------------------
  // Teardown — restore ownership to start-of-probe snapshot, delete
  // any scratch users we created (alpha and any beta left behind).
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snap) => {
      // Restore ownership exactly to snapshot. Use {recursive: false}
      // to force replacement — default merge wouldn't drop extra keys.
      const actor = globalThis.game.actors?.get(actorId);
      await actor.update({ ownership: snap.ownership }, { recursive: false });
      const restored = JSON.parse(JSON.stringify(actor.ownership ?? {}));

      // Delete any remaining __probe_owner_* users.
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
        expectedKeys,
        liveKeys,
        keyMatch,
        valueMismatch,
        scratchUsersDeleted: deleted,
        totalUsers: globalThis.game.users.size,
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
  log.info(
    { findings, errors, errorCount: errors.length, findingCount: findings.length },
    'PHASE 1 SUMMARY',
  );
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
