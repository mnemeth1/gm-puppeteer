/**
 * page.evaluate body for `dnd5e_update_item_uses`. Sets the remaining
 * charge count on a uses-tracking item embedded on a D&D 5e actor. D&D 5e
 * sibling of `pf2e_update_item_uses`; companion to `dnd5e_update_item_quantity`.
 *
 * **The 5e uses model is NOT the PF2e one** — confirmed by a live probe
 * against Foundry v14.361 + dnd5e 5.3.3
 * (`scripts/probe-dnd5e-update-item-uses.mjs`):
 *
 *  - **`system.uses.value` is DERIVED, not stored.** The dnd5e `uses`
 *    schema stores `{spent, max, recovery, autoDestroy}` only — `value` is
 *    a computed getter equal to `max − spent`. The PF2e sibling writes
 *    `uses.value` directly; that path does not exist here. This tool
 *    writes the stored field, **`system.uses.spent`**, and lets the system
 *    recompute `value`.
 *  - **`uses.max` is a stored formula string** (`"3"`, `"1"`,
 *    `"max(1, @abilities.cha.mod)"`) that the system resolves to a number
 *    on the prepared document. This tool reads the *resolved* live
 *    `system.uses.max` (a number) and never touches the stored formula.
 *  - **`uses` is cross-cutting in 5e** — not just physical items. Feats
 *    (Bardic Inspiration, Misty Step) and spells (Shield with limited
 *    castings) carry `system.uses` too. Unlike the PF2e sibling (which
 *    restricts to physical types because PF2e non-physical items have no
 *    uses field), this tool gates on "has a `uses` tracker" — `uses.max`
 *    resolving to a number > 0 — regardless of item type.
 *  - **No over-charge.** Caller passes the desired *remaining* count
 *    (`value`); the tool computes `spent = max − value`. 5e cannot exceed
 *    `max` — a `value > max` would imply negative `spent` (Foundry clamps
 *    that to 0). Rather than silently clamp, this tool rejects
 *    `value > max` with `REMAINING_EXCEEDS_MAX`.
 *  - **`value: 0` is a legitimate depleted-but-present state.** Writing
 *    `spent = max` does NOT trigger `autoDestroy` — that pipeline fires
 *    only inside the 5e use/activity flow. Use `dnd5e_remove_item_from_actor`
 *    to also delete the item.
 *  - Setting `spent` to its current resolved value is a clean no-op at the
 *    document layer (empty array return, no throw). Surfaced via
 *    `remainingBefore === remainingAfter`; no separate `noop` flag.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * helper is defined inline. Only erased-at-runtime type declarations and the
 * tool-layer-only exported const live at module scope.
 */
export interface Dnd5eUpdateItemUsesInput {
  actorId: string;
  itemId: string;
  /** Desired remaining charge count. The tool computes `spent = max − value`. */
  value: number;
}

export interface Dnd5eUpdateItemUsesItem {
  id: string;
  name: string;
  type: string;
  /** Remaining charges (`max − spent`) before the write. */
  remainingBefore: number;
  /** Remaining charges after the write — equal to the requested `value`. */
  remainingAfter: number;
  /** Resolved `system.uses.max` snapshot; not modified by this tool. */
  max: number;
  /** Stored `system.uses.spent` before the write. */
  spentBefore: number;
  /** Stored `system.uses.spent` after the write (`max − value`). */
  spentAfter: number;
}

export interface Dnd5eUpdateItemUsesOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'updated';
  item: Dnd5eUpdateItemUsesItem;
}

export interface Dnd5eUpdateItemUsesErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'ITEM_NOT_FOUND_ON_ACTOR'
        | 'ITEM_HAS_NO_USES_TRACKER'
        | 'REMAINING_EXCEEDS_MAX'
        | 'INVALID_VALUE';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eUpdateItemUsesResult = Dnd5eUpdateItemUsesOk | Dnd5eUpdateItemUsesErr;

/** Actor types this tool will mutate. Mirrors the dnd5e tool family. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

export async function dnd5eUpdateItemUsesBody(
  input: Dnd5eUpdateItemUsesInput,
): Promise<Dnd5eUpdateItemUsesResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    items?: {
      get?(id: string): ItemDocLike | undefined;
    };
    updateEmbeddedDocuments(
      name: 'Item',
      data: Array<AnyRecord & { _id: string }>,
    ): Promise<ItemDocLike[]>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
  }

  const fail = (
    message: string,
    details: Dnd5eUpdateItemUsesErr['error']['details'],
  ): Dnd5eUpdateItemUsesErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // -- Resolve actor.
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
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
      `Actor type '${actorType}' is not supported by dnd5e_update_item_uses. ` +
        `Supported types: character, npc.`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', actorId: input.actorId, type: actorType },
    );
  }

  // -- Resolve target item on actor.
  const target = actor.items?.get?.(input.itemId);
  if (!target || !target.id) {
    return fail(`No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`, {
      reason: 'ITEM_NOT_FOUND_ON_ACTOR',
      actorId: input.actorId,
      itemId: input.itemId,
    });
  }

  const targetType: string = typeof target.type === 'string' ? target.type : '';
  const targetName: string = typeof target.name === 'string' ? target.name : '';

  // -- Uses-tracker gate. Read the RESOLVED live `system.uses` — `uses.max`
  // is stored as a formula string but the prepared document carries the
  // resolved number. A finite `max > 0` is the definition of "has a real
  // charge pool"; without it there is nothing to set.
  const sys = (target.system as AnyRecord | undefined) ?? {};
  const uses = sys.uses as AnyRecord | undefined;
  const maxRaw = uses?.max;
  if (!uses || typeof maxRaw !== 'number' || !Number.isFinite(maxRaw) || maxRaw <= 0) {
    return fail(
      `Item '${targetName}' (type=${targetType}) has no \`system.uses\` charge pool — ` +
        `\`uses.max\` does not resolve to a positive number, so there are no charges to set. ` +
        `Items with a uses tracker are typically wands, staves, charged magic items, and ` +
        `feats/spells with limited activations (e.g. Bardic Inspiration). Use ` +
        `dnd5e_get_item_details to inspect the item's \`uses\` block before retrying.`,
      { reason: 'ITEM_HAS_NO_USES_TRACKER', itemId: input.itemId, type: targetType },
    );
  }
  const max = maxRaw;

  // -- Validate value defensively. zod's .int().min(0) catches fractional
  // and negative input at the MCP edge; the evaluator re-validates so a
  // future direct caller doesn't get silent Foundry coercion. 0 is allowed
  // (depleted-but-present).
  if (
    typeof input.value !== 'number' ||
    !Number.isInteger(input.value) ||
    input.value < 0 ||
    !Number.isFinite(input.value)
  ) {
    return fail(`value must be a non-negative integer, got: ${String(input.value)}`, {
      reason: 'INVALID_VALUE',
      value: input.value,
    });
  }

  // -- 5e cannot over-charge: remaining > max would imply negative spent.
  if (input.value > max) {
    return fail(
      `Requested remaining charges (${input.value}) exceeds this item's maximum (${max}). ` +
        `D&D 5e items cannot hold more charges than \`uses.max\`. Set value ≤ ${max}.`,
      { reason: 'REMAINING_EXCEEDS_MAX', value: input.value, max },
    );
  }

  // -- Read current uses for the response.
  const spentRaw = uses.spent;
  const spentBefore =
    typeof spentRaw === 'number' && Number.isFinite(spentRaw) ? (spentRaw as number) : 0;
  const valueRaw = uses.value;
  const remainingBefore =
    typeof valueRaw === 'number' && Number.isFinite(valueRaw)
      ? (valueRaw as number)
      : max - spentBefore;

  // -- Translate desired remaining → stored `spent`, then apply. The
  // derived `system.uses.value` recomputes to `max − spent` on data prep.
  // Foundry no-ops cleanly when `spent` is unchanged (empty array return,
  // no throw); the caller infers no-op from remainingBefore === remainingAfter.
  const spentAfter = max - input.value;
  await actor.updateEmbeddedDocuments('Item', [
    { _id: target.id, 'system.uses.spent': spentAfter },
  ]);

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'updated',
    item: {
      id: target.id,
      name: targetName,
      type: targetType,
      remainingBefore,
      remainingAfter: input.value,
      max,
      spentBefore,
      spentAfter,
    },
  };
}
