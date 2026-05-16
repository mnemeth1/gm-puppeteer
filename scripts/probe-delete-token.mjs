/**
 * Probe + acceptance script for delete_token. Drives the live headless
 * Foundry against the active scene and exercises:
 *
 *   1. Delete a single probe token by id (no sceneId argument) → ok=true,
 *      deleted.length=1, notFound=[], token absent from scene.tokens.
 *   2. Delete two probe tokens in one call with explicit sceneId → ok=true,
 *      both ids in deleted, both gone from scene.tokens.
 *   3. Delete a batch mixing one real probe id with one bogus id → ok=true,
 *      partial success: deleted.length=1, notFound.length=1.
 *   4. Bogus sceneId → ToolError code=INVALID_INPUT (evaluator
 *      SCENE_NOT_FOUND → tool wrapper INVALID_INPUT).
 *   5. All-bogus tokenIds against the active scene → ok=true, deleted=[],
 *      notFound=[...], and scene.tokens.size is unchanged across the call.
 *   6. Post-teardown signature multiset (name|actorId|x|y|w|h) on the
 *      scene equals the pre-probe snapshot.
 *
 * State restoration model (destructive probe — full toObject() payloads):
 *  - Pre-probe scrub: delete any token on the active scene whose name
 *    starts with PROBE_TOKEN_NAME_PREFIX (leftovers from a failed run).
 *  - Setup: place N probe tokens on the active scene via the canonical
 *    Foundry API (actor.getTokenDocument → scene.createEmbeddedDocuments),
 *    NOT via the place_token_at_grid tool — keeps the probe decoupled
 *    from the placement tool's behavior.
 *  - Snapshot: capture full toObject() payload for every token on the
 *    scene now (probe + pre-existing). Probe tokens ARE part of the
 *    snapshot; tests delete them, teardown recreates them, final scrub
 *    deletes the recreated probe tokens to end clean.
 *  - Teardown: for each snapshot id not present now, recreate via
 *    scene.createEmbeddedDocuments with the saved payload. Foundry
 *    assigns a fresh id (the original is unrecoverable), so the post-
 *    teardown check is on the name+actorId+x+y+w+h signature multiset,
 *    NOT id-set equality.
 *  - Final scrub: delete any remaining probe-prefixed tokens.
 *
 *   npm run build && node scripts/probe-delete-token.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'delete_token');
if (!tool) {
  log.error('delete_token not registered');
  process.exit(2);
}

const PROBE_TOKEN_NAME_PREFIX = '__probe_delete_token__';

const failures = [];

function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  }
}

async function call(input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { isError: true, validation: parsed.error.issues };
  }
  const blocks = await tool.handler(parsed.data, { browser: session, log }).catch((err) => ({
    __throw:
      err instanceof Error
        ? { code: err.code, message: err.message, details: err.details }
        : { message: String(err) },
  }));
  if (blocks?.__throw) return { isError: true, error: blocks.__throw };
  const block = blocks?.[0];
  if (!block || block.type !== 'text') return { isError: true, raw: blocks };
  try {
    return { ok: true, data: JSON.parse(block.text) };
  } catch {
    return { isError: true, raw: block.text };
  }
}

try {
  const { page } = await session.ensureStarted();

  // --------------------------------------------------------------------
  // Pre-probe scrub: remove any probe-prefixed tokens on the active scene.
  // --------------------------------------------------------------------
  const scrub = await page.evaluate(async (prefix) => {
    const s = globalThis.game.scenes?.active;
    if (!s) return { error: 'no active scene' };
    const targets = (s.tokens?.contents ?? []).filter((t) =>
      (t.name ?? '').startsWith(prefix),
    );
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return { removed: [] };
    try {
      await s.deleteEmbeddedDocuments('Token', ids);
      return { removed: ids };
    } catch (e) {
      return { error: e?.message ?? String(e) };
    }
  }, PROBE_TOKEN_NAME_PREFIX);
  log.info({ scrub }, 'pre-probe scrub');
  if (scrub.error) {
    log.error({ scrub }, 'scrub failed; aborting');
    process.exit(2);
  }

  // --------------------------------------------------------------------
  // Discover scene + actor for the probe.
  // --------------------------------------------------------------------
  const env = await page.evaluate(() => {
    const s = globalThis.game.scenes?.active;
    if (!s) return null;
    const actors = (globalThis.game.actors?.contents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
    }));
    return {
      sceneId: s.id,
      sceneName: s.name,
      gridSize: s.grid?.size ?? null,
      gridType: s.grid?.type ?? null,
      tokenCount: s.tokens?.size ?? 0,
      actors,
    };
  });
  if (!env) {
    log.error('No active scene; cannot run delete_token probe');
    process.exit(2);
  }
  const placeable =
    env.actors.find((a) => a.name === 'Valeros (Level 1)') ??
    env.actors.find((a) => a.type === 'character') ??
    env.actors[0];
  if (!placeable) {
    log.error('No world actors available; cannot run probe');
    process.exit(2);
  }
  log.info(
    { sceneId: env.sceneId, sceneName: env.sceneName, actor: placeable, tokenCount: env.tokenCount },
    'env: active scene + chosen actor',
  );

  // --------------------------------------------------------------------
  // Setup: place 3 probe tokens directly via the canonical Foundry API.
  //
  // Coords are arbitrary (in-bounds or padding-region, both accepted by
  // Foundry — we only care about delete behavior, not visual layout).
  // Use distinct pixel offsets so the snapshot signature can distinguish
  // them.
  // --------------------------------------------------------------------
  const setup = await page.evaluate(
    async (actorId, namePrefix, gridSize) => {
      const s = globalThis.game.scenes.active;
      const actor = globalThis.game.actors.get(actorId);
      if (!actor) return { error: 'actor not found' };
      const placements = [
        { name: namePrefix + 'A', x: 0, y: 0 },
        { name: namePrefix + 'B', x: gridSize ?? 100, y: 0 },
        { name: namePrefix + 'C', x: (gridSize ?? 100) * 2, y: 0 },
      ];
      const created = [];
      for (const p of placements) {
        const tdoc = await actor.getTokenDocument({ x: p.x, y: p.y, name: p.name });
        const arr = await s.createEmbeddedDocuments('Token', [tdoc.toObject()]);
        const t = arr?.[0];
        if (!t) return { error: 'createEmbeddedDocuments returned empty' };
        created.push({ id: t.id, name: t.name, x: t.x, y: t.y });
      }
      return { created };
    },
    placeable.id,
    PROBE_TOKEN_NAME_PREFIX,
    env.gridSize,
  );
  if (setup.error) {
    log.error({ setup }, 'setup failed; aborting');
    process.exit(2);
  }
  log.info({ setup }, 'setup: placed probe tokens');
  if (setup.created.length !== 3) {
    log.error({ setup }, 'expected 3 probe tokens, got something else');
    process.exit(2);
  }
  const [probeA, probeB, probeC] = setup.created;

  // --------------------------------------------------------------------
  // Snapshot: full toObject() per token on the scene (probe + pre-existing).
  // --------------------------------------------------------------------
  const startSnapshot = await page.evaluate(() => {
    const s = globalThis.game.scenes.active;
    return {
      sceneId: s.id,
      tokenCount: s.tokens?.size ?? 0,
      tokens: (s.tokens?.contents ?? []).map((t) => ({
        id: t.id,
        name: t.name ?? '',
        actorId: t.actorId ?? null,
        x: t.x ?? 0,
        y: t.y ?? 0,
        width: t.width ?? 1,
        height: t.height ?? 1,
        payload: t.toObject(),
      })),
    };
  });
  log.info(
    {
      tokenCount: startSnapshot.tokenCount,
      sample: startSnapshot.tokens.slice(0, 5).map((t) => ({
        id: t.id,
        name: t.name,
        x: t.x,
        y: t.y,
      })),
    },
    'snapshot captured',
  );

  // --------------------------------------------------------------------
  // T1: delete a single probe token by id, no sceneId argument.
  // --------------------------------------------------------------------
  {
    const res = await call({ tokenIds: [probeA.id] });
    log.info({ probe: 1, res }, 'T1: delete one (active scene default)');
    assert(res.ok === true, 'T1: ok', { res });
    if (res.ok) {
      assert(res.data.sceneId === env.sceneId, 'T1: sceneId matches active', {
        got: res.data.sceneId,
        want: env.sceneId,
      });
      assert(res.data.deleted?.length === 1, 'T1: deleted.length=1', { d: res.data.deleted });
      assert(res.data.deleted?.[0]?.tokenId === probeA.id, 'T1: deleted id matches', {
        got: res.data.deleted?.[0]?.tokenId,
        want: probeA.id,
      });
      assert(res.data.deleted?.[0]?.tokenName === probeA.name, 'T1: deleted name snapshot', {
        got: res.data.deleted?.[0]?.tokenName,
        want: probeA.name,
      });
      assert(res.data.deleted?.[0]?.actorId === placeable.id, 'T1: deleted actorId snapshot', {
        got: res.data.deleted?.[0]?.actorId,
        want: placeable.id,
      });
      assert(
        Array.isArray(res.data.notFound) && res.data.notFound.length === 0,
        'T1: notFound is empty',
        { nf: res.data.notFound },
      );
    }
    const gone = await page.evaluate(
      (id) => !globalThis.game.scenes.active.tokens.get(id),
      probeA.id,
    );
    assert(gone === true, 'T1: probeA actually removed from scene.tokens', { gone });
  }

  // --------------------------------------------------------------------
  // T2: delete two probe tokens in one call with explicit sceneId.
  // --------------------------------------------------------------------
  {
    const res = await call({ tokenIds: [probeB.id, probeC.id], sceneId: env.sceneId });
    log.info({ probe: 2, res }, 'T2: delete two (explicit sceneId)');
    assert(res.ok === true, 'T2: ok', { res });
    if (res.ok) {
      assert(res.data.deleted?.length === 2, 'T2: deleted.length=2', { d: res.data.deleted });
      const deletedIds = new Set((res.data.deleted ?? []).map((d) => d.tokenId));
      assert(deletedIds.has(probeB.id) && deletedIds.has(probeC.id), 'T2: both ids in deleted', {
        deletedIds: [...deletedIds],
      });
      assert(res.data.notFound?.length === 0, 'T2: notFound empty', { nf: res.data.notFound });
    }
    const stillThere = await page.evaluate(
      (ids) => {
        const s = globalThis.game.scenes.active;
        return ids.filter((id) => !!s.tokens.get(id));
      },
      [probeB.id, probeC.id],
    );
    assert(stillThere.length === 0, 'T2: both tokens actually removed', { stillThere });
  }

  // --------------------------------------------------------------------
  // T3: mixed batch — one real probe id, one bogus. Need a fresh probe
  // token since T1+T2 deleted all three. Place one more inline.
  // --------------------------------------------------------------------
  let probeD;
  {
    const placed = await page.evaluate(
      async (actorId, name, gridSize) => {
        const s = globalThis.game.scenes.active;
        const actor = globalThis.game.actors.get(actorId);
        const tdoc = await actor.getTokenDocument({
          x: (gridSize ?? 100) * 3,
          y: 0,
          name,
        });
        const arr = await s.createEmbeddedDocuments('Token', [tdoc.toObject()]);
        const t = arr?.[0];
        return { id: t.id, name: t.name, x: t.x, y: t.y };
      },
      placeable.id,
      PROBE_TOKEN_NAME_PREFIX + 'D',
      env.gridSize,
    );
    probeD = placed;
    log.info({ probeD }, 'T3 setup: extra probe token');

    const bogusId = 'deadbeefdeadbeef';
    const res = await call({ tokenIds: [probeD.id, bogusId] });
    log.info({ probe: 3, res }, 'T3: partial-success batch');
    assert(res.ok === true, 'T3: ok (partial success is not an error)', { res });
    if (res.ok) {
      assert(res.data.deleted?.length === 1, 'T3: deleted.length=1', { d: res.data.deleted });
      assert(res.data.deleted?.[0]?.tokenId === probeD.id, 'T3: deleted id is probeD', {
        got: res.data.deleted?.[0]?.tokenId,
        want: probeD.id,
      });
      assert(res.data.notFound?.length === 1, 'T3: notFound.length=1', { nf: res.data.notFound });
      assert(res.data.notFound?.[0] === bogusId, 'T3: notFound contains the bogus id', {
        nf: res.data.notFound,
      });
    }
  }

  // --------------------------------------------------------------------
  // T4: bogus sceneId → ToolError INVALID_INPUT.
  // --------------------------------------------------------------------
  {
    const res = await call({ tokenIds: ['anything'], sceneId: 'bogus-scene-id' });
    log.info({ probe: 4, res }, 'T4: bogus sceneId');
    assert(res.isError === true, 'T4: error', { res });
    assert(res.error?.code === 'INVALID_INPUT', 'T4: code=INVALID_INPUT', { code: res.error?.code });
    assert(
      res.error?.details?.sceneId === 'bogus-scene-id',
      'T4: error details echo the sceneId',
      { d: res.error?.details },
    );
  }

  // --------------------------------------------------------------------
  // T5: all-bogus tokenIds against active scene → ok=true, no deletions,
  // scene.tokens.size unchanged across the call.
  // --------------------------------------------------------------------
  {
    const sizeBefore = await page.evaluate(
      () => globalThis.game.scenes.active.tokens?.size ?? 0,
    );
    const res = await call({ tokenIds: ['bogus1', 'bogus2', 'bogus3'] });
    log.info({ probe: 5, res, sizeBefore }, 'T5: all-bogus batch');
    assert(res.ok === true, 'T5: ok (no Foundry call needed)', { res });
    if (res.ok) {
      assert(res.data.deleted?.length === 0, 'T5: deleted empty', { d: res.data.deleted });
      assert(res.data.notFound?.length === 3, 'T5: notFound contains all 3', {
        nf: res.data.notFound,
      });
    }
    const sizeAfter = await page.evaluate(
      () => globalThis.game.scenes.active.tokens?.size ?? 0,
    );
    assert(sizeBefore === sizeAfter, 'T5: scene.tokens.size unchanged', { sizeBefore, sizeAfter });
  }

  // --------------------------------------------------------------------
  // Teardown.
  //
  // 1. Delete any orphan tokens on the scene not in the snapshot (we
  //    placed probeD inline in T3 after the snapshot — that's an orphan).
  // 2. For each snapshot id missing from the scene now (probeA/B/C/D
  //    were deleted by the tests), recreate via createEmbeddedDocuments
  //    using the saved payload. Foundry assigns a fresh id; the probe
  //    tokens we created live in the snapshot, so they get recreated too
  //    — the FINAL scrub step then removes them.
  // 3. FINAL scrub: delete any remaining probe-prefixed tokens.
  // 4. Build signature multiset (name|actorId|x|y|w|h) on the post-
  //    teardown scene and compare against the snapshot signature
  //    multiset MINUS the probe-prefixed entries — so we end at the
  //    pre-setup state, not the snapshot state (which included probes).
  // --------------------------------------------------------------------
  const teardown = await page.evaluate(
    async (snapshot, prefix) => {
      const s = globalThis.game.scenes.active;
      const snapIds = new Set(snapshot.tokens.map((t) => t.id));

      // 1. Delete orphans introduced after the snapshot (probeD).
      const orphans = (s.tokens?.contents ?? [])
        .filter((t) => !snapIds.has(t.id))
        .map((t) => t.id);
      const orphansDeleted = [];
      const orphanFailures = [];
      if (orphans.length > 0) {
        try {
          await s.deleteEmbeddedDocuments('Token', orphans);
          orphansDeleted.push(...orphans);
        } catch (err) {
          orphanFailures.push(err?.message ?? String(err));
        }
      }

      // 2. Recreate snapshot tokens that are missing.
      const missingSnap = snapshot.tokens.filter((snap) => !s.tokens.get(snap.id));
      const recreated = [];
      const recreateFailures = [];
      if (missingSnap.length > 0) {
        try {
          const arr = await s.createEmbeddedDocuments(
            'Token',
            missingSnap.map((m) => m.payload),
          );
          recreated.push(
            ...arr.map((t, idx) => ({
              originalId: missingSnap[idx].id,
              newId: t.id,
              name: t.name,
            })),
          );
        } catch (err) {
          recreateFailures.push(err?.message ?? String(err));
        }
      }

      // 3. Final scrub: delete probe-prefixed tokens (the recreated ones
      // from step 2 plus any leftover orphans from a partially-completed
      // setup).
      const probeIds = (s.tokens?.contents ?? [])
        .filter((t) => (t.name ?? '').startsWith(prefix))
        .map((t) => t.id);
      const finalScrubDeleted = [];
      const finalScrubFailures = [];
      if (probeIds.length > 0) {
        try {
          await s.deleteEmbeddedDocuments('Token', probeIds);
          finalScrubDeleted.push(...probeIds);
        } catch (err) {
          finalScrubFailures.push(err?.message ?? String(err));
        }
      }

      // 4. Build signature multisets.
      const sigOfToken = (t) =>
        [
          t.name ?? '',
          t.actorId ?? '',
          t.x ?? 0,
          t.y ?? 0,
          t.width ?? 1,
          t.height ?? 1,
        ].join('|');
      const sigOfSnap = (s) => [s.name, s.actorId ?? '', s.x, s.y, s.width, s.height].join('|');

      const finalSig = new Map();
      for (const t of s.tokens?.contents ?? []) {
        const k = sigOfToken(t);
        finalSig.set(k, (finalSig.get(k) ?? 0) + 1);
      }
      const expectedSig = new Map();
      for (const snap of snapshot.tokens) {
        if (snap.name.startsWith(prefix)) continue; // probes don't survive teardown
        const k = sigOfSnap(snap);
        expectedSig.set(k, (expectedSig.get(k) ?? 0) + 1);
      }
      const missingSigs = [];
      for (const [sig, count] of expectedSig) {
        const have = finalSig.get(sig) ?? 0;
        if (have !== count) missingSigs.push({ sig, expected: count, actual: have });
      }
      const extraSigs = [];
      for (const [sig, count] of finalSig) {
        if (!expectedSig.has(sig)) extraSigs.push({ sig, count });
      }

      return {
        orphansDeleted,
        orphanFailures,
        recreated,
        recreateFailures,
        finalScrubDeleted,
        finalScrubFailures,
        finalTokenCount: s.tokens?.size ?? 0,
        signaturesMatch: missingSigs.length === 0 && extraSigs.length === 0,
        missingSigs,
        extraSigs,
      };
    },
    startSnapshot,
    PROBE_TOKEN_NAME_PREFIX,
  );
  log.info({ teardown }, 'teardown complete');

  // --------------------------------------------------------------------
  // T6: post-teardown assertions.
  // --------------------------------------------------------------------
  assert(teardown.orphanFailures.length === 0, 'T6: no orphan-delete failures', {
    f: teardown.orphanFailures,
  });
  assert(teardown.recreateFailures.length === 0, 'T6: no recreate failures', {
    f: teardown.recreateFailures,
  });
  assert(teardown.finalScrubFailures.length === 0, 'T6: no final-scrub failures', {
    f: teardown.finalScrubFailures,
  });
  // Expected final count = snapshot count - probe tokens (3 in snapshot, +1 probeD recreated then scrubbed).
  const probeTokensInSnapshot = startSnapshot.tokens.filter((t) =>
    t.name.startsWith(PROBE_TOKEN_NAME_PREFIX),
  ).length;
  const expectedFinalCount = startSnapshot.tokenCount - probeTokensInSnapshot;
  assert(
    teardown.finalTokenCount === expectedFinalCount,
    'T6: final token count equals pre-setup state',
    { final: teardown.finalTokenCount, expected: expectedFinalCount },
  );
  assert(
    teardown.signaturesMatch === true,
    'T6: name+actorId+x+y+w+h multiset matches pre-setup',
    { missing: teardown.missingSigs, extra: teardown.extraSigs },
  );

  if (failures.length > 0) {
    log.error({ failures, failureCount: failures.length }, 'PROBE FAILED');
    process.exitCode = 1;
  } else {
    log.info('all acceptance assertions passed');
    process.exitCode = 0;
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
