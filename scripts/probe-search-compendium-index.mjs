/**
 * Phase 1 design-blocking probes for the search_compendium structured-
 * filter extension. Run BEFORE the evaluator is extended; the two-stage
 * filter design hangs on the answers.
 *
 * Read-only. Discovers packs and samples a few documents per shape; no
 * world mutations.
 *
 * Findings expected:
 *   Q0. Pack inventory — every pack, its documentName, entry-type
 *       counts, total size. Identifies an item pack, an NPC pack, a
 *       hazard pack, a familiar pack for downstream probes.
 *   Q1. Index field coverage — which of {type, level, traits, rarity,
 *       source/publication, img} are present on `index.contents[0]`
 *       WITHOUT calling `getDocument()`? Sampled on one actor pack and
 *       one item pack.
 *   Q2. Can `Compendium.configure({ indexFields: [...] })` (or whatever
 *       v14 API hangs off `pack.compendium` / `pack.constructor`) be
 *       used to widen the cheap fields? Probe whether `pack.indexFields`
 *       reveals what's configured. If PF2e already widens it, we get
 *       the fields free.
 *   Q3. Full-doc load timing — `Promise.all(...getDocument)` on a
 *       small (~200) and a large (~1000) pack. Decision input for
 *       `descriptionMatch` perf characterization.
 *   Q4. Hazard / familiar pack discovery — confirm `pf2e.hazards` (or
 *       similar) and surface any familiar-bearing pack.
 *   Q5. Description-field paths per doc type — what `system.description.*`
 *       / `system.details.publicNotes` etc shape do NPCs, items, hazards,
 *       and familiars use? Confirms the existing `describe()` paths in
 *       search-compendium.ts cover all four.
 *
 *   npm run build && node scripts/probe-search-compendium-index.mjs
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

try {
  const { page } = await session.ensureStarted();

  // ====================================================================
  // Q0. Pack inventory.
  // ====================================================================
  const packInventory = await page.evaluate(async () => {
    const out = [];
    const packs = globalThis.game?.packs ? Array.from(globalThis.game.packs) : [];
    for (const pack of packs) {
      let total = 0;
      const typesSeen = {};
      let indexFields = null;
      try {
        // Foundry v14 surfaces configured indexFields on the pack
        // instance. Capture whatever is there for Q2 visibility.
        const cfg = pack.indexFields ?? pack.constructor?.INDEX_FIELDS ?? null;
        if (cfg instanceof Set) indexFields = Array.from(cfg);
        else if (Array.isArray(cfg)) indexFields = cfg.slice();
        else if (cfg && typeof cfg === 'object') indexFields = Object.keys(cfg);
      } catch {
        indexFields = '__error__';
      }
      try {
        const idx = await pack.getIndex();
        total = idx.contents.length;
        for (const e of idx.contents) {
          const t = e.type ?? '?';
          typesSeen[t] = (typesSeen[t] ?? 0) + 1;
        }
      } catch (err) {
        typesSeen.__error = err?.message ?? String(err);
      }
      out.push({
        collection: pack.collection,
        documentName: pack.documentName,
        title: pack.title,
        total,
        typesSeen,
        indexFields,
      });
    }
    return out;
  });
  record('Q0', 'pack inventory', packInventory);

  // Pick concrete targets.
  const itemPack = packInventory
    .filter((p) => p.documentName === 'Item' && p.total > 50)
    .sort((a, b) => a.total - b.total)[0];
  const actorPacks = packInventory.filter((p) => p.documentName === 'Actor');
  const bestiaryPack =
    actorPacks.find((p) => (p.typesSeen.npc ?? 0) > 200) ??
    actorPacks.find((p) => (p.typesSeen.npc ?? 0) > 0);
  const hazardPack = actorPacks.find((p) => (p.typesSeen.hazard ?? 0) > 0);
  const familiarPack = actorPacks.find((p) => (p.typesSeen.familiar ?? 0) > 0);
  const smallPack = packInventory
    .filter((p) => p.documentName === 'Item' && p.total > 50 && p.total < 300)
    .sort((a, b) => a.total - b.total)[0];
  const largePack = packInventory
    .filter((p) => p.documentName === 'Actor' && p.total > 500)
    .sort((a, b) => b.total - a.total)[0];

  log.info(
    {
      itemPack: itemPack?.collection,
      bestiary: bestiaryPack?.collection,
      hazards: hazardPack?.collection,
      familiars: familiarPack?.collection,
      smallPack: smallPack?.collection,
      largePack: largePack?.collection,
    },
    'chosen targets',
  );

  if (!itemPack) fail('Q0', 'no item pack of >50 entries found', { actorPacks });
  if (!bestiaryPack) fail('Q0', 'no actor pack with npc entries found', { actorPacks });

  // ====================================================================
  // Q1. Index field coverage.
  // ====================================================================
  if (itemPack && bestiaryPack) {
    const indexCoverage = await page.evaluate(
      async ({ itemColl, actorColl }) => {
        const probe = async (collection) => {
          const pack = globalThis.game.packs?.get(collection);
          if (!pack) return { error: `pack ${collection} not loaded` };
          const idx = await pack.getIndex();
          const sample = idx.contents.slice(0, 3).map((e) => ({
            keys: Object.keys(e),
            type: e.type ?? null,
            level: e.level ?? null,
            systemLevel: e.system?.level ?? null,
            systemDetailsLevel: e.system?.details?.level ?? null,
            traits: e.traits ?? null,
            systemTraitsValue: e.system?.traits?.value ?? null,
            systemTraitsRarity: e.system?.traits?.rarity ?? null,
            rarity: e.rarity ?? null,
            source: e.source ?? null,
            systemPublicationTitle: e.system?.publication?.title ?? null,
            systemSource: e.system?.source ?? null,
            img: e.img ?? null,
          }));
          return {
            entryCount: idx.contents.length,
            firstEntryAllKeys: idx.contents[0] ? Object.keys(idx.contents[0]) : [],
            sample,
          };
        };
        return {
          itemPack: await probe(itemColl),
          actorPack: await probe(actorColl),
        };
      },
      { itemColl: itemPack.collection, actorColl: bestiaryPack.collection },
    );
    record('Q1', 'index field coverage on first 3 entries', indexCoverage);
  }

  // ====================================================================
  // Q2. Index-field configuration knobs.
  // ====================================================================
  const indexFieldCfg = await page.evaluate(async () => {
    const packsArr = globalThis.game?.packs ? Array.from(globalThis.game.packs) : [];
    const sample = packsArr[0];
    if (!sample) return { error: 'no packs' };
    const result = {
      collectionClassName: sample.constructor?.name ?? null,
      hasIndexFieldsInstance: sample.indexFields !== undefined && sample.indexFields !== null,
      indexFieldsType: sample.indexFields ? sample.indexFields.constructor?.name : null,
      indexFieldsContents:
        sample.indexFields instanceof Set
          ? Array.from(sample.indexFields)
          : (sample.indexFields ?? null),
      ctorIndexFields:
        sample.constructor && 'INDEX_FIELDS' in sample.constructor
          ? sample.constructor.INDEX_FIELDS
          : null,
      ctorConfigureExists: typeof sample.constructor?.configure === 'function',
    };
    return result;
  });
  record('Q2', 'index-field knobs', indexFieldCfg);

  // ====================================================================
  // Q3. Full-doc load timing.
  // ====================================================================
  const timingSubject = smallPack ?? itemPack;
  if (timingSubject) {
    const smallTiming = await page.evaluate(async (collection) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };
      const idx = await pack.getIndex();
      const ids = idx.contents.map((e) => e._id).filter(Boolean);
      const t0 = performance.now();
      const docs = await Promise.all(ids.map((id) => pack.getDocument(id)));
      const t1 = performance.now();
      return { collection, count: docs.length, ms: Math.round(t1 - t0) };
    }, timingSubject.collection);
    record('Q3', 'full-doc load timing — small pack', smallTiming);
  }

  if (largePack) {
    const largeTiming = await page.evaluate(async (collection) => {
      const pack = globalThis.game.packs?.get(collection);
      if (!pack) return { error: `pack ${collection} not loaded` };
      const idx = await pack.getIndex();
      const ids = idx.contents.map((e) => e._id).filter(Boolean);
      const t0 = performance.now();
      const docs = await Promise.all(ids.map((id) => pack.getDocument(id)));
      const t1 = performance.now();
      return { collection, count: docs.length, ms: Math.round(t1 - t0) };
    }, largePack.collection);
    record('Q3', 'full-doc load timing — large pack', largeTiming);
  } else {
    record('Q3', 'no large pack — skipped large timing', null);
  }

  // ====================================================================
  // Q4. Hazard / familiar pack discovery (recorded as part of Q0; this
  // entry is the explicit confirmation for the plan's record).
  // ====================================================================
  record('Q4', 'hazard/familiar pack confirmation', {
    hazardPack: hazardPack?.collection ?? null,
    hazardCount: hazardPack?.typesSeen?.hazard ?? null,
    familiarPack: familiarPack?.collection ?? null,
    familiarCount: familiarPack?.typesSeen?.familiar ?? null,
  });

  // ====================================================================
  // Q5. Description-field paths per doc type.
  // ====================================================================
  const descPaths = await page.evaluate(
    async ({ itemColl, actorColl, hazardColl, familiarColl }) => {
      const out = {};
      const sample = async (collection, label, typeFilter) => {
        if (!collection) return { skipped: 'no pack' };
        const pack = globalThis.game.packs?.get(collection);
        if (!pack) return { error: `pack ${collection} not loaded` };
        const idx = await pack.getIndex();
        const target =
          (typeFilter ? idx.contents.find((e) => e.type === typeFilter) : idx.contents[0]) ?? null;
        if (!target) return { error: `no entry matched filter ${typeFilter}` };
        const doc = await pack.getDocument(target._id);
        const sys = doc?.system ?? {};
        return {
          label,
          docType: doc?.type ?? null,
          name: doc?.name ?? null,
          hasSystemDescriptionValue: typeof sys.description?.value === 'string',
          systemDescriptionValueLen:
            typeof sys.description?.value === 'string' ? sys.description.value.length : null,
          hasDetailsPublicNotes: typeof sys.details?.publicNotes === 'string',
          detailsPublicNotesLen:
            typeof sys.details?.publicNotes === 'string' ? sys.details.publicNotes.length : null,
          hasDetailsAppearance: typeof sys.details?.appearance === 'string',
          detailsAppearanceLen:
            typeof sys.details?.appearance === 'string' ? sys.details.appearance.length : null,
          systemKeys: Object.keys(sys).slice(0, 20),
          detailsKeys: Object.keys(sys.details ?? {}).slice(0, 20),
        };
      };
      out.item = await sample(itemColl, 'item', null);
      out.npc = await sample(actorColl, 'npc', 'npc');
      out.hazard = await sample(hazardColl, 'hazard', 'hazard');
      out.familiar = await sample(familiarColl, 'familiar', 'familiar');
      return out;
    },
    {
      itemColl: itemPack?.collection ?? null,
      actorColl: bestiaryPack?.collection ?? null,
      hazardColl: hazardPack?.collection ?? null,
      familiarColl: familiarPack?.collection ?? null,
    },
  );
  record('Q5', 'description-field paths per doc type', descPaths);

  // ====================================================================
  // Summary.
  // ====================================================================
  log.info(
    {
      findingCount: findings.length,
      errorCount: errors.length,
      errors,
    },
    'PHASE 1 SUMMARY',
  );
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'phase 1 probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
