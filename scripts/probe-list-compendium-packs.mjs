/**
 * One-shot read-only probe: log in to live headless Foundry and answer the
 * v14.361 + PF2e 8.1.2 API questions that gate the list_compendium_packs
 * impl.
 *
 * No mutation, no cleanup. Just enumerate game.packs and dump the metadata
 * fields the projection wants to surface.
 *
 * Questions:
 *   1. game.packs enumeration — total count via Array.from(game.packs).
 *      Decides whether the registry is iterable (it is) and whether the
 *      result has the duck-typed CompendiumCollection shape we expect.
 *   2. Field presence per pack — for every pack, count packs missing
 *      string `collection` or `documentName`. Expect 0/0; these are the
 *      primary key + the row's documentType column.
 *   3. documentName distribution — histogram of all documentName values.
 *      Expect a mix of Actor, Item, JournalEntry, RollTable, Macro,
 *      Scene; possibly Adventure / Cards. Informs the description's type
 *      list.
 *   4. metadata shape — log the full Object.keys() set across every pack
 *      and dump the metadata object for 3 sample packs. We need to find
 *      the field that best represents "system" (the source package): in
 *      v14 the CompendiumCollection's metadata typically carries
 *      `packageName` (e.g. 'pf2e') and `packageType` ('system' | 'module'
 *      | 'world'); we also check for a literal `system` field for
 *      completeness. Decides the system-extraction rule for the
 *      evaluator.
 *   5. Label cascade — for every pack, compare metadata.label, title,
 *      and collection. We want to confirm the cascade
 *      (metadata?.label ?? title ?? collection) matches what
 *      search-compendium already uses. Log any pack where the three
 *      values would diverge so we know which level of the cascade
 *      actually fires in practice.
 *   6. Projection preview — dump 5 sample rows with the v1 projection
 *      {id, label, system, documentType} for eyeball verification.
 *
 *   npm run build && node scripts/probe-list-compendium-packs.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const enumeration = await page.evaluate(() => {
    const game = globalThis.game;
    const all = game?.packs ? Array.from(game.packs) : [];

    let collectionMissing = 0;
    let collectionNonString = 0;
    let documentNameMissing = 0;
    let documentNameNonString = 0;
    const documentNameCounts = {};
    const metadataKeysUnion = new Set();
    const metadataSamples = [];
    let packageNamePresent = 0;
    let packageTypePresent = 0;
    let systemFieldPresent = 0;
    let metadataLabelPresent = 0;
    let titlePresent = 0;
    let divergentLabelRows = 0;
    const divergentLabelSamples = [];
    const previewRows = [];

    for (const pack of all) {
      const collection = pack?.collection;
      if (collection == null) collectionMissing += 1;
      else if (typeof collection !== 'string') collectionNonString += 1;

      const documentName = pack?.documentName;
      if (documentName == null) documentNameMissing += 1;
      else if (typeof documentName !== 'string') documentNameNonString += 1;
      const dt = typeof documentName === 'string' ? documentName : '<missing>';
      documentNameCounts[dt] = (documentNameCounts[dt] ?? 0) + 1;

      const metadata = pack?.metadata;
      if (metadata && typeof metadata === 'object') {
        for (const k of Object.keys(metadata)) metadataKeysUnion.add(k);
        if (typeof metadata.packageName === 'string' && metadata.packageName.length > 0)
          packageNamePresent += 1;
        if (typeof metadata.packageType === 'string' && metadata.packageType.length > 0)
          packageTypePresent += 1;
        if (typeof metadata.system === 'string' && metadata.system.length > 0)
          systemFieldPresent += 1;
        if (typeof metadata.label === 'string' && metadata.label.length > 0)
          metadataLabelPresent += 1;

        if (metadataSamples.length < 3) {
          // Shallow projection: drop nested objects but keep primitives so
          // pino can log it cleanly.
          const shallow = {};
          for (const [k, v] of Object.entries(metadata)) {
            if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
              shallow[k] = v;
            } else if (Array.isArray(v)) {
              shallow[k] = `<array len=${v.length}>`;
            } else {
              shallow[k] = `<${typeof v}>`;
            }
          }
          metadataSamples.push({
            collection: typeof collection === 'string' ? collection : null,
            metadata: shallow,
          });
        }
      }

      const title = pack?.title;
      if (typeof title === 'string' && title.length > 0) titlePresent += 1;

      // Cascade comparison: which level actually fires?
      const metaLabel =
        metadata && typeof metadata.label === 'string' && metadata.label.length > 0
          ? metadata.label
          : null;
      const titleVal = typeof title === 'string' && title.length > 0 ? title : null;
      const collectionVal = typeof collection === 'string' ? collection : null;
      const picked = metaLabel ?? titleVal ?? collectionVal;
      // Divergent if metaLabel, title, and collection are not all equal
      // (excluding nulls). We're mostly interested in when metaLabel is
      // missing — that's where the fallback fires.
      if (
        (metaLabel === null && titleVal !== null) ||
        (metaLabel === null && titleVal === null && collectionVal !== null)
      ) {
        divergentLabelRows += 1;
        if (divergentLabelSamples.length < 5) {
          divergentLabelSamples.push({
            collection: collectionVal,
            metaLabel,
            title: titleVal,
            picked,
          });
        }
      }

      // Preview row for first 5 packs
      if (previewRows.length < 5) {
        const id = typeof collection === 'string' ? collection : '';
        const label = picked ?? id;
        const packageName =
          metadata && typeof metadata.packageName === 'string' ? metadata.packageName : null;
        const prefix = id.includes('.') ? id.slice(0, id.indexOf('.')) : id;
        const systemForRow = packageName ?? prefix;
        previewRows.push({
          id,
          label,
          system: systemForRow,
          documentType: typeof documentName === 'string' ? documentName : '',
        });
      }
    }

    return {
      total: all.length,
      collectionMissing,
      collectionNonString,
      documentNameMissing,
      documentNameNonString,
      documentNameCounts,
      metadataKeysUnion: Array.from(metadataKeysUnion).sort(),
      metadataSamples,
      packageNamePresent,
      packageTypePresent,
      systemFieldPresent,
      metadataLabelPresent,
      titlePresent,
      divergentLabelRows,
      divergentLabelSamples,
      previewRows,
    };
  });

  log.info({ total: enumeration.total }, 'Q1: game.packs total count');
  log.info(
    {
      collectionMissing: enumeration.collectionMissing,
      collectionNonString: enumeration.collectionNonString,
      documentNameMissing: enumeration.documentNameMissing,
      documentNameNonString: enumeration.documentNameNonString,
    },
    'Q2: collection / documentName presence (expect 0 / 0 / 0 / 0)',
  );
  log.info(
    { documentNameCounts: enumeration.documentNameCounts },
    'Q3: documentName distribution',
  );
  log.info(
    {
      metadataKeysUnion: enumeration.metadataKeysUnion,
      packageNamePresent: enumeration.packageNamePresent,
      packageTypePresent: enumeration.packageTypePresent,
      systemFieldPresent: enumeration.systemFieldPresent,
      metadataLabelPresent: enumeration.metadataLabelPresent,
      titlePresent: enumeration.titlePresent,
      samples: enumeration.metadataSamples,
      total: enumeration.total,
    },
    'Q4: metadata shape & system-source candidates (counts out of total)',
  );
  log.info(
    {
      divergentLabelRows: enumeration.divergentLabelRows,
      samples: enumeration.divergentLabelSamples,
    },
    'Q5: label cascade — packs where metadata.label is absent (fallback fires)',
  );
  log.info({ rows: enumeration.previewRows }, 'Q6: projection preview (first 5 packs)');

  process.exitCode = 0;
} catch (err) {
  log.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'probe failed',
  );
  process.exitCode = 1;
} finally {
  await session.stop().catch(() => undefined);
}
