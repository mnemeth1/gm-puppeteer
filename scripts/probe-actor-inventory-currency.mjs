/**
 * Follow-up probe: where does PF2e 8.1.2 expose actor currency?
 * The main probe found actor.system.coins absent on both Valeros and the
 * Goblin Warrior, even though Valeros has a "Copper Pieces" treasure item.
 *
 *   npm run build && node scripts/probe-actor-inventory-currency.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const currencyExploration = await page.evaluate(() => {
    const a = globalThis.game.actors?.get('tLhy0qgJyw31QaEy');
    if (!a) return { error: 'no Valeros' };

    // Candidate paths PF2e might expose currency on.
    const paths = {};
    const tryGet = (label, fn) => {
      try {
        paths[label] = JSON.parse(JSON.stringify(fn() ?? null));
      } catch (e) {
        paths[label] = `THREW:${e?.message ?? e}`;
      }
    };

    tryGet('a.system.coins', () => a.system?.coins);
    tryGet('a.inventory?.coins', () => a.inventory?.coins);
    tryGet('a.inventory?.coins.toObject?.()', () =>
      typeof a.inventory?.coins?.toObject === 'function' ? a.inventory.coins.toObject() : null,
    );
    tryGet('a.inventory?.coins keys', () =>
      a.inventory?.coins && typeof a.inventory.coins === 'object'
        ? Object.keys(a.inventory.coins)
        : null,
    );
    tryGet('a.inventory keys', () =>
      a.inventory && typeof a.inventory === 'object' ? Object.keys(a.inventory) : null,
    );
    tryGet('a.system keys', () =>
      a.system && typeof a.system === 'object' ? Object.keys(a.system) : null,
    );

    // Direct method/property probes for the standard PF2e Coins API.
    const inv = a.inventory;
    const probe = {
      hasInventory: !!inv,
      inventoryCtor: inv?.constructor?.name,
      hasCoins: 'coins' in (inv ?? {}),
      coinsCtor: inv?.coins?.constructor?.name,
      coinsHasPP: typeof inv?.coins?.pp === 'number',
      coinsHasGP: typeof inv?.coins?.gp === 'number',
      coinsHasSP: typeof inv?.coins?.sp === 'number',
      coinsHasCP: typeof inv?.coins?.cp === 'number',
      coinsPP: inv?.coins?.pp ?? null,
      coinsGP: inv?.coins?.gp ?? null,
      coinsSP: inv?.coins?.sp ?? null,
      coinsCP: inv?.coins?.cp ?? null,
    };

    // Also: enumerate treasure items by slug to see if currency is treasure-by-slug.
    const treasureItems = [];
    for (const item of a.items?.contents ?? []) {
      if (item.type !== 'treasure') continue;
      treasureItems.push({
        id: item.id,
        name: item.name,
        slug: item.system?.slug ?? null,
        price: item.system?.price ?? null,
        quantity: item.system?.quantity ?? null,
        denomination: item.system?.denomination ?? null,
        size: item.system?.size ?? null,
        stackGroup: item.system?.stackGroup ?? null,
      });
    }

    return { paths, probe, treasureItems };
  });
  log.info({ currencyExploration }, 'currency exploration on Valeros');

  // Try an actor with explicit coins. Most starter actors don't, but maybe Goblin does.
  const goblinCurrency = await page.evaluate(() => {
    const a = globalThis.game.actors?.get('QKC9vREnE3ajuVIF');
    if (!a) return null;
    return {
      name: a.name,
      inventoryCoins: a.inventory?.coins
        ? {
            pp: a.inventory.coins.pp ?? null,
            gp: a.inventory.coins.gp ?? null,
            sp: a.inventory.coins.sp ?? null,
            cp: a.inventory.coins.cp ?? null,
          }
        : null,
    };
  });
  log.info({ goblinCurrency }, 'goblin warrior currency');

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
