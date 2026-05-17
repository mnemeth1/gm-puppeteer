/**
 * Probe for `dnd5e_get_actor_inventory`. Two phases in one file.
 *
 * Read-only — reads `game.actors` only, no mutation, no world teardown.
 *
 *   npm run build && node scripts/probe-dnd5e-get-actor-inventory.mjs
 *
 * PHASE 1 — raw-shape discovery. Dumps the live dnd5e 5.x actor/item schema
 * so the evaluator's field paths are probe-verified, not ported from the
 * PF2e sibling on faith. Confirms: physical vs non-physical item types;
 * `actor.items.contents` is a real array; the physical-item field paths
 * (`system.quantity / weight / price / equipped / attunement / attuned /
 * identified / container`); `actor.system.currency` is a five-denomination
 * `{pp,gp,ep,sp,cp}` object (incl. electrum); `container`-type items carry
 * their own `system.currency` pool; the `system.uses` shape.
 *
 * PHASE 2 — evaluator exercise. Runs the compiled evaluator
 * (`dist/evaluators/dnd5e-get-actor-inventory.js`) inside the headless
 * Foundry client exactly as the MCP tool handler does, and asserts the
 * projection plus the ACTOR_NOT_FOUND error path.
 *
 * Actors are resolved live from `game.actors` — the probe does not assume
 * specific world ids. It needs at least one dnd5e actor with a physical
 * inventory; the character/npc split is best-effort and skipped if absent.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { dnd5eGetActorInventoryBody } from '../dist/evaluators/dnd5e-get-actor-inventory.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const BOGUS_ID = 'deadbeefdeadbeef';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    log.info({ detail }, `PASS — ${name}`);
  } else {
    failures += 1;
    log.error({ detail }, `FAIL — ${name}`);
  }
};

try {
  const { page } = await session.ensureStarted();

  // ======================================================================
  // PHASE 1 — raw-shape discovery.
  // ======================================================================
  log.info('=== PHASE 1: raw-shape discovery ===');

  // Q0 — confirm the world is dnd5e and enumerate candidate actors. Pick the
  // character and npc with the most items so the per-item dump is richest.
  const survey = await page.evaluate(() => {
    const game = globalThis.game;
    const PHYSICAL = ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'];
    const actors = [];
    for (const a of game.actors?.contents ?? []) {
      const contents = a.items?.contents ?? [];
      actors.push({
        id: a.id,
        name: a.name,
        type: a.type,
        itemCount: contents.length,
        physicalCount: contents.filter((i) => PHYSICAL.includes(i.type)).length,
        contentsIsArray: Array.isArray(contents),
      });
    }
    const pickBest = (t) =>
      actors
        .filter((a) => a.type === t)
        .sort((x, y) => y.physicalCount - x.physicalCount)[0] ?? null;
    return {
      systemId: game.system?.id,
      actorCount: actors.length,
      actors,
      character: pickBest('character'),
      npc: pickBest('npc'),
    };
  });
  log.info({ survey }, 'Q0: world survey + candidate actors');
  check('Q0 world system is dnd5e', survey.systemId === 'dnd5e', survey.systemId);
  check('Q0 at least one actor with a physical inventory exists',
    survey.actors.some((a) => a.physicalCount > 0),
    survey.actors.map((a) => `${a.name}:${a.physicalCount}`));

  const charId = survey.character?.id ?? null;
  const npcId = survey.npc?.id ?? null;
  const probeId = charId ?? npcId ?? survey.actors.find((a) => a.physicalCount > 0)?.id ?? null;
  if (!probeId) {
    log.error('no dnd5e actor with a physical inventory — cannot probe');
    process.exitCode = 1;
    throw new Error('no probe subject');
  }

  // Q1–Q7 — per-actor item-type tabulation, physical-item field dump,
  // currency shape, container per-item currency, uses shape.
  const dumpActor = (actorId) =>
    page.evaluate((id) => {
      const game = globalThis.game;
      const a = game.actors?.get(id);
      if (!a) return { error: 'not found' };
      const PHYSICAL = new Set([
        'weapon', 'equipment', 'consumable', 'tool', 'loot', 'container',
      ]);
      const types = {};
      const physicalItems = [];
      for (const item of a.items?.contents ?? []) {
        types[item.type] = (types[item.type] ?? 0) + 1;
        if (!PHYSICAL.has(item.type)) continue;
        const sys = item.system ?? {};
        physicalItems.push({
          name: item.name,
          type: item.type,
          quantity: sys.quantity ?? null,
          weight: sys.weight ?? null,
          price: sys.price ?? null,
          equipped: sys.equipped ?? null,
          equippedType: typeof sys.equipped,
          attunement: sys.attunement ?? null,
          attuned: sys.attuned ?? null,
          identified: 'identified' in sys ? sys.identified : '(absent)',
          container: 'container' in sys ? sys.container : '(absent)',
          uses: sys.uses ? JSON.parse(JSON.stringify(sys.uses)) : null,
          // container per-item currency
          currency:
            item.type === 'container' && sys.currency
              ? JSON.parse(JSON.stringify(sys.currency))
              : null,
        });
      }
      const sysCurrency = a.system?.currency;
      return {
        name: a.name,
        type: a.type,
        types,
        actorCurrency: sysCurrency ? JSON.parse(JSON.stringify(sysCurrency)) : null,
        actorCurrencyKeys:
          sysCurrency && typeof sysCurrency === 'object' ? Object.keys(sysCurrency) : null,
        hasCoinsKey: !!a.system && 'coins' in a.system,
        physicalItems,
      };
    }, actorId);

  const charDump = charId ? await dumpActor(charId) : null;
  const npcDump = npcId ? await dumpActor(npcId) : null;
  if (charDump) log.info({ charDump }, 'Q1-Q7: character actor item/currency dump');
  if (npcDump) log.info({ npcDump }, 'Q1-Q7: npc actor item/currency dump');

  const dumps = [charDump, npcDump].filter(Boolean);

  // Q5 — actor currency shape: five denominations incl. electrum.
  for (const d of dumps) {
    const keys = d.actorCurrencyKeys ?? [];
    check(`Q5 ${d.type} "${d.name}" currency has pp/gp/ep/sp/cp`,
      ['pp', 'gp', 'ep', 'sp', 'cp'].every((k) => keys.includes(k)),
      { keys, currency: d.actorCurrency });
    check(`Q5 ${d.type} "${d.name}" currency NOT at system.coins`,
      d.hasCoinsKey === false, d.hasCoinsKey);
  }

  // Q3 — physical-item field paths. `equipped` is a bare boolean on every
  // physical type EXCEPT `loot`, which carries no equipped/attunement/
  // attuned fields at all (the evaluator defaults them to false/""/false).
  for (const d of dumps) {
    const items = d.physicalItems ?? [];
    const nonLoot = items.filter((i) => i.type !== 'loot');
    const loot = items.filter((i) => i.type === 'loot');
    check(`Q3 ${d.type} "${d.name}" non-loot physical items have boolean equipped`,
      nonLoot.every((i) => i.equippedType === 'boolean'),
      nonLoot.map((i) => `${i.name}:${i.equippedType}`));
    check(`Q3 ${d.type} "${d.name}" loot items carry no equipped field`,
      loot.every((i) => i.equippedType === 'undefined'),
      loot.map((i) => `${i.name}:${i.equippedType}`));
    check(`Q3 ${d.type} "${d.name}" price is {value,denomination,valueInGP}`,
      items.length === 0 ||
        items.every((i) => i.price && typeof i.price === 'object' && 'denomination' in i.price),
      items.map((i) => i.price));
  }

  // Q6 — container per-item currency pool.
  const containers = dumps.flatMap((d) =>
    (d.physicalItems ?? []).filter((i) => i.type === 'container'),
  );
  if (containers.length > 0) {
    check('Q6 container items expose a system.currency pool',
      containers.some((c) => c.currency !== null),
      containers.map((c) => ({ name: c.name, currency: c.currency })));
  } else {
    log.warn('Q6 skipped — no container-type items on the probed actors');
  }

  // Q7 — uses shape: max is a number when finite, "" when unlimited.
  const usesItems = dumps.flatMap((d) =>
    (d.physicalItems ?? []).filter((i) => i.uses !== null),
  );
  if (usesItems.length > 0) {
    log.info({ usesItems: usesItems.map((i) => ({ name: i.name, uses: i.uses })) },
      'Q7: system.uses shapes observed');
  } else {
    log.warn('Q7 skipped — no items with a system.uses block on the probed actors');
  }

  // ======================================================================
  // PHASE 2 — evaluator exercise.
  // ======================================================================
  log.info('=== PHASE 2: evaluator exercise ===');

  const run = (actorId) => page.evaluate(dnd5eGetActorInventoryBody, { actorId });

  const PHYSICAL = ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'];

  for (const [label, id] of [['character', charId], ['npc', npcId]]) {
    if (!id) {
      log.warn(`S1 ${label} skipped — no such actor in world`);
      continue;
    }
    const r = await run(id);
    check(`S1 ${label} → ok with items array + currency`,
      r.ok && Array.isArray(r.items) && r.currency && typeof r.currency === 'object',
      r.ok ? { actorName: r.actorName, itemCount: r.items.length } : r);
    check(`S1 ${label} items are all physical types only`,
      r.ok && r.items.every((i) => PHYSICAL.includes(i.type)),
      r.ok ? [...new Set(r.items.map((i) => i.type))] : r);
    check(`S1 ${label} currency has five numeric denominations`,
      r.ok &&
        ['pp', 'gp', 'ep', 'sp', 'cp'].every((k) => typeof r.currency[k] === 'number'),
      r.ok ? r.currency : r);
    check(`S1 ${label} every item has the structural fields`,
      r.ok &&
        r.items.every(
          (i) =>
            typeof i.id === 'string' &&
            typeof i.name === 'string' &&
            typeof i.quantity === 'number' &&
            typeof i.equipped === 'boolean' &&
            typeof i.attunement === 'string' &&
            typeof i.identified === 'boolean' &&
            (i.container === null || typeof i.container === 'string'),
        ),
      r.ok ? r.items.find((i) => typeof i.id !== 'string') ?? 'all-well-formed' : r);
    if (r.ok) {
      const withUses = r.items.filter((i) => i.uses);
      const withCurrency = r.items.filter((i) => i.currency);
      log.info(
        {
          label,
          itemCount: r.items.length,
          withUses: withUses.map((i) => ({ name: i.name, uses: i.uses })),
          containerCurrency: withCurrency.map((i) => ({ name: i.name, currency: i.currency })),
        },
        `S1 ${label}: uses + container-currency observed`,
      );
      check(`S1 ${label} uses block (when present) is only on finite-charge items`,
        withUses.every((i) => i.uses.max > 0),
        withUses.map((i) => i.uses));
      check(`S1 ${label} currency field appears only on container items`,
        withCurrency.every((i) => i.type === 'container'),
        withCurrency.map((i) => i.type));
    }
  }

  // S2 — ACTOR_NOT_FOUND error path.
  const s2 = await run(BOGUS_ID);
  check('S2 bogus actor id → ok:false ACTOR_NOT_FOUND',
    !s2.ok && s2.error.code === 'ACTOR_NOT_FOUND', s2);

  if (failures > 0) {
    log.error({ failures }, 'probe completed with failures');
    process.exitCode = 1;
  } else {
    log.info('probe completed — all scenarios passed');
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
