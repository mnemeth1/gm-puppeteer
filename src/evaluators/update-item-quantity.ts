/**
 * page.evaluate body for update_item_quantity. Sets the absolute
 * `system.quantity` on a physical inventory item embedded on an actor.
 * The set-operation sibling of `add_item_to_actor` (merge-add) and
 * `remove_item_from_actor` (decrement).
 *
 * Behavior nuances confirmed by scripts/probe-update-item-quantity.mjs
 * and scripts/probe-update-item-quantity-phase1.mjs against Foundry
 * v14.361 + PF2e 8.1.2:
 *  - `updateEmbeddedDocuments("Item", [{_id, "system.quantity": N}])`
 *    accepts any non-negative integer; tested up to 999. Setting the
 *    quantity to its current value is a no-op at the document layer —
 *    the update call returns an empty array, does NOT throw, and no
 *    document update event fires. The tool surfaces this via
 *    `qtyBefore === qtyAfter` in the response; no separate `noop` flag
 *    is needed because the caller already has the data to detect it.
 *  - `actor.inventory.coins` is a computed aggregator over treasure
 *    items. Setting a treasure stack's quantity via the generic
 *    `updateEmbeddedDocuments` path flows through to the coin total
 *    automatically (verified Probe B: setting Copper Pieces qty 9 → 42
 *    updates `actor.inventory.coins.cp` to 42). The tool intentionally
 *    does NOT use PF2e's dedicated `actor.inventory.removeCoins` /
 *    `addCoins` paths — treasure behaves uniformly with other physical
 *    items.
 *  - Setting `system.quantity` to a float (e.g. 1.5) is silently
 *    truncated to int by Foundry's schema. Setting to a numeric string
 *    (e.g. "5") is silently coerced to int. The zod input layer rejects
 *    both before the eval, so the user-facing surface never sees these
 *    coercions — they are recorded here as context only. The evaluator
 *    body re-validates `Number.isInteger` defensively in case a future
 *    direct caller bypasses zod.
 *  - Setting `system.quantity` to a negative integer is silently clamped
 *    to 0 by Foundry's schema (carried over from remove_item_from_actor
 *    Probe F). The zod layer rejects negative input with `.min(1)`, and
 *    `quantity: 0` is rejected with a dedicated `QUANTITY_ZERO` reason
 *    code that points the caller at `remove_item_from_actor`.
 *  - Setting `system.quantity` on a non-physical type (feat, action,
 *    spell, etc.) is silently dropped by Foundry's schema — the field
 *    is not stored on the document. The tool's `UPDATE_ON_NON_PHYSICAL`
 *    rejection is the user-facing safety net; without it the call would
 *    appear to succeed while accomplishing nothing.
 *
 * No cascade or ejection logic applies here — `updateEmbeddedDocuments`
 * does not trigger document deletes, so neither GrantItem cascade-deletes
 * nor container-ejection apply to a quantity change. This is a meaningful
 * simplification over `remove_item_from_actor`.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface UpdateItemQuantityInput {
  actorId: string;
  itemId: string;
  quantity: number;
}

export interface UpdateItemQuantityItem {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export interface UpdateItemQuantityOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'updated';
  item: UpdateItemQuantityItem;
}

export interface UpdateItemQuantityErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateItemQuantityResult = UpdateItemQuantityOk | UpdateItemQuantityErr;

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

export async function updateItemQuantityBody(
  input: UpdateItemQuantityInput,
): Promise<UpdateItemQuantityResult> {
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

  const fail = (message: string, details: Record<string, unknown>): UpdateItemQuantityErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // Same canonical-name helper as remove_item_from_actor. Surfacing the
  // identified name keeps logs/audit clear ("you updated a Longsword
  // stack") even when the item displays an unidentified alias.
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
    return fail(`No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`, {
      actorId: input.actorId,
      itemId: input.itemId,
      reason: 'ITEM_NOT_FOUND_ON_ACTOR',
    });
  }

  const targetType: string = typeof target.type === 'string' ? target.type : '';
  if (!PHYSICAL_ITEM_TYPES.has(targetType)) {
    return fail(
      `update_item_quantity requires a physical item type; this item is '${targetType}'. ` +
        `Non-physical items (feats, actions, spells, ancestries, etc.) do not have a ` +
        `\`system.quantity\` field — Foundry silently drops the update. Physical types: ` +
        `weapon, armor, shield, consumable, equipment, backpack, treasure, ammo.`,
      {
        itemId: input.itemId,
        type: targetType,
        reason: 'UPDATE_ON_NON_PHYSICAL',
      },
    );
  }

  // -- Validate quantity defensively. zod's .min(1) and .int() catch
  // these at the MCP boundary, but the evaluator re-validates so a
  // future direct caller doesn't get silent Foundry coercion (1.5 → 1,
  // "5" → 5, -3 → 0).
  if (input.quantity === 0) {
    return fail(
      `Setting quantity to 0 is not supported by update_item_quantity. Use ` +
        `remove_item_from_actor with mode: "delete" to remove the item, or ` +
        `mode: "decrement" with quantity equal to current to clamp it.`,
      {
        quantity: input.quantity,
        reason: 'QUANTITY_ZERO',
      },
    );
  }
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    !Number.isFinite(input.quantity)
  ) {
    return fail(`quantity must be an integer ≥ 1, got: ${String(input.quantity)}`, {
      quantity: input.quantity,
      reason: 'INVALID_QUANTITY',
    });
  }

  // -- Read current quantity for the response.
  const qtyBefore =
    typeof target.system?.quantity === 'number' && Number.isFinite(target.system.quantity)
      ? (target.system.quantity as number)
      : 1;

  // -- Apply. Foundry no-ops cleanly when the new value equals the
  // current value (verified Phase 1 A4): updateEmbeddedDocuments returns
  // an empty array, no throw. The caller infers no-op from
  // qtyBefore === qtyAfter.
  await actor.updateEmbeddedDocuments('Item', [
    { _id: target.id, 'system.quantity': input.quantity },
  ]);

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'updated',
    item: {
      id: target.id,
      name: identifiedName(target),
      type: targetType,
      qtyBefore,
      qtyAfter: input.quantity,
    },
  };
}
