/**
 * Phase-1 exploratory probe for dnd5e_request_check. Confirms the dnd5e
 * check-enricher API shape against the live headless Foundry BEFORE the
 * evaluator is written. Throwaway — does not exercise a tool.
 *
 * D&D 5e has no PF2e `@Check[...]` enricher. Modern dnd5e ships
 * `[[/check]]` / `[[/save]]` / `[[/skill]]` / `[[/tool]]` enrichers that
 * render a clickable roll button. The accepted syntax, the anchor class,
 * and whether server-side enrichment as AI-GM keeps the anchor clickable
 * are all unknown until measured here.
 *
 * Questions:
 *   Q1. Which enricher expressions produce a clickable anchor? (try
 *       ability / skill / save / tool variants, keyed and positional.)
 *   Q2. Is `foundry.applications.ux.TextEditor.implementation.enrichHTML`
 *       the working path? Does the output carry an <a> (clickable) or a
 *       stripped <span>? What is the anchor's class?
 *   Q3. What data-* attributes does the enriched anchor carry?
 *   Q4. Does actor.testUserPermission(user, "OWNER") resolve owners+GMs?
 *   Q5. ChatMessage.implementation / getSpeaker behave as in core?
 *   Q6. Does the stored whispered message keep the clickable anchor?
 *   Q7. Is the DC shown in the rendered button, and is there any
 *       DC-visibility toggle in the enricher syntax?
 *
 * Cleans up every ChatMessage it creates.
 *
 *   npm run build && node scripts/probe-dnd5e-request-check-phase1.mjs
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
    const report = {
      system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
    };

    const pc = game.actors?.contents.find((a) => a.type === 'character');
    const baseMsgIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);

    const skillKey = Object.keys(CONFIG?.DND5E?.skills ?? {})[0] ?? 'acr';
    const abilityKey = (CONFIG?.DND5E?.abilities ?? {}).dex ? 'dex' : 'str';
    const toolKey =
      Object.keys(CONFIG?.DND5E?.tools ?? {})[0] ??
      Object.keys(CONFIG?.DND5E?.toolIds ?? {})[0] ??
      'thief';
    report.keysUsed = { skillKey, abilityKey, toolKey };

    // Q2: locate a TextEditor with enrichHTML.
    const fapp = globalThis.foundry?.applications?.ux?.TextEditor;
    const candidates = {
      'foundry.applications.ux.TextEditor.implementation': fapp?.implementation,
      'foundry.applications.ux.TextEditor': fapp,
      'globalThis.TextEditor': globalThis.TextEditor,
    };
    report.candidates = {};
    let TextEditor = null;
    let usedPath = null;
    for (const [path, obj] of Object.entries(candidates)) {
      const has = typeof obj?.enrichHTML === 'function';
      report.candidates[path] = { exists: obj != null, hasEnrichHTML: has };
      if (has && !TextEditor) {
        TextEditor = obj;
        usedPath = path;
      }
    }
    report.usedPath = usedPath;

    const rollData = pc && typeof pc.getRollData === 'function' ? pc.getRollData() : {};

    // Q1/Q3/Q7: enrich a battery of candidate expressions.
    const exprs = [
      `[[/check ability=${abilityKey} dc=15]]`,
      `[[/check skill=${skillKey} dc=15]]`,
      `[[/check ${abilityKey} 15]]`,
      `[[/skill ${skillKey}]]`,
      `[[/skill skill=${skillKey} dc=15]]`,
      `[[/save ability=${abilityKey} dc=15]]`,
      `[[/save ${abilityKey} 15]]`,
      `[[/tool tool=${toolKey} dc=15]]`,
      `[[/tool ${toolKey} 15]]`,
      `[[/check ability=${abilityKey} skill=${skillKey} dc=15]]`,
    ];
    report.enrichTests = [];
    for (const expr of exprs) {
      const entry = { expr };
      if (!TextEditor) {
        entry.error = 'no TextEditor';
        report.enrichTests.push(entry);
        continue;
      }
      try {
        const html = await TextEditor.enrichHTML(expr, { rollData });
        entry.html = html;
        entry.hasAnchor = typeof html === 'string' && /<a\b/.test(html);
        entry.spanOnly = typeof html === 'string' && !/<a\b/.test(html) && /<span\b/.test(html);
        if (typeof html === 'string') {
          entry.anchorClasses = [
            ...new Set([...html.matchAll(/<a[^>]*class="([^"]*)"/gi)].map((m) => m[1])),
          ];
          entry.dataAttrs = [...new Set([...html.matchAll(/data-[a-z0-9-]+/gi)].map((m) => m[0]))];
        }
      } catch (e) {
        entry.error = e?.message ?? String(e);
      }
      report.enrichTests.push(entry);
    }

    // Q4: ownership resolution.
    if (pc) {
      report.pc = { id: pc.id, name: pc.name };
      const owners = game.users?.contents.filter((u) => pc.testUserPermission(u, 'OWNER')) ?? [];
      report.owners = owners.map((u) => ({ id: u.id, name: u.name, isGM: u.isGM }));
    } else {
      report.pc = null;
    }

    // Q5: ChatMessage API.
    report.chatMessage = {
      hasImplementation: globalThis.ChatMessage?.implementation != null,
      implementationName: globalThis.ChatMessage?.implementation?.name ?? null,
      speakerForPc: pc ? globalThis.ChatMessage.getSpeaker({ actor: pc }) : null,
    };

    // Q6: post one whispered message with the first clickable enrichment.
    const firstClickable = report.enrichTests.find((t) => t.hasAnchor);
    if (pc && firstClickable) {
      try {
        const gmIds = game.users?.contents.filter((u) => u.isGM).map((u) => u.id) ?? [];
        const content = `${pc.name}, roll ${firstClickable.html}.`;
        const msg = await globalThis.ChatMessage.implementation.create({
          content,
          speaker: globalThis.ChatMessage.getSpeaker({ actor: pc }),
          whisper: gmIds,
        });
        report.createdMessage = {
          usedExpr: firstClickable.expr,
          id: msg?.id ?? null,
          storedHasAnchor: typeof msg?.content === 'string' && /<a\b/.test(msg.content),
          storedContentSample: typeof msg?.content === 'string' ? msg.content.slice(0, 400) : null,
        };
      } catch (e) {
        report.createError = e?.message ?? String(e);
      }
    }

    // Cleanup.
    const created =
      game.messages?.contents.filter((m) => !baseMsgIds.has(m.id)).map((m) => m.id) ?? [];
    if (created.length > 0) await globalThis.ChatMessage.deleteDocuments(created);
    report.cleanedUpMessages = created.length;

    return report;
  });

  log.info({ out }, 'phase-1 dnd5e_request_check API report');
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
