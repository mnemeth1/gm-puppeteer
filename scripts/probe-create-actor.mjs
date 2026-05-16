/**
 * One-shot probe: log in to the live headless Foundry and answer the
 * v14 API questions that gate the create_actor_from_compendium impl.
 *
 * Specifically:
 *   1. Does fromUuid(uuid) resolve cross-pack without explicit
 *      game.packs.get(packId).getDocument(docId)?
 *   2. Are Actor.create and Actor.implementation.create both functions,
 *      and is one canonical over the other in v14?
 *   3. Does compendiumActor.toObject() produce a plain object that survives
 *      Actor.create()? (Round-trip a real Valeros, then delete the result.)
 *   4. Do prototypeToken.name / prototypeToken.actorLink overrides on the
 *      create payload persist to the created actor's prototype?
 *   5. What actor types does PF2e 8.1.2 actually expose? Confirm "character"
 *      is the right discriminator for "linked by default" PCs.
 *   6. What happens if `folder` is a non-existent ID — silent drop or error?
 *
 *   npm run build && node scripts/probe-create-actor.mjs
 *
 * Cleans up after itself: any actor created during the probe is deleted
 * before exit.
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });

const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  // --- Q1: Find a known compendium actor without hardcoding a UUID. ---
  const valerosLookup = await page.evaluate(async () => {
    const game = globalThis.game;
    const out = { packs: [], valerosUuid: null, packsWithCharacters: [] };
    for (const pack of Array.from(game.packs ?? [])) {
      if (pack.documentName !== 'Actor') continue;
      const index = await pack.getIndex();
      const hit = index.contents.find((e) =>
        (e.name ?? '').toLowerCase().includes('valeros'),
      );
      out.packs.push({
        collection: pack.collection,
        size: index.contents.length,
        sampleNames: index.contents.slice(0, 3).map((e) => e.name),
      });
      if (hit) {
        out.valerosUuid =
          hit.uuid ?? `Compendium.${pack.collection}.Actor.${hit._id}`;
        break;
      }
    }
    return out;
  });
  log.info(
    { foundUuid: valerosLookup.valerosUuid, actorPackCount: valerosLookup.packs.length },
    'Q1: found Valeros via index scan',
  );
  if (!valerosLookup.valerosUuid) {
    log.error('Valeros not in any Actor pack — cannot continue probe');
    process.exitCode = 1;
    throw new Error('no Valeros UUID');
  }

  // --- Q2/Q3: fromUuid resolution + toObject() shape on the same doc. ---
  const fromUuidShape = await page.evaluate(async (uuid) => {
    const doc = await fromUuid(uuid);
    if (!doc) return { resolved: false };
    const obj = doc.toObject();
    return {
      resolved: true,
      docConstructor: doc.constructor?.name,
      documentName: doc.documentName,
      isActor: doc instanceof CONFIG.Actor.documentClass,
      type: doc.type,
      name: doc.name,
      objKeys: Object.keys(obj).slice(0, 20),
      objIdPresent: '_id' in obj,
      objHasPrototypeToken: !!obj.prototypeToken,
      prototypeTokenKeys: obj.prototypeToken
        ? Object.keys(obj.prototypeToken).slice(0, 20)
        : null,
      prototypeTokenName: obj.prototypeToken?.name,
      prototypeTokenActorLink: obj.prototypeToken?.actorLink,
      itemCount: Array.isArray(obj.items) ? obj.items.length : -1,
      effectCount: Array.isArray(obj.effects) ? obj.effects.length : -1,
      // Inspect the create API entry points.
      hasActorCreate: typeof Actor.create === 'function',
      hasActorImplCreate: typeof Actor.implementation?.create === 'function',
      actorImplName: Actor.implementation?.name,
      actorBaseName: Actor.name,
      isImplSubclassOfBase: Actor.implementation?.prototype instanceof Actor,
    };
  }, valerosLookup.valerosUuid);
  log.info({ fromUuidShape }, 'Q2/Q3: fromUuid resolution + toObject shape + create entry points');

  // --- Enumerate the PF2e actor types currently registered. ---
  const pf2eActorTypes = await page.evaluate(() => {
    return {
      gameSystemId: globalThis.game?.system?.id,
      gameSystemVersion: globalThis.game?.system?.version,
      configActorTypes: Object.keys(CONFIG.Actor.dataModels ?? {}),
      configActorTypeLabels: CONFIG.Actor.typeLabels,
    };
  });
  log.info({ pf2eActorTypes }, 'Q5: PF2e actor types registered with CONFIG.Actor');

  // --- Q3/Q4: Round-trip create. Apply name + prototype overrides and verify. ---
  const TEST_NAME = '__gm_puppeteer_probe_actor__';
  const TEST_PROTOTYPE_NAME = '__gm_puppeteer_probe_proto__';
  const createTest = await page.evaluate(
    async (uuid, name, protoName) => {
      const source = await fromUuid(uuid);
      const data = source.toObject();
      delete data._id;
      data.name = name;
      data.prototypeToken = {
        ...(data.prototypeToken ?? {}),
        name: protoName,
        actorLink: false, // override the default to confirm persistence
      };
      const created = await Actor.implementation.create(data);
      return {
        createdId: created.id,
        createdName: created.name,
        createdType: created.type,
        prototypeName: created.prototypeToken?.name,
        prototypeActorLink: created.prototypeToken?.actorLink,
        itemCount: created.items?.size ?? -1,
        effectCount: created.effects?.size ?? -1,
        inActorsCollection: !!globalThis.game?.actors?.get(created.id),
        // Inspect the created class to confirm it is the impl class.
        createdConstructor: created.constructor?.name,
        createdInstanceofImpl: created instanceof Actor.implementation,
      };
    },
    valerosLookup.valerosUuid,
    TEST_NAME,
    TEST_PROTOTYPE_NAME,
  );
  log.info({ createTest }, 'Q3/Q4: round-trip create with prototype overrides');

  // --- Q6: Folder pass-through with a non-existent id. ---
  let folderProbe = null;
  if (createTest.createdId) {
    folderProbe = await page.evaluate(async (uuid) => {
      const source = await fromUuid(uuid);
      const data = source.toObject();
      delete data._id;
      data.name = '__gm_puppeteer_probe_actor_folder__';
      data.folder = 'thisIdDoesNotExist1234';
      try {
        const created = await Actor.implementation.create(data);
        return {
          succeeded: true,
          createdId: created.id,
          folder: created.folder,
        };
      } catch (err) {
        return { succeeded: false, error: err?.message ?? String(err) };
      }
    }, valerosLookup.valerosUuid);
    log.info({ folderProbe }, 'Q6: create with bogus folder id');
  }

  // --- fromUuid behavior on garbage UUIDs (typed-error design check). ---
  const fromUuidErrors = await page.evaluate(async () => {
    const out = {};
    try {
      out.malformed = await fromUuid('not.a.real.uuid');
    } catch (e) {
      out.malformedError = e?.message ?? String(e);
    }
    try {
      out.missingPack = await fromUuid('Compendium.no.such.pack.Actor.000000000000');
    } catch (e) {
      out.missingPackError = e?.message ?? String(e);
    }
    // An Item UUID — we need to detect "wrong doc type" cleanly.
    const itemPack = Array.from(globalThis.game.packs ?? []).find(
      (p) => p.documentName === 'Item',
    );
    let itemUuid = null;
    if (itemPack) {
      const idx = await itemPack.getIndex();
      const firstItem = idx.contents[0];
      if (firstItem) {
        itemUuid =
          firstItem.uuid ?? `Compendium.${itemPack.collection}.Item.${firstItem._id}`;
      }
    }
    if (itemUuid) {
      const itemDoc = await fromUuid(itemUuid);
      out.itemUuid = itemUuid;
      out.itemDocConstructor = itemDoc?.constructor?.name;
      out.itemDocumentName = itemDoc?.documentName;
      out.itemIsActor = itemDoc instanceof CONFIG.Actor.documentClass;
    }
    return out;
  });
  log.info({ fromUuidErrors }, 'fromUuid error / wrong-type behavior');

  // --- Cleanup: delete anything we created. ---
  const cleanup = await page.evaluate(async (names) => {
    const removed = [];
    for (const name of names) {
      const docs = globalThis.game.actors?.contents?.filter((a) => a.name === name) ?? [];
      for (const doc of docs) {
        try {
          await doc.delete();
          removed.push(doc.id);
        } catch (e) {
          removed.push(`failed:${doc.id}:${e?.message ?? e}`);
        }
      }
    }
    return { removed };
  }, [TEST_NAME, '__gm_puppeteer_probe_actor_folder__']);
  log.info({ cleanup }, 'cleanup');

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
