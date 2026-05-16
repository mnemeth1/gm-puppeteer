/**
 * Phase-1 exploratory probe for request_check. Confirms the v14 +
 * PF2e 8.1.2 text-enrichment API shape BEFORE the evaluator is
 * written. Throwaway — does not exercise a tool.
 *
 * Questions:
 *   Q1. Which global path exposes a working `enrichHTML`?
 *       - foundry.applications.ux.TextEditor.implementation
 *       - foundry.applications.ux.TextEditor
 *       - globalThis.TextEditor
 *   Q2. Is enrichHTML async? Does enriching "@Check[perception|dc:20|
 *       showDC:gm]" yield an <a class="inline-check"> anchor (a real
 *       clickable button) rather than literal text or a stripped span?
 *   Q3. What data-* attributes does the enriched anchor carry?
 *   Q4. Does actor.testUserPermission(user, "OWNER") resolve owners?
 *   Q5. ChatMessage.implementation vs ChatMessage; getSpeaker shape.
 *
 * Cleans up any ChatMessage it creates.
 *
 *   npm run build && node scripts/probe-request-check-phase1.mjs
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
    const pc = game.actors?.contents.find((a) => a.type === 'character');
    const baseMsgIds = new Set(game.messages?.contents.map((m) => m.id) ?? []);

    const expr = '@Check[perception|dc:20|showDC:gm]';
    const report = { expr };

    // Q1: locate a TextEditor with enrichHTML.
    const fapp = globalThis.foundry?.applications?.ux?.TextEditor;
    const candidates = {
      'foundry.applications.ux.TextEditor.implementation': fapp?.implementation,
      'foundry.applications.ux.TextEditor': fapp,
      'globalThis.TextEditor': globalThis.TextEditor,
    };
    report.candidates = {};
    for (const [path, obj] of Object.entries(candidates)) {
      report.candidates[path] = {
        exists: obj != null,
        hasEnrichHTML: typeof obj?.enrichHTML === 'function',
      };
    }

    // Q2/Q3: enrich via the first working candidate.
    let enriched = null;
    let usedPath = null;
    for (const [path, obj] of Object.entries(candidates)) {
      if (typeof obj?.enrichHTML !== 'function') continue;
      try {
        const html = await obj.enrichHTML(expr, {
          rollData: pc ? pc.getRollData() : {},
        });
        enriched = html;
        usedPath = path;
        break;
      } catch (e) {
        report[`enrichError_${path}`] = e?.message ?? String(e);
      }
    }
    report.usedPath = usedPath;
    report.enrichedHtml = enriched;
    report.hasInlineCheckAnchor =
      typeof enriched === 'string' && /<a[^>]*class="[^"]*inline-check/.test(enriched);
    report.hasAnchorTag = typeof enriched === 'string' && /<a\b/.test(enriched);
    report.hasSpanOnly =
      typeof enriched === 'string' && !/<a\b/.test(enriched) && /<span\b/.test(enriched);
    if (typeof enriched === 'string') {
      const dataAttrs = [...enriched.matchAll(/data-[a-z0-9-]+/gi)].map((m) => m[0]);
      report.dataAttrs = [...new Set(dataAttrs)];
    }

    // Q4: ownership resolution.
    if (pc) {
      report.pc = { id: pc.id, name: pc.name };
      const owners = game.users?.contents.filter((u) => pc.testUserPermission(u, 'OWNER')) ?? [];
      report.owners = owners.map((u) => ({ id: u.id, name: u.name, isGM: u.isGM }));
      report.ownershipRaw = pc.ownership;
    }

    // Q5: ChatMessage API.
    report.chatMessage = {
      hasImplementation: globalThis.ChatMessage?.implementation != null,
      implementationName: globalThis.ChatMessage?.implementation?.name ?? null,
      speakerForPc: pc ? globalThis.ChatMessage.getSpeaker({ actor: pc }) : null,
    };

    // Actually create a whispered message and read back its stored content.
    if (pc && enriched) {
      try {
        const gmIds = game.users?.contents.filter((u) => u.isGM).map((u) => u.id) ?? [];
        const msg = await globalThis.ChatMessage.implementation.create({
          content: enriched,
          speaker: globalThis.ChatMessage.getSpeaker({ actor: pc }),
          whisper: gmIds,
        });
        report.createdMessage = {
          id: msg?.id ?? null,
          storedHasAnchor: typeof msg?.content === 'string' && /<a\b/.test(msg.content),
          storedContentSample:
            typeof msg?.content === 'string' ? msg.content.slice(0, 240) : null,
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

  log.info({ out }, 'phase-1 request_check API report');
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
