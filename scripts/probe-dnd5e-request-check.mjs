/**
 * Acceptance probe for dnd5e_request_check. Exercises the registered
 * tool end-to-end against the live dnd5e world: a check request for
 * every category, verification that the posted message carries a
 * clickable roll-link anchor and the right whisper set, and every error
 * reason. The tool only posts chat messages, so teardown is a
 * message-id set-diff delete.
 *
 *   npm run build && node scripts/probe-dnd5e-request-check.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'dnd5e_request_check');
if (!tool) {
  log.error('dnd5e_request_check not registered');
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

async function messageContent(id) {
  return page.evaluate((mid) => {
    const m = globalThis.game.messages?.get(mid);
    return m && typeof m.content === 'string' ? m.content : null;
  }, id);
}

let page;
try {
  ({ page } = await session.ensureStarted());

  const setup = await page.evaluate(() => {
    const game = globalThis.game;
    const pick = (t) => game.actors?.contents.find((a) => a.type === t);
    const npc = pick('npc');
    const pc = pick('character');
    return {
      npc: npc ? { id: npc.id, name: npc.name } : null,
      pc: pc ? { id: pc.id, name: pc.name } : null,
      baseMsgIds: game.messages?.contents.map((m) => m.id) ?? [],
    };
  });

  if (!setup.pc) {
    log.error('probe aborted: world needs a character actor');
    process.exitCode = 1;
    throw new Error('precondition failed');
  }
  log.info({ npc: setup.npc, pc: setup.pc }, 'test actors');

  // -- Happy path: skill check request with DC.
  const r1 = await call({ actorId: setup.pc.id, category: 'skill', key: 'acr', dc: 15 });
  assert(r1.ok && r1.data.ok, 'skill request ok', r1);
  if (r1.ok && r1.data.ok) {
    assert(
      r1.data.checkExpression === '[[/check skill=acr dc=15]]',
      'checkExpression literal',
      r1.data,
    );
    assert(r1.data.whisperedTo.length > 0, 'whisperedTo non-empty', r1.data);
    assert(typeof r1.data.chatMessageId === 'string', 'chatMessageId set', r1.data);
    const content = await messageContent(r1.data.chatMessageId);
    assert(
      typeof content === 'string' && /<a[^>]*class="[^"]*roll-link/.test(content),
      'posted message has clickable roll-link anchor',
      { content },
    );
  }

  // -- Happy path: ability check request, no DC.
  const r2 = await call({ actorId: setup.pc.id, category: 'ability', key: 'str' });
  assert(r2.ok && r2.data.ok, 'ability request ok', r2);
  if (r2.ok && r2.data.ok) {
    assert(r2.data.checkExpression === '[[/check ability=str]]', 'no-DC expression', r2.data);
  }

  // -- Happy path: saving throw request.
  const r3 = await call({ actorId: setup.pc.id, category: 'save', key: 'dex', dc: 13 });
  assert(r3.ok && r3.data.ok, 'save request ok', r3);
  if (r3.ok && r3.data.ok) {
    assert(r3.data.checkExpression === '[[/save ability=dex dc=13]]', 'save expression', r3.data);
    const content = await messageContent(r3.data.chatMessageId);
    assert(
      typeof content === 'string' && content.includes(' saving throw.'),
      'save sentence includes "saving throw."',
      { content },
    );
  }

  // -- Happy path: tool check request.
  const r4 = await call({ actorId: setup.pc.id, category: 'tool', key: 'thief', dc: 14 });
  assert(r4.ok && r4.data.ok, 'tool request ok', r4);

  // -- Error: NPC actor rejected.
  if (setup.npc) {
    const e1 = await call({ actorId: setup.npc.id, category: 'skill', key: 'acr' });
    assert(
      e1.isError && e1.error?.details?.reason === 'ACTOR_NOT_A_PC',
      'NPC -> ACTOR_NOT_A_PC',
      e1,
    );
  }

  // -- Error: bogus actor.
  const e2 = await call({ actorId: 'nonexistent000000', category: 'skill', key: 'acr' });
  assert(
    e2.isError && e2.error?.details?.reason === 'ACTOR_NOT_FOUND',
    'bogus id -> ACTOR_NOT_FOUND',
    e2,
  );

  // -- Error: invalid key.
  const e3 = await call({ actorId: setup.pc.id, category: 'ability', key: 'bogus' });
  assert(
    e3.isError && e3.error?.details?.reason === 'CHECK_KEY_INVALID',
    'bad key -> CHECK_KEY_INVALID',
    e3,
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
    log.info('PROBE PASSED — dnd5e_request_check verified end-to-end');
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
