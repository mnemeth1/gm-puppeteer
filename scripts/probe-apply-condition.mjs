/**
 * Probe + acceptance script for apply_condition. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Apply non-valued condition (off-guard) to clean character →
 *       operation: "applied", existedBefore: false, value: null,
 *       previousValue: null, valueRequested: null, valueApplied: null.
 *   2.  Apply non-valued already present → operation: "noop",
 *       reason: "already_present".
 *   3.  Apply valued condition with default value (frightened, no value)
 *       → frightened 1, valueRequested: 1, valueApplied: 1, clamped: false,
 *       existedBefore: false, previousValue: null, value: 1.
 *   4.  Apply valued with explicit value on existing-lower (frightened 1
 *       → apply 3) → applied, value: 3, previousValue: 1,
 *       existedBefore: true, clamped: false.
 *   5.  Apply valued at equal value (frightened 3 → apply 3) → noop,
 *       reason: "already_at_or_above_requested_value", value: 3.
 *   6.  Apply valued at lower value (frightened 3 → apply 1) → noop,
 *       reason: "already_at_or_above_requested_value", value: 3.
 *   7.  Apply valued exceeding max (frightened from scratch, value: 7) →
 *       valueApplied: 4 (PF2e cap), clamped: true.
 *   8.  Apply dying to clean character → dying 1, value: 1,
 *       cascadeGranted includes unconscious + blinded + prone.
 *   9.  Apply dying with wounded present (wounded 1 exists, apply dying
 *       1) → dying 1 (pure-declarative; wounded is NOT auto-added).
 *       Confirms Phase 1 Q3 contract.
 *   10. Apply wounded to clean character → wounded 1.
 *   11. Apply doomed 2 to clean character → doomed 2; verify
 *       dying.max reduced to 2 (4 - 2).
 *   12. Apply frightened to NPC (Goblin Warrior 1) — parity check.
 *   13. Error: bogus actorId → INVALID_INPUT / ACTOR_NOT_FOUND.
 *   14. Error: unsupported actor type (party actor) →
 *       ACTOR_TYPE_UNSUPPORTED.
 *   15. Error: bogus slug → CONDITION_NOT_FOUND.
 *   16. Error: value on non-valued (off-guard with value: 2) →
 *       VALUE_ON_NON_VALUED_CONDITION.
 *   17. Error: persistent-damage slug → PERSISTENT_DAMAGE_NOT_SUPPORTED.
 *   18. Teardown verification: post-teardown state (conditions multiset
 *       by slug+value+grantedBy, effects multiset by name, vitals
 *       attributes) equals the start-of-probe snapshot on both actors.
 *
 * State restoration model:
 *  - At probe start, snapshot conditions (per-item toObject() payloads),
 *    effects (per-item toObject() payloads), and vitals attributes
 *    (dying/wounded/doomed {value, max}) on every affected actor.
 *  - Conditions cascaded by PF2e on creation/deletion are part of the
 *    natural state — teardown does NOT try to preserve every cascade
 *    chain id-by-id. Instead, the post-teardown assertion checks the
 *    multiset signature (slug, value) ignoring ids, since Foundry assigns
 *    fresh ids on recreate.
 *  - Teardown order on each actor:
 *    1. Delete every condition currently present (force-remove via
 *       `decreaseCondition(slug, {forceRemove: true})` then sweep for
 *       orphans by id). Decrement loops the vitals attributes down to 0
 *       since the canonical source is the attribute path.
 *    2. Restore vitals attributes to snapshot values (writes to
 *       system.attributes.{dying|wounded|doomed}.value via actor.update).
 *    3. Recreate any snapshot conditions/effects that the current state
 *       lacks by replaying the saved toObject() payloads through
 *       createEmbeddedDocuments. (Foundry assigns new ids; the multiset
 *       signature check is id-agnostic.)
 *  - Final assertion per actor: post-teardown condition slug+value
 *    multiset == snapshot multiset; post-teardown effect name multiset
 *    == snapshot multiset; vitals attribute values == snapshot vitals.
 *
 *   npm run build && node scripts/probe-apply-condition.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'apply_condition');
if (!tool) {
  log.error('apply_condition not registered');
  process.exit(2);
}

const VALEROS_ID = 'wcD2h1fQmIxIab4B';
const GOBLIN_ID = 'QKC9vREnE3ajuVIF';
const PARTY_ID = 'xxxPF2ExPARTYxxx';

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
  // Snapshot: capture conditions/effects/vitals on Valeros + Goblin.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate(
    (actorIds) => {
      const out = {};
      for (const id of actorIds) {
        const actor = globalThis.game.actors?.get(id);
        if (!actor) {
          out[id] = { error: `actor ${id} not found` };
          continue;
        }
        out[id] = {
          name: actor.name,
          type: actor.type,
          conditions: actor.itemTypes.condition.map((c) => ({
            id: c.id,
            slug: c.system.slug,
            value: c.system.value.value,
            grantedById: c.flags?.pf2e?.grantedBy?.id ?? null,
            payload: c.toObject(),
          })),
          effects: actor.itemTypes.effect.map((e) => ({
            id: e.id,
            name: e.name,
            payload: e.toObject(),
          })),
          vitals: {
            dying: {
              value: actor.system.attributes.dying.value,
              max: actor.system.attributes.dying.max,
            },
            wounded: {
              value: actor.system.attributes.wounded.value,
              max: actor.system.attributes.wounded.max,
            },
            doomed: {
              value: actor.system.attributes.doomed.value,
              max: actor.system.attributes.doomed.max,
            },
          },
        };
      }
      return out;
    },
    [VALEROS_ID, GOBLIN_ID],
  );
  log.info(
    {
      valeros: {
        conditions: startSnapshot[VALEROS_ID]?.conditions?.length ?? 0,
        effects: startSnapshot[VALEROS_ID]?.effects?.length ?? 0,
        vitals: startSnapshot[VALEROS_ID]?.vitals,
      },
      goblin: {
        conditions: startSnapshot[GOBLIN_ID]?.conditions?.length ?? 0,
        effects: startSnapshot[GOBLIN_ID]?.effects?.length ?? 0,
        vitals: startSnapshot[GOBLIN_ID]?.vitals,
      },
    },
    'snapshot: start-of-probe state captured',
  );

  // --------------------------------------------------------------------
  // Reusable helper: clear all conditions on an actor in the headless
  // browser (used between probes to start each one from a clean slate
  // for that actor, and also as the first step of teardown).
  // --------------------------------------------------------------------
  async function clearConditions(actorId) {
    return page.evaluate(async (id) => {
      const actor = globalThis.game.actors?.get(id);
      if (!actor) return { error: 'no actor' };
      // First: clear vitals attributes (clears their derived condition
      // items via PF2e's preparation cycle, but we'll sweep stragglers
      // anyway).
      await actor.update({
        'system.attributes.dying.value': 0,
        'system.attributes.wounded.value': 0,
        'system.attributes.doomed.value': 0,
      });
      // Then: delete any remaining condition items. Loop because cascade
      // deletes may shrink the array during iteration.
      let remaining = actor.itemTypes.condition.map((c) => c.id);
      while (remaining.length > 0) {
        await actor.deleteEmbeddedDocuments('Item', remaining);
        remaining = actor.itemTypes.condition.map((c) => c.id);
      }
      return { ok: true, conditions: actor.itemTypes.condition.length };
    }, actorId);
  }

  // Reset to clean state on both actors before the happy-path probes.
  await clearConditions(VALEROS_ID);
  await clearConditions(GOBLIN_ID);

  // --------------------------------------------------------------------
  // Probe 1: apply non-valued (off-guard) on clean Valeros.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'off-guard' });
    log.info({ probe: 1, res }, 'probe 1: apply off-guard (non-valued)');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 1: applied', { op: res.data.operation });
      assert(res.data.condition.slug === 'off-guard', 'probe 1: slug echoed', {
        slug: res.data.condition.slug,
      });
      assert(res.data.condition.existedBefore === false, 'probe 1: existedBefore=false', {
        existedBefore: res.data.condition.existedBefore,
      });
      assert(res.data.condition.previousValue === null, 'probe 1: previousValue=null', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.value === null, 'probe 1: value=null (non-valued)', {
        value: res.data.condition.value,
      });
      assert(
        res.data.condition.valueRequested === null && res.data.condition.valueApplied === null,
        'probe 1: valueRequested/Applied null',
        {
          valueRequested: res.data.condition.valueRequested,
          valueApplied: res.data.condition.valueApplied,
        },
      );
      assert(res.data.condition.clamped === false, 'probe 1: clamped=false', {
        clamped: res.data.condition.clamped,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: apply non-valued already present → noop "already_present".
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'off-guard' });
    log.info({ probe: 2, res }, 'probe 2: apply off-guard already present (noop)');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 2: operation=noop', { op: res.data.operation });
      assert(res.data.reason === 'already_present', 'probe 2: reason=already_present', {
        reason: res.data.reason,
      });
      assert(res.data.condition.value === null, 'probe 2: value=null', {
        value: res.data.condition.value,
      });
    }
  }

  // Reset for next probe.
  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 3: apply valued with default value (frightened, no value).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'frightened' });
    log.info({ probe: 3, res }, 'probe 3: apply frightened (default value=1)');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 3: applied', { op: res.data.operation });
      assert(res.data.condition.value === 1, 'probe 3: value=1', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.valueRequested === 1, 'probe 3: valueRequested=1', {
        valueRequested: res.data.condition.valueRequested,
      });
      assert(res.data.condition.valueApplied === 1, 'probe 3: valueApplied=1', {
        valueApplied: res.data.condition.valueApplied,
      });
      assert(res.data.condition.previousValue === null, 'probe 3: previousValue=null', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.existedBefore === false, 'probe 3: existedBefore=false', {
        existedBefore: res.data.condition.existedBefore,
      });
      assert(res.data.condition.clamped === false, 'probe 3: clamped=false', {
        clamped: res.data.condition.clamped,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: apply on existing-lower (frightened 1 exists, apply 3).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 3 });
    log.info({ probe: 4, res }, 'probe 4: raise frightened 1 → 3');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 4: applied', { op: res.data.operation });
      assert(res.data.condition.previousValue === 1, 'probe 4: previousValue=1', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.existedBefore === true, 'probe 4: existedBefore=true', {
        existedBefore: res.data.condition.existedBefore,
      });
      assert(res.data.condition.value === 3, 'probe 4: value=3', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.valueRequested === 3, 'probe 4: valueRequested=3', {
        valueRequested: res.data.condition.valueRequested,
      });
      assert(res.data.condition.valueApplied === 3, 'probe 4: valueApplied=3', {
        valueApplied: res.data.condition.valueApplied,
      });
      assert(res.data.condition.clamped === false, 'probe 4: clamped=false', {
        clamped: res.data.condition.clamped,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: equal-value → noop.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 3 });
    log.info({ probe: 5, res }, 'probe 5: apply frightened 3 on frightened 3 (noop)');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 5: noop', { op: res.data.operation });
      assert(
        res.data.reason === 'already_at_or_above_requested_value',
        'probe 5: reason=already_at_or_above_requested_value',
        { reason: res.data.reason },
      );
      assert(res.data.condition.value === 3, 'probe 5: value=3', {
        value: res.data.condition.value,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: lower-value → noop.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 1 });
    log.info({ probe: 6, res }, 'probe 6: apply frightened 1 on frightened 3 (noop)');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 6: noop', { op: res.data.operation });
      assert(res.data.condition.value === 3, 'probe 6: value still 3', {
        value: res.data.condition.value,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 7: clamp (apply frightened value=7 from clean state → 4).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 7 });
    log.info({ probe: 7, res }, 'probe 7: frightened value=7 → clamped to 4');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 7: applied', { op: res.data.operation });
      assert(res.data.condition.valueRequested === 7, 'probe 7: valueRequested=7', {
        valueRequested: res.data.condition.valueRequested,
      });
      assert(res.data.condition.valueApplied === 4, 'probe 7: valueApplied=4', {
        valueApplied: res.data.condition.valueApplied,
      });
      assert(res.data.condition.value === 4, 'probe 7: value=4', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.clamped === true, 'probe 7: clamped=true', {
        clamped: res.data.condition.clamped,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 8: apply dying to clean character — verify cascade chain.
  //
  // Expected cascade: dying → unconscious → blinded + prone (4 entries
  // total in cascadeGranted = unconscious, blinded, prone).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'dying' });
    log.info({ probe: 8, res }, 'probe 8: apply dying (default 1) — cascade');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 8: applied', { op: res.data.operation });
      assert(res.data.condition.slug === 'dying', 'probe 8: slug=dying', {
        slug: res.data.condition.slug,
      });
      assert(res.data.condition.value === 1, 'probe 8: dying value=1', {
        value: res.data.condition.value,
      });
      const cascade = res.data.cascadeGranted ?? [];
      const cascadeSlugs = cascade.map((c) => c.slug).sort();
      assert(cascadeSlugs.includes('unconscious'), 'probe 8: cascadeGranted includes unconscious', {
        cascadeSlugs,
      });
      assert(
        cascadeSlugs.includes('blinded'),
        'probe 8: cascadeGranted includes blinded (transitive)',
        { cascadeSlugs },
      );
      assert(
        cascadeSlugs.includes('prone'),
        'probe 8: cascadeGranted includes prone (transitive)',
        { cascadeSlugs },
      );
      // Verify the actual attribute updated.
      const dyingValue = await page.evaluate((id) => {
        return globalThis.game.actors?.get(id)?.system.attributes.dying.value ?? null;
      }, VALEROS_ID);
      assert(dyingValue === 1, 'probe 8: actor.system.attributes.dying.value=1', { dyingValue });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 9: apply dying with wounded=1 present. Pure-declarative
  // contract: dying becomes 1, NOT 2. PF2e's wounded-adds-to-dying
  // interaction lives in actor.applyDamage and is NOT replicated here.
  // --------------------------------------------------------------------
  {
    // Set wounded directly via attribute update (faster than apply path).
    await page.evaluate(async (id) => {
      const actor = globalThis.game.actors?.get(id);
      await actor.update({ 'system.attributes.wounded.value': 1 });
    }, VALEROS_ID);
    const res = await call({ actorId: VALEROS_ID, slug: 'dying', value: 1 });
    log.info({ probe: 9, res }, 'probe 9: apply dying 1 with wounded 1 (pure-declarative)');
    assert(res.ok === true, 'probe 9: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 9: applied', { op: res.data.operation });
      assert(res.data.condition.value === 1, 'probe 9: dying=1 (NOT 2)', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.valueRequested === 1, 'probe 9: valueRequested=1', {
        valueRequested: res.data.condition.valueRequested,
      });
      assert(res.data.condition.valueApplied === 1, 'probe 9: valueApplied=1', {
        valueApplied: res.data.condition.valueApplied,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 10: apply wounded → wounded 1.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'wounded' });
    log.info({ probe: 10, res }, 'probe 10: apply wounded');
    assert(res.ok === true, 'probe 10: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 10: applied', { op: res.data.operation });
      assert(res.data.condition.value === 1, 'probe 10: wounded=1', {
        value: res.data.condition.value,
      });
      const wValue = await page.evaluate((id) => {
        return globalThis.game.actors?.get(id)?.system.attributes.wounded.value ?? null;
      }, VALEROS_ID);
      assert(wValue === 1, 'probe 10: actor.system.attributes.wounded.value=1', { wValue });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 11: apply doomed 2 → doomed 2; verify dying.max reduced.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'doomed', value: 2 });
    log.info({ probe: 11, res }, 'probe 11: apply doomed 2 → reduces dying.max');
    assert(res.ok === true, 'probe 11: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 11: applied', { op: res.data.operation });
      assert(res.data.condition.value === 2, 'probe 11: doomed=2', {
        value: res.data.condition.value,
      });
      const post = await page.evaluate((id) => {
        const a = globalThis.game.actors?.get(id);
        return {
          dying_max: a.system.attributes.dying.max,
          doomed_value: a.system.attributes.doomed.value,
        };
      }, VALEROS_ID);
      assert(post.dying_max === 2, 'probe 11: dying.max reduced to 2 (4 - doomed=2)', { post });
      assert(post.doomed_value === 2, 'probe 11: doomed.value=2', { post });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 12: apply frightened to NPC (Goblin Warrior) — parity check.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: GOBLIN_ID, slug: 'frightened', value: 2 });
    log.info({ probe: 12, res }, 'probe 12: apply frightened 2 to NPC');
    assert(res.ok === true, 'probe 12: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'applied', 'probe 12: applied', { op: res.data.operation });
      assert(res.data.condition.value === 2, 'probe 12: value=2', {
        value: res.data.condition.value,
      });
      assert(res.data.actor.id === GOBLIN_ID, 'probe 12: actor id echoed', {
        actorId: res.data.actor.id,
      });
    }
  }

  await clearConditions(GOBLIN_ID);

  // --------------------------------------------------------------------
  // Probe 13: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: 'deadbeef', slug: 'frightened' });
    log.info({ probe: 13, res }, 'probe 13: bogus actorId');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 13: reason=ACTOR_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 14: unsupported actor type (party).
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: PARTY_ID, slug: 'frightened' });
    log.info({ probe: 14, res }, 'probe 14: party actor unsupported');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 14: reason=ACTOR_TYPE_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 15: bogus slug → CONDITION_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'frighteded' });
    log.info({ probe: 15, res }, 'probe 15: bogus slug');
    assert(res.isError === true, 'probe 15: error', { res });
    assert(
      res.error?.details?.reason === 'CONDITION_NOT_FOUND',
      'probe 15: reason=CONDITION_NOT_FOUND',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 16: value on non-valued condition.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'off-guard', value: 2 });
    log.info({ probe: 16, res }, 'probe 16: value on non-valued');
    assert(res.isError === true, 'probe 16: error', { res });
    assert(
      res.error?.details?.reason === 'VALUE_ON_NON_VALUED_CONDITION',
      'probe 16: reason=VALUE_ON_NON_VALUED_CONDITION',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 17: persistent-damage rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({ actorId: VALEROS_ID, slug: 'persistent-damage' });
    log.info({ probe: 17, res }, 'probe 17: persistent-damage rejected');
    assert(res.isError === true, 'probe 17: error', { res });
    assert(
      res.error?.details?.reason === 'PERSISTENT_DAMAGE_NOT_SUPPORTED',
      'probe 17: reason=PERSISTENT_DAMAGE_NOT_SUPPORTED',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Teardown: clear all conditions on Valeros + Goblin, restore vitals
  // attributes to snapshot values, recreate any snapshot conditions/
  // effects that were lost (in our case, both actors arrived clean so
  // there is nothing to recreate, but the codepath stays correct for
  // future runs against polluted starts).
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorIds, snapshot) => {
      const report = {};
      for (const id of actorIds) {
        const actor = globalThis.game.actors?.get(id);
        if (!actor) {
          report[id] = { error: 'actor missing' };
          continue;
        }
        const snap = snapshot[id];
        if (!snap) {
          report[id] = { error: 'no snapshot' };
          continue;
        }

        // 1. Clear vitals attributes (this clears their derived condition
        // items via PF2e's preparation cycle). We do this BEFORE deleting
        // condition items so doomed reduction effects clear cleanly.
        await actor.update({
          'system.attributes.dying.value': 0,
          'system.attributes.wounded.value': 0,
          'system.attributes.doomed.value': 0,
        });

        // 2. Delete every remaining condition item. Loop to handle
        // cascade-deletes that shrink the array during iteration.
        let stragglers = actor.itemTypes.condition.map((c) => c.id);
        let iterations = 0;
        while (stragglers.length > 0 && iterations < 10) {
          await actor.deleteEmbeddedDocuments('Item', stragglers);
          stragglers = actor.itemTypes.condition.map((c) => c.id);
          iterations += 1;
        }

        // 3. Delete any orphan effect items (not in snapshot).
        // Conservative cleanup: delete every effect whose name doesn't
        // appear in the snapshot.
        const snapshotEffectNames = snap.effects.map((e) => e.name);
        const orphanEffects = actor.itemTypes.effect
          .filter((e) => !snapshotEffectNames.includes(e.name))
          .map((e) => e.id);
        if (orphanEffects.length > 0) {
          await actor.deleteEmbeddedDocuments('Item', orphanEffects);
        }

        // 4. Restore vitals to snapshot values (cascades will spawn the
        // appropriate condition items + chained children automatically).
        await actor.update({
          'system.attributes.dying.value': snap.vitals.dying.value,
          'system.attributes.wounded.value': snap.vitals.wounded.value,
          'system.attributes.doomed.value': snap.vitals.doomed.value,
        });

        // 5. Recreate any snapshot conditions whose slugs aren't present
        // post-vitals-restore. The vitals-restore step in (4) already
        // recreates dying/wounded/doomed condition items (and their
        // cascades). For non-vitals snapshot conditions (e.g., a frightened
        // entry someone left on the actor before the probe), we replay the
        // saved payload.
        const currentSlugs = new Set(actor.itemTypes.condition.map((c) => c.system.slug));
        const toRecreate = snap.conditions
          .filter((c) => !currentSlugs.has(c.slug) && c.grantedById === null)
          .map((c) => c.payload);
        if (toRecreate.length > 0) {
          await actor.createEmbeddedDocuments('Item', toRecreate);
        }

        // 6. Recreate any missing snapshot effects.
        const currentEffectNames = actor.itemTypes.effect.map((e) => e.name);
        const effectsToRecreate = snap.effects
          .filter((e) => !currentEffectNames.includes(e.name))
          .map((e) => e.payload);
        if (effectsToRecreate.length > 0) {
          await actor.createEmbeddedDocuments('Item', effectsToRecreate);
        }

        // 7. Report final state for assertion.
        report[id] = {
          conditions: actor.itemTypes.condition
            .map((c) => ({ slug: c.system.slug, value: c.system.value.value }))
            .sort((a, b) => a.slug.localeCompare(b.slug)),
          effects: actor.itemTypes.effect.map((e) => e.name).sort(),
          vitals: {
            dying: actor.system.attributes.dying.value,
            wounded: actor.system.attributes.wounded.value,
            doomed: actor.system.attributes.doomed.value,
          },
        };
      }
      return report;
    },
    [VALEROS_ID, GOBLIN_ID],
    startSnapshot,
  );
  log.info({ teardown }, 'teardown: restore vitals + clear added conditions');

  // --------------------------------------------------------------------
  // Probe 18: teardown verification per actor.
  //
  // Assert multiset equality on conditions (slug+value), effects (name),
  // and vitals (dying/wounded/doomed values).
  // --------------------------------------------------------------------
  for (const id of [VALEROS_ID, GOBLIN_ID]) {
    const snap = startSnapshot[id];
    const post = teardown[id];
    const expectedConds = snap.conditions
      .map((c) => ({ slug: c.slug, value: c.value }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const expectedEffects = snap.effects.map((e) => e.name).sort();
    assert(
      JSON.stringify(post.conditions) === JSON.stringify(expectedConds),
      `probe 18: ${snap.name} condition multiset matches snapshot`,
      { actor: snap.name, post: post.conditions, expected: expectedConds },
    );
    assert(
      JSON.stringify(post.effects) === JSON.stringify(expectedEffects),
      `probe 18: ${snap.name} effect multiset matches snapshot`,
      { actor: snap.name, post: post.effects, expected: expectedEffects },
    );
    assert(
      post.vitals.dying === snap.vitals.dying.value,
      `probe 18: ${snap.name} dying value restored`,
      { actor: snap.name, post: post.vitals.dying, expected: snap.vitals.dying.value },
    );
    assert(
      post.vitals.wounded === snap.vitals.wounded.value,
      `probe 18: ${snap.name} wounded value restored`,
      { actor: snap.name, post: post.vitals.wounded, expected: snap.vitals.wounded.value },
    );
    assert(
      post.vitals.doomed === snap.vitals.doomed.value,
      `probe 18: ${snap.name} doomed value restored`,
      { actor: snap.name, post: post.vitals.doomed, expected: snap.vitals.doomed.value },
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
