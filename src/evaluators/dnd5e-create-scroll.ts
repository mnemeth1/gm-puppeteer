/**
 * page.evaluate body for `dnd5e_create_scroll`. Generates a spell-scroll
 * consumable from a Spell UUID and places it on a D&D 5e actor. D&D 5e
 * sibling of `pf2e_create_scroll_or_wand` — but scroll-only: D&D 5e has
 * NO per-spell wand generation (5e wands are bespoke SRD items, not
 * built from a spell), so there is no `kind` parameter.
 *
 * API path confirmed by scripts/probe-dnd5e-create-scroll-or-wand-phase1.mjs
 * against Foundry v14.361 + dnd5e 5.3.3:
 *
 *  - The dnd5e system exposes a factory:
 *    `Item5e.createScrollFromSpell(spell, options={}, config={})`
 *    (`Item5e` === `CONFIG.Item.documentClass`). For a compendium-bound
 *    spell it delegates to `createScrollFromCompendiumSpell(uuid, config)`.
 *  - The factory opens a `CreateScrollDialog` unless `config.dialog` is
 *    `false`. The dialog-bypass and the cast level live in the THIRD
 *    argument (`config`), NOT the second (`options`). This evaluator
 *    calls `createScrollFromSpell(spell, {}, { dialog: false, level })`.
 *  - The factory returns an UNSAVED `Item5e` document (`hasId: false`,
 *    not in `game.items`). This evaluator takes `toObject()`, applies
 *    quantity / container / identification overrides, then persists it
 *    with `actor.createEmbeddedDocuments('Item', [data])`.
 *  - The produced item is a `consumable` with `system.type.value ===
 *    "scroll"`, `uses: { spent: 0, max: 1, autoDestroy: true, value: 1 }`,
 *    `quantity: 1`. Its effect lives in `system.activities` as a single
 *    `CastActivity` (id `dnd5escrollspell`) — there is NO embedded spell
 *    Item the way PF2e scroll consumables carry one.
 *  - `config.level` sets the embedded cast activity's `spell.level` (the
 *    level the scroll casts the spell at). The scroll ITEM template,
 *    however, is `CONFIG.DND5E.spellScrollIds[spell.system.level]` keyed
 *    on the spell's BASE level — upcasting changes the cast level only,
 *    not the scroll's rarity/template. The factory applies NO floor
 *    check on `level`; downcasting (level below the spell's base) is
 *    silently accepted, so this evaluator rejects it itself
 *    (`LEVEL_BELOW_SPELL_BASE`). A cantrip (base level 0) cannot be
 *    upcast (`CANTRIP_NOT_UPCASTABLE`).
 *  - `system.container` is a bare item-id string (or `null`) — the 5e
 *    container-membership link. `system.identified` is a bare boolean.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface Dnd5eCreateScrollInput {
  actorId: string;
  spellUuid: string;
  /** Cast level for the embedded spell. Defaults to the spell's base level. */
  level: number | null;
  quantity: number;
  containerId: string | null;
  identified: boolean;
}

export interface Dnd5eCreateScrollItem {
  id: string;
  uuid: string;
  name: string;
  type: 'consumable';
  subtype: string;
  spellUuid: string;
  spellName: string;
  /** The level the scroll casts the spell at. */
  castLevel: number;
  /** The spell's base level (= scroll-template level). */
  baseSpellLevel: number;
  quantity: number;
  containerId: string | null;
  identified: boolean;
}

export interface Dnd5eCreateScrollOk {
  ok: true;
  actor: { id: string; name: string };
  item: Dnd5eCreateScrollItem;
}

export interface Dnd5eCreateScrollErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: Record<string, unknown> & { reason: string };
  };
}

export type Dnd5eCreateScrollResult = Dnd5eCreateScrollOk | Dnd5eCreateScrollErr;

declare function fromUuid(uuid: string): Promise<unknown>;

export async function dnd5eCreateScrollBody(
  input: Dnd5eCreateScrollInput,
): Promise<Dnd5eCreateScrollResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ItemDocLike {
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    documentName?: string;
    system?: AnyRecord;
    toObject(): AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    items?: { get?(id: string): ItemDocLike | undefined };
    createEmbeddedDocuments(name: 'Item', data: AnyRecord[]): Promise<ItemDocLike[]>;
  }
  interface Item5eStatic {
    createScrollFromSpell?(
      spell: unknown,
      options: AnyRecord,
      config: AnyRecord,
    ): Promise<ItemDocLike | undefined>;
  }

  const SUPPORTED_ACTOR_TYPES = new Set(['character', 'npc']);
  const MAX_SPELL_LEVEL = 9;

  const fail = (
    message: string,
    details: Record<string, unknown> & { reason: string },
  ): Dnd5eCreateScrollErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const readNumber = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // -- Validate primitive inputs (defense-in-depth; the tool's zod
  //    schema already enforced these). --------------------------------
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
  if (
    input.level !== null &&
    (typeof input.level !== 'number' || !Number.isInteger(input.level) || input.level < 0)
  ) {
    return fail(`level must be a non-negative integer or null, got: ${String(input.level)}`, {
      reason: 'INVALID_LEVEL',
      level: input.level,
    });
  }

  // -- Resolve the dnd5e scroll factory. ------------------------------
  const config = (globalThis as unknown as { CONFIG?: AnyRecord }).CONFIG;
  const Item5e = (config?.Item as AnyRecord | undefined)?.documentClass as Item5eStatic | undefined;
  if (typeof Item5e?.createScrollFromSpell !== 'function') {
    return fail(
      'CONFIG.Item.documentClass.createScrollFromSpell is not available — the dnd5e ' +
        'system module may not be fully initialized or the version is incompatible.',
      { reason: 'FACTORY_UNAVAILABLE' },
    );
  }

  // -- Resolve actor. -------------------------------------------------
  const game = (
    globalThis as unknown as {
      game?: { actors?: { get(id: string): ActorDocLike | undefined } };
    }
  ).game;
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, {
      reason: 'ACTOR_NOT_FOUND',
      actorId: input.actorId,
    });
  }
  const actorType = typeof actor.type === 'string' ? actor.type : '';
  if (!SUPPORTED_ACTOR_TYPES.has(actorType)) {
    return fail(
      `dnd5e_create_scroll supports character and npc actors; actor '${actor.name ?? input.actorId}' is type '${actorType}'.`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', actorId: input.actorId, type: actorType },
    );
  }

  // -- Resolve spell. -------------------------------------------------
  const spell = (await fromUuid(input.spellUuid)) as ItemDocLike | null;
  if (!spell) {
    return fail(`No spell found for spellUuid: ${input.spellUuid}`, {
      reason: 'SPELL_NOT_FOUND',
      spellUuid: input.spellUuid,
    });
  }
  if (spell.documentName !== 'Item' || spell.type !== 'spell') {
    return fail(
      `spellUuid resolved to a ${spell.documentName ?? 'unknown'} of type '${spell.type ?? 'unknown'}'; dnd5e_create_scroll requires a spell Item. For granting a finished compendium scroll/wand item, use dnd5e_add_item_to_actor.`,
      {
        reason: 'NOT_A_SPELL',
        spellUuid: input.spellUuid,
        documentName: spell.documentName ?? null,
        type: spell.type ?? null,
      },
    );
  }

  const baseSpellLevel = readNumber((spell.system as AnyRecord | undefined)?.level);
  if (baseSpellLevel === null) {
    return fail(
      `Spell '${spell.name ?? input.spellUuid}' has no readable system.level — cannot determine the scroll level.`,
      { reason: 'SPELL_LEVEL_UNREADABLE', spellUuid: input.spellUuid },
    );
  }

  // -- Resolve and validate the cast level. ---------------------------
  const castLevel = input.level === null ? baseSpellLevel : input.level;
  if (castLevel < baseSpellLevel) {
    return fail(
      `level ${castLevel} is below spell '${spell.name ?? '?'}' base level ${baseSpellLevel}. A scroll cannot cast a spell below its base level.`,
      {
        reason: 'LEVEL_BELOW_SPELL_BASE',
        level: castLevel,
        baseSpellLevel,
      },
    );
  }
  if (castLevel > MAX_SPELL_LEVEL) {
    return fail(`level ${castLevel} exceeds the maximum spell level of ${MAX_SPELL_LEVEL}.`, {
      reason: 'LEVEL_ABOVE_MAX',
      level: castLevel,
      max: MAX_SPELL_LEVEL,
    });
  }
  if (baseSpellLevel === 0 && castLevel !== 0) {
    return fail(
      `Spell '${spell.name ?? '?'}' is a cantrip; cantrips are not cast from a spell slot and cannot be scribed at a level above 0.`,
      { reason: 'CANTRIP_NOT_UPCASTABLE', level: castLevel },
    );
  }

  // -- Validate containerId (when provided). --------------------------
  if (input.containerId !== null) {
    const containerItem = actor.items?.get?.(input.containerId);
    if (!containerItem) {
      return fail(`No item found on actor for containerId: ${input.containerId}`, {
        reason: 'CONTAINER_NOT_FOUND',
        containerId: input.containerId,
      });
    }
    if (containerItem.type !== 'container') {
      return fail(
        `Item with containerId ${input.containerId} is type '${containerItem.type ?? 'unknown'}', not a container.`,
        {
          reason: 'NOT_A_CONTAINER',
          containerId: input.containerId,
          type: containerItem.type ?? null,
        },
      );
    }
  }

  // -- Build the scroll via the dnd5e factory. ------------------------
  let scrollDoc: ItemDocLike | undefined;
  try {
    scrollDoc = await Item5e.createScrollFromSpell(spell, {}, { dialog: false, level: castLevel });
  } catch (e: unknown) {
    return fail(
      `createScrollFromSpell threw for spell '${spell.name ?? input.spellUuid}': ${
        e instanceof Error ? e.message : String(e)
      }`,
      { reason: 'SCROLL_FACTORY_FAILED', spellUuid: input.spellUuid },
    );
  }
  if (!scrollDoc || typeof scrollDoc.toObject !== 'function') {
    return fail(
      `createScrollFromSpell returned no document for spell '${spell.name ?? input.spellUuid}'.`,
      { reason: 'SCROLL_FACTORY_FAILED', spellUuid: input.spellUuid },
    );
  }

  // -- Apply quantity / container / identification overrides. ---------
  const data = scrollDoc.toObject();
  delete data._id;
  const sys = (data.system as AnyRecord | undefined) ?? {};
  sys.quantity = input.quantity;
  sys.container = input.containerId;
  sys.identified = input.identified;
  data.system = sys;

  // -- Persist on the actor. ------------------------------------------
  let createdArr: ItemDocLike[];
  try {
    createdArr = await actor.createEmbeddedDocuments('Item', [data]);
  } catch (e: unknown) {
    return fail(
      `createEmbeddedDocuments threw while placing the scroll: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { reason: 'CREATE_FAILED', spellUuid: input.spellUuid },
    );
  }
  const created = createdArr?.[0];
  if (!created || !created.id) {
    return fail(`createEmbeddedDocuments returned no document for the scroll.`, {
      reason: 'CREATE_FAILED',
      spellUuid: input.spellUuid,
    });
  }

  const createdSys = (created.system as AnyRecord | undefined) ?? {};
  const createdContainerRaw = createdSys.container;
  const createdContainer =
    typeof createdContainerRaw === 'string' && createdContainerRaw.length > 0
      ? createdContainerRaw
      : null;
  const createdTypeValue =
    typeof (createdSys.type as AnyRecord | undefined)?.value === 'string'
      ? ((createdSys.type as AnyRecord).value as string)
      : 'scroll';

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    item: {
      id: created.id,
      uuid: typeof created.uuid === 'string' ? created.uuid : '',
      name: typeof created.name === 'string' ? created.name : '',
      type: 'consumable',
      subtype: createdTypeValue,
      spellUuid: input.spellUuid,
      spellName: typeof spell.name === 'string' ? spell.name : '',
      castLevel,
      baseSpellLevel,
      quantity: readNumber(createdSys.quantity) ?? input.quantity,
      containerId: createdContainer,
      identified: createdSys.identified !== false,
    },
  };
}
