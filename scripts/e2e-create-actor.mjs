/**
 * End-to-end exercise of create_actor_from_compendium against live
 * headless Foundry. Logs in once, runs every scenario, cleans up.
 *
 * Scenarios:
 *   1. search_compendium → Valeros UUID lookup (no hardcoded UUID).
 *   2. create_actor_from_compendium(Valeros, no overrides) → type
 *      character, actorLink true, proto name "Valeros".
 *   3. create_actor_from_compendium(Valeros, name="Test Valeros") →
 *      actor name AND prototype name both "Test Valeros" (the v13 bug).
 *   4. search_compendium → bestiary NPC UUID lookup.
 *   5. create_actor_from_compendium(NPC, name="Goblin Warrior 1") →
 *      type npc, actorLink false, proto name "Goblin Warrior 1".
 *   6. create_actor_from_compendium(Valeros, actorLink=false) →
 *      payload override accepted; returned actorLink reflects PF2e
 *      enforcement (true for character).
 *   7. Error: malformed UUID → INVALID_INPUT UUID_NOT_FOUND.
 *   8. Error: Item UUID → INVALID_INPUT NOT_AN_ACTOR.
 *
 * Cleanup deletes every actor created during the run.
 *
 *   npm run build && node scripts/e2e-create-actor.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const createTool = tools.find((t) => t.name === 'create_actor_from_compendium');
const searchTool = tools.find((t) => t.name === 'search_compendium');
if (!createTool || !searchTool) {
  console.error('required tools not registered');
  process.exit(2);
}

const created = [];
let failures = 0;

function check(label, ok, details = undefined) {
  if (ok) {
    log.info({ check: label }, 'PASS');
  } else {
    failures += 1;
    log.error({ check: label, ...(details ? { details } : {}) }, 'FAIL');
  }
}

async function callTool(tool, args) {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new Error(`bad input: ${JSON.stringify(parsed.error.issues)}`);
  try {
    const blocks = await tool.handler(parsed.data, { browser: session, log });
    const text = blocks.find((b) => b.type === 'text')?.text;
    return { ok: true, value: text ? JSON.parse(text) : null };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: err?.code,
        message: err?.message,
        details: err?.details,
      },
    };
  }
}

try {
  log.info('logging in');
  await session.ensureStarted();

  // --- Scenario 1: Find Valeros via search_compendium ---
  log.info('scenario 1: search_compendium for Valeros');
  const searchValeros = await callTool(searchTool, {
    query: 'Valeros',
    pack: 'pf2e.iconics',
    type: 'Actor',
    limit: 5,
  });
  const valerosHit = searchValeros.value?.results?.find((r) => r.name === 'Valeros (Level 5)');
  check(
    '1. search_compendium returns Valeros from pf2e.iconics',
    !!valerosHit?.uuid,
    !valerosHit?.uuid ? searchValeros : undefined,
  );
  if (!valerosHit) throw new Error('cannot continue without Valeros UUID');
  const valerosUuid = valerosHit.uuid;
  log.info({ valerosUuid }, 'using Valeros UUID');

  // --- Scenario 2: create from Valeros, no overrides ---
  log.info('scenario 2: create from Valeros, no overrides');
  const s2 = await callTool(createTool, { uuid: valerosUuid });
  check('2a. ok', s2.ok, s2);
  if (s2.ok) {
    created.push(s2.value.actorId);
    check('2b. type === character', s2.value.type === 'character', s2.value);
    check('2c. actorLink === true', s2.value.actorLink === true, s2.value);
    // The iconics Valeros source has actor.name="Valeros (Level 5)" but
    // prototypeToken.name="Valeros" — intentionally different in the
    // compendium. With no override we passthrough the source's proto name.
    check(
      '2d. prototypeTokenName === "Valeros" (passthrough from source proto)',
      s2.value.prototypeTokenName === 'Valeros',
      s2.value,
    );
  }

  // --- Scenario 3: name override — anti-v13-bug check ---
  log.info('scenario 3: create from Valeros with name="Test Valeros"');
  const s3 = await callTool(createTool, { uuid: valerosUuid, name: 'Test Valeros' });
  check('3a. ok', s3.ok, s3);
  if (s3.ok) {
    created.push(s3.value.actorId);
    check('3b. actor name === "Test Valeros"', s3.value.name === 'Test Valeros', s3.value);
    check(
      '3c. prototypeTokenName === "Test Valeros" (anti v13 bug)',
      s3.value.prototypeTokenName === 'Test Valeros',
      s3.value,
    );
  }

  // --- Scenario 4: search for an NPC ---
  log.info('scenario 4: search_compendium for an NPC');
  // Use a stable, well-known bestiary entry: search any pf2e bestiary pack for "goblin warrior".
  const searchGoblin = await callTool(searchTool, {
    query: 'goblin warrior',
    type: 'Actor',
    limit: 5,
  });
  const goblinHit = searchGoblin.value?.results?.find((r) => r.type === 'npc');
  check(
    '4. search_compendium returns an NPC for "goblin warrior"',
    !!goblinHit?.uuid,
    !goblinHit?.uuid ? searchGoblin : undefined,
  );
  if (!goblinHit) {
    log.warn('no goblin warrior in any pack — skipping NPC scenarios');
  }

  // --- Scenario 5: NPC creation with name override ---
  let s5 = null;
  if (goblinHit) {
    log.info({ goblinUuid: goblinHit.uuid }, 'scenario 5: create NPC with name override');
    s5 = await callTool(createTool, {
      uuid: goblinHit.uuid,
      name: 'Goblin Warrior 1',
    });
    check('5a. ok', s5.ok, s5);
    if (s5.ok) {
      created.push(s5.value.actorId);
      check('5b. type === npc', s5.value.type === 'npc', s5.value);
      check('5c. actorLink === false (NPC heuristic)', s5.value.actorLink === false, s5.value);
      check('5d. name === "Goblin Warrior 1"', s5.value.name === 'Goblin Warrior 1', s5.value);
      check(
        '5e. prototypeTokenName === "Goblin Warrior 1"',
        s5.value.prototypeTokenName === 'Goblin Warrior 1',
        s5.value,
      );
    }
  }

  // --- Scenario 6: explicit actorLink:false on character ---
  log.info('scenario 6: create from Valeros with actorLink=false');
  const s6 = await callTool(createTool, { uuid: valerosUuid, actorLink: false });
  check('6a. ok', s6.ok, s6);
  if (s6.ok) {
    created.push(s6.value.actorId);
    // PF2e enforces actorLink=true on character regardless. The returned value
    // should reflect what PF2e actually stored.
    check(
      '6b. actorLink === true (PF2e enforces for character; returned reflects stored)',
      s6.value.actorLink === true,
      s6.value,
    );
  }

  // --- Scenario 7: malformed UUID ---
  log.info('scenario 7: malformed UUID');
  const s7 = await callTool(createTool, { uuid: 'Compendium.bogus.pack.Actor.deadbeef' });
  check('7a. fails', s7.ok === false, s7);
  check('7b. code is INVALID_INPUT', s7.error?.code === 'INVALID_INPUT', s7.error);
  check(
    '7c. message mentions the UUID',
    typeof s7.error?.message === 'string' && s7.error.message.includes('Compendium.bogus'),
    s7.error,
  );

  // --- Scenario 8: Item UUID (wrong document type) ---
  log.info('scenario 8: Item UUID returns NOT_AN_ACTOR');
  // Find any Item UUID via search_compendium.
  const searchItem = await callTool(searchTool, {
    query: 'a',
    type: 'Item',
    limit: 1,
  });
  const itemHit = searchItem.value?.results?.[0];
  if (!itemHit) {
    log.warn('no item found via search_compendium — skipping NOT_AN_ACTOR scenario');
  } else {
    const s8 = await callTool(createTool, { uuid: itemHit.uuid });
    check('8a. fails', s8.ok === false, s8);
    check('8b. code is INVALID_INPUT', s8.error?.code === 'INVALID_INPUT', s8.error);
    check(
      '8c. message says Item',
      typeof s8.error?.message === 'string' && s8.error.message.includes('Item'),
      s8.error,
    );
  }

  // --- Cleanup ---
  log.info({ count: created.length }, 'cleanup: deleting created actors');
  const { page } = await session.ensureStarted();
  const cleanup = await page.evaluate(async (ids) => {
    const removed = [];
    const failed = [];
    for (const id of ids) {
      const doc = globalThis.game.actors?.get(id);
      if (!doc) {
        failed.push({ id, reason: 'not in collection' });
        continue;
      }
      try {
        await doc.delete();
        removed.push(id);
      } catch (e) {
        failed.push({ id, reason: e?.message ?? String(e) });
      }
    }
    return { removed, failed };
  }, created);
  log.info(cleanup, 'cleanup result');

  if (failures > 0) {
    log.error({ failures }, 'E2E FAILED');
    process.exitCode = 1;
  } else {
    log.info('E2E PASSED');
    process.exitCode = 0;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'e2e crashed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
