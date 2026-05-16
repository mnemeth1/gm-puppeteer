/**
 * Stage 0 design-blocking probe for the compendium-cache work. Run BEFORE
 * building the cache shell; the answers decide which parts of the design
 * actually need to ship.
 *
 * Read-only. No world mutations.
 *
 * Findings expected:
 *   Q1. Does Foundry v14 / PF2e 8.1.2 internally cache pack.getDocument(id)?
 *       Call twice on the same id, time both, check reference identity, and
 *       inspect pack.contents / pack.get(id) before and after. Decision
 *       rule: if secondMs < 5 ms AND a === b → drop cache.docs from the
 *       design; the warm just pre-loads and CompendiumCollection holds it.
 *   Q2. Does pack.getIndex({ fields }) cache when called twice with the
 *       same field set? Time both. Time a third call with a different
 *       field set as a control. If second call is sub-5 ms → drop
 *       cache.indexes too.
 *   Q3. Per-pack `locked` flag. Locked PF2e system packs can't mutate, so
 *       storing a live doc reference is safe and cheaper than .toObject().
 *       Reports per pack.
 *   Q4. Empirical bestiary-pack predicate input. Enumerate every
 *       game.packs entry with collection, documentName, metadata.system,
 *       metadata.packageType, total entries, type counts, locked. The
 *       warm-time predicate is chosen from this enumeration, not guessed.
 *
 *   npm run build && node scripts/probe-compendium-doc-cache.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const findings = [];
const errors = [];

function record(probeId, label, value) {
  findings.push({ probeId, label, value });
  log.info({ probeId, label, value }, 'finding');
}

function fail(probeId, label, ctx) {
  errors.push({ probeId, label, ctx });
  log.error({ probeId, label, ctx }, 'PROBE FAILURE');
}

// Mirror of the widened-fields array in src/evaluators/search-compendium.ts.
// Kept here verbatim so the index-cache probe exercises the exact field set
// the production tool uses.
const WIDENED_FIELDS = [
  'system.details.level.value',
  'system.level.value',
  'system.traits.value',
  'system.traits.rarity',
  'system.details.publication.title',
  'system.publication.title',
];

// A second field set, structurally different from WIDENED_FIELDS, used as
// a control in Q2 to see whether Foundry detects the field-set change and
// rebuilds vs returning a stale cached index missing the new paths.
const ALT_FIELDS = [
  'system.details.level.value',
  'system.traits.value',
  'system.details.alignment.value',
  'system.attributes.hp.value',
];

try {
  const { page } = await session.ensureStarted();

  // ====================================================================
  // Q4. Pack enumeration (runs first; downstream probes pick targets
  //     from this output).
  // ====================================================================
  const packInventory = await page.evaluate(async () => {
    const packsArr = globalThis.game?.packs ? Array.from(globalThis.game.packs) : [];
    const out = [];
    for (const pack of packsArr) {
      let total = 0;
      const typesSeen = {};
      let indexErr = null;
      try {
        const idx = await pack.getIndex();
        total = idx.contents.length;
        for (const e of idx.contents) {
          const t = e.type ?? '?';
          typesSeen[t] = (typesSeen[t] ?? 0) + 1;
        }
      } catch (err) {
        indexErr = err?.message ?? String(err);
      }
      out.push({
        collection: pack.collection,
        documentName: pack.documentName,
        title: pack.title,
        packageType: pack.metadata?.packageType ?? null,
        system: pack.metadata?.system ?? null,
        label: pack.metadata?.label ?? null,
        locked: pack.locked ?? null,
        total,
        typesSeen,
        indexErr,
      });
    }
    return out;
  });
  record(
    'Q4',
    'pack inventory (collection, documentName, packageType, system, locked, total, types)',
    packInventory,
  );

  // Pick a mid-size Actor pack with majority-npc content for the doc-cache
  // and index-cache timing tests. Prefer 100-300 entries to keep probe fast.
  const actorPacks = packInventory.filter(
    (p) => p.documentName === 'Actor' && (p.typesSeen.npc ?? 0) > 0,
  );
  const midSizeBestiary =
    actorPacks
      .filter((p) => p.total >= 100 && p.total <= 300)
      .sort((a, b) => a.total - b.total)[0] ?? actorPacks.sort((a, b) => a.total - b.total)[0];

  if (!midSizeBestiary) {
    fail('Q4', 'no Actor pack with npc entries found — Q1/Q2 cannot run', { actorPacks });
  }

  log.info(
    {
      target: midSizeBestiary?.collection ?? null,
      total: midSizeBestiary?.total ?? null,
      locked: midSizeBestiary?.locked ?? null,
    },
    'Q1/Q2 target pack',
  );

  // ====================================================================
  // Q1. Foundry-internal doc cache test.
  //
  //   For each of N=5 random ids in the target pack:
  //     - snapshot pre-state (pack.contents.length, pack.get(id))
  //     - call pack.getDocument(id), time it → docA
  //     - snapshot post-state (did pack.contents grow? is pack.get(id) === docA?)
  //     - call pack.getDocument(id) again, time it → docB
  //     - check docA === docB (reference identity)
  //
  //   Decision rule (interpreted by the human reading the probe output):
  //     - secondMs consistently < 5 ms AND docA === docB → Foundry caches.
  //       Our design drops cache.docs.
  //     - secondMs ≈ firstMs OR docA !== docB → we own the doc map.
  // ====================================================================
  if (midSizeBestiary) {
    const docCache = await page.evaluate(async (collection) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };

      const idx = await pack.getIndex();
      const allIds = idx.contents.map((e) => e._id).filter(Boolean);
      if (allIds.length < 5) {
        return { error: `pack ${collection} has fewer than 5 entries (${allIds.length})` };
      }

      // Pick 5 spread-out ids (front, middle, end, plus two random) so a
      // cache that's LRU-style won't accidentally pass.
      const pick = (i) => allIds[Math.floor(i)];
      const picks = [
        pick(0),
        pick(allIds.length / 4),
        pick(allIds.length / 2),
        pick((allIds.length * 3) / 4),
        pick(allIds.length - 1),
      ];

      // Snapshot what cache-shaped state the pack exposes BEFORE any
      // getDocument call has been made in this probe. Note: prior tool
      // calls in this MCP session may have already touched some docs,
      // so we capture this for context, not as proof of a cold cache.
      const preState = {
        contentsLength: pack.contents?.length ?? null,
        documentsSize: typeof pack.documents?.size === 'number' ? pack.documents.size : null,
        indexSize: pack.index?.size ?? null,
      };

      const results = [];
      for (const id of picks) {
        const beforeGet = pack.get?.(id) ?? null;
        const t1 = performance.now();
        const docA = await pack.getDocument(id);
        const t2 = performance.now();
        const afterFirst = pack.get?.(id) ?? null;
        const t3 = performance.now();
        const docB = await pack.getDocument(id);
        const t4 = performance.now();

        results.push({
          id,
          firstMs: +(t2 - t1).toFixed(2),
          secondMs: +(t4 - t3).toFixed(2),
          identityAEqualsB: docA === docB,
          packGetReturnedFirstBeforeFetch: beforeGet === docA,
          packGetReturnsAfterFetch: afterFirst === docA,
          packGetReturnsAfterFetchType:
            afterFirst === null ? 'null' : afterFirst === docA ? 'same' : 'different',
          docAName: docA?.name ?? null,
          docAType: docA?.type ?? null,
        });
      }

      const postState = {
        contentsLength: pack.contents?.length ?? null,
        documentsSize: typeof pack.documents?.size === 'number' ? pack.documents.size : null,
        indexSize: pack.index?.size ?? null,
      };

      const firstMsAvg = results.reduce((s, r) => s + r.firstMs, 0) / results.length;
      const secondMsAvg = results.reduce((s, r) => s + r.secondMs, 0) / results.length;
      const allIdentical = results.every((r) => r.identityAEqualsB === true);
      const allFastOnSecond = results.every((r) => r.secondMs < 5);

      return {
        collection,
        preState,
        postState,
        contentsGrew:
          preState.contentsLength !== null &&
          postState.contentsLength !== null &&
          postState.contentsLength > preState.contentsLength,
        results,
        firstMsAvg: +firstMsAvg.toFixed(2),
        secondMsAvg: +secondMsAvg.toFixed(2),
        verdict: {
          allIdenticalReferences: allIdentical,
          allFastOnSecondCall: allFastOnSecond,
          foundryCachesDocsLikely: allIdentical && allFastOnSecond,
        },
      };
    }, midSizeBestiary.collection);
    record('Q1', 'pack.getDocument cache behavior — 5 ids, two calls each', docCache);
  }

  // ====================================================================
  // Q2. Foundry-internal index cache test.
  //
  //   Same target pack. Sequence:
  //     - call pack.getIndex({ fields: WIDENED_FIELDS }), time → idx1
  //     - call pack.getIndex({ fields: WIDENED_FIELDS }) again, time → idx2
  //     - call pack.getIndex({ fields: ALT_FIELDS }), time → idx3
  //   Compare:
  //     - timing across the three
  //     - identity (idx1 === idx2? idx1.contents === idx2.contents?)
  //     - field coverage on idx3.contents[0] — did the new field show up?
  //
  //   Decision rule:
  //     - secondMs < 5 ms AND idx1 === idx2 → Foundry caches widened index;
  //       drop cache.indexes from the design.
  //     - idx3 with new field: if the new field IS populated AND idx3 was
  //       slow → cache invalidates on field-set change (expected).
  //                       if the new field is NOT populated → Foundry
  //       returns a stale cached index regardless of fields, and we own
  //       the cache (or have to call with a superset).
  // ====================================================================
  if (midSizeBestiary) {
    const indexCache = await page.evaluate(
      async ({ collection, widenedFields, altFields }) => {
        const pack = globalThis.game.packs?.get(collection);
        if (!pack) return { error: `pack ${collection} not loaded` };

        const t1 = performance.now();
        const idx1 = await pack.getIndex({ fields: widenedFields });
        const t2 = performance.now();
        const idx2 = await pack.getIndex({ fields: widenedFields });
        const t3 = performance.now();
        const idx3 = await pack.getIndex({ fields: altFields });
        const t4 = performance.now();

        const sampleEntry = (idx) => {
          const e = idx.contents[0];
          if (!e) return null;
          return {
            keys: Object.keys(e),
            systemKeys: e.system ? Object.keys(e.system) : null,
            hasLevel:
              e.system?.details?.level?.value !== undefined || e.system?.level?.value !== undefined,
            hasTraitsValue: Array.isArray(e.system?.traits?.value),
            hasRarity: typeof e.system?.traits?.rarity === 'string',
            hasPublication:
              typeof e.system?.publication?.title === 'string' ||
              typeof e.system?.details?.publication?.title === 'string',
            // ALT_FIELDS specific: did the alignment / hp fields make it
            // onto the projected entry?
            hasAlignment: typeof e.system?.details?.alignment?.value === 'string',
            hasHp:
              typeof e.system?.attributes?.hp?.value === 'number' ||
              typeof e.system?.attributes?.hp?.value === 'string',
          };
        };

        return {
          collection,
          firstMs: +(t2 - t1).toFixed(2),
          secondMs: +(t3 - t2).toFixed(2),
          thirdMsAltFields: +(t4 - t3).toFixed(2),
          identityIdx1EqualsIdx2: idx1 === idx2,
          identityContentsArrEqual: idx1.contents === idx2.contents,
          identityContents0Equal: idx1.contents[0] === idx2.contents[0],
          widenedSample: sampleEntry(idx1),
          widenedSecondSample: sampleEntry(idx2),
          altFieldsSample: sampleEntry(idx3),
          verdict: {
            secondCallFast: +(t3 - t2).toFixed(2) < 5,
            // If the alt-fields call gives back an index with NEITHER the
            // alt-only fields populated NOR a noticeable rebuild cost, then
            // Foundry is serving a stale cache by ignoring the field arg.
            altFieldsAppearedToRebuild: +(t4 - t3).toFixed(2) > 50,
          },
        };
      },
      {
        collection: midSizeBestiary.collection,
        widenedFields: WIDENED_FIELDS,
        altFields: ALT_FIELDS,
      },
    );
    record('Q2', 'pack.getIndex cache behavior — same fields twice, then alt fields', indexCache);
  }

  // ====================================================================
  // Q3. Per-pack locked flag, broken out for design clarity.
  //
  //   The pack inventory above already includes `locked`, but
  //   summarizing here makes the "which packs are safe to store live
  //   references for" decision explicit. Locked === true means the pack
  //   contents can't mutate during the session, so doc cache entries can
  //   be live object references rather than .toObject() payloads.
  // ====================================================================
  const lockedSummary = {
    lockedActorPacks: packInventory
      .filter((p) => p.documentName === 'Actor' && p.locked === true)
      .map((p) => ({ collection: p.collection, total: p.total })),
    unlockedActorPacks: packInventory
      .filter((p) => p.documentName === 'Actor' && p.locked !== true)
      .map((p) => ({ collection: p.collection, total: p.total, locked: p.locked })),
    lockedItemPacks: packInventory
      .filter((p) => p.documentName === 'Item' && p.locked === true)
      .map((p) => ({ collection: p.collection, total: p.total })),
    unlockedItemPacks: packInventory
      .filter((p) => p.documentName === 'Item' && p.locked !== true)
      .map((p) => ({ collection: p.collection, total: p.total, locked: p.locked })),
  };
  record('Q3', 'locked-flag summary by documentName', lockedSummary);

  // ====================================================================
  // Summary.
  // ====================================================================
  log.info(
    {
      findingCount: findings.length,
      errorCount: errors.length,
      errors,
    },
    'STAGE 0 doc-cache PROBE SUMMARY',
  );
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'doc-cache probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
