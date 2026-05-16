/**
 * Phase-1 exploratory probe for get_chat_messages. Confirms the v14.361 +
 * PF2e 8.1.2 ChatMessage document shape and PF2e card flags BEFORE the
 * get-chat-messages projection is written. Throwaway — does not exercise
 * a tool.
 *
 * Questions:
 *   Q1. v14 author field. `ChatMessage#author` getter vs the stored
 *       `_source.author` / legacy `_source.user`. Is the getter a User
 *       document and the source field a plain id string?
 *   Q2. Speaker shape `{actor, alias, token, scene}`; timestamp vs
 *       `_stats.createdTime`.
 *   Q3. content (stored HTML), whisper (string[] user ids), blind flag.
 *   Q4. rolls — stored shape in `_source.rolls` (serialized) vs the live
 *       `message.rolls` getter; how to read a total; `isRoll`.
 *   Q5. v14 `type` (string) vs legacy numeric `style`; dump
 *       CONST.CHAT_MESSAGE_STYLES.
 *   Q6. PF2e card flags. Dump `flags.pf2e` in full for a real check
 *       message and a real damage message — `flags.pf2e.context`
 *       (type, dc, outcome, domains, options), damage detection, the
 *       per-type damage breakdown inside the serialized DamageRoll,
 *       appliedDamage / origin.
 *   Q7. A non-PF2e message (a plain narration) lacks `flags.pf2e.context`
 *       — confirms the kind:"other" fallback branch.
 *
 * The probe scans existing messages first; if the world carries no
 * check / damage card it generates them (an NPC perception roll; an NPC
 * strike's damage), dumps them, and deletes everything it created.
 *
 *   npm run build && node scripts/probe-chat-messages-phase1.mjs
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
    const report = { generated: [] };

    // -- A safe, bounded description of one ChatMessage.
    const describe = (m) => {
      const src = typeof m.toObject === 'function' ? m.toObject() : {};
      let rollsLive = [];
      try {
        rollsLive = (m.rolls ?? []).map((r) => ({
          class: r?.constructor?.name ?? null,
          total: r?.total ?? null,
          formula: r?.formula ?? null,
        }));
      } catch (e) {
        rollsLive = [{ error: String(e) }];
      }
      // _source.rolls entries are JSON strings in v12+ — parse for the
      // full serialized Roll (terms / instances / options).
      let rollsParsed = null;
      try {
        rollsParsed = (src.rolls ?? []).map((r) =>
          typeof r === 'string' ? JSON.parse(r) : r,
        );
      } catch (e) {
        rollsParsed = [{ parseError: String(e) }];
      }
      const safeGetter = (fn) => {
        try {
          return fn();
        } catch (e) {
          return `<<${String(e)}>>`;
        }
      };
      return {
        id: m.id,
        authorGetter: safeGetter(() =>
          m.author ? { id: m.author.id ?? null, name: m.author.name ?? null } : null,
        ),
        sourceAuthor: src.author ?? null,
        sourceUser: src.user ?? null,
        isRoll: safeGetter(() => m.isRoll ?? null),
        isDamageRoll: safeGetter(() => m.isDamageRoll ?? null),
        isCheckRoll: safeGetter(() => m.isCheckRoll ?? null),
        sourceType: src.type ?? null,
        sourceStyle: src.style ?? null,
        speaker: src.speaker ?? null,
        timestamp: src.timestamp ?? null,
        stats: src._stats ?? null,
        whisper: src.whisper ?? null,
        blind: src.blind ?? null,
        visible: safeGetter(() => m.visible ?? null),
        contentSample:
          typeof src.content === 'string' ? src.content.slice(0, 400) : src.content,
        flavorSample:
          typeof src.flavor === 'string' ? src.flavor.slice(0, 200) : src.flavor,
        rollsLive,
        rollsParsed,
        flagKeys: src.flags ? Object.keys(src.flags) : [],
        flagsPf2e: src.flags?.pf2e ?? null,
      };
    };

    // -- Q5: chat-message style/type constants.
    report.constants = {
      CHAT_MESSAGE_STYLES: globalThis.CONST?.CHAT_MESSAGE_STYLES ?? null,
      CHAT_MESSAGE_TYPES: globalThis.CONST?.CHAT_MESSAGE_TYPES ?? null,
      documentClassName: globalThis.CONFIG?.ChatMessage?.documentClass?.name ?? null,
    };

    // -- Survey existing messages for pf2e cards.
    const existing = game.messages?.contents ?? [];
    report.existingCount = existing.length;
    const pf2eContextTypes = {};
    let existingCheck = null;
    let existingDamage = null;
    let existingPlain = null;
    for (const m of existing) {
      const ctx = m.flags?.pf2e?.context;
      if (ctx?.type) {
        pf2eContextTypes[ctx.type] = (pf2eContextTypes[ctx.type] ?? 0) + 1;
        if (!existingDamage && ctx.type === 'damage-roll') existingDamage = m;
        if (!existingCheck && ctx.type !== 'damage-roll') existingCheck = m;
      } else if (!existingPlain && !m.isRoll) {
        existingPlain = m;
      }
    }
    report.pf2eContextTypesSeen = pf2eContextTypes;

    // -- Last 3 messages, raw shape.
    report.recentMessages = existing.slice(-3).map(describe);

    // -- Generate a check card if none exists: an NPC perception roll.
    let check = existingCheck;
    if (!check) {
      const npc = game.actors?.contents.find(
        (a) => a.type === 'npc' && a.perception?.roll,
      );
      if (npc) {
        try {
          await npc.perception.roll({ skipDialog: true, createMessage: true, dc: 18 });
          const created = (game.messages?.contents ?? []).filter(
            (m) => !baselineIds.has(m.id),
          );
          check = created[created.length - 1] ?? null;
          if (check) report.generated.push(check.id);
        } catch (e) {
          report.checkGenError = String(e);
        }
      } else {
        report.checkGenError = 'no NPC with a perception statistic';
      }
    }
    report.checkCard = check ? describe(check) : null;
    report.checkCardSource = check ? 'existing' : 'none';
    if (check && !existingCheck) report.checkCardSource = 'generated';

    // -- Generate a damage card if none exists: an NPC strike's damage.
    let damage = existingDamage;
    if (!damage) {
      const npc = game.actors?.contents.find(
        (a) => a.type === 'npc' && Array.isArray(a.system?.actions) && a.system.actions.length,
      );
      const strike = npc?.system?.actions?.find((s) => s.type === 'strike' && s.damage);
      if (strike) {
        try {
          await strike.damage({ event: new MouseEvent('click', { shiftKey: true }) });
          const created = (game.messages?.contents ?? []).filter(
            (m) => !baselineIds.has(m.id),
          );
          damage = created[created.length - 1] ?? null;
          if (damage && !report.generated.includes(damage.id)) {
            report.generated.push(damage.id);
          }
        } catch (e) {
          report.damageGenError = String(e);
        }
      } else {
        report.damageGenError = 'no NPC with a strike action';
      }
    }
    report.damageCard = damage ? describe(damage) : null;
    report.damageCardSource = existingDamage ? 'existing' : damage ? 'generated' : 'none';

    // -- Q7: a plain (non-roll, non-pf2e-card) message. Generate one.
    let plain = existingPlain;
    if (!plain) {
      try {
        const msg = await ChatMessageCls.implementation.create({
          content: '<p>Probe plain narration message.</p>',
        });
        plain = msg ?? null;
        if (plain) report.generated.push(plain.id);
      } catch (e) {
        report.plainGenError = String(e);
      }
    }
    report.plainCard = plain ? describe(plain) : null;

    // -- Cleanup: delete everything this probe created.
    const created = (game.messages?.contents ?? [])
      .filter((m) => !baselineIds.has(m.id))
      .map((m) => m.id);
    if (created.length > 0) await ChatMessageCls.deleteDocuments(created);
    const finalIds = new Set((game.messages?.contents ?? []).map((m) => m.id));
    report.cleanup = {
      deleted: created.length,
      restored:
        finalIds.size === baselineIds.size &&
        [...baselineIds].every((id) => finalIds.has(id)),
    };

    return report;
  });

  log.info(
    {
      existingCount: out.existingCount,
      pf2eContextTypesSeen: out.pf2eContextTypesSeen,
      checkCardSource: out.checkCardSource,
      damageCardSource: out.damageCardSource,
      cleanup: out.cleanup,
    },
    'phase-1 get_chat_messages probe summary',
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
