/**
 * One-shot probe: log in to live headless Foundry and answer the v14 +
 * PF2e 8.1.2 API questions that gate the get_actor_inventory impl.
 *
 * All probes are read-only. The script creates and deletes a single
 * disposable "rune-shape" probe actor (a fresh-from-compendium longsword
 * dropped onto a temp actor) only if we cannot find an existing magical
 * weapon in the world. Cleanup runs in `finally`.
 *
 * Questions:
 *   1. Strict-physical type set — iterate items on Valeros + Goblin Warrior 1
 *      and document every item.type. Identify which are physical inventory.
 *   2. Equipped-state shape — read item.system.equipped on equipped weapons,
 *      worn armor, stowed consumables. Document carryType / handsHeld /
 *      inSlot.
 *   3. Container hierarchy — read system.containerId across items. Is it
 *      null, missing, or a string id? Same question for container items.
 *   4. Bulk shape — read system.bulk for a sword, chain shirt, coin pouch,
 *      heavy item. Document the field structure and PF2e's "L" / numeric
 *      convention.
 *   5. Rune storage on PF2e 8.1.2 — confirm whether runes live at
 *      system.runes {potency, striking, property[]} or in legacy fields.
 *      Probe both a non-magical and a magical weapon.
 *   6. Currency shape — actor.system.coins denominations.
 *   7. Traits shape — confirm system.traits.value is an array of slug strings.
 *   8. Iteration path — actor.items.contents canonical?
 *
 *   npm run build && node scripts/probe-actor-inventory.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const PROBE_ACTOR_NAME = '__gm_puppeteer_probe_inventory__';

async function cleanupProbeActor(page) {
  return page.evaluate(async (name) => {
    const docs = globalThis.game.actors?.contents?.filter((a) => a.name === name) ?? [];
    const removed = [];
    for (const doc of docs) {
      try {
        await doc.delete();
        removed.push(doc.id);
      } catch (e) {
        removed.push(`failed:${doc.id}:${e?.message ?? e}`);
      }
    }
    return { removed };
  }, PROBE_ACTOR_NAME);
}

try {
  const { page } = await session.ensureStarted();

  // --- Q0: confirm the candidate actors exist. ---
  const candidates = await page.evaluate(() => {
    const game = globalThis.game;
    const out = {};
    for (const a of game.actors?.contents ?? []) {
      if (a.id === 'tLhy0qgJyw31QaEy' || a.id === 'QKC9vREnE3ajuVIF') {
        out[a.id] = { id: a.id, name: a.name, type: a.type, itemCount: a.items?.size ?? -1 };
      }
    }
    return out;
  });
  log.info({ candidates }, 'Q0: candidate actors present in world');

  // --- Q1: iterate items on both actors and tabulate item types. ---
  const typeTabulation = await page.evaluate(() => {
    const game = globalThis.game;
    const tab = {};
    for (const actorId of ['tLhy0qgJyw31QaEy', 'QKC9vREnE3ajuVIF']) {
      const a = game.actors?.get(actorId);
      if (!a) continue;
      const types = {};
      const iterPath = {
        contentsLen: a.items?.contents?.length ?? -1,
        size: a.items?.size ?? -1,
        isMap: typeof a.items?.get === 'function',
        isCollection: a.items?.constructor?.name,
      };
      for (const item of a.items?.contents ?? []) {
        const t = item.type;
        types[t] = (types[t] ?? 0) + 1;
      }
      tab[actorId] = {
        name: a.name,
        type: a.type,
        types,
        iterPath,
      };
    }
    return tab;
  });
  log.info({ typeTabulation }, 'Q1: item.type frequencies on candidate actors');

  // --- Q8: iteration path confirmation. ---
  const iterPath = await page.evaluate(() => {
    const a = globalThis.game.actors?.get('tLhy0qgJyw31QaEy');
    if (!a) return { error: 'no actor' };
    return {
      hasContents: Array.isArray(a.items?.contents),
      contentsLen: a.items?.contents?.length,
      contentsIsArrayLike: a.items?.contents?.every?.((x) => x?.type !== undefined) ?? false,
      hasValues: typeof a.items?.values === 'function',
      valuesIsIterable: typeof a.items?.values === 'function',
      hasSize: typeof a.items?.size === 'number',
      classCtor: a.items?.constructor?.name,
    };
  });
  log.info({ iterPath }, 'Q8: actor.items iteration path');

  // --- Q2: equipped-state, Q3: containerId, Q4: bulk, Q5: runes, Q7: traits.
  // For each physical-looking item on Valeros, dump the shape of the fields
  // we expect to project. Group by type so we can identify which types
  // carry which fields.
  const itemShapes = await page.evaluate(() => {
    const a = globalThis.game.actors?.get('tLhy0qgJyw31QaEy');
    if (!a) return { error: 'no Valeros' };
    const out = [];
    for (const item of a.items?.contents ?? []) {
      const sys = item.system ?? {};
      out.push({
        id: item.id,
        name: item.name,
        type: item.type,
        // equipped state
        equipped: sys.equipped !== undefined ? JSON.parse(JSON.stringify(sys.equipped)) : null,
        equippedKeys: sys.equipped ? Object.keys(sys.equipped) : null,
        // container
        containerId: sys.containerId ?? null,
        hasContainerIdKey: 'containerId' in sys,
        // bulk
        bulk: sys.bulk !== undefined ? JSON.parse(JSON.stringify(sys.bulk)) : null,
        bulkKeys: sys.bulk && typeof sys.bulk === 'object' ? Object.keys(sys.bulk) : null,
        // traits
        traits:
          sys.traits !== undefined
            ? {
                value: sys.traits?.value ?? null,
                valueIsArray: Array.isArray(sys.traits?.value),
                rarity: sys.traits?.rarity ?? null,
                keys: Object.keys(sys.traits ?? {}),
              }
            : null,
        // runes
        runes: sys.runes !== undefined ? JSON.parse(JSON.stringify(sys.runes)) : null,
        runesKeys: sys.runes && typeof sys.runes === 'object' ? Object.keys(sys.runes) : null,
        // legacy rune fields (pre-consolidation)
        legacyPotency: sys.potencyRune?.value ?? null,
        legacyStriking: sys.strikingRune?.value ?? null,
        legacyProp1: sys.propertyRune1?.value ?? null,
        // quantity, level
        quantity: sys.quantity ?? null,
        level: sys.level?.value ?? sys.level ?? null,
      });
    }
    return { actorName: a.name, items: out };
  });
  log.info(
    { actor: itemShapes.actorName, itemCount: itemShapes.items?.length, items: itemShapes.items },
    'Q2/Q3/Q4/Q5/Q7: per-item shape dump (Valeros)',
  );

  // --- Same dump for Goblin Warrior 1, since NPC item shapes can differ from PC. ---
  const itemShapesGoblin = await page.evaluate(() => {
    const a = globalThis.game.actors?.get('QKC9vREnE3ajuVIF');
    if (!a) return { error: 'no Goblin Warrior 1' };
    const out = [];
    for (const item of a.items?.contents ?? []) {
      const sys = item.system ?? {};
      out.push({
        id: item.id,
        name: item.name,
        type: item.type,
        equipped: sys.equipped !== undefined ? JSON.parse(JSON.stringify(sys.equipped)) : null,
        containerId: sys.containerId ?? null,
        bulk: sys.bulk !== undefined ? JSON.parse(JSON.stringify(sys.bulk)) : null,
        traitsValue: sys.traits?.value ?? null,
        runes: sys.runes !== undefined ? JSON.parse(JSON.stringify(sys.runes)) : null,
        quantity: sys.quantity ?? null,
        level: sys.level?.value ?? sys.level ?? null,
      });
    }
    return { actorName: a.name, items: out };
  });
  log.info(
    {
      actor: itemShapesGoblin.actorName,
      itemCount: itemShapesGoblin.items?.length,
      items: itemShapesGoblin.items,
    },
    'Q2/Q3/Q4/Q5/Q7: per-item shape dump (Goblin Warrior 1)',
  );

  // --- Q6: currency on each actor. ---
  const currencyProbe = await page.evaluate(() => {
    const game = globalThis.game;
    const out = {};
    for (const id of ['tLhy0qgJyw31QaEy', 'QKC9vREnE3ajuVIF']) {
      const a = game.actors?.get(id);
      if (!a) continue;
      const sys = a.system ?? {};
      out[id] = {
        name: a.name,
        hasCoinsKey: 'coins' in sys,
        coins: sys.coins !== undefined ? JSON.parse(JSON.stringify(sys.coins)) : null,
        coinsKeys: sys.coins && typeof sys.coins === 'object' ? Object.keys(sys.coins) : null,
        // PF2e treasure stash uses sys.totalWealth sometimes; just dump it.
        hasTotalWealth: 'totalWealth' in sys,
        totalWealth: sys.totalWealth ?? null,
      };
    }
    return out;
  });
  log.info({ currencyProbe }, 'Q6: currency shape on candidate actors');

  // --- Q5 (magical weapon path): find or temporarily create a magical-rune weapon.
  // First check if any actor in the world already has one we can read non-destructively.
  const magicalWeaponSearch = await page.evaluate(() => {
    const game = globalThis.game;
    for (const a of game.actors?.contents ?? []) {
      for (const item of a.items?.contents ?? []) {
        if (item.type !== 'weapon') continue;
        const r = item.system?.runes;
        const legacyP = item.system?.potencyRune?.value;
        if (
          (r && (r.potency > 0 || r.striking > 0 || (r.property?.length ?? 0) > 0)) ||
          (legacyP && legacyP > 0)
        ) {
          return {
            actorId: a.id,
            actorName: a.name,
            itemId: item.id,
            name: item.name,
            runes: r ? JSON.parse(JSON.stringify(r)) : null,
            legacyPotency: legacyP ?? null,
            legacyStriking: item.system?.strikingRune?.value ?? null,
            legacyProp1: item.system?.propertyRune1?.value ?? null,
          };
        }
      }
    }
    return null;
  });
  log.info({ magicalWeaponSearch }, 'Q5: existing magical-rune weapon search');

  let createdProbeActorId = null;
  if (!magicalWeaponSearch) {
    log.info('Q5: no existing magical weapon found; will create a probe actor + magical longsword');

    // Look up a magical longsword UUID in pf2e.equipment-srd. PF2e 8.1.2
    // ships standard +1 striking weapons we can pull.
    const magicalUuid = await page.evaluate(async () => {
      const pack = globalThis.game.packs?.get('pf2e.equipment-srd');
      if (!pack) return null;
      const idx = await pack.getIndex();
      // Look for "+1 striking" or "+1 longsword" or similar magic items.
      const candidates = idx.contents.filter((e) => {
        const n = (e.name ?? '').toLowerCase();
        return n.includes('+1') || n.includes('+2');
      });
      const longsword = candidates.find((e) => (e.name ?? '').toLowerCase().includes('longsword'));
      const anyWeapon = candidates[0];
      const pick = longsword ?? anyWeapon ?? null;
      if (!pick) return null;
      return {
        uuid: pick.uuid ?? `Compendium.${pack.collection}.Item.${pick._id}`,
        name: pick.name,
      };
    });
    log.info({ magicalUuid }, 'Q5: candidate magical weapon for probe');

    if (magicalUuid?.uuid) {
      // Find a non-magical longsword too, for comparison.
      const plainUuid = await page.evaluate(async () => {
        const pack = globalThis.game.packs?.get('pf2e.equipment-srd');
        if (!pack) return null;
        const idx = await pack.getIndex();
        const hit = idx.contents.find((e) => (e.name ?? '').toLowerCase() === 'longsword');
        if (!hit) return null;
        return {
          uuid: hit.uuid ?? `Compendium.${pack.collection}.Item.${hit._id}`,
          name: hit.name,
        };
      });
      log.info({ plainUuid }, 'Q5: candidate non-magical weapon for probe');

      const probeResult = await page.evaluate(
        async (actorName, magicUuid, plainUuid) => {
          // Create a disposable NPC to host the items.
          const created = await Actor.implementation.create({
            name: actorName,
            type: 'npc',
          });
          if (!created) return { error: 'create failed' };

          const magicalItem = await fromUuid(magicUuid);
          const plainItem = plainUuid ? await fromUuid(plainUuid) : null;

          const data = [magicalItem.toObject()];
          if (plainItem) data.push(plainItem.toObject());
          for (const d of data) delete d._id;
          const items = await created.createEmbeddedDocuments('Item', data);

          return {
            actorId: created.id,
            actorName: created.name,
            items: items.map((it) => ({
              id: it.id,
              name: it.name,
              type: it.type,
              runes: it.system?.runes ? JSON.parse(JSON.stringify(it.system.runes)) : null,
              runesKeys:
                it.system?.runes && typeof it.system.runes === 'object'
                  ? Object.keys(it.system.runes)
                  : null,
              legacyPotency: it.system?.potencyRune?.value ?? null,
              legacyStriking: it.system?.strikingRune?.value ?? null,
              legacyProp1: it.system?.propertyRune1?.value ?? null,
              quantity: it.system?.quantity ?? null,
              level: it.system?.level?.value ?? it.system?.level ?? null,
              bulk: it.system?.bulk ? JSON.parse(JSON.stringify(it.system.bulk)) : null,
              traitsValue: it.system?.traits?.value ?? null,
              equipped:
                it.system?.equipped !== undefined
                  ? JSON.parse(JSON.stringify(it.system.equipped))
                  : null,
              containerId: it.system?.containerId ?? null,
            })),
          };
        },
        PROBE_ACTOR_NAME,
        magicalUuid.uuid,
        plainUuid?.uuid ?? null,
      );
      createdProbeActorId = probeResult?.actorId ?? null;
      log.info({ probeResult }, 'Q5: rune shape on a fresh magical + non-magical weapon');
    }
  }

  // --- Cleanup. ---
  if (createdProbeActorId) {
    const cleanup = await cleanupProbeActor(page);
    log.info({ cleanup }, 'cleanup');
  }

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  try {
    const { page } = await session.ensureStarted();
    const cleanup = await cleanupProbeActor(page);
    log.warn({ cleanup }, 'post-failure cleanup');
  } catch {
    /* already in error path */
  }
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
