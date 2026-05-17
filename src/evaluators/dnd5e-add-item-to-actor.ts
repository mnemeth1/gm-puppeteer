/**
 * page.evaluate body for `dnd5e_add_item_to_actor`. Grants a physical item
 * from a compendium source to a D&D 5e character/npc. Handles quantity,
 * container placement, identification status, and stack-merging that
 * emulates the Foundry UI's drag-to-merge behavior. D&D 5e sibling of
 * `pf2e_add_item_to_actor`.
 *
 * Behavior nuances confirmed by scripts/probe-dnd5e-add-item-to-actor.mjs
 * against Foundry v14.361 + dnd5e 5.3.3. The 5e schema differs from PF2e —
 * no field path is ported on faith:
 *
 *  - `actor.createEmbeddedDocuments("Item", [data])` accepts a `toObject()`
 *    payload directly. The input's `_id` is stripped and a fresh one is
 *    assigned. Unlike PF2e, dnd5e does NOT auto-populate the created
 *    document's `_stats.compendiumSource` on a bare `createEmbeddedDocuments`
 *    call — that field is only set by the drag-drop UI's `fromCompendium`
 *    pipeline. The tool therefore sets `_stats.compendiumSource` explicitly
 *    in the create payload, recording provenance the same way a UI drop
 *    does (and so the merge-identity lookup can find tool-granted stacks).
 *
 *  - dnd5e does NOT auto-merge stacks on `createEmbeddedDocuments`. As with
 *    PF2e, the stacking happens in the drag-drop UI handler, not the
 *    document API (probe-confirmed: two `createEmbeddedDocuments` calls of
 *    the same item produce two separate entries). The tool implements merge
 *    explicitly: same `_stats.compendiumSource` + same `system.container` +
 *    same `system.identified` ⇒ merge by bumping `system.quantity` via
 *    `updateEmbeddedDocuments`. The explicit merge runs BEFORE the create
 *    path, so a `merge: "auto"` duplicate never reaches `createEmbeddedDocuments`.
 *    `container`-type sources are excluded from the merge path — two
 *    containers carry identity in their contents, never merge.
 *
 *  - **Container field is `system.container`** — a bare item-id string (or
 *    `null`/absent), the 5e analogue of PF2e's `system.containerId`. A
 *    container item is `type: "container"` (NOT PF2e's `backpack`).
 *
 *  - **Identification is `system.identified`** — a bare boolean (NOT PF2e's
 *    `system.identification.status` string). Defaults to `true`; explicit
 *    `false` only on unidentified items.
 *
 *  - **No cascade.** Granting a physical compendium item in 5e does not
 *    spawn child Item documents — 5e uses Active Effects + Advancements,
 *    not PF2e's `GrantItem` rule cascades. No `cascadeGranted` field.
 *
 *  - **No ChoiceSet check.** 5e has no ChoiceSet rule element, so there is
 *    no headless-dialog hazard to guard against on physical-item grant.
 *
 *  - **Actor type support.** `character`, `npc` — same set as
 *    `dnd5e_get_actor_state` / `dnd5e_apply_condition`. `vehicle` / `group`
 *    / `encounter` are rejected with ACTOR_TYPE_UNSUPPORTED. 5e has no
 *    `familiar` actor type.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline. Only erased-at-runtime type declarations
 * and tool-layer-only consts live at module scope.
 */
export interface Dnd5eAddItemToActorInput {
  actorId: string;
  sourceUuid: string;
  quantity: number;
  containerId: string | null;
  identified: boolean;
  merge: 'auto' | 'never';
}

export interface Dnd5eAddItemToActorCreatedItem {
  id: string;
  uuid: string;
  name: string;
  type: string;
  quantity: number;
  /** Owning container's item id, or `null` when at inventory root. */
  container: string | null;
  /** `true` when identified; `false` for mystery loot. */
  identified: boolean;
  sourceUuid: string;
}

export interface Dnd5eAddItemToActorMergedInto {
  id: string;
  uuid: string;
  name: string;
  previousQuantity: number;
  newQuantity: number;
  addedQuantity: number;
  container: string | null;
}

export interface Dnd5eAddItemToActorOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'created' | 'merged';
  item?: Dnd5eAddItemToActorCreatedItem;
  mergedInto?: Dnd5eAddItemToActorMergedInto;
  warnings?: string[];
}

export interface Dnd5eAddItemToActorErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: {
      reason:
        | 'ACTOR_NOT_FOUND'
        | 'ACTOR_TYPE_UNSUPPORTED'
        | 'SOURCE_NOT_FOUND'
        | 'SOURCE_NOT_ITEM'
        | 'CROSS_ACTOR_UNSUPPORTED'
        | 'NON_PHYSICAL_ITEM'
        | 'INVALID_QUANTITY'
        | 'CONTAINER_NOT_FOUND'
        | 'CONTAINER_TYPE_INVALID'
        | 'CREATE_FAILED';
      [k: string]: unknown;
    };
  };
}

export type Dnd5eAddItemToActorResult = Dnd5eAddItemToActorOk | Dnd5eAddItemToActorErr;

/** Actor types this tool will mutate. Mirrors dnd5e_apply_condition's set. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

/**
 * The D&D 5e physical-inventory item types this tool will grant. Exported
 * for the tool layer's user-facing error message; the evaluator re-declares
 * this set inline because module-scope identifiers do not survive
 * `page.evaluate` serialization.
 */
export const PHYSICAL_ITEM_TYPES = [
  'weapon',
  'equipment',
  'consumable',
  'tool',
  'loot',
  'container',
] as const;

declare function fromUuid(uuid: string): Promise<unknown>;

export async function dnd5eAddItemToActorBody(
  input: Dnd5eAddItemToActorInput,
): Promise<Dnd5eAddItemToActorResult> {
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
    documentName?: string;
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
    createEmbeddedDocuments(name: 'Item', data: AnyRecord[]): Promise<ItemDocLike[]>;
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
    details: Dnd5eAddItemToActorErr['error']['details'],
  ): Dnd5eAddItemToActorErr => ({
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
      reason: 'INVALID_QUANTITY',
      quantity: input.quantity,
    });
  }

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
      `Actor type '${actorType}' is not supported by dnd5e_add_item_to_actor. ` +
        `Supported types: character, npc. (5e has no familiar actor type.)`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', actorId: input.actorId, type: actorType },
    );
  }

  // -- Resolve source UUID.
  const source = (await fromUuid(input.sourceUuid)) as ItemDocLike | null;
  if (!source) {
    return fail(`No item found for sourceUuid: ${input.sourceUuid}`, {
      reason: 'SOURCE_NOT_FOUND',
      sourceUuid: input.sourceUuid,
    });
  }
  if (source.documentName !== 'Item') {
    return fail(
      `sourceUuid resolved to ${source.documentName ?? 'unknown'}, expected Item: ${input.sourceUuid}`,
      {
        reason: 'SOURCE_NOT_ITEM',
        sourceUuid: input.sourceUuid,
        documentName: source.documentName ?? null,
      },
    );
  }

  // -- Reject actor-embedded item UUIDs (Actor.X.Item.Y). These resolve to a
  // valid Item, so the documentName check above passes — the prefix check is
  // what distinguishes a compendium source from a cross-actor move, which is
  // a separate operation with different semantics. (A bare Actor.X world
  // actor UUID resolves to an Actor and is caught by the SOURCE_NOT_ITEM
  // check above.)
  if (input.sourceUuid.startsWith('Actor.')) {
    return fail(
      `sourceUuid must be a compendium Item UUID; got actor-embedded UUID: ${input.sourceUuid}. ` +
        `Cross-actor item moves are not yet supported.`,
      { reason: 'CROSS_ACTOR_UNSUPPORTED', sourceUuid: input.sourceUuid },
    );
  }

  const sourceType = typeof source.type === 'string' ? source.type : '';
  if (!PHYSICAL.has(sourceType)) {
    return fail(
      `sourceUuid points to a ${sourceType}; dnd5e_add_item_to_actor handles physical inventory ` +
        `items only (${PHYSICAL_TYPES_LIST}). Use foundry_eval to grant non-physical items ` +
        `(spells, feats, classes, etc.).`,
      { reason: 'NON_PHYSICAL_ITEM', sourceUuid: input.sourceUuid, type: sourceType },
    );
  }

  // -- Validate containerId (when provided).
  if (input.containerId !== null) {
    const containerItem = actor.items?.get?.(input.containerId);
    if (!containerItem) {
      return fail(`No item found on actor for containerId: ${input.containerId}`, {
        reason: 'CONTAINER_NOT_FOUND',
        actorId: input.actorId,
        containerId: input.containerId,
      });
    }
    const containerType = typeof containerItem.type === 'string' ? containerItem.type : '';
    if (containerType !== 'container') {
      return fail(
        `Item with containerId ${input.containerId} is type ${containerType}, not a container.`,
        { reason: 'CONTAINER_TYPE_INVALID', containerId: input.containerId, type: containerType },
      );
    }
  }

  // -- Merge candidate lookup (auto only).
  //
  // findMergeCandidate: same compendium source + same container + same
  // identification status. If multiple match, return the first and surface
  // a warning. Containers (type='container') are excluded from the merge
  // path entirely — two containers carry identity in their contents and
  // Foundry's UI does not merge them either.
  const findMergeCandidate = (): { match: ItemDocLike | null; multiple: boolean } => {
    if (input.merge !== 'auto' || sourceType === 'container') {
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
      const candidateContainerRaw = csys.container;
      const candidateContainer =
        typeof candidateContainerRaw === 'string' && candidateContainerRaw.length > 0
          ? candidateContainerRaw
          : null;
      if (candidateContainer !== input.containerId) continue;
      // `identified` defaults to true; explicit false only on unidentified.
      const candidateIdentified = csys.identified !== false;
      if (candidateIdentified !== input.identified) continue;
      if (!first) first = candidate;
      count += 1;
    }
    return { match: first, multiple: count > 1 };
  };

  const warnings: string[] = [];

  const candidateLookup = findMergeCandidate();
  if (candidateLookup.match) {
    const match = candidateLookup.match;
    if (!match.id) {
      return fail(`Merge candidate has no id: ${match.uuid ?? '?'}`, {
        reason: 'CREATE_FAILED',
        sourceUuid: input.sourceUuid,
      });
    }
    const msys = (match.system as AnyRecord | undefined) ?? {};
    const previousQuantity =
      typeof msys.quantity === 'number' && Number.isFinite(msys.quantity) ? msys.quantity : 1;
    const newQuantity = previousQuantity + input.quantity;
    await actor.updateEmbeddedDocuments('Item', [
      { _id: match.id, 'system.quantity': newQuantity },
    ]);
    if (candidateLookup.multiple) {
      warnings.push(
        `Multiple existing stacks matched the merge identity (same source, container, ` +
          `identification). Merged into the first; the others were left untouched.`,
      );
    }
    const matchContainerRaw = msys.container;
    const matchContainer =
      typeof matchContainerRaw === 'string' && matchContainerRaw.length > 0
        ? matchContainerRaw
        : null;
    const mergedResult: Dnd5eAddItemToActorOk = {
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
        container: matchContainer,
      },
    };
    if (warnings.length > 0) mergedResult.warnings = warnings;
    return mergedResult;
  }

  // -- Create path.
  const data = source.toObject();
  const sysObj = (data.system as AnyRecord | undefined) ?? {};
  const newSys: AnyRecord = { ...sysObj };
  newSys.quantity = input.quantity;
  // container: bare item-id string, or null at inventory root. Setting null
  // defensively clears any source-payload container.
  newSys.container = input.containerId;
  if (!input.identified) {
    newSys.identified = false;
  }
  data.system = newSys;
  // Record compendium provenance the way the Foundry UI's drop pipeline
  // does. dnd5e does not auto-populate `_stats.compendiumSource` on a bare
  // createEmbeddedDocuments call, so set it explicitly — both for provenance
  // and so the merge-identity lookup can find tool-granted stacks.
  const statsObj = (data._stats as AnyRecord | undefined) ?? {};
  data._stats = { ...statsObj, compendiumSource: input.sourceUuid };

  const createdArr = await actor.createEmbeddedDocuments('Item', [data]);
  const created = createdArr?.[0];
  if (!created || !created.id) {
    return fail(
      `createEmbeddedDocuments returned no document for sourceUuid: ${input.sourceUuid}`,
      { reason: 'CREATE_FAILED', sourceUuid: input.sourceUuid },
    );
  }

  const createdSys = (created.system as AnyRecord | undefined) ?? {};
  const createdContainerRaw = createdSys.container;
  const createdContainer =
    typeof createdContainerRaw === 'string' && createdContainerRaw.length > 0
      ? createdContainerRaw
      : null;
  const createdIdentified = createdSys.identified !== false;
  const createdSourceRaw = created._stats?.compendiumSource;
  const createdSource =
    typeof createdSourceRaw === 'string' ? createdSourceRaw : input.sourceUuid;
  const createdQty =
    typeof createdSys.quantity === 'number' && Number.isFinite(createdSys.quantity)
      ? createdSys.quantity
      : input.quantity;

  const result: Dnd5eAddItemToActorOk = {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'created',
    item: {
      id: created.id,
      uuid: typeof created.uuid === 'string' ? created.uuid : '',
      name: typeof created.name === 'string' ? created.name : '',
      type: typeof created.type === 'string' ? created.type : '',
      quantity: createdQty,
      container: createdContainer,
      identified: createdIdentified,
      sourceUuid: createdSource,
    },
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
