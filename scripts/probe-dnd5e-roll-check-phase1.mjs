/**
 * Phase-1 exploratory probe for dnd5e_roll_check. Confirms the dnd5e
 * roll-pipeline API shape against the live headless Foundry BEFORE the
 * evaluator is written. Throwaway — does not exercise a tool.
 *
 * D&D 5e has no PF2e `Statistic` class; checks are rolled by methods on
 * the actor. The names, argument shapes, and dialog-bypass differ by
 * dnd5e major version, so nothing here is assumed — the probe records
 * what the live world actually does.
 *
 * Questions:
 *   Q1. Which roll methods does an NPC expose? (rollAbilityCheck /
 *       rollSkill / rollSavingThrow / rollAbilitySave / rollToolCheck /
 *       rollAbilityTest — and their legacy aliases.)
 *   Q2. What argument shape works — the (config, dialog, message) triad
 *       of modern dnd5e, or a flat (key, options) form?
 *   Q3. Which invocation bypasses the roll-config dialog WITHOUT hanging
 *       the headless client? Every candidate is raced against an 8s
 *       timeout so a hang is recorded as `timedOut`, never wedged.
 *   Q4. What does a roll return — a single D20Roll, an array, a
 *       ChatMessage? Where are total / the natural d20?
 *   Q5. How is a target DC passed, and how is success/failure recovered
 *       (a native flag on the roll/message, or computed total >= dc)?
 *   Q6. Does the roll post a chat card, and is its id on the return or
 *       recovered via a game.messages.size diff?
 *   Q7. What rollMode values move a roll public / gm / blind?
 *   Q8. CONFIG.DND5E.skills / .abilities / tool key inventories.
 *   Q9. Which actor types support the roll methods (npc yes; vehicle /
 *       group rejected)?
 *
 * Cleans up every ChatMessage it creates.
 *
 *   npm run build && node scripts/probe-dnd5e-roll-check-phase1.mjs
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
    const CONFIG = globalThis.CONFIG;
    const CONST = globalThis.CONST;
    const report = {
      system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
    };

    const baseMsgIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);

    const npc = game.actors?.contents.find((a) => a.type === 'npc');
    const pc = game.actors?.contents.find((a) => a.type === 'character');
    const other = game.actors?.contents.find(
      (a) => a.type !== 'npc' && a.type !== 'character',
    );
    report.actors = {
      npc: npc ? { id: npc.id, name: npc.name, type: npc.type } : null,
      pc: pc ? { id: pc.id, name: pc.name, type: pc.type } : null,
      other: other ? { id: other.id, name: other.name, type: other.type } : null,
      allTypes: [...new Set(game.actors?.contents.map((a) => a.type) ?? [])],
    };

    // Q8: config inventories.
    report.config = {
      skillKeys: Object.keys(CONFIG?.DND5E?.skills ?? {}),
      abilityKeys: Object.keys(CONFIG?.DND5E?.abilities ?? {}),
      toolKeys: Object.keys(CONFIG?.DND5E?.tools ?? {}),
      toolIdsSample: Object.keys(CONFIG?.DND5E?.toolIds ?? {}).slice(0, 12),
      diceRollModes: CONST?.DICE_ROLL_MODES ?? null,
    };

    if (!npc) {
      report.aborted = 'no npc actor in world';
      return report;
    }

    // Q1: roll-method existence on the NPC.
    const methodNames = [
      'rollAbilityCheck',
      'rollAbilityTest',
      'rollSkill',
      'rollSavingThrow',
      'rollAbilitySave',
      'rollToolCheck',
      'rollInitiative',
    ];
    report.npcMethods = {};
    for (const m of methodNames) report.npcMethods[m] = typeof npc[m];

    // NPC's own stat keys, to confirm the key space matches CONFIG.
    report.npcSystem = {
      skillKeys: Object.keys(npc.system?.skills ?? {}),
      abilityKeys: Object.keys(npc.system?.abilities ?? {}),
      toolKeys: Object.keys(npc.system?.tools ?? {}),
    };

    const skillKey = report.npcSystem.skillKeys[0] ?? 'acr';
    const abilityKey = report.npcSystem.abilityKeys.includes('dex')
      ? 'dex'
      : (report.npcSystem.abilityKeys[0] ?? 'dex');

    // -- Helpers ------------------------------------------------------
    const withTimeout = (p, ms) =>
      Promise.race([
        Promise.resolve(p)
          .then((v) => ({ settled: true, value: v }))
          .catch((e) => ({ settled: true, error: e?.message ?? String(e) })),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), ms)),
      ]);

    const describeRoll = (val) => {
      const one = Array.isArray(val) ? val[0] : val;
      return {
        returnIsArray: Array.isArray(val),
        returnLength: Array.isArray(val) ? val.length : null,
        returnCtor: val?.constructor?.name ?? null,
        innerCtor: one?.constructor?.name ?? null,
        total: one?.total ?? null,
        firstDie: one?.dice?.[0]?.results?.[0]?.result ?? null,
        isSuccess: one?.isSuccess ?? null,
        isFailure: one?.isFailure ?? null,
        optionKeys: one?.options ? Object.keys(one.options) : null,
        optionsTarget: one?.options?.target ?? null,
      };
    };

    const tryRoll = async (label, invoke) => {
      const before = game.messages?.size ?? 0;
      let raced;
      try {
        raced = await withTimeout(invoke(), 8000);
      } catch (e) {
        return { label, threwSync: e?.message ?? String(e) };
      }
      const after = game.messages?.size ?? 0;
      const msgDelta = after - before;
      let lastMsgFlags = null;
      if (msgDelta > 0) {
        const last = game.messages?.contents[game.messages.contents.length - 1];
        lastMsgFlags = {
          flagKeys: last?.flags ? Object.keys(last.flags) : null,
          dnd5eFlagKeys: last?.flags?.dnd5e ? Object.keys(last.flags.dnd5e) : null,
          rolls: Array.isArray(last?.rolls) ? last.rolls.length : null,
          whisperLen: Array.isArray(last?.whisper) ? last.whisper.length : null,
        };
      }
      if (raced.timedOut) return { label, timedOut: true, msgDelta };
      if (raced.error) return { label, threw: raced.error, msgDelta, lastMsgFlags };
      return { label, ok: true, msgDelta, lastMsgFlags, ...describeRoll(raced.value) };
    };

    // Q2/Q3/Q4/Q5: skill-check invocation shapes.
    report.skillAttempts = [];
    report.skillAttempts.push(
      await tryRoll('skill triad {skill} +configure:false', () =>
        npc.rollSkill({ skill: skillKey }, { configure: false }, {}),
      ),
    );
    report.skillAttempts.push(
      await tryRoll('skill triad {skill,target:15}', () =>
        npc.rollSkill({ skill: skillKey, target: 15 }, { configure: false }, {}),
      ),
    );
    report.skillAttempts.push(
      await tryRoll('skill flat (key,{chooseModifier,fastForward})', () =>
        npc.rollSkill(skillKey, { chooseModifier: false, fastForward: true }),
      ),
    );

    // Q2/Q3: ability check.
    report.abilityAttempts = [];
    if (typeof npc.rollAbilityCheck === 'function') {
      report.abilityAttempts.push(
        await tryRoll('rollAbilityCheck triad {ability}', () =>
          npc.rollAbilityCheck({ ability: abilityKey }, { configure: false }, {}),
        ),
      );
    }
    if (typeof npc.rollAbilityTest === 'function') {
      report.abilityAttempts.push(
        await tryRoll('rollAbilityTest flat (key,{fastForward})', () =>
          npc.rollAbilityTest(abilityKey, { fastForward: true, chooseModifier: false }),
        ),
      );
    }

    // Q2/Q3: saving throw.
    report.saveAttempts = [];
    if (typeof npc.rollSavingThrow === 'function') {
      report.saveAttempts.push(
        await tryRoll('rollSavingThrow triad {ability,target:12}', () =>
          npc.rollSavingThrow({ ability: abilityKey, target: 12 }, { configure: false }, {}),
        ),
      );
    }
    if (typeof npc.rollAbilitySave === 'function') {
      report.saveAttempts.push(
        await tryRoll('rollAbilitySave flat (key,{fastForward})', () =>
          npc.rollAbilitySave(abilityKey, { fastForward: true }),
        ),
      );
    }

    // Q2/Q3: tool check.
    report.toolAttempts = [];
    const npcToolKey = report.npcSystem.toolKeys[0] ?? null;
    const cfgToolKey = report.config.toolKeys[0] ?? report.config.toolIdsSample[0] ?? null;
    const toolKey = npcToolKey ?? cfgToolKey;
    report.toolKeyUsed = { npcToolKey, cfgToolKey, toolKey };
    if (typeof npc.rollToolCheck === 'function' && toolKey) {
      report.toolAttempts.push(
        await tryRoll('rollToolCheck triad {tool}', () =>
          npc.rollToolCheck({ tool: toolKey }, { configure: false }, {}),
        ),
      );
      report.toolAttempts.push(
        await tryRoll('rollToolCheck flat (key,{fastForward})', () =>
          npc.rollToolCheck(toolKey, { fastForward: true }),
        ),
      );
    }

    // Q7: rollMode — roll a skill whispered to GMs, inspect the message.
    report.rollModeAttempt = await tryRoll('skill triad gmroll message', () =>
      npc.rollSkill({ skill: skillKey }, { configure: false }, { rollMode: 'gmroll' }),
    );

    // Q9: actor-type support — does the PC / other actor expose the methods?
    report.typeSupport = {
      pc: pc ? { rollSkill: typeof pc.rollSkill } : null,
      other: other ? { type: other.type, rollSkill: typeof other.rollSkill } : null,
    };

    // Cleanup: delete every message created during this probe.
    const created =
      game.messages?.contents.filter((m) => !baseMsgIds.has(m.id)).map((m) => m.id) ?? [];
    if (created.length > 0) await globalThis.ChatMessage.deleteDocuments(created);
    report.cleanedUpMessages = created.length;

    return report;
  });

  log.info({ out }, 'phase-1 dnd5e_roll_check API report');
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
