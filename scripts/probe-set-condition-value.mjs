/**
 * Probe + acceptance script for set_condition_value. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world.
 *
 * Phase 1 (going-down API discovery) — runs by default. Five readback
 * experiments against raw page.evaluate (no tool call):
 *   1.A Non-vital direct update: seed frightened=4, call
 *       actor.updateEmbeddedDocuments('Item', [{_id, 'system.value.value': 2}]).
 *       Confirm sheet/_source/system all reflect 2 and the condition item
 *       remains attached cleanly.
 *   1.B Non-vital decreaseCondition loop control: seed frightened=4, loop
 *       decreaseCondition('frightened') twice. Same readback.
 *   1.C Vital via item update: seed dying=3, updateEmbeddedDocuments on
 *       the dying item, confirm system.attributes.dying.value AND the
 *       item's _source/system both reflect the change, cascade children
 *       (unconscious + blinded + prone) survive.
 *   1.D Vital via attribute update: seed dying=3,
 *       actor.update({'system.attributes.dying.value': 2}). Same readbacks.
 *   1.E Vital decreaseCondition control: seed dying=3, single
 *       decreaseCondition('dying'). Same readbacks.
 *
 * Phase 2 (tool acceptance) — gated behind a future flag. Phase 3 (teardown
 * multiset verification) likewise.
 *
 * State restoration model: full toObject() payloads snapshotted at start,
 * vitals attributes captured, post-teardown assertion is multiset-equal on
 * (slug, value) + effect name + vital values. Same shape as
 * scripts/probe-apply-condition.mjs.
 *
 *   npm run build && node scripts/probe-set-condition-value.mjs
 *   npm run build && node scripts/probe-set-condition-value.mjs --phase=1
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
const phase = phaseArg ? phaseArg.split('=')[1] : 'all';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'set_condition_value');
if (!tool) {
  log.error('set_condition_value not registered');
  process.exit(2);
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

// `callRaw` calls the evaluator directly (skips zod) — used for probe 10
// which exercises the evaluator's defensive value-zero guard.
async function callRaw(page, args) {
  const { setConditionValueBody } = await import('../dist/evaluators/set-condition-value.js');
  const result = await page.evaluate(setConditionValueBody, args);
  return result;
}

const PARTY_ID = 'xxxPF2ExPARTYxxx';

const VALEROS_ID = 'wcD2h1fQmIxIab4B';
const GOBLIN_ID = 'QKC9vREnE3ajuVIF';

const failures = [];

function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Snapshot conditions/effects/vitals on both actors. Used by Phase 3
  // teardown; safe to capture even when running Phase 1 only.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorIds) => {
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
          dying: { value: actor.system.attributes.dying.value, max: actor.system.attributes.dying.max },
          wounded: { value: actor.system.attributes.wounded.value, max: actor.system.attributes.wounded.max },
          doomed: { value: actor.system.attributes.doomed.value, max: actor.system.attributes.doomed.max },
        },
      };
    }
    return out;
  }, [VALEROS_ID, GOBLIN_ID]);
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
  // Reusable helper: clear all conditions on an actor.
  // --------------------------------------------------------------------
  async function clearConditions(actorId) {
    return page.evaluate(async (id) => {
      const actor = globalThis.game.actors?.get(id);
      if (!actor) return { error: 'no actor' };
      await actor.update({
        'system.attributes.dying.value': 0,
        'system.attributes.wounded.value': 0,
        'system.attributes.doomed.value': 0,
      });
      let remaining = actor.itemTypes.condition.map((c) => c.id);
      let iters = 0;
      while (remaining.length > 0 && iters < 10) {
        await actor.deleteEmbeddedDocuments('Item', remaining);
        remaining = actor.itemTypes.condition.map((c) => c.id);
        iters += 1;
      }
      return { ok: true, conditions: actor.itemTypes.condition.length };
    }, actorId);
  }

  await clearConditions(VALEROS_ID);
  await clearConditions(GOBLIN_ID);

  // ====================================================================
  // PHASE 1 — going-down API discovery.
  // ====================================================================
  log.info({ phase: 1 }, '===== Phase 1: going-down API discovery =====');

  // --------------------------------------------------------------------
  // 1.A Non-vital direct update.
  // Seed frightened=4 via increaseCondition. Then call
  // actor.updateEmbeddedDocuments('Item', [{_id, 'system.value.value': 2}]).
  // --------------------------------------------------------------------
  {
    const readback = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      // Seed.
      await actor.increaseCondition('frightened', { value: 4, max: 4 });
      const seeded = actor.getCondition('frightened');
      const seededValue = seeded?.system?.value?.value ?? null;
      const seededId = seeded?.id ?? null;
      // Mutate.
      const updateResult = await actor.updateEmbeddedDocuments('Item', [
        { _id: seededId, 'system.value.value': 2 },
      ]);
      // Readback.
      const post = actor.getCondition('frightened');
      const postCount = actor.itemTypes.condition.filter((c) => c.system.slug === 'frightened').length;
      return {
        seededValue,
        seededId,
        updateResultLength: Array.isArray(updateResult) ? updateResult.length : null,
        postSystemValue: post?.system?.value?.value ?? null,
        postSourceValue: post?._source?.system?.value?.value ?? null,
        postId: post?.id ?? null,
        postCount,
      };
    }, VALEROS_ID);
    log.info({ probe: '1.A', readback }, '1.A non-vital direct update');
    assert(readback.seededValue === 4, '1.A: seed frightened=4', { readback });
    assert(readback.postSystemValue === 2, '1.A: post system.value.value=2', { readback });
    assert(readback.postSourceValue === 2, '1.A: post _source.system.value.value=2', { readback });
    assert(readback.postId === readback.seededId, '1.A: same condition id (not recreated)', {
      readback,
    });
    assert(readback.postCount === 1, '1.A: still exactly one frightened item', { readback });
  }
  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // 1.B Non-vital decreaseCondition loop control.
  // --------------------------------------------------------------------
  {
    const readback = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      await actor.increaseCondition('frightened', { value: 4, max: 4 });
      const seeded = actor.getCondition('frightened');
      const seededValue = seeded?.system?.value?.value ?? null;
      const seededId = seeded?.id ?? null;
      await actor.decreaseCondition('frightened');
      await actor.decreaseCondition('frightened');
      const post = actor.getCondition('frightened');
      const postCount = actor.itemTypes.condition.filter((c) => c.system.slug === 'frightened').length;
      return {
        seededValue,
        seededId,
        postSystemValue: post?.system?.value?.value ?? null,
        postSourceValue: post?._source?.system?.value?.value ?? null,
        postId: post?.id ?? null,
        postCount,
      };
    }, VALEROS_ID);
    log.info({ probe: '1.B', readback }, '1.B non-vital decreaseCondition x2');
    assert(readback.seededValue === 4, '1.B: seed frightened=4', { readback });
    assert(readback.postSystemValue === 2, '1.B: post system.value.value=2', { readback });
    assert(readback.postSourceValue === 2, '1.B: post _source.system.value.value=2', { readback });
    assert(readback.postCount === 1, '1.B: still exactly one frightened item', { readback });
  }
  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // 1.C Vital via item update.
  // Seed dying=3 (clean character has dying.max=4). Then call
  // updateEmbeddedDocuments on the dying item directly.
  // --------------------------------------------------------------------
  {
    const readback = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      await actor.increaseCondition('dying', { value: 3, max: actor.system.attributes.dying.max });
      const seededDying = actor.getCondition('dying');
      const seededValue = seededDying?.system?.value?.value ?? null;
      const seededAttr = actor.system.attributes.dying.value;
      const seededId = seededDying?.id ?? null;
      const seededCascade = actor.itemTypes.condition
        .filter((c) => c.system.slug !== 'dying')
        .map((c) => c.system.slug)
        .sort();
      // Mutate via item update.
      await actor.updateEmbeddedDocuments('Item', [
        { _id: seededId, 'system.value.value': 1 },
      ]);
      const post = actor.getCondition('dying');
      const postCount = actor.itemTypes.condition.filter((c) => c.system.slug === 'dying').length;
      const postCascade = actor.itemTypes.condition
        .filter((c) => c.system.slug !== 'dying')
        .map((c) => c.system.slug)
        .sort();
      return {
        seededValue,
        seededAttr,
        seededId,
        seededCascade,
        postSystemValue: post?.system?.value?.value ?? null,
        postSourceValue: post?._source?.system?.value?.value ?? null,
        postAttr: actor.system.attributes.dying.value,
        postId: post?.id ?? null,
        postCount,
        postCascade,
      };
    }, VALEROS_ID);
    log.info({ probe: '1.C', readback }, '1.C vital via item update');
    assert(readback.seededValue === 3, '1.C: seed dying item value=3', { readback });
    assert(readback.seededAttr === 3, '1.C: seed dying attribute=3', { readback });
    assert(readback.seededCascade.includes('unconscious'), '1.C: cascade includes unconscious', {
      readback,
    });
    // The interesting readbacks — does the item-level update propagate?
    log.info(
      {
        probe: '1.C results',
        postSystemValue: readback.postSystemValue,
        postSourceValue: readback.postSourceValue,
        postAttr: readback.postAttr,
        postCascadePresent: readback.postCascade,
      },
      '1.C: item-update propagation check',
    );
  }
  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // 1.D Vital via attribute update.
  // --------------------------------------------------------------------
  {
    const readback = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      await actor.increaseCondition('dying', { value: 3, max: actor.system.attributes.dying.max });
      const seededDying = actor.getCondition('dying');
      const seededValue = seededDying?.system?.value?.value ?? null;
      const seededAttr = actor.system.attributes.dying.value;
      const seededCascade = actor.itemTypes.condition
        .filter((c) => c.system.slug !== 'dying')
        .map((c) => c.system.slug)
        .sort();
      // Mutate via attribute update.
      await actor.update({ 'system.attributes.dying.value': 1 });
      const post = actor.getCondition('dying');
      const postCount = actor.itemTypes.condition.filter((c) => c.system.slug === 'dying').length;
      const postCascade = actor.itemTypes.condition
        .filter((c) => c.system.slug !== 'dying')
        .map((c) => c.system.slug)
        .sort();
      return {
        seededValue,
        seededAttr,
        seededCascade,
        postSystemValue: post?.system?.value?.value ?? null,
        postSourceValue: post?._source?.system?.value?.value ?? null,
        postAttr: actor.system.attributes.dying.value,
        postCount,
        postCascade,
      };
    }, VALEROS_ID);
    log.info({ probe: '1.D', readback }, '1.D vital via attribute update');
    assert(readback.seededAttr === 3, '1.D: seed dying attribute=3', { readback });
    // Phase 1 finding: writing the attribute alone does NOT propagate when
    // an existing dying item is present at a higher value (PF2e's prep
    // cycle reads the item back over the attribute). This documents the
    // discovery — the working down-path is the item-update from 1.C, not
    // the attribute-update from 1.D.
    assert(
      readback.postSystemValue === 3 && readback.postAttr === 3,
      '1.D: attribute-update silently reverts (item-update is the canonical path)',
      { readback },
    );
  }
  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // 1.E Vital decreaseCondition control.
  // --------------------------------------------------------------------
  {
    const readback = await page.evaluate(async (actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      await actor.increaseCondition('dying', { value: 3, max: actor.system.attributes.dying.max });
      const seededAttr = actor.system.attributes.dying.value;
      const seededCascade = actor.itemTypes.condition
        .filter((c) => c.system.slug !== 'dying')
        .map((c) => c.system.slug)
        .sort();
      // Mutate via decreaseCondition (one step).
      await actor.decreaseCondition('dying');
      const post = actor.getCondition('dying');
      const postCascade = actor.itemTypes.condition
        .filter((c) => c.system.slug !== 'dying')
        .map((c) => c.system.slug)
        .sort();
      return {
        seededAttr,
        seededCascade,
        postSystemValue: post?.system?.value?.value ?? null,
        postSourceValue: post?._source?.system?.value?.value ?? null,
        postAttr: actor.system.attributes.dying.value,
        postCount: actor.itemTypes.condition.filter((c) => c.system.slug === 'dying').length,
        postCascade,
      };
    }, VALEROS_ID);
    log.info({ probe: '1.E', readback }, '1.E vital decreaseCondition (control)');
    assert(readback.seededAttr === 3, '1.E: seed dying attribute=3', { readback });
    assert(readback.postAttr === 2, '1.E: post dying attribute=2', { readback });
    assert(readback.postSystemValue === 2, '1.E: post dying item value=2', { readback });
    assert(readback.postCascade.includes('unconscious'), '1.E: unconscious cascade survives', {
      readback,
    });
  }
  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Phase 1 summary — emit the readbacks that drive the API choice.
  // --------------------------------------------------------------------
  log.info(
    {
      phase: 1,
      summary:
        'Inspect the readbacks above. Predicted result: 1.A works (non-vital item ' +
        "update); 1.C works (vital item update propagates to attribute) OR shows " +
        'desync (pick 1.D path for vitals); 1.D and 1.E known good.',
    },
    'Phase 1 complete',
  );

  // Stop here if --phase=1.
  if (phase === '1') {
    if (failures.length > 0) {
      log.error({ failures, failureCount: failures.length }, 'PHASE 1 FAILED');
      process.exitCode = 1;
    } else {
      log.info('Phase 1 readbacks captured; review log to pick down-path API.');
      process.exitCode = 0;
    }
  } else {
    // ====================================================================
    // PHASE 2 — tool acceptance.
    // ====================================================================
    log.info({ phase: 2 }, '===== Phase 2: tool acceptance =====');

    // ------------------------------------------------------------------
    // Probe 1: up from absent (frightened 0 → 2).
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 2 });
      log.info({ probe: 1, res }, 'probe 1: up from absent (frightened 0 → 2)');
      assert(res.ok === true, 'probe 1: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 1: applied', { op: res.data.operation });
        assert(res.data.condition.existedBefore === false, 'probe 1: existedBefore=false', {
          existedBefore: res.data.condition.existedBefore,
        });
        assert(res.data.condition.previousValue === null, 'probe 1: previousValue=null', {
          previousValue: res.data.condition.previousValue,
        });
        assert(res.data.condition.value === 2, 'probe 1: value=2', { value: res.data.condition.value });
        assert(res.data.condition.valueRequested === 2, 'probe 1: valueRequested=2', {
          valueRequested: res.data.condition.valueRequested,
        });
        assert(res.data.condition.valueApplied === 2, 'probe 1: valueApplied=2', {
          valueApplied: res.data.condition.valueApplied,
        });
        assert(res.data.condition.clamped === false, 'probe 1: clamped=false', {
          clamped: res.data.condition.clamped,
        });
        // No cascade for non-vital from-absent.
        assert(
          !res.data.cascadeGranted || res.data.cascadeGranted.length === 0,
          'probe 1: no cascadeGranted for non-vital from-absent',
          { cascadeGranted: res.data.cascadeGranted },
        );
      }
    }

    // ------------------------------------------------------------------
    // Probe 2: up from existing-lower (frightened 2 → 3).
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 3 });
      log.info({ probe: 2, res }, 'probe 2: up from existing-lower (frightened 2 → 3)');
      assert(res.ok === true, 'probe 2: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 2: applied', { op: res.data.operation });
        assert(res.data.condition.existedBefore === true, 'probe 2: existedBefore=true', {
          existedBefore: res.data.condition.existedBefore,
        });
        assert(res.data.condition.previousValue === 2, 'probe 2: previousValue=2', {
          previousValue: res.data.condition.previousValue,
        });
        assert(res.data.condition.value === 3, 'probe 2: value=3', { value: res.data.condition.value });
        assert(res.data.condition.valueApplied === 3, 'probe 2: valueApplied=3', {
          valueApplied: res.data.condition.valueApplied,
        });
        assert(res.data.condition.clamped === false, 'probe 2: clamped=false', {
          clamped: res.data.condition.clamped,
        });
        // No new cascade when bumping an existing condition.
        assert(
          !res.data.cascadeGranted || res.data.cascadeGranted.length === 0,
          'probe 2: no cascadeGranted on existing-bump',
          { cascadeGranted: res.data.cascadeGranted },
        );
      }
    }

    // ------------------------------------------------------------------
    // Probe 3: down (frightened 3 → 1).
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 1 });
      log.info({ probe: 3, res }, 'probe 3: down (frightened 3 → 1)');
      assert(res.ok === true, 'probe 3: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 3: applied', { op: res.data.operation });
        assert(res.data.condition.existedBefore === true, 'probe 3: existedBefore=true', {
          existedBefore: res.data.condition.existedBefore,
        });
        assert(res.data.condition.previousValue === 3, 'probe 3: previousValue=3', {
          previousValue: res.data.condition.previousValue,
        });
        assert(res.data.condition.value === 1, 'probe 3: value=1', { value: res.data.condition.value });
        assert(res.data.condition.valueApplied === 1, 'probe 3: valueApplied=1', {
          valueApplied: res.data.condition.valueApplied,
        });
        // Confirm at the data layer.
        const live = await page.evaluate((id) => {
          const a = globalThis.game.actors?.get(id);
          const c = a?.getCondition('frightened');
          return c?._source?.system?.value?.value ?? null;
        }, VALEROS_ID);
        assert(live === 1, 'probe 3: live readback frightened=1', { live });
      }
    }

    // ------------------------------------------------------------------
    // Probe 4: no-op (frightened 1 → 1).
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 1 });
      log.info({ probe: 4, res }, 'probe 4: no-op (frightened 1 → 1)');
      assert(res.ok === true, 'probe 4: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'noop', 'probe 4: noop', { op: res.data.operation });
        assert(res.data.reason === 'already_at_requested_value', 'probe 4: reason', {
          reason: res.data.reason,
        });
        assert(res.data.condition.value === 1, 'probe 4: value=1', { value: res.data.condition.value });
      }
    }
    await clearConditions(VALEROS_ID);

    // ------------------------------------------------------------------
    // Probe 5: clamp going up (frightened 0 → 7) → valueApplied=4.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 7 });
      log.info({ probe: 5, res }, 'probe 5: clamp going up (frightened 0 → 7 → 4)');
      assert(res.ok === true, 'probe 5: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 5: applied', { op: res.data.operation });
        assert(res.data.condition.valueRequested === 7, 'probe 5: valueRequested=7', {
          valueRequested: res.data.condition.valueRequested,
        });
        assert(res.data.condition.valueApplied === 4, 'probe 5: valueApplied=4', {
          valueApplied: res.data.condition.valueApplied,
        });
        assert(res.data.condition.value === 4, 'probe 5: value=4', { value: res.data.condition.value });
        assert(res.data.condition.clamped === true, 'probe 5: clamped=true', {
          clamped: res.data.condition.clamped,
        });
      }
    }
    await clearConditions(VALEROS_ID);

    // ------------------------------------------------------------------
    // Probe 6: vital up (dying 0 → 2). Cascade includes unconscious +
    // blinded + prone.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'dying', value: 2 });
      log.info({ probe: 6, res }, 'probe 6: vital up (dying 0 → 2)');
      assert(res.ok === true, 'probe 6: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 6: applied', { op: res.data.operation });
        assert(res.data.condition.value === 2, 'probe 6: dying=2', { value: res.data.condition.value });
        assert(res.data.condition.existedBefore === false, 'probe 6: existedBefore=false', {
          existedBefore: res.data.condition.existedBefore,
        });
        const cascadeSlugs = (res.data.cascadeGranted ?? []).map((c) => c.slug).sort();
        assert(cascadeSlugs.includes('unconscious'), 'probe 6: cascade includes unconscious', {
          cascadeSlugs,
        });
        assert(cascadeSlugs.includes('blinded'), 'probe 6: cascade includes blinded', {
          cascadeSlugs,
        });
        assert(cascadeSlugs.includes('prone'), 'probe 6: cascade includes prone', {
          cascadeSlugs,
        });
        const dyingValue = await page.evaluate(
          (id) => globalThis.game.actors?.get(id)?.system.attributes.dying.value ?? null,
          VALEROS_ID,
        );
        assert(dyingValue === 2, 'probe 6: actor.system.attributes.dying.value=2', { dyingValue });
      }
    }

    // ------------------------------------------------------------------
    // Probe 7: vital down (dying 2 → 1). Cascade children still on actor.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'dying', value: 1 });
      log.info({ probe: 7, res }, 'probe 7: vital down (dying 2 → 1)');
      assert(res.ok === true, 'probe 7: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 7: applied', { op: res.data.operation });
        assert(res.data.condition.previousValue === 2, 'probe 7: previousValue=2', {
          previousValue: res.data.condition.previousValue,
        });
        assert(res.data.condition.value === 1, 'probe 7: dying=1', { value: res.data.condition.value });
        // No cascadeGranted on a going-down.
        assert(
          !res.data.cascadeGranted || res.data.cascadeGranted.length === 0,
          'probe 7: no cascadeGranted on going-down',
          { cascadeGranted: res.data.cascadeGranted },
        );
        const post = await page.evaluate((id) => {
          const a = globalThis.game.actors?.get(id);
          return {
            attr: a?.system.attributes.dying.value ?? null,
            cascadeSlugs: a?.itemTypes.condition
              .filter((c) => c.system.slug !== 'dying')
              .map((c) => c.system.slug)
              .sort(),
          };
        }, VALEROS_ID);
        assert(post.attr === 1, 'probe 7: actor.system.attributes.dying.value=1', { post });
        assert(post.cascadeSlugs.includes('unconscious'), 'probe 7: unconscious survives', { post });
        assert(post.cascadeSlugs.includes('blinded'), 'probe 7: blinded survives', { post });
        assert(post.cascadeSlugs.includes('prone'), 'probe 7: prone survives', { post });
      }
    }
    await clearConditions(VALEROS_ID);

    // ------------------------------------------------------------------
    // Probe 8: vital clamp via doomed. Apply doomed=2 first (dying.max → 2);
    // then set dying to 4 → valueApplied=2, clamped=true.
    // ------------------------------------------------------------------
    {
      await page.evaluate(async (id) => {
        const actor = globalThis.game.actors?.get(id);
        await actor.increaseCondition('doomed', { value: 2, max: actor.system.attributes.doomed.max });
      }, VALEROS_ID);
      const res = await call({ actorId: VALEROS_ID, slug: 'dying', value: 4 });
      log.info({ probe: 8, res }, 'probe 8: vital clamp via doomed (dying request 4 → clamped 2)');
      assert(res.ok === true, 'probe 8: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 8: applied', { op: res.data.operation });
        assert(res.data.condition.valueRequested === 4, 'probe 8: valueRequested=4', {
          valueRequested: res.data.condition.valueRequested,
        });
        assert(res.data.condition.valueApplied === 2, 'probe 8: valueApplied=2 (dying.max - doomed=2)', {
          valueApplied: res.data.condition.valueApplied,
        });
        assert(res.data.condition.clamped === true, 'probe 8: clamped=true', {
          clamped: res.data.condition.clamped,
        });
      }
    }
    await clearConditions(VALEROS_ID);

    // ------------------------------------------------------------------
    // Probe 9: NPC parity (Goblin frightened 0 → 2).
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: GOBLIN_ID, slug: 'frightened', value: 2 });
      log.info({ probe: 9, res }, 'probe 9: NPC parity (Goblin frightened 0 → 2)');
      assert(res.ok === true, 'probe 9: ok', { res });
      if (res.ok) {
        assert(res.data.operation === 'applied', 'probe 9: applied', { op: res.data.operation });
        assert(res.data.actor.id === GOBLIN_ID, 'probe 9: actor id echoed', {
          actorId: res.data.actor.id,
        });
        assert(res.data.condition.value === 2, 'probe 9: value=2', { value: res.data.condition.value });
      }
    }
    await clearConditions(GOBLIN_ID);

    // ------------------------------------------------------------------
    // Probe 10: reject value=0 → zod rejection at MCP boundary.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frightened', value: 0 });
      log.info({ probe: 10, res }, 'probe 10: reject value=0 (zod boundary)');
      assert(res.isError === true, 'probe 10: error', { res });
      // value=0 fails zod's .min(1) → validation error (not ToolError).
      assert(Array.isArray(res.validation), 'probe 10: zod validation error', { res });
    }

    // Probe 10b: bypass zod, exercise evaluator's defensive guard for value=0.
    {
      const raw = await callRaw(page, { actorId: VALEROS_ID, slug: 'frightened', value: 0 });
      log.info({ probe: '10b', raw }, 'probe 10b: evaluator defensive value=0 guard');
      assert(raw.ok === false, 'probe 10b: evaluator rejects', { raw });
      assert(
        raw.error?.details?.reason === 'VALUE_ZERO_USE_REMOVE_CONDITION',
        'probe 10b: reason=VALUE_ZERO_USE_REMOVE_CONDITION',
        { reason: raw.error?.details?.reason },
      );
    }

    // ------------------------------------------------------------------
    // Probe 11: reject non-valued (off-guard, value 2).
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'off-guard', value: 2 });
      log.info({ probe: 11, res }, 'probe 11: reject non-valued (off-guard)');
      assert(res.isError === true, 'probe 11: error', { res });
      assert(
        res.error?.details?.reason === 'NON_VALUED_CONDITION_NOT_SUPPORTED',
        'probe 11: reason=NON_VALUED_CONDITION_NOT_SUPPORTED',
        { reason: res.error?.details?.reason },
      );
    }

    // ------------------------------------------------------------------
    // Probe 12: reject persistent-damage.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'persistent-damage', value: 2 });
      log.info({ probe: 12, res }, 'probe 12: reject persistent-damage');
      assert(res.isError === true, 'probe 12: error', { res });
      assert(
        res.error?.details?.reason === 'PERSISTENT_DAMAGE_NOT_SUPPORTED',
        'probe 12: reason=PERSISTENT_DAMAGE_NOT_SUPPORTED',
        { reason: res.error?.details?.reason },
      );
    }

    // ------------------------------------------------------------------
    // Probe 13: reject bogus slug.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: VALEROS_ID, slug: 'frighteded', value: 2 });
      log.info({ probe: 13, res }, 'probe 13: bogus slug');
      assert(res.isError === true, 'probe 13: error', { res });
      assert(
        res.error?.details?.reason === 'CONDITION_NOT_FOUND',
        'probe 13: reason=CONDITION_NOT_FOUND',
        { reason: res.error?.details?.reason },
      );
    }

    // ------------------------------------------------------------------
    // Probe 14: reject bogus actorId.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: 'deadbeef', slug: 'frightened', value: 2 });
      log.info({ probe: 14, res }, 'probe 14: bogus actorId');
      assert(res.isError === true, 'probe 14: error', { res });
      assert(
        res.error?.details?.reason === 'ACTOR_NOT_FOUND',
        'probe 14: reason=ACTOR_NOT_FOUND',
        { reason: res.error?.details?.reason },
      );
    }

    // ------------------------------------------------------------------
    // Probe 15: reject party actor.
    // ------------------------------------------------------------------
    {
      const res = await call({ actorId: PARTY_ID, slug: 'frightened', value: 2 });
      log.info({ probe: 15, res }, 'probe 15: party actor unsupported');
      assert(res.isError === true, 'probe 15: error', { res });
      assert(
        res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
        'probe 15: reason=ACTOR_TYPE_UNSUPPORTED',
        { reason: res.error?.details?.reason },
      );
    }

    // ====================================================================
    // PHASE 3 — teardown + multiset assertion.
    // ====================================================================
    log.info({ phase: 3 }, '===== Phase 3: teardown =====');
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
          // 1. Clear vitals.
          await actor.update({
            'system.attributes.dying.value': 0,
            'system.attributes.wounded.value': 0,
            'system.attributes.doomed.value': 0,
          });
          // 2. Delete remaining conditions (cascade-aware loop).
          let stragglers = actor.itemTypes.condition.map((c) => c.id);
          let iters = 0;
          while (stragglers.length > 0 && iters < 10) {
            await actor.deleteEmbeddedDocuments('Item', stragglers);
            stragglers = actor.itemTypes.condition.map((c) => c.id);
            iters += 1;
          }
          // 3. Delete orphan effects (not in snapshot).
          const snapshotEffectNames = snap.effects.map((e) => e.name);
          const orphanEffects = actor.itemTypes.effect
            .filter((e) => !snapshotEffectNames.includes(e.name))
            .map((e) => e.id);
          if (orphanEffects.length > 0) {
            await actor.deleteEmbeddedDocuments('Item', orphanEffects);
          }
          // 4. Restore vitals to snapshot.
          await actor.update({
            'system.attributes.dying.value': snap.vitals.dying.value,
            'system.attributes.wounded.value': snap.vitals.wounded.value,
            'system.attributes.doomed.value': snap.vitals.doomed.value,
          });
          // 5. Recreate missing non-cascade snapshot conditions.
          const currentSlugs = new Set(actor.itemTypes.condition.map((c) => c.system.slug));
          const toRecreate = snap.conditions
            .filter((c) => !currentSlugs.has(c.slug) && c.grantedById === null)
            .map((c) => c.payload);
          if (toRecreate.length > 0) {
            await actor.createEmbeddedDocuments('Item', toRecreate);
          }
          // 6. Recreate missing snapshot effects.
          const currentEffectNames = actor.itemTypes.effect.map((e) => e.name);
          const effectsToRecreate = snap.effects
            .filter((e) => !currentEffectNames.includes(e.name))
            .map((e) => e.payload);
          if (effectsToRecreate.length > 0) {
            await actor.createEmbeddedDocuments('Item', effectsToRecreate);
          }
          // 7. Report final state.
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
    log.info({ teardown }, 'teardown report');

    // Multiset verification.
    for (const id of [VALEROS_ID, GOBLIN_ID]) {
      const snap = startSnapshot[id];
      const post = teardown[id];
      const expectedConds = snap.conditions
        .map((c) => ({ slug: c.slug, value: c.value }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      const expectedEffects = snap.effects.map((e) => e.name).sort();
      assert(
        JSON.stringify(post.conditions) === JSON.stringify(expectedConds),
        `teardown: ${snap.name} condition multiset matches snapshot`,
        { actor: snap.name, post: post.conditions, expected: expectedConds },
      );
      assert(
        JSON.stringify(post.effects) === JSON.stringify(expectedEffects),
        `teardown: ${snap.name} effect multiset matches snapshot`,
        { actor: snap.name, post: post.effects, expected: expectedEffects },
      );
      assert(
        post.vitals.dying === snap.vitals.dying.value,
        `teardown: ${snap.name} dying restored`,
        { post: post.vitals.dying, expected: snap.vitals.dying.value },
      );
      assert(
        post.vitals.wounded === snap.vitals.wounded.value,
        `teardown: ${snap.name} wounded restored`,
        { post: post.vitals.wounded, expected: snap.vitals.wounded.value },
      );
      assert(
        post.vitals.doomed === snap.vitals.doomed.value,
        `teardown: ${snap.name} doomed restored`,
        { post: post.vitals.doomed, expected: snap.vitals.doomed.value },
      );
    }

    if (failures.length > 0) {
      log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
      process.exitCode = 1;
    } else {
      log.info('all acceptance assertions passed');
      process.exitCode = 0;
    }
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
