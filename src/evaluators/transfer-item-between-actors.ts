/**
 * page.evaluate body for transfer_item_between_actors. Moves a physical
 * item from one actor's inventory to another's. Five operations live
 * inside one evaluator: full transfer, full-transfer-with-merge,
 * partial-stack split, partial-stack split-with-merge, and cascade
 * transfer (a container plus its entire subtree of nested items).
 *
 * This is the fifth inventory-mutation tool and the first that touches
 * two actors in a single call. The same-actor cousin
 * `move_item_to_container` rejects this surface explicitly
 * (src/evaluators/move-item-to-container.ts:66-69) because cross-actor
 * carries enough additional semantics (rune carryover, identification
 * status carryover, merge identity spanning actors, equipment state
 * reset) that bundling it into `move_item_to_container` would be a
 * "do not conflate" violation.
 *
 * Behavior nuances confirmed by scripts/probe-transfer-item-between-actors.mjs
 * against Foundry v14.361 + PF2e 8.1.2:
 *  - Cross-actor transfer is implemented as create-on-destination first,
 *    then mutate-source. Destination mutation comes first so a failed
 *    `createEmbeddedDocuments` (e.g. a PF2e schema rejection on the
 *    payload) leaves the source intact. The reverse order would risk
 *    silent data loss.
 *  - Stack-merge identity is identical to `add_item_to_actor`:
 *    `_stats.compendiumSource` + destination `containerId` + identification
 *    status. Containers (`type: "backpack"`) are excluded from merge
 *    because they have unique identity in their contents.
 *  - Equipment state is reset on every transferred item:
 *    `system.equipped.{carryType, handsHeld, inSlot}` → stowed/0/false.
 *    The destination actor hasn't taken any action to wield, wear, or
 *    socket the item — leaving the source's equipped state would create
 *    nonsense like "wielded by an NPC who isn't holding anything."
 *  - Identification status carries over verbatim via the toObject()
 *    payload — an unidentified longsword stays unidentified on the
 *    destination actor. This is the desired loot-flow behavior: the GM
 *    wants the player to keep guessing, not have the item magically
 *    identify on hand-off.
 *  - Runes carry over verbatim via toObject() (`system.runes.*` for
 *    weapons, armor, shields). No special handling needed.
 *  - Cascade transfer for containers:
 *      1. BFS the source subtree (root + every descendant whose
 *         `system.containerId` chains back to root).
 *      2. Pre-generate destination ids via `foundry.utils.randomID()`
 *         for every subtree node, building the oldId → newId map
 *         BEFORE create. This is required because Foundry's
 *         `createEmbeddedDocuments` does NOT preserve input order in
 *         its returned array: probe 7 v0 fed payloads in subtree-BFS
 *         order [outer, inner, potion] and received back ids in the
 *         order [outer, potion, inner], which corrupted positional
 *         oldId → newId mapping and produced a tree where potion
 *         contained inner.
 *      3. Build each payload with `_id` set to its pre-generated id
 *         AND `system.containerId` wired to the parent's pre-generated
 *         id (or `destinationContainerId` for the root). Pass
 *         `{ keepId: true }` to preserve the ids through create.
 *      4. Delete source subtree in ONE `deleteEmbeddedDocuments` call.
 *    Two Foundry round-trips total regardless of subtree size. After
 *    create, every pre-generated id is verified present on destination
 *    as a defense against PF2e or a 3rd-party module rewriting an
 *    `_id` at `_preCreate` time.
 *  - Bulk-delete of the entire subtree avoids triggering PF2e's
 *    container `_preDelete` eject-to-root logic: when a container is in
 *    the delete batch alongside all its children, there are no surviving
 *    children to eject. Probe 6 verifies — if Foundry processes the
 *    delete batch sequentially internally and the eject fires anyway,
 *    we'll see drifted containerId state and fall back to pre-clearing
 *    every non-root subtree item's containerId before delete.
 *  - Cascade transfer is full-stack only. Partial-quantity on a backpack
 *    is rejected (SPLIT_ON_CONTAINER) — backpacks have qty 1 by
 *    convention, and "split half a backpack" is semantically nonsense.
 *  - `flags.pf2e.grantedBy.id` on a subtree item that grants a parent
 *    NOT in the subtree produces a broken-link warning. The flag itself
 *    is left intact on the destination — PF2e's cascade-delete is
 *    parent-rule-driven, so a dangling child-side flag is harmless, and
 *    third-party modules might still find the data useful. Probe 9
 *    captures this case.
 *  - No cycle detection is needed: cross-actor moves can't form cycles
 *    on the destination because the transferred items receive fresh
 *    ids that the user could not have referenced in
 *    `destinationContainerId`. The destination container is validated
 *    for type-is-backpack the same way `move_item_to_container` does.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface TransferItemBetweenActorsInput {
  sourceActorId: string;
  destinationActorId: string;
  itemId: string;
  destinationContainerId: string | null;
  /** null = full stack; integer ≥ 1 = split N off the source. */
  quantity: number | null;
  merge: 'auto' | 'never';
}

export interface TransferCreatedItem {
  oldId: string;
  newId: string;
  name: string;
  type: string;
  quantity: number;
  containerIdAfter: string | null;
}

export interface TransferMergedInto {
  id: string;
  name: string;
  type: string;
  previousQuantity: number;
  newQuantity: number;
  addedQuantity: number;
  containerId: string | null;
}

export interface TransferSourceDecremented {
  id: string;
  name: string;
  type: string;
  qtyBefore: number;
  qtyAfter: number;
}

export interface TransferCascadeDescendant {
  oldId: string;
  newId: string;
  name: string;
  type: string;
  quantity: number;
  containerIdAfter: string;
}

export interface TransferBrokenGrantLink {
  id: string;
  name: string;
  grantedBy: string;
}

export type TransferItemBetweenActorsOk =
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'transferred';
      item: TransferCreatedItem;
      warnings?: string[];
      brokenGrantLinks?: TransferBrokenGrantLink[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'transferredAndMerged';
      sourceDeletedId: string;
      mergedInto: TransferMergedInto;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'split';
      sourceItem: TransferSourceDecremented;
      created: TransferCreatedItem;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'splitAndMerged';
      sourceItem: TransferSourceDecremented;
      mergedInto: TransferMergedInto;
      warnings?: string[];
    }
  | {
      ok: true;
      sourceActor: { id: string; name: string };
      destinationActor: { id: string; name: string };
      operation: 'cascadeTransferred';
      root: TransferCreatedItem;
      descendants: TransferCascadeDescendant[];
      warnings?: string[];
      brokenGrantLinks?: TransferBrokenGrantLink[];
    };

export interface TransferItemBetweenActorsErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type TransferItemBetweenActorsResult =
  | TransferItemBetweenActorsOk
  | TransferItemBetweenActorsErr;

/** Physical inventory item types this tool will transfer. Exported for the
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

export async function transferItemBetweenActorsBody(
  input: TransferItemBetweenActorsInput,
): Promise<TransferItemBetweenActorsResult> {
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
  const CHOICE_SET_KEY = 'ChoiceSet';

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
    toObject(): AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
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
    details: Record<string, unknown>,
  ): TransferItemBetweenActorsErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

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

  const containerIdOf = (item: ItemDocLike): string | null => {
    const raw = (item.system as AnyRecord | undefined)?.containerId;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return null;
  };

  const qtyOf = (item: ItemDocLike): number => {
    const q = (item.system as AnyRecord | undefined)?.quantity;
    return typeof q === 'number' && Number.isFinite(q) ? q : 1;
  };

  const identificationStatusOf = (item: ItemDocLike): 'identified' | 'unidentified' => {
    const ident = (item.system as AnyRecord | undefined)?.identification as
      | AnyRecord
      | undefined;
    return ident?.status === 'unidentified' ? 'unidentified' : 'identified';
  };

  const sourceUuidOf = (item: ItemDocLike): string | null => {
    const raw = item._stats?.compendiumSource;
    return typeof raw === 'string' ? raw : null;
  };

  // Mutate a toObject() payload so the destination actor receives a
  // stowed, hands-free, not-in-slot item. We never want a transferred
  // weapon to land "wielded" or armor to land "worn in slot" because
  // the destination character has done nothing to put it there.
  const resetEquippedInPayload = (payload: AnyRecord): void => {
    const sys = (payload.system as AnyRecord | undefined) ?? {};
    if (typeof sys.equipped !== 'object' || sys.equipped === null) return;
    const equipped = sys.equipped as AnyRecord;
    const next: AnyRecord = { ...equipped };
    next.carryType = 'stowed';
    if ('handsHeld' in equipped) next.handsHeld = 0;
    if ('inSlot' in equipped) next.inSlot = false;
    payload.system = { ...sys, equipped: next };
  };

  // -- Validate quantity input shape (zod normalizes but defend here too).
  if (input.quantity !== null) {
    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1
    ) {
      return fail(
        `quantity must be a positive integer or null (full stack), got: ${String(input.quantity)}`,
        { quantity: input.quantity, reason: 'INVALID_QUANTITY' },
      );
    }
  }

  // -- Reject same-actor.
  if (input.sourceActorId === input.destinationActorId) {
    return fail(
      `sourceActorId and destinationActorId are the same actor (${input.sourceActorId}). ` +
        `Use move_item_to_container for same-actor moves.`,
      { actorId: input.sourceActorId, reason: 'TRANSFER_TO_SAME_ACTOR' },
    );
  }

  // -- Resolve actors.
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const sourceActor = game?.actors?.get(input.sourceActorId);
  if (!sourceActor) {
    return fail(`No actor found for sourceActorId: ${input.sourceActorId}`, {
      sourceActorId: input.sourceActorId,
      which: 'source',
      reason: 'ACTOR_NOT_FOUND',
    });
  }
  const destinationActor = game?.actors?.get(input.destinationActorId);
  if (!destinationActor) {
    return fail(`No actor found for destinationActorId: ${input.destinationActorId}`, {
      destinationActorId: input.destinationActorId,
      which: 'destination',
      reason: 'ACTOR_NOT_FOUND',
    });
  }

  // -- Resolve target item on source.
  const target = sourceActor.items?.get?.(input.itemId);
  if (!target || typeof target.id !== 'string' || target.id.length === 0) {
    return fail(
      `No item found on source actor ${sourceActor.id ?? input.sourceActorId} for itemId: ${input.itemId}`,
      {
        sourceActorId: input.sourceActorId,
        itemId: input.itemId,
        reason: 'ITEM_NOT_FOUND_ON_ACTOR',
      },
    );
  }
  const targetId: string = target.id;

  const targetType: string = typeof target.type === 'string' ? target.type : '';
  if (!PHYSICAL_ITEM_TYPES.has(targetType)) {
    return fail(
      `transfer_item_between_actors requires a physical item type; this item is '${targetType}'. ` +
        `Non-physical items (feats, actions, spells, ancestries, etc.) do not move between actors ` +
        `this way. Physical types: ${PHYSICAL_TYPES_LIST}. Use foundry_eval if you need to ` +
        `manipulate non-physical items.`,
      { itemId: input.itemId, type: targetType, reason: 'TRANSFER_ON_NON_PHYSICAL' },
    );
  }

  // -- Resolve / validate destination container.
  let destinationContainer: ItemDocLike | null = null;
  if (input.destinationContainerId !== null) {
    destinationContainer =
      destinationActor.items?.get?.(input.destinationContainerId) ?? null;
    if (!destinationContainer) {
      return fail(
        `No item found on destination actor ${destinationActor.id ?? input.destinationActorId} ` +
          `for destinationContainerId: ${input.destinationContainerId}`,
        {
          destinationActorId: input.destinationActorId,
          destinationContainerId: input.destinationContainerId,
          reason: 'CONTAINER_NOT_FOUND',
        },
      );
    }
    const containerType =
      typeof destinationContainer.type === 'string' ? destinationContainer.type : '';
    if (containerType !== 'backpack') {
      return fail(
        `Item with destinationContainerId ${input.destinationContainerId} is type ` +
          `'${containerType}', not a container (expected type 'backpack'). Foundry does not ` +
          `enforce this — setting containerId to a non-container id would persist and corrupt ` +
          `the destination actor's inventory tree.`,
        {
          destinationContainerId: input.destinationContainerId,
          type: containerType,
          reason: 'TARGET_NOT_CONTAINER',
        },
      );
    }
  }

  // -- Mode selection.
  const targetIsBackpack = targetType === 'backpack';
  const targetQty = qtyOf(target);

  if (input.quantity !== null) {
    if (targetIsBackpack) {
      return fail(
        `Cannot split a backpack — partial-quantity transfer requires a stackable item. ` +
          `Backpacks have unique identity in their contents. Drop the quantity parameter to ` +
          `transfer the whole container (with its contents) via the cascade path.`,
        { itemId: target.id, type: targetType, reason: 'SPLIT_ON_CONTAINER' },
      );
    }
    if (input.quantity > targetQty) {
      return fail(
        `Requested quantity ${input.quantity} exceeds available ${targetQty} on source item ` +
          `${target.id}. Reduce quantity, or omit it to transfer the entire stack.`,
        {
          requested: input.quantity,
          available: targetQty,
          itemId: target.id,
          reason: 'INVALID_QUANTITY',
        },
      );
    }
  }

  // Mode: 'cascade' for backpack-no-quantity, 'split' for partial-qty <
  // current, 'full' for everything else (full stack including
  // quantity===current).
  let mode: 'cascade' | 'split' | 'full';
  if (input.quantity === null && targetIsBackpack) {
    mode = 'cascade';
  } else if (input.quantity !== null && input.quantity < targetQty) {
    mode = 'split';
  } else {
    mode = 'full';
  }

  // -- ChoiceSet scan.
  //
  // For full/split modes: scan just the target. For cascade: scan every
  // subtree item. ChoiceSet on a physical item in PF2e 8.1.2 is a
  // forward-compat concern (third-party modules) — the natural-data
  // path doesn't exercise it.
  const hasChoiceSetRule = (item: ItemDocLike): boolean => {
    const rules = (item.system as AnyRecord | undefined)?.rules;
    if (!Array.isArray(rules)) return false;
    for (const rule of rules) {
      if (rule && typeof rule === 'object' && (rule as AnyRecord).key === CHOICE_SET_KEY) {
        return true;
      }
    }
    return false;
  };

  // -- BFS the source subtree (cascade) or just wrap target (full/split).
  //
  // Each node captures: oldId, originalContainerId (before any payload
  // mutation), name/type for the response, and the toObject() payload.
  interface SubtreeNode {
    oldId: string;
    originalContainerId: string | null;
    name: string;
    type: string;
    quantity: number;
    payload: AnyRecord;
    flags: AnyRecord;
  }

  const captureNode = (item: ItemDocLike): SubtreeNode => ({
    oldId: item.id ?? '',
    originalContainerId: containerIdOf(item),
    name: identifiedName(item),
    type: typeof item.type === 'string' ? item.type : '',
    quantity: qtyOf(item),
    payload: item.toObject(),
    flags: ((item.flags as AnyRecord | undefined) ?? {}) as AnyRecord,
  });

  const rootNode: SubtreeNode = captureNode(target);
  const subtree: SubtreeNode[] = [rootNode];
  const subtreeIds = new Set<string>();
  subtreeIds.add(targetId);

  if (mode === 'cascade') {
    // Iterative BFS: while there are nodes whose children we haven't
    // expanded yet, walk source actor's items and pick up any whose
    // containerId points at a node already in the subtree set.
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
        if (containerIdOf(candidate) !== parentId) continue;
        subtree.push(captureNode(candidate));
        subtreeIds.add(candidate.id);
      }
      safety += 1;
      if (safety > 4096) break; // pathological-data safety net
    }
  }

  // ChoiceSet check across the (single-node or subtree) batch.
  for (const node of subtree) {
    const sourceItem = sourceActor.items?.get?.(node.oldId);
    if (sourceItem && hasChoiceSetRule(sourceItem)) {
      return fail(
        `Item ${node.oldId} (${node.name}) has a ChoiceSet rule and cannot be transferred ` +
          `(its cascade would block on a selection dialog in headless context). Use foundry_eval ` +
          `to handle the choice manually.`,
        { itemId: node.oldId, reason: 'CHOICE_SET' },
      );
    }
  }

  // Broken grant link detection: any subtree item whose
  // flags.pf2e.grantedBy.id points at an item NOT in the subtree.
  const brokenGrantLinks: TransferBrokenGrantLink[] = [];
  for (const node of subtree) {
    const pf2eFlags = (node.flags.pf2e as AnyRecord | undefined) ?? {};
    const grantedBy = pf2eFlags.grantedBy as AnyRecord | undefined;
    const grantedById = grantedBy?.id;
    if (typeof grantedById !== 'string' || grantedById.length === 0) continue;
    if (subtreeIds.has(grantedById)) continue;
    brokenGrantLinks.push({
      id: node.oldId,
      name: node.name,
      grantedBy: grantedById,
    });
  }

  // -- Merge candidate lookup (full & split only; never for cascade).
  //
  // Identity: same compendium source (non-null), same destination
  // containerId (null counts), same identification status. Excludes
  // containers. Target itself is on a different actor so id collisions
  // aren't possible.
  const findMergeCandidate = (): { match: ItemDocLike | null; multiple: boolean } => {
    if (mode === 'cascade') return { match: null, multiple: false };
    if (input.merge !== 'auto') return { match: null, multiple: false };
    if (targetIsBackpack) return { match: null, multiple: false };
    const targetSource = sourceUuidOf(target);
    if (targetSource === null) return { match: null, multiple: false };
    const targetStatus = identificationStatusOf(target);
    let first: ItemDocLike | null = null;
    let count = 0;
    for (const candidate of destinationActor.items?.contents ?? []) {
      if (!candidate || !candidate.id) continue;
      const candidateType = typeof candidate.type === 'string' ? candidate.type : '';
      if (candidateType === 'backpack') continue;
      const candidateSource = sourceUuidOf(candidate);
      if (candidateSource !== targetSource) continue;
      const candidateContainer = containerIdOf(candidate);
      if (candidateContainer !== input.destinationContainerId) continue;
      const candidateStatus = identificationStatusOf(candidate);
      if (candidateStatus !== targetStatus) continue;
      if (!first) first = candidate;
      count += 1;
    }
    return { match: first, multiple: count > 1 };
  };

  const mergeLookup = findMergeCandidate();
  const warnings: string[] = [];
  if (mergeLookup.multiple) {
    warnings.push(
      `Multiple existing stacks on destination matched the merge identity (same source, ` +
        `container, identification). Merged into the first; the others were left untouched.`,
    );
  }

  // -- Common payload builder (root-only or full subtree).
  //
  // Strips _id (Foundry assigns fresh), pre-flattens containerId to
  // null (remapped after create for the cascade case), resets the
  // equipped state, and optionally adjusts quantity for the split path.
  const buildPayload = (
    node: SubtreeNode,
    isRoot: boolean,
    overrideQuantity: number | null,
    overrideRootContainerId: string | null,
  ): AnyRecord => {
    const data: AnyRecord = { ...node.payload };
    delete (data as { _id?: unknown })._id;
    const sys: AnyRecord = {
      ...((data.system as AnyRecord | undefined) ?? {}),
    };
    // Always pre-flatten to null; cascade remap fixes children up
    // afterwards. For non-cascade (subtree size 1, isRoot true), set
    // root's containerId directly so we can skip the remap step.
    if (isRoot) {
      sys.containerId = overrideRootContainerId;
      if (overrideQuantity !== null) sys.quantity = overrideQuantity;
    } else {
      sys.containerId = null;
    }
    data.system = sys;
    resetEquippedInPayload(data);
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

  // -- Execute by mode.

  // SPLIT path.
  if (mode === 'split') {
    const quantity = input.quantity as number;
    const qtyBefore = targetQty;
    const qtyAfter = qtyBefore - quantity;

    if (
      mergeLookup.match &&
      typeof mergeLookup.match.id === 'string' &&
      mergeLookup.match.id.length > 0
    ) {
      const match = mergeLookup.match;
      const matchId: string = mergeLookup.match.id;
      const matchQtyBefore = qtyOf(match);
      const matchQtyAfter = matchQtyBefore + quantity;
      // Destination first, then source decrement.
      await destinationActor.updateEmbeddedDocuments('Item', [
        { _id: matchId, 'system.quantity': matchQtyAfter },
      ]);
      await sourceActor.updateEmbeddedDocuments('Item', [
        { _id: targetId, 'system.quantity': qtyAfter },
      ]);
      const result: TransferItemBetweenActorsOk = {
        ok: true,
        sourceActor: sourceActorEcho,
        destinationActor: destinationActorEcho,
        operation: 'splitAndMerged',
        sourceItem: {
          id: targetId,
          name: identifiedName(target),
          type: targetType,
          qtyBefore,
          qtyAfter,
        },
        mergedInto: {
          id: matchId,
          name: identifiedName(match),
          type: typeof match.type === 'string' ? match.type : '',
          previousQuantity: matchQtyBefore,
          newQuantity: matchQtyAfter,
          addedQuantity: quantity,
          containerId: input.destinationContainerId,
        },
      };
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    }

    // No merge: create on dest with quantity=N, then decrement source.
    const payload = buildPayload(
      rootNode,
      true,
      quantity,
      input.destinationContainerId,
    );
    const createdArr = await destinationActor.createEmbeddedDocuments('Item', [payload]);
    const created = createdArr?.[0];
    if (!created || typeof created.id !== 'string' || created.id.length === 0) {
      return fail(
        `createEmbeddedDocuments on destination returned no document for itemId: ${targetId}`,
        { itemId: targetId, reason: 'CREATE_FAILED' },
      );
    }
    const createdId: string = created.id;
    await sourceActor.updateEmbeddedDocuments('Item', [
      { _id: targetId, 'system.quantity': qtyAfter },
    ]);
    const result: TransferItemBetweenActorsOk = {
      ok: true,
      sourceActor: sourceActorEcho,
      destinationActor: destinationActorEcho,
      operation: 'split',
      sourceItem: {
        id: targetId,
        name: identifiedName(target),
        type: targetType,
        qtyBefore,
        qtyAfter,
      },
      created: {
        oldId: targetId,
        newId: createdId,
        name: identifiedName(created),
        type: typeof created.type === 'string' ? created.type : targetType,
        quantity,
        containerIdAfter: input.destinationContainerId,
      },
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  // FULL path (single physical item, possibly stackable).
  if (mode === 'full') {
    if (
      mergeLookup.match &&
      typeof mergeLookup.match.id === 'string' &&
      mergeLookup.match.id.length > 0
    ) {
      const match = mergeLookup.match;
      const matchId: string = mergeLookup.match.id;
      const matchQtyBefore = qtyOf(match);
      const matchQtyAfter = matchQtyBefore + targetQty;
      await destinationActor.updateEmbeddedDocuments('Item', [
        { _id: matchId, 'system.quantity': matchQtyAfter },
      ]);
      await sourceActor.deleteEmbeddedDocuments('Item', [targetId]);
      const result: TransferItemBetweenActorsOk = {
        ok: true,
        sourceActor: sourceActorEcho,
        destinationActor: destinationActorEcho,
        operation: 'transferredAndMerged',
        sourceDeletedId: targetId,
        mergedInto: {
          id: matchId,
          name: identifiedName(match),
          type: typeof match.type === 'string' ? match.type : '',
          previousQuantity: matchQtyBefore,
          newQuantity: matchQtyAfter,
          addedQuantity: targetQty,
          containerId: input.destinationContainerId,
        },
      };
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    }

    // No merge: create on dest, delete on source.
    const payload = buildPayload(rootNode, true, null, input.destinationContainerId);
    const createdArr = await destinationActor.createEmbeddedDocuments('Item', [payload]);
    const created = createdArr?.[0];
    if (!created || typeof created.id !== 'string' || created.id.length === 0) {
      return fail(
        `createEmbeddedDocuments on destination returned no document for itemId: ${targetId}`,
        { itemId: targetId, reason: 'CREATE_FAILED' },
      );
    }
    const createdId: string = created.id;
    await sourceActor.deleteEmbeddedDocuments('Item', [targetId]);
    const result: TransferItemBetweenActorsOk = {
      ok: true,
      sourceActor: sourceActorEcho,
      destinationActor: destinationActorEcho,
      operation: 'transferred',
      item: {
        oldId: targetId,
        newId: createdId,
        name: identifiedName(created),
        type: typeof created.type === 'string' ? created.type : targetType,
        quantity: qtyOf(created),
        containerIdAfter: input.destinationContainerId,
      },
    };
    if (warnings.length > 0) result.warnings = warnings;
    if (brokenGrantLinks.length > 0) result.brokenGrantLinks = brokenGrantLinks;
    return result;
  }

  // CASCADE path.
  //
  // Foundry's `createEmbeddedDocuments` returns its array in *some*
  // order — internally Foundry may rearrange the result (sort key,
  // hook ordering, etc.) so a positional oldId → newId mapping based
  // on the returned array is NOT safe. Verified empirically: feeding
  // [outer, inner, potion] payloads into Foundry returned them with
  // ids in the order [outer, potion, inner], which corrupted the
  // containerId remap in v0.
  //
  // Fix: pre-generate ids via `foundry.utils.randomID()` and pass
  // `keepId: true`. Then we know each subtree node's new id BEFORE
  // create runs, can wire `system.containerId` into the payload
  // directly, and don't need a post-create remap. Three Foundry
  // operations become two (create + delete).
  const foundryUtils = (
    globalThis as unknown as { foundry?: { utils?: FoundryUtilsLike } }
  ).foundry?.utils;
  const randomID = foundryUtils?.randomID;
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
    let resolvedContainerId: string | null;
    if (idx === 0) {
      resolvedContainerId = input.destinationContainerId;
    } else {
      const originalParent = node.originalContainerId;
      resolvedContainerId = originalParent
        ? oldToNew.get(originalParent) ?? null
        : null;
    }
    const data: AnyRecord = { ...node.payload };
    data._id = newId;
    const sys: AnyRecord = { ...((data.system as AnyRecord | undefined) ?? {}) };
    sys.containerId = resolvedContainerId;
    data.system = sys;
    resetEquippedInPayload(data);
    return data;
  });

  const createdDocs = await destinationActor.createEmbeddedDocuments('Item', payloads, {
    keepId: true,
  });
  if (!Array.isArray(createdDocs) || createdDocs.length !== subtree.length) {
    return fail(
      `createEmbeddedDocuments on destination returned ${
        Array.isArray(createdDocs) ? createdDocs.length : 'no'
      } documents for a subtree of ${subtree.length} items.`,
      {
        subtreeSize: subtree.length,
        returned: Array.isArray(createdDocs) ? createdDocs.length : null,
        reason: 'CREATE_FAILED',
      },
    );
  }
  // Verify every pre-generated id landed (defensive — PF2e or Foundry
  // could in principle rewrite an _id at _preCreate time).
  for (const node of subtree) {
    const expected = oldToNew.get(node.oldId);
    if (!expected || !destinationActor.items?.get?.(expected)) {
      return fail(
        `Pre-generated id ${expected ?? '?'} (oldId ${node.oldId}) is missing on destination ` +
          `after create — Foundry or PF2e rewrote the _id, breaking the cascade tree shape.`,
        { oldId: node.oldId, expectedNewId: expected ?? null, reason: 'CREATE_FAILED' },
      );
    }
  }

  // Delete the source subtree.
  const sourceSubtreeIds = subtree.map((n) => n.oldId);
  await sourceActor.deleteEmbeddedDocuments('Item', sourceSubtreeIds);

  // Build response. Look up the created docs again to surface
  // post-update state (containerId reflects the remap).
  const rootNewId = oldToNew.get(targetId);
  if (!rootNewId) {
    return fail(
      `Internal: root oldId ${targetId} missing from oldToNew map post-create.`,
      { itemId: targetId, reason: 'CREATE_FAILED' },
    );
  }
  const rootCreated = destinationActor.items?.get?.(rootNewId);
  const root: TransferCreatedItem = {
    oldId: targetId,
    newId: rootNewId,
    name: rootCreated ? identifiedName(rootCreated) : identifiedName(target),
    type: targetType,
    quantity: rootCreated ? qtyOf(rootCreated) : targetQty,
    containerIdAfter: input.destinationContainerId,
  };

  const descendants: TransferCascadeDescendant[] = [];
  for (let i = 1; i < subtree.length; i++) {
    const node = subtree[i];
    if (!node) continue;
    const newId = oldToNew.get(node.oldId);
    if (!newId) continue;
    const liveItem = destinationActor.items?.get?.(newId);
    const parentNewId = node.originalContainerId
      ? oldToNew.get(node.originalContainerId) ?? ''
      : '';
    descendants.push({
      oldId: node.oldId,
      newId,
      name: liveItem ? identifiedName(liveItem) : node.name,
      type: node.type,
      quantity: liveItem ? qtyOf(liveItem) : node.quantity,
      containerIdAfter: parentNewId,
    });
  }

  const result: TransferItemBetweenActorsOk = {
    ok: true,
    sourceActor: sourceActorEcho,
    destinationActor: destinationActorEcho,
    operation: 'cascadeTransferred',
    root,
    descendants,
  };
  if (warnings.length > 0) result.warnings = warnings;
  if (brokenGrantLinks.length > 0) result.brokenGrantLinks = brokenGrantLinks;
  return result;
}
