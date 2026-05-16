/**
 * One-shot read-only probe: log in to live headless Foundry and answer the
 * v14.361 + PF2e 8.1.2 API questions that gate the get_available_conditions
 * impl.
 *
 * No mutation, no cleanup. Just enumerate game.pf2e.ConditionManager and
 * dump the template fields the projection wants to surface.
 *
 * Questions:
 *   1. conditionsSlugs length & content — expect 44 strings in PF2e 8.1.2.
 *      Decides whether the getter is the right enumeration source and
 *      confirms count matches the figure apply-condition's JSDoc baked in.
 *   2. Per-slug template shape — for each slug, capture name (top-level),
 *      system.value.isValued, system.value.value, system.group, and the
 *      union of top-level field keys. Histogram of isValued (expect 11
 *      true / 33 false, per apply-condition's documented split: frightened,
 *      sickened, stupefied, slowed, drained, clumsy, enfeebled, stunned,
 *      dying, wounded, doomed).
 *   3. Vitals sanity check — confirm dying/wounded/doomed all have
 *      isValued===true. apply-condition.ts hardcodes them as the vitals
 *      set; we want to ensure the template-level shape agrees.
 *   4. persistent-damage presence — confirm 'persistent-damage' is in the
 *      slug list and dump its template. apply_condition rejects this slug
 *      because increaseCondition opens a UI dialog; we want to flag it in
 *      the get_available_conditions projection so callers can skip without
 *      trial-and-error.
 *   5. Projection preview — dump the v1 projection for a curated sample:
 *      frightened, off-guard, dying, persistent-damage, blinded. Eyeball
 *      verification of {slug, name, valued, defaultMax, isVital,
 *      persistentDamage} before writing the evaluator.
 *   6. Empty-name defense — log any slug whose top-level name is missing
 *      or empty. We rely on template.name; if any slug surfaces missing,
 *      the projection needs a fallback (e.g. title-case the slug).
 *
 *   npm run build && node scripts/probe-get-available-conditions.mjs
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
    const VITALS_SLUGS = new Set(['dying', 'wounded', 'doomed']);
    const NON_VITAL_VALUED_CAP = 4;
    const PREVIEW_SLUGS = ['frightened', 'off-guard', 'dying', 'persistent-damage', 'blinded'];

    const game = globalThis.game;
    const CM = game?.pf2e?.ConditionManager;
    if (!CM) {
      return { error: 'ConditionManager unavailable' };
    }

    const slugs = Array.isArray(CM.conditionsSlugs) ? CM.conditionsSlugs.slice().sort() : null;
    if (!slugs) {
      return { error: 'conditionsSlugs is not an array', actualType: typeof CM.conditionsSlugs };
    }

    const isValuedHistogram = { true: 0, false: 0, other: 0 };
    const perSlug = [];
    const emptyNameSlugs = [];
    const vitalsCheck = {};
    let persistentDamageTemplate = null;
    const previewRows = [];
    const topLevelKeyUnion = new Set();
    const systemKeyUnion = new Set();

    for (const slug of slugs) {
      const template = CM.getCondition(slug);
      if (!template) {
        perSlug.push({ slug, missing: true });
        continue;
      }

      // Top-level keys — only enumerable ones; ConditionPF2e is a Foundry
      // Item document with most properties on the prototype, so the
      // enumerable set may be small. We log it for visibility but rely on
      // explicit field access below.
      try {
        for (const k of Object.keys(template)) topLevelKeyUnion.add(k);
      } catch {
        // ignore — some Foundry documents have non-enumerable proxies
      }

      const name = typeof template.name === 'string' ? template.name : null;
      if (!name || name.length === 0) emptyNameSlugs.push(slug);

      const system = template.system;
      if (system && typeof system === 'object') {
        try {
          for (const k of Object.keys(system)) systemKeyUnion.add(k);
        } catch {
          // ignore
        }
      }

      const isValued = system?.value?.isValued;
      if (isValued === true) isValuedHistogram.true += 1;
      else if (isValued === false) isValuedHistogram.false += 1;
      else isValuedHistogram.other += 1;

      const value = system?.value?.value;
      const group = typeof system?.group === 'string' ? system.group : null;

      perSlug.push({
        slug,
        name,
        isValued: isValued === true,
        isValuedRaw: isValued,
        value: value ?? null,
        group,
      });

      if (VITALS_SLUGS.has(slug)) {
        vitalsCheck[slug] = {
          isValued: isValued === true,
          isValuedRaw: isValued,
          value: value ?? null,
        };
      }

      if (slug === 'persistent-damage') {
        // Shallow projection of the template — Foundry Item docs aren't
        // safe to JSON.stringify because of prototype getters. Capture
        // the fields we care about explicitly.
        persistentDamageTemplate = {
          name,
          slug,
          systemValue: {
            isValued: system?.value?.isValued ?? null,
            value: system?.value?.value ?? null,
          },
          systemGroup: group,
          systemKeys:
            system && typeof system === 'object'
              ? (() => {
                  try {
                    return Object.keys(system);
                  } catch {
                    return null;
                  }
                })()
              : null,
        };
      }

      if (PREVIEW_SLUGS.includes(slug)) {
        const valued = isValued === true;
        const isVital = VITALS_SLUGS.has(slug);
        const defaultMax = valued && !isVital ? NON_VITAL_VALUED_CAP : null;
        previewRows.push({
          slug,
          name: name ?? '',
          valued,
          defaultMax,
          isVital,
          persistentDamage: slug === 'persistent-damage',
        });
      }
    }

    return {
      total: slugs.length,
      slugs,
      isValuedHistogram,
      perSlug,
      emptyNameSlugs,
      vitalsCheck,
      persistentDamagePresent: slugs.includes('persistent-damage'),
      persistentDamageTemplate,
      topLevelKeyUnion: Array.from(topLevelKeyUnion).sort(),
      systemKeyUnion: Array.from(systemKeyUnion).sort(),
      previewRows,
    };
  });

  if (enumeration.error) {
    log.error({ probe: enumeration }, 'probe aborted: precondition failed');
    process.exitCode = 1;
  } else {
    log.info(
      { total: enumeration.total, slugs: enumeration.slugs },
      'Q1: conditionsSlugs length & content (expect 44)',
    );
    log.info(
      {
        histogram: enumeration.isValuedHistogram,
        topLevelKeyUnion: enumeration.topLevelKeyUnion,
        systemKeyUnion: enumeration.systemKeyUnion,
      },
      'Q2: per-slug template field coverage (expect 11 valued / 33 non-valued, 0 other)',
    );
    log.info(
      { vitalsCheck: enumeration.vitalsCheck },
      'Q3: vitals (dying/wounded/doomed) all have isValued=true',
    );
    log.info(
      {
        present: enumeration.persistentDamagePresent,
        template: enumeration.persistentDamageTemplate,
      },
      'Q4: persistent-damage slug presence & template shape',
    );
    log.info(
      { rows: enumeration.previewRows },
      'Q5: v1 projection preview (frightened, off-guard, dying, persistent-damage, blinded)',
    );
    log.info(
      {
        count: enumeration.emptyNameSlugs.length,
        slugs: enumeration.emptyNameSlugs,
      },
      'Q6: slugs with missing/empty template.name (expect 0)',
    );

    // Detail dump: per-slug rows, paginated for readability.
    log.info({ rows: enumeration.perSlug.slice(0, 22) }, 'Detail: per-slug rows (1/2)');
    log.info({ rows: enumeration.perSlug.slice(22) }, 'Detail: per-slug rows (2/2)');

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
