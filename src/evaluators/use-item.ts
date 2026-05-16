/**
 * page.evaluate body for use_item. Runs the PF2e item-use pipeline for
 * a single item embedded on an actor. Sibling to the inventory-mutation
 * cluster but distinct in intent: this tool *runs* the use pipeline
 * (chat card, charges, embedded-spell cast) rather than just editing
 * quantity.
 *
 * Two underlying API paths, selected by item type. Both surface a
 * `mode` field in the response so callers can tell which path ran:
 *
 *  - `consume` — `ConsumablePF2e.consume(1)` is called. Used for all
 *    `type: "consumable"` items: potions, scrolls, wands, elixirs,
 *    poisons, talismans, etc.
 *  - `message` — `Item.toMessage(undefined, { create: true })` posts
 *    a chat card; if the item has `system.uses.max > 0`, the tool then
 *    decrements `system.uses.value` by 1. Used for `type: "equipment"`
 *    activations.
 *
 * Behavior nuances confirmed by scripts/probe-use-item-phase1.mjs
 * against Foundry v14.361 + PF2e 8.1.2:
 *
 *  - `item.consume(1)` returns `undefined` — there is no return-value
 *    path to the created ChatMessage. The tool diffs
 *    `game.messages.size` across the call to recover the latest
 *    message id (if any was posted). For consume() calls that produce
 *    no chat message (basic potions, Phase-1 Q2 finding) the response
 *    carries `chatMessageId: null`.
 *  - `consume()` on a potion (`uses.max === 1`) decrements
 *    `system.quantity`. `consume()` on a scroll without an embedded
 *    spell additionally deletes the item (consume's autoDestroy path)
 *    and posts a "Uses X" chat message.
 *  - `consume()` on a wand on a non-caster actor SILENTLY does
 *    nothing (Phase-1 Q3 finding) — no throw, no chat, no state
 *    change. The tool detects this no-op by comparing before/after
 *    state and returns `USE_HAD_NO_EFFECT` with a hint pointing to
 *    the spellcasting-entry requirement. Without this detection,
 *    callers would see `ok: true` for a call that accomplished
 *    nothing.
 *  - `consume()` on `quantity: 0` is also a silent no-op (Phase-1 Q8
 *    finding). The tool gates this server-side with
 *    `NO_CHARGES_REMAINING` before invoking consume.
 *  - Equipment items do NOT expose `consume()` (Phase-1 Q7 finding),
 *    but DO expose `toMessage()` inherited from ItemPF2e. The tool
 *    uses `toMessage()` as the activation path and manually
 *    decrements `system.uses.value` if applicable. This is the same
 *    operation a user performs by clicking the chat-card button on
 *    the character sheet.
 *  - Weapons, armor, shields, backpacks, treasure, and ammo expose
 *    `toMessage()` but have no meaningful "use" verb in PF2e. The
 *    tool rejects them with `ITEM_TYPE_UNSUPPORTED` — calling
 *    toMessage() on a weapon would post a chat card with the item's
 *    description but accomplishes nothing semantically.
 *  - Non-physical types (feat, action, spell, etc.) are rejected with
 *    `ITEM_TYPE_NON_PHYSICAL`. Feat/action activation lives in PF2e's
 *    action-roll pipeline and is out of v1 scope.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface UseItemInput {
  actorId: string;
  itemId: string;
}

export interface UseItemResultItem {
  id: string;
  name: string;
  type: string;
  /** `system.category` for consumables (potion, scroll, wand, etc.); `null` otherwise. */
  subtype: string | null;
  qtyBefore: number | null;
  qtyAfter: number | null;
  /** Present when the item exposes `system.uses` with `max > 0`. */
  usesBefore?: number;
  usesAfter?: number;
  /** True when `consume()`'s autoDestroy fired and the item was removed. */
  deleted: boolean;
}

export interface UseItemOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'used';
  /**
   * Which underlying PF2e API path ran. `consume` for type=consumable
   * (via `ConsumablePF2e.consume(1)`); `message` for type=equipment
   * (via `Item.toMessage()` + manual uses decrement).
   */
  mode: 'consume' | 'message';
  item: UseItemResultItem;
  /** Chat message id if a card was posted. `null` if no chat message was produced. */
  chatMessageId: string | null;
}

export interface UseItemErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UseItemResult = UseItemOk | UseItemErr;

/** Physical inventory types this tool may receive. Equipment + consumable
 * are the two actionable branches; the others get explicit rejection so
 * the AI knows there is no "use" verb for them in PF2e. */
export const PHYSICAL_ITEM_TYPES = [
  'weapon',
  'armor',
  'shield',
  'consumable',
  'equipment',
  'backpack',
  'treasure',
  'ammo',
] as const;

export async function useItemBody(input: UseItemInput): Promise<UseItemResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const PHYSICAL_TYPES = new Set([
    'weapon',
    'armor',
    'shield',
    'consumable',
    'equipment',
    'backpack',
    'treasure',
    'ammo',
  ]);

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    consume?(thisMany?: number): Promise<unknown>;
    toMessage?(
      event?: unknown,
      options?: { create?: boolean },
    ): Promise<{ id?: string } | undefined>;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    items?: {
      get?(id: string): ItemDocLike | undefined;
    };
    updateEmbeddedDocuments(
      name: 'Item',
      data: Array<AnyRecord & { _id: string }>,
    ): Promise<ItemDocLike[]>;
  }
  interface ChatMessageLike {
    id?: string;
  }
  interface MessagesCollectionLike {
    size: number;
    contents?: ChatMessageLike[];
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    messages?: MessagesCollectionLike;
  }

  const fail = (
    message: string,
    details: Record<string, unknown>,
  ): UseItemErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  // Surface the canonical (identified) name so audit logs read clearly
  // even when the player carries the item under an unidentified alias.
  // Same helper shape as remove-item-from-actor / update-item-quantity.
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

  const readNumber = (v: unknown, fallback: number | null = null): number | null => {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  // Snapshot a small set of fields we'll use for before/after comparison
  // and for the response payload.
  const snapshotState = (item: ItemDocLike): {
    qty: number | null;
    usesValue: number | null;
    usesMax: number | null;
  } => {
    const sys = (item.system as AnyRecord | undefined) ?? {};
    const uses = sys.uses as AnyRecord | undefined;
    return {
      qty: readNumber(sys.quantity, null),
      usesValue: uses ? readNumber(uses.value, null) : null,
      usesMax: uses ? readNumber(uses.max, null) : null,
    };
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
    return fail(
      `No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`,
      {
        actorId: input.actorId,
        itemId: input.itemId,
        reason: 'ITEM_NOT_FOUND_ON_ACTOR',
      },
    );
  }

  const targetType: string = typeof target.type === 'string' ? target.type : '';

  // -- Reject non-physical types up front.
  if (!PHYSICAL_TYPES.has(targetType)) {
    return fail(
      `use_item requires a physical item; this item is '${targetType}'. ` +
        `Non-physical types (feat, action, spell, ancestry, class, etc.) have no use ` +
        `pipeline at the inventory layer — feat/action activation lives in PF2e's ` +
        `action-roll pipeline, which is out of scope for use_item.`,
      {
        itemId: input.itemId,
        type: targetType,
        reason: 'ITEM_TYPE_NON_PHYSICAL',
      },
    );
  }

  // -- Reject physical types that have no meaningful use verb.
  if (
    targetType !== 'consumable' &&
    targetType !== 'equipment'
  ) {
    return fail(
      `use_item does not support type '${targetType}'. Only 'consumable' items (potions, ` +
        `scrolls, wands, elixirs, talismans, etc.) and 'equipment' items with activations are ` +
        `supported. Weapons are not "used" — they are wielded; armor and shields are worn; ` +
        `backpacks store items; treasure and ammo have no use pipeline.`,
      {
        itemId: input.itemId,
        type: targetType,
        reason: 'ITEM_TYPE_UNSUPPORTED',
      },
    );
  }

  const targetName = identifiedName(target);
  const sys = (target.system as AnyRecord | undefined) ?? {};
  const subtypeRaw = sys.category;
  const subtype: string | null = typeof subtypeRaw === 'string' ? subtypeRaw : null;

  // Capture before-state once, common to both branches.
  const before = snapshotState(target);

  // ==================================================================
  // CONSUMABLE BRANCH — ConsumablePF2e.consume(1).
  // ==================================================================
  if (targetType === 'consumable') {
    if (typeof target.consume !== 'function') {
      return fail(
        `Item '${targetName}' is type=consumable but does not expose a consume() method. ` +
          `This is unexpected for PF2e 8.x — the item may be malformed.`,
        {
          itemId: input.itemId,
          type: targetType,
          reason: 'CONSUME_UNAVAILABLE',
        },
      );
    }

    // Zero-charge guard. consume() silently no-ops on quantity=0 (Phase-1
    // Q8) and on uses.value=0 for uses-tracked consumables (wands), so
    // the tool must reject these up-front.
    //
    // Decrement target by item shape:
    //   - uses.max > 1 (e.g., wand): consume decrements uses.value.
    //   - uses.max === 1 / absent: consume decrements quantity.
    // We gate on whichever target is the active counter.
    const usesMax = before.usesMax;
    const usesValue = before.usesValue;
    const qty = before.qty;
    const usesIsTracker = typeof usesMax === 'number' && usesMax > 1;

    if (usesIsTracker) {
      if (!(typeof usesValue === 'number' && usesValue > 0)) {
        return fail(
          `Item '${targetName}' has no remaining charges (uses.value=${String(usesValue)}, ` +
            `uses.max=${String(usesMax)}). Recharge or replace the item before using.`,
          {
            itemId: input.itemId,
            usesValue,
            usesMax,
            reason: 'NO_CHARGES_REMAINING',
          },
        );
      }
    } else {
      if (!(typeof qty === 'number' && qty > 0)) {
        return fail(
          `Item '${targetName}' has no remaining quantity (quantity=${String(qty)}). ` +
            `Acquire more before using.`,
          {
            itemId: input.itemId,
            quantity: qty,
            reason: 'NO_CHARGES_REMAINING',
          },
        );
      }
    }

    // Pre-call snapshot for chat-message recovery. consume(1) returns
    // undefined (Phase-1 Q2) so we recover the chat message — if any —
    // by diffing the messages collection size.
    const msgCountBefore = game?.messages?.size ?? 0;
    const targetIdBefore = target.id;

    let threw: string | null = null;
    try {
      await target.consume(1);
    } catch (e: unknown) {
      threw = e instanceof Error ? e.message : String(e);
    }

    if (threw !== null) {
      return fail(
        `consume() threw for item '${targetName}': ${threw}`,
        {
          itemId: input.itemId,
          subtype,
          error: threw,
          reason: 'CONSUME_FAILED',
        },
      );
    }

    // Re-resolve after consume — autoDestroy may have deleted the item.
    const liveAfter = actor.items?.get?.(targetIdBefore);
    const deleted = !liveAfter;
    const after = liveAfter
      ? snapshotState(liveAfter)
      : { qty: null, usesValue: null, usesMax: null };

    // Detect silent no-op (consume() returned without throwing but
    // nothing changed). Wand-on-non-caster falls into this case
    // (Phase-1 Q3 finding). Without this guard, callers would see
    // ok: true for a call that did nothing.
    const nothingChanged =
      !deleted &&
      before.qty === after.qty &&
      before.usesValue === after.usesValue;
    if (nothingChanged) {
      const hint =
        subtype === 'wand' || subtype === 'scroll'
          ? `${subtype === 'wand' ? 'Wand' : 'Scroll'} consumption requires the actor to have ` +
            `a spellcasting entry (or Trick Magic Item) for the embedded spell. PF2e silently ` +
            `aborts consume() when no compatible spellcasting source is available.`
          : `consume() returned without modifying the item. The item may have an unusual ` +
            `rules configuration that aborts the use pipeline.`;
      return fail(
        `Calling consume() on '${targetName}' had no effect. ${hint}`,
        {
          itemId: input.itemId,
          subtype,
          qtyBefore: before.qty,
          usesBefore: before.usesValue,
          reason: 'USE_HAD_NO_EFFECT',
        },
      );
    }

    const msgCountAfter = game?.messages?.size ?? 0;
    let chatMessageId: string | null = null;
    if (msgCountAfter > msgCountBefore) {
      const contents = game?.messages?.contents ?? [];
      const latest = contents[contents.length - 1];
      const latestId = latest?.id;
      if (typeof latestId === 'string') chatMessageId = latestId;
    }

    const item: UseItemResultItem = {
      id: targetIdBefore,
      name: targetName,
      type: targetType,
      subtype,
      qtyBefore: before.qty,
      qtyAfter: deleted ? 0 : after.qty,
      deleted,
    };
    if (typeof before.usesMax === 'number' && before.usesMax > 0) {
      item.usesBefore = before.usesValue ?? 0;
      item.usesAfter = deleted ? 0 : after.usesValue ?? 0;
    }

    return {
      ok: true,
      actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
      operation: 'used',
      mode: 'consume',
      item,
      chatMessageId,
    };
  }

  // ==================================================================
  // EQUIPMENT BRANCH — Item.toMessage() + manual uses decrement.
  //
  // Equipment items have no consume() method (Phase-1 Q7). The
  // user-facing equivalent is "click the chat-card button on the
  // sheet" — Foundry's `Item.toMessage()` posts the same card, and we
  // then manually decrement `system.uses.value` for items that track
  // charges.
  // ==================================================================
  if (typeof target.toMessage !== 'function') {
    return fail(
      `Item '${targetName}' is type=equipment but does not expose a toMessage() method. ` +
        `This is unexpected for Foundry v14 — the item may be malformed.`,
      {
        itemId: input.itemId,
        type: targetType,
        reason: 'TOMESSAGE_UNAVAILABLE',
      },
    );
  }

  // Equipment-with-uses zero-charge guard. Equipment without uses
  // (no system.uses or uses.max <= 0) has no charge concept — the
  // tool just posts the chat card.
  const eqUsesMax = before.usesMax;
  const eqUsesValue = before.usesValue;
  const eqHasUses = typeof eqUsesMax === 'number' && eqUsesMax > 0;
  if (eqHasUses && !(typeof eqUsesValue === 'number' && eqUsesValue > 0)) {
    return fail(
      `Item '${targetName}' has no remaining charges (uses.value=${String(eqUsesValue)}, ` +
        `uses.max=${String(eqUsesMax)}). Recharge or wait for daily refresh.`,
      {
        itemId: input.itemId,
        usesValue: eqUsesValue,
        usesMax: eqUsesMax,
        reason: 'NO_CHARGES_REMAINING',
      },
    );
  }

  const eqMsgCountBefore = game?.messages?.size ?? 0;
  const eqTargetId = target.id;
  let eqThrew: string | null = null;
  let toMessageReturn: { id?: string } | undefined;
  try {
    toMessageReturn = await target.toMessage(undefined, { create: true });
  } catch (e: unknown) {
    eqThrew = e instanceof Error ? e.message : String(e);
  }
  if (eqThrew !== null) {
    return fail(
      `toMessage() threw for item '${targetName}': ${eqThrew}`,
      {
        itemId: input.itemId,
        error: eqThrew,
        reason: 'TOMESSAGE_FAILED',
      },
    );
  }

  // Decrement uses.value if this equipment tracks charges. Per Phase-1
  // Q7, equipment has no auto-decrement on toMessage — we own the
  // bookkeeping. Mirrors what the PF2e character sheet does on
  // chat-card click.
  let eqUsesAfter: number | null = eqUsesValue;
  if (eqHasUses && typeof eqUsesValue === 'number') {
    const nextValue = eqUsesValue - 1;
    await actor.updateEmbeddedDocuments('Item', [
      { _id: eqTargetId, 'system.uses.value': nextValue },
    ]);
    eqUsesAfter = nextValue;
  }

  // Recover chat message id. toMessage() with { create: true } returns
  // the created ChatMessage; fall back to diffing messages size if the
  // return is missing.
  let eqChatMessageId: string | null = null;
  const returnedId = toMessageReturn?.id;
  if (typeof returnedId === 'string') {
    eqChatMessageId = returnedId;
  } else {
    const eqMsgCountAfter = game?.messages?.size ?? 0;
    if (eqMsgCountAfter > eqMsgCountBefore) {
      const contents = game?.messages?.contents ?? [];
      const latest = contents[contents.length - 1];
      const latestId = latest?.id;
      if (typeof latestId === 'string') eqChatMessageId = latestId;
    }
  }

  const eqItem: UseItemResultItem = {
    id: eqTargetId,
    name: targetName,
    type: targetType,
    subtype,
    qtyBefore: before.qty,
    qtyAfter: before.qty,
    deleted: false,
  };
  if (eqHasUses) {
    eqItem.usesBefore = eqUsesValue ?? 0;
    eqItem.usesAfter = eqUsesAfter ?? 0;
  }

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'used',
    mode: 'message',
    item: eqItem,
    chatMessageId: eqChatMessageId,
  };
}
