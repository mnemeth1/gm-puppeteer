/**
 * Exploratory probe for the D&D 5e branch of get_chat_messages. Confirms
 * the dnd5e ChatMessage shape (5.3.3 / Foundry v14.361) BEFORE the
 * parseDnd5eCard projection is finalized. Throwaway — exercises no tool.
 *
 * D&D 5e splits one action across a roll-less *usage* card plus separate
 * *roll* messages joined by `flags.dnd5e.originatingMessage`, and never
 * bakes an outcome into the message. Questions:
 *
 *   Q3. A roll made with ADVANTAGE: dump `rolls[0].dice[0].results` —
 *       two results, only the kept one `active`. Confirms how the parser
 *       must pick the natural d20.
 *   Q4. Are `rolls[0].options` / `rolls[0].dice` populated on the LIVE
 *       `message.rolls` getter (not only the serialized `_source.rolls`)?
 *   Q5. Where the save DC lives — on `flags.dnd5e.activity` of the
 *       originating usage card, recoverable from the activity document
 *       via its uuid, or only as `data-dc` HTML. Decides the
 *       originatingMessage join in parseDnd5eCard.
 *   Q6. Exact `flags.dnd5e.roll.type` strings for save / ability check /
 *       skill check / tool check rolls.
 *
 * Scans the existing log for one of each dnd5e card kind (initiative,
 * usage card, attack roll, damage roll, save roll) and dumps it; then
 * generates skill / ability / save / tool / advantage rolls for Q3/Q6.
 * Deletes every message it creates and asserts the id set is restored.
 *
 *   npm run build && node scripts/probe-chat-messages-dnd5e.mjs
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
    const fromUuid = globalThis.fromUuid;
    const report = {
      system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
    };
    const baselineIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);

    // -- Bounded description of one ChatMessage, dnd5e-focused.
    const describe = (m) => {
      if (!m) return null;
      const src = typeof m.toObject === 'function' ? m.toObject() : {};
      const safe = (fn) => {
        try {
          return fn();
        } catch (e) {
          return `<<${String(e)}>>`;
        }
      };
      const rollsLive = safe(() =>
        (m.rolls ?? []).map((r) => ({
          class: r?.constructor?.name ?? null,
          total: r?.total ?? null,
          formula: r?.formula ?? null,
          options: r?.options ?? null,
          diceResults: (r?.dice ?? []).map((d) => ({
            faces: d?.faces ?? null,
            results: d?.results ?? null,
          })),
        })),
      );
      return {
        id: m.id,
        flavor: typeof src.flavor === 'string' ? src.flavor.slice(0, 120) : src.flavor,
        sourceType: src.type ?? null,
        isRoll: safe(() => m.isRoll ?? null),
        flagsCore: src.flags?.core ?? null,
        flagsDnd5e: src.flags?.dnd5e ?? null,
        rollsLiveCount: Array.isArray(m.rolls) ? m.rolls.length : null,
        rollsLive,
        contentSample: typeof src.content === 'string' ? src.content.slice(0, 600) : src.content,
      };
    };

    // -- Scan the existing log for one of each dnd5e card kind.
    const existing = game.messages?.contents ?? [];
    report.existingCount = existing.length;
    const found = {
      initiative: null,
      usageAttack: null,
      usageSave: null,
      rollAttack: null,
      rollDamage: null,
      rollSave: null,
    };
    const rollTypesSeen = {};
    for (const m of existing) {
      const dnd = m.flags?.dnd5e;
      if (m.flags?.core?.initiativeRoll === true && !found.initiative) {
        found.initiative = m;
        continue;
      }
      if (!dnd) continue;
      if (dnd.messageType === 'roll' && dnd.roll?.type) {
        rollTypesSeen[dnd.roll.type] = (rollTypesSeen[dnd.roll.type] ?? 0) + 1;
        if (dnd.roll.type === 'attack' && !found.rollAttack) found.rollAttack = m;
        if (dnd.roll.type === 'damage' && !found.rollDamage) found.rollDamage = m;
        if (dnd.roll.type === 'save' && !found.rollSave) found.rollSave = m;
      } else if (!dnd.messageType && dnd.activity) {
        if (dnd.activity.type === 'attack' && !found.usageAttack) found.usageAttack = m;
        if (dnd.activity.type === 'save' && !found.usageSave) found.usageSave = m;
      }
    }
    report.rollTypesSeenInLog = rollTypesSeen;
    report.existingCards = {};
    for (const [k, v] of Object.entries(found)) report.existingCards[k] = describe(v);

    // -- Q5: where the save DC lives. Resolve the save activity from its
    // uuid and dump its `save` config; also scan the usage card HTML.
    report.q5_saveDc = {};
    const usageSave = found.usageSave;
    if (usageSave) {
      const activityUuid = usageSave.flags?.dnd5e?.activity?.uuid ?? null;
      report.q5_saveDc.activityUuid = activityUuid;
      report.q5_saveDc.usageFlagsDnd5e = usageSave.flags?.dnd5e ?? null;
      const html = typeof usageSave.content === 'string' ? usageSave.content : '';
      const dcMatch = html.match(/data-dc="([^"]*)"/);
      report.q5_saveDc.htmlDataDc = dcMatch ? dcMatch[1] : null;
      if (activityUuid && typeof fromUuid === 'function') {
        try {
          const activity = await fromUuid(activityUuid);
          report.q5_saveDc.activityResolved = !!activity;
          report.q5_saveDc.activityType = activity?.type ?? null;
          report.q5_saveDc.activitySave = activity?.save ?? null;
          report.q5_saveDc.activitySaveDcValue = activity?.save?.dc?.value ?? null;
        } catch (e) {
          report.q5_saveDc.activityError = String(e);
        }
      }
    } else {
      report.q5_saveDc.note = 'no save-activity usage card in the log to inspect';
    }

    // -- Q3/Q6: generate skill / ability / save / tool / advantage rolls.
    const withTimeout = (p, ms) =>
      Promise.race([
        Promise.resolve(p)
          .then(() => ({ settled: true }))
          .catch((e) => ({ settled: true, error: e?.message ?? String(e) })),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), ms)),
      ]);

    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    report.npc = npc ? { id: npc.id, name: npc.name } : null;
    report.generatedRolls = [];

    const genRoll = async (label, invoke) => {
      const before = game.messages?.size ?? 0;
      const raced = await withTimeout(invoke(), 8000);
      const after = game.messages?.size ?? 0;
      let card = null;
      if (after > before) {
        const last = game.messages?.contents[game.messages.contents.length - 1];
        card = describe(last);
      }
      report.generatedRolls.push({ label, ...raced, msgDelta: after - before, card });
    };

    if (npc) {
      const abilityKeys = Object.keys(npc.system?.abilities ?? {});
      const skillKeys = Object.keys(npc.system?.skills ?? {});
      const toolKeys = Object.keys(npc.system?.tools ?? {});
      const abilityKey = abilityKeys.includes('dex') ? 'dex' : (abilityKeys[0] ?? 'dex');
      const skillKey = skillKeys[0] ?? 'prc';
      report.npcStatKeys = { abilityKeys, skillKeys, toolKeys, abilityKey, skillKey };

      if (typeof npc.rollSavingThrow === 'function') {
        await genRoll('save', () =>
          npc.rollSavingThrow({ ability: abilityKey }, { configure: false }, {}),
        );
      }
      if (typeof npc.rollAbilityCheck === 'function') {
        await genRoll('abilityCheck', () =>
          npc.rollAbilityCheck({ ability: abilityKey }, { configure: false }, {}),
        );
      }
      if (typeof npc.rollSkill === 'function') {
        await genRoll('skill', () => npc.rollSkill({ skill: skillKey }, { configure: false }, {}));
        // Q3: advantage — two d20 results, one kept.
        await genRoll('skill+advantage', () =>
          npc.rollSkill({ skill: skillKey, advantage: true }, { configure: false }, {}),
        );
      }
      if (typeof npc.rollToolCheck === 'function' && toolKeys[0]) {
        await genRoll('toolCheck', () =>
          npc.rollToolCheck({ tool: toolKeys[0] }, { configure: false }, {}),
        );
      }
    }

    // -- Cleanup: delete everything this probe created.
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
      system: out.system,
      existingCount: out.existingCount,
      rollTypesSeenInLog: out.rollTypesSeenInLog,
      generatedRollTypes: out.generatedRolls?.map((g) => ({
        label: g.label,
        rollType: g.card?.flagsDnd5e?.roll?.type ?? null,
        timedOut: g.timedOut ?? false,
      })),
      cleanup: out.cleanup,
    },
    'dnd5e get_chat_messages probe summary',
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
