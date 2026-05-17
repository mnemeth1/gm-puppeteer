/**
 * page.evaluate body for pf2e_remove_condition. Counterpart to pf2e_apply_condition.
 * Decrements a condition's value or removes it entirely, by slug or by the
 * embedded condition item's id.
 *
 * Semantics confirmed by scripts/probe-remove-condition.mjs against Foundry
 * v14.361 + PF2e 8.1.2:
 *
 *  - **API choice.** `actor.decreaseCondition(slug, {forceRemove?})` is the
 *    PF2e helper. Without `forceRemove`, decrements valued conditions by 1
 *    and deletes when hitting 0; non-valued conditions are deleted
 *    immediately. With `forceRemove: true`, deletes the condition outright
 *    regardless of value. Vitals (dying/wounded/doomed) route through the
 *    attribute path (`actor.system.attributes.{slug}.value`) inside the API
 *    call; no special-casing required here. Does not post to chat in PF2e
 *    8.1.2 (verified Phase 1 — same as increaseCondition).
 *
 *  - **Slug XOR conditionId.** Two ways to identify the target:
 *     - `slug`: matches against `actor.itemTypes.condition` by
 *       `system.slug`. The natural "I know what condition I want gone"
 *       form. Slug validated against `game.pf2e.ConditionManager.
 *       conditionsSlugs` to surface a clean `CONDITION_NOT_FOUND` instead
 *       of a downstream throw.
 *     - `conditionId`: the embedded item's id (matches the `id` returned
 *       by `pf2e_get_actor_state`'s `ConditionEntry`). Used when slug is
 *       ambiguous — primarily for the speculative multi-instance case.
 *    Tool-layer schema enforces exactly one is set. Both paths converge
 *    on the same `decreaseCondition(slug, …)` call after resolution.
 *
 *  - **Modes.** `"decrement"` (default at the tool layer) and `"remove"`.
 *    On non-valued conditions (prone, off-guard, blinded), both modes are
 *    silently equivalent — there is no value to decrement, so the result
 *    is a full delete either way. No error on "decrement of non-valued";
 *    the tool's contract is "the requested state change happens," not "the
 *    mode parameter has type-specific semantics."
 *
 *  - **Three operation outcomes.** `removed` (condition fully gone — either
 *    `mode: "remove"`, or `mode: "decrement"` and previousValue ≤ 1, or
 *    non-valued); `decremented` (valued, mode: "decrement", previousValue
 *    > 1 — condition still present with reduced value); `noop` (condition
 *    wasn't on the actor; not an error, mirrors pf2e_apply_condition's no-op
 *    precedent).
 *
 *  - **Cascade visibility.** When a parent like Unconscious is removed,
 *    PF2e auto-deletes children whose `flags.pf2e.grantedBy.onDelete ===
 *    "cascade"` (blinded + prone in the unconscious case). The tool
 *    pre-walks the BFS transitive closure of `flags.pf2e.grantedBy.id`
 *    BEFORE the API call and surfaces it in `cascadeDeleted` on the
 *    `removed` operation. To keep the response truthful regardless of
 *    PF2e's hook reliability (same risk profile as
 *    `pf2e_remove_item_from_actor`), the tool also force-deletes any
 *    cascade-tagged survivors after the API call.
 *
 *  - **Vitals are pure pass-through.** `decreaseCondition` routes the
 *    underlying attribute write for dying/wounded/doomed correctly.
 *    Phase 1 (probe 8) confirmed that `decreaseCondition('dying',
 *    {forceRemove: true})` does NOT auto-increment wounded — the
 *    wounded-on-dying-recovery RAW interaction lives in the actual
 *    recovery-save flow, not in the raw condition-removal API. The tool
 *    therefore neither surfaces nor suppresses any wounded side effect;
 *    callers needing the post-call vitals state should issue a fresh
 *    `pf2e_get_actor_state`. Same contract boundary as pf2e_apply_condition.
 *
 *  - **`persistent-damage` is rejected.** Mirrors pf2e_apply_condition.
 *    Removing a persistent-damage instance via slug is ambiguous (an actor
 *    can carry multiple persistent-damage items of different damage types),
 *    and the PF2e UI routes through `PersistentDamageEditor` for these.
 *    v1 rejects with `PERSISTENT_DAMAGE_NOT_SUPPORTED` on both slug and
 *    conditionId paths; callers should use foundry_eval with
 *    `actor.deleteEmbeddedDocuments` against a specific id.
 *
 *  - **Multi-instance guard.** PF2e single-instances same-slug conditions
 *    in normal operation (`increaseCondition` bumps existing rather than
 *    spawning a duplicate). If world-data corruption or a third-party
 *    module produces >1 condition item with the same slug, the slug-input
 *    path errors with `MULTIPLE_INSTANCES_USE_CONDITION_ID` rather than
 *    silently picking one — the caller should disambiguate via
 *    `conditionId`. Cheap diagnostic; the condition this branch fires on
 *    is rare but not impossible.
 *
 *  - **Actor type support.** `character`, `npc`, `familiar` — same set as
 *    pf2e_apply_condition / pf2e_get_actor_state. Other types (party, loot, hazard,
 *    vehicle, army) don't carry the condition machinery and are rejected
 *    with `ACTOR_TYPE_UNSUPPORTED`.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface RemoveConditionInput {
  actorId: string;
  /** Mutually exclusive with conditionId. Tool layer enforces XOR. */
  slug: string | null;
  /** Mutually exclusive with slug. Tool layer enforces XOR. */
  conditionId: string | null;
  mode: 'decrement' | 'remove';
}

export interface RemoveConditionCascadeEntry {
  id: string;
  slug: string;
  name: string;
  grantedBy: string;
}

export interface RemoveConditionRemoved {
  ok: true;
  actor: { id: string; name: string };
  operation: 'removed';
  condition: {
    id: string;
    slug: string;
    name: string;
    previousValue: number | null;
  };
  cascadeDeleted?: RemoveConditionCascadeEntry[];
}

export interface RemoveConditionDecremented {
  ok: true;
  actor: { id: string; name: string };
  operation: 'decremented';
  condition: {
    id: string;
    slug: string;
    name: string;
    previousValue: number;
    value: number;
  };
}

export interface RemoveConditionNoop {
  ok: true;
  actor: { id: string; name: string };
  operation: 'noop';
  slug: string;
  reason: 'not_present';
}

export type RemoveConditionOk =
  | RemoveConditionRemoved
  | RemoveConditionDecremented
  | RemoveConditionNoop;

export interface RemoveConditionErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RemoveConditionResult = RemoveConditionOk | RemoveConditionErr;

/** Actor types this tool will mutate. Mirrors pf2e_apply_condition's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc', 'familiar'] as const;

export async function removeConditionBody(
  input: RemoveConditionInput,
): Promise<RemoveConditionResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc', 'familiar']);
  const VITALS_SLUGS = new Set(['dying', 'wounded', 'doomed']);
  const PERSISTENT_DAMAGE_SLUG = 'persistent-damage';

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
    items?: {
      contents?: ItemDocLike[];
      get?(id: string): ItemDocLike | undefined;
    };
    itemTypes?: { condition?: ItemDocLike[] };
    decreaseCondition(
      slug: string,
      options?: { forceRemove?: boolean },
    ): Promise<ItemDocLike | null>;
    deleteEmbeddedDocuments(name: 'Item', ids: string[]): Promise<ItemDocLike[]>;
  }
  interface ConditionManagerLike {
    conditionsSlugs: string[];
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    pf2e?: { ConditionManager?: ConditionManagerLike };
  }

  const fail = (message: string, details: Record<string, unknown>): RemoveConditionErr => ({
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
      `Actor type '${actorType}' is not supported by pf2e_remove_condition. ` +
        `Supported types: character, npc, familiar. ` +
        `(party/loot/hazard/vehicle/army actors do not carry the condition machinery.)`,
      {
        actorId: input.actorId,
        type: actorType,
        reason: 'ACTOR_TYPE_UNSUPPORTED',
      },
    );
  }

  // -- Resolve ConditionManager (defensive — needed for slug validation
  // and as a system-loaded sanity check).
  const CM = game?.pf2e?.ConditionManager;
  if (!CM) {
    return fail(`game.pf2e.ConditionManager is unavailable — the PF2e system may not be loaded.`, {
      reason: 'CONDITION_MANAGER_UNAVAILABLE',
    });
  }

  // -- Resolve target condition item via either input path.
  const conditions: ItemDocLike[] = actor.itemTypes?.condition ?? [];
  let targetItem: ItemDocLike | null = null;
  let resolvedSlug: string;

  if (input.conditionId !== null) {
    const item = actor.items?.get?.(input.conditionId);
    if (!item || !item.id) {
      return fail(
        `No item found on actor ${actor.id ?? input.actorId} for conditionId: ${input.conditionId}`,
        {
          actorId: input.actorId,
          conditionId: input.conditionId,
          reason: 'CONDITION_ID_NOT_ON_ACTOR',
        },
      );
    }
    if (item.type !== 'condition') {
      return fail(
        `Item ${input.conditionId} on actor ${actor.id ?? input.actorId} is not a condition ` +
          `(type='${typeof item.type === 'string' ? item.type : ''}'). pf2e_remove_condition only ` +
          `operates on items of type 'condition'.`,
        {
          actorId: input.actorId,
          conditionId: input.conditionId,
          type: typeof item.type === 'string' ? item.type : '',
          reason: 'NOT_A_CONDITION_ITEM',
        },
      );
    }
    const itemSlug = item.system?.slug;
    if (typeof itemSlug !== 'string' || itemSlug.length === 0) {
      return fail(
        `Item ${input.conditionId} has no system.slug — cannot route through decreaseCondition.`,
        {
          actorId: input.actorId,
          conditionId: input.conditionId,
          reason: 'CONDITION_ITEM_MISSING_SLUG',
        },
      );
    }
    if (itemSlug === PERSISTENT_DAMAGE_SLUG) {
      return fail(
        `Item ${input.conditionId} is a persistent-damage condition. pf2e_remove_condition does not ` +
          `support persistent-damage in v1. Use foundry_eval with actor.deleteEmbeddedDocuments ` +
          `to remove a specific persistent-damage instance by id.`,
        {
          actorId: input.actorId,
          conditionId: input.conditionId,
          slug: itemSlug,
          reason: 'PERSISTENT_DAMAGE_NOT_SUPPORTED',
        },
      );
    }
    targetItem = item;
    resolvedSlug = itemSlug;
  } else {
    if (input.slug === null) {
      return fail(`Neither 'slug' nor 'conditionId' was provided. Exactly one is required.`, {
        reason: 'MISSING_TARGET_INPUT',
      });
    }
    resolvedSlug = input.slug;

    const slugList: string[] = Array.isArray(CM.conditionsSlugs) ? CM.conditionsSlugs : [];
    if (!slugList.includes(resolvedSlug)) {
      return fail(
        `No PF2e condition found for slug: '${resolvedSlug}'. ` +
          `Valid slugs are exposed at game.pf2e.ConditionManager.conditionsSlugs ` +
          `(44 entries in PF2e 8.1.2). For rules text on a specific condition see ` +
          `https://2e.aonprd.com/Conditions.aspx.`,
        { slug: resolvedSlug, reason: 'CONDITION_NOT_FOUND' },
      );
    }

    if (resolvedSlug === PERSISTENT_DAMAGE_SLUG) {
      return fail(
        `Slug 'persistent-damage' is not supported by pf2e_remove_condition in v1. ` +
          `Multiple persistent-damage instances can co-exist on an actor (one per damage type), ` +
          `and the PF2e UI routes these through PersistentDamageEditor. Use foundry_eval with ` +
          `actor.deleteEmbeddedDocuments against a specific id for now.`,
        { slug: resolvedSlug, reason: 'PERSISTENT_DAMAGE_NOT_SUPPORTED' },
      );
    }

    const matches = conditions.filter(
      (c) => typeof c?.system?.slug === 'string' && c.system.slug === resolvedSlug,
    );
    if (matches.length === 0) {
      return {
        ok: true,
        actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
        operation: 'noop',
        slug: resolvedSlug,
        reason: 'not_present',
      };
    }
    if (matches.length > 1) {
      return fail(
        `Actor ${actor.id ?? input.actorId} has ${matches.length} condition items with slug ` +
          `'${resolvedSlug}'. PF2e normally single-instances same-slug conditions; this is ` +
          `unusual. Pass 'conditionId' instead to remove a specific instance.`,
        {
          actorId: input.actorId,
          slug: resolvedSlug,
          matchCount: matches.length,
          reason: 'MULTIPLE_INSTANCES_USE_CONDITION_ID',
        },
      );
    }
    targetItem = matches[0] ?? null;
  }

  if (!targetItem || !targetItem.id) {
    return fail(
      `Internal: target condition resolution returned null without an error path firing.`,
      { reason: 'INTERNAL_RESOLUTION_FAILURE' },
    );
  }
  const targetId = targetItem.id;
  const targetName = typeof targetItem.name === 'string' ? targetItem.name : '';

  // -- Determine isValued (vitals are always valued; otherwise read from
  // the live item's system.value.isValued).
  const isValued = VITALS_SLUGS.has(resolvedSlug)
    ? true
    : Boolean(
        (targetItem.system?.value as AnyRecord | undefined)?.isValued ??
        (targetItem._source?.system?.value as AnyRecord | undefined)?.isValued,
      );

  // -- Read previousValue.
  let previousValue: number | null;
  if (isValued) {
    if (VITALS_SLUGS.has(resolvedSlug)) {
      const attrs = (actor.system?.attributes as AnyRecord | undefined) ?? {};
      const vital = (attrs[resolvedSlug] as AnyRecord | undefined) ?? {};
      previousValue = typeof vital.value === 'number' ? (vital.value as number) : 0;
    } else {
      const src = targetItem._source?.system?.value as { value?: number | null } | undefined;
      previousValue = typeof src?.value === 'number' ? src.value : 0;
    }
  } else {
    previousValue = null;
  }

  // -- Pre-walk cascade children BFS-transitively before any delete.
  const cascadeDeleted: RemoveConditionCascadeEntry[] = [];
  {
    const seen = new Set<string>([targetId]);
    const queue: string[] = [targetId];
    while (queue.length > 0) {
      const parentId = queue.shift() as string;
      for (const c of conditions) {
        if (!c || !c.id || c.id === targetId || seen.has(c.id)) continue;
        const pf2eFlags = (c.flags?.pf2e as AnyRecord | undefined) ?? {};
        const gbRaw = pf2eFlags.grantedBy as AnyRecord | undefined;
        const gbId = gbRaw && typeof gbRaw.id === 'string' && gbRaw.id.length > 0 ? gbRaw.id : null;
        if (gbId !== parentId) continue;
        seen.add(c.id);
        cascadeDeleted.push({
          id: c.id,
          slug: typeof c.system?.slug === 'string' ? (c.system.slug as string) : '',
          name: typeof c.name === 'string' ? c.name : '',
          grantedBy: parentId,
        });
        queue.push(c.id);
      }
    }
  }

  // -- Compute willRemove.
  //   - mode: 'remove' always removes.
  //   - non-valued conditions: decrement === remove (silent equivalence).
  //   - valued at previousValue <= 1: decrement collapses to delete.
  const willRemove = input.mode === 'remove' || !isValued || (previousValue ?? 0) <= 1;

  // -- Issue the API call.
  await actor.decreaseCondition(resolvedSlug, willRemove ? { forceRemove: true } : undefined);

  // -- Post-call cascade enforcement (mirrors pf2e_remove_item_from_actor):
  // PF2e's cascade-on-delete hook depends on the parent carrying a
  // matching GrantItem rule. We pre-walked by the child's grantedBy flag,
  // which is the truthier signal; force-delete any cascade-tagged
  // survivors.
  if (willRemove && cascadeDeleted.length > 0) {
    const survivors = cascadeDeleted
      .map((c) => c.id)
      .filter((id) => Boolean(actor.items?.get?.(id)));
    if (survivors.length > 0) {
      await actor.deleteEmbeddedDocuments('Item', survivors);
    }
  }

  // -- Build response.
  if (willRemove) {
    const result: RemoveConditionRemoved = {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'removed',
      condition: {
        id: targetId,
        slug: resolvedSlug,
        name: targetName,
        previousValue,
      },
    };
    if (cascadeDeleted.length > 0) result.cascadeDeleted = cascadeDeleted;
    return result;
  }

  // Decremented: re-read post-state value (vitals via attribute path,
  // non-vitals via the condition item's _source).
  let newValue: number;
  if (VITALS_SLUGS.has(resolvedSlug)) {
    const attrs = (actor.system?.attributes as AnyRecord | undefined) ?? {};
    const vital = (attrs[resolvedSlug] as AnyRecord | undefined) ?? {};
    newValue =
      typeof vital.value === 'number'
        ? (vital.value as number)
        : Math.max(0, (previousValue ?? 0) - 1);
  } else {
    const reread = actor.items?.get?.(targetId);
    const v = reread?._source?.system?.value as { value?: number | null } | undefined;
    newValue = typeof v?.value === 'number' ? v.value : Math.max(0, (previousValue ?? 0) - 1);
  }

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'decremented',
    condition: {
      id: targetId,
      slug: resolvedSlug,
      name: targetName,
      previousValue: previousValue ?? 0,
      value: newValue,
    },
  };
}
