/**
 * Phase-1 exploratory probe for post_chat_message. Confirms the v14.361 +
 * PF2e 8.1.2 ChatMessage write behaviour BEFORE the post-chat-message
 * evaluator is written. Throwaway — does not exercise a tool.
 *
 * Questions:
 *   Q1. Raw HTML round-trips verbatim through
 *       `ChatMessage.implementation.create({content})` — no escaping,
 *       no sanitization, no auto-enrichment that mangles the markup.
 *   Q2. `create()` returns the created document with a usable `.id`.
 *   Q3. NPC speaker + whisper combine cleanly — all four
 *       speaker×whisper combinations (GM/NPC × public/whisper) post
 *       with the expected stored `speaker` and `whisper`.
 *   Q4. GM oversight — does the headless GM client (AI-GM, itself a GM
 *       user) see a whisper addressed only to a non-GM player user?
 *       (`message.visible` for the GM client.)
 *   Q5. Owner resolution — `game.users.filter(u =>
 *       actor.testUserPermission(u,'OWNER'))` for a PC yields owner
 *       players + GMs; for an NPC it yields only GMs. So "has a player
 *       owner" = "some non-GM user owns it" — confirm an NPC has none.
 *
 * Snapshots the ChatMessage id set, deletes everything it creates, and
 * asserts the set is restored.
 *
 *   npm run build && node scripts/probe-chat-post-phase1.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const out = await page.evaluate(async () => {
    const game = globalThis.game;
    const ChatMessageCls = globalThis.ChatMessage;
    const baselineIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);
    const report = {};

    const pc = game.actors?.contents.find((a) => a.type === 'character');
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    report.pc = pc ? { id: pc.id, name: pc.name } : null;
    report.npc = npc ? { id: npc.id, name: npc.name } : null;

    // -- Q5: owner resolution for a PC vs an NPC.
    const ownersOf = (actor) =>
      (game.users?.contents ?? [])
        .filter((u) => actor.testUserPermission(u, 'OWNER'))
        .map((u) => ({ id: u.id, name: u.name, isGM: u.isGM }));
    if (pc) {
      const owners = ownersOf(pc);
      report.pcOwners = owners;
      report.pcHasNonGmOwner = owners.some((u) => !u.isGM);
    }
    if (npc) {
      const owners = ownersOf(npc);
      report.npcOwners = owners;
      report.npcHasNonGmOwner = owners.some((u) => !u.isGM);
    }

    // A non-GM player user id, for the whisper-target / oversight probes.
    const playerUser = (game.users?.contents ?? []).find((u) => !u.isGM);
    report.playerUser = playerUser ? { id: playerUser.id, name: playerUser.name } : null;

    // -- Q1 + Q2: raw HTML round-trip.
    const rawHtml =
      '<p>The door <strong>creaks</strong> open &amp; <em>dust</em> falls.</p>' +
      '<ul><li>one</li><li>two</li></ul>';
    let rawMsg;
    try {
      rawMsg = await ChatMessageCls.implementation.create({ content: rawHtml });
      report.rawHtml = {
        returnedId: rawMsg?.id ?? null,
        storedContent: typeof rawMsg?.content === 'string' ? rawMsg.content : null,
        verbatim: rawMsg?.content === rawHtml,
      };
    } catch (e) {
      report.rawHtmlError = String(e);
    }

    // -- Q3: the four speaker×whisper combinations.
    const combos = [];
    const post = async (label, data) => {
      try {
        const m = await ChatMessageCls.implementation.create(data);
        const src = typeof m?.toObject === 'function' ? m.toObject() : {};
        combos.push({
          label,
          id: m?.id ?? null,
          speaker: src.speaker ?? null,
          whisper: src.whisper ?? null,
          visibleToGm: (() => {
            try {
              return m?.visible ?? null;
            } catch (e) {
              return `<<${String(e)}>>`;
            }
          })(),
        });
      } catch (e) {
        combos.push({ label, error: String(e) });
      }
    };

    const gmSpeaker = ChatMessageCls.getSpeaker();
    const npcSpeaker = npc ? ChatMessageCls.getSpeaker({ actor: npc }) : gmSpeaker;
    const whisperIds = playerUser ? [playerUser.id] : [];

    await post('gm-public', { content: '<p>gm public</p>', speaker: gmSpeaker });
    await post('gm-whisper', {
      content: '<p>gm whisper</p>',
      speaker: gmSpeaker,
      whisper: whisperIds,
    });
    await post('npc-public', { content: '<p>npc public</p>', speaker: npcSpeaker });
    await post('npc-whisper', {
      content: '<p>npc whisper</p>',
      speaker: npcSpeaker,
      whisper: whisperIds,
    });
    report.combos = combos;

    // -- Q4: GM oversight. The whispered combos above target only a
    // non-GM player; `visibleToGm` records whether the headless GM
    // client still sees them.
    report.gmSeesPlayerWhisper = combos
      .filter((c) => c.label.endsWith('-whisper'))
      .map((c) => ({ label: c.label, visibleToGm: c.visibleToGm }));

    // -- Cleanup.
    const created = (game.messages?.contents ?? [])
      .filter((m) => !baselineIds.has(m.id))
      .map((m) => m.id);
    if (created.length > 0) await ChatMessageCls.deleteDocuments(created);
    const finalIds = new Set((game.messages?.contents ?? []).map((m) => m.id));
    report.cleanup = {
      deleted: created.length,
      restored:
        finalIds.size === baselineIds.size && [...baselineIds].every((id) => finalIds.has(id)),
    };

    return report;
  });

  log.info(
    {
      pcHasNonGmOwner: out.pcHasNonGmOwner,
      npcHasNonGmOwner: out.npcHasNonGmOwner,
      rawHtmlVerbatim: out.rawHtml?.verbatim,
      gmSeesPlayerWhisper: out.gmSeesPlayerWhisper,
      cleanup: out.cleanup,
    },
    'phase-1 post_chat_message probe summary',
  );
  console.error(JSON.stringify(out, null, 2));
  if (!out.cleanup?.restored) {
    log.error('cleanup did NOT restore the message-id set');
    process.exitCode = 1;
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
