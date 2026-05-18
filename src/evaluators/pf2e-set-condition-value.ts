/**
 * page.evaluate body for pf2e_set_condition_value. Third tool in the condition-
 * mutation cluster (siblings: pf2e_apply_condition for take-max increment,
 * pf2e_remove_condition for decrement/clear). Sets a VALUED PF2e condition to
 * an absolute value N — fills the gap between pf2e_apply_condition (which can
 * only raise) and pf2e_remove_condition (which can only decrement-by-1 or
 * force-clear). Useful when a GM wants an exact mid-encounter value
 * ("frightened to 2") without cycling through multiple sibling calls.
 *
 * Semantics confirmed by scripts/probe-set-condition-value.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *
 *  - **Going-up API.** Reuses pf2e_apply_condition's mechanism:
 *    `actor.increaseCondition(slug, {value: delta, max})` with delta =
 *    (requested - current) for existing-bump, or requested directly on
 *    first-time creation. Fires the GrantItem cascade (e.g. dying →
 *    unconscious → blinded + prone) on first-time creation. Same
 *    take-max math as pf2e_apply_condition (the only difference is that
 *    pf2e_apply_condition refuses to lower; this tool routes the lower-case
 *    to the down-path below).
 *
 *  - **Going-down API.** UNIFORM across vitals and non-vitals:
 *    `actor.updateEmbeddedDocuments('Item', [{_id: existingId,
 *    'system.value.value': N}])`. Phase 1 readback confirmed:
 *      * Non-vital (frightened 4 → 2): system.value.value AND _source.
 *        system.value.value both reflect N; same item id; count
 *        unchanged.
 *      * Vital (dying 3 → 1): same as above, AND the derived attribute
 *        `actor.system.attributes.dying.value` propagates to N. Cascade
 *        children (unconscious + blinded + prone) remain attached.
 *    The condition item is the source of truth for vitals; the attribute
 *    is a derived/synced view (Phase 1 Probe 1.D confirmed: writing the
 *    attribute alone is silently reverted by PF2e's prep cycle when an
 *    existing higher-value condition item is present, so the
 *    `actor.update({'system.attributes.{slug}.value': N})` path is
 *    rejected for the down case).
 *
 *  - **Cascade visibility.** Cascade fires on item CREATION, not on
 *    item value-update. Therefore:
 *      * Going up from absent → N: cascadeGranted populated (same BFS
 *        from pf2e_apply_condition's buildAppliedResponse).
 *      * Going up from existing-lower → N: cascadeGranted omitted (the
 *        parent item already exists; no new cascade fires).
 *      * Going down → N (N > 0): cascadeGranted omitted (no cascade
 *        deletions; children persist until parent fully removed).
 *
 *  - **value: 0 rejected.** Mirrors pf2e_update_item_quantity's qty-0 policy.
 *    The zod schema rejects at the MCP boundary via `.min(1)`; the
 *    evaluator carries its own defensive guard for direct callers. The
 *    rejection points to pf2e_remove_condition (mode: "remove") as the
 *    canonical clearing path.
 *
 *  - **Non-valued conditions rejected.** pf2e_set_condition_value is for
 *    valued conditions only (frightened, sickened, stupefied, slowed,
 *    drained, clumsy, enfeebled, stunned, dying, wounded, doomed). Non-
 *    valued conditions (off-guard, prone, blinded, fascinated, etc.)
 *    toggle on/off — pf2e_apply_condition is the on-switch, pf2e_remove_condition
 *    is the off-switch. Rejected with NON_VALUED_CONDITION_NOT_SUPPORTED
 *    and a pointer to the siblings.
 *
 *  - **persistent-damage rejected.** Same story as pf2e_apply_condition /
 *    pf2e_remove_condition — `increaseCondition('persistent-damage')` opens a
 *    UI dialog (PersistentDamageEditor) that blocks in the headless
 *    client.
 *
 *  - **Clamp.** effectiveMax = `actor.system.attributes[slug].max` for
 *    vitals (doomed reduces dying.max dynamically), 4 for non-vital
 *    valued conditions. valueApplied = min(requested, effectiveMax).
 *    clamped: true when requested > effectiveMax.
 *
 *  - **No-op.** When the condition is already present and the (clamped)
 *    requested value equals the current value, operation: "noop",
 *    reason: "already_at_requested_value". Mirrors the pf2e_apply_condition
 *    and pf2e_update_item_quantity no-op precedents.
 *
 *  - **No chat posted.** Inherited from increaseCondition and
 *    updateEmbeddedDocuments. Same as siblings.
 *
 *  - **Actor type support.** character, npc, familiar — same set as
 *    pf2e_apply_condition / pf2e_remove_condition / pf2e_get_actor_state.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface Pf2eSetConditionValueInput {
  actorId: string;
  slug: string;
  value: number;
}

export interface Pf2eSetConditionValueCascadeEntry {
  id: string;
  slug: string;
  name: string;
  grantedBy: string;
}

export interface Pf2eSetConditionValueApplied {
  ok: true;
  actor: { id: string; name: string };
  operation: 'applied';
  condition: {
    id: string;
    slug: string;
    name: string;
    previousValue: number | null;
    existedBefore: boolean;
    value: number;
    valueRequested: number;
    valueApplied: number;
    clamped: boolean;
  };
  cascadeGranted?: Pf2eSetConditionValueCascadeEntry[];
}

export interface Pf2eSetConditionValueNoop {
  ok: true;
  actor: { id: string; name: string };
  operation: 'noop';
  condition: {
    id: string;
    slug: string;
    name: string;
    value: number;
  };
  reason: 'already_at_requested_value';
}

export type Pf2eSetConditionValueOk = Pf2eSetConditionValueApplied | Pf2eSetConditionValueNoop;

export interface Pf2eSetConditionValueErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Pf2eSetConditionValueResult = Pf2eSetConditionValueOk | Pf2eSetConditionValueErr;

/** Actor types this tool will mutate. Mirrors pf2e_apply_condition's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc', 'familiar'] as const;

export async function pf2eSetConditionValueBody(
  input: Pf2eSetConditionValueInput,
): Promise<Pf2eSetConditionValueResult> {
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
    updateEmbeddedDocuments(
      embeddedName: string,
      updates: Array<Record<string, unknown>>,
    ): Promise<ItemDocLike[]>;
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

  const fail = (message: string, details: Record<string, unknown>): Pf2eSetConditionValueErr => ({
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
      `Actor type '${actorType}' is not supported by pf2e_set_condition_value. ` +
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
        `(44 entries in PF2e 8.1.2). For rules text on a specific condition, see ` +
        `https://2e.aonprd.com/Conditions.aspx.`,
      { slug: input.slug, reason: 'CONDITION_NOT_FOUND' },
    );
  }

  // -- Reject persistent-damage up front.
  if (input.slug === PERSISTENT_DAMAGE_SLUG) {
    return fail(
      `Slug 'persistent-damage' is not supported by pf2e_set_condition_value because PF2e's ` +
        `increaseCondition path opens PersistentDamageEditor (a UI dialog) which blocks in the ` +
        `headless GM client. Use foundry_eval with actor.createEmbeddedDocuments / ` +
        `updateEmbeddedDocuments and the structured persistent shape ` +
        `({formula, damageType, dc, criticalHit}) for manual manipulation.`,
      { slug: input.slug, reason: 'PERSISTENT_DAMAGE_NOT_SUPPORTED' },
    );
  }

  // -- Load template to determine isValued.
  const template = CM.getCondition(input.slug);
  if (!template) {
    return fail(
      `Condition template lookup returned null for slug: '${input.slug}'. ` +
        `This indicates an inconsistency in PF2e's ConditionManager state.`,
      { slug: input.slug, reason: 'CONDITION_TEMPLATE_MISSING' },
    );
  }
  const isValued = template.system?.value?.isValued === true;

  // -- Reject non-valued conditions.
  if (!isValued) {
    return fail(
      `Slug '${input.slug}' is a non-valued condition; pf2e_set_condition_value is for valued ` +
        `conditions only (frightened, sickened, stupefied, slowed, drained, clumsy, enfeebled, ` +
        `stunned, dying, wounded, doomed). Non-valued conditions toggle on/off — use ` +
        `pf2e_apply_condition to set on and pf2e_remove_condition to clear.`,
      {
        slug: input.slug,
        reason: 'NON_VALUED_CONDITION_NOT_SUPPORTED',
      },
    );
  }

  // -- Defensive: reject value <= 0 or non-integer (zod's .min(1) already
  // enforces this at the MCP boundary; this guard catches direct evaluator
  // callers like probes that bypass zod).
  if (!Number.isInteger(input.value) || input.value < 1) {
    return fail(
      `value must be an integer >= 1; received ${input.value}. To clear a condition entirely, ` +
        `use pf2e_remove_condition with mode: "remove".`,
      {
        slug: input.slug,
        value: input.value,
        reason: 'VALUE_ZERO_USE_REMOVE_CONDITION',
      },
    );
  }

  // -- Read current state.
  const existingItem = actor.getCondition(input.slug) ?? null;
  const existedBefore = existingItem != null;

  let currentValue: number;
  let effectiveMax: number;
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

  // -- Compute valueApplied with clamp.
  const requested = input.value;
  const valueApplied = Math.min(requested, effectiveMax);
  const clamped = requested > effectiveMax;

  // -- No-op: condition already present at requested (clamped) value.
  if (existedBefore && existingItem && existingItem.id && valueApplied === currentValue) {
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'noop',
      condition: {
        id: existingItem.id,
        slug: input.slug,
        name: typeof existingItem.name === 'string' ? existingItem.name : '',
        value: currentValue,
      },
      reason: 'already_at_requested_value',
    };
  }

  // -- Branch: going up vs going down.
  let resultItem: ItemDocLike | null;
  if (!existedBefore || valueApplied > currentValue) {
    // Going up. Reuse pf2e_apply_condition's pattern.
    const delta = existedBefore ? valueApplied - currentValue : valueApplied;
    const applied = await actor.increaseCondition(input.slug, {
      value: delta,
      max: effectiveMax,
    });
    if (!applied || !applied.id) {
      return fail(`increaseCondition returned no document for slug: '${input.slug}'.`, {
        slug: input.slug,
        reason: 'INCREASE_CONDITION_RETURNED_NULL',
      });
    }
    resultItem = applied;
  } else {
    // Going down. existedBefore is guaranteed true (otherwise currentValue
    // would be 0 and we'd be on the up-path). Direct embedded-item update.
    if (!existingItem || !existingItem.id) {
      // Defensive — shouldn't happen given existedBefore guard.
      return fail(
        `Internal: existing condition item lost between check and update for slug: '${input.slug}'.`,
        { slug: input.slug, reason: 'EXISTING_ITEM_LOST' },
      );
    }
    await actor.updateEmbeddedDocuments('Item', [
      { _id: existingItem.id, 'system.value.value': valueApplied },
    ]);
    resultItem = actor.getCondition(input.slug) ?? existingItem;
  }

  // -- Re-read post-state value (vitals via attribute, non-vitals via item).
  let postValue: number;
  if (VITALS_SLUGS.has(input.slug)) {
    const attrs = (actor.system?.attributes as AnyRecord | undefined) ?? {};
    const vital = (attrs[input.slug] as AnyRecord | undefined) ?? {};
    postValue = typeof vital.value === 'number' ? (vital.value as number) : valueApplied;
  } else {
    const reread = actor.getCondition(input.slug);
    const v = reread?._source?.system?.value as { value?: number | null } | undefined;
    postValue = typeof v?.value === 'number' ? v.value : valueApplied;
  }

  // -- Build applied response.
  const conditions = actor.itemTypes?.condition ?? [];
  const cascadeGranted: Pf2eSetConditionValueCascadeEntry[] = [];
  // Cascade BFS only when going-up-from-absent — cascades fire on item
  // creation, not on value-update.
  if (!existedBefore && resultItem && resultItem.id) {
    const granted = new Set<string>([resultItem.id]);
    const queue: string[] = [resultItem.id];
    while (queue.length > 0) {
      const parentId = queue.shift() as string;
      for (const c of conditions) {
        if (!c || !c.id || c.id === resultItem.id) continue;
        if (granted.has(c.id)) continue;
        const pf2eFlags = (c.flags?.pf2e as AnyRecord | undefined) ?? {};
        const gbRaw = pf2eFlags.grantedBy as AnyRecord | undefined;
        const gbId = gbRaw && typeof gbRaw.id === 'string' && gbRaw.id.length > 0 ? gbRaw.id : null;
        if (gbId !== parentId) continue;
        granted.add(c.id);
        cascadeGranted.push({
          id: c.id,
          slug: typeof c.system?.slug === 'string' ? (c.system.slug as string) : input.slug,
          name: typeof c.name === 'string' ? c.name : '',
          grantedBy: parentId,
        });
        queue.push(c.id);
      }
    }
  }

  const response: Pf2eSetConditionValueApplied = {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'applied',
    condition: {
      id: resultItem?.id ?? '',
      slug: input.slug,
      name: typeof resultItem?.name === 'string' ? resultItem.name : '',
      previousValue: existedBefore ? currentValue : null,
      existedBefore,
      value: postValue,
      valueRequested: requested,
      valueApplied: postValue,
      clamped,
    },
  };
  if (cascadeGranted.length > 0) response.cascadeGranted = cascadeGranted;
  return response;
}
