/**
 * Probe + acceptance script for remove_condition. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1.  Decrement valued, previousValue > 1: frightened 3 →
 *       operation: "decremented", previousValue: 3, value: 2.
 *   2.  Decrement valued, previousValue === 1: frightened 1 →
 *       operation: "removed", previousValue: 1.
 *   3.  Remove (forceRemove) valued: frightened 3 → operation: "removed",
 *       previousValue: 3.
 *   4.  Remove non-valued: prone (mode: "remove") → operation: "removed",
 *       previousValue: null.
 *   5.  Decrement non-valued: prone (mode: "decrement") → operation:
 *       "removed" (silent equivalence — non-valued has no value to
 *       decrement).
 *   6.  Cascade on parent: apply unconscious, remove it →
 *       cascadeDeleted includes blinded + prone; verify no survivors
 *       with grantedBy.id === unconscious.id.
 *   7.  Vitals decrement: dying 2 → dying 1, operation: "decremented",
 *       system.attributes.dying.value === 1.
 *   8.  Vitals remove (forceRemove): dying 2 → operation: "removed",
 *       cascadeDeleted includes unconscious + blinded + prone,
 *       system.attributes.dying.value === 0.
 *   9.  Noop: remove off-guard on clean actor → operation: "noop",
 *       reason: "not_present".
 *   10. conditionId input variant: apply frightened, capture id, remove
 *       by conditionId → operation: "removed".
 *   11. slug input variant on NPC (parity): apply frightened to goblin,
 *       remove by slug → operation: "removed".
 *   12. Error: bogus actorId → ACTOR_NOT_FOUND.
 *   13. Error: party actor → ACTOR_TYPE_UNSUPPORTED.
 *   14. Error: bogus slug → CONDITION_NOT_FOUND.
 *   15. Error: bogus conditionId → CONDITION_ID_NOT_ON_ACTOR.
 *   16. Error: persistent-damage slug → PERSISTENT_DAMAGE_NOT_SUPPORTED.
 *   17. Teardown verification: post-teardown state matches start-of-probe
 *       snapshot on both actors (conditions multiset by slug+value,
 *       effects by name, vitals attributes).
 *
 * State restoration model identical to probe-apply-condition.mjs:
 * snapshot per-item toObject() payloads + vitals attributes; teardown
 * clears vitals, sweeps remaining condition items, restores vitals to
 * snapshot, recreates any missing snapshot conditions/effects via
 * createEmbeddedDocuments. Post-teardown assertion is multiset on
 * (slug, value) — id-agnostic, since Foundry assigns new ids on recreate.
 *
 *   npm run build && node scripts/probe-remove-condition.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const removeTool = tools.find((t) => t.name === 'remove_condition');
const applyTool = tools.find((t) => t.name === 'apply_condition');
if (!removeTool) {
  log.error('remove_condition not registered');
  process.exit(2);
}
if (!applyTool) {
  log.error('apply_condition not registered (needed for setup)');
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

async function callTool(tool, input) {
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

const callRemove = (input) => callTool(removeTool, input);
const callApply = (input) => callTool(applyTool, input);

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
  // browser (used between probes and as the first step of teardown).
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
      let iter = 0;
      while (remaining.length > 0 && iter < 10) {
        await actor.deleteEmbeddedDocuments('Item', remaining);
        remaining = actor.itemTypes.condition.map((c) => c.id);
        iter += 1;
      }
      return { ok: true, conditions: actor.itemTypes.condition.length };
    }, actorId);
  }

  await clearConditions(VALEROS_ID);
  await clearConditions(GOBLIN_ID);

  // --------------------------------------------------------------------
  // Probe 1: decrement valued, value > 1.
  // Setup: frightened 3. Action: remove_condition (decrement default).
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'frightened', value: 3 });
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'frightened' });
    log.info({ probe: 1, res }, 'probe 1: decrement frightened 3 → 2');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 1: operation=decremented', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === 3, 'probe 1: previousValue=3', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.value === 2, 'probe 1: value=2', {
        value: res.data.condition.value,
      });
      assert(res.data.condition.slug === 'frightened', 'probe 1: slug echoed', {
        slug: res.data.condition.slug,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: decrement valued, previousValue === 1.
  // Frightened 2 (left from probe 1) → decrement to 1, then decrement
  // again → removed.
  // --------------------------------------------------------------------
  {
    // Drive frightened down to 1.
    await callRemove({ actorId: VALEROS_ID, slug: 'frightened' }); // 2 → 1
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'frightened' });
    log.info({ probe: 2, res }, 'probe 2: decrement frightened 1 → removed');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 2: operation=removed', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === 1, 'probe 2: previousValue=1', {
        previousValue: res.data.condition.previousValue,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 3: remove (forceRemove) valued.
  // Frightened 3, mode: "remove" → fully removed, previousValue: 3.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'frightened', value: 3 });
    const res = await callRemove({
      actorId: VALEROS_ID,
      slug: 'frightened',
      mode: 'remove',
    });
    log.info({ probe: 3, res }, 'probe 3: forceRemove frightened 3');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 3: operation=removed', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === 3, 'probe 3: previousValue=3', {
        previousValue: res.data.condition.previousValue,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 4: remove non-valued (prone), mode: "remove".
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'prone' });
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'prone', mode: 'remove' });
    log.info({ probe: 4, res }, 'probe 4: remove prone (non-valued)');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 4: operation=removed', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === null, 'probe 4: previousValue=null', {
        previousValue: res.data.condition.previousValue,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 5: decrement non-valued (prone) → silent equivalence to remove.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'prone' });
    const res = await callRemove({
      actorId: VALEROS_ID,
      slug: 'prone',
      mode: 'decrement',
    });
    log.info({ probe: 5, res }, 'probe 5: decrement prone → silent equivalence');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(
        res.data.operation === 'removed',
        'probe 5: operation=removed (decrement on non-valued)',
        {
          op: res.data.operation,
        },
      );
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 6: cascade on parent. Apply unconscious (cascades to
  // blinded + prone), then remove unconscious → cascadeDeleted should
  // include blinded + prone.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'unconscious' });
    // Verify cascade fired before we test removal.
    const preCheck = await page.evaluate((id) => {
      const actor = globalThis.game.actors?.get(id);
      return actor.itemTypes.condition
        .map((c) => ({
          slug: c.system.slug,
          grantedById: c.flags?.pf2e?.grantedBy?.id ?? null,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    }, VALEROS_ID);
    log.info({ probe: 6, preCheck }, 'probe 6: state after applying unconscious');
    assert(
      preCheck.some((c) => c.slug === 'unconscious'),
      'probe 6: unconscious present',
      { preCheck },
    );
    assert(
      preCheck.some((c) => c.slug === 'blinded' && c.grantedById !== null),
      'probe 6: blinded granted',
      { preCheck },
    );
    assert(
      preCheck.some((c) => c.slug === 'prone' && c.grantedById !== null),
      'probe 6: prone granted',
      { preCheck },
    );

    const res = await callRemove({
      actorId: VALEROS_ID,
      slug: 'unconscious',
      mode: 'remove',
    });
    log.info({ probe: 6, res }, 'probe 6: remove unconscious (cascade)');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 6: operation=removed', {
        op: res.data.operation,
      });
      const cascade = res.data.cascadeDeleted ?? [];
      const cascadeSlugs = cascade.map((c) => c.slug).sort();
      assert(cascadeSlugs.includes('blinded'), 'probe 6: cascadeDeleted includes blinded', {
        cascadeSlugs,
      });
      assert(cascadeSlugs.includes('prone'), 'probe 6: cascadeDeleted includes prone', {
        cascadeSlugs,
      });

      // Confirm no survivors on actor.
      const postState = await page.evaluate((id) => {
        const actor = globalThis.game.actors?.get(id);
        return actor.itemTypes.condition.map((c) => c.system.slug).sort();
      }, VALEROS_ID);
      assert(!postState.includes('unconscious'), 'probe 6: unconscious gone', { postState });
      assert(!postState.includes('blinded'), 'probe 6: blinded gone (cascade enforced)', {
        postState,
      });
      assert(!postState.includes('prone'), 'probe 6: prone gone (cascade enforced)', {
        postState,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 7: vitals decrement. dying 2 → dying 1.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'dying', value: 2 });
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'dying' });
    log.info({ probe: 7, res }, 'probe 7: decrement dying 2 → 1');
    assert(res.ok === true, 'probe 7: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'decremented', 'probe 7: operation=decremented', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === 2, 'probe 7: previousValue=2', {
        previousValue: res.data.condition.previousValue,
      });
      assert(res.data.condition.value === 1, 'probe 7: value=1', {
        value: res.data.condition.value,
      });
      const dyingAttr = await page.evaluate((id) => {
        return globalThis.game.actors?.get(id)?.system.attributes.dying.value ?? null;
      }, VALEROS_ID);
      assert(dyingAttr === 1, 'probe 7: system.attributes.dying.value === 1', { dyingAttr });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 8: vitals remove (forceRemove). dying 2 → 0, cascade clears.
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: VALEROS_ID, slug: 'dying', value: 2 });
    // Verify cascade attached.
    const preCheck = await page.evaluate((id) => {
      const actor = globalThis.game.actors?.get(id);
      return {
        dying: actor.system.attributes.dying.value,
        wounded: actor.system.attributes.wounded.value,
        conditionSlugs: actor.itemTypes.condition.map((c) => c.system.slug).sort(),
      };
    }, VALEROS_ID);
    log.info({ probe: 8, preCheck }, 'probe 8: state pre-remove');

    const res = await callRemove({
      actorId: VALEROS_ID,
      slug: 'dying',
      mode: 'remove',
    });
    log.info({ probe: 8, res }, 'probe 8: forceRemove dying 2');
    assert(res.ok === true, 'probe 8: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 8: operation=removed', {
        op: res.data.operation,
      });
      assert(res.data.condition.previousValue === 2, 'probe 8: previousValue=2', {
        previousValue: res.data.condition.previousValue,
      });
      const cascadeSlugs = (res.data.cascadeDeleted ?? []).map((c) => c.slug).sort();
      assert(cascadeSlugs.includes('unconscious'), 'probe 8: cascadeDeleted includes unconscious', {
        cascadeSlugs,
      });
      assert(
        cascadeSlugs.includes('blinded'),
        'probe 8: cascadeDeleted includes blinded (transitive)',
        { cascadeSlugs },
      );
      assert(
        cascadeSlugs.includes('prone'),
        'probe 8: cascadeDeleted includes prone (transitive)',
        { cascadeSlugs },
      );

      const postState = await page.evaluate((id) => {
        const actor = globalThis.game.actors?.get(id);
        return {
          dying: actor.system.attributes.dying.value,
          wounded: actor.system.attributes.wounded.value,
          conditionSlugs: actor.itemTypes.condition.map((c) => c.system.slug).sort(),
        };
      }, VALEROS_ID);
      assert(postState.dying === 0, 'probe 8: system.attributes.dying.value === 0', { postState });
      assert(!postState.conditionSlugs.includes('unconscious'), 'probe 8: unconscious gone', {
        postState,
      });
      log.info(
        { probe: 8, postWounded: postState.wounded, preWounded: preCheck.wounded },
        'probe 8: informational — wounded post-remove (PF2e recovery side-effect)',
      );
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 9: noop on absent condition.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'off-guard' });
    log.info({ probe: 9, res }, 'probe 9: remove off-guard on clean actor (noop)');
    assert(res.ok === true, 'probe 9: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'noop', 'probe 9: operation=noop', {
        op: res.data.operation,
      });
      assert(res.data.reason === 'not_present', 'probe 9: reason=not_present', {
        reason: res.data.reason,
      });
      assert(res.data.slug === 'off-guard', 'probe 9: slug echoed', { slug: res.data.slug });
    }
  }

  // --------------------------------------------------------------------
  // Probe 10: conditionId input variant.
  // --------------------------------------------------------------------
  {
    const apply = await callApply({ actorId: VALEROS_ID, slug: 'frightened', value: 2 });
    assert(apply.ok === true, 'probe 10: setup apply ok', { apply });
    const frightenedId = apply.ok ? apply.data.condition.id : null;
    assert(typeof frightenedId === 'string' && frightenedId.length > 0, 'probe 10: captured id', {
      frightenedId,
    });
    const res = await callRemove({
      actorId: VALEROS_ID,
      conditionId: frightenedId,
      mode: 'remove',
    });
    log.info({ probe: 10, res }, 'probe 10: remove by conditionId');
    assert(res.ok === true, 'probe 10: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 10: operation=removed', {
        op: res.data.operation,
      });
      assert(res.data.condition.slug === 'frightened', 'probe 10: slug resolved', {
        slug: res.data.condition.slug,
      });
      assert(res.data.condition.id === frightenedId, 'probe 10: id echoed', {
        id: res.data.condition.id,
      });
    }
  }

  await clearConditions(VALEROS_ID);

  // --------------------------------------------------------------------
  // Probe 11: slug input variant on NPC (parity check).
  // --------------------------------------------------------------------
  {
    await callApply({ actorId: GOBLIN_ID, slug: 'frightened', value: 2 });
    const res = await callRemove({
      actorId: GOBLIN_ID,
      slug: 'frightened',
      mode: 'remove',
    });
    log.info({ probe: 11, res }, 'probe 11: remove frightened on NPC');
    assert(res.ok === true, 'probe 11: ok', { res });
    if (res.ok) {
      assert(res.data.operation === 'removed', 'probe 11: operation=removed', {
        op: res.data.operation,
      });
      assert(res.data.actor.id === GOBLIN_ID, 'probe 11: actor id echoed', {
        actorId: res.data.actor.id,
      });
    }
  }

  await clearConditions(GOBLIN_ID);

  // --------------------------------------------------------------------
  // Probe 12: bogus actorId → ACTOR_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: 'deadbeef', slug: 'frightened' });
    log.info({ probe: 12, res }, 'probe 12: bogus actorId');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(res.error?.details?.reason === 'ACTOR_NOT_FOUND', 'probe 12: reason=ACTOR_NOT_FOUND', {
      reason: res.error?.details?.reason,
    });
  }

  // --------------------------------------------------------------------
  // Probe 13: party actor → ACTOR_TYPE_UNSUPPORTED.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: PARTY_ID, slug: 'frightened' });
    log.info({ probe: 13, res }, 'probe 13: party actor unsupported');
    assert(res.isError === true, 'probe 13: error', { res });
    assert(
      res.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'probe 13: reason=ACTOR_TYPE_UNSUPPORTED',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 14: bogus slug → CONDITION_NOT_FOUND.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'frighteded' });
    log.info({ probe: 14, res }, 'probe 14: bogus slug');
    assert(res.isError === true, 'probe 14: error', { res });
    assert(
      res.error?.details?.reason === 'CONDITION_NOT_FOUND',
      'probe 14: reason=CONDITION_NOT_FOUND',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 15: bogus conditionId → CONDITION_ID_NOT_ON_ACTOR.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: VALEROS_ID, conditionId: 'doesNotExist123' });
    log.info({ probe: 15, res }, 'probe 15: bogus conditionId');
    assert(res.isError === true, 'probe 15: error', { res });
    assert(
      res.error?.details?.reason === 'CONDITION_ID_NOT_ON_ACTOR',
      'probe 15: reason=CONDITION_ID_NOT_ON_ACTOR',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Probe 16: persistent-damage slug → PERSISTENT_DAMAGE_NOT_SUPPORTED.
  // --------------------------------------------------------------------
  {
    const res = await callRemove({ actorId: VALEROS_ID, slug: 'persistent-damage' });
    log.info({ probe: 16, res }, 'probe 16: persistent-damage rejected');
    assert(res.isError === true, 'probe 16: error', { res });
    assert(
      res.error?.details?.reason === 'PERSISTENT_DAMAGE_NOT_SUPPORTED',
      'probe 16: reason=PERSISTENT_DAMAGE_NOT_SUPPORTED',
      { reason: res.error?.details?.reason },
    );
  }

  // --------------------------------------------------------------------
  // Teardown: clear vitals + condition items, restore vitals to snapshot,
  // recreate any missing snapshot conditions/effects.
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

        await actor.update({
          'system.attributes.dying.value': 0,
          'system.attributes.wounded.value': 0,
          'system.attributes.doomed.value': 0,
        });

        let stragglers = actor.itemTypes.condition.map((c) => c.id);
        let iterations = 0;
        while (stragglers.length > 0 && iterations < 10) {
          await actor.deleteEmbeddedDocuments('Item', stragglers);
          stragglers = actor.itemTypes.condition.map((c) => c.id);
          iterations += 1;
        }

        const snapshotEffectNames = snap.effects.map((e) => e.name);
        const orphanEffects = actor.itemTypes.effect
          .filter((e) => !snapshotEffectNames.includes(e.name))
          .map((e) => e.id);
        if (orphanEffects.length > 0) {
          await actor.deleteEmbeddedDocuments('Item', orphanEffects);
        }

        await actor.update({
          'system.attributes.dying.value': snap.vitals.dying.value,
          'system.attributes.wounded.value': snap.vitals.wounded.value,
          'system.attributes.doomed.value': snap.vitals.doomed.value,
        });

        const currentSlugs = new Set(actor.itemTypes.condition.map((c) => c.system.slug));
        const toRecreate = snap.conditions
          .filter((c) => !currentSlugs.has(c.slug) && c.grantedById === null)
          .map((c) => c.payload);
        if (toRecreate.length > 0) {
          await actor.createEmbeddedDocuments('Item', toRecreate);
        }

        const currentEffectNames = actor.itemTypes.effect.map((e) => e.name);
        const effectsToRecreate = snap.effects
          .filter((e) => !currentEffectNames.includes(e.name))
          .map((e) => e.payload);
        if (effectsToRecreate.length > 0) {
          await actor.createEmbeddedDocuments('Item', effectsToRecreate);
        }

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
  // Probe 17: teardown verification per actor.
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
      `probe 17: ${snap.name} condition multiset matches snapshot`,
      { actor: snap.name, post: post.conditions, expected: expectedConds },
    );
    assert(
      JSON.stringify(post.effects) === JSON.stringify(expectedEffects),
      `probe 17: ${snap.name} effect multiset matches snapshot`,
      { actor: snap.name, post: post.effects, expected: expectedEffects },
    );
    assert(
      post.vitals.dying === snap.vitals.dying.value,
      `probe 17: ${snap.name} dying value restored`,
      { actor: snap.name, post: post.vitals.dying, expected: snap.vitals.dying.value },
    );
    assert(
      post.vitals.wounded === snap.vitals.wounded.value,
      `probe 17: ${snap.name} wounded value restored`,
      { actor: snap.name, post: post.vitals.wounded, expected: snap.vitals.wounded.value },
    );
    assert(
      post.vitals.doomed === snap.vitals.doomed.value,
      `probe 17: ${snap.name} doomed value restored`,
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
