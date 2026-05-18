/**
 * Acceptance probe for dnd5e_roll_check. Exercises the registered tool
 * end-to-end against the live dnd5e world: happy paths for every check
 * category, the visibility modes, and every error reason. The tool only
 * posts chat messages, so teardown is a message-id set-diff delete — no
 * actor-state snapshot needed.
 *
 *   npm run build && node scripts/probe-dnd5e-roll-check.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_roll_check');
if (!tool) {
  log.error('dnd5e_roll_check not registered');
  process.exit(2);
}

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  } else {
    log.info({ label }, 'ok');
  }
}

async function call(input) {
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
  return { ok: true, data: JSON.parse(block.text) };
}

try {
  const { page } = await session.ensureStarted();

  const setup = await page.evaluate(() => {
    const game = globalThis.game;
    const pick = (t) => game.actors?.contents.find((a) => a.type === t);
    const npc = pick('npc');
    const pc = pick('character');
    const vehicle = pick('vehicle');
    return {
      npc: npc ? { id: npc.id, name: npc.name } : null,
      pc: pc ? { id: pc.id, name: pc.name } : null,
      vehicle: vehicle ? { id: vehicle.id, name: vehicle.name } : null,
      baseMsgIds: game.messages?.contents.map((m) => m.id) ?? [],
    };
  });

  if (!setup.npc) {
    log.error('probe aborted: world needs an npc actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  log.info({ npc: setup.npc, pc: setup.pc, vehicle: setup.vehicle }, 'test actors');

  // -- Happy path: ability check, no DC.
  const r1 = await call({ actorId: setup.npc.id, category: 'ability', key: 'dex' });
  assert(r1.ok && r1.data.ok, 'ability check no DC ok', r1);
  if (r1.ok && r1.data.ok) {
    assert(r1.data.outcome === null, 'no-DC outcome is null', r1.data);
    assert(typeof r1.data.total === 'number', 'total numeric', r1.data);
    assert(r1.data.dieResult >= 1 && r1.data.dieResult <= 20, 'dieResult in 1..20', r1.data);
    assert(typeof r1.data.chatMessageId === 'string', 'chatMessageId set', r1.data);
    assert(r1.data.modifier === r1.data.total - r1.data.dieResult, 'modifier consistent', r1.data);
  }

  // -- Happy path: skill check with DC — outcome consistent with total.
  const r2 = await call({ actorId: setup.npc.id, category: 'skill', key: 'arc', dc: 12 });
  assert(r2.ok && r2.data.ok, 'skill check with DC ok', r2);
  if (r2.ok && r2.data.ok) {
    assert(r2.data.outcome === 'success' || r2.data.outcome === 'failure', 'outcome set', r2.data);
    assert(
      (r2.data.outcome === 'success') === (r2.data.total >= 12),
      'outcome consistent with total>=dc',
      r2.data,
    );
  }

  // -- Happy path: saving throw, gm visibility — message whispered.
  const r3 = await call({
    actorId: setup.npc.id,
    category: 'save',
    key: 'wis',
    dc: 10,
    visibility: 'gm',
  });
  assert(r3.ok && r3.data.ok, 'saving throw gm ok', r3);
  if (r3.ok && r3.data.ok && r3.data.chatMessageId) {
    const whisperLen = await page.evaluate((id) => {
      const m = globalThis.game.messages?.get(id);
      return Array.isArray(m?.whisper) ? m.whisper.length : -1;
    }, r3.data.chatMessageId);
    assert(whisperLen > 0, 'gm roll is whispered', { whisperLen });
  }

  // -- Happy path: tool check.
  const r4 = await call({ actorId: setup.npc.id, category: 'tool', key: 'thief' });
  assert(r4.ok && r4.data.ok, 'tool check ok', r4);

  // -- Error: PC actor rejected.
  if (setup.pc) {
    const e1 = await call({ actorId: setup.pc.id, category: 'ability', key: 'str' });
    assert(e1.isError && e1.error?.details?.reason === 'ACTOR_IS_PC', 'PC -> ACTOR_IS_PC', e1);
  }

  // -- Error: bogus actor.
  const e2 = await call({ actorId: 'nonexistent000000', category: 'ability', key: 'str' });
  assert(
    e2.isError && e2.error?.details?.reason === 'ACTOR_NOT_FOUND',
    'bogus id -> ACTOR_NOT_FOUND',
    e2,
  );

  // -- Error: vehicle actor rejected.
  if (setup.vehicle) {
    const e3 = await call({ actorId: setup.vehicle.id, category: 'skill', key: 'arc' });
    assert(
      e3.isError && e3.error?.details?.reason === 'ACTOR_TYPE_UNSUPPORTED',
      'vehicle -> ACTOR_TYPE_UNSUPPORTED',
      e3,
    );
  }

  // -- Error: invalid key.
  const e4 = await call({ actorId: setup.npc.id, category: 'skill', key: 'bogus' });
  assert(
    e4.isError && e4.error?.details?.reason === 'CHECK_KEY_INVALID',
    'bad key -> CHECK_KEY_INVALID',
    e4,
  );

  // -- Teardown: delete every message this probe created.
  const cleaned = await page.evaluate(async (baseIds) => {
    const base = new Set(baseIds);
    const game = globalThis.game;
    const created = game.messages?.contents.filter((m) => !base.has(m.id)).map((m) => m.id) ?? [];
    if (created.length > 0) await globalThis.ChatMessage.deleteDocuments(created);
    return created.length;
  }, setup.baseMsgIds);
  log.info({ cleaned }, 'probe chat messages deleted');

  if (failures.length > 0) {
    log.error({ failures }, `PROBE FAILED — ${failures.length} assertion(s)`);
    process.exitCode = 1;
  } else {
    log.info('PROBE PASSED — dnd5e_roll_check verified end-to-end');
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
