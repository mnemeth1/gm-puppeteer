/**
 * page.evaluate body for `dnd5e_remove_item_from_actor`. Removes an embedded
 * item from a D&D 5e actor's inventory or decrements its quantity. D&D 5e
 * sibling of `pf2e_remove_item_from_actor`; companion to
 * `dnd5e_add_item_to_actor`. Two modes:
 *
 *  - `delete`    — remove the item entry entirely.
 *  - `decrement` — reduce a physical item's `system.quantity` by N. When
 *    the resulting quantity is 0 and `deleteIfZero` is true (default),
 *    the item is deleted; otherwise the entry persists at qty 0.
 *
 * Behavior nuances confirmed by scripts/probe-dnd5e-remove-item-from-actor.mjs
 * against Foundry v14.361 + dnd5e 5.3.3. The 5e schema differs from PF2e —
 * no field path is ported on faith:
 *
 *  - **Container delete ORPHANS its contents.** Deleting a
 *    `type: "container"` item via `deleteEmbeddedDocuments` does NOT
 *    destroy the contained items, nor does it eject them — they survive
 *    with `system.container` still pointing at the now-deleted container
 *    id (a dangling reference). This differs from PF2e, where
 *    `ContainerPF2e._preDelete` actively ejects contents to top-level by
 *    nulling `system.containerId`. dnd5e does no such cleanup. To avoid
 *    leaving a dangling graph edge — the "relational-field mutations need
 *    tool-side invariant defense" rule — this tool collects the
 *    directly-contained items BEFORE the delete and, after deleting the
 *    target, explicitly nulls their `system.container` (ejecting them to
 *    the inventory root). The promoted items are surfaced as
 *    `ejectedToTopLevel`. Only direct (depth-1) children are repointed:
 *    deleting an outer container leaves a nested inner container's own
 *    subtree intact — the inner container is ejected to root and its
 *    children still correctly point at it.
 *
 *  - **No cascade.** 5e physical items have no `GrantItem`-style child
 *    documents — 5e uses Active Effects + Advancements. There is no
 *    `cascadeDeleted` field (the PF2e sibling has one).
 *
 *  - **Setting `system.quantity` to 0** via `updateEmbeddedDocuments`
 *    persists at the document layer — Foundry does NOT auto-delete qty-0
 *    items. Setting a negative value is silently clamped to 0 by the
 *    schema. The zod input layer rejects negatives/zero before the eval,
 *    so the clamp is recorded as context only. `deleteIfZero: true`
 *    (default) deletes the entry when a decrement reaches 0, matching the
 *    intuitive "used the last one" outcome.
 *
 *  - **Name on unidentified items.** For an item with
 *    `system.identified: false`, dnd5e's `Item5e#name` getter returns the
 *    MASKED name (`system.unidentified.name`), not the true name. This
 *    tool reports `item.name` verbatim — the displayed name — which is a
 *    deliberate divergence from the PF2e sibling (which resolves the
 *    canonical identified name) and is consistent with
 *    `dnd5e_add_item_to_actor`, which also reports the bare document name.
 *
 *  - **Actor type support.** `character`, `npc` — same set as
 *    `dnd5e_add_item_to_actor` / `dnd5e_apply_condition`. `vehicle` /
 *    `group` / `encounter` are rejected with ACTOR_TYPE_UNSUPPORTED. 5e
 *    has no `familiar` actor type. (The PF2e sibling has no actor-type
 *    gate; this gate mirrors the rest of the dnd5e tool family.)
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline. Only erased-at-runtime type declarations
 * and the exported tool-layer-only const live at module scope.
 */
export interface Dnd5eRemoveItemFromActorInput {
  actorId: string;
  itemId: string;
  mode: 'delete' | 'decrement';
  /** Ignored when mode='delete'. */
  quantity: number;
  /** Ignored when mode='delete'. */
  deleteIfZero: boolean;
}

export interface Dnd5eRemoveDeletedItem {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
  /** `system.quantity` at the moment of delete. `null` for non-physical types. */
  qtyAtDelete: number | null;
}

export interface Dnd5eRemoveDecrementedToDeletedItem {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
  /** Quantity before this call; for the qty-collapsed-to-zero path. */
  qtyBefore: number;
}

export interface Dnd5eRemoveEjectedEntry {
  id: string;
  name: string;
  type: string;
  sourceUuid: string | null;
}

export interface Dnd5eRemoveDecrementedItem {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export type Dnd5eRemoveItemFromActorOk =
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'deleted';
      deletedItem: Dnd5eRemoveDeletedItem;
      ejectedToTopLevel: Dnd5eRemoveEjectedEntry[];
    }
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'decremented';
      item: Dnd5eRemoveDecrementedItem;
    }
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'decrementedAndDeleted';
      deletedItem: Dnd5eRemoveDecrementedToDeletedItem;
      ejectedToTopLevel: Dnd5eRemoveEjectedEntry[];
    };

export interface Dnd5eRemoveItemFromActorErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'ITEM_NOT_FOUND_ON_ACTOR'
        | 'INVALID_QUANTITY'
        | 'DECREMENT_ON_NON_PHYSICAL';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eRemoveItemFromActorResult =
  | Dnd5eRemoveItemFromActorOk
  | Dnd5eRemoveItemFromActorErr;

/** Actor types this tool will mutate. Mirrors dnd5e_add_item_to_actor's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

/**
 * The D&D 5e physical-inventory item types `decrement` mode supports.
 * Mirrors `dnd5e_add_item_to_actor`'s set. Exported for the tool layer to
 * reuse in user-facing error messages; the evaluator re-declares this set
 * inline because module-scope identifiers do not survive `page.evaluate`
 * serialization.
 */
export const PHYSICAL_ITEM_TYPES = [
  'weapon',
  'equipment',
  'consumable',
  'tool',
  'loot',
  'container',
] as const;

export async function dnd5eRemoveItemFromActorBody(
  input: Dnd5eRemoveItemFromActorInput,
): Promise<Dnd5eRemoveItemFromActorResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);
  const PHYSICAL = new Set(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container']);
  const PHYSICAL_TYPES_LIST = 'weapon, equipment, consumable, tool, loot, container';

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface ItemDocLike {
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
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

  const fail = (
    message: string,
    details: Dnd5eRemoveItemFromActorErr['error']['details'],
  ): Dnd5eRemoveItemFromActorErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const sourceUuidOf = (item: ItemDocLike): string | null => {
    const raw = item._stats?.compendiumSource;
    return typeof raw === 'string' ? raw : null;
  };

  const nameOf = (item: ItemDocLike): string => (typeof item.name === 'string' ? item.name : '');

  const typeOf = (item: ItemDocLike): string => (typeof item.type === 'string' ? item.type : '');

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
      `Actor type '${actorType}' is not supported by dnd5e_remove_item_from_actor. ` +
        `Supported types: character, npc. (5e has no familiar actor type.)`,
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

  const targetId: string = target.id;
  const targetType = typeOf(target);
  const isPhysical = PHYSICAL.has(targetType);

  // -- Decrement-mode-specific validation.
  if (input.mode === 'decrement') {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      return fail(`quantity must be an integer ≥ 1, got: ${String(input.quantity)}`, {
        reason: 'INVALID_QUANTITY',
        quantity: input.quantity,
      });
    }
    if (!isPhysical) {
      return fail(
        `decrement mode requires a physical item type; this item is '${targetType}'. Use ` +
          `mode 'delete' to remove it. Physical types: ${PHYSICAL_TYPES_LIST}.`,
        { reason: 'DECREMENT_ON_NON_PHYSICAL', itemId: input.itemId, type: targetType },
      );
    }
  }

  // -- Helper: collect the items directly contained by the target (those
  // whose `system.container` equals the target id). Run BEFORE the delete
  // so the entries can be named and then re-pointed to the inventory root.
  const collectContained = (): Dnd5eRemoveEjectedEntry[] => {
    const contained: Dnd5eRemoveEjectedEntry[] = [];
    for (const item of actor.items?.contents ?? []) {
      if (!item || !item.id || item.id === targetId) continue;
      const isys = (item.system as AnyRecord | undefined) ?? {};
      if (isys.container !== targetId) continue;
      contained.push({
        id: item.id,
        name: nameOf(item),
        type: typeOf(item),
        sourceUuid: sourceUuidOf(item),
      });
    }
    return contained;
  };

  // -- Helper: delete the target and eject its direct contents to the
  // inventory root. dnd5e leaves `system.container` dangling at the
  // deleted id (probe Q1) — this tool nulls it so callers never see a
  // dangling graph edge. The eject runs AFTER the delete so a failed
  // delete leaves the container graph untouched.
  const deleteAndEject = async (contained: Dnd5eRemoveEjectedEntry[]): Promise<void> => {
    await actor.deleteEmbeddedDocuments('Item', [targetId]);
    const survivors = contained.filter((c) => Boolean(actor.items?.get?.(c.id)));
    if (survivors.length > 0) {
      await actor.updateEmbeddedDocuments(
        'Item',
        survivors.map((c) => ({ _id: c.id, 'system.container': null })),
      );
    }
  };

  // -- Mode: delete -----------------------------------------------------
  if (input.mode === 'delete') {
    const contained = collectContained();

    const sys = (target.system as AnyRecord | undefined) ?? {};
    const currentQty =
      typeof sys.quantity === 'number' && Number.isFinite(sys.quantity)
        ? (sys.quantity as number)
        : null;

    const deletedItem: Dnd5eRemoveDeletedItem = {
      id: targetId,
      name: nameOf(target),
      type: targetType,
      sourceUuid: sourceUuidOf(target),
      qtyAtDelete: isPhysical ? currentQty : null,
    };

    await deleteAndEject(contained);

    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'deleted',
      deletedItem,
      ejectedToTopLevel: contained,
    };
  }

  // -- Mode: decrement --------------------------------------------------
  const sys = (target.system as AnyRecord | undefined) ?? {};
  const currentQty =
    typeof sys.quantity === 'number' && Number.isFinite(sys.quantity)
      ? (sys.quantity as number)
      : 1;
  // Clamp on overflow: decrementing more than current is allowed and
  // collapses to 0. With deleteIfZero defaulting true, this naturally
  // becomes a delete.
  const newQty = Math.max(0, currentQty - input.quantity);

  if (newQty > 0) {
    await actor.updateEmbeddedDocuments('Item', [{ _id: targetId, 'system.quantity': newQty }]);
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'decremented',
      item: {
        id: targetId,
        name: nameOf(target),
        type: targetType,
        qtyBefore: currentQty,
        qtyAfter: newQty,
      },
    };
  }

  // newQty === 0
  if (!input.deleteIfZero) {
    await actor.updateEmbeddedDocuments('Item', [{ _id: targetId, 'system.quantity': 0 }]);
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'decremented',
      item: {
        id: targetId,
        name: nameOf(target),
        type: targetType,
        qtyBefore: currentQty,
        qtyAfter: 0,
      },
    };
  }

  // newQty === 0 AND deleteIfZero → decrementedAndDeleted
  const contained = collectContained();
  const deletedItem: Dnd5eRemoveDecrementedToDeletedItem = {
    id: targetId,
    name: nameOf(target),
    type: targetType,
    sourceUuid: sourceUuidOf(target),
    qtyBefore: currentQty,
  };

  await deleteAndEject(contained);

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'decrementedAndDeleted',
    deletedItem,
    ejectedToTopLevel: contained,
  };
}
