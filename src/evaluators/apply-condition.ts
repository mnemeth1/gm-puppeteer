/**
 * page.evaluate body for apply_condition. First tool in the condition-
 * mutation cluster. Applies a PF2e condition to an actor — by slug, with
 * optional value for valued conditions (frightened, sickened, stupefied,
 * etc.). Sibling to `remove_condition` (decrement / clear) and
 * `set_condition_value` (absolute set) — this is the take-max apply
 * operation.
 *
 * Semantics confirmed by scripts/probe-apply-condition.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **API choice.** `actor.increaseCondition(slug, {value, max})` is
 *    the PF2e helper. Handles first-time creation AND existing-bump
 *    atomically, fires the GrantItem cascade (e.g. dying → unconscious →
 *    blinded + prone), and wires rule elements through
 *    `createEmbeddedDocuments`. We do NOT bypass it for raw
 *    `createEmbeddedDocuments` — the cascade and rule-element wiring
 *    would not fire reliably.
 *
 *  - **Slug source of truth.** `game.pf2e.ConditionManager.conditionsSlugs`
 *    (getter, 44 entries in PF2e 8.1.2). Per-condition template fetched
 *    via `game.pf2e.ConditionManager.getCondition(slug)` (returns a
 *    `ConditionPF2e` Item with `toObject()`; returns `null` for unknown
 *    slugs). Calling `increaseCondition` with a bogus slug throws on the
 *    null template — we validate up front to surface a clean
 *    `CONDITION_NOT_FOUND` instead.
 *
 *  - **Valued vs non-valued.** Read from
 *    `template.system.value.isValued`. Non-valued: `value` parameter is
 *    rejected (VALUE_ON_NON_VALUED_CONDITION) — silent drop would be
 *    user-hostile. Valued: `value` defaults to 1 if omitted.
 *
 *  - **Take-max semantics, not additive.** `increaseCondition` is
 *    natively ADDITIVE on existing conditions:
 *      `Math.clamp(currentValue + addend, 1, max)`.
 *    Calling `increaseCondition('frightened', {value: 2})` on an actor
 *    with frightened-1 produces frightened-3, NOT frightened-2. We layer
 *    take-max on top: read current, compute delta = requested - current,
 *    pass `{value: delta, max}` so PF2e's clamp produces exactly the
 *    requested value (or max). On first-time application, pass
 *    `{value: requested, max}` directly — increaseCondition's
 *    `clamp(template.value=1, value, max)` produces min(max(template.value,
 *    value), max), which delivers the requested value clamped at max.
 *
 *  - **Caps live in tool, not template.** The condition template carries
 *    `system.value: {isValued, value}` only — no max. The PF2e SRD caps
 *    valued conditions at 4 in nearly all cases (frightened, sickened,
 *    stupefied, slowed, drained, clumsy, enfeebled, stunned). Vitals
 *    (dying, wounded, doomed) have per-actor caps at
 *    `actor.system.attributes.{slug}.max` — doomed reduces dying.max
 *    dynamically (doomed-2 → dying.max=2). The tool computes
 *    `effectiveMax`:
 *      vitals slug → actor.system.attributes[slug].max
 *      anything else valued → 4
 *    and surfaces `clamped: true` when valueApplied < valueRequested.
 *
 *  - **Vitals are DECLARATIVE take-max, NOT RAW-faithful.** PF2e's
 *    wounded-adds-to-dying interaction (each new dying gain increases
 *    by 1 + wounded.value) is in `actor.applyDamage`, NOT in
 *    `increaseCondition`. This tool does NOT replicate it. The contract
 *    is: caller says "I want dying at value N", tool sets dying to
 *    `max(current, N)` clamped to `dying.max - doomed.value`. If the
 *    caller wants RAW wounded-adjusted dying from a fresh hit, they
 *    compute it themselves (or wait for a future `apply_damage` tool).
 *    This keeps the contract uniform across all 41 non-special slugs.
 *
 *  - **`persistent-damage` is rejected.** `increaseCondition('persistent-
 *    damage')` opens `PersistentDamageEditor` — a Foundry UI dialog —
 *    which would block in the headless GM client. v1 rejects with
 *    `PERSISTENT_DAMAGE_NOT_SUPPORTED` and a pointer to foundry_eval +
 *    raw `createEmbeddedDocuments` with the structured `{formula,
 *    damageType, dc}` shape from get_actor_state.
 *
 *  - **Cascade visibility.** Applying dying spawns unconscious; uncon-
 *    scious spawns blinded + prone (verified Phase 1 — 4-deep chain via
 *    `flags.pf2e.grantedBy.id`). The tool surfaces the FULL transitive
 *    closure in `cascadeGranted` (BFS from the applied condition), so
 *    GM tools downstream see every condition that landed in one
 *    response. Mirrors add_item_to_actor's `cascadeGranted` shape, but
 *    transitive rather than direct-only (cascade chains are deeper in
 *    PF2e's condition graph than in the GrantItem-rule graph).
 *
 *  - **No chat posted.** `increaseCondition` does not auto-post (probed
 *    across 14 condition mutations, game.messages.size unchanged). No
 *    `silent` flag is needed because there is nothing to suppress.
 *
 *  - **Actor type support.** `character`, `npc`, `familiar` — same set
 *    as get_actor_state. Reject `army`, `hazard`, `loot`, `party`,
 *    `vehicle` with ACTOR_TYPE_UNSUPPORTED.
 *
 *  - **No-op as success.** When the requested value is at-or-below
 *    current (after clamping requested at max), the result is
 *    `operation: "noop"`. Same precedent as `update_item_quantity`
 *    (qtyBefore === qtyAfter) and `move_item_to_container`
 *    (containerIdBefore === containerIdAfter). Reason discriminates the
 *    non-valued ("already_present") vs valued
 *    ("already_at_or_above_requested_value") sub-cases.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface ApplyConditionInput {
  actorId: string;
  slug: string;
  value: number | null;
}

export interface ApplyConditionCascadeEntry {
  id: string;
  slug: string;
  name: string;
  grantedBy: string;
}

export interface ApplyConditionApplied {
  ok: true;
  actor: { id: string; name: string };
  operation: 'applied';
  condition: {
    id: string;
    slug: string;
    name: string;
    previousValue: number | null;
    existedBefore: boolean;
    value: number | null;
    valueRequested: number | null;
    valueApplied: number | null;
    clamped: boolean;
  };
  cascadeGranted?: ApplyConditionCascadeEntry[];
}

export interface ApplyConditionNoop {
  ok: true;
  actor: { id: string; name: string };
  operation: 'noop';
  condition: {
    id: string;
    slug: string;
    name: string;
    value: number | null;
  };
  reason: 'already_at_or_above_requested_value' | 'already_present';
}

export type ApplyConditionOk = ApplyConditionApplied | ApplyConditionNoop;

export interface ApplyConditionErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApplyConditionResult = ApplyConditionOk | ApplyConditionErr;

/** Actor types this tool will mutate. Mirrors get_actor_state's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc', 'familiar'] as const;

export async function applyConditionBody(
  input: ApplyConditionInput,
): Promise<ApplyConditionResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc', 'familiar']);
  const VITALS_SLUGS = new Set(['dying', 'wounded', 'doomed']);
  const PERSISTENT_DAMAGE_SLUG = 'persistent-damage';
  const NON_VITAL_VALUED_CAP = 4;

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    flags?: AnyRecord;
    _source?: { system?: AnyRecord };
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    itemTypes?: { condition?: ItemDocLike[] };
    getCondition(slug: string): ItemDocLike | null | undefined;
    increaseCondition(
      slug: string,
      options?: { value?: number; max?: number },
    ): Promise<ItemDocLike | null>;
  }
  interface ConditionTemplateLike {
    system?: { value?: { isValued?: boolean; value?: number | null } };
  }
  interface ConditionManagerLike {
    conditionsSlugs: string[];
    getCondition(slug: string): ConditionTemplateLike | null;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    pf2e?: { ConditionManager?: ConditionManagerLike };
  }

  const fail = (message: string, details: Record<string, unknown>): ApplyConditionErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;

  // -- Resolve actor.
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, {
      actorId: input.actorId,
      reason: 'ACTOR_NOT_FOUND',
    });
  }

  // -- Validate actor type.
  const actorType = typeof actor.type === 'string' ? actor.type : '';
  if (!SUPPORTED.has(actorType)) {
    return fail(
      `Actor type '${actorType}' is not supported by apply_condition. ` +
        `Supported types: character, npc, familiar. ` +
        `(party/loot/hazard/vehicle/army actors do not carry the condition machinery.)`,
      {
        actorId: input.actorId,
        type: actorType,
        reason: 'ACTOR_TYPE_UNSUPPORTED',
      },
    );
  }

  // -- Resolve ConditionManager and validate slug.
  const CM = game?.pf2e?.ConditionManager;
  if (!CM) {
    return fail(`game.pf2e.ConditionManager is unavailable — the PF2e system may not be loaded.`, {
      reason: 'CONDITION_MANAGER_UNAVAILABLE',
    });
  }

  const slugList: string[] = Array.isArray(CM.conditionsSlugs) ? CM.conditionsSlugs : [];
  if (!slugList.includes(input.slug)) {
    return fail(
      `No PF2e condition found for slug: '${input.slug}'. ` +
        `Valid slugs are exposed at game.pf2e.ConditionManager.conditionsSlugs ` +
        `(44 entries in PF2e 8.1.2: frightened, off-guard, dying, etc.). ` +
        `For rules text on a specific condition, see https://2e.aonprd.com/Conditions.aspx.`,
      { slug: input.slug, reason: 'CONDITION_NOT_FOUND' },
    );
  }

  // -- Reject persistent-damage up front (opens a dialog).
  if (input.slug === PERSISTENT_DAMAGE_SLUG) {
    return fail(
      `Slug 'persistent-damage' is not supported by apply_condition because PF2e's ` +
        `increaseCondition path opens PersistentDamageEditor (a UI dialog) which blocks in the ` +
        `headless GM client. Use foundry_eval with actor.createEmbeddedDocuments and the ` +
        `structured persistent shape ({formula, damageType, dc, criticalHit}) for now; a ` +
        `dedicated apply_persistent_damage tool may follow.`,
      { slug: input.slug, reason: 'PERSISTENT_DAMAGE_NOT_SUPPORTED' },
    );
  }

  // -- Load template to determine isValued.
  const template = CM.getCondition(input.slug);
  if (!template) {
    // Slug is in conditionsSlugs but template lookup failed — shouldn't
    // happen in practice; defensive.
    return fail(
      `Condition template lookup returned null for slug: '${input.slug}'. ` +
        `This indicates an inconsistency in PF2e's ConditionManager state.`,
      { slug: input.slug, reason: 'CONDITION_TEMPLATE_MISSING' },
    );
  }
  const isValued = template.system?.value?.isValued === true;

  // -- Validate value parameter against template's isValued.
  if (input.value !== null && !isValued) {
    return fail(
      `Slug '${input.slug}' is a non-valued condition; passing a value is not supported. ` +
        `Non-valued conditions (off-guard, prone, blinded, fascinated, etc.) toggle on/off and ` +
        `do not carry a numeric value. Omit 'value' to apply.`,
      {
        slug: input.slug,
        value: input.value,
        reason: 'VALUE_ON_NON_VALUED_CONDITION',
      },
    );
  }

  // -- Read current state.
  // For vitals: canonical source is system.attributes.{slug}.{value,max}.
  // For non-vitals: read the condition item if present.
  const existingItem = actor.getCondition(input.slug) ?? null;
  const existedBefore = existingItem != null;

  let currentValue: number | null = null;
  let effectiveMax: number | null = null;
  if (isValued) {
    if (VITALS_SLUGS.has(input.slug)) {
      const attrs = (actor.system?.attributes as AnyRecord | undefined) ?? {};
      const vital = (attrs[input.slug] as AnyRecord | undefined) ?? {};
      currentValue = typeof vital.value === 'number' ? (vital.value as number) : 0;
      effectiveMax = typeof vital.max === 'number' ? (vital.max as number) : NON_VITAL_VALUED_CAP;
    } else {
      const src = existingItem?._source?.system?.value as { value?: number | null } | undefined;
      currentValue = typeof src?.value === 'number' ? src.value : 0;
      effectiveMax = NON_VITAL_VALUED_CAP;
    }
  }

  // -- Determine requested value with default-1 rule.
  const requestedValue: number | null = isValued ? (input.value ?? 1) : null;

  // -- Non-valued path.
  if (!isValued) {
    if (existedBefore && existingItem && existingItem.id) {
      return {
        ok: true,
        actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
        operation: 'noop',
        condition: {
          id: existingItem.id,
          slug: input.slug,
          name: typeof existingItem.name === 'string' ? existingItem.name : '',
          value: null,
        },
        reason: 'already_present',
      };
    }
    // Apply.
    const created = await actor.increaseCondition(input.slug);
    if (!created || !created.id) {
      return fail(`increaseCondition returned no document for slug: '${input.slug}'.`, {
        slug: input.slug,
        reason: 'INCREASE_CONDITION_RETURNED_NULL',
      });
    }
    return buildAppliedResponse({
      actor,
      actorIdFallback: input.actorId,
      created,
      slug: input.slug,
      previousValue: null,
      existedBefore: false,
      valueRequested: null,
      valueApplied: null,
      clamped: false,
    });
  }

  // -- Valued path. Take-max semantics.
  const safeRequested = requestedValue ?? 1;
  const safeMax = effectiveMax ?? NON_VITAL_VALUED_CAP;
  const safeCurrent = currentValue ?? 0;

  // Compute the predicted post-apply value: take-max clamped to effectiveMax.
  const valueAppliedPredicted = Math.min(Math.max(safeCurrent, safeRequested), safeMax);
  const clamped = safeRequested > safeMax;

  // No-op: target equals current → nothing changes.
  if (valueAppliedPredicted <= safeCurrent && existedBefore && existingItem && existingItem.id) {
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'noop',
      condition: {
        id: existingItem.id,
        slug: input.slug,
        name: typeof existingItem.name === 'string' ? existingItem.name : '',
        value: safeCurrent,
      },
      reason: 'already_at_or_above_requested_value',
    };
  }

  // First-time application: pass requested as value, plus effective max.
  // increaseCondition computes clamp(template.value=1, requested, max),
  // which produces the requested value clamped at max.
  //
  // Existing-bump: PF2e's increaseCondition is additive
  // (clamp(current + addend, 1, max)). For take-max we need to add the
  // delta (predicted - current), not the raw requested value.
  const delta = existedBefore ? valueAppliedPredicted - safeCurrent : safeRequested;

  const applied = await actor.increaseCondition(input.slug, {
    value: delta,
    max: safeMax,
  });
  if (!applied || !applied.id) {
    return fail(`increaseCondition returned no document for slug: '${input.slug}'.`, {
      slug: input.slug,
      reason: 'INCREASE_CONDITION_RETURNED_NULL',
    });
  }

  // Re-read post-apply for accurate value (vitals route through attribute
  // path; non-vitals through condition item).
  let valueApplied: number;
  if (VITALS_SLUGS.has(input.slug)) {
    const attrs = (actor.system?.attributes as AnyRecord | undefined) ?? {};
    const vital = (attrs[input.slug] as AnyRecord | undefined) ?? {};
    valueApplied =
      typeof vital.value === 'number' ? (vital.value as number) : valueAppliedPredicted;
  } else {
    const reread = actor.getCondition(input.slug);
    const v = reread?._source?.system?.value as { value?: number | null } | undefined;
    valueApplied = typeof v?.value === 'number' ? (v.value as number) : valueAppliedPredicted;
  }

  return buildAppliedResponse({
    actor,
    actorIdFallback: input.actorId,
    created: applied,
    slug: input.slug,
    previousValue: existedBefore ? safeCurrent : null,
    existedBefore,
    valueRequested: safeRequested,
    valueApplied,
    clamped,
  });

  // ---- helpers (inlined; closures don't survive page.evaluate) ---------

  function buildAppliedResponse(args: {
    actor: ActorDocLike;
    actorIdFallback: string;
    created: ItemDocLike;
    slug: string;
    previousValue: number | null;
    existedBefore: boolean;
    valueRequested: number | null;
    valueApplied: number | null;
    clamped: boolean;
  }): ApplyConditionApplied {
    const conditions = args.actor.itemTypes?.condition ?? [];
    const cascadeGranted: ApplyConditionCascadeEntry[] = [];
    if (args.created.id) {
      // BFS from created.id: find condition entries whose
      // flags.pf2e.grantedBy.id is in the growing 'granted' set. This
      // catches the full transitive cascade (e.g. dying → unconscious
      // → blinded + prone).
      const granted = new Set<string>([args.created.id]);
      const queue: string[] = [args.created.id];
      while (queue.length > 0) {
        const parentId = queue.shift() as string;
        for (const c of conditions) {
          if (!c || !c.id || c.id === args.created.id) continue;
          if (granted.has(c.id)) continue;
          const pf2eFlags = (c.flags?.pf2e as AnyRecord | undefined) ?? {};
          const gbRaw = pf2eFlags.grantedBy as AnyRecord | undefined;
          const gbId =
            gbRaw && typeof gbRaw.id === 'string' && gbRaw.id.length > 0 ? gbRaw.id : null;
          if (gbId !== parentId) continue;
          granted.add(c.id);
          cascadeGranted.push({
            id: c.id,
            slug: typeof c.system?.slug === 'string' ? (c.system.slug as string) : args.slug,
            name: typeof c.name === 'string' ? c.name : '',
            grantedBy: parentId,
          });
          queue.push(c.id);
        }
      }
    }

    const result: ApplyConditionApplied = {
      ok: true,
      actor: { id: args.actor.id ?? args.actorIdFallback, name: args.actor.name ?? '' },
      operation: 'applied',
      condition: {
        id: args.created.id ?? '',
        slug: args.slug,
        name: typeof args.created.name === 'string' ? args.created.name : '',
        previousValue: args.previousValue,
        existedBefore: args.existedBefore,
        value: args.valueApplied,
        valueRequested: args.valueRequested,
        valueApplied: args.valueApplied,
        clamped: args.clamped,
      },
    };
    if (cascadeGranted.length > 0) result.cascadeGranted = cascadeGranted;
    return result;
  }
}
