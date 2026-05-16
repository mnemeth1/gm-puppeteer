/**
 * page.evaluate body for get_available_conditions. Read-only enumeration
 * of every PF2e condition the system exposes, surfacing the
 * valued/unvalued status and effective cap so a caller can pre-clamp
 * and pick the right downstream tool (`apply_condition` /
 * `set_condition_value` / `remove_condition`) on the first try without
 * trial-and-error.
 *
 * Semantics confirmed by scripts/probe-get-available-conditions.mjs
 * against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **Slug source.** `game.pf2e.ConditionManager.conditionsSlugs`
 *    (getter, 44 entries in PF2e 8.1.2). Same source apply_condition
 *    validates against. Same source remove_condition uses.
 *
 *  - **Template lookup.** `game.pf2e.ConditionManager.getCondition(slug)`
 *    returns a `ConditionPF2e` Item with top-level `name` and
 *    `system.value.{isValued, value}`. Every probed slug had a
 *    populated, non-empty top-level `name` — no fallback to slug-
 *    casing is needed.
 *
 *  - **Valued split: 13 / 31.** apply-condition's JSDoc cites the
 *    8 SRD valued non-vitals (frightened, sickened, stupefied,
 *    slowed, drained, clumsy, enfeebled, stunned) plus the 3 vitals
 *    (dying, wounded, doomed). PF2e 8.1.2 ships two further valued
 *    conditions — `cursebound` and `malevolence` — bringing the
 *    template-level isValued=true count to 13. Probe confirmed: 13
 *    valued, 31 non-valued, 0 with isValued !== boolean.
 *
 *  - **`defaultMax` derivation.** Mirrors apply-condition's runtime
 *    rule exactly: 4 for valued non-vitals (`NON_VITAL_VALUED_CAP`),
 *    null for vitals (per-actor — the real cap is
 *    `actor.system.attributes[slug].max`, dynamic with doomed), null
 *    for non-valued. Cursebound and malevolence go through the same
 *    cap-4 branch as the canonical SRD valued conditions because
 *    apply-condition already treats every non-vital valued slug
 *    identically. If a PF2e content update ever differentiates per-
 *    condition caps, this projection and apply-condition's
 *    NON_VITAL_VALUED_CAP need to move together.
 *
 *  - **`persistentDamage` flag.** Surfaces the one slug
 *    apply_condition refuses outright (`persistent-damage` opens
 *    PersistentDamageEditor, a UI dialog that blocks in headless).
 *    Template-level the slug has `isValued: false`, so callers
 *    grouping by `valued` alone wouldn't notice it; the explicit
 *    flag lets them filter it out without remembering the special
 *    case.
 *
 *  - **`isVital` flag.** Dying / wounded / doomed have a per-actor
 *    cap rather than the SRD's flat 4. Returning a flag plus
 *    null-cap (rather than guessing a constant) keeps the contract
 *    honest. Callers that want the real cap can hit
 *    `get_actor_state` once they have a target actor.
 *
 *  - **Sort.** Output sorted alphabetically by slug for stable
 *    enumeration across calls.
 *
 *  - **No inputs.** 44 rows is small enough that client-side
 *    filtering is trivial; the zero-arg schema keeps the tool
 *    surface minimal.
 *
 *  - **Error surface.** Two reachable failures: ConditionManager
 *    unavailable (PF2e not loaded) and conditionsSlugs not an
 *    array. Both wrap into the same `{ok:false, error:{code,
 *    message}}` discriminated-union pattern as the rest of the
 *    condition cluster (apply / remove / set).
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper and constant is defined inline.
 */
export interface ConditionSummary {
  slug: string;
  name: string;
  valued: boolean;
  defaultMax: number | null;
  isVital: boolean;
  persistentDamage: boolean;
}

export interface GetAvailableConditionsOk {
  ok: true;
  conditions: ConditionSummary[];
}

export interface GetAvailableConditionsErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason: 'CONDITION_MANAGER_UNAVAILABLE' | 'CONDITION_MANAGER_MALFORMED';
      [k: string]: unknown;
    };
  };
}

export type GetAvailableConditionsResult =
  | GetAvailableConditionsOk
  | GetAvailableConditionsErr;

export function getAvailableConditionsBody(): GetAvailableConditionsResult {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const VITALS_SLUGS = new Set(['dying', 'wounded', 'doomed']);
  const PERSISTENT_DAMAGE_SLUG = 'persistent-damage';
  const NON_VITAL_VALUED_CAP = 4;

  interface ConditionTemplateLike {
    name?: string;
    system?: {
      value?: { isValued?: boolean; value?: number | null };
    };
  }
  interface ConditionManagerLike {
    conditionsSlugs: string[];
    getCondition(slug: string): ConditionTemplateLike | null;
  }
  interface FoundryGameLike {
    pf2e?: { ConditionManager?: ConditionManagerLike };
  }

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const CM = game?.pf2e?.ConditionManager;
  if (!CM) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'game.pf2e.ConditionManager is unavailable — the PF2e system may not be loaded.',
        details: { reason: 'CONDITION_MANAGER_UNAVAILABLE' },
      },
    };
  }

  const slugList = CM.conditionsSlugs;
  if (!Array.isArray(slugList)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'game.pf2e.ConditionManager.conditionsSlugs is not an array; PF2e API contract changed.',
        details: {
          reason: 'CONDITION_MANAGER_MALFORMED',
          actualType: typeof slugList,
        },
      },
    };
  }

  const summaries: ConditionSummary[] = [];
  for (const slug of slugList) {
    if (typeof slug !== 'string' || slug.length === 0) continue;
    const template = CM.getCondition(slug);
    if (!template) continue;

    const name = typeof template.name === 'string' ? template.name : slug;
    const valued = template.system?.value?.isValued === true;
    const isVital = VITALS_SLUGS.has(slug);
    const persistentDamage = slug === PERSISTENT_DAMAGE_SLUG;
    const defaultMax = valued && !isVital ? NON_VITAL_VALUED_CAP : null;

    summaries.push({
      slug,
      name,
      valued,
      defaultMax,
      isVital,
      persistentDamage,
    });
  }

  summaries.sort((a, b) => a.slug.localeCompare(b.slug));

  return { ok: true, conditions: summaries };
}
