/**
 * page.evaluate body for move_item_to_container. Relocates an existing
 * physical item on an actor into a different container on the same
 * actor, or to root inventory (containerId: null). The third member of
 * the inventory-mutation cluster, alongside `add_item_to_actor`
 * (merge-add) and `update_item_quantity` (set quantity). First tool to
 * mutate a relational field (system.containerId) rather than a scalar.
 *
 * Behavior nuances confirmed by scripts/probe-move-item-to-container.mjs
 * and scripts/probe-move-item-to-container-phase1.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *  - `updateEmbeddedDocuments("Item", [{_id, "system.containerId": v}])`
 *    is the exclusive write path. No parallel field updates needed —
 *    pre/post diff on a no-op set shows zero drift outside the field.
 *  - For physical items at root, `system.containerId` is literally
 *    `null`. For non-physical items (feats, classes, spells, etc.),
 *    the field is absent from the schema entirely. The tool always
 *    echoes `null` (never `undefined` or `""`) for root in its
 *    response, so callers can rely on a single shape.
 *  - Setting `system.containerId` to its current value is a clean
 *    no-op at the document layer: `updateEmbeddedDocuments` returns
 *    `[]`, does NOT throw. The tool surfaces this via
 *    `containerIdBefore === containerIdAfter` in the response — no
 *    separate `noop` flag (mirrors update_item_quantity's qtyBefore /
 *    qtyAfter precedent).
 *  - Foundry does NOT auto-merge stacks when a containerId update
 *    aligns two siblings on `compendiumSource + containerId +
 *    identification.status` (Phase 1 Q4 verified two distinct stacks
 *    survive). The tool implements the merge branch explicitly,
 *    identical in shape to `add_item_to_actor`'s merge identity:
 *    same `_stats.compendiumSource` + same destination `containerId` +
 *    same `system.identification.status`. The merge folds the source
 *    item's quantity into the matching sibling and deletes the source.
 *    The source item's id is intentionally NOT echoed in the merged
 *    response — it no longer exists; callers holding stale ids must
 *    refresh via `get_actor_inventory`.
 *  - Moving a container with contents leaves the contents inside the
 *    container (their `containerId` references are unaffected by the
 *    parent's move; Phase 1 Q5 verified). No cascade work needed.
 *  - **Cycle detection is the tool's responsibility.** Foundry only
 *    rejects exact self-cycles (depth 1, silently clamps the value
 *    to null); cycles of depth 2+ (parent → child, deeper chains) are
 *    accepted and persisted, leaving the actor in a logically corrupt
 *    state (an item is its own ancestor). Phase 1 Q6 sub-probes
 *    verified this. The tool walks the destination's ancestor chain
 *    and rejects if the source is reachable as an ancestor (or is the
 *    destination itself).
 *  - **TARGET_NOT_CONTAINER is the tool's responsibility.** Foundry
 *    accepts a containerId pointing at a non-container item (e.g., a
 *    weapon's id) and persists it. Phase 1 Q7 verified. The tool
 *    rejects up-front when `destinationItem.type !== 'backpack'`.
 *  - Setting `system.containerId` on a non-physical item is silently
 *    dropped by Foundry's schema (Phase 1 Q8 verified). The
 *    MOVE_ON_NON_PHYSICAL rejection is the user-facing safety net —
 *    without it, the call would appear to succeed but accomplish
 *    nothing.
 *
 * No quantity input — partial-stack moves (split-and-move) are
 * out of scope; compose from `update_item_quantity` (decrement source) +
 * `add_item_to_actor` (create destination) until a dedicated
 * `split_item` tool exists.
 *
 * No identification input — identification changes are a separate
 * concern; the move preserves the source item's identification status.
 *
 * No `destinationActorId` — cross-actor transfer has different
 * semantics (rune carryover, identification rules, merge identity
 * spans actors) and belongs in a future `transfer_item_between_actors`
 * tool.
 *
 * No numeric inputs — the strict-int / no-coerce convention from
 * `update_item_quantity` is intentionally absent here because the
 * surface has no scalar parameters.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface MoveItemToContainerInput {
  actorId: string;
  itemId: string;
  containerId: string | null;
  merge: boolean;
}

export interface MoveItemToContainerMovedItem {
  id: string;
  name: string;
  type: string;
  quantity: number;
  containerIdBefore: string | null;
  containerIdAfter: string | null;
}

export interface MoveItemToContainerMergedInto {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export type MoveItemToContainerOk =
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'moved';
      item: MoveItemToContainerMovedItem;
    }
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'merged';
      mergedInto: MoveItemToContainerMergedInto;
    };

export interface MoveItemToContainerErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type MoveItemToContainerResult = MoveItemToContainerOk | MoveItemToContainerErr;

/** Physical inventory item types this tool will move. Exported for the
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

export async function moveItemToContainerBody(
  input: MoveItemToContainerInput,
): Promise<MoveItemToContainerResult> {
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
    name?: string;
    type?: string;
    system?: AnyRecord;
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

  const fail = (message: string, details: Record<string, unknown>): MoveItemToContainerErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // Surface the identified (canonical) name regardless of an item's
  // current identification status. Mirrors update_item_quantity /
  // remove_item_from_actor.
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

  // Read the containerId reference from an item, normalizing the
  // null / undefined / "" surface variants to a single shape:
  //   - null:        item is at root
  //   - non-empty:   item is inside that container
  // For non-physical items the field is absent — they read as null too,
  // which is fine because non-physical items are rejected up-front.
  const containerIdOf = (item: ItemDocLike): string | null => {
    const raw = (item.system as AnyRecord | undefined)?.containerId;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return null;
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

  // -- Resolve target item.
  const target = actor.items?.get?.(input.itemId);
  if (!target || !target.id) {
    return fail(`No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`, {
      actorId: input.actorId,
      itemId: input.itemId,
      reason: 'ITEM_NOT_FOUND',
    });
  }

  const targetType: string = typeof target.type === 'string' ? target.type : '';
  if (!PHYSICAL_ITEM_TYPES.has(targetType)) {
    return fail(
      `move_item_to_container requires a physical item type; this item is '${targetType}'. ` +
        `Non-physical items (feats, actions, spells, ancestries, etc.) do not have a ` +
        `\`system.containerId\` field — Foundry silently drops the update. Physical types: ` +
        `${PHYSICAL_TYPES_LIST}. Use foundry_eval if you need to manipulate non-physical items.`,
      { itemId: input.itemId, type: targetType, reason: 'MOVE_ON_NON_PHYSICAL' },
    );
  }

  // -- Resolve / validate destination container (when non-null).
  let destinationContainer: ItemDocLike | null = null;
  if (input.containerId !== null) {
    destinationContainer = actor.items?.get?.(input.containerId) ?? null;
    if (!destinationContainer) {
      return fail(
        `No item found on actor ${actor.id ?? input.actorId} for containerId: ${input.containerId}`,
        {
          actorId: input.actorId,
          containerId: input.containerId,
          reason: 'CONTAINER_NOT_FOUND',
        },
      );
    }
    const containerType =
      typeof destinationContainer.type === 'string' ? destinationContainer.type : '';
    if (containerType !== 'backpack') {
      return fail(
        `Item with containerId ${input.containerId} is type '${containerType}', not a container ` +
          `(expected type 'backpack'). Foundry does not enforce this — setting containerId to a ` +
          `non-container id would persist and corrupt the actor's inventory tree.`,
        {
          containerId: input.containerId,
          type: containerType,
          reason: 'TARGET_NOT_CONTAINER',
        },
      );
    }
  }

  // -- Cycle detection.
  // Foundry only rejects exact self-cycles (depth 1) and accepts deeper
  // cycles silently, so we walk the destination's ancestor chain and
  // reject if `target` is the destination itself or is reachable as an
  // ancestor of the destination.
  if (input.containerId !== null && destinationContainer) {
    if (input.containerId === target.id) {
      return fail(`Cannot move item ${target.id} into itself (self-cycle).`, {
        itemId: target.id,
        containerId: input.containerId,
        reason: 'CYCLE_DETECTED',
      });
    }
    // Walk ancestors of destinationContainer. Each step: if we encounter
    // target.id, the move would create a cycle (target is an ancestor of
    // the destination).
    const visited = new Set<string>();
    let cursor: ItemDocLike | null = destinationContainer;
    let cycleHit = false;
    let depth = 0;
    while (cursor) {
      if (!cursor.id) break;
      if (visited.has(cursor.id)) break; // pre-existing cycle in actor data; bail
      visited.add(cursor.id);
      if (cursor.id === target.id) {
        cycleHit = true;
        break;
      }
      const parentId = containerIdOf(cursor);
      if (parentId === null) break;
      cursor = actor.items?.get?.(parentId) ?? null;
      depth += 1;
      if (depth > 256) break; // pathological-data safety net
    }
    if (cycleHit) {
      return fail(
        `Cannot move item ${target.id} into container ${input.containerId} — that would make ` +
          `the item its own ancestor (cycle). Move the destination out first, or pick a different ` +
          `container.`,
        { itemId: target.id, containerId: input.containerId, reason: 'CYCLE_DETECTED' },
      );
    }
  }

  // -- Capture before-state for the response.
  const containerIdBefore = containerIdOf(target);
  const targetSourceRaw = target._stats?.compendiumSource;
  const targetSource = typeof targetSourceRaw === 'string' ? targetSourceRaw : null;
  const targetIdent = (target.system as AnyRecord | undefined)?.identification as
    | AnyRecord
    | undefined;
  const targetStatus: 'identified' | 'unidentified' =
    targetIdent?.status === 'unidentified' ? 'unidentified' : 'identified';
  const targetQty =
    typeof target.system?.quantity === 'number' && Number.isFinite(target.system.quantity)
      ? (target.system.quantity as number)
      : 1;

  // -- Merge candidate lookup. Same identity check as add_item_to_actor:
  //   same compendium source (non-null) + same destination containerId
  //   (null counts) + same identification status. The source item is
  //   excluded explicitly (id mismatch).
  //
  // Containers (type='backpack') are excluded from the merge path
  // entirely. Two containers are NOT interchangeable — they have unique
  // identity in their contents — so folding qty-1 + qty-1 into a qty-2
  // backpack would be a UX disaster (the source backpack's contents
  // would be orphaned at the actor top level). Foundry's UI doesn't
  // merge containers either. This is a known gap in `add_item_to_actor`
  // too, but doesn't surface there because the source is always a fresh
  // compendium import with no contents.
  let mergeMatch: ItemDocLike | null = null;
  if (input.merge && targetSource !== null && targetType !== 'backpack') {
    for (const candidate of actor.items?.contents ?? []) {
      if (!candidate || !candidate.id) continue;
      if (candidate.id === target.id) continue;
      const candidateSourceRaw = candidate._stats?.compendiumSource;
      const candidateSource = typeof candidateSourceRaw === 'string' ? candidateSourceRaw : null;
      if (candidateSource !== targetSource) continue;
      const candidateContainer = containerIdOf(candidate);
      if (candidateContainer !== input.containerId) continue;
      const candidateIdent = (candidate.system as AnyRecord | undefined)?.identification as
        | AnyRecord
        | undefined;
      const candidateStatus =
        candidateIdent?.status === 'unidentified' ? 'unidentified' : 'identified';
      if (candidateStatus !== targetStatus) continue;
      mergeMatch = candidate;
      break;
    }
  }

  // -- Merge path: bump destination's quantity, delete source.
  if (mergeMatch && mergeMatch.id) {
    const matchSys = (mergeMatch.system as AnyRecord | undefined) ?? {};
    const matchQtyBefore =
      typeof matchSys.quantity === 'number' && Number.isFinite(matchSys.quantity)
        ? (matchSys.quantity as number)
        : 1;
    const matchQtyAfter = matchQtyBefore + targetQty;
    await actor.updateEmbeddedDocuments('Item', [
      { _id: mergeMatch.id, 'system.quantity': matchQtyAfter },
    ]);
    await actor.deleteEmbeddedDocuments('Item', [target.id]);
    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'merged',
      mergedInto: {
        id: mergeMatch.id,
        name: identifiedName(mergeMatch),
        type: typeof mergeMatch.type === 'string' ? mergeMatch.type : '',
        qtyBefore: matchQtyBefore,
        qtyAfter: matchQtyAfter,
      },
    };
  }

  // -- Plain move path. Same-destination is a clean no-op at Foundry's
  // document layer (returns [], no throw); the tool surfaces no-op via
  // containerIdBefore === containerIdAfter.
  await actor.updateEmbeddedDocuments('Item', [
    { _id: target.id, 'system.containerId': input.containerId },
  ]);
  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'moved',
    item: {
      id: target.id,
      name: identifiedName(target),
      type: targetType,
      quantity: targetQty,
      containerIdBefore,
      containerIdAfter: input.containerId,
    },
  };
}
