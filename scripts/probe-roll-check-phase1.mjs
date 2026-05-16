/**
 * Phase-1 exploratory probe for roll_check. Confirms the PF2e 8.1.2
 * statistic-roll API shape against the live headless Foundry BEFORE
 * the evaluator is written. Throwaway — does not exercise a tool.
 *
 * Questions:
 *   Q1. Does an NPC expose actor.perception / actor.skills[slug] /
 *       actor.saves[slug] as Statistic instances with a .roll method?
 *   Q2. Does Statistic.roll({ skipDialog: true, createMessage: true })
 *       complete WITHOUT hanging on CheckModifiersDialog? (a hang here
 *       means skipDialog did not take — the probe would time out).
 *   Q3. What is on the returned Roll: total, the natural d20, and the
 *       degree-of-success property path?
 *   Q4. What are the keys of CONFIG.ChatMessage.modes (messageMode)?
 *   Q5. Where does the statistic's total check modifier live (.mod /
 *       .check.mod)?
 *
 * Cleans up every ChatMessage it creates.
 *
 *   npm run build && node scripts/probe-roll-check-phase1.mjs
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
    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    const hazard = game.actors?.contents.find((a) => a.type === 'hazard');
    const pc = game.actors?.contents.find((a) => a.type === 'character');

    const baseMsgIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);

    const describeStat = (s) =>
      s == null
        ? null
        : {
            ctor: s.constructor?.name ?? null,
            hasRoll: typeof s.roll === 'function',
            mod: s.mod ?? null,
            checkMod: s.check?.mod ?? null,
            slug: s.slug ?? null,
          };

    const report = {
      npc: npc ? { id: npc.id, name: npc.name, type: npc.type } : null,
      hazard: hazard ? { id: hazard.id, name: hazard.name, type: hazard.type } : null,
      pc: pc ? { id: pc.id, name: pc.name, type: pc.type } : null,
      chatMessageModes: Object.keys(globalThis.CONFIG?.ChatMessage?.modes ?? {}),
    };

    if (npc) {
      report.npcPerception = describeStat(npc.perception);
      report.npcSkillKeys = npc.skills ? Object.keys(npc.skills) : null;
      report.npcAthletics = describeStat(npc.skills?.athletics);
      report.npcSaveKeys = npc.saves ? Object.keys(npc.saves) : null;
      report.npcFortitude = describeStat(npc.saves?.fortitude);
      report.npcGetStatisticAthletics = describeStat(
        typeof npc.getStatistic === 'function' ? npc.getStatistic('athletics') : null,
      );
      report.npcGetStatisticPerception = describeStat(
        typeof npc.getStatistic === 'function' ? npc.getStatistic('perception') : null,
      );

      // Q2/Q3: actually roll perception with skipDialog, DC supplied.
      try {
        const roll = await npc.perception.roll({
          skipDialog: true,
          createMessage: true,
          dc: 15,
        });
        report.perceptionRoll = {
          returnedNull: roll == null,
          ctor: roll?.constructor?.name ?? null,
          total: roll?.total ?? null,
          optionKeys: roll?.options ? Object.keys(roll.options) : null,
          degreeOfSuccess_options: roll?.options?.degreeOfSuccess ?? null,
          degreeOfSuccess_direct: roll?.degreeOfSuccess ?? null,
          firstDie: roll?.dice?.[0]?.results?.[0]?.result ?? null,
          diceCount: Array.isArray(roll?.dice) ? roll.dice.length : null,
        };
      } catch (e) {
        report.perceptionRollError = e?.message ?? String(e);
      }

      // skill roll, no DC
      try {
        const roll = await npc.skills.athletics.roll({
          skipDialog: true,
          createMessage: true,
        });
        report.athleticsRoll = {
          returnedNull: roll == null,
          total: roll?.total ?? null,
          degreeOfSuccess_options: roll?.options?.degreeOfSuccess ?? null,
        };
      } catch (e) {
        report.athleticsRollError = e?.message ?? String(e);
      }

      // gm messageMode roll
      try {
        const roll = await npc.saves.will.roll({
          skipDialog: true,
          createMessage: true,
          messageMode: 'gm',
          dc: 20,
        });
        report.willGmRoll = {
          returnedNull: roll == null,
          total: roll?.total ?? null,
        };
      } catch (e) {
        report.willGmRollError = e?.message ?? String(e);
      }
    }

    if (hazard) {
      report.hazardPerception = describeStat(hazard.perception);
      report.hazardSkillKeys = hazard.skills ? Object.keys(hazard.skills) : null;
      report.hazardSaveKeys = hazard.saves ? Object.keys(hazard.saves) : null;
    }

    // Cleanup: delete every message created during this probe.
    const created =
      game.messages?.contents.filter((m) => !baseMsgIds.has(m.id)).map((m) => m.id) ?? [];
    if (created.length > 0) await globalThis.ChatMessage.deleteDocuments(created);
    report.cleanedUpMessages = created.length;

    return report;
  });

  log.info({ out }, 'phase-1 roll_check API report');
  console.error(JSON.stringify(out, null, 2));
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
