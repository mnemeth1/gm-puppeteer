/**
 * Probe + acceptance script for create_scroll_or_wand. Drives the live
 * headless Foundry against the gm-puppeteer-sandbox world and exercises
 * the tool's happy paths plus every documented error branch.
 *
 * Phase 1 findings (probe-create-scroll-or-wand-phase1.mjs):
 *  - `ConsumablePF2e.fromSpell` does not exist in PF2e 8.1.2; the tool
 *    uses CONFIG.PF2E.spellcastingItems[kind].compendiumUuids[rank] to
 *    locate a generic template, clones it, and injects
 *    spell.toObject() into system.spell with
 *    system.location.heightenedLevel = rank.
 *  - Scrolls support ranks 1–10; wands support ranks 1–9 (rank-10 wand
 *    template is intentionally null in the config map).
 *  - Cantrips, focus spells, and rituals are rejected by the evaluator
 *    even though the document layer would accept them.
 *  - PF2e does NOT auto-merge consumables on createEmbeddedDocuments;
 *    multiple calls produce separate entries (same behavior as
 *    add_item_to_actor).
 *
 * Probes:
 *
 *   1. Scroll of Force Barrage at rank 1, no container, qty 1.
 *   2. Wand of Heal at rank 1, no container, qty 1.
 *   3. Scroll of Fireball at rank 3, into backpack.
 *   4. Heightened: Scroll of Force Barrage at rank 3.
 *   5. Quantity > 1: Scroll of Force Barrage at rank 1, qty 3.
 *   6. Unidentified: Scroll of Force Barrage at rank 1, identified=false.
 *   7. Error: non-spell UUID (Longsword) → INVALID_INPUT.
 *   8. Error: cantrip (Detect Magic) → INVALID_INPUT.
 *   9. Error: rank below spell's base rank (Fireball at rank 1).
 *   10. Error: rank 10 wand → "no rank-10 wand template" message.
 *   11. Error: bad actorId.
 *   12. Error: bad containerId.
 *   13. Error: non-container containerId (the Longsword we created in
 *       a prior probe, by id).
 *   14. Teardown verification.
 *
 * State restoration model (mirroring probe-add-item-to-actor.mjs v1.1):
 *  - At probe start, snapshot every item on the actor as {id, qty}.
 *  - At probe end, (a) delete any item whose id is on the actor but
 *    not in the snapshot, (b) for each snapshot id whose quantity
 *    drifted, restore via updateEmbeddedDocuments, (c) assert the
 *    post-teardown item-id set equals the snapshot set AND every
 *    snapshot id's quantity equals the snapshot quantity.
 *
 * The tool is additive (only creates items, never deletes existing
 * ones), so the {id, qty} snapshot is sufficient — no need for
 * full toObject() payloads for recreate.
 *
 *   npm run build && node scripts/probe-create-scroll-or-wand.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'create_scroll_or_wand');
if (!tool) {
  log.error('create_scroll_or_wand not registered');
  process.exit(2);
}
const getItemDetailsTool = tools.find((t) => t.name === 'get_item_details');

const PROBE_ACTOR_ID = 'wcD2h1fQmIxIab4B'; // Test Valeros in sandbox
const LONGSWORD_UUID = 'Compendium.pf2e.equipment-srd.Item.LJdbVTOZog39EEbi';

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

async function callGetItemDetails(uuid) {
  if (!getItemDetailsTool) return { isError: true, error: { message: 'tool not registered' } };
  const parsed = getItemDetailsTool.inputSchema.safeParse({ uuid });
  if (!parsed.success) return { isError: true, validation: parsed.error.issues };
  const blocks = await getItemDetailsTool
    .handler(parsed.data, { browser: session, log })
    .catch((err) => ({ __throw: { message: err?.message ?? String(err) } }));
  if (blocks?.__throw) return { isError: true, error: blocks.__throw };
  const block = blocks?.[0];
  if (!block || block.type !== 'text') return { isError: true, raw: blocks };
  return { ok: true, data: JSON.parse(block.text) };
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub: sweep any leftover __probe_create_scroll_or_wand_*
  // items from interrupted prior runs of either Phase 1 or this probe,
  // and any "Scroll of …" / "Wand of …" items created by failed runs.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: 'actor missing' };
    // Phase 1 probe items.
    const phase1Orphans = actor.items.contents
      .filter(
        (i) => typeof i.name === 'string' && i.name.startsWith('__probe_create_scroll_or_wand_'),
      )
      .map((i) => i.id);
    if (phase1Orphans.length > 0) {
      await actor.deleteEmbeddedDocuments('Item', phase1Orphans);
    }
    return { deletedPhase1Orphans: phase1Orphans.length, itemCount: actor.items.size };
  }, PROBE_ACTOR_ID);
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Snapshot start-of-probe inventory.
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate((actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    return {
      itemCount: actor.items.size,
      items: actor.items.contents.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        qty: typeof i.system?.quantity === 'number' ? i.system.quantity : 1,
      })),
    };
  }, PROBE_ACTOR_ID);
  log.info({ itemCount: startSnapshot.itemCount }, 'snapshot: start-of-probe inventory captured');

  // --------------------------------------------------------------------
  // Discovery: spell UUIDs + backpack id + a non-container item id.
  // --------------------------------------------------------------------
  const discovery = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    const items = actor.items?.contents ?? [];

    const spellsPack = globalThis.game.packs?.get('pf2e.spells-srd');
    if (!spellsPack) return { error: 'pf2e.spells-srd missing' };
    const idx = await spellsPack.getIndex({ fields: ['system.level', 'system.traits'] });
    const entries = idx.contents ?? [];
    const findByName = (needle) =>
      entries.find((e) => (e.name ?? '').toLowerCase() === needle.toLowerCase());
    const make = (entry) =>
      entry
        ? {
            uuid: entry.uuid ?? `Compendium.${spellsPack.collection}.Item.${entry._id}`,
            name: entry.name,
            rank: entry.system?.level?.value ?? null,
            traits: entry.system?.traits?.value ?? [],
          }
        : null;

    // Primary spell: Force Barrage (remaster) → Magic Missile (legacy)
    // → Heal (last-resort, always present).
    let primary = make(findByName('Force Barrage')) ?? make(findByName('Magic Missile'));
    if (!primary || primary.rank !== 1) {
      primary = make(findByName('Heal'));
    }

    const heal = make(findByName('Heal'));
    const fireball = make(findByName('Fireball'));
    const detectMagic = make(findByName('Detect Magic'));

    const backpack = items.find((i) => i.type === 'backpack');

    return {
      primary,
      heal,
      fireball,
      detectMagic,
      backpack: backpack ? { id: backpack.id, name: backpack.name } : null,
    };
  }, PROBE_ACTOR_ID);

  if (discovery.error) {
    log.error({ discovery }, 'discovery failed; aborting');
    process.exit(2);
  }
  log.info({ discovery }, 'discovery: probe targets located');
  if (!discovery.primary || discovery.primary.rank !== 1) {
    log.error('no rank-1 standard spell discoverable for primary probe — aborting');
    process.exit(2);
  }
  if (!discovery.heal) {
    log.error('Heal not found — required for probe 2');
    process.exit(2);
  }
  if (!discovery.fireball || discovery.fireball.rank !== 3) {
    log.error('Fireball not found at rank 3 — required for probes 3 and 9');
    process.exit(2);
  }
  if (!discovery.detectMagic) {
    log.error('Detect Magic not found — required for probe 8');
    process.exit(2);
  }
  if (!discovery.backpack) {
    log.error('Test Valeros has no backpack — required for probe 3');
    process.exit(2);
  }

  const backpackId = discovery.backpack.id;

  // --------------------------------------------------------------------
  // Probe 1: happy path scroll of Force Barrage at rank 1.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.primary.uuid,
      kind: 'scroll',
      rank: 1,
    });
    log.info({ probe: 1, res }, 'probe 1: scroll of primary spell, rank 1');
    assert(res.ok === true, 'probe 1: ok', { res });
    if (res.ok) {
      assert(res.data.item?.kind === 'scroll', 'probe 1: kind=scroll', {
        kind: res.data.item?.kind,
      });
      assert(res.data.item?.rank === 1, 'probe 1: rank=1', { rank: res.data.item?.rank });
      assert(res.data.item?.quantity === 1, 'probe 1: qty=1', {
        qty: res.data.item?.quantity,
      });
      assert(
        res.data.item?.spellUuid === discovery.primary.uuid,
        'probe 1: spellUuid matches input',
        { spellUuid: res.data.item?.spellUuid },
      );
      assert(
        res.data.item?.spellName === discovery.primary.name,
        'probe 1: spellName matches input',
        { spellName: res.data.item?.spellName },
      );
      assert(
        res.data.item?.name === `Scroll of ${discovery.primary.name}`,
        'probe 1: item name follows "Scroll of {Spell}" convention',
        { name: res.data.item?.name },
      );
      assert(res.data.item?.containerId === null, 'probe 1: containerId null (top level)', {
        containerId: res.data.item?.containerId,
      });
      assert(res.data.item?.identificationStatus === 'identified', 'probe 1: default identified', {
        status: res.data.item?.identificationStatus,
      });

      // Sanity: get_item_details should round-trip the consumable.
      const details = await callGetItemDetails(res.data.item.uuid);
      assert(details.ok === true, 'probe 1: get_item_details ok', { details });
      if (details.ok) {
        assert(
          details.data?.consumable?.spell?.name === discovery.primary.name,
          'probe 1: get_item_details exposes embedded spell name',
          { consumable: details.data?.consumable },
        );
        assert(
          details.data?.consumable?.category === 'scroll',
          'probe 1: get_item_details category=scroll',
          { category: details.data?.consumable?.category },
        );
      }
    }
  }

  // --------------------------------------------------------------------
  // Probe 2: wand of Heal at rank 1.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.heal.uuid,
      kind: 'wand',
      rank: 1,
    });
    log.info({ probe: 2, res }, 'probe 2: wand of Heal, rank 1');
    assert(res.ok === true, 'probe 2: ok', { res });
    if (res.ok) {
      assert(res.data.item?.kind === 'wand', 'probe 2: kind=wand', {
        kind: res.data.item?.kind,
      });
      assert(res.data.item?.rank === 1, 'probe 2: rank=1', { rank: res.data.item?.rank });
      assert(
        res.data.item?.name === `Wand of ${discovery.heal.name}`,
        'probe 2: item name follows "Wand of {Spell}" convention',
        { name: res.data.item?.name },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 3: scroll of Fireball at rank 3 into backpack.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.fireball.uuid,
      kind: 'scroll',
      rank: 3,
      containerId: backpackId,
    });
    log.info({ probe: 3, res }, 'probe 3: scroll of Fireball, rank 3, in backpack');
    assert(res.ok === true, 'probe 3: ok', { res });
    if (res.ok) {
      assert(res.data.item?.containerId === backpackId, 'probe 3: containerId set on new entry', {
        containerId: res.data.item?.containerId,
      });
      assert(res.data.item?.rank === 3, 'probe 3: rank=3', { rank: res.data.item?.rank });
    }
  }

  // --------------------------------------------------------------------
  // Probe 4: heightened scroll of primary at rank 3.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.primary.uuid,
      kind: 'scroll',
      rank: 3,
    });
    log.info({ probe: 4, res }, 'probe 4: heightened scroll, rank 3');
    assert(res.ok === true, 'probe 4: ok', { res });
    if (res.ok) {
      assert(res.data.item?.rank === 3, 'probe 4: rank=3', { rank: res.data.item?.rank });
      // The embedded spell should now report heightenedLevel: 3.
      const details = await callGetItemDetails(res.data.item.uuid);
      assert(details.ok === true, 'probe 4: get_item_details ok', { details });
      if (details.ok) {
        const heightened =
          details.data?.consumable?.spell?.system?.location?.heightenedLevel ?? null;
        assert(heightened === 3, 'probe 4: embedded spell heightenedLevel=3', {
          heightened,
          consumable: details.data?.consumable,
        });
      }
    }
  }

  // --------------------------------------------------------------------
  // Probe 5: quantity > 1.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.primary.uuid,
      kind: 'scroll',
      rank: 1,
      quantity: 3,
    });
    log.info({ probe: 5, res }, 'probe 5: scroll of primary, rank 1, qty 3');
    assert(res.ok === true, 'probe 5: ok', { res });
    if (res.ok) {
      assert(res.data.item?.quantity === 3, 'probe 5: qty=3', {
        qty: res.data.item?.quantity,
      });
    }
  }

  // --------------------------------------------------------------------
  // Probe 6: unidentified.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.primary.uuid,
      kind: 'scroll',
      rank: 1,
      identified: false,
    });
    log.info({ probe: 6, res }, 'probe 6: scroll of primary, unidentified');
    assert(res.ok === true, 'probe 6: ok', { res });
    if (res.ok) {
      assert(
        res.data.item?.identificationStatus === 'unidentified',
        'probe 6: identificationStatus=unidentified',
        { status: res.data.item?.identificationStatus },
      );
    }
  }

  // --------------------------------------------------------------------
  // Probe 7: non-spell UUID.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: LONGSWORD_UUID,
      kind: 'scroll',
      rank: 1,
    });
    log.info({ probe: 7, res }, 'probe 7: non-spell UUID');
    assert(res.isError === true, 'probe 7: error', { res });
    assert(
      res.error?.message?.includes('requires a spell'),
      'probe 7: non-spell rejection message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 8: cantrip rejection.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.detectMagic.uuid,
      kind: 'scroll',
      rank: 1,
    });
    log.info({ probe: 8, res }, 'probe 8: cantrip rejection');
    assert(res.isError === true, 'probe 8: error', { res });
    assert(res.error?.message?.includes('cantrip'), 'probe 8: cantrip rejection message', {
      msg: res.error?.message,
    });
  }

  // --------------------------------------------------------------------
  // Probe 9: rank below spell base rank (Fireball at rank 1).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.fireball.uuid,
      kind: 'scroll',
      rank: 1,
    });
    log.info({ probe: 9, res }, 'probe 9: rank below base rank');
    assert(res.isError === true, 'probe 9: error', { res });
    assert(
      res.error?.message?.includes('below the spell'),
      'probe 9: below-base-rank rejection message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 10: rank 10 wand (no template).
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.fireball.uuid,
      kind: 'wand',
      rank: 10,
    });
    log.info({ probe: 10, res }, 'probe 10: rank-10 wand');
    assert(res.isError === true, 'probe 10: error', { res });
    assert(
      res.error?.message?.includes('no rank-10 wand template'),
      'probe 10: rank-10-wand-missing rejection message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 11: bad actorId.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: 'deadbeef',
      spellUuid: discovery.primary.uuid,
      kind: 'scroll',
      rank: 1,
    });
    log.info({ probe: 11, res }, 'probe 11: bad actorId');
    assert(res.isError === true, 'probe 11: error', { res });
    assert(
      res.error?.message?.startsWith('No actor found for actorId:'),
      'probe 11: actor-not-found message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 12: bad containerId.
  // --------------------------------------------------------------------
  {
    const res = await call({
      actorId: PROBE_ACTOR_ID,
      spellUuid: discovery.primary.uuid,
      kind: 'scroll',
      rank: 1,
      containerId: 'deadbeefdeadbeef',
    });
    log.info({ probe: 12, res }, 'probe 12: bad containerId');
    assert(res.isError === true, 'probe 12: error', { res });
    assert(
      res.error?.message?.startsWith('No item found on actor for containerId:'),
      'probe 12: container-not-found message',
      { msg: res.error?.message },
    );
  }

  // --------------------------------------------------------------------
  // Probe 13: non-container containerId (use the actor's first weapon).
  // --------------------------------------------------------------------
  {
    const weaponId = await page.evaluate((actorId) => {
      const actor = globalThis.game.actors?.get(actorId);
      const ls = actor.items.contents.find((i) => i.type === 'weapon' && !i.system?.containerId);
      return ls ? ls.id : null;
    }, PROBE_ACTOR_ID);
    if (!weaponId) {
      log.warn('probe 13 skipped — no top-level weapon on actor');
    } else {
      const res = await call({
        actorId: PROBE_ACTOR_ID,
        spellUuid: discovery.primary.uuid,
        kind: 'scroll',
        rank: 1,
        containerId: weaponId,
      });
      log.info({ probe: 13, res, weaponId }, 'probe 13: non-container containerId');
      assert(res.isError === true, 'probe 13: error', { res });
      assert(
        /is type \w+, not a container/.test(res.error?.message ?? ''),
        'probe 13: wrong-container-type message',
        { msg: res.error?.message },
      );
    }
  }

  // --------------------------------------------------------------------
  // Teardown: restore the actor to the exact start-of-probe snapshot.
  //
  //   1. Delete any item whose id is on the actor but not in the
  //      snapshot (orphans introduced by probes 1-6).
  //   2. For each snapshot id whose current quantity differs from the
  //      snapshot, restore via updateEmbeddedDocuments (probes 1-6 are
  //      additive, so quantity drift should not occur, but the check
  //      is the safety net).
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (actorId, snapshot) => {
      const actor = globalThis.game.actors?.get(actorId);
      const snapshotIds = new Set(snapshot.items.map((i) => i.id));
      const snapshotQty = new Map(snapshot.items.map((i) => [i.id, i.qty]));

      const deleted = [];
      const deleteFailures = [];
      const orphanIds = actor.items.contents.filter((i) => !snapshotIds.has(i.id)).map((i) => i.id);
      for (const id of orphanIds) {
        const existing = actor.items.get(id);
        if (!existing) continue;
        try {
          await existing.delete();
          deleted.push(id);
        } catch (err) {
          deleteFailures.push(`${id}:${err?.message ?? String(err)}`);
        }
      }

      const updates = [];
      for (const item of actor.items.contents) {
        const expected = snapshotQty.get(item.id);
        if (expected === undefined) continue;
        const current = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        if (current !== expected) {
          updates.push({ _id: item.id, 'system.quantity': expected });
        }
      }
      if (updates.length > 0) {
        await actor.updateEmbeddedDocuments('Item', updates);
      }

      const finalIds = new Set(actor.items.contents.map((i) => i.id));
      const driftedAfter = [];
      for (const item of actor.items.contents) {
        const expected = snapshotQty.get(item.id);
        if (expected === undefined) continue;
        const current = typeof item.system?.quantity === 'number' ? item.system.quantity : 1;
        if (current !== expected) {
          driftedAfter.push({ id: item.id, name: item.name, expected, actual: current });
        }
      }
      const extraIds = [...finalIds].filter((id) => !snapshotIds.has(id));
      const missingIds = [...snapshotIds].filter((id) => !finalIds.has(id));

      return {
        deletedCount: deleted.length,
        deleteFailures,
        updatedCount: updates.length,
        finalItemCount: actor.items.size,
        idsMatch: extraIds.length === 0 && missingIds.length === 0,
        extraIds,
        missingIds,
        driftedAfter,
      };
    },
    PROBE_ACTOR_ID,
    startSnapshot,
  );
  log.info({ teardown }, 'teardown: restore to start-of-probe snapshot');

  // --------------------------------------------------------------------
  // Probe 14: snapshot-equality verification.
  // --------------------------------------------------------------------
  assert(
    teardown.finalItemCount === startSnapshot.itemCount,
    'probe 14: item count equals snapshot',
    { snapshot: startSnapshot.itemCount, final: teardown.finalItemCount },
  );
  assert(teardown.idsMatch === true, 'probe 14: item-id set equals snapshot', {
    extraIds: teardown.extraIds,
    missingIds: teardown.missingIds,
  });
  assert(teardown.driftedAfter.length === 0, 'probe 14: every snapshot id has snapshot quantity', {
    drifted: teardown.driftedAfter,
  });
  assert(teardown.deleteFailures.length === 0, 'probe 14: no orphan delete failures', {
    failures: teardown.deleteFailures,
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
