/**
 * page.evaluate body for pf2e_remove_item_from_actor. Removes an embedded item
 * from an actor's inventory or decrements its quantity. Two modes:
 *
 *  - `delete`   — remove the item entry entirely.
 *  - `decrement` — reduce a physical item's `system.quantity` by N. When
 *    the resulting quantity is 0 and `deleteIfZero` is true (default),
 *    the item is deleted; otherwise the entry persists at qty 0.
 *
 * Behavior nuances confirmed by scripts/probe-remove-item-from-actor.mjs
 * against Foundry v14.361 + PF2e 8.1.2:
 *  - Deleting a container (`type: "backpack"`) does NOT destroy its
 *    contents. PF2e's `ContainerPF2e._preDelete` forwards to the system
 *    data model, which **ejects** the contained items to the actor's
 *    top-level inventory by clearing their `system.containerId` to
 *    `null`. The tool collects the would-be-ejected items BEFORE the
 *    delete and surfaces them as `ejectedToTopLevel` in the response, so
 *    callers know which items got promoted. This matches what the PF2e
 *    UI's trash-icon click does — no semantic divergence between the
 *    tool and the UI.
 *  - Items with `flags.pf2e.grantedBy.id === <target>` are reported as
 *    `cascadeDeleted` (with `reason: "grantedBy"`) and the tool
 *    GUARANTEES they are gone post-call. PF2e's cascade-delete is
 *    driven by the parent's `system.rules` carrying a matching
 *    GrantItem entry — NOT by the child's `grantedBy` flag alone — so
 *    a child whose parent has no such rule (e.g., a flag attached by
 *    hand, or by a third-party module that doesn't mirror the rule)
 *    would persist after PF2e's delete hook. To keep the response
 *    truthful, the tool deletes the target first, then explicitly
 *    deletes any cascade-tagged child that PF2e didn't auto-remove.
 *    An item that matches both criteria (grant child contained inside
 *    the target container) is reported under `cascadeDeleted`, not
 *    `ejectedToTopLevel`, because the cascade-tag wins.
 *  - Setting `system.quantity` to 0 via `updateEmbeddedDocuments`
 *    persists at the document layer — Foundry does NOT auto-delete
 *    qty-0 items. PF2e's `ConsumablePF2e.consume()` explicitly calls
 *    `this.delete()` when `autoDestroy && uses.value <= thisMany`, which
 *    is the source of the "use the last potion makes it disappear"
 *    behavior. Our `deleteIfZero: true` default mirrors that
 *    consume-path semantics so callers get the expected outcome.
 *  - Setting `system.quantity` to a negative number via
 *    `updateEmbeddedDocuments` is silently clamped to 0 by Foundry's
 *    schema, not rejected. Setting a float (1.5) is truncated to int.
 *    Our zod input layer rejects both before the eval, so these
 *    behaviors are recorded as context only.
 *  - Setting `system.quantity` on a non-physical item type (feat,
 *    action, etc.) is silently dropped by Foundry's schema — the field
 *    is not stored on the document. The tool's input-layer rejection of
 *    decrement on non-physical types is the user-facing safety net, not
 *    something Foundry will catch for us at storage time.
 *  - PF2e exposes `actor.inventory.removeCoins({pp, gp, sp, cp})` as a
 *    dedicated currency-adjustment path. The tool intentionally does
 *    NOT use it — treasure items are decremented via the generic
 *    `updateEmbeddedDocuments` path so the behavior is uniform across
 *    item types. `actor.inventory.coins` is a computed aggregator, so a
 *    decrement on a treasure stack flows through to the coin total
 *    automatically.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface Pf2eRemoveItemFromActorInput {
  actorId: string;
  itemId: string;
  mode: 'delete' | 'decrement';
  /** Ignored when mode='delete'. */
  quantity: number;
  /** Ignored when mode='delete'. */
  deleteIfZero: boolean;
}

export interface RemoveDeletedItem {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
  /** `system.quantity` at the moment of delete. `null` for non-physical types. */
  qtyAtDelete: number | null;
}

export interface RemoveDecrementedToDeletedItem {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
  /** Quantity before this call; for the qty-collapsed-to-zero path. */
  qtyBefore: number;
}

export interface RemoveEjectedEntry {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
}

export interface RemoveCascadeDeletedEntry {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
  reason: 'grantedBy';
}

export interface RemoveDecrementedItem {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export type Pf2eRemoveItemFromActorOk =
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'deleted';
      deletedItem: RemoveDeletedItem;
      ejectedToTopLevel: RemoveEjectedEntry[];
      cascadeDeleted: RemoveCascadeDeletedEntry[];
    }
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'decremented';
      item: RemoveDecrementedItem;
    }
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'decrementedAndDeleted';
      deletedItem: RemoveDecrementedToDeletedItem;
      ejectedToTopLevel: RemoveEjectedEntry[];
      cascadeDeleted: RemoveCascadeDeletedEntry[];
    };

export interface Pf2eRemoveItemFromActorErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Pf2eRemoveItemFromActorResult = Pf2eRemoveItemFromActorOk | Pf2eRemoveItemFromActorErr;

/** Physical inventory item types this tool supports for `decrement` mode.
 * Mirrors `pf2e_add_item_to_actor`'s set. Exported for the tool layer to reuse
 * in user-facing error messages. */
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

export async function pf2eRemoveItemFromActorBody(
  input: Pf2eRemoveItemFromActorInput,
): Promise<Pf2eRemoveItemFromActorResult> {
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
  const PHYSICAL_TYPES_LIST =
    'weapon, armor, shield, consumable, equipment, backpack, treasure, ammo';

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface ItemDocLike {
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    documentName?: string;
    system?: AnyRecord;
    flags?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    items?: {
      contents?: ItemDocLike[];
      get?(id: string): ItemDocLike | undefined;
    };
    deleteEmbeddedDocuments(name: 'Item', ids: string[]): Promise<ItemDocLike[]>;
    updateEmbeddedDocuments(
      name: 'Item',
      data: Array<AnyRecord & { _id: string }>,
    ): Promise<ItemDocLike[]>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
  }

  const fail = (message: string, details: Record<string, unknown>): Pf2eRemoveItemFromActorErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // -- Helper: choose the identified (canonical) name regardless of an
  // item's current identification status. For unidentified items, this is
  // `system.identification.identified.name`; for everything else, fall back
  // to `item.name`. Surfacing the canonical name keeps logs/audit clear
  // ("you deleted a Longsword") even when the item displays an unidentified
  // alias ("Unusual Longsword") in the UI.
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

  const sourceUuidOf = (item: ItemDocLike): string | null => {
    const raw = item._stats?.compendiumSource;
    return typeof raw === 'string' ? raw : null;
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
  const isPhysical = PHYSICAL_ITEM_TYPES.has(targetType);

  // -- Decrement-mode-specific validation.
  if (input.mode === 'decrement') {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      return fail(`quantity must be an integer ≥ 1, got: ${String(input.quantity)}`, {
        quantity: input.quantity,
        reason: 'INVALID_QUANTITY',
      });
    }
    if (!isPhysical) {
      return fail(
        `decrement mode requires a physical item type; this item is '${targetType}'. Use mode 'delete' to remove it. Physical types: ${PHYSICAL_TYPES_LIST}.`,
        {
          itemId: input.itemId,
          type: targetType,
          reason: 'DECREMENT_ON_NON_PHYSICAL',
        },
      );
    }
  }

  // -- Helper: scan for the side-effect previews. Run BEFORE any delete so
  // we can name the children that are about to vanish or get promoted.
  // Returns disjoint sets — an item that matches both criteria (grant
  // child located inside the container) goes under cascadeDeleted only
  // because PF2e's grant-cascade deletes it rather than ejecting it.
  const collectPreviews = (
    targetId: string,
  ): {
    cascadeDeleted: RemoveCascadeDeletedEntry[];
    ejectedToTopLevel: RemoveEjectedEntry[];
  } => {
    const cascadeDeleted: RemoveCascadeDeletedEntry[] = [];
    const ejectedToTopLevel: RemoveEjectedEntry[] = [];
    const cascadeIds = new Set<string>();

    // Pass 1: cascade (grantedBy) children.
    for (const item of actor.items?.contents ?? []) {
      if (!item || !item.id || item.id === targetId) continue;
      const flagsObj = (item.flags as AnyRecord | undefined) ?? {};
      const pf2eFlags = (flagsObj.pf2e as AnyRecord | undefined) ?? {};
      const grantedByRaw = pf2eFlags.grantedBy;
      if (!grantedByRaw || typeof grantedByRaw !== 'object') continue;
      const grantedById = (grantedByRaw as AnyRecord).id;
      if (typeof grantedById !== 'string' || grantedById !== targetId) continue;
      cascadeIds.add(item.id);
      cascadeDeleted.push({
        id: item.id,
        name: identifiedName(item),
        type: typeof item.type === 'string' ? item.type : '',
        sourceUuid: sourceUuidOf(item),
        reason: 'grantedBy',
      });
    }

    // Pass 2: container contents not already in the cascade set.
    for (const item of actor.items?.contents ?? []) {
      if (!item || !item.id || item.id === targetId) continue;
      if (cascadeIds.has(item.id)) continue;
      const isys = (item.system as AnyRecord | undefined) ?? {};
      if (isys.containerId !== targetId) continue;
      ejectedToTopLevel.push({
        id: item.id,
        name: identifiedName(item),
        type: typeof item.type === 'string' ? item.type : '',
        sourceUuid: sourceUuidOf(item),
      });
    }

    return { cascadeDeleted, ejectedToTopLevel };
  };

  // Helper: delete the target and guarantee the cascade-delete preview
  // is honored. PF2e's delete-time cascade depends on the parent
  // carrying a matching GrantItem rule entry, so the child flag alone
  // is not sufficient to trigger removal. We force-delete any
  // cascade-tagged survivors so the response always matches reality.
  const deleteWithCascadeEnforcement = async (
    targetId: string,
    cascadeChildIds: string[],
  ): Promise<void> => {
    await actor.deleteEmbeddedDocuments('Item', [targetId]);
    if (cascadeChildIds.length === 0) return;
    const survivors = cascadeChildIds.filter((id) => Boolean(actor.items?.get?.(id)));
    if (survivors.length > 0) {
      await actor.deleteEmbeddedDocuments('Item', survivors);
    }
  };

  // -- Mode: delete -----------------------------------------------------
  if (input.mode === 'delete') {
    const previews = collectPreviews(target.id);

    const currentQty =
      typeof target.system?.quantity === 'number' && Number.isFinite(target.system.quantity)
        ? (target.system.quantity as number)
        : null;

    const deletedItem: RemoveDeletedItem = {
      id: target.id,
      name: identifiedName(target),
      type: targetType,
      sourceUuid: sourceUuidOf(target),
      qtyAtDelete: isPhysical ? currentQty : null,
    };

    await deleteWithCascadeEnforcement(
      target.id,
      previews.cascadeDeleted.map((c) => c.id),
    );

    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'deleted',
      deletedItem,
      ejectedToTopLevel: previews.ejectedToTopLevel,
      cascadeDeleted: previews.cascadeDeleted,
    };
  }

  // -- Mode: decrement --------------------------------------------------
  const currentQty =
    typeof target.system?.quantity === 'number' && Number.isFinite(target.system.quantity)
      ? (target.system.quantity as number)
      : 1;
  // Clamp on overflow: decrementing more than current is allowed and
  // collapses to 0. With deleteIfZero defaulting true, this naturally
  // becomes a delete — matches the "tool figures out create-vs-merge"
  // pattern from pf2e_add_item_to_actor.
  const newQty = Math.max(0, currentQty - input.quantity);

  if (newQty > 0) {
    await actor.updateEmbeddedDocuments('Item', [{ _id: target.id, 'system.quantity': newQty }]);
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'decremented',
      item: {
        id: target.id,
        name: identifiedName(target),
        type: targetType,
        qtyBefore: currentQty,
        qtyAfter: newQty,
      },
    };
  }

  // newQty === 0
  if (!input.deleteIfZero) {
    await actor.updateEmbeddedDocuments('Item', [{ _id: target.id, 'system.quantity': 0 }]);
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'decremented',
      item: {
        id: target.id,
        name: identifiedName(target),
        type: targetType,
        qtyBefore: currentQty,
        qtyAfter: 0,
      },
    };
  }

  // newQty === 0 AND deleteIfZero → decrementedAndDeleted
  const previews = collectPreviews(target.id);
  const deletedItem: RemoveDecrementedToDeletedItem = {
    id: target.id,
    name: identifiedName(target),
    type: targetType,
    sourceUuid: sourceUuidOf(target),
    qtyBefore: currentQty,
  };

  await deleteWithCascadeEnforcement(
    target.id,
    previews.cascadeDeleted.map((c) => c.id),
  );

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'decrementedAndDeleted',
    deletedItem,
    ejectedToTopLevel: previews.ejectedToTopLevel,
    cascadeDeleted: previews.cascadeDeleted,
  };
}
