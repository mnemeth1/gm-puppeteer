/**
 * page.evaluate body for `dnd5e_update_item_quantity`. Sets the absolute
 * `system.quantity` on a physical inventory item embedded on a D&D 5e actor.
 * The set-operation sibling of `dnd5e_add_item_to_actor` (merge-add) and
 * `dnd5e_remove_item_from_actor` (decrement / delete). D&D 5e sibling of
 * `pf2e_update_item_quantity`.
 *
 * Behaviour nuances confirmed by a live probe against Foundry v14.361 +
 * dnd5e 5.3.3 (`scripts/probe-dnd5e-update-item-quantity.mjs`):
 *  - `updateEmbeddedDocuments("Item", [{_id, "system.quantity": N}])`
 *    accepts any non-negative integer. Setting the quantity to its current
 *    value is a clean no-op at the document layer — the call returns an
 *    empty array, does NOT throw, and no update event fires. Surfaced via
 *    `qtyBefore === qtyAfter`; no separate `noop` flag.
 *  - 5e does not auto-delete a qty-0 item, and a negative quantity is
 *    silently clamped to 0 by the schema. The zod layer rejects `< 1`, and
 *    `quantity: 0` is rejected here with a dedicated `QUANTITY_ZERO` reason
 *    pointing the caller at `dnd5e_remove_item_from_actor`.
 *  - Setting `system.quantity` on a non-physical type (feat, spell, class,
 *    etc.) is silently dropped — the field is not on those schemas. The
 *    `UPDATE_ON_NON_PHYSICAL` rejection is the user-facing safety net.
 *
 * No cascade or container-ejection logic applies — `updateEmbeddedDocuments`
 * triggers no document deletes, so a quantity change cannot orphan a
 * container's contents the way `dnd5e_remove_item_from_actor` can.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime — every
 * helper is defined inline. Only erased-at-runtime type declarations and the
 * tool-layer-only exported consts live at module scope.
 */
export interface Dnd5eUpdateItemQuantityInput {
  actorId: string;
  itemId: string;
  quantity: number;
}

export interface Dnd5eUpdateItemQuantityItem {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export interface Dnd5eUpdateItemQuantityOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'updated';
  item: Dnd5eUpdateItemQuantityItem;
}

export interface Dnd5eUpdateItemQuantityErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'ITEM_NOT_FOUND_ON_ACTOR'
        | 'UPDATE_ON_NON_PHYSICAL'
        | 'QUANTITY_ZERO'
        | 'INVALID_QUANTITY';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eUpdateItemQuantityResult =
  | Dnd5eUpdateItemQuantityOk
  | Dnd5eUpdateItemQuantityErr;

/** Actor types this tool will mutate. Mirrors the dnd5e tool family. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

/** D&D 5e physical-inventory item types this tool will set `quantity` on.
 * Exported for the tool layer to reuse in user-facing error messages. */
export const PHYSICAL_ITEM_TYPES = [
  'weapon',
  'equipment',
  'consumable',
  'tool',
  'loot',
  'container',
] as const;

export async function dnd5eUpdateItemQuantityBody(
  input: Dnd5eUpdateItemQuantityInput,
): Promise<Dnd5eUpdateItemQuantityResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);
  const PHYSICAL = new Set(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container']);

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
    details: Dnd5eUpdateItemQuantityErr['error']['details'],
  ): Dnd5eUpdateItemQuantityErr => ({
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
      `Actor type '${actorType}' is not supported by dnd5e_update_item_quantity. ` +
        `Supported types: character, npc.`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', actorId: input.actorId, type: actorType },
    );
  }

  // -- Resolve target item on actor.
  const target = actor.items?.get?.(input.itemId);
  if (!target || !target.id) {
    return fail(
      `No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`,
      { reason: 'ITEM_NOT_FOUND_ON_ACTOR', actorId: input.actorId, itemId: input.itemId },
    );
  }

  const targetType: string = typeof target.type === 'string' ? target.type : '';
  if (!PHYSICAL.has(targetType)) {
    return fail(
      `dnd5e_update_item_quantity requires a physical item type; this item is '${targetType}'. ` +
        `Non-physical items (feats, spells, classes, backgrounds, races, etc.) do not have a ` +
        `\`system.quantity\` field — Foundry silently drops the update. Physical types: ` +
        `weapon, equipment, consumable, tool, loot, container.`,
      { reason: 'UPDATE_ON_NON_PHYSICAL', itemId: input.itemId, type: targetType },
    );
  }

  // -- Validate quantity defensively. zod's .int().min(1) catches these at
  // the MCP boundary; the evaluator re-validates so a future direct caller
  // doesn't get silent Foundry coercion (1.5 → 1, -3 → 0).
  if (input.quantity === 0) {
    return fail(
      `Setting quantity to 0 is not supported by dnd5e_update_item_quantity. Use ` +
        `dnd5e_remove_item_from_actor with mode: "delete" to remove the item, or ` +
        `mode: "decrement" with quantity equal to current to clamp it.`,
      { reason: 'QUANTITY_ZERO', quantity: input.quantity },
    );
  }
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    !Number.isFinite(input.quantity)
  ) {
    return fail(`quantity must be an integer ≥ 1, got: ${String(input.quantity)}`, {
      reason: 'INVALID_QUANTITY',
      quantity: input.quantity,
    });
  }

  // -- Read current quantity for the response.
  const qtyRaw = target.system?.quantity;
  const qtyBefore =
    typeof qtyRaw === 'number' && Number.isFinite(qtyRaw) ? qtyRaw : 1;

  // -- Apply. Foundry no-ops cleanly when the new value equals the current
  // value: updateEmbeddedDocuments returns an empty array, no throw. The
  // caller infers no-op from qtyBefore === qtyAfter.
  await actor.updateEmbeddedDocuments('Item', [
    { _id: target.id, 'system.quantity': input.quantity },
  ]);

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'updated',
    item: {
      id: target.id,
      name: typeof target.name === 'string' ? target.name : '',
      type: targetType,
      qtyBefore,
      qtyAfter: input.quantity,
    },
  };
}
