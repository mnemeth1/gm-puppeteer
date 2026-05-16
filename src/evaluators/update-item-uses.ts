/**
 * page.evaluate body for update_item_uses. Sets the absolute
 * `system.uses.value` on a charges-tracking physical item embedded on
 * an actor. Sibling to `use_item` (decrement-with-side-effects) and
 * `update_item_quantity` (sets `system.quantity`).
 *
 * Behavior nuances confirmed against Foundry v14.361 + PF2e 8.1.2:
 *  - `updateEmbeddedDocuments("Item", [{_id, "system.uses.value": N}])`
 *    accepts any non-negative integer. Setting a value that equals the
 *    current value is a clean no-op at the document layer (empty array
 *    return, no event). Surfaced via `usesBefore === usesAfter`; no
 *    separate `noop` flag.
 *  - There is NO upper bound on `uses.value` at Foundry's schema layer.
 *    Setting `value > uses.max` is accepted as-is. The tool does NOT
 *    clamp — values above max are conceivable for "over-charge"
 *    scenarios, and the response carries `usesMax` so callers can
 *    detect over-set without a follow-up read.
 *  - `value === 0` is a legitimate "depleted" state. Direct field
 *    write does NOT trigger `autoDestroy` — that pipeline only fires
 *    inside `ConsumablePF2e.consume()`. Use `remove_item_from_actor`
 *    if the item should also be deleted.
 *  - For potion-like items (`uses.max === 1`), the live counter that
 *    `use_item` decrements is `system.quantity`, not `system.uses.value`.
 *    This tool writes `uses.value` faithfully regardless; semantic
 *    interpretation is the caller's. The tool description steers
 *    callers toward `update_item_quantity` for those items.
 *  - Setting `system.uses.value` on an item without a `system.uses`
 *    field (e.g. a longsword) is silently dropped by Foundry — the
 *    schema does not store it. The tool's `ITEM_HAS_NO_USES_FIELD`
 *    rejection is the user-facing safety net.
 *  - `system.frequency` (per-day activations on feats and abilities)
 *    is a different field on a different document type. This tool
 *    does NOT touch it; non-physical items are rejected via
 *    `UPDATE_ON_NON_PHYSICAL` before the uses presence gate runs.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface UpdateItemUsesInput {
  actorId: string;
  itemId: string;
  value: number;
}

export interface UpdateItemUsesItem {
  id: string;
  name: string;
  type: string;
  usesBefore: number;
  usesAfter: number;
  /** Snapshot of `system.uses.max` taken before the write; not modified
   * by this tool. Foundry does not enforce `value <= max`, so callers
   * that want over-set detection compare `usesAfter` to `usesMax`. */
  usesMax: number;
}

export interface UpdateItemUsesOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'updated';
  item: UpdateItemUsesItem;
}

export interface UpdateItemUsesErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateItemUsesResult = UpdateItemUsesOk | UpdateItemUsesErr;

/** Physical inventory item types this tool will set. Exported for the
 * tool layer to reuse in user-facing error messages. */
export const PHYSICAL_INVENTORY_TYPES = [
  'weapon',
  'armor',
  'shield',
  'consumable',
  'equipment',
  'backpack',
  'treasure',
  'ammo',
] as const;

export async function updateItemUsesBody(
  input: UpdateItemUsesInput,
): Promise<UpdateItemUsesResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const PHYSICAL_ITEM_TYPES = new Set([
    'weapon',
    'armor',
    'shield',
    'consumable',
    'equipment',
    'backpack',
    'treasure',
    'ammo',
  ]);

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
    details: Record<string, unknown>,
  ): UpdateItemUsesErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // Same canonical-name helper as update_item_quantity. Surfacing the
  // identified name keeps logs/audit clear even when the item displays
  // an unidentified alias.
  const identifiedName = (item: ItemDocLike): string => {
    const sys = (item.system as AnyRecord | undefined) ?? {};
    const ident = sys.identification as AnyRecord | undefined;
    if (ident && ident.status === 'unidentified') {
      const inner = ident.identified as AnyRecord | undefined;
      const canonical = inner?.name;
      if (typeof canonical === 'string' && canonical.length > 0) return canonical;
    }
    return typeof item.name === 'string' ? item.name : '';
  };

  // -- Resolve actor.
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, {
      actorId: input.actorId,
      reason: 'ACTOR_NOT_FOUND',
    });
  }

  // -- Resolve target item on actor.
  const target = actor.items?.get?.(input.itemId);
  if (!target || !target.id) {
    return fail(
      `No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`,
      {
        actorId: input.actorId,
        itemId: input.itemId,
        reason: 'ITEM_NOT_FOUND_ON_ACTOR',
      },
    );
  }

  const targetType: string = typeof target.type === 'string' ? target.type : '';
  if (!PHYSICAL_ITEM_TYPES.has(targetType)) {
    return fail(
      `update_item_uses requires a physical item type; this item is '${targetType}'. ` +
        `Non-physical items (feats, actions, spells, ancestries, etc.) do not have a ` +
        `\`system.uses\` field — Foundry silently drops the update. Physical types: ` +
        `weapon, armor, shield, consumable, equipment, backpack, treasure, ammo. ` +
        `For per-day activations on feats use \`system.frequency\`, which this tool ` +
        `does not touch.`,
      {
        itemId: input.itemId,
        type: targetType,
        reason: 'UPDATE_ON_NON_PHYSICAL',
      },
    );
  }

  // -- Presence gate: item must have a `system.uses` tracker. Without
  // `uses.max` as a finite number we can't echo the snapshot field, so
  // bare `{uses: {}}` does not count as a valid charges item.
  const sys = (target.system as AnyRecord | undefined) ?? {};
  const uses = sys.uses as AnyRecord | undefined;
  const usesMaxRaw = uses?.max;
  if (
    !uses ||
    typeof usesMaxRaw !== 'number' ||
    !Number.isFinite(usesMaxRaw)
  ) {
    return fail(
      `Item '${identifiedName(target)}' (type=${targetType}) has no \`system.uses\` ` +
        `tracker — there is no charges field to set. Items with \`system.uses\` are ` +
        `typically wands, scrolls, talismans, batons, and equipment with limited ` +
        `activations. Use get_item_details to inspect the item's tracker before retrying.`,
      {
        itemId: input.itemId,
        type: targetType,
        reason: 'ITEM_HAS_NO_USES_FIELD',
      },
    );
  }

  // -- Validate value defensively. zod's .int().min(0) catches these at
  // the MCP boundary, but the evaluator re-validates so a future direct
  // caller doesn't get silent Foundry coercion (1.5 → 1, "5" → 5).
  // Lower bound is 0 (depleted is legitimate) — divergence from
  // update_item_quantity, which rejects 0.
  if (
    typeof input.value !== 'number' ||
    !Number.isInteger(input.value) ||
    input.value < 0 ||
    !Number.isFinite(input.value)
  ) {
    return fail(`value must be a non-negative integer, got: ${String(input.value)}`, {
      value: input.value,
      reason: 'INVALID_VALUE',
    });
  }

  // -- Read current uses for the response.
  const usesValueRaw = uses.value;
  const usesBefore =
    typeof usesValueRaw === 'number' && Number.isFinite(usesValueRaw)
      ? (usesValueRaw as number)
      : 0;
  const usesMax = usesMaxRaw;

  // -- Apply. Foundry no-ops cleanly when the new value equals the
  // current value: updateEmbeddedDocuments returns an empty array, no
  // throw. Caller infers no-op from usesBefore === usesAfter.
  await actor.updateEmbeddedDocuments('Item', [
    { _id: target.id, 'system.uses.value': input.value },
  ]);

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'updated',
    item: {
      id: target.id,
      name: identifiedName(target),
      type: targetType,
      usesBefore,
      usesAfter: input.value,
      usesMax,
    },
  };
}
