/**
 * page.evaluate body for `dnd5e_transfer_item_between_actors`. Moves a
 * physical item from one D&D 5e actor's inventory to another's. Five
 * operations live inside one evaluator: full transfer,
 * full-transfer-with-merge, partial-stack split, partial-stack
 * split-with-merge, and cascade transfer (a container plus its entire
 * subtree of nested items). D&D 5e sibling of
 * `pf2e_transfer_item_between_actors`; cross-actor cousin of
 * `dnd5e_move_item_to_container` (which rejects cross-actor moves).
 *
 * Behavior nuances confirmed by
 * scripts/probe-dnd5e-inventory-graph-phase1.mjs and
 * scripts/probe-dnd5e-transfer-item-between-actors.mjs against Foundry
 * v14.361 + dnd5e 5.3.3. The 5e schema differs from PF2e — no field path
 * is ported on faith:
 *
 *  - **Container field is `system.container`** — a bare item-id string or
 *    `null` at root. Container items are `type: "container"` (NOT PF2e's
 *    `backpack`). Physical types: weapon, equipment, consumable, tool,
 *    loot, container.
 *
 *  - Transfer is create-on-destination first, then mutate-source.
 *    Destination mutation commits first so a failed create leaves the
 *    source intact.
 *
 *  - **Equipment state is reset on every transferred item.** 5e's
 *    `system.equipped` is a bare boolean (probe Q8) — set to `false` in
 *    the payload. 5e's attunement is two fields (probe Q9):
 *    `system.attunement` (a string requirement: "" / "required" /
 *    "optional") and `system.attuned` (a boolean — whether currently
 *    attuned). Attunement is per-actor; an item attuned by the source
 *    character must NOT arrive pre-attuned on the destination character,
 *    so `system.attuned` is reset to `false`. The `system.attunement`
 *    requirement is left intact — it is a property of the item, not the
 *    holder.
 *
 *  - **No cascade rules / no ChoiceSet.** 5e physical items have no
 *    `GrantItem`-style child documents and no `ChoiceSet` rule element,
 *    so there is no headless-dialog hazard and no broken-grant-link
 *    surface (the PF2e sibling has both — they are dropped here).
 *
 *  - Identification (`system.identified`, a boolean) carries over verbatim
 *    via the `toObject()` payload — an unidentified item stays
 *    unidentified on the destination. Merge identity matches
 *    `dnd5e_add_item_to_actor`: `_stats.compendiumSource` + destination
 *    `system.container` + `system.identified`. Containers are excluded
 *    from merge — they carry identity in their contents.
 *    `_stats.compendiumSource` survives the toObject→create round-trip
 *    (probe Q12), so a transferred item is still merge-eligible afterward.
 *
 *  - Cascade transfer for containers:
 *      1. BFS the source subtree (root + every descendant whose
 *         `system.container` chains back to root).
 *      2. Pre-generate destination ids via `foundry.utils.randomID(16)`
 *         for every subtree node, building the oldId → newId map BEFORE
 *         create — `createEmbeddedDocuments` does not preserve input
 *         order, so a positional map would corrupt the tree.
 *      3. Build each payload with `_id` set to its pre-generated id AND
 *         `system.container` wired to the parent's pre-generated id (or
 *         `destinationContainerId` for the root). Pass `{ keepId: true }`.
 *         Probe Q10 confirmed `keepId` preserves ids and tree shape
 *         regardless of payload order.
 *      4. Delete the source subtree in ONE `deleteEmbeddedDocuments`
 *         call. Probe Q11 confirmed a batched subtree delete is clean —
 *         5e has no container `_preDelete` eject (unlike PF2e), so there
 *         is no eject-to-root side effect to design around.
 *    After create, every pre-generated id is verified present on the
 *    destination as a defense against a rewrite at `_preCreate` time.
 *
 *  - Cascade transfer is full-stack only. Partial-quantity on a container
 *    is rejected (SPLIT_ON_CONTAINER).
 *
 *  - No cycle detection is needed: cross-actor moves cannot form cycles
 *    on the destination — transferred items receive fresh ids the caller
 *    could not have referenced in `destinationContainerId`. The
 *    destination container is type-validated the same way
 *    `dnd5e_move_item_to_container` does.
 *
 *  - **Actor type support.** `character`, `npc` on BOTH source and
 *    destination — same set as the rest of the dnd5e tool family.
 *    `vehicle` / `group` / `encounter` are rejected with
 *    ACTOR_TYPE_UNSUPPORTED. 5e has no `familiar` actor type.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface Dnd5eTransferItemBetweenActorsInput {
  sourceActorId: string;
  destinationActorId: string;
  itemId: string;
  destinationContainerId: string | null;
  /** null = full stack (or, for a container, the whole subtree); integer ≥ 1 = split N off. */
  quantity: number | null;
  merge: 'auto' | 'never';
}

export interface Dnd5eTransferCreatedItem {
  oldId: string;
  newId: string;
  name: string;
  type: string;
  quantity: number;
  containerAfter: string | null;
}

export interface Dnd5eTransferMergedInto {
  id: string;
  name: string;
  type: string;
  previousQuantity: number;
  newQuantity: number;
  addedQuantity: number;
  container: string | null;
}

export interface Dnd5eTransferSourceDecremented {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export interface Dnd5eTransferCascadeDescendant {
  oldId: string;
  newId: string;
  name: string;
  type: string;
  quantity: number;
  containerAfter: string;
}

export type Dnd5eTransferItemBetweenActorsOk =
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'transferred';
      item: Dnd5eTransferCreatedItem;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'transferredAndMerged';
      sourceDeletedId: string;
      mergedInto: Dnd5eTransferMergedInto;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'split';
      sourceItem: Dnd5eTransferSourceDecremented;
      created: Dnd5eTransferCreatedItem;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'splitAndMerged';
      sourceItem: Dnd5eTransferSourceDecremented;
      mergedInto: Dnd5eTransferMergedInto;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'cascadeTransferred';
      root: Dnd5eTransferCreatedItem;
      descendants: Dnd5eTransferCascadeDescendant[];
      warnings?: string[];
    };

export interface Dnd5eTransferItemBetweenActorsErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'INVALID_QUANTITY'
        | 'TRANSFER_TO_SAME_ACTOR'
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'ITEM_NOT_FOUND_ON_ACTOR'
        | 'NON_PHYSICAL_ITEM'
        | 'CONTAINER_NOT_FOUND'
        | 'CONTAINER_TYPE_INVALID'
        | 'SPLIT_ON_CONTAINER'
        | 'CREATE_FAILED';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eTransferItemBetweenActorsResult =
  | Dnd5eTransferItemBetweenActorsOk
  | Dnd5eTransferItemBetweenActorsErr;

/** Actor types this tool will mutate. Mirrors dnd5e_add_item_to_actor's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

/**
 * The D&D 5e physical-inventory item types this tool will transfer.
 * Exported for the tool layer's user-facing error message; the evaluator
 * re-declares this set inline because module-scope identifiers do not
 * survive `page.evaluate` serialization.
 */
export const PHYSICAL_ITEM_TYPES = [
  'weapon',
  'equipment',
  'consumable',
  'tool',
  'loot',
  'container',
] as const;

export async function dnd5eTransferItemBetweenActorsBody(
  input: Dnd5eTransferItemBetweenActorsInput,
): Promise<Dnd5eTransferItemBetweenActorsResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);
  const PHYSICAL = new Set(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container']);
  const PHYSICAL_TYPES_LIST = 'weapon, equipment, consumable, tool, loot, container';

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
    toObject(): AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    items?: {
      contents?: ItemDocLike[];
      get?(id: string): ItemDocLike | undefined;
    };
    createEmbeddedDocuments(
      name: 'Item',
      data: AnyRecord[],
      operation?: AnyRecord,
    ): Promise<ItemDocLike[]>;
    updateEmbeddedDocuments(
      name: 'Item',
      data: Array<AnyRecord & { _id: string }>,
    ): Promise<ItemDocLike[]>;
    deleteEmbeddedDocuments(name: 'Item', ids: string[]): Promise<ItemDocLike[]>;
  }
  interface FoundryUtilsLike {
    randomID?: (length?: number) => string;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
  }

  const fail = (
    message: string,
    details: Dnd5eTransferItemBetweenActorsErr['error']['details'],
  ): Dnd5eTransferItemBetweenActorsErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // Verbatim displayed name (NOT the PF2e canonical-identified resolver).
  const nameOf = (item: ItemDocLike): string =>
    typeof item.name === 'string' ? item.name : '';

  const typeOf = (item: ItemDocLike): string =>
    typeof item.type === 'string' ? item.type : '';

  const containerOf = (item: ItemDocLike): string | null => {
    const raw = (item.system as AnyRecord | undefined)?.container;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const qtyOf = (item: ItemDocLike): number => {
    const q = (item.system as AnyRecord | undefined)?.quantity;
    return typeof q === 'number' && Number.isFinite(q) ? q : 1;
  };

  const identifiedOf = (item: ItemDocLike): boolean =>
    (item.system as AnyRecord | undefined)?.identified !== false;

  const sourceUuidOf = (item: ItemDocLike): string | null => {
    const raw = item._stats?.compendiumSource;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  // Mutate a toObject() payload so the destination actor receives an
  // unequipped, unattuned item: the destination character has done
  // nothing to wield, wear, or attune it. `system.equipped` is a bare
  // boolean (probe Q8); `system.attuned` is a bare boolean and attunement
  // is per-actor (probe Q9). The `system.attunement` requirement is a
  // property of the item itself and is left intact.
  const resetTransferStateInPayload = (payload: AnyRecord): void => {
    const sys = (payload.system as AnyRecord | undefined) ?? {};
    const next: AnyRecord = { ...sys };
    if ('equipped' in sys) next.equipped = false;
    if ('attuned' in sys) next.attuned = false;
    payload.system = next;
  };

  // -- Validate quantity input shape (zod normalizes, defend here too).
  if (input.quantity !== null) {
    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1
    ) {
      return fail(
        `quantity must be a positive integer or null (full stack), got: ${String(input.quantity)}`,
        { reason: 'INVALID_QUANTITY', quantity: input.quantity },
      );
    }
  }

  // -- Reject same-actor.
  if (input.sourceActorId === input.destinationActorId) {
    return fail(
      `sourceActorId and destinationActorId are the same actor (${input.sourceActorId}). ` +
        `Use dnd5e_move_item_to_container for same-actor moves.`,
      { reason: 'TRANSFER_TO_SAME_ACTOR', actorId: input.sourceActorId },
    );
  }

  // -- Resolve actors.
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const sourceActor = game?.actors?.get(input.sourceActorId);
  if (!sourceActor) {
    return fail(`No actor found for sourceActorId: ${input.sourceActorId}`, {
      reason: 'ACTOR_NOT_FOUND',
      which: 'source',
      sourceActorId: input.sourceActorId,
    });
  }
  const destinationActor = game?.actors?.get(input.destinationActorId);
  if (!destinationActor) {
    return fail(`No actor found for destinationActorId: ${input.destinationActorId}`, {
      reason: 'ACTOR_NOT_FOUND',
      which: 'destination',
      destinationActorId: input.destinationActorId,
    });
  }

  // -- Validate actor types (both ends).
  const sourceType = typeof sourceActor.type === 'string' ? sourceActor.type : '';
  if (!SUPPORTED.has(sourceType)) {
    return fail(
      `Source actor type '${sourceType}' is not supported by dnd5e_transfer_item_between_actors. ` +
        `Supported types: character, npc. (5e has no familiar actor type.)`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', which: 'source', type: sourceType },
    );
  }
  const destType = typeof destinationActor.type === 'string' ? destinationActor.type : '';
  if (!SUPPORTED.has(destType)) {
    return fail(
      `Destination actor type '${destType}' is not supported by ` +
        `dnd5e_transfer_item_between_actors. Supported types: character, npc.`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', which: 'destination', type: destType },
    );
  }

  // -- Resolve target item on source.
  const target = sourceActor.items?.get?.(input.itemId);
  if (!target || typeof target.id !== 'string' || target.id.length === 0) {
    return fail(
      `No item found on source actor ${sourceActor.id ?? input.sourceActorId} for itemId: ` +
        `${input.itemId}`,
      { reason: 'ITEM_NOT_FOUND_ON_ACTOR', sourceActorId: input.sourceActorId, itemId: input.itemId },
    );
  }
  const targetId: string = target.id;
  const targetType = typeOf(target);

  if (!PHYSICAL.has(targetType)) {
    return fail(
      `dnd5e_transfer_item_between_actors requires a physical item type; this item is ` +
        `'${targetType}'. Non-physical items (spells, feats, classes, etc.) do not move ` +
        `between actors this way. Physical types: ${PHYSICAL_TYPES_LIST}. Use foundry_eval ` +
        `for non-physical items.`,
      { reason: 'NON_PHYSICAL_ITEM', itemId: input.itemId, type: targetType },
    );
  }

  // -- Resolve / validate destination container.
  if (input.destinationContainerId !== null) {
    const destinationContainer =
      destinationActor.items?.get?.(input.destinationContainerId) ?? null;
    if (!destinationContainer) {
      return fail(
        `No item found on destination actor ${destinationActor.id ?? input.destinationActorId} ` +
          `for destinationContainerId: ${input.destinationContainerId}`,
        {
          reason: 'CONTAINER_NOT_FOUND',
          destinationActorId: input.destinationActorId,
          destinationContainerId: input.destinationContainerId,
        },
      );
    }
    const containerType = typeOf(destinationContainer);
    if (containerType !== 'container') {
      return fail(
        `Item with destinationContainerId ${input.destinationContainerId} is type ` +
          `'${containerType}', not a container (expected type 'container'). Foundry does not ` +
          `enforce this — it would persist and corrupt the destination actor's inventory tree.`,
        {
          reason: 'CONTAINER_TYPE_INVALID',
          destinationContainerId: input.destinationContainerId,
          type: containerType,
        },
      );
    }
  }

  // -- Mode selection.
  const targetIsContainer = targetType === 'container';
  const targetQty = qtyOf(target);

  if (input.quantity !== null) {
    if (targetIsContainer) {
      return fail(
        `Cannot split a container — partial-quantity transfer requires a stackable item. ` +
          `Containers carry identity in their contents. Omit the quantity parameter to transfer ` +
          `the whole container (with its contents) via the cascade path.`,
        { reason: 'SPLIT_ON_CONTAINER', itemId: targetId, type: targetType },
      );
    }
    if (input.quantity > targetQty) {
      return fail(
        `Requested quantity ${input.quantity} exceeds available ${targetQty} on source item ` +
          `${targetId}. Reduce quantity, or omit it to transfer the entire stack.`,
        {
          reason: 'INVALID_QUANTITY',
          requested: input.quantity,
          available: targetQty,
          itemId: targetId,
        },
      );
    }
  }

  // 'cascade' for container-no-quantity, 'split' for partial-qty < current,
  // 'full' for everything else (including quantity === current).
  let mode: 'cascade' | 'split' | 'full';
  if (input.quantity === null && targetIsContainer) {
    mode = 'cascade';
  } else if (input.quantity !== null && input.quantity < targetQty) {
    mode = 'split';
  } else {
    mode = 'full';
  }

  // -- BFS the source subtree (cascade) or just wrap the target.
  interface SubtreeNode {
    oldId: string;
    originalContainer: string | null;
    name: string;
    type: string;
    quantity: number;
    payload: AnyRecord;
  }

  const captureNode = (item: ItemDocLike): SubtreeNode => ({
    oldId: item.id ?? '',
    originalContainer: containerOf(item),
    name: nameOf(item),
    type: typeOf(item),
    quantity: qtyOf(item),
    payload: item.toObject(),
  });

  const rootNode: SubtreeNode = captureNode(target);
  const subtree: SubtreeNode[] = [rootNode];
  const subtreeIds = new Set<string>([targetId]);

  if (mode === 'cascade') {
    let cursor = 0;
    let safety = 0;
    while (cursor < subtree.length) {
      const cursorNode = subtree[cursor];
      cursor += 1;
      if (!cursorNode) continue;
      const parentId = cursorNode.oldId;
      for (const candidate of sourceActor.items?.contents ?? []) {
        if (!candidate || !candidate.id) continue;
        if (subtreeIds.has(candidate.id)) continue;
        if (containerOf(candidate) !== parentId) continue;
        subtree.push(captureNode(candidate));
        subtreeIds.add(candidate.id);
      }
      safety += 1;
      if (safety > 4096) break; // pathological-data safety net
    }
  }

  // -- Merge candidate lookup (full & split only; never for cascade).
  //
  // Identity: same compendium source (non-null), same destination
  // container (null counts), same identification status. Containers
  // excluded. Target lives on a different actor so id collisions are
  // impossible.
  const findMergeCandidate = (): { match: ItemDocLike | null; multiple: boolean } => {
    if (mode === 'cascade' || input.merge !== 'auto' || targetIsContainer) {
      return { match: null, multiple: false };
    }
    const targetSource = sourceUuidOf(target);
    if (targetSource === null) return { match: null, multiple: false };
    const targetIdentified = identifiedOf(target);
    let first: ItemDocLike | null = null;
    let count = 0;
    for (const candidate of destinationActor.items?.contents ?? []) {
      if (!candidate || !candidate.id) continue;
      if (typeOf(candidate) === 'container') continue;
      if (sourceUuidOf(candidate) !== targetSource) continue;
      if (containerOf(candidate) !== input.destinationContainerId) continue;
      if (identifiedOf(candidate) !== targetIdentified) continue;
      if (!first) first = candidate;
      count += 1;
    }
    return { match: first, multiple: count > 1 };
  };

  const mergeLookup = findMergeCandidate();
  const warnings: string[] = [];
  if (mergeLookup.multiple) {
    warnings.push(
      `Multiple existing stacks on the destination matched the merge identity (same source, ` +
        `container, identification). Merged into the first; the others were left untouched.`,
    );
  }

  // -- Payload builder (root-only, for full / split modes).
  // Strips _id (Foundry assigns a fresh one), sets root's container,
  // optionally overrides quantity for the split path, resets equip /
  // attune state.
  const buildRootPayload = (overrideQuantity: number | null): AnyRecord => {
    const data: AnyRecord = { ...rootNode.payload };
    delete (data as { _id?: unknown })._id;
    const sys: AnyRecord = { ...((data.system as AnyRecord | undefined) ?? {}) };
    sys.container = input.destinationContainerId;
    if (overrideQuantity !== null) sys.quantity = overrideQuantity;
    data.system = sys;
    resetTransferStateInPayload(data);
    return data;
  };

  const sourceActorEcho = {
    id: sourceActor.id ?? input.sourceActorId,
    name: sourceActor.name ?? '',
  };
  const destinationActorEcho = {
    id: destinationActor.id ?? input.destinationActorId,
    name: destinationActor.name ?? '',
  };

  // ===================================================================
  // SPLIT path.
  // ===================================================================
  if (mode === 'split') {
    const quantity = input.quantity as number;
    const qtyBefore = targetQty;
    const qtyAfter = qtyBefore - quantity;

    if (mergeLookup.match && mergeLookup.match.id) {
      const match = mergeLookup.match;
      const matchId: string = match.id as string;
      const matchQtyBefore = qtyOf(match);
      const matchQtyAfter = matchQtyBefore + quantity;
      // Destination first, then source decrement.
      await destinationActor.updateEmbeddedDocuments('Item', [
        { _id: matchId, 'system.quantity': matchQtyAfter },
      ]);
      await sourceActor.updateEmbeddedDocuments('Item', [
        { _id: targetId, 'system.quantity': qtyAfter },
      ]);
      const result: Dnd5eTransferItemBetweenActorsOk = {
        ok: true,
        sourceActor: sourceActorEcho,
        destinationActor: destinationActorEcho,
        operation: 'splitAndMerged',
        sourceItem: {
          id: targetId,
          name: nameOf(target),
          type: targetType,
          qtyBefore,
          qtyAfter,
        },
        mergedInto: {
          id: matchId,
          name: nameOf(match),
          type: typeOf(match),
          previousQuantity: matchQtyBefore,
          newQuantity: matchQtyAfter,
          addedQuantity: quantity,
          container: input.destinationContainerId,
        },
      };
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    }

    // No merge: create on destination with quantity=N, then decrement source.
    const payload = buildRootPayload(quantity);
    const createdArr = await destinationActor.createEmbeddedDocuments('Item', [payload]);
    const created = createdArr?.[0];
    if (!created || typeof created.id !== 'string' || created.id.length === 0) {
      return fail(
        `createEmbeddedDocuments on the destination returned no document for itemId: ${targetId}`,
        { reason: 'CREATE_FAILED', itemId: targetId },
      );
    }
    await sourceActor.updateEmbeddedDocuments('Item', [
      { _id: targetId, 'system.quantity': qtyAfter },
    ]);
    const result: Dnd5eTransferItemBetweenActorsOk = {
      ok: true,
      sourceActor: sourceActorEcho,
      destinationActor: destinationActorEcho,
      operation: 'split',
      sourceItem: {
        id: targetId,
        name: nameOf(target),
        type: targetType,
        qtyBefore,
        qtyAfter,
      },
      created: {
        oldId: targetId,
        newId: created.id,
        name: nameOf(created),
        type: typeOf(created) || targetType,
        quantity,
        containerAfter: input.destinationContainerId,
      },
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  // ===================================================================
  // FULL path (single physical item, possibly stackable).
  // ===================================================================
  if (mode === 'full') {
    if (mergeLookup.match && mergeLookup.match.id) {
      const match = mergeLookup.match;
      const matchId: string = match.id as string;
      const matchQtyBefore = qtyOf(match);
      const matchQtyAfter = matchQtyBefore + targetQty;
      await destinationActor.updateEmbeddedDocuments('Item', [
        { _id: matchId, 'system.quantity': matchQtyAfter },
      ]);
      await sourceActor.deleteEmbeddedDocuments('Item', [targetId]);
      const result: Dnd5eTransferItemBetweenActorsOk = {
        ok: true,
        sourceActor: sourceActorEcho,
        destinationActor: destinationActorEcho,
        operation: 'transferredAndMerged',
        sourceDeletedId: targetId,
        mergedInto: {
          id: matchId,
          name: nameOf(match),
          type: typeOf(match),
          previousQuantity: matchQtyBefore,
          newQuantity: matchQtyAfter,
          addedQuantity: targetQty,
          container: input.destinationContainerId,
        },
      };
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    }

    // No merge: create on destination, delete on source.
    const payload = buildRootPayload(null);
    const createdArr = await destinationActor.createEmbeddedDocuments('Item', [payload]);
    const created = createdArr?.[0];
    if (!created || typeof created.id !== 'string' || created.id.length === 0) {
      return fail(
        `createEmbeddedDocuments on the destination returned no document for itemId: ${targetId}`,
        { reason: 'CREATE_FAILED', itemId: targetId },
      );
    }
    await sourceActor.deleteEmbeddedDocuments('Item', [targetId]);
    const result: Dnd5eTransferItemBetweenActorsOk = {
      ok: true,
      sourceActor: sourceActorEcho,
      destinationActor: destinationActorEcho,
      operation: 'transferred',
      item: {
        oldId: targetId,
        newId: created.id,
        name: nameOf(created),
        type: typeOf(created) || targetType,
        quantity: qtyOf(created),
        containerAfter: input.destinationContainerId,
      },
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  // ===================================================================
  // CASCADE path.
  //
  // `createEmbeddedDocuments` returns its array in some order Foundry
  // chooses, so a positional oldId → newId map is unsafe. Pre-generate
  // ids via `foundry.utils.randomID(16)`, wire `system.container` in the
  // payload directly, and pass `{ keepId: true }` (probe Q10). Two
  // Foundry round-trips total: one create, one bulk delete.
  // ===================================================================
  const randomID = (globalThis as unknown as { foundry?: { utils?: FoundryUtilsLike } }).foundry
    ?.utils?.randomID;
  if (typeof randomID !== 'function') {
    return fail(
      `foundry.utils.randomID is not available — cannot pre-generate ids for cascade transfer.`,
      { reason: 'CREATE_FAILED' },
    );
  }

  const oldToNew = new Map<string, string>();
  for (const node of subtree) {
    oldToNew.set(node.oldId, randomID(16));
  }

  const payloads: AnyRecord[] = subtree.map((node, idx) => {
    const newId = oldToNew.get(node.oldId);
    if (typeof newId !== 'string') {
      throw new Error(`Internal: missing pre-generated id for ${node.oldId}`);
    }
    let resolvedContainer: string | null;
    if (idx === 0) {
      resolvedContainer = input.destinationContainerId;
    } else {
      resolvedContainer = node.originalContainer
        ? (oldToNew.get(node.originalContainer) ?? null)
        : null;
    }
    const data: AnyRecord = { ...node.payload };
    data._id = newId;
    const sys: AnyRecord = { ...((data.system as AnyRecord | undefined) ?? {}) };
    sys.container = resolvedContainer;
    data.system = sys;
    resetTransferStateInPayload(data);
    return data;
  });

  const createdDocs = await destinationActor.createEmbeddedDocuments('Item', payloads, {
    keepId: true,
  });
  if (!Array.isArray(createdDocs) || createdDocs.length !== subtree.length) {
    return fail(
      `createEmbeddedDocuments on the destination returned ${
        Array.isArray(createdDocs) ? createdDocs.length : 'no'
      } documents for a subtree of ${subtree.length} items.`,
      {
        reason: 'CREATE_FAILED',
        subtreeSize: subtree.length,
        returned: Array.isArray(createdDocs) ? createdDocs.length : null,
      },
    );
  }
  // Verify every pre-generated id landed.
  for (const node of subtree) {
    const expected = oldToNew.get(node.oldId);
    if (!expected || !destinationActor.items?.get?.(expected)) {
      return fail(
        `Pre-generated id ${expected ?? '?'} (oldId ${node.oldId}) is missing on the ` +
          `destination after create — the _id was rewritten, breaking the cascade tree shape.`,
        { reason: 'CREATE_FAILED', oldId: node.oldId, expectedNewId: expected ?? null },
      );
    }
  }

  // Delete the source subtree in one call.
  await sourceActor.deleteEmbeddedDocuments(
    'Item',
    subtree.map((n) => n.oldId),
  );

  const rootNewId = oldToNew.get(targetId);
  if (!rootNewId) {
    return fail(`Internal: root oldId ${targetId} missing from the id map post-create.`, {
      reason: 'CREATE_FAILED',
      itemId: targetId,
    });
  }
  const rootCreated = destinationActor.items?.get?.(rootNewId);
  const root: Dnd5eTransferCreatedItem = {
    oldId: targetId,
    newId: rootNewId,
    name: rootCreated ? nameOf(rootCreated) : rootNode.name,
    type: targetType,
    quantity: rootCreated ? qtyOf(rootCreated) : targetQty,
    containerAfter: input.destinationContainerId,
  };

  const descendants: Dnd5eTransferCascadeDescendant[] = [];
  for (let i = 1; i < subtree.length; i++) {
    const node = subtree[i];
    if (!node) continue;
    const newId = oldToNew.get(node.oldId);
    if (!newId) continue;
    const liveItem = destinationActor.items?.get?.(newId);
    const parentNewId = node.originalContainer
      ? (oldToNew.get(node.originalContainer) ?? '')
      : '';
    descendants.push({
      oldId: node.oldId,
      newId,
      name: liveItem ? nameOf(liveItem) : node.name,
      type: node.type,
      quantity: liveItem ? qtyOf(liveItem) : node.quantity,
      containerAfter: parentNewId,
    });
  }

  const result: Dnd5eTransferItemBetweenActorsOk = {
    ok: true,
    sourceActor: sourceActorEcho,
    destinationActor: destinationActorEcho,
    operation: 'cascadeTransferred',
    root,
    descendants,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
