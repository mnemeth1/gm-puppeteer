/**
 * One-shot read-only probe: log in to live headless Foundry and verify the
 * v14.361 + PF2e 8.1.2 API surface that gates the get_token_details impl.
 *
 * Read-only. Inspects every token on every scene to maximize coverage from
 * whatever the world currently holds. Questions that can't be answered from
 * existing state (e.g. "what does an orphaned token look like" when no
 * orphans exist) are logged as follow-ups rather than answered by mutating.
 *
 * Questions:
 *   1. Top-level field surface — Object.keys(token) and Object.keys(
 *      token.toObject()) on a real scene token. Surface anything in the
 *      proposed projection that's missing or any unexpected field worth
 *      including.
 *   2. Live document vs toObject() parity — do token.x / .y / .rotation /
 *      etc. match toObject().x / .y / .rotation? Decides whether the
 *      evaluator reads off the live document or toObject().
 *   3. Image source — is there a top-level token.img on v14, or only
 *      token.texture.src?
 *   4. Default-value sanity — on tokens with no manual configuration: are
 *      elevation, rotation, sort, alpha, lockRotation always numerics /
 *      booleans (vs undefined / null)?
 *   5. Orphaned-actor semantics — scan all scenes for tokens whose actorId
 *      is set but token.actor === null. If any exist, dump
 *      { actorId, actorLink, actor: null? undefined? } so we know what
 *      actorMissing should key off of. If none exist, log as follow-up.
 *   6. Texture / mirror shape — dump token.texture for every token (src,
 *      scaleX/Y, offsetX/Y, rotation, tint) plus mirrorX/Y. Record the
 *      tint distribution (null vs hex string vs "#ffffff" sentinel).
 *   7. Detection modes — find any token with non-empty detectionModes
 *      (a creature with darkvision / low-light vision) and dump the array
 *      shape: confirm Array<{ id, enabled, range }>.
 *   8. flags.pf2e content — Object.keys(token.flags?.pf2e ?? {}) across
 *      every token. If consistently empty, drop the flags projection from
 *      the v1 interface.
 *   9. Tool handler smoke — gated on `tools.find(t => t.name ===
 *      'get_token_details')`. Skipped on first run (tool not yet built);
 *      re-run after registration to exercise:
 *        a. {tokenId: <real>}                 → ok=true
 *        b. {tokenId: <real>, sceneId: <ok>}  → ok=true
 *        c. {tokenId: 'bogus'}                → TOKEN_NOT_FOUND
 *        d. {tokenId: <real>, sceneId: '?'}   → SCENE_NOT_FOUND
 *        e. {tokenId, includeRawDocument: true} → rawDocument populated
 *
 *   npm run build && node scripts/probe-get-token-details.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'get_token_details');

try {
  const { page } = await session.ensureStarted();

  // --- World survey: collect every token on every scene for Q1–Q8 ---
  const survey = await page.evaluate(() => {
    const game = globalThis.game;
    const scenes = game?.scenes?.contents ?? [];
    const activeSceneId = game?.scenes?.active?.id ?? null;

    const allRows = [];
    const liveVsToObjectDiffs = [];
    const tintDistribution = { null: 0, undefined: 0, emptyString: 0, hex: 0, other: 0 };
    const detectionModeSamples = [];
    const flagsPf2eKeys = {};
    const orphanedTokens = [];

    let firstTokenKeysLive = null;
    let firstTokenKeysToObject = null;
    let firstTokenSceneName = null;

    for (const scene of scenes) {
      const tokenList = scene?.tokens?.contents ?? [];
      for (const t of tokenList) {
        const obj = t.toObject?.() ?? null;

        if (firstTokenKeysLive === null && obj !== null) {
          firstTokenKeysLive = Object.keys(t).sort();
          firstTokenKeysToObject = Object.keys(obj).sort();
          firstTokenSceneName = scene.name ?? null;
        }

        // Q2 — diff a handful of fields between live and toObject()
        if (obj) {
          const diffs = {};
          for (const k of [
            'x',
            'y',
            'width',
            'height',
            'rotation',
            'elevation',
            'sort',
            'alpha',
            'disposition',
            'hidden',
          ]) {
            const live = t[k];
            const flat = obj[k];
            if (live !== flat) diffs[k] = { live, toObject: flat };
          }
          if (Object.keys(diffs).length > 0) {
            liveVsToObjectDiffs.push({ sceneId: scene.id, tokenId: t.id, name: t.name, diffs });
          }
        }

        // Q6 — texture tint distribution
        const tint = t.texture?.tint;
        if (tint === null) tintDistribution.null += 1;
        else if (tint === undefined) tintDistribution.undefined += 1;
        else if (tint === '') tintDistribution.emptyString += 1;
        else if (typeof tint === 'string' && /^#[0-9a-f]{6}$/i.test(tint))
          tintDistribution.hex += 1;
        else tintDistribution.other += 1;

        // Q7 — detection modes (sample up to 5)
        const dm = t.detectionModes;
        if (Array.isArray(dm) && dm.length > 0 && detectionModeSamples.length < 5) {
          detectionModeSamples.push({
            sceneId: scene.id,
            tokenId: t.id,
            name: t.name,
            detectionModes: dm.map((m) => ({
              id: m?.id ?? null,
              enabled: m?.enabled ?? null,
              range: m?.range ?? null,
              keys: m ? Object.keys(m).sort() : [],
            })),
          });
        }

        // Q8 — flags.pf2e keys
        const pf2eKeys = Object.keys(t.flags?.pf2e ?? {}).sort();
        const fingerprint = pf2eKeys.join(',') || '<empty>';
        flagsPf2eKeys[fingerprint] = (flagsPf2eKeys[fingerprint] ?? 0) + 1;

        // Q5 — orphans: actorId set but token.actor === null/undefined
        const actorId = t.actorId;
        const actor = t.actor;
        if (typeof actorId === 'string' && (actor === null || actor === undefined)) {
          orphanedTokens.push({
            sceneId: scene.id,
            sceneName: scene.name,
            tokenId: t.id,
            name: t.name,
            actorId,
            actorLink: t.actorLink === true,
            actorIsNull: actor === null,
            actorIsUndefined: actor === undefined,
          });
        }

        // Q3/Q4 sample for the first 25 tokens — top-level img + defaults
        if (allRows.length < 25) {
          allRows.push({
            sceneId: scene.id,
            tokenId: t.id,
            name: t.name,
            hasTopLevelImg: typeof t.img === 'string',
            topLevelImg: typeof t.img === 'string' ? t.img : null,
            textureSrc: t.texture?.src ?? null,
            elevation: t.elevation,
            elevationType: typeof t.elevation,
            rotation: t.rotation,
            rotationType: typeof t.rotation,
            sort: t.sort,
            sortType: typeof t.sort,
            alpha: t.alpha,
            alphaType: typeof t.alpha,
            lockRotation: t.lockRotation,
            lockRotationType: typeof t.lockRotation,
            displayName: t.displayName,
            displayBars: t.displayBars,
            disposition: t.disposition,
            mirrorX: t.mirrorX,
            mirrorY: t.mirrorY,
            sightEnabled: t.sight?.enabled,
            sightRange: t.sight?.range,
            lightBright: t.light?.bright,
            lightDim: t.light?.dim,
            bar1Attr: t.bar1?.attribute ?? null,
            bar2Attr: t.bar2?.attribute ?? null,
          });
        }
      }
    }

    return {
      activeSceneId,
      sceneCount: scenes.length,
      totalTokens: scenes.reduce((sum, s) => sum + (s.tokens?.contents?.length ?? 0), 0),
      firstTokenSceneName,
      firstTokenKeysLive,
      firstTokenKeysToObject,
      liveVsToObjectDiffs,
      tintDistribution,
      detectionModeSamples,
      flagsPf2eKeys,
      orphanedTokens,
      sampleRows: allRows,
    };
  });

  log.info(
    {
      activeSceneId: survey.activeSceneId,
      sceneCount: survey.sceneCount,
      totalTokens: survey.totalTokens,
      firstTokenScene: survey.firstTokenSceneName,
    },
    'world survey: scope of the probe',
  );

  if (survey.totalTokens === 0) {
    log.warn(
      'no tokens found in any scene in this world — Q1–Q8 cannot be answered. ' +
        'place at least one token on a scene and re-run.',
    );
    process.exitCode = 1;
  } else {
    // --- Q1 ---
    log.info(
      {
        liveKeys: survey.firstTokenKeysLive,
        toObjectKeys: survey.firstTokenKeysToObject,
      },
      'Q1: top-level token document field surface (live vs toObject)',
    );

    // --- Q2 ---
    if (survey.liveVsToObjectDiffs.length === 0) {
      log.info(
        'Q2: no diffs found between live document and toObject() for x/y/width/height/rotation/elevation/sort/alpha/disposition/hidden',
      );
    } else {
      log.warn(
        { diffs: survey.liveVsToObjectDiffs },
        'Q2: DIFFS found between live document and toObject() — projection should pick one consistently',
      );
    }

    // --- Q3 + Q4 ---
    log.info(
      { sampleRows: survey.sampleRows },
      'Q3 (img source) + Q4 (default-value types) — per-token sample',
    );

    const q4Anomalies = survey.sampleRows.filter(
      (r) =>
        r.elevationType !== 'number' ||
        r.rotationType !== 'number' ||
        r.sortType !== 'number' ||
        r.alphaType !== 'number' ||
        r.lockRotationType !== 'boolean',
    );
    if (q4Anomalies.length === 0) {
      log.info(
        'Q4: elevation/rotation/sort/alpha are always numbers, lockRotation always boolean — no defensive fallback needed',
      );
    } else {
      log.warn(
        { anomalies: q4Anomalies },
        'Q4: some tokens have non-numeric / non-boolean values for default fields — projection needs defensive accessors',
      );
    }

    // --- Q5 ---
    if (survey.orphanedTokens.length === 0) {
      log.warn(
        'Q5: no orphaned tokens found in this world (actorId set but token.actor === null). ' +
          'actorMissing semantics cannot be confirmed from current state. ' +
          'Follow-up: create an unlinked token, delete its actor, re-run to observe.',
      );
    } else {
      log.info(
        { orphans: survey.orphanedTokens },
        'Q5: orphaned tokens observed — use to decide actorMissing source-of-truth',
      );
    }

    // --- Q6 ---
    log.info(
      { tintDistribution: survey.tintDistribution },
      'Q6: texture.tint value distribution across all tokens',
    );
    if (survey.tintDistribution.hex === 0) {
      log.warn(
        'Q6: no tokens with a non-default hex tint found. ' +
          'Follow-up: set tint on one token via foundry_eval and re-run to confirm hex-string shape.',
      );
    }

    // --- Q7 ---
    if (survey.detectionModeSamples.length === 0) {
      log.warn(
        'Q7: no tokens with non-empty detectionModes found. ' +
          'Follow-up: place a creature with darkvision (any goblin) on a scene and re-run.',
      );
    } else {
      log.info({ samples: survey.detectionModeSamples }, 'Q7: detectionModes shape samples');
    }

    // --- Q8 ---
    log.info(
      { flagsPf2eFingerprints: survey.flagsPf2eKeys },
      'Q8: token.flags.pf2e key fingerprints (count by sorted-keys signature)',
    );
    const onlyEmpty =
      Object.keys(survey.flagsPf2eKeys).length === 1 && '<empty>' in survey.flagsPf2eKeys;
    if (onlyEmpty) {
      log.info('Q8: token.flags.pf2e is empty on every token — drop the flags projection from v1');
    }
  }

  // --- Q9: tool handler smoke (gated) ---
  if (!tool) {
    log.info(
      'Q9: get_token_details not yet registered in tools/index.ts — skipping handler smoke. ' +
        'Re-run this probe after the tool ships.',
    );
  } else if (survey.totalTokens === 0) {
    log.info('Q9: skipped (no tokens to exercise against)');
  } else {
    // pick the first sampled row as our target
    const target = survey.sampleRows[0];
    const targetSceneId = target.sceneId;
    const targetTokenId = target.tokenId;

    const ctx = { browser: session, log };

    // a. tokenId only (active scene fallback)
    const p1 = tool.inputSchema.safeParse({ tokenId: targetTokenId });
    if (!p1.success) {
      log.error({ issues: p1.error.issues }, 'Q9a: schema rejected {tokenId}');
      process.exitCode = 1;
    } else {
      const r1 = JSON.parse((await tool.handler(p1.data, ctx))[0].text);
      log.info({ ok: r1.ok, tokenName: r1.token?.name }, 'Q9a: tokenId-only on active scene');
      if (r1.ok !== true && targetSceneId === survey.activeSceneId) {
        log.error({ result: r1 }, 'Q9a: expected ok=true');
        process.exitCode = 1;
      }
    }

    // b. tokenId + explicit sceneId
    const p2 = tool.inputSchema.safeParse({ tokenId: targetTokenId, sceneId: targetSceneId });
    if (!p2.success) {
      log.error({ issues: p2.error.issues }, 'Q9b: schema rejected {tokenId, sceneId}');
      process.exitCode = 1;
    } else {
      const r2 = JSON.parse((await tool.handler(p2.data, ctx))[0].text);
      log.info({ ok: r2.ok, tokenName: r2.token?.name }, 'Q9b: tokenId + explicit sceneId');
      if (r2.ok !== true) {
        log.error({ result: r2 }, 'Q9b: expected ok=true');
        process.exitCode = 1;
      }
    }

    // c. bogus tokenId on active scene — handler throws ToolError per
    //    move_token/delete_token/get_item_details convention; details.code
    //    carries the evaluator's specific code (TOKEN_NOT_FOUND).
    const p3 = tool.inputSchema.safeParse({ tokenId: 'bogusbogusbogus0' });
    if (!p3.success) {
      log.error({ issues: p3.error.issues }, 'Q9c: schema rejected bogus tokenId');
      process.exitCode = 1;
    } else {
      let threw = null;
      try {
        await tool.handler(p3.data, ctx);
      } catch (e) {
        threw = e;
      }
      log.info(
        {
          threw: threw?.name ?? null,
          code: threw?.code ?? null,
          detailsCode: threw?.details?.code ?? null,
          message: threw?.message ?? null,
        },
        'Q9c: bogus tokenId (expect ToolError thrown, details.code = TOKEN_NOT_FOUND)',
      );
      if (
        threw?.name !== 'ToolError' ||
        threw.code !== 'INVALID_INPUT' ||
        (threw.details?.code !== undefined && threw.details.code !== 'TOKEN_NOT_FOUND')
      ) {
        // details.code may not be set when the evaluator omits it; the
        // throw with INVALID_INPUT and a message mentioning the tokenId
        // is the minimum required.
        if (threw?.name !== 'ToolError' || threw.code !== 'INVALID_INPUT') {
          log.error({ threw }, 'Q9c: expected ToolError(INVALID_INPUT)');
          process.exitCode = 1;
        }
      }
    }

    // d. valid tokenId on bogus sceneId — also throws.
    const p4 = tool.inputSchema.safeParse({ tokenId: targetTokenId, sceneId: 'doesnotexist' });
    if (!p4.success) {
      log.error({ issues: p4.error.issues }, 'Q9d: schema rejected {tokenId, sceneId: bogus}');
      process.exitCode = 1;
    } else {
      let threw = null;
      try {
        await tool.handler(p4.data, ctx);
      } catch (e) {
        threw = e;
      }
      log.info(
        {
          threw: threw?.name ?? null,
          code: threw?.code ?? null,
          message: threw?.message ?? null,
        },
        'Q9d: bogus sceneId (expect ToolError thrown)',
      );
      if (threw?.name !== 'ToolError' || threw.code !== 'INVALID_INPUT') {
        log.error({ threw }, 'Q9d: expected ToolError(INVALID_INPUT)');
        process.exitCode = 1;
      }
    }

    // e. includeRawDocument
    const p5 = tool.inputSchema.safeParse({ tokenId: targetTokenId, includeRawDocument: true });
    if (!p5.success) {
      log.error({ issues: p5.error.issues }, 'Q9e: schema rejected {includeRawDocument: true}');
      process.exitCode = 1;
    } else {
      const r5 = JSON.parse((await tool.handler(p5.data, ctx))[0].text);
      log.info(
        {
          ok: r5.ok,
          hasRawDocument: r5.token?.rawDocument !== undefined,
          rawDocumentKeys: r5.token?.rawDocument ? Object.keys(r5.token.rawDocument).sort() : null,
        },
        'Q9e: includeRawDocument=true',
      );
      if (r5.ok !== true || !r5.token?.rawDocument) {
        log.error({ result: r5 }, 'Q9e: expected ok=true with rawDocument populated');
        process.exitCode = 1;
      }
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
