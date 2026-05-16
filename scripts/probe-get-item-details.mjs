/**
 * Probe + acceptance script for get_item_details. Drives the live headless
 * Foundry against the gm-puppeteer-sandbox world and exercises:
 *
 *   1. One item of every type carried on the default probe actor (Valeros
 *      — id tLhy0qgJyw31QaEy in the sandbox). Types verified earlier on
 *      a level-1 Valeros: lore, ancestry, background, feat, class, action,
 *      backpack, equipment, consumable, armor, weapon, shield, ammo,
 *      treasure, heritage.
 *   2. A spell resolved from `pf2e.spells-srd` (Valeros, a fighter, has
 *      none on his sheet — fall back to a compendium lookup for the spell
 *      case).
 *   3. NOT_FOUND error on a bogus UUID (`Actor.deadbeef.Item.deadbeef`).
 *   4. WRONG_DOCUMENT_TYPE error on an Actor UUID (any world actor).
 *   5. All three `descriptionFormat` values on a single item (verify
 *      conditional field-presence).
 *   6. `includeRules: true` and `includeRawSystem: true` opt-ins.
 *
 * The probe is non-destructive: it does not create, modify, or delete
 * any documents. It exits non-zero if any acceptance assertion fails.
 *
 *   npm run build && node scripts/probe-get-item-details.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';
import { tools } from '../dist/tools/index.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

const tool = tools.find((t) => t.name === 'get_item_details');
if (!tool) {
  log.error('get_item_details not registered');
  process.exit(2);
}

const PROBE_ACTOR_ID = 'tLhy0qgJyw31QaEy'; // Valeros in sandbox
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

  // Discover one item of each type carried by Valeros, plus a spell from
  // pf2e.spells-srd (Ignition or any other low-level spell).
  const discovery = await page.evaluate(async (actorId) => {
    const actor = globalThis.game.actors?.get(actorId);
    if (!actor) return { error: `actor ${actorId} not found` };
    const byType = {};
    for (const item of actor.items?.contents ?? []) {
      const t = item.type;
      if (!byType[t]) byType[t] = { uuid: item.uuid, name: item.name, id: item.id };
    }
    // Find a spell in pf2e.spells-srd to round out the type coverage.
    let spell = null;
    const pack = globalThis.game.packs?.get('pf2e.spells-srd');
    if (pack) {
      const idx = await pack.getIndex();
      const hit =
        idx.contents.find((e) => (e.name ?? '').toLowerCase() === 'ignition') ??
        idx.contents.find((e) => (e.name ?? '').toLowerCase().includes('heal')) ??
        idx.contents[0];
      if (hit) {
        spell = {
          uuid: hit.uuid ?? `Compendium.${pack.collection}.Item.${hit._id}`,
          name: hit.name,
        };
      }
    }
    // First world Actor for the WRONG_DOCUMENT_TYPE test.
    const firstActor = globalThis.game.actors?.contents?.[0];
    const actorUuid = firstActor ? firstActor.uuid : null;
    return { actorName: actor.name, byType, spell, actorUuid };
  }, PROBE_ACTOR_ID);
  log.info({ discovery }, 'discovered probe targets');
  if (discovery?.error) {
    log.error({ discovery }, 'discovery failed; aborting');
    process.exit(2);
  }

  // ---- Sweep: one of every type Valeros carries -------------------------
  for (const [type, entry] of Object.entries(discovery.byType)) {
    const res = await call({ uuid: entry.uuid });
    if (!res.ok) {
      log.error({ type, entry, res }, 'unexpected non-OK response for typed item');
      failures.push({ label: `type-sweep:${type}`, ctx: res });
      continue;
    }
    const data = res.data;
    const projectionKey = [
      'weapon',
      'armor',
      'shield',
      'consumable',
      'equipment',
      'container',
      'treasure',
      'ammo',
      'feat',
      'action',
      'ancestry',
      'heritage',
      'background',
      'class',
      'lore',
      'spell',
    ].find((k) => data[k] !== undefined);
    log.info(
      {
        type,
        name: data.name,
        projectionKey,
        hasPhysical: !!data.physical,
        descTextLen: data.descriptionText?.length ?? 0,
        traitsLen: data.traits.length,
        sourceUuid: data.sourceUuid ? `${data.sourceUuid.slice(0, 40)}...` : null,
        publication: data.publication?.title ?? null,
        priceFormatted: data.physical?.priceFormatted ?? null,
        rawSystemPresent: data.rawSystem !== undefined,
        ruleCount: data.rules?.length ?? null,
      },
      'item probed',
    );

    // Acceptance: typed projection present for known types, fallback to rawSystem otherwise.
    const KNOWN = new Set([
      'weapon',
      'armor',
      'shield',
      'consumable',
      'equipment',
      'backpack',
      'treasure',
      'ammo',
      'feat',
      'action',
      'ancestry',
      'heritage',
      'background',
      'class',
      'lore',
      'spell',
    ]);
    if (KNOWN.has(type)) {
      assert(projectionKey !== undefined, `typed projection emitted for ${type}`, {
        uuid: entry.uuid,
      });
    } else {
      assert(data.rawSystem !== undefined, `rawSystem forced for unknown type ${type}`, {
        uuid: entry.uuid,
      });
    }

    // Acceptance: physical block iff type is in physical set
    const PHYSICAL = new Set([
      'weapon',
      'armor',
      'shield',
      'consumable',
      'equipment',
      'backpack',
      'treasure',
      'ammo',
    ]);
    if (PHYSICAL.has(type)) {
      assert(!!data.physical, `physical block present for ${type}`, { uuid: entry.uuid });
    } else {
      assert(!data.physical, `physical block absent for non-physical type ${type}`, {
        uuid: entry.uuid,
      });
    }

    // Spot-check rune shape on weapon/armor/shield
    if (type === 'weapon') {
      const runes = data.weapon?.runes;
      assert(
        runes === null ||
          (runes && typeof runes === 'object' && ('property' in runes || 'potency' in runes)),
        'weapon runes shape',
        { runes },
      );
      // v1.1: weapon.hands was dropped — hands info lives at physical.usage.hands.
      assert(
        !('hands' in (data.weapon ?? {})),
        'weapon projection has no `hands` field (use physical.usage.hands)',
        { weapon: data.weapon },
      );
    }
    if (type === 'shield') {
      const runes = data.shield?.runes;
      // shield runes can be {reinforcing: number} or null.
      assert(
        runes === null ||
          (runes &&
            typeof runes === 'object' &&
            ('reinforcing' in runes || Object.keys(runes).length === 0)),
        'shield runes shape',
        { runes },
      );
    }
    // v1.1: empty publication objects (system-default lore items, etc.)
    // are normalized to null. Farming Lore is the in-sandbox witness.
    if (type === 'lore' && data.name === 'Farming Lore') {
      assert(data.publication === null, 'Farming Lore publication normalized to null', {
        publication: data.publication,
      });
    }
  }

  // ---- Spell case from compendium ---------------------------------------
  if (discovery.spell) {
    const res = await call({ uuid: discovery.spell.uuid });
    if (!res.ok) {
      log.error({ res, spell: discovery.spell }, 'spell fetch failed');
      failures.push({ label: 'spell-fetch', ctx: res });
    } else {
      const data = res.data;
      log.info(
        {
          name: data.name,
          type: data.type,
          projectionPresent: !!data.spell,
          level: data.spell?.level,
          traditions: data.spell?.traditions,
          damageEntryCount: Array.isArray(data.spell?.damage) ? data.spell.damage.length : null,
          heighteningDamageCount: Array.isArray(data.spell?.heightening?.damage)
            ? data.spell.heightening.damage.length
            : null,
          publication: data.publication?.title ?? null,
          sourceUuid: data.sourceUuid,
          descTextLen: data.descriptionText?.length ?? 0,
        },
        'compendium spell probed',
      );
      assert(data.type === 'spell', 'compendium-resolved doc is type=spell', { data: data.type });
      assert(!!data.spell, 'spell projection emitted', { name: data.name });
      // Compendium-resident items: sourceUuid should equal own uuid
      assert(
        data.sourceUuid === data.uuid || data.sourceUuid === discovery.spell.uuid,
        'compendium spell sourceUuid == own uuid',
        { sourceUuid: data.sourceUuid, uuid: data.uuid },
      );
    }
  } else {
    log.warn('no spell discovered — skipping spell case');
  }

  // ---- Error paths ------------------------------------------------------
  // NOT_FOUND: bogus UUID
  const notFound = await call({ uuid: 'Actor.deadbeef.Item.deadbeef' });
  log.info({ notFound }, 'NOT_FOUND probe');
  assert(notFound.isError, 'bogus uuid returns error', { notFound });
  assert(
    notFound.error?.code === 'INVALID_INPUT' &&
      typeof notFound.error?.message === 'string' &&
      notFound.error.message.startsWith('No item found for uuid:'),
    'NOT_FOUND error code + message shape',
    { notFound },
  );

  // WRONG_DOCUMENT_TYPE: actor UUID
  if (discovery.actorUuid) {
    const wrongType = await call({ uuid: discovery.actorUuid });
    log.info({ wrongType }, 'WRONG_DOCUMENT_TYPE probe');
    assert(wrongType.isError, 'actor uuid returns error', { wrongType });
    assert(
      wrongType.error?.code === 'INVALID_INPUT' &&
        typeof wrongType.error?.message === 'string' &&
        wrongType.error.message.startsWith('UUID resolved to Actor'),
      'WRONG_DOCUMENT_TYPE error code + message shape',
      { wrongType },
    );
  } else {
    log.warn('no actor uuid discovered — skipping WRONG_DOCUMENT_TYPE');
  }

  // ---- descriptionFormat opt-in verification ----------------------------
  // Pick the first item we discovered with a non-empty description.
  const sampleEntry =
    discovery.byType.feat ??
    discovery.byType.weapon ??
    discovery.byType.armor ??
    Object.values(discovery.byType)[0];
  if (sampleEntry) {
    const both = await call({ uuid: sampleEntry.uuid, descriptionFormat: 'both' });
    const htmlOnly = await call({ uuid: sampleEntry.uuid, descriptionFormat: 'html' });
    const textOnly = await call({ uuid: sampleEntry.uuid, descriptionFormat: 'text' });
    log.info(
      {
        sample: sampleEntry.name,
        both_has_html: both.data?.description !== undefined,
        both_has_text: both.data?.descriptionText !== undefined,
        htmlOnly_has_html: htmlOnly.data?.description !== undefined,
        htmlOnly_has_text: htmlOnly.data?.descriptionText !== undefined,
        textOnly_has_html: textOnly.data?.description !== undefined,
        textOnly_has_text: textOnly.data?.descriptionText !== undefined,
      },
      'descriptionFormat opt-in',
    );
    assert(
      both.data?.description !== undefined && both.data?.descriptionText !== undefined,
      'descriptionFormat=both yields both fields',
      both.data,
    );
    assert(
      htmlOnly.data?.description !== undefined && htmlOnly.data?.descriptionText === undefined,
      'descriptionFormat=html yields description only',
      htmlOnly.data,
    );
    assert(
      textOnly.data?.description === undefined && textOnly.data?.descriptionText !== undefined,
      'descriptionFormat=text yields descriptionText only',
      textOnly.data,
    );

    // ---- includeRules / includeRawSystem opt-ins -------------------------
    const withRules = await call({ uuid: sampleEntry.uuid, includeRules: true });
    const withRaw = await call({ uuid: sampleEntry.uuid, includeRawSystem: true });
    log.info(
      {
        withRules_hasRules: Array.isArray(withRules.data?.rules),
        withRules_ruleCount: withRules.data?.rules?.length,
        withRaw_hasRawSystem: !!withRaw.data?.rawSystem,
        withRaw_rawSystemKeys: withRaw.data?.rawSystem
          ? Object.keys(withRaw.data.rawSystem).slice(0, 10)
          : null,
      },
      'opt-in escape hatches',
    );
    assert(Array.isArray(withRules.data?.rules), 'includeRules:true populates rules array', {
      rules: withRules.data?.rules,
    });
    assert(
      withRaw.data?.rawSystem !== undefined && typeof withRaw.data.rawSystem === 'object',
      'includeRawSystem:true populates rawSystem',
      { rawSystem: !!withRaw.data?.rawSystem },
    );
    assert(both.data?.rules === undefined, 'rules omitted by default', { rules: both.data?.rules });
    // rawSystem may still be present if the type has no projection — that's expected.
    if (KNOWN_PROJECTIONS_HAS(both.data?.type)) {
      assert(
        both.data?.rawSystem === undefined,
        'rawSystem omitted by default for known projection',
        { type: both.data?.type, rawSystem: !!both.data?.rawSystem },
      );
    }
  }

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

function KNOWN_PROJECTIONS_HAS(type) {
  return new Set([
    'weapon',
    'armor',
    'shield',
    'consumable',
    'equipment',
    'backpack',
    'treasure',
    'ammo',
    'feat',
    'action',
    'ancestry',
    'heritage',
    'background',
    'class',
    'lore',
    'spell',
  ]).has(type);
}
