/**
 * page.evaluate body for dnd5e_remove_condition. Removes — or, for the one
 * valued condition, decrements — a D&D 5e status on an actor. The structural
 * inverse of `dnd5e_apply_condition` and the removal counterpart in the D&D
 * 5e condition-mutation cluster, parallel to `pf2e_remove_condition`.
 *
 * Semantics (confirmed against Foundry v14.361 + dnd5e 5.3.3, modern rules,
 * by scripts/probe-dnd5e-apply-condition.mjs and verified for the removal
 * direction by scripts/probe-dnd5e-remove-condition.mjs):
 *
 *  - **Non-valued statuses (42 of 43) come off via toggleStatusEffect.**
 *    `actor.toggleStatusEffect(id, {active: false})` deletes the backing
 *    `ActiveEffect` and drops the id from `actor.statuses`. The tool checks
 *    `actor.statuses` up front and after the call rather than trusting the
 *    polymorphic return value.
 *
 *  - **Exhaustion is the only valued condition.** It is NOT removed via
 *    toggleStatusEffect (toggling the `exhaustion` status is a no-op in
 *    dnd5e). Exhaustion lives on `system.attributes.exhaustion`; the only
 *    write path is `actor.update({'system.attributes.exhaustion': N})`.
 *    Writing 0 clears the status and its "Exhaustion N" ActiveEffect; the
 *    system maintains both through data preparation.
 *
 *  - **`mode` is load-bearing only for exhaustion.** `mode: 'remove'`
 *    writes exhaustion to 0; `mode: 'decrement'` writes current - 1. For
 *    the 42 non-valued statuses both modes are identical — the status
 *    toggles off — and `mode` is accepted but inert.
 *
 *  - **Exhaustion reads use `_source`.** Within one page.evaluate call the
 *    prepared `actor.system.attributes.exhaustion` lags a write by one
 *    operation; `actor._source.system.attributes.exhaustion` is always
 *    immediately correct. The tool reads current exhaustion from `_source`.
 *
 *  - **Cascade.** Some conditions carry rider statuses (dnd5e
 *    `conditionTypes[id].riders`) — applying `unconscious` also applies
 *    `incapacitated`, and the system removes the rider when the parent
 *    comes off. The tool diffs `actor.statuses` across the awaited toggle
 *    and surfaces any ids that dropped alongside the requested one in
 *    `cascadeRemoved`.
 *
 *  - **No-op as success.** A status not present (a non-valued status absent
 *    from `actor.statuses`, or exhaustion already at 0) returns
 *    `operation: "noop"`, NOT an error. Same precedent as
 *    dnd5e_apply_condition / pf2e_remove_condition.
 *
 *  - **Actor type support.** `character`, `npc` — same set as
 *    dnd5e_apply_condition. `vehicle` / `group` / `encounter` are rejected
 *    with ACTOR_TYPE_UNSUPPORTED.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * helper and constant is defined inline.
 */
export type Dnd5eConditionCategory = 'condition' | 'pseudo-condition' | 'status';

export type Dnd5eRemoveConditionMode = 'decrement' | 'remove';

export interface Dnd5eRemoveConditionInput {
  actorId: string;
  statusId: string;
  mode: Dnd5eRemoveConditionMode;
}

export interface Dnd5eRemoveConditionRemoved {
  ok: true;
  actor: { id: string; name: string };
  operation: 'removed';
  condition: {
    statusId: string;
    name: string;
    category: Dnd5eConditionCategory;
    valued: boolean;
    previousValue: number | null;
  };
  effectId: string | null;
  cascadeRemoved?: string[];
}

export interface Dnd5eRemoveConditionDecremented {
  ok: true;
  actor: { id: string; name: string };
  operation: 'decremented';
  condition: {
    statusId: string;
    name: string;
    category: Dnd5eConditionCategory;
    valued: true;
    previousValue: number;
    value: number;
  };
  effectId: string | null;
}

export interface Dnd5eRemoveConditionNoop {
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
  reason: 'not_present';
}

export type Dnd5eRemoveConditionOk =
  | Dnd5eRemoveConditionRemoved
  | Dnd5eRemoveConditionDecremented
  | Dnd5eRemoveConditionNoop;

export interface Dnd5eRemoveConditionErr {
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
        | 'REMOVE_FAILED';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eRemoveConditionResult = Dnd5eRemoveConditionOk | Dnd5eRemoveConditionErr;

/** Actor types this tool will mutate. Mirrors dnd5e_apply_condition's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

export async function dnd5eRemoveConditionBody(
  input: Dnd5eRemoveConditionInput,
): Promise<Dnd5eRemoveConditionResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);

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
    details: Dnd5eRemoveConditionErr['error']['details'],
  ): Dnd5eRemoveConditionErr => ({
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
      `Actor type '${actorType}' is not supported by dnd5e_remove_condition. ` +
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

  const findEffectId = (statusId: string): string | null => {
    const contents = actor.effects?.contents ?? [];
    const backing = contents.find((e) => toArray(e?.statuses).includes(statusId));
    return backing && typeof backing.id === 'string' ? backing.id : null;
  };

  // -- Valued path: exhaustion. Decremented / removed via the attribute.
  if (valued) {
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

    if (current <= 0) {
      return {
        ok: true,
        actor: actorRef,
        operation: 'noop',
        condition: { statusId: input.statusId, name, category, valued: true, value: 0 },
        reason: 'not_present',
      };
    }

    const effectId = findEffectId(input.statusId);
    const predicted = input.mode === 'remove' ? 0 : current - 1;
    await actor.update({ 'system.attributes.exhaustion': predicted });

    if (predicted <= 0) {
      return {
        ok: true,
        actor: actorRef,
        operation: 'removed',
        condition: {
          statusId: input.statusId,
          name,
          category,
          valued: true,
          previousValue: current,
        },
        effectId,
      };
    }

    return {
      ok: true,
      actor: actorRef,
      operation: 'decremented',
      condition: {
        statusId: input.statusId,
        name,
        category,
        valued: true,
        previousValue: current,
        value: predicted,
      },
      effectId,
    };
  }

  // -- Non-valued path: toggle the status off. `mode` is inert here.
  const statusesBefore = new Set(toArray(actor.statuses));
  if (!statusesBefore.has(input.statusId)) {
    return {
      ok: true,
      actor: actorRef,
      operation: 'noop',
      condition: { statusId: input.statusId, name, category, valued: false, value: null },
      reason: 'not_present',
    };
  }

  const effectId = findEffectId(input.statusId);
  await actor.toggleStatusEffect(input.statusId, { active: false });

  const statusesAfter = new Set(toArray(actor.statuses));
  if (statusesAfter.has(input.statusId)) {
    return fail(
      `toggleStatusEffect('${input.statusId}') did not remove the status — it is still ` +
        `present in actor.statuses after the call.`,
      { reason: 'REMOVE_FAILED', statusId: input.statusId },
    );
  }

  // Cascade: rider statuses the system dropped alongside the requested one.
  const cascadeRemoved = Array.from(statusesBefore)
    .filter((s) => s !== input.statusId && !statusesAfter.has(s))
    .sort();

  const result: Dnd5eRemoveConditionRemoved = {
    ok: true,
    actor: actorRef,
    operation: 'removed',
    condition: {
      statusId: input.statusId,
      name,
      category,
      valued: false,
      previousValue: null,
    },
    effectId,
  };
  if (cascadeRemoved.length > 0) result.cascadeRemoved = cascadeRemoved;
  return result;
}
