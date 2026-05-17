/**
 * One-shot read-only probe: log in to live headless Foundry and answer the
 * D&D 5e API questions that gate the dnd5e_get_available_conditions impl.
 *
 * 5e has NO `condition` Item type and no ConditionManager (PF2e has both).
 * The applyable-status registry is `CONFIG.statusEffects` (an array); the
 * condition-specific metadata lives in `CONFIG.DND5E.conditionTypes` (an
 * object keyed by condition id). The tool enumerates the FULL statusEffects
 * set and categorizes each entry against conditionTypes.
 *
 * No mutation, no cleanup. Just enumerate the two CONFIG registries and dump
 * the fields the projection wants to surface.
 *
 * Questions:
 *   1. System / ruleset — game.system.id, game.system.version, and the
 *      active rules setting (2014 vs 2024). The world has 2024 content.
 *   2. CONFIG.statusEffects shape — length, every id, the union of per-entry
 *      field keys. This is the enumeration source.
 *   3. CONFIG.DND5E.conditionTypes shape — key count, every key, union of
 *      per-entry field keys. Capture each entry's label/name, icon,
 *      reference, pseudo, levels, riders, statuses, special.
 *   4. Valued split — confirm Exhaustion is the only valued condition.
 *      Dump conditionTypes.exhaustion fully: does it carry a `levels`
 *      integer (the cap)? Any other entry with a numeric/levels field?
 *   5. Pseudo-conditions — every conditionTypes id with pseudo===true.
 *   6. Scope diff — statusEffects ids NOT in conditionTypes (e.g.
 *      concentration, dead, bleeding) and conditionTypes ids NOT in
 *      statusEffects (if any).
 *   7. Projection preview — v1 projection for a sample: blinded, exhaustion,
 *      prone, incapacitated, dead, plus one pseudo entry.
 *
 *   npm run build && node scripts/probe-dnd5e-get-available-conditions.mjs
 */
import { BrowserSession } from '../dist/browser/session.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/logging.js';

const config = loadConfig();
const log = createLogger({ logLevel: 'info' });
const session = new BrowserSession(config, log);

try {
  const { page } = await session.ensureStarted();

  const probe = await page.evaluate(() => {
    const game = globalThis.game;
    const CONFIG = globalThis.CONFIG;

    // ---- Q1: system / ruleset ---------------------------------------------
    let rulesSetting = null;
    try {
      rulesSetting = game?.settings?.get?.('dnd5e', 'rulesVersion') ?? null;
    } catch {
      rulesSetting = null;
    }
    const system = {
      id: game?.system?.id ?? null,
      version: game?.system?.version ?? null,
      rulesSetting,
    };

    // ---- Q2: CONFIG.statusEffects -----------------------------------------
    const statusEffects = CONFIG?.statusEffects;
    if (!Array.isArray(statusEffects)) {
      return { error: 'CONFIG.statusEffects is not an array', actualType: typeof statusEffects };
    }
    const statusKeyUnion = new Set();
    const statusRows = [];
    for (const se of statusEffects) {
      if (se && typeof se === 'object') {
        for (const k of Object.keys(se)) statusKeyUnion.add(k);
        statusRows.push({
          id: se.id ?? null,
          _id: se._id ?? null,
          name: se.name ?? null,
          label: se.label ?? null,
          img: se.img ?? null,
          reference: se.reference ?? null,
          hud: se.hud ?? null,
        });
      }
    }

    // ---- Q3: CONFIG.DND5E.conditionTypes ----------------------------------
    const conditionTypes = CONFIG?.DND5E?.conditionTypes;
    const conditionTypesIsObject =
      conditionTypes && typeof conditionTypes === 'object' && !Array.isArray(conditionTypes);
    const condKeyUnion = new Set();
    const condRows = [];
    const pseudoIds = [];
    const valuedIds = [];
    if (conditionTypesIsObject) {
      for (const [id, ct] of Object.entries(conditionTypes)) {
        if (!ct || typeof ct !== 'object') {
          condRows.push({ id, malformed: true, actualType: typeof ct });
          continue;
        }
        for (const k of Object.keys(ct)) condKeyUnion.add(k);
        const row = {
          id,
          label: ct.label ?? null,
          name: ct.name ?? null,
          icon: ct.icon ?? null,
          img: ct.img ?? null,
          reference: ct.reference ?? null,
          pseudo: ct.pseudo ?? null,
          levels: ct.levels ?? null,
          riders: ct.riders ?? null,
          statuses: ct.statuses ?? null,
          special: ct.special ?? null,
        };
        condRows.push(row);
        if (ct.pseudo === true) pseudoIds.push(id);
        if (typeof ct.levels === 'number' && ct.levels > 0) valuedIds.push(id);
      }
    }

    // ---- Q4: exhaustion detail --------------------------------------------
    const exhaustionRaw = conditionTypesIsObject ? conditionTypes.exhaustion : null;
    const exhaustion = exhaustionRaw
      ? {
          present: true,
          label: exhaustionRaw.label ?? exhaustionRaw.name ?? null,
          levels: exhaustionRaw.levels ?? null,
          reference: exhaustionRaw.reference ?? null,
          allKeys: Object.keys(exhaustionRaw),
        }
      : { present: false };

    // ---- Q6: scope diff ----------------------------------------------------
    const statusIds = new Set(statusRows.map((r) => r.id).filter((x) => typeof x === 'string'));
    const condIds = new Set(condRows.map((r) => r.id));
    const statusOnly = [...statusIds].filter((id) => !condIds.has(id)).sort();
    const conditionOnly = [...condIds].filter((id) => !statusIds.has(id)).sort();

    // ---- Q7: projection preview -------------------------------------------
    const PREVIEW = ['blinded', 'exhaustion', 'prone', 'incapacitated', 'dead'];
    if (pseudoIds.length > 0) PREVIEW.push(pseudoIds[0]);
    const titleCase = (s) =>
      String(s)
        .split(/[-_\s]+/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
    const preview = [];
    for (const id of PREVIEW) {
      const se = statusRows.find((r) => r.id === id) ?? null;
      const ct = conditionTypesIsObject ? conditionTypes[id] : null;
      const inCond = !!ct;
      const isPseudo = ct?.pseudo === true;
      const valued = typeof ct?.levels === 'number' && ct.levels > 0;
      preview.push({
        id,
        name: se?.name ?? se?.label ?? ct?.label ?? ct?.name ?? titleCase(id),
        category: !inCond ? 'status' : isPseudo ? 'pseudo-condition' : 'condition',
        valued,
        maxValue: valued ? ct.levels : null,
        reference: se?.reference ?? ct?.reference ?? null,
        inStatusEffects: !!se,
      });
    }

    return {
      system,
      statusEffects: {
        length: statusEffects.length,
        keyUnion: [...statusKeyUnion].sort(),
        rows: statusRows,
      },
      conditionTypes: {
        isObject: !!conditionTypesIsObject,
        count: condRows.length,
        keyUnion: [...condKeyUnion].sort(),
        rows: condRows,
      },
      pseudoIds,
      valuedIds,
      exhaustion,
      scopeDiff: { statusOnly, conditionOnly },
      preview,
    };
  });

  if (probe.error) {
    log.error({ probe }, 'probe aborted: precondition failed');
    process.exitCode = 1;
  } else {
    log.info({ system: probe.system }, 'Q1: system / ruleset (expect dnd5e)');
    log.info(
      { length: probe.statusEffects.length, keyUnion: probe.statusEffects.keyUnion },
      'Q2: CONFIG.statusEffects length & per-entry field keys',
    );
    log.info(
      { count: probe.conditionTypes.count, keyUnion: probe.conditionTypes.keyUnion },
      'Q3: CONFIG.DND5E.conditionTypes count & per-entry field keys',
    );
    log.info(
      { valuedIds: probe.valuedIds, exhaustion: probe.exhaustion },
      'Q4: valued conditions (expect exhaustion only) & exhaustion detail',
    );
    log.info({ pseudoIds: probe.pseudoIds }, 'Q5: pseudo-condition ids');
    log.info({ scopeDiff: probe.scopeDiff }, 'Q6: status-only vs condition-only ids');
    log.info({ preview: probe.preview }, 'Q7: v1 projection preview');

    log.info({ rows: probe.statusEffects.rows }, 'Detail: CONFIG.statusEffects rows');
    log.info({ rows: probe.conditionTypes.rows.slice(0, 16) }, 'Detail: conditionTypes rows (1/2)');
    log.info({ rows: probe.conditionTypes.rows.slice(16) }, 'Detail: conditionTypes rows (2/2)');

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
