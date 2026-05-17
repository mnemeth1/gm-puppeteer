/**
 * page.evaluate body for dnd5e_apply_condition. Applies a D&D 5e status —
 * a core condition, a pseudo-condition, or a plain status — to an actor.
 * Sibling to `dnd5e_get_available_conditions` (enumerate the applyable
 * statuses), `dnd5e_remove_condition`, and the future
 * `dnd5e_set_condition_value`. This is the take-max apply operation,
 * parallel to `pf2e_apply_condition`.
 *
 * Semantics confirmed by scripts/probe-dnd5e-apply-condition.mjs against
 * Foundry v14.361 + dnd5e 5.3.3 (rules setting "modern" / 2024):
 *
 *  - **No condition Item type, no ConditionManager.** 5e statuses are
 *    entries in `CONFIG.statusEffects` (43 in 5.3.3). Applying one creates
 *    a backing `ActiveEffect` on the actor and adds the id to
 *    `actor.statuses` (a `Set<string>`). `actor.toggleStatusEffect(id,
 *    {active: true})` is the apply API — it returns the created
 *    `ActiveEffect` data object on a real change, and `false` when the
 *    status is already present (no duplicate created). The tool checks
 *    `actor.statuses` up front rather than relying on the polymorphic
 *    return value.
 *
 *  - **Valued split: 1 / 42.** `exhaustion` is the only valued condition
 *    (`CONFIG.DND5E.conditionTypes.exhaustion.levels` = 6, the 2024 cap).
 *    `valued` is derived from `conditionTypes[id].levels`, not hardcoded.
 *    Every other status is a pure on/off toggle — passing `value` on one
 *    is rejected with VALUE_ON_NON_VALUED_CONDITION.
 *
 *  - **Exhaustion is NOT applied via toggleStatusEffect.** Toggling the
 *    `exhaustion` status is a no-op in dnd5e (returns `false`, sets no
 *    level). Exhaustion lives on `system.attributes.exhaustion`; the only
 *    write path is `actor.update({'system.attributes.exhaustion': N})`.
 *    The system then maintains the `exhaustion` status and the
 *    "Exhaustion N" ActiveEffect through its data-preparation cycle.
 *
 *  - **Exhaustion reads use `_source`.** Within one page.evaluate call the
 *    *prepared* `actor.system.attributes.exhaustion` lags a write by one
 *    operation (derived data re-prepares asynchronously), but
 *    `actor._source.system.attributes.exhaustion` is always immediately
 *    correct. The tool reads current exhaustion from `_source` and returns
 *    the computed post-apply value rather than re-reading prepared data.
 *
 *  - **Take-max semantics for exhaustion.** Mirrors pf2e_apply_condition:
 *    the actor ends at `min(max(current, requested), 6)`. `value` defaults
 *    to 1 when omitted. When the actor is already at or above the
 *    requested level the result is `operation: "noop"` —
 *    `already_at_or_above_requested_value`. `clamped: true` is surfaced
 *    when the requested level exceeded 6.
 *
 *  - **Cascade.** Some conditions carry rider statuses (dnd5e
 *    `conditionTypes[id].riders`) — applying `unconscious` also applies
 *    `incapacitated`. The tool diffs `actor.statuses` across the awaited
 *    toggle and surfaces any extra ids in `cascadeApplied`.
 *
 *  - **No chat posted.** `toggleStatusEffect` does not post to chat
 *    (probed: `game.messages.size` unchanged across applications).
 *
 *  - **Actor type support.** `character`, `npc` — same set as
 *    dnd5e_get_actor_state. `vehicle` / `group` / `encounter` are rejected
 *    with ACTOR_TYPE_UNSUPPORTED. 5e has no `familiar` actor type.
 *
 *  - **No-op as success.** A status already present, or an exhaustion
 *    level already at/above the request, returns `operation: "noop"` —
 *    NOT an error. Same precedent as pf2e_apply_condition.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper and constant is defined inline.
 */
export type Dnd5eConditionCategory = 'condition' | 'pseudo-condition' | 'status';

export interface Dnd5eApplyConditionInput {
  actorId: string;
  statusId: string;
  value: number | null;
}

export interface Dnd5eApplyConditionApplied {
  ok: true;
  actor: { id: string; name: string };
  operation: 'applied';
  condition: {
    statusId: string;
    name: string;
    category: Dnd5eConditionCategory;
    valued: boolean;
    previousValue: number | null;
    existedBefore: boolean;
    value: number | null;
    valueRequested: number | null;
    valueApplied: number | null;
    clamped: boolean;
  };
  effectId: string | null;
  cascadeApplied?: string[];
}

export interface Dnd5eApplyConditionNoop {
  ok: true;
  actor: { id: string; name: string };
  operation: 'noop';
  condition: {
    statusId: string;
    name: string;
    category: Dnd5eConditionCategory;
    valued: boolean;
    value: number | null;
  };
  reason: 'already_present' | 'already_at_or_above_requested_value';
}

export type Dnd5eApplyConditionOk = Dnd5eApplyConditionApplied | Dnd5eApplyConditionNoop;

export interface Dnd5eApplyConditionErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'STATUS_EFFECTS_UNAVAILABLE'
        | 'STATUS_NOT_FOUND'
        | 'VALUE_ON_NON_VALUED_CONDITION'
        | 'APPLY_FAILED';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eApplyConditionResult = Dnd5eApplyConditionOk | Dnd5eApplyConditionErr;

/** Actor types this tool will mutate. Mirrors dnd5e_get_actor_state's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

export async function dnd5eApplyConditionBody(
  input: Dnd5eApplyConditionInput,
): Promise<Dnd5eApplyConditionResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);
  const EXHAUSTION_ID = 'exhaustion';

  type AnyRecord = Record<string, unknown>;
  interface EffectLike {
    id?: string;
    name?: string;
    statuses?: Iterable<string>;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    statuses?: Iterable<string>;
    system?: AnyRecord;
    _source?: AnyRecord;
    effects?: { contents?: EffectLike[] };
    toggleStatusEffect(id: string, options?: { active?: boolean }): Promise<unknown>;
    update(data: AnyRecord): Promise<unknown>;
  }
  interface ConditionTypeLike {
    name?: unknown;
    pseudo?: unknown;
    levels?: unknown;
  }
  interface StatusEffectLike {
    id?: unknown;
    name?: unknown;
    label?: unknown;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
  }
  interface FoundryConfigLike {
    statusEffects?: unknown;
    DND5E?: { conditionTypes?: Record<string, ConditionTypeLike> };
  }

  const fail = (
    message: string,
    details: Dnd5eApplyConditionErr['error']['details'],
  ): Dnd5eApplyConditionErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const titleCase = (s: string): string =>
    s
      .split(/[-_\s]+/)
      .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ');

  const toArray = (s: Iterable<string> | undefined): string[] =>
    s && typeof (s as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
      ? Array.from(s)
      : [];

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const CONFIG = (globalThis as unknown as { CONFIG?: FoundryConfigLike }).CONFIG;

  // -- Resolve actor.
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, {
      reason: 'ACTOR_NOT_FOUND',
      actorId: input.actorId,
    });
  }

  // -- Validate actor type.
  const actorType = typeof actor.type === 'string' ? actor.type : '';
  if (!SUPPORTED.has(actorType)) {
    return fail(
      `Actor type '${actorType}' is not supported by dnd5e_apply_condition. ` +
        `Supported types: character, npc. (vehicle / group / encounter actors do not ` +
        `carry the status-effect machinery.)`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', actorId: input.actorId, type: actorType },
    );
  }

  // -- Validate statusId against CONFIG.statusEffects.
  const statusEffects = CONFIG?.statusEffects;
  if (!Array.isArray(statusEffects)) {
    return fail(
      `CONFIG.statusEffects is unavailable — the D&D 5e system may not be loaded.`,
      { reason: 'STATUS_EFFECTS_UNAVAILABLE' },
    );
  }
  const statusRow = (statusEffects as StatusEffectLike[]).find(
    (r) => r !== null && typeof r === 'object' && r.id === input.statusId,
  );
  if (!statusRow) {
    return fail(
      `No D&D 5e status found for statusId: '${input.statusId}'. Valid ids are ` +
        `enumerated by dnd5e_get_available_conditions (the 'statusId' field of each row).`,
      { reason: 'STATUS_NOT_FOUND', statusId: input.statusId },
    );
  }

  // -- Classify: category, valued, display name.
  const conditionTypes = CONFIG?.DND5E?.conditionTypes;
  const hasConditionTypes =
    conditionTypes !== undefined && conditionTypes !== null && typeof conditionTypes === 'object';
  const ct = hasConditionTypes ? conditionTypes[input.statusId] : undefined;
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
    typeof statusRow.name === 'string' && statusRow.name.length > 0
      ? statusRow.name
      : typeof statusRow.label === 'string' && statusRow.label.length > 0
        ? statusRow.label
        : inCond && typeof ct.name === 'string' && ct.name.length > 0
          ? ct.name
          : titleCase(input.statusId);

  const actorRef = { id: actor.id ?? input.actorId, name: actor.name ?? '' };

  // -- Validate value parameter against the valued flag.
  if (input.value !== null && !valued) {
    return fail(
      `Status '${input.statusId}' is a non-valued condition; passing a value is not ` +
        `supported. Non-valued statuses toggle on/off. Exhaustion is the only valued ` +
        `D&D 5e condition. Omit 'value' to apply.`,
      { reason: 'VALUE_ON_NON_VALUED_CONDITION', statusId: input.statusId, value: input.value },
    );
  }

  const findEffectId = (statusId: string): string | null => {
    const contents = actor.effects?.contents ?? [];
    const backing = contents.find((e) => toArray(e?.statuses).includes(statusId));
    return backing && typeof backing.id === 'string' ? backing.id : null;
  };

  // -- Valued path: exhaustion. Written via system.attributes.exhaustion.
  if (valued) {
    const max = levels ?? 6;
    const src = actor._source as AnyRecord | undefined;
    const srcAttrs = ((src?.system as AnyRecord | undefined)?.attributes as AnyRecord) ?? {};
    const preparedAttrs = (actor.system?.attributes as AnyRecord | undefined) ?? {};
    const rawCurrent =
      typeof srcAttrs.exhaustion === 'number'
        ? (srcAttrs.exhaustion as number)
        : typeof preparedAttrs.exhaustion === 'number'
          ? (preparedAttrs.exhaustion as number)
          : 0;
    const current = Math.max(0, rawCurrent);

    const requested = input.value ?? 1;
    const predicted = Math.min(Math.max(current, requested), max);
    const clamped = requested > max;

    if (predicted <= current) {
      return {
        ok: true,
        actor: actorRef,
        operation: 'noop',
        condition: { statusId: input.statusId, name, category, valued: true, value: current },
        reason: 'already_at_or_above_requested_value',
      };
    }

    await actor.update({ 'system.attributes.exhaustion': predicted });

    return {
      ok: true,
      actor: actorRef,
      operation: 'applied',
      condition: {
        statusId: input.statusId,
        name,
        category,
        valued: true,
        previousValue: current,
        existedBefore: current > 0,
        value: predicted,
        valueRequested: requested,
        valueApplied: predicted,
        clamped,
      },
      effectId: findEffectId(input.statusId),
    };
  }

  // -- Non-valued path: toggle the status on.
  const statusesBefore = new Set(toArray(actor.statuses));
  if (statusesBefore.has(input.statusId)) {
    return {
      ok: true,
      actor: actorRef,
      operation: 'noop',
      condition: { statusId: input.statusId, name, category, valued: false, value: null },
      reason: 'already_present',
    };
  }

  await actor.toggleStatusEffect(input.statusId, { active: true });

  const statusesAfter = toArray(actor.statuses);
  if (!statusesAfter.includes(input.statusId)) {
    return fail(
      `toggleStatusEffect('${input.statusId}') did not apply the status — it is absent ` +
        `from actor.statuses after the call.`,
      { reason: 'APPLY_FAILED', statusId: input.statusId },
    );
  }

  // Cascade: rider statuses that appeared alongside the requested one.
  const cascadeApplied = statusesAfter
    .filter((s) => s !== input.statusId && !statusesBefore.has(s))
    .sort();

  const result: Dnd5eApplyConditionApplied = {
    ok: true,
    actor: actorRef,
    operation: 'applied',
    condition: {
      statusId: input.statusId,
      name,
      category,
      valued: false,
      previousValue: null,
      existedBefore: false,
      value: null,
      valueRequested: null,
      valueApplied: null,
      clamped: false,
    },
    effectId: findEffectId(input.statusId),
  };
  if (cascadeApplied.length > 0) result.cascadeApplied = cascadeApplied;
  return result;
}
