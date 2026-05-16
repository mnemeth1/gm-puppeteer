/**
 * One-shot read-only probe: log in to live headless Foundry and verify the
 * v14.361 + PF2e 8.1.2 API surface for get_scene_tokens.
 *
 * No mutation, no cleanup. Enumerates scene.tokens.contents on the active
 * scene, dumps the fields the projection surfaces, then exercises the tool
 * handler end-to-end.
 *
 * Questions:
 *   1. scene.tokens.contents — is the collection iterable as `.contents` and
 *      does it survive page.evaluate as a plain array?
 *   2. actorId on unlinked tokens — what is the value when a token has no
 *      backing actor (or actor was deleted)? Probe records the distribution.
 *   3. disposition — is it always a number? what values appear?
 *   4. width/height units — confirm these are grid squares (1 = Medium),
 *      not pixels.
 *   5. Tool handler smoke test — call get_scene_tokens with no args and
 *      with sceneId set explicitly; verify both return ok: true.
 *   6. Negative path — sceneId="doesnotexist" returns SCENE_NOT_FOUND.
 *
 *   npm run build && node scripts/probe-get-scene-tokens.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'get_scene_tokens');
if (!tool) {
  log.error('get_scene_tokens not registered in tools/index.ts — did the build run?');
  process.exit(2);
}

try {
  const { page } = await session.ensureStarted();

  // --- Raw enumeration: answer Q1–Q4 ---
  const enumeration = await page.evaluate(() => {
    const game = globalThis.game;
    const scene = game?.scenes?.active;
    if (!scene) return { reason: 'no active scene' };

    const all = scene.tokens?.contents ?? [];
    const isArray = Array.isArray(all);

    const dispositionCounts = {};
    const actorIdShapes = { string: 0, null: 0, other: 0 };
    const widthHeightValues = new Set();
    const rows = [];

    for (const t of all) {
      const disp = t?.disposition;
      const dispKey = String(disp);
      dispositionCounts[dispKey] = (dispositionCounts[dispKey] ?? 0) + 1;

      const aid = t?.actorId;
      if (typeof aid === 'string') actorIdShapes.string += 1;
      else if (aid === null) actorIdShapes.null += 1;
      else actorIdShapes.other += 1;

      widthHeightValues.add(`${t?.width}x${t?.height}`);

      rows.push({
        id: t?.id ?? null,
        name: t?.name ?? null,
        actorId: aid ?? null,
        actorIdType: typeof aid,
        actorLink: t?.actorLink === true,
        x: t?.x ?? null,
        y: t?.y ?? null,
        width: t?.width ?? null,
        height: t?.height ?? null,
        disposition: disp ?? null,
        hidden: t?.hidden === true,
      });
    }

    return {
      sceneId: scene.id,
      sceneName: scene.name,
      total: all.length,
      contentsIsArray: isArray,
      dispositionCounts,
      actorIdShapes,
      widthHeightValues: Array.from(widthHeightValues).sort(),
      rows,
    };
  });

  log.info(
    {
      sceneId: enumeration.sceneId,
      sceneName: enumeration.sceneName,
      total: enumeration.total,
      contentsIsArray: enumeration.contentsIsArray,
    },
    'Q1: scene.tokens.contents shape',
  );
  log.info({ actorIdShapes: enumeration.actorIdShapes }, 'Q2: actorId shape distribution');
  log.info({ dispositionCounts: enumeration.dispositionCounts }, 'Q3: disposition distribution');
  log.info(
    { widthHeightValues: enumeration.widthHeightValues },
    'Q4: width x height observed (grid squares — 1x1 = Medium)',
  );
  log.info({ rows: enumeration.rows }, 'projection preview (one row per token)');

  // --- Q5a: tool handler with no args (active scene) ---
  const parsed1 = tool.inputSchema.safeParse({});
  if (!parsed1.success) {
    log.error({ issues: parsed1.error.issues }, 'empty input failed schema parse');
    process.exitCode = 1;
  } else {
    const blocks1 = await tool.handler(parsed1.data, { browser: session, log });
    const result1 = JSON.parse(blocks1[0].text);
    log.info(
      {
        ok: result1.ok,
        sceneId: result1.sceneId,
        tokenCount: result1.tokens?.length,
        firstThree: result1.tokens?.slice(0, 3),
      },
      'Q5a: tool handler (no args) result',
    );
  }

  // --- Q5b: tool handler with explicit sceneId ---
  const parsed2 = tool.inputSchema.safeParse({ sceneId: enumeration.sceneId });
  if (!parsed2.success) {
    log.error({ issues: parsed2.error.issues }, 'explicit-sceneId input failed schema parse');
    process.exitCode = 1;
  } else {
    const blocks2 = await tool.handler(parsed2.data, { browser: session, log });
    const result2 = JSON.parse(blocks2[0].text);
    log.info(
      {
        ok: result2.ok,
        sceneId: result2.sceneId,
        tokenCount: result2.tokens?.length,
      },
      'Q5b: tool handler (explicit sceneId) result',
    );
  }

  // --- Q6: negative path ---
  const parsed3 = tool.inputSchema.safeParse({ sceneId: 'doesnotexist' });
  if (!parsed3.success) {
    log.error({ issues: parsed3.error.issues }, 'doesnotexist input failed schema parse');
    process.exitCode = 1;
  } else {
    const blocks3 = await tool.handler(parsed3.data, { browser: session, log });
    const result3 = JSON.parse(blocks3[0].text);
    log.info({ result: result3 }, 'Q6: tool handler with bogus sceneId (expect SCENE_NOT_FOUND)');
    if (result3.ok !== false || result3.error?.code !== 'SCENE_NOT_FOUND') {
      log.error('expected SCENE_NOT_FOUND, got something else');
      process.exitCode = 1;
    }
  }

  if (process.exitCode == null) process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
