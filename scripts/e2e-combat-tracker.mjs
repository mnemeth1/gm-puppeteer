/**
 * End-to-end check for the combat-tracker tools, driven through the real
 * MCP tool handlers (zod parse + handler + evaluator), not raw eval.
 *
 * Flow: discover the active scene → start_combat (created / idempotent) →
 * add_combatants (added / alreadyPresent / notFound) → get_combat_state →
 * begin_combat (start / idempotent) → remove_combatants (removed /
 * notFound) → end_combat (deleted / idempotent).
 *
 * Safety: aborts if the active scene already owns a combat encounter, so
 * the run never clobbers a real encounter. Teardown calls end_combat.
 *
 *   npm run build && node scripts/e2e-combat-tracker.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

const byName = new Map(tools.map((t) => [t.name, t]));
async function call(name, input) {
  const tool = byName.get(name);
  if (!tool) return { isError: true, error: { message: `tool ${name} not registered` } };
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { isError: true, validation: parsed.error.issues };
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

  // Discover the active scene and its tokens.
  const scene = await page.evaluate(() => {
    const s = globalThis.game.scenes?.active ?? null;
    return {
      id: s?.id ?? null,
      name: s?.name ?? null,
      tokenIds: (s?.tokens?.contents ?? []).map((t) => t.id),
    };
  });
  log.info({ scene }, 'discovered active scene');
  if (!scene.id || scene.tokenIds.length < 2) {
    log.error('need an active scene with >= 2 tokens; aborting');
    process.exit(2);
  }
  const [tokenA, tokenB, tokenC] = [
    scene.tokenIds[0],
    scene.tokenIds[1],
    scene.tokenIds[2] ?? scene.tokenIds[1],
  ];

  // Guard: never clobber a pre-existing encounter.
  const pre = await call('get_combat_state', {});
  log.info({ step: 'pre', pre }, 'get_combat_state (pre)');
  assert(pre.ok === true, 'pre: get_combat_state ok', { pre });
  if (pre.ok && pre.data.combat !== null) {
    log.error('active scene already owns a combat encounter; aborting to avoid clobbering it');
    process.exit(2);
  }

  // 1. start_combat — created.
  const s1 = await call('start_combat', {});
  log.info({ step: 1, s1 }, 'start_combat (create)');
  assert(s1.ok && s1.data.created === true, '1: start_combat created', { s1 });
  assert(s1.ok && s1.data.round === 0, '1: round 0', { s1 });
  assert(s1.ok && s1.data.started === false, '1: not started', { s1 });

  // 2. start_combat again — idempotent.
  const s2 = await call('start_combat', {});
  log.info({ step: 2, s2 }, 'start_combat (idempotent)');
  assert(s2.ok && s2.data.created === false, '2: start_combat idempotent', { s2 });
  assert(s2.ok && s2.data.combatId === s1.data.combatId, '2: same combatId', { s1, s2 });

  // 3. add_combatants — added + notFound.
  const a1 = await call('add_combatants', { tokenIds: [tokenA, tokenB, 'bogusTokenId00'] });
  log.info({ step: 3, a1 }, 'add_combatants (add + notFound)');
  assert(a1.ok && a1.data.added.length === 2, '3: two added', { a1 });
  assert(a1.ok && a1.data.notFound.length === 1, '3: one notFound', { a1 });
  assert(
    a1.ok && a1.data.added.every((e) => typeof e.combatantId === 'string' && e.combatantId),
    '3: added entries carry combatantId',
    { a1 },
  );

  // 4. add_combatants again — alreadyPresent + added.
  const a2 = await call('add_combatants', { tokenIds: [tokenA, tokenC] });
  log.info({ step: 4, a2 }, 'add_combatants (alreadyPresent)');
  assert(a2.ok && a2.data.alreadyPresent.some((e) => e.tokenId === tokenA), '4: tokenA alreadyPresent', {
    a2,
  });
  // tokenC may equal tokenB on a 2-token scene; in that case it's alreadyPresent too.
  const tokenCWasNew = tokenC !== tokenA && tokenC !== tokenB;
  assert(
    a2.ok && (tokenCWasNew ? a2.data.added.length === 1 : a2.data.added.length === 0),
    '4: tokenC add reflects whether it was new',
    { a2, tokenCWasNew },
  );

  // 5. get_combat_state — combatants present, not started.
  const g1 = await call('get_combat_state', {});
  log.info({ step: 5, g1 }, 'get_combat_state (populated)');
  assert(g1.ok && g1.data.combat !== null, '5: combat present', { g1 });
  assert(g1.ok && g1.data.combat.started === false, '5: not started', { g1 });
  assert(g1.ok && g1.data.combat.round === 0, '5: round 0', { g1 });
  assert(g1.ok && g1.data.combat.combatants.length >= 2, '5: combatants listed', { g1 });
  assert(
    g1.ok && g1.data.combat.combatants.every((c) => c.initiative === null),
    '5: initiative null before begin',
    { g1 },
  );

  // 6. begin_combat — start, then idempotent.
  const b1 = await call('begin_combat', {});
  log.info({ step: 6, b1 }, 'begin_combat (start)');
  assert(b1.ok && b1.data.started === true, '6: started', { b1 });
  assert(b1.ok && b1.data.round === 1, '6: round 1', { b1 });
  assert(b1.ok && b1.data.alreadyStarted === false, '6: alreadyStarted false', { b1 });

  const b2 = await call('begin_combat', {});
  log.info({ step: 7, b2 }, 'begin_combat (idempotent)');
  assert(b2.ok && b2.data.alreadyStarted === true, '7: begin_combat idempotent', { b2 });

  // 8. remove_combatants — removed + notFound.
  const victims = g1.data.combat.combatants.map((c) => c.combatantId);
  const r1 = await call('remove_combatants', {
    combatantIds: [victims[0], 'bogusCombatantId0'],
  });
  log.info({ step: 8, r1 }, 'remove_combatants (remove + notFound)');
  assert(r1.ok && r1.data.removed.length === 1, '8: one removed', { r1 });
  assert(r1.ok && r1.data.notFound.length === 1, '8: one notFound', { r1 });

  // 9. end_combat — deleted, then idempotent.
  const e1 = await call('end_combat', {});
  log.info({ step: 9, e1 }, 'end_combat (delete)');
  assert(e1.ok && e1.data.deleted === true, '9: end_combat deleted', { e1 });
  assert(e1.ok && e1.data.combatId === s1.data.combatId, '9: deleted the combat we created', {
    e1,
  });

  const e2 = await call('end_combat', {});
  log.info({ step: 10, e2 }, 'end_combat (idempotent)');
  assert(e2.ok && e2.data.deleted === false, '10: end_combat idempotent', { e2 });
  assert(e2.ok && e2.data.combatId === null, '10: combatId null when nothing to end', { e2 });

  // Final state check.
  const gFinal = await call('get_combat_state', {});
  assert(gFinal.ok && gFinal.data.combat === null, 'final: scene has no combat', { gFinal });

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'E2E FAILED');
    process.exitCode = 1;
  } else {
    log.info('all combat-tracker e2e assertions passed');
    process.exitCode = 0;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'e2e failed',
  );
  // Best-effort teardown so a mid-run failure doesn't leave a combat behind.
  await call('end_combat', {}).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
