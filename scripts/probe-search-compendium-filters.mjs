/**
 * Live-Foundry probe for the search_compendium structured-filter
 * extension. Read-only — no mutations, so no teardown logic. Exercises
 * each filter independently and composed, including the encounter-prep
 * walkthrough anchor query (forest creatures L2-8).
 *
 *   npm run build && node scripts/probe-search-compendium-filters.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'search_compendium');
if (!tool) {
  log.error('search_compendium tool not found');
  process.exit(1);
}

const failures = [];

function assert(cond, label, ctx) {
  if (cond) {
    log.info({ label }, 'PASS');
  } else {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'FAIL');
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, validation: parsed.error.issues };
  }
  const blocks = await tool.handler(parsed.data, { browser: session, log });
  const block = blocks?.[0];
  if (!block || block.type !== 'text') {
    return { ok: false, raw: blocks };
  }
  return { ok: true, data: JSON.parse(block.text) };
}

try {
  await session.ensureStarted();

  // ====================================================================
  // 1. Empty input refused.
  // ====================================================================
  const empty = await call({});
  assert(
    empty.ok && empty.data?.ok === false && empty.data?.error?.code === 'NO_FILTERS',
    'empty input returns NO_FILTERS error',
    empty,
  );

  // ====================================================================
  // 2. Name query alone (smoke — equivalent to old behavior).
  // ====================================================================
  const goblinByName = await call({ query: 'goblin', limit: 5 });
  assert(
    goblinByName.ok &&
      Array.isArray(goblinByName.data?.results) &&
      goblinByName.data.results.length > 0,
    'name query "goblin" returns results',
    { count: goblinByName.data?.returned, total: goblinByName.data?.total },
  );
  assert(
    goblinByName.ok &&
      goblinByName.data.results.every(
        (r) => 'level' in r && 'traits' in r && 'rarity' in r && 'source' in r,
      ),
    'every row carries level/traits/rarity/source from widened index',
    goblinByName.data?.results?.[0],
  );
  assert(
    goblinByName.ok && goblinByName.data.results.every((r) => r.description === undefined),
    'no description when descriptionMatch is not set',
    goblinByName.data?.results?.[0],
  );

  // ====================================================================
  // 3. level filter alone (filter-only — no query).
  // ====================================================================
  const dragonsHigh = await call({
    query: 'dragon',
    level: { min: 15, max: 25 },
    actorType: 'npc',
    limit: 10,
  });
  assert(
    dragonsHigh.ok && (dragonsHigh.data.results ?? []).length > 0,
    'level + actorType filter returns level-15+ dragons',
    { count: dragonsHigh.data?.returned, sample: dragonsHigh.data?.results?.[0]?.name },
  );
  assert(
    dragonsHigh.ok &&
      dragonsHigh.data.results.every((r) => r.level !== null && r.level >= 15 && r.level <= 25),
    'all level-filtered rows are within range',
    dragonsHigh.data?.results?.map((r) => ({ name: r.name, level: r.level })).slice(0, 5),
  );
  assert(
    dragonsHigh.ok && dragonsHigh.data.results.every((r) => r.type === 'npc'),
    'all rows are actorType=npc',
    dragonsHigh.data?.results?.map((r) => r.type),
  );

  // ====================================================================
  // 4. traits filter alone.
  // ====================================================================
  const plantsLowMid = await call({
    actorType: 'npc',
    traits: ['plant'],
    level: { min: 1, max: 8 },
    limit: 20,
  });
  assert(
    plantsLowMid.ok && plantsLowMid.data.results.length > 0,
    'traits filter "plant" returns plant-trait creatures',
    { count: plantsLowMid.data?.returned, sample: plantsLowMid.data?.results?.[0]?.name },
  );
  assert(
    plantsLowMid.ok &&
      plantsLowMid.data.results.every((r) =>
        (r.traits ?? []).map((t) => t.toLowerCase()).includes('plant'),
      ),
    'all rows carry the "plant" trait',
    plantsLowMid.data?.results?.map((r) => ({ name: r.name, traits: r.traits })).slice(0, 5),
  );

  // ====================================================================
  // 5. rarity filter.
  // ====================================================================
  const rareItems = await call({
    type: 'Item',
    rarity: 'rare',
    pack: 'pf2e.equipment-srd',
    limit: 10,
  });
  assert(
    rareItems.ok && rareItems.data.results.length > 0,
    'rarity=rare in equipment-srd returns results',
    { count: rareItems.data?.returned },
  );
  assert(
    rareItems.ok && rareItems.data.results.every((r) => r.rarity === 'rare'),
    'all rare-filtered rows have rarity=rare',
    rareItems.data?.results?.map((r) => r.rarity),
  );

  // ====================================================================
  // 6. itemType filter.
  // ====================================================================
  const weapons = await call({
    pack: 'pf2e.equipment-srd',
    itemType: 'weapon',
    level: { min: 5, max: 10 },
    limit: 10,
  });
  assert(weapons.ok && weapons.data.results.length > 0, 'itemType=weapon + level returns weapons', {
    count: weapons.data?.returned,
  });
  assert(
    weapons.ok && weapons.data.results.every((r) => r.type === 'weapon'),
    'all rows are weapons',
    weapons.data?.results?.map((r) => r.type),
  );

  // ====================================================================
  // 7. source filter.
  // ====================================================================
  const monsterCore = await call({
    actorType: 'npc',
    source: ['Monster Core'],
    level: { min: 5, max: 6 },
    limit: 10,
  });
  assert(
    monsterCore.ok && monsterCore.data.results.length > 0,
    'source filter "Monster Core" returns results',
    { count: monsterCore.data?.returned },
  );
  assert(
    monsterCore.ok &&
      monsterCore.data.results.every((r) =>
        (r.source ?? '').toLowerCase().includes('monster core'),
      ),
    'all rows are sourced to Monster Core',
    monsterCore.data?.results?.map((r) => ({ name: r.name, source: r.source })).slice(0, 5),
  );

  // ====================================================================
  // 8. descriptionMatch — no result for a junk string.
  // ====================================================================
  const noHit = await call({
    pack: 'pf2e.pathfinder-bestiary',
    descriptionMatch: 'XQZJUNK',
    limit: 5,
  });
  assert(
    noHit.ok && noHit.data.returned === 0 && noHit.data.total === 0,
    'descriptionMatch "XQZJUNK" returns 0',
    noHit.data,
  );

  // ====================================================================
  // 9. The encounter-prep walkthrough anchor query.
  // ====================================================================
  const forestQuery = await call({
    actorType: 'npc',
    level: { min: 2, max: 8 },
    traits: ['plant', 'fey', 'beast', 'animal'],
    descriptionMatch: 'forest',
    limit: 15,
  });
  assert(
    forestQuery.ok && forestQuery.data.results.length > 0,
    'walkthrough query returns forest-flavored creatures L2-8',
    {
      count: forestQuery.data?.returned,
      total: forestQuery.data?.total,
      sample: forestQuery.data?.results?.slice(0, 5).map((r) => ({
        name: r.name,
        level: r.level,
        traits: r.traits,
        excerpt: r.descriptionMatchExcerpt,
      })),
    },
  );
  assert(
    forestQuery.ok &&
      forestQuery.data.results.every((r) => r.level !== null && r.level >= 2 && r.level <= 8),
    'all walkthrough hits are level 2-8',
    forestQuery.data?.results?.map((r) => ({ name: r.name, level: r.level })),
  );
  assert(
    forestQuery.ok &&
      forestQuery.data.results.every((r) => {
        const lower = (r.traits ?? []).map((t) => t.toLowerCase());
        return ['plant', 'fey', 'beast', 'animal'].some((wanted) => lower.includes(wanted));
      }),
    'all walkthrough hits carry at least one of plant/fey/beast/animal',
    forestQuery.data?.results?.map((r) => ({ name: r.name, traits: r.traits })),
  );
  assert(
    forestQuery.ok &&
      forestQuery.data.results.every(
        (r) =>
          typeof r.descriptionMatchExcerpt === 'string' &&
          r.descriptionMatchExcerpt.toLowerCase().includes('forest'),
      ),
    'every hit carries an excerpt containing "forest"',
    forestQuery.data?.results?.map((r) => ({
      name: r.name,
      excerpt: r.descriptionMatchExcerpt,
    })),
  );

  // ====================================================================
  // 10. limit honored when many candidates pass.
  // ====================================================================
  const capped = await call({
    actorType: 'npc',
    pack: 'pf2e.pathfinder-monster-core',
    level: { min: 1, max: 20 },
    limit: 3,
  });
  assert(
    capped.ok && capped.data.returned === 3 && capped.data.total > 3,
    'limit caps returned but total reports the full match count',
    { returned: capped.data?.returned, total: capped.data?.total },
  );

  log.info({ failureCount: failures.length, failures }, 'PROBE SUMMARY');
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}

if (failures.length > 0) process.exit(1);
