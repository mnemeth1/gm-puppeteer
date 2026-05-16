/**
 * Throwaway end-to-end check that the compendium warm actually helps.
 * Launches a fresh session (triggers the background warm), waits for
 * the warm to finish (or up to 90 s), then times the same
 * descriptionMatch query twice — once on the warm-allowlisted pack
 * and once on a non-warmed pack — to show the warm's effect.
 *
 *   npm run build && node scripts/e2e-warm-verify.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'search_compendium');
if (!tool) throw new Error('search_compendium tool not registered');

const warmedPack = 'pf2e.pathfinder-monster-core'; // in default WARM_PHASE2_PACKS
const coldPack = 'pf2e.pathfinder-bestiary'; // not in default allowlist

const run = async (label, args) => {
  const t0 = performance.now();
  const content = await tool.handler(args, { browser: session, log });
  const ms = +(performance.now() - t0).toFixed(0);
  const text = content?.[0]?.type === 'text' ? content[0].text : '{}';
  const payload = JSON.parse(text);
  console.log(
    JSON.stringify({
      label,
      ms,
      total: payload.total ?? null,
      returned: payload.returned ?? null,
      firstHit: payload.results?.[0]?.name ?? null,
    }),
  );
};

try {
  console.log(JSON.stringify({ step: 'ensureStarted (triggers warm)' }));
  const t0 = performance.now();
  await session.ensureStarted();
  console.log(
    JSON.stringify({
      step: 'session ready',
      ms: +(performance.now() - t0).toFixed(0),
    }),
  );

  console.log(JSON.stringify({ step: 'sleeping 75s for warm to settle' }));
  await new Promise((r) => setTimeout(r, 75_000));

  // Description-match against the warmed pack — should be fast.
  await run('warmed pack, descriptionMatch="dragon"', {
    pack: warmedPack,
    descriptionMatch: 'dragon',
    limit: 5,
  });

  // Re-run — should also be fast (still warm).
  await run('warmed pack, second run', {
    pack: warmedPack,
    descriptionMatch: 'dragon',
    limit: 5,
  });

  // Cold pack — should be slow on first run.
  await run('COLD pack, descriptionMatch="dragon"', {
    pack: coldPack,
    descriptionMatch: 'dragon',
    limit: 5,
  });

  // Cold pack again — now warm (Foundry just cached on the first call).
  await run('cold pack, second run', {
    pack: coldPack,
    descriptionMatch: 'dragon',
    limit: 5,
  });
} finally {
  await session.stop().catch(() => undefined);
}
