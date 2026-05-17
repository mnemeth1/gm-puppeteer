/**
 * page.evaluate body for dnd5e_get_available_conditions. Read-only
 * enumeration of every status the D&D 5e system can apply to an actor,
 * surfacing each one's category, its valued/unvalued status and cap, and a
 * rules-reference UUID — so a caller can pick the right id and the right
 * downstream tool (`dnd5e_apply_condition` / `dnd5e_set_condition_value` /
 * `dnd5e_remove_condition`) on the first try.
 *
 * Semantics confirmed by scripts/probe-dnd5e-get-available-conditions.mjs
 * against Foundry v14.361 + dnd5e 5.3.3 (rules setting "modern" / 2024):
 *
 *  - **No condition Item type, no ConditionManager.** Unlike PF2e, 5e has
 *    no `condition` document and no `ConditionManager`. The applyable-status
 *    registry is `CONFIG.statusEffects` — an array (43 entries in dnd5e
 *    5.3.3). Condition-specific metadata lives in
 *    `CONFIG.DND5E.conditionTypes` — an object keyed by id (26 entries).
 *    The dnd5e system merges conditionTypes metadata into the matching
 *    statusEffects entries, so a statusEffects row already carries
 *    `name`, `reference`, `pseudo`, and `levels` when it is a condition.
 *
 *  - **Enumeration source: `CONFIG.statusEffects`.** It is the superset —
 *    every conditionTypes id also appears in statusEffects (probe Q6:
 *    conditionOnly was empty; 43 = 26 conditionTypes + 17 status-only).
 *    Enumerating statusEffects yields the full set of things
 *    `dnd5e_apply_condition` can apply, which is the tool's chosen scope.
 *
 *  - **Three categories.** Each row is classified by membership in
 *    `CONFIG.DND5E.conditionTypes`:
 *      • `condition` — in conditionTypes, `pseudo !== true`. The 15 core 5e
 *        conditions (blinded, charmed, …, unconscious, plus exhaustion).
 *      • `pseudo-condition` — in conditionTypes with `pseudo: true`. Tracked
 *        like conditions but not part of the core set: bleeding, burning,
 *        cursed, dehydration, diseased, falling, malnutrition, silenced,
 *        suffocation, surprised, transformed (11 in 5.3.3).
 *      • `status` — in `CONFIG.statusEffects` but NOT conditionTypes:
 *        burrowing, concentrating, the three cover tiers, dead, dodging,
 *        the three encumbrance tiers, ethereal, flying, hiding, hovering,
 *        marked, sleeping, stable (17 in 5.3.3).
 *
 *  - **Valued split: 1 / 42.** Only `exhaustion` is valued — its
 *    conditionTypes entry carries `levels: 6` (the 2024 exhaustion cap;
 *    an actor's level lives on `system.attributes.exhaustion`). No other
 *    entry carries a `levels` integer. `valued` is derived as
 *    `typeof levels === 'number' && levels > 0`, and `maxValue` echoes
 *    `levels` for valued rows, `null` otherwise — no constant is hardcoded,
 *    so a future ruleset change to the exhaustion cap is picked up live.
 *
 *  - **`name` is already localized.** statusEffects `name` is a
 *    display-ready string ("Blinded", "Half Cover"), not an i18n key —
 *    dnd5e localizes at registration. Fallback chain: statusEffects
 *    `name` → `label` → conditionTypes `name` → title-cased id.
 *
 *  - **`reference`** is a Compendium UUID into the rules glossary
 *    JournalEntryPage — feed it to `dnd5e_search_rules` / `get_journal_page`
 *    for the mechanical text. Populated for every real condition; `null`
 *    for some pseudo-conditions and most plain statuses.
 *
 *  - **Sort.** Output sorted alphabetically by `statusId` for stable
 *    enumeration. Each row's `statusId` is the canonical id to feed to
 *    `dnd5e_apply_condition` / `dnd5e_remove_condition`.
 *
 *  - **No inputs.** 43 rows is small enough that client-side filtering is
 *    trivial; a zero-arg schema keeps the surface minimal.
 *
 *  - **Error surface.** `CONFIG.statusEffects` unavailable (dnd5e not
 *    loaded) or not an array. `CONFIG.DND5E.conditionTypes` is a soft
 *    dependency — if it is missing, every row degrades to
 *    `category: 'status'` rather than failing the call.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper and constant is defined inline.
 */
export type Dnd5eConditionCategory = 'condition' | 'pseudo-condition' | 'status';

export interface Dnd5eConditionSummary {
  statusId: string;
  name: string;
  category: Dnd5eConditionCategory;
  valued: boolean;
  maxValue: number | null;
  reference: string | null;
}

export interface Dnd5eGetAvailableConditionsOk {
  ok: true;
  conditions: Dnd5eConditionSummary[];
}

export interface Dnd5eGetAvailableConditionsErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason: 'STATUS_EFFECTS_UNAVAILABLE' | 'STATUS_EFFECTS_MALFORMED';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eGetAvailableConditionsResult =
  | Dnd5eGetAvailableConditionsOk
  | Dnd5eGetAvailableConditionsErr;

export function dnd5eGetAvailableConditionsBody(): Dnd5eGetAvailableConditionsResult {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const titleCase = (s: string): string =>
    s
      .split(/[-_\s]+/)
      .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ');

  interface StatusEffectLike {
    id?: unknown;
    name?: unknown;
    label?: unknown;
    reference?: unknown;
  }
  interface ConditionTypeLike {
    name?: unknown;
    reference?: unknown;
    pseudo?: unknown;
    levels?: unknown;
  }
  interface FoundryConfigLike {
    statusEffects?: unknown;
    DND5E?: { conditionTypes?: Record<string, ConditionTypeLike> };
  }

  const CONFIG = (globalThis as unknown as { CONFIG?: FoundryConfigLike }).CONFIG;
  const statusEffects = CONFIG?.statusEffects;

  if (statusEffects === undefined || statusEffects === null) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'CONFIG.statusEffects is unavailable — the D&D 5e system may not be loaded.',
        details: { reason: 'STATUS_EFFECTS_UNAVAILABLE' },
      },
    };
  }
  if (!Array.isArray(statusEffects)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'CONFIG.statusEffects is not an array; Foundry/dnd5e API contract changed.',
        details: { reason: 'STATUS_EFFECTS_MALFORMED', actualType: typeof statusEffects },
      },
    };
  }

  // Soft dependency: without conditionTypes every row degrades to 'status'.
  const conditionTypes = CONFIG?.DND5E?.conditionTypes;
  const hasConditionTypes =
    conditionTypes !== undefined && conditionTypes !== null && typeof conditionTypes === 'object';

  const summaries: Dnd5eConditionSummary[] = [];
  const seen = new Set<string>();

  for (const raw of statusEffects as StatusEffectLike[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);

    const ct = hasConditionTypes ? conditionTypes[id] : undefined;
    const inCond = ct !== undefined && ct !== null && typeof ct === 'object';
    const isPseudo = inCond && ct.pseudo === true;
    const category: Dnd5eConditionCategory = !inCond
      ? 'status'
      : isPseudo
        ? 'pseudo-condition'
        : 'condition';

    const levels = inCond && typeof ct.levels === 'number' ? ct.levels : null;
    const valued = levels !== null && levels > 0;

    const name =
      typeof raw.name === 'string' && raw.name.length > 0
        ? raw.name
        : typeof raw.label === 'string' && raw.label.length > 0
          ? raw.label
          : inCond && typeof ct.name === 'string' && ct.name.length > 0
            ? ct.name
            : titleCase(id);

    const reference =
      typeof raw.reference === 'string' && raw.reference.length > 0
        ? raw.reference
        : inCond && typeof ct.reference === 'string' && ct.reference.length > 0
          ? ct.reference
          : null;

    summaries.push({
      statusId: id,
      name,
      category,
      valued,
      maxValue: valued ? levels : null,
      reference,
    });
  }

  summaries.sort((a, b) => a.statusId.localeCompare(b.statusId));

  return { ok: true, conditions: summaries };
}
