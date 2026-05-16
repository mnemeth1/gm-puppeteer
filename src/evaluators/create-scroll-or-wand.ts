/**
 * page.evaluate body for create_scroll_or_wand. Generates a
 * spell-specific scroll or wand consumable on a world actor, mirroring
 * PF2e's drag-spell-onto-actor UI workflow.
 *
 * API path confirmed by scripts/probe-create-scroll-or-wand-phase1.mjs
 * against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - PF2e v8 exposes NO `ConsumablePF2e.fromSpell` static. The Foundry
 *    document classes carry only the inherited helpers (`getDefaultArtwork`,
 *    `fromDropData`, etc.). There is no factory entry on `game.pf2e`
 *    either; the UI drag handler does the work inline.
 *
 *  - `CONFIG.PF2E.spellcastingItems[kind].compendiumUuids` is the
 *    canonical per-rank template registry. Shape:
 *      { scroll: { compendiumUuids: { 1: "Compendium...", ..., 10: "..." }, name, nameTemplate },
 *        wand:   { compendiumUuids: { 1: "Compendium...", ..., 9:  "..." , 10: null } } }
 *    Wand rank 10 is intentionally null — PF2e remaster has no rank-10
 *    wand. The evaluator rejects rank-10 wand requests with
 *    INVALID_INPUT.
 *
 *  - The clone-and-inject path:
 *      1. fromUuid(templateUuid) → load the generic rank-N template.
 *      2. template.toObject() → strip the doc identity for re-creation.
 *      3. Set `data.system.spell = spell.toObject()` after forcing
 *         `data.system.spell.system.location = { value: null, heightenedLevel: rank }`.
 *      4. actor.createEmbeddedDocuments('Item', [data]).
 *
 *  - The persisted item retains the template's
 *    `_stats.compendiumSource` (the rank-N scroll/wand template UUID),
 *    not the spell's UUID. Two scrolls of the same spell/rank would
 *    therefore both report the same compendiumSource — they will NOT
 *    auto-merge through add_item_to_actor's merge-by-source logic
 *    (they should not; identical scrolls of different spells share the
 *    rank template). Each `create_scroll_or_wand` call yields one
 *    inventory entry with `quantity` copies inside.
 *
 *  - PF2e's document layer is permissive about embedded spell type:
 *    cantrips and focus spells persist cleanly when injected. The tool
 *    layer rejects them anyway because a scroll-of-a-cantrip is not a
 *    PF2e rules object. Rituals are similarly rejected.
 *
 *  - The persisted item's `name` defaults to the template's generic
 *    name ("Scroll of 1st-rank Spell"). The tool sets it explicitly to
 *    "Scroll of {spellName}" / "Wand of {spellName}" to match PF2e's
 *    UI convention.
 *
 * Note: This function is serialized via Puppeteer's page.evaluate,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface CreateScrollOrWandInput {
  actorId: string;
  spellUuid: string;
  kind: 'scroll' | 'wand';
  rank: number;
  quantity: number;
  containerId: string | null;
  identified: boolean;
}

export interface CreateScrollOrWandCascadeEntry {
  id: string;
  uuid: string;
  name: string;
  type: string;
  grantedBy: string;
}

export interface CreateScrollOrWandItem {
  id: string;
  uuid: string;
  name: string;
  type: 'consumable';
  kind: 'scroll' | 'wand';
  rank: number;
  quantity: number;
  containerId: string | null;
  spellUuid: string;
  spellName: string;
  templateUuid: string;
  identificationStatus: 'identified' | 'unidentified';
}

export interface CreateScrollOrWandOk {
  ok: true;
  actor: { id: string; name: string };
  item: CreateScrollOrWandItem;
  cascadeGranted?: CreateScrollOrWandCascadeEntry[];
  warnings?: string[];
}

export interface CreateScrollOrWandErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CreateScrollOrWandResult = CreateScrollOrWandOk | CreateScrollOrWandErr;

declare function fromUuid(uuid: string): Promise<unknown>;

export async function createScrollOrWandBody(
  input: CreateScrollOrWandInput,
): Promise<CreateScrollOrWandResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ItemDocLike {
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    baseRank?: number;
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
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
  }
  interface SpellcastingItemConfig {
    name?: string;
    nameTemplate?: string;
    compendiumUuids?: Record<string, string | null>;
  }
  interface FoundryConfigPF2e {
    spellcastingItems?: {
      scroll?: SpellcastingItemConfig;
      wand?: SpellcastingItemConfig;
    };
  }
  interface FoundryConfig {
    PF2E?: FoundryConfigPF2e;
  }

  const fail = (message: string, details: Record<string, unknown>): CreateScrollOrWandErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // -- Validate primitive inputs (defense-in-depth; the tool layer's
  //    zod schema already enforced these).
  if (input.kind !== 'scroll' && input.kind !== 'wand') {
    return fail(`kind must be "scroll" or "wand", got: ${String(input.kind)}`, {
      kind: input.kind,
    });
  }
  if (
    typeof input.rank !== 'number' ||
    !Number.isInteger(input.rank) ||
    input.rank < 1 ||
    input.rank > 10
  ) {
    return fail(`rank must be an integer in [1, 10], got: ${String(input.rank)}`, {
      rank: input.rank,
    });
  }
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1
  ) {
    return fail(`quantity must be an integer ≥ 1, got: ${String(input.quantity)}`, {
      quantity: input.quantity,
    });
  }

  // -- Resolve template UUID from CONFIG.PF2E.spellcastingItems.
  const config = (globalThis as unknown as { CONFIG?: FoundryConfig }).CONFIG;
  const spellcastingItems = config?.PF2E?.spellcastingItems;
  if (!spellcastingItems) {
    return fail(
      'CONFIG.PF2E.spellcastingItems is not available — the PF2e system module may not be ' +
        'fully initialized or the version is too old.',
      {},
    );
  }
  const kindConfig = input.kind === 'scroll' ? spellcastingItems.scroll : spellcastingItems.wand;
  if (!kindConfig?.compendiumUuids) {
    return fail(
      `CONFIG.PF2E.spellcastingItems.${input.kind}.compendiumUuids is missing — the PF2e ` +
        'system module may have changed shape.',
      { kind: input.kind },
    );
  }
  const templateUuid =
    kindConfig.compendiumUuids[String(input.rank)] ?? kindConfig.compendiumUuids[input.rank];
  if (!templateUuid) {
    if (input.kind === 'wand' && input.rank === 10) {
      return fail(
        `PF2e has no rank-10 wand template (CONFIG.PF2E.spellcastingItems.wand.compendiumUuids[10] is null). Wands support ranks 1–9 only.`,
        { kind: input.kind, rank: input.rank },
      );
    }
    return fail(
      `No ${input.kind} template found for rank ${input.rank}. Supported ranks for ${input.kind}: ${Object.keys(
        kindConfig.compendiumUuids,
      )
        .filter((k) => kindConfig.compendiumUuids?.[k] != null)
        .join(', ')}.`,
      { kind: input.kind, rank: input.rank },
    );
  }

  // -- Resolve actor.
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, { actorId: input.actorId });
  }

  // -- Resolve spell.
  const spell = (await fromUuid(input.spellUuid)) as ItemDocLike | null;
  if (!spell) {
    return fail(`No spell found for spellUuid: ${input.spellUuid}`, {
      spellUuid: input.spellUuid,
    });
  }
  if (spell.documentName !== 'Item') {
    return fail(
      `spellUuid resolved to ${spell.documentName ?? 'unknown'}, expected Item: ${input.spellUuid}`,
      { spellUuid: input.spellUuid, documentName: spell.documentName ?? null },
    );
  }
  if (spell.type !== 'spell') {
    return fail(
      `spellUuid points to a ${spell.type ?? 'unknown'}; create_scroll_or_wand requires a spell. For physical inventory items, use add_item_to_actor.`,
      { spellUuid: input.spellUuid, type: spell.type ?? null },
    );
  }

  // -- Reject cantrips, focus spells, and rituals — these don't have a
  //    meaningful scroll/wand equivalent in PF2e rules even though the
  //    document layer would accept the create.
  const spellSys = (spell.system as AnyRecord | undefined) ?? {};
  const spellTraits = (spellSys.traits as AnyRecord | undefined) ?? {};
  const traitsValue = Array.isArray(spellTraits.value) ? (spellTraits.value as string[]) : [];
  const isCantrip = traitsValue.includes('cantrip');
  const isFocus = traitsValue.includes('focus');
  const isRitual = spellSys.category === 'ritual' || spell.type === ('ritual' as unknown as string);
  if (isCantrip) {
    return fail(
      `Spell "${spell.name ?? '?'}" is a cantrip; cantrips cannot be scribed into scrolls or wands in PF2e.`,
      { spellUuid: input.spellUuid, trait: 'cantrip' },
    );
  }
  if (isFocus) {
    return fail(
      `Spell "${spell.name ?? '?'}" is a focus spell; focus spells cannot be scribed into scrolls or wands in PF2e.`,
      { spellUuid: input.spellUuid, trait: 'focus' },
    );
  }
  if (isRitual) {
    return fail(
      `Spell "${spell.name ?? '?'}" is a ritual; rituals cannot be scribed into scrolls or wands in PF2e.`,
      { spellUuid: input.spellUuid, category: 'ritual' },
    );
  }

  // -- Rank floor: cannot scribe a spell at a rank below its base.
  const spellBaseLevel =
    typeof spell.baseRank === 'number'
      ? spell.baseRank
      : typeof (spellSys.level as AnyRecord | undefined)?.value === 'number'
        ? ((spellSys.level as AnyRecord).value as number)
        : null;
  if (spellBaseLevel !== null && input.rank < spellBaseLevel) {
    return fail(
      `rank ${input.rank} is below the spell's base rank of ${spellBaseLevel}. Heightening down is not allowed.`,
      { rank: input.rank, baseRank: spellBaseLevel, spellUuid: input.spellUuid },
    );
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

  // -- Load template and build the create payload.
  const template = (await fromUuid(templateUuid)) as ItemDocLike | null;
  if (!template) {
    return fail(
      `Template UUID did not resolve: ${templateUuid}. This indicates a PF2e config drift.`,
      { templateUuid, kind: input.kind, rank: input.rank },
    );
  }
  const data = template.toObject();
  const sysObj = (data.system as AnyRecord | undefined) ?? {};
  const newSys: AnyRecord = { ...sysObj };

  // Inject the spell at the chosen rank.
  const spellPayload = spell.toObject();
  const spellPayloadSys = (spellPayload.system as AnyRecord | undefined) ?? {};
  const spellPayloadLocation = (spellPayloadSys.location as AnyRecord | undefined) ?? {};
  spellPayload.system = {
    ...spellPayloadSys,
    location: {
      ...spellPayloadLocation,
      value: null,
      heightenedLevel: input.rank,
    },
  };
  newSys.spell = spellPayload;
  newSys.quantity = input.quantity;
  newSys.containerId = input.containerId !== null ? input.containerId : null;

  // Identification: default identified. Mirrors add_item_to_actor.
  if (!input.identified) {
    const sourceIdent = (sysObj.identification as AnyRecord | undefined) ?? {};
    newSys.identification = { ...sourceIdent, status: 'unidentified' };
  }

  data.system = newSys;

  // Set a meaningful name. The template's stock name ("Scroll of
  // 1st-rank Spell") is the generic placeholder; the UI convention for
  // a baked-spell consumable is "Scroll of {SpellName}" /
  // "Wand of {SpellName}".
  const kindLabel = input.kind === 'scroll' ? 'Scroll' : 'Wand';
  const spellName = typeof spell.name === 'string' ? spell.name : 'Unknown Spell';
  data.name = `${kindLabel} of ${spellName}`;

  // -- Create.
  const createdArr = await actor.createEmbeddedDocuments('Item', [data]);
  const created = createdArr?.[0];
  if (!created || !created.id) {
    return fail(
      `createEmbeddedDocuments returned no document for kind=${input.kind}, rank=${input.rank}, spellUuid=${input.spellUuid}`,
      { kind: input.kind, rank: input.rank, spellUuid: input.spellUuid },
    );
  }

  // -- Cascade detection: any items on the actor whose
  //    flags.pf2e.grantedBy.id points at our newly-created item.
  //    Scrolls/wands typically don't have GrantItem rules, but the
  //    pattern is inherited from add_item_to_actor for consistency.
  const cascadeGranted: CreateScrollOrWandCascadeEntry[] = [];
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
  const createdQty =
    typeof createdSys.quantity === 'number' && Number.isFinite(createdSys.quantity)
      ? createdSys.quantity
      : input.quantity;

  const result: CreateScrollOrWandOk = {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    item: {
      id: created.id,
      uuid: typeof created.uuid === 'string' ? created.uuid : '',
      name: typeof created.name === 'string' ? created.name : '',
      type: 'consumable',
      kind: input.kind,
      rank: input.rank,
      quantity: createdQty,
      containerId: createdContainer,
      spellUuid: input.spellUuid,
      spellName,
      templateUuid,
      identificationStatus: createdStatus,
    },
  };
  if (cascadeGranted.length > 0) result.cascadeGranted = cascadeGranted;
  return result;
}
