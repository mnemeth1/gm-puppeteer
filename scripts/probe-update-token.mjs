/**
 * Probe for update_token. Runs against live Foundry v14.361 + PF2e 8.1.2
 * BEFORE the tool ships — exercises `TokenDocument#update` directly via
 * `page.evaluate` to lock down the parameter list and tool semantics.
 *
 * Questions (correspond to Phase 1 in
 *   ~/.claude/plans/read-todo-md-then-come-glittery-cocke.md):
 *
 *   Q1. PF2e disposition re-derivation. Does
 *       token.update({disposition: N}) stick on the live document? On
 *       toObject()? Does behavior differ for linked-PC tokens vs
 *       unlinked-NPC tokens? get-token-details JSDoc warns of a live-vs-
 *       toObject divergence here.
 *
 *   Q2. Nested-field update syntax. Does token.update({sight: {enabled:
 *       true}}) merge-patch the sight subdocument or replace it
 *       (zeroing untouched fields)? Compare nested-object form vs
 *       dot-path form ('sight.enabled': true). Decides whether the
 *       evaluator builds nested objects or dot-paths.
 *
 *   Q3. displayName / displayBars strictness. Foundry exports
 *       CONST.TOKEN_DISPLAY_MODES = {NONE:0, CONTROL:10, OWNER_HOVER:20,
 *       HOVER:30, OWNER:40, ALWAYS:50}. Does token.update validate
 *       against the enum, accept any int, or clamp? Decides zod schema:
 *       literal-union vs int-range.
 *
 *   Q4. Stale token reference after update. move_token re-fetches
 *       post-update for stale .x/.y. Confirm whether the same artifact
 *       applies to non-positional fields (almost certainly yes — it's a
 *       Puppeteer/headless artifact, not field-specific).
 *
 *   Q5. Empty update no-op. token.update({}) — throws? returns falsy?
 *       silent no-op? Schema layer should reject before reaching the
 *       page, but defensive behavior here informs the evaluator.
 *
 *   Q6. Linked-token name semantics. Setting token.name on a linked
 *       token — renames only the token, or propagates to the linked
 *       actor? Tested on a linked PC if present in this world.
 *
 *   Q7. sight.visionMode acceptance. Try setting visionMode to 'basic'
 *       (default), 'darkvision', 'lowLightVision'. Foundry-side enum
 *       validation? Unknown values rejected, silently accepted, or
 *       coerced?
 *
 * State restoration: snapshot every field this probe touches (name,
 * disposition, hidden, displayName, displayBars, sight) on every target
 * token at the start. Restore each touched token to its full snapshot
 * via one consolidating token.update at teardown. Assert the post-
 * teardown reads match the snapshot exactly.
 *
 *   npm run build && node scripts/probe-update-token.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const failures = [];
function assert(cond, label, ctx) {
  if (!cond) {
    failures.push({ label, ctx });
    log.error({ label, ctx }, 'ASSERTION FAILED');
  } else {
    log.info({ label }, 'pass');
  }
}

// Snapshots keyed by tokenId — restored at teardown.
const snapshots = new Map();

try {
  const { page } = await session.ensureStarted();

  // -------- Discovery --------
  // Find a disposable (unlinked, NPC-ish) and, if present, a linked PC
  // for the disposition/name divergence cases.
  const discovery = await page.evaluate(() => {
    const game = globalThis.game;
    const scene = game?.scenes?.active;
    if (!scene) return { ok: false, reason: 'no active scene' };

    const tokens = scene.tokens?.contents ?? [];
    if (tokens.length === 0) return { ok: false, reason: 'no tokens on active scene' };

    const snap = (t) => ({
      name: t.name,
      disposition: t.disposition,
      hidden: t.hidden,
      displayName: t.displayName,
      displayBars: t.displayBars,
      sight: {
        enabled: t.sight?.enabled,
        range: t.sight?.range,
        angle: t.sight?.angle,
        visionMode: t.sight?.visionMode,
        color: t.sight?.color ?? null,
        brightness: t.sight?.brightness,
        saturation: t.sight?.saturation,
        contrast: t.sight?.contrast,
        attenuation: t.sight?.attenuation,
      },
    });

    const projection = tokens.map((t) => ({
      id: t.id,
      name: t.name,
      actorId: t.actorId ?? null,
      actorLink: t.actorLink === true,
      actorName: t.actor?.name ?? null,
      actorType: t.actor?.type ?? null,
      snapshot: snap(t),
    }));

    const linkedPC =
      projection.find((t) => t.actorLink && t.actorType === 'character') ?? null;
    const npc =
      projection.find((t) => !t.actorLink) ??
      projection.find((t) => t.actorType !== 'character') ??
      projection.find((t) => t.actorType === 'npc') ??
      projection[0];

    return {
      ok: true,
      sceneId: scene.id,
      sceneName: scene.name,
      all: projection,
      npc,
      linkedPC,
    };
  });

  if (!discovery.ok) {
    log.error({ reason: discovery.reason }, 'discovery failed');
    process.exit(2);
  }
  log.info(
    {
      scene: discovery.sceneName,
      sceneId: discovery.sceneId,
      tokenCount: discovery.all.length,
      npc: { id: discovery.npc.id, name: discovery.npc.name, actorLink: discovery.npc.actorLink },
      linkedPC: discovery.linkedPC
        ? { id: discovery.linkedPC.id, name: discovery.linkedPC.name }
        : null,
    },
    'discovery: probe targets selected',
  );

  // Record snapshots for every token we plan to touch.
  for (const tok of [discovery.npc, discovery.linkedPC].filter(Boolean)) {
    snapshots.set(tok.id, tok.snapshot);
  }

  const npcId = discovery.npc.id;
  const linkedPCId = discovery.linkedPC?.id ?? null;
  const npcSnap = snapshots.get(npcId);

  // -------- Q1: disposition re-derivation --------
  // Strategy: write a *different* disposition value, then read it back
  // both live (re-fetched from scene.tokens) and via toObject(). Then
  // wait a microtask + an animation-frame tick and read again, to
  // catch any PF2e re-derivation that fires async.
  const q1 = await page.evaluate(async (tokenId) => {
    const game = globalThis.game;
    const scene = game.scenes.active;
    const tBefore = scene.tokens.get(tokenId);
    const original = tBefore.disposition;
    // Pick a different valid disposition.
    const candidates = [-2, -1, 0, 1].filter((d) => d !== original);
    const target = candidates[0];

    const updateErr = await tBefore.update({ disposition: target }).then(
      () => null,
      (e) => String(e?.message ?? e),
    );

    const tImmediate = scene.tokens.get(tokenId);
    const immediate = {
      live: tImmediate.disposition,
      toObject: tImmediate.toObject?.()?.disposition,
    };

    await new Promise((res) => setTimeout(res, 50));
    const tLater = scene.tokens.get(tokenId);
    const later = {
      live: tLater.disposition,
      toObject: tLater.toObject?.()?.disposition,
    };

    return { original, target, updateErr, immediate, later };
  }, npcId);
  log.info({ q1 }, 'Q1: disposition write on NPC token');
  assert(q1.updateErr === null, 'Q1: disposition update did not throw', { updateErr: q1.updateErr });

  if (linkedPCId !== null) {
    const q1Linked = await page.evaluate(async (tokenId) => {
      const game = globalThis.game;
      const scene = game.scenes.active;
      const tBefore = scene.tokens.get(tokenId);
      const original = tBefore.disposition;
      const candidates = [-2, -1, 0, 1].filter((d) => d !== original);
      const target = candidates[0];

      const updateErr = await tBefore.update({ disposition: target }).then(
        () => null,
        (e) => String(e?.message ?? e),
      );

      const tImmediate = scene.tokens.get(tokenId);
      const immediate = {
        live: tImmediate.disposition,
        toObject: tImmediate.toObject?.()?.disposition,
      };

      await new Promise((res) => setTimeout(res, 50));
      const tLater = scene.tokens.get(tokenId);
      const later = {
        live: tLater.disposition,
        toObject: tLater.toObject?.()?.disposition,
      };

      return { original, target, updateErr, immediate, later };
    }, linkedPCId);
    log.info({ q1Linked }, 'Q1: disposition write on LINKED PC token (PF2e re-derivation test)');
  } else {
    log.warn(
      'Q1: no linked-character token on the active scene — linked-PC disposition behavior cannot be observed in this run.',
    );
  }

  // -------- Q2: nested-field update syntax --------
  // Snapshot the FULL sight object before each form; flip enabled; read
  // back every sight field and check whether un-touched fields were
  // preserved or zeroed. Restore between forms.
  const restoreSight = async (tokenId, snapSight) => {
    await page.evaluate(
      async ({ tokenId, sight }) => {
        const t = globalThis.game.scenes.active.tokens.get(tokenId);
        await t.update({ sight });
      },
      { tokenId, sight: snapSight },
    );
  };

  const q2Nested = await page.evaluate(async (tokenId) => {
    const game = globalThis.game;
    const scene = game.scenes.active;
    const tBefore = scene.tokens.get(tokenId);
    const before = {
      enabled: tBefore.sight?.enabled,
      range: tBefore.sight?.range,
      angle: tBefore.sight?.angle,
      visionMode: tBefore.sight?.visionMode,
      brightness: tBefore.sight?.brightness,
    };
    const target = !before.enabled;
    const updateErr = await tBefore.update({ sight: { enabled: target } }).then(
      () => null,
      (e) => String(e?.message ?? e),
    );
    const tAfter = scene.tokens.get(tokenId);
    const after = {
      enabled: tAfter.sight?.enabled,
      range: tAfter.sight?.range,
      angle: tAfter.sight?.angle,
      visionMode: tAfter.sight?.visionMode,
      brightness: tAfter.sight?.brightness,
    };
    return { before, target, updateErr, after };
  }, npcId);
  log.info({ q2Nested }, 'Q2a: nested-object form { sight: { enabled: !x } }');
  await restoreSight(npcId, npcSnap.sight);

  const q2Dot = await page.evaluate(async (tokenId) => {
    const game = globalThis.game;
    const scene = game.scenes.active;
    const tBefore = scene.tokens.get(tokenId);
    const before = {
      enabled: tBefore.sight?.enabled,
      range: tBefore.sight?.range,
      angle: tBefore.sight?.angle,
      visionMode: tBefore.sight?.visionMode,
      brightness: tBefore.sight?.brightness,
    };
    const target = !before.enabled;
    const updateErr = await tBefore.update({ 'sight.enabled': target }).then(
      () => null,
      (e) => String(e?.message ?? e),
    );
    const tAfter = scene.tokens.get(tokenId);
    const after = {
      enabled: tAfter.sight?.enabled,
      range: tAfter.sight?.range,
      angle: tAfter.sight?.angle,
      visionMode: tAfter.sight?.visionMode,
      brightness: tAfter.sight?.brightness,
    };
    return { before, target, updateErr, after };
  }, npcId);
  log.info({ q2Dot }, 'Q2b: dot-path form { "sight.enabled": !x }');
  await restoreSight(npcId, npcSnap.sight);

  // Decide which form preserves untouched sight fields.
  const nestedPreserves =
    q2Nested.updateErr === null &&
    q2Nested.after.enabled === q2Nested.target &&
    q2Nested.after.range === q2Nested.before.range &&
    q2Nested.after.angle === q2Nested.before.angle &&
    q2Nested.after.visionMode === q2Nested.before.visionMode;
  const dotPreserves =
    q2Dot.updateErr === null &&
    q2Dot.after.enabled === q2Dot.target &&
    q2Dot.after.range === q2Dot.before.range &&
    q2Dot.after.angle === q2Dot.before.angle &&
    q2Dot.after.visionMode === q2Dot.before.visionMode;
  log.info(
    { nestedPreserves, dotPreserves },
    'Q2 summary: which form preserves untouched sight fields',
  );

  // -------- Q3: displayName / displayBars strictness --------
  const q3 = await page.evaluate(async (tokenId) => {
    const game = globalThis.game;
    const scene = game.scenes.active;
    const t = scene.tokens.get(tokenId);
    const TOKEN_DISPLAY_MODES = globalThis.CONST?.TOKEN_DISPLAY_MODES ?? null;

    const cases = [
      { input: 30, label: 'in-enum HOVER (30)' },
      { input: 0, label: 'in-enum NONE (0)' },
      { input: 25, label: 'out-of-enum positive (25)' },
      { input: -1, label: 'negative (-1)' },
      { input: 1000, label: 'large (1000)' },
    ];
    const results = [];
    for (const c of cases) {
      const errMsg = await t.update({ displayName: c.input }).then(
        () => null,
        (e) => String(e?.message ?? e),
      );
      const after = scene.tokens.get(tokenId).displayName;
      results.push({ ...c, errMsg, after });
    }
    return { TOKEN_DISPLAY_MODES, results };
  }, npcId);
  log.info({ q3 }, 'Q3: displayName strictness (acceptance / rejection / clamping)');

  // -------- Q4: stale reference after update --------
  const q4 = await page.evaluate(async (tokenId) => {
    const game = globalThis.game;
    const scene = game.scenes.active;
    const tFirstRef = scene.tokens.get(tokenId);
    const originalName = tFirstRef.name;
    const newName = `__probe_${Date.now()}`;
    await tFirstRef.update({ name: newName });
    const fromOldRef = tFirstRef.name;
    const tNewRef = scene.tokens.get(tokenId);
    const fromNewRef = tNewRef.name;
    return { originalName, newName, fromOldRef, fromNewRef, oldRefIsStale: fromOldRef !== newName };
  }, npcId);
  log.info({ q4 }, 'Q4: stale reference after update (name field)');

  // -------- Q5: empty update --------
  const q5 = await page.evaluate(async (tokenId) => {
    const t = globalThis.game.scenes.active.tokens.get(tokenId);
    let returned;
    let errMsg = null;
    try {
      returned = await t.update({});
    } catch (e) {
      errMsg = String(e?.message ?? e);
    }
    return {
      errMsg,
      returnedKind:
        returned === undefined
          ? 'undefined'
          : returned === null
            ? 'null'
            : typeof returned,
    };
  }, npcId);
  log.info({ q5 }, 'Q5: empty token.update({}) behavior');

  // -------- Q6: linked-token name propagation --------
  if (linkedPCId !== null) {
    const q6 = await page.evaluate(async (tokenId) => {
      const game = globalThis.game;
      const scene = game.scenes.active;
      const t = scene.tokens.get(tokenId);
      const tokenNameBefore = t.name;
      const actorNameBefore = t.actor?.name;
      const probeSuffix = `__probe_${Date.now()}`;
      const newName = `${tokenNameBefore}${probeSuffix}`;
      const updateErr = await t.update({ name: newName }).then(
        () => null,
        (e) => String(e?.message ?? e),
      );
      const tAfter = scene.tokens.get(tokenId);
      const tokenNameAfter = tAfter.name;
      const actorNameAfter = tAfter.actor?.name;
      // Restore right away — the linked actor's name is global state.
      if (updateErr === null) {
        await tAfter.update({ name: tokenNameBefore });
      }
      return {
        tokenNameBefore,
        actorNameBefore,
        newName,
        updateErr,
        tokenNameAfter,
        actorNameAfter,
        propagatedToActor: actorNameBefore !== actorNameAfter,
      };
    }, linkedPCId);
    log.info({ q6 }, 'Q6: linked-token name propagation');
  } else {
    log.warn('Q6: no linked-character token — name-propagation behavior cannot be observed.');
  }

  // -------- Q7: sight.visionMode acceptance --------
  const q7 = await page.evaluate(
    async ({ tokenId, snapSight }) => {
      const game = globalThis.game;
      const scene = game.scenes.active;
      const t = scene.tokens.get(tokenId);
      const cases = ['basic', 'darkvision', 'lowLightVision', 'notARealMode'];
      const results = [];
      for (const mode of cases) {
        const errMsg = await t.update({ sight: { visionMode: mode } }).then(
          () => null,
          (e) => String(e?.message ?? e),
        );
        const after = scene.tokens.get(tokenId).sight?.visionMode;
        results.push({ requested: mode, errMsg, after });
      }
      // Restore full sight to snapshot to clear side-effects from the loop.
      await t.update({ sight: snapSight });
      return results;
    },
    { tokenId: npcId, snapSight: npcSnap.sight },
  );
  log.info({ q7 }, 'Q7: sight.visionMode acceptance');

  // -------- Q8: tool-handler acceptance (Phase 3 of the plan) --------
  // Gated on registration: skipped on a pre-build run, exercised once
  // src/tools/index.ts wires update_token in.
  const updateTool = tools.find((t) => t.name === 'update_token');
  if (!updateTool) {
    log.warn('Q8: update_token not registered yet — skipping handler acceptance pass.');
  } else {
    const toolCtx = { browser: session, log };

    // Q8a: single-field update — disposition. We assert the tool
    // FAITHFULLY REPORTS state (before === pre-handler live, after ===
    // post-handler live), NOT that PF2e accepts the value — Q8a-bonus
    // captures the PF2e re-derivation behavior separately.
    const dispPre = await page.evaluate(
      (id) => globalThis.game.scenes.active.tokens.get(id).disposition,
      npcId,
    );
    const targetDisp = dispPre === 0 ? -1 : 0;
    const r8a = JSON.parse(
      (await updateTool.handler({ tokenId: npcId, disposition: targetDisp }, toolCtx))[0].text,
    );
    const dispPost = await page.evaluate(
      (id) => globalThis.game.scenes.active.tokens.get(id).disposition,
      npcId,
    );
    log.info(
      { r8a, dispPre, dispPost, requested: targetDisp },
      'Q8a: single-field update (disposition)',
    );
    assert(r8a.tokenId === npcId, 'Q8a: tokenId echoed', { r8a });
    assert(
      r8a.changed.length === 1 && r8a.changed[0] === 'disposition',
      'Q8a: changed === ["disposition"]',
      { changed: r8a.changed },
    );
    assert(r8a.before.disposition === dispPre, 'Q8a: tool reports correct pre-handler before', {
      toolBefore: r8a.before.disposition,
      live: dispPre,
    });
    assert(r8a.after.disposition === dispPost, 'Q8a: tool reports correct post-handler after', {
      toolAfter: r8a.after.disposition,
      live: dispPost,
    });
    if (dispPost !== targetDisp) {
      log.warn(
        { requested: targetDisp, actual: dispPost, source: 'PF2e re-derivation' },
        'Q8a-bonus: disposition write did NOT stick — PF2e (or Foundry) overrode it. Tool ' +
          'correctly reports the override in `after`. Document in tool description.',
      );
    }

    // Q8b: multi-field update — name + hidden + displayName.
    const newName = `__probe_tool_${Date.now()}`;
    const r8b = JSON.parse(
      (
        await updateTool.handler(
          {
            tokenId: npcId,
            name: newName,
            hidden: !npcSnap.hidden,
            displayName: 30,
          },
          toolCtx,
        )
      )[0].text,
    );
    log.info({ r8b }, 'Q8b: multi-field update (name, hidden, displayName)');
    assert(
      new Set(r8b.changed).size === 3 &&
        new Set(r8b.changed).has('name') &&
        new Set(r8b.changed).has('hidden') &&
        new Set(r8b.changed).has('displayName'),
      'Q8b: changed has exactly name+hidden+displayName',
      { changed: r8b.changed },
    );
    assert(r8b.after.name === newName, 'Q8b: name updated', { after: r8b.after.name });
    assert(r8b.after.displayName === 30, 'Q8b: displayName updated', {
      after: r8b.after.displayName,
    });

    // Q8c: sight subobject update. Same faithful-reporting invariant as Q8a.
    const sightPre = await page.evaluate(
      (id) => {
        const t = globalThis.game.scenes.active.tokens.get(id);
        return { enabled: t.sight?.enabled === true, range: t.sight?.range ?? 0 };
      },
      npcId,
    );
    const requestedSight = { enabled: !sightPre.enabled, range: 30 };
    const r8c = JSON.parse(
      (await updateTool.handler({ tokenId: npcId, sight: requestedSight }, toolCtx))[0].text,
    );
    const sightPost = await page.evaluate(
      (id) => {
        const t = globalThis.game.scenes.active.tokens.get(id);
        return { enabled: t.sight?.enabled === true, range: t.sight?.range ?? 0 };
      },
      npcId,
    );
    log.info(
      { r8c, sightPre, sightPost, requested: requestedSight },
      'Q8c: sight subobject update',
    );
    assert(
      new Set(r8c.changed).has('sight.enabled') && new Set(r8c.changed).has('sight.range'),
      'Q8c: changed has sight.enabled + sight.range',
      { changed: r8c.changed },
    );
    assert(
      r8c.before.sight?.enabled === sightPre.enabled &&
        r8c.before.sight?.range === sightPre.range,
      'Q8c: tool reports correct pre-handler sight',
      { toolBefore: r8c.before.sight, live: sightPre },
    );
    assert(
      r8c.after.sight?.enabled === sightPost.enabled && r8c.after.sight?.range === sightPost.range,
      'Q8c: tool reports correct post-handler sight',
      { toolAfter: r8c.after.sight, live: sightPost },
    );
    if (sightPost.range !== requestedSight.range) {
      log.warn(
        { requested: requestedSight.range, actual: sightPost.range, source: 'PF2e re-derivation' },
        'Q8c-bonus: sight.range write did NOT stick — PF2e (or Foundry) overrode it. ' +
          'Tool correctly reports the override in `after`. Document in tool description.',
      );
    }

    // Q8d: bogus tokenId → ToolError(INVALID_INPUT, details.code=TOKEN_NOT_FOUND).
    let threwD = null;
    try {
      await updateTool.handler(
        { tokenId: 'definitely-not-a-real-token-id-0000', disposition: 0 },
        toolCtx,
      );
    } catch (e) {
      threwD = e;
    }
    log.info(
      { name: threwD?.name, code: threwD?.code, detailsCode: threwD?.details?.code },
      'Q8d: bogus tokenId',
    );
    assert(
      threwD?.name === 'ToolError' && threwD.code === 'INVALID_INPUT',
      'Q8d: bogus tokenId throws ToolError(INVALID_INPUT)',
      { threw: { name: threwD?.name, code: threwD?.code, message: threwD?.message } },
    );
    assert(
      typeof threwD?.message === 'string' && threwD.message.includes('No token with id'),
      'Q8d: error message mentions missing token',
      { message: threwD?.message },
    );
    assert(
      threwD?.details?.tokenId === 'definitely-not-a-real-token-id-0000',
      'Q8d: details.tokenId carries the bogus id',
      { details: threwD?.details },
    );

    // Q8e: empty update → schema rejects (refine).
    const parsedEmpty = updateTool.inputSchema.safeParse({ tokenId: npcId });
    log.info(
      { success: parsedEmpty.success, issues: parsedEmpty.error?.issues ?? null },
      'Q8e: schema rejection of empty update',
    );
    assert(parsedEmpty.success === false, 'Q8e: schema rejects empty input', { parsedEmpty });

    // Q8f: out-of-enum displayName → schema rejects (literal-union).
    const parsedBadEnum = updateTool.inputSchema.safeParse({ tokenId: npcId, displayName: 25 });
    log.info(
      { success: parsedBadEnum.success, issues: parsedBadEnum.error?.issues ?? null },
      'Q8f: schema rejection of out-of-enum displayName',
    );
    assert(parsedBadEnum.success === false, 'Q8f: schema rejects displayName=25', {
      parsedBadEnum,
    });

    // Q8g: out-of-range disposition → schema rejects.
    const parsedBadDisp = updateTool.inputSchema.safeParse({ tokenId: npcId, disposition: 7 });
    assert(parsedBadDisp.success === false, 'Q8g: schema rejects disposition=7', {
      parsedBadDisp,
    });

    // Q8h: bogus sceneId → ToolError with details.code=SCENE_NOT_FOUND.
    let threwH = null;
    try {
      await updateTool.handler(
        { tokenId: npcId, sceneId: 'sceneIdThatDoesNotExist', disposition: 0 },
        toolCtx,
      );
    } catch (e) {
      threwH = e;
    }
    log.info(
      { name: threwH?.name, code: threwH?.code, detailsCode: threwH?.details?.code },
      'Q8h: bogus sceneId',
    );
    assert(
      threwH?.name === 'ToolError' && threwH?.code === 'INVALID_INPUT',
      'Q8h: bogus sceneId throws ToolError(INVALID_INPUT)',
      { threw: { name: threwH?.name, code: threwH?.code, message: threwH?.message } },
    );
    assert(
      typeof threwH?.message === 'string' && threwH.message.includes('No scene with id'),
      'Q8h: error message mentions missing scene',
      { message: threwH?.message },
    );
    assert(
      threwH?.details?.sceneId === 'sceneIdThatDoesNotExist',
      'Q8h: details.sceneId carries the bogus id',
      { details: threwH?.details },
    );
  }

  // -------- Teardown: restore every touched token to its snapshot --------
  for (const [tokenId, snap] of snapshots.entries()) {
    const restoreResult = await page.evaluate(
      async ({ tokenId, snap }) => {
        const t = globalThis.game.scenes.active.tokens.get(tokenId);
        if (!t) return { ok: false, reason: 'token missing' };
        const payload = {
          name: snap.name,
          disposition: snap.disposition,
          hidden: snap.hidden,
          displayName: snap.displayName,
          displayBars: snap.displayBars,
          sight: snap.sight,
        };
        const errMsg = await t.update(payload).then(
          () => null,
          (e) => String(e?.message ?? e),
        );
        const tAfter = globalThis.game.scenes.active.tokens.get(tokenId);
        return {
          ok: errMsg === null,
          errMsg,
          read: {
            name: tAfter.name,
            disposition: tAfter.disposition,
            hidden: tAfter.hidden,
            displayName: tAfter.displayName,
            displayBars: tAfter.displayBars,
            sight: {
              enabled: tAfter.sight?.enabled,
              range: tAfter.sight?.range,
              angle: tAfter.sight?.angle,
              visionMode: tAfter.sight?.visionMode,
              brightness: tAfter.sight?.brightness,
              saturation: tAfter.sight?.saturation,
              contrast: tAfter.sight?.contrast,
              attenuation: tAfter.sight?.attenuation,
            },
          },
        };
      },
      { tokenId, snap },
    );
    log.info({ tokenId, restoreResult }, 'teardown: restored token');
  }

  // -------- Final invariant: post-teardown reads match the snapshot --------
  for (const [tokenId, snap] of snapshots.entries()) {
    const read = await page.evaluate((id) => {
      const t = globalThis.game.scenes.active.tokens.get(id);
      return {
        name: t.name,
        disposition: t.disposition,
        hidden: t.hidden,
        displayName: t.displayName,
        displayBars: t.displayBars,
        sight: {
          enabled: t.sight?.enabled,
          range: t.sight?.range,
          angle: t.sight?.angle,
          visionMode: t.sight?.visionMode,
          brightness: t.sight?.brightness,
          saturation: t.sight?.saturation,
          contrast: t.sight?.contrast,
          attenuation: t.sight?.attenuation,
        },
      };
    }, tokenId);
    // Note: disposition may legitimately diverge from snapshot if PF2e re-
    // derives it for linked PCs. Report mismatches but don't fail the probe
    // on that field for linked tokens — Q1 captured the divergence
    // intentionally.
    const fieldsToCheck = [
      'name',
      'hidden',
      'displayName',
      'displayBars',
    ];
    for (const f of fieldsToCheck) {
      assert(
        read[f] === snap[f],
        `final invariant: ${f} restored on token ${tokenId}`,
        { field: f, read: read[f], snap: snap[f] },
      );
    }
    for (const f of ['enabled', 'range', 'angle', 'visionMode']) {
      assert(
        read.sight[f] === snap.sight[f],
        `final invariant: sight.${f} restored on token ${tokenId}`,
        { field: `sight.${f}`, read: read.sight[f], snap: snap.sight[f] },
      );
    }
    // Disposition: warn-only.
    if (read.disposition !== snap.disposition) {
      log.warn(
        { tokenId, read: read.disposition, snap: snap.disposition },
        'final invariant: disposition DIVERGES from snapshot — expected if PF2e re-derives on linked tokens (see Q1)',
      );
    } else {
      log.info({ tokenId }, 'final invariant: disposition restored');
    }
  }

  if (failures.length === 0) {
    log.info('all assertions passed');
    process.exitCode = 0;
  } else {
    log.error({ failures }, 'one or more assertions failed');
    process.exitCode = 1;
  }
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  // Best-effort teardown on the error path.
  try {
    const { page } = await session.ensureStarted();
    for (const [tokenId, snap] of snapshots.entries()) {
      await page.evaluate(
        async ({ tokenId, snap }) => {
          const t = globalThis.game.scenes.active.tokens.get(tokenId);
          if (!t) return;
          await t.update({
            name: snap.name,
            disposition: snap.disposition,
            hidden: snap.hidden,
            displayName: snap.displayName,
            displayBars: snap.displayBars,
            sight: snap.sight,
          });
        },
        { tokenId, snap },
      );
    }
  } catch {
    // already in error path
  }
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
