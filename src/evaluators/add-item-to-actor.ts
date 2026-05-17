/**
 * page.evaluate body for pf2e_add_item_to_actor. Grants a physical item from a
 * compendium source to a world actor. Handles quantity, container
 * placement, identification status, and stack-merging that emulates the
 * Foundry UI's drag-to-merge behavior.
 *
 * Behavior nuances confirmed by scripts/probe-add-item-to-actor.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *  - `actor.createEmbeddedDocuments("Item", [data])` accepts a `toObject()`
 *    payload directly. The input's `_id` is stripped and a fresh one is
 *    assigned. The returned document's `_stats.compendiumSource` is
 *    automatically populated with the source UUID.
 *  - PF2e does NOT auto-merge stacks on create. Adding 5 arrows via
 *    `createEmbeddedDocuments` to an actor with an existing 20-arrow stack
 *    produces two separate entries (20 + 5), not one merged entry of 25.
 *    The Foundry UI auto-merges on drop; the underlying API does not. The
 *    tool implements merge explicitly: same `_stats.compendiumSource` +
 *    same `containerId` + same `identification.status` ⇒ merge by
 *    `actor.updateEmbeddedDocuments("Item", [{_id, "system.quantity": newQty}])`.
 *    Containers (`type === 'backpack'`) are excluded from the merge path
 *    — they carry identity in their contents, so two backpacks always
 *    create as separate entries.
 *  - PF2e fires `GrantItem` cascades on item creation. Cascade-children
 *    carry `flags.pf2e.grantedBy: {id: <parent item id>, onDelete: "cascade"}`.
 *    Deleting the parent auto-deletes the cascade-children. The tool
 *    surfaces these alongside the explicit grant.
 *  - `ChoiceSet` rules (Assurance asks "which skill?", Steel on Steel asks
 *    "which Ikon?") attempt to display a selection dialog. In the headless
 *    GM client this can hang the create operation. v1 rejects ChoiceSet
 *    sources up front.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface AddItemToActorInput {
  actorId: string;
  sourceUuid: string;
  quantity: number;
  containerId: string | null;
  identified: boolean;
  merge: 'auto' | 'never';
}

export interface AddItemToActorCreatedItem {
  id: string;
  uuid: string;
  name: string;
  type: string;
  quantity: number;
  containerId: string | null;
  identificationStatus: 'identified' | 'unidentified';
  sourceUuid: string;
}

export interface AddItemToActorCascadeEntry {
  id: string;
  uuid: string;
  name: string;
  type: string;
  grantedBy: string;
}

export interface AddItemToActorMergedInto {
  id: string;
  uuid: string;
  name: string;
  previousQuantity: number;
  newQuantity: number;
  addedQuantity: number;
  containerId: string | null;
}

export interface AddItemToActorOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'created' | 'merged';
  item?: AddItemToActorCreatedItem;
  cascadeGranted?: AddItemToActorCascadeEntry[];
  mergedInto?: AddItemToActorMergedInto;
  warnings?: string[];
}

export interface AddItemToActorErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type AddItemToActorResult = AddItemToActorOk | AddItemToActorErr;

/** Physical inventory item types this tool will grant. Exported for the
 * tool layer to reuse in the user-facing error message. */
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

declare function fromUuid(uuid: string): Promise<unknown>;

export async function addItemToActorBody(
  input: AddItemToActorInput,
): Promise<AddItemToActorResult> {
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
  const CHOICE_SET_KEY = 'ChoiceSet';
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
    toObject(): AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    items?: {
      contents?: ItemDocLike[];
      get?(id: string): ItemDocLike | undefined;
    };
    createEmbeddedDocuments(name: 'Item', data: AnyRecord[]): Promise<ItemDocLike[]>;
    updateEmbeddedDocuments(
      name: 'Item',
      data: Array<AnyRecord & { _id: string }>,
    ): Promise<ItemDocLike[]>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
  }

  const fail = (message: string, details: Record<string, unknown>): AddItemToActorErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // -- Validate quantity (input is already coerced by the tool layer to a
  // number, but defensive parse here too).
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1
  ) {
    return fail(`quantity must be an integer ≥ 1, got: ${String(input.quantity)}`, {
      quantity: input.quantity,
    });
  }

  // -- Resolve actor.
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, { actorId: input.actorId });
  }

  // -- Resolve source UUID.
  const source = (await fromUuid(input.sourceUuid)) as ItemDocLike | null;
  if (!source) {
    return fail(`No item found for sourceUuid: ${input.sourceUuid}`, {
      sourceUuid: input.sourceUuid,
    });
  }

  if (source.documentName !== 'Item') {
    return fail(
      `sourceUuid resolved to ${source.documentName ?? 'unknown'}, expected Item: ${input.sourceUuid}`,
      { sourceUuid: input.sourceUuid, documentName: source.documentName ?? null },
    );
  }

  // -- Reject actor-embedded item UUIDs. Cross-actor moves are a separate
  // operation with different semantics.
  if (input.sourceUuid.startsWith('Actor.')) {
    return fail(
      `sourceUuid must be a compendium Item UUID; got actor-embedded UUID: ${input.sourceUuid}. Cross-actor item moves are not yet supported.`,
      { sourceUuid: input.sourceUuid },
    );
  }

  const sourceType = typeof source.type === 'string' ? source.type : '';
  if (!PHYSICAL_ITEM_TYPES.has(sourceType)) {
    return fail(
      `sourceUuid points to a ${sourceType}; pf2e_add_item_to_actor handles physical inventory items only (${PHYSICAL_TYPES_LIST}). Use foundry_eval to grant non-physical items.`,
      { sourceUuid: input.sourceUuid, type: sourceType },
    );
  }

  // -- ChoiceSet rejection: PF2e ChoiceSet rules block on a selection
  // dialog that cannot be answered in headless context.
  //
  // Defensive forward-compat: in PF2e 8.1.2, every ChoiceSet-bearing item
  // in the SRD compendiums is a feat, so the natural-input path always
  // hits the physical-only type-rejection branch above before reaching
  // this check. The branch is kept in place for the case where PF2e (or
  // a third-party module) adds a ChoiceSet rule to a physical item in a
  // future release — see scripts/probe-add-item-to-actor.mjs probe 14.
  const rulesRaw = (source.system as AnyRecord | undefined)?.rules;
  if (Array.isArray(rulesRaw)) {
    let choiceSetCount = 0;
    for (const rule of rulesRaw) {
      if (rule && typeof rule === 'object' && (rule as AnyRecord).key === CHOICE_SET_KEY) {
        choiceSetCount += 1;
      }
    }
    if (choiceSetCount > 0) {
      return fail(
        `sourceUuid has a ChoiceSet rule and cannot be granted programmatically in v1 (its cascade would block on a selection dialog in headless context). Use foundry_eval to handle the choice manually.`,
        { sourceUuid: input.sourceUuid, choiceSetCount },
      );
    }
  }

  // -- Validate containerId (when provided).
  if (input.containerId !== null) {
    const containerItem = actor.items?.get?.(input.containerId);
    if (!containerItem) {
      return fail(`No item found on actor for containerId: ${input.containerId}`, {
        actorId: input.actorId,
        containerId: input.containerId,
      });
    }
    const containerType = typeof containerItem.type === 'string' ? containerItem.type : '';
    if (containerType !== 'backpack') {
      return fail(
        `Item with containerId ${input.containerId} is type ${containerType}, not a container.`,
        { containerId: input.containerId, type: containerType },
      );
    }
  }

  // -- Merge candidate lookup (auto only).
  //
  // findMergeCandidate: same compendium source + same containerId + same
  // identification status. If multiple match, return the first and surface
  // a warning.
  //
  // Containers (type='backpack') are excluded from the merge path entirely
  // — two containers are NOT interchangeable, they carry identity in their
  // contents, and Foundry's UI doesn't merge them either. Same exclusion
  // as in pf2e_move_item_to_container's merge logic. In practice this branch
  // is forward-compat: the source is always a fresh compendium import
  // with empty contents, but the response would still lie about merge vs.
  // create if a user granted a second backpack to an existing stack.
  const findMergeCandidate = (): { match: ItemDocLike | null; multiple: boolean } => {
    if (input.merge !== 'auto' || sourceType === 'backpack') {
      return { match: null, multiple: false };
    }
    let first: ItemDocLike | null = null;
    let count = 0;
    for (const candidate of actor.items?.contents ?? []) {
      if (!candidate || !candidate.id) continue;
      const csys = (candidate.system as AnyRecord | undefined) ?? {};
      const candidateSourceRaw = candidate._stats?.compendiumSource;
      const candidateSource = typeof candidateSourceRaw === 'string' ? candidateSourceRaw : null;
      if (candidateSource !== input.sourceUuid) continue;
      const candidateContainerRaw = csys.containerId;
      const candidateContainer =
        typeof candidateContainerRaw === 'string' && candidateContainerRaw.length > 0
          ? candidateContainerRaw
          : null;
      if (candidateContainer !== input.containerId) continue;
      const candidateIdent = csys.identification as AnyRecord | undefined;
      const candidateStatus =
        candidateIdent?.status === 'unidentified' ? 'unidentified' : 'identified';
      const desiredStatus = input.identified ? 'identified' : 'unidentified';
      if (candidateStatus !== desiredStatus) continue;
      if (!first) first = candidate;
      count += 1;
    }
    return { match: first, multiple: count > 1 };
  };

  const warnings: string[] = [];

  const candidateLookup = findMergeCandidate();
  if (candidateLookup.match) {
    const match = candidateLookup.match;
    const msys = (match.system as AnyRecord | undefined) ?? {};
    const previousQuantity =
      typeof msys.quantity === 'number' && Number.isFinite(msys.quantity) ? msys.quantity : 1;
    const newQuantity = previousQuantity + input.quantity;
    if (!match.id) {
      return fail(`Merge candidate has no id: ${match.uuid ?? '?'}`, {
        sourceUuid: input.sourceUuid,
      });
    }
    await actor.updateEmbeddedDocuments('Item', [
      { _id: match.id, 'system.quantity': newQuantity },
    ]);
    if (candidateLookup.multiple) {
      warnings.push(
        `Multiple existing stacks matched the merge identity (same source, container, identification). Merged into the first; the others were left untouched.`,
      );
    }
    const matchContainerRaw = msys.containerId;
    const matchContainer =
      typeof matchContainerRaw === 'string' && matchContainerRaw.length > 0
        ? matchContainerRaw
        : null;
    const result: AddItemToActorOk = {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'merged',
      mergedInto: {
        id: match.id,
        uuid: typeof match.uuid === 'string' ? match.uuid : '',
        name: typeof match.name === 'string' ? match.name : '',
        previousQuantity,
        newQuantity,
        addedQuantity: input.quantity,
        containerId: matchContainer,
      },
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  // -- Create path.
  const data = source.toObject();
  const sysObj = (data.system as AnyRecord | undefined) ?? {};
  const newSys: AnyRecord = { ...sysObj };
  newSys.quantity = input.quantity;
  if (input.containerId !== null) {
    newSys.containerId = input.containerId;
  } else {
    // Top-level placement: defensively null out any source-payload containerId.
    newSys.containerId = null;
  }
  if (!input.identified) {
    const sourceIdent = (sysObj.identification as AnyRecord | undefined) ?? {};
    newSys.identification = { ...sourceIdent, status: 'unidentified' };
  }
  data.system = newSys;

  const createdArr = await actor.createEmbeddedDocuments('Item', [data]);
  const created = createdArr?.[0];
  if (!created || !created.id) {
    return fail(
      `createEmbeddedDocuments returned no document for sourceUuid: ${input.sourceUuid}`,
      {
        sourceUuid: input.sourceUuid,
      },
    );
  }

  // -- Cascade detection: items on the actor whose flags.pf2e.grantedBy.id
  // points at our newly-created item.
  const cascadeGranted: AddItemToActorCascadeEntry[] = [];
  for (const item of actor.items?.contents ?? []) {
    if (!item || !item.id || item.id === created.id) continue;
    const flagsObj = (item.flags as AnyRecord | undefined) ?? {};
    const pf2eFlags = (flagsObj.pf2e as AnyRecord | undefined) ?? {};
    const grantedByRaw = pf2eFlags.grantedBy;
    if (!grantedByRaw || typeof grantedByRaw !== 'object') continue;
    const grantedById = (grantedByRaw as AnyRecord).id;
    if (typeof grantedById !== 'string' || grantedById !== created.id) continue;
    cascadeGranted.push({
      id: item.id,
      uuid: typeof item.uuid === 'string' ? item.uuid : '',
      name: typeof item.name === 'string' ? item.name : '',
      type: typeof item.type === 'string' ? item.type : '',
      grantedBy: created.id,
    });
  }

  const createdSys = (created.system as AnyRecord | undefined) ?? {};
  const createdContainerRaw = createdSys.containerId;
  const createdContainer =
    typeof createdContainerRaw === 'string' && createdContainerRaw.length > 0
      ? createdContainerRaw
      : null;
  const createdIdent = createdSys.identification as AnyRecord | undefined;
  const createdStatus: 'identified' | 'unidentified' =
    createdIdent?.status === 'unidentified' ? 'unidentified' : 'identified';
  const createdSourceRaw = created._stats?.compendiumSource;
  const createdSource = typeof createdSourceRaw === 'string' ? createdSourceRaw : input.sourceUuid;
  const createdQty =
    typeof createdSys.quantity === 'number' && Number.isFinite(createdSys.quantity)
      ? createdSys.quantity
      : input.quantity;

  const result: AddItemToActorOk = {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'created',
    item: {
      id: created.id,
      uuid: typeof created.uuid === 'string' ? created.uuid : '',
      name: typeof created.name === 'string' ? created.name : '',
      type: typeof created.type === 'string' ? created.type : '',
      quantity: createdQty,
      containerId: createdContainer,
      identificationStatus: createdStatus,
      sourceUuid: createdSource,
    },
  };
  if (cascadeGranted.length > 0) result.cascadeGranted = cascadeGranted;
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
