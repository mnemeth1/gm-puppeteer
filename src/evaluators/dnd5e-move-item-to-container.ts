/**
 * page.evaluate body for `dnd5e_move_item_to_container`. Relocates an
 * existing physical item on a D&D 5e actor into a different container on
 * the SAME actor, or to the inventory root (`containerId: null`). D&D 5e
 * sibling of `pf2e_move_item_to_container`; the same-actor cousin of
 * `dnd5e_transfer_item_between_actors`.
 *
 * Behavior nuances confirmed by
 * scripts/probe-dnd5e-inventory-graph-phase1.mjs and
 * scripts/probe-dnd5e-move-item-to-container.mjs against Foundry v14.361 +
 * dnd5e 5.3.3. The 5e schema differs from PF2e — no field path is ported
 * on faith:
 *
 *  - **Container field is `system.container`** — a bare item-id string, or
 *    literally `null` at inventory root (probe Q1: `typeof === 'object'`,
 *    `=== null`, never `""` or absent). The 5e analogue of PF2e's
 *    `system.containerId`. A container item is `type: "container"` (NOT
 *    PF2e's `backpack`).
 *
 *  - `updateEmbeddedDocuments("Item", [{_id, "system.container": v}])` is
 *    the exclusive write path. Probe Q2: a move drifts ONLY
 *    `system.container` — no parallel field updates needed.
 *
 *  - Setting `system.container` to its current value is a clean no-op
 *    (probe Q3: `updateEmbeddedDocuments` returns `[]`, does NOT throw).
 *    The tool surfaces this via `containerBefore === containerAfter` in
 *    the response — no separate `noop` flag (mirrors the PF2e sibling).
 *
 *  - **Cycle detection is entirely the tool's responsibility.** Probe Q4
 *    found 5e ACCEPTS and persists an exact self-cycle (`A.container = A`)
 *    — unlike PF2e, which clamps depth-1 self-cycles to null. Probe Q5
 *    found 5e also accepts depth-2+ cycles (`A→B`, then `B→A` persists).
 *    Foundry enforces only the storage-layer schema, not graph shape, so
 *    this tool rejects a move up-front when `containerId` equals the
 *    target id (self-cycle) or when the target is reachable as an
 *    ancestor of the destination container (deeper cycle), walking the
 *    destination's ancestor chain via `system.container`.
 *
 *  - **CONTAINER_TYPE_INVALID is the tool's responsibility.** Probe Q6
 *    found Foundry accepts a `system.container` pointing at a
 *    non-container item (e.g. a weapon's id) and persists it. The tool
 *    rejects up-front when the destination item's `type !== 'container'`.
 *
 *  - Moving a container with contents leaves the contents inside it —
 *    their `system.container` references are unaffected by the parent's
 *    move (probe Q7). No cascade work needed for a same-actor move.
 *
 *  - **Identification is `system.identified`** — a bare boolean (defaults
 *    `true`; explicit `false` only on unidentified loot). For an
 *    unidentified item, dnd5e's `Item5e#name` getter returns the MASKED
 *    name; this tool reports `item.name` verbatim — the displayed name —
 *    consistent with `dnd5e_add_item_to_actor` /
 *    `dnd5e_remove_item_from_actor`, and a deliberate divergence from the
 *    PF2e sibling (which resolves the canonical identified name).
 *
 *  - Merge identity matches `dnd5e_add_item_to_actor`: same
 *    `_stats.compendiumSource` + same destination `system.container` +
 *    same `system.identified`. When `merge: "auto"` and a match exists,
 *    the source item's quantity folds into the matching sibling and the
 *    source item is deleted. Containers (`type: "container"`) are excluded
 *    from the merge path — two containers carry identity in their
 *    contents and never merge.
 *
 *  - **Actor type support.** `character`, `npc` — same set as the rest of
 *    the dnd5e tool family. `vehicle` / `group` / `encounter` are
 *    rejected with ACTOR_TYPE_UNSUPPORTED. 5e has no `familiar` actor
 *    type. (The PF2e sibling has no actor-type gate; this gate mirrors
 *    the dnd5e family.)
 *
 * No quantity input — partial-stack moves (split-and-move) are out of
 * scope; compose `dnd5e_update_item_quantity` + `dnd5e_add_item_to_actor`.
 * No `destinationActorId` — cross-actor transfer is
 * `dnd5e_transfer_item_between_actors`.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface Dnd5eMoveItemToContainerInput {
  actorId: string;
  itemId: string;
  containerId: string | null;
  merge: 'auto' | 'never';
}

export interface Dnd5eMoveItemToContainerMovedItem {
  id: string;
  name: string;
  type: string;
  quantity: number;
  /** Owning container's item id before the move, or `null` (root). */
  containerBefore: string | null;
  /** Owning container's item id after the move, or `null` (root). */
  containerAfter: string | null;
}

export interface Dnd5eMoveItemToContainerMergedInto {
  id: string;
  name: string;
  type: string;
  previousQuantity: number;
  newQuantity: number;
  addedQuantity: number;
  /** The merged-into stack's container, or `null` (root). */
  container: string | null;
}

export type Dnd5eMoveItemToContainerOk =
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'moved';
      item: Dnd5eMoveItemToContainerMovedItem;
      warnings?: string[];
    }
  | {
      ok: true;
      actor: { id: string; name: string };
      operation: 'merged';
      mergedInto: Dnd5eMoveItemToContainerMergedInto;
      warnings?: string[];
    };

export interface Dnd5eMoveItemToContainerErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'ITEM_NOT_FOUND_ON_ACTOR'
        | 'NON_PHYSICAL_ITEM'
        | 'CONTAINER_NOT_FOUND'
        | 'CONTAINER_TYPE_INVALID'
        | 'CYCLE_DETECTED';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eMoveItemToContainerResult =
  | Dnd5eMoveItemToContainerOk
  | Dnd5eMoveItemToContainerErr;

/** Actor types this tool will mutate. Mirrors dnd5e_add_item_to_actor's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

/**
 * The D&D 5e physical-inventory item types this tool will move. Exported
 * for the tool layer's user-facing error message; the evaluator
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

export async function dnd5eMoveItemToContainerBody(
  input: Dnd5eMoveItemToContainerInput,
): Promise<Dnd5eMoveItemToContainerResult> {
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
    details: Dnd5eMoveItemToContainerErr['error']['details'],
  ): Dnd5eMoveItemToContainerErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // Verbatim displayed name (NOT the PF2e canonical-identified resolver).
  const nameOf = (item: ItemDocLike): string =>
    typeof item.name === 'string' ? item.name : '';

  const typeOf = (item: ItemDocLike): string =>
    typeof item.type === 'string' ? item.type : '';

  // Normalize `system.container` to a single shape: a non-empty string
  // (the owning container's id) or `null` (item at inventory root).
  const containerOf = (item: ItemDocLike): string | null => {
    const raw = (item.system as AnyRecord | undefined)?.container;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  const qtyOf = (item: ItemDocLike): number => {
    const q = (item.system as AnyRecord | undefined)?.quantity;
    return typeof q === 'number' && Number.isFinite(q) ? q : 1;
  };

  // `system.identified` defaults true; explicit false only on mystery loot.
  const identifiedOf = (item: ItemDocLike): boolean =>
    (item.system as AnyRecord | undefined)?.identified !== false;

  const sourceUuidOf = (item: ItemDocLike): string | null => {
    const raw = item._stats?.compendiumSource;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

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
      `Actor type '${actorType}' is not supported by dnd5e_move_item_to_container. ` +
        `Supported types: character, npc. (5e has no familiar actor type.)`,
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
  const targetId: string = target.id;
  const targetType = typeOf(target);

  if (!PHYSICAL.has(targetType)) {
    return fail(
      `dnd5e_move_item_to_container requires a physical item type; this item is '${targetType}'. ` +
        `Non-physical items (spells, feats, classes, backgrounds, races, etc.) have no ` +
        `\`system.container\` field — Foundry silently drops the update. Physical types: ` +
        `${PHYSICAL_TYPES_LIST}. Use foundry_eval to manipulate non-physical items.`,
      { reason: 'NON_PHYSICAL_ITEM', itemId: input.itemId, type: targetType },
    );
  }

  // -- Resolve / validate destination container (when non-null).
  let destinationContainer: ItemDocLike | null = null;
  if (input.containerId !== null) {
    destinationContainer = actor.items?.get?.(input.containerId) ?? null;
    if (!destinationContainer) {
      return fail(
        `No item found on actor ${actor.id ?? input.actorId} for containerId: ${input.containerId}`,
        { reason: 'CONTAINER_NOT_FOUND', actorId: input.actorId, containerId: input.containerId },
      );
    }
    const containerType = typeOf(destinationContainer);
    if (containerType !== 'container') {
      return fail(
        `Item with containerId ${input.containerId} is type '${containerType}', not a container ` +
          `(expected type 'container'). Foundry does not enforce this — setting system.container ` +
          `to a non-container id would persist and corrupt the actor's inventory tree.`,
        { reason: 'CONTAINER_TYPE_INVALID', containerId: input.containerId, type: containerType },
      );
    }
  }

  // -- Cycle detection. 5e accepts both self-cycles and deeper cycles
  // (probe Q4/Q5), so the tool walks the destination's ancestor chain
  // and rejects if `target` is the destination itself or is reachable as
  // an ancestor of the destination.
  if (input.containerId !== null && destinationContainer) {
    if (input.containerId === targetId) {
      return fail(`Cannot move item ${targetId} into itself (self-cycle).`, {
        reason: 'CYCLE_DETECTED',
        itemId: targetId,
        containerId: input.containerId,
      });
    }
    const visited = new Set<string>();
    let cursor: ItemDocLike | null = destinationContainer;
    let cycleHit = false;
    let depth = 0;
    while (cursor) {
      if (!cursor.id) break;
      if (visited.has(cursor.id)) break; // pre-existing cycle in actor data; bail
      visited.add(cursor.id);
      if (cursor.id === targetId) {
        cycleHit = true;
        break;
      }
      const parentId = containerOf(cursor);
      if (parentId === null) break;
      cursor = actor.items?.get?.(parentId) ?? null;
      depth += 1;
      if (depth > 256) break; // pathological-data safety net
    }
    if (cycleHit) {
      return fail(
        `Cannot move item ${targetId} into container ${input.containerId} — that would make the ` +
          `item its own ancestor (cycle). Move the destination container out first, or pick a ` +
          `different container.`,
        { reason: 'CYCLE_DETECTED', itemId: targetId, containerId: input.containerId },
      );
    }
  }

  // -- Capture before-state.
  const containerBefore = containerOf(target);
  const targetQty = qtyOf(target);
  const targetSource = sourceUuidOf(target);
  const targetIdentified = identifiedOf(target);

  // -- Merge candidate lookup (auto only; never for containers).
  //
  // Identity matches dnd5e_add_item_to_actor: same compendium source
  // (non-null) + same destination container (null counts) + same
  // identification status. The source item is excluded by id. If
  // multiple match, the first is used and a warning is surfaced.
  const warnings: string[] = [];
  let mergeMatch: ItemDocLike | null = null;
  if (input.merge === 'auto' && targetSource !== null && targetType !== 'container') {
    let count = 0;
    for (const candidate of actor.items?.contents ?? []) {
      if (!candidate || !candidate.id || candidate.id === targetId) continue;
      if (typeOf(candidate) === 'container') continue;
      if (sourceUuidOf(candidate) !== targetSource) continue;
      if (containerOf(candidate) !== input.containerId) continue;
      if (identifiedOf(candidate) !== targetIdentified) continue;
      if (!mergeMatch) mergeMatch = candidate;
      count += 1;
    }
    if (count > 1) {
      warnings.push(
        `Multiple existing stacks matched the merge identity (same source, container, ` +
          `identification). Merged into the first; the others were left untouched.`,
      );
    }
  }

  // -- Merge path: fold the source's quantity into the matching sibling,
  // delete the source.
  if (mergeMatch && mergeMatch.id) {
    const matchId: string = mergeMatch.id;
    const previousQuantity = qtyOf(mergeMatch);
    const newQuantity = previousQuantity + targetQty;
    await actor.updateEmbeddedDocuments('Item', [
      { _id: matchId, 'system.quantity': newQuantity },
    ]);
    await actor.deleteEmbeddedDocuments('Item', [targetId]);
    const merged: Dnd5eMoveItemToContainerOk = {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'merged',
      mergedInto: {
        id: matchId,
        name: nameOf(mergeMatch),
        type: typeOf(mergeMatch),
        previousQuantity,
        newQuantity,
        addedQuantity: targetQty,
        container: input.containerId,
      },
    };
    if (warnings.length > 0) merged.warnings = warnings;
    return merged;
  }

  // -- Plain move path. Same-destination is a clean no-op at Foundry's
  // document layer (probe Q3); surfaced via containerBefore === containerAfter.
  await actor.updateEmbeddedDocuments('Item', [
    { _id: targetId, 'system.container': input.containerId },
  ]);
  const moved: Dnd5eMoveItemToContainerOk = {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'moved',
    item: {
      id: targetId,
      name: nameOf(target),
      type: targetType,
      quantity: targetQty,
      containerBefore,
      containerAfter: input.containerId,
    },
  };
  if (warnings.length > 0) moved.warnings = warnings;
  return moved;
}
