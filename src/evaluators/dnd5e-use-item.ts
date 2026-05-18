/**
 * page.evaluate body for `dnd5e_use_item`. Runs the D&D 5e activity / use
 * pipeline for a single item embedded on an actor — the tool *runs* the
 * use pipeline (chat card, charge/quantity consumption) rather than
 * silently editing state. D&D 5e sibling of `pf2e_use_item`. Spell-scroll
 * `cast` activities are deliberately out of scope — see below.
 *
 * Behaviour confirmed by scripts/probe-dnd5e-use-item-phase1.mjs and
 * -phase2.mjs against Foundry v14.361 + dnd5e 5.3.3:
 *
 *  - D&D 5e has no PF2e `consume()` / `toMessage()` split. Every usable
 *    item carries `system.activities` — an `ActivityCollection`
 *    (Map-like: `.contents`, `.get(id)`, `.filter()`). Each activity has
 *    `.id`, `.type`, `.name`, a `.canUse` boolean, and an async
 *    `.use(usageConfig, dialogConfig, messageConfig)` method. An item
 *    with zero activities has no mechanical "use" (`Item5e#use` just
 *    posts a description card) — this tool rejects it
 *    (`ITEM_HAS_NO_ACTIVITIES`).
 *  - `Item5e#use()` auto-picks `activities[0]` and, for multi-activity
 *    items, opens an `ActivityChoiceDialog` unless the call carries a
 *    shiftKey event. This evaluator sidesteps that entirely: it resolves
 *    the activity itself (by `activityId`, or the first `canUse` one)
 *    and calls `activity.use(...)` directly.
 *  - DIALOG-FREE PATH: `activity.use({ event: { shiftKey: true } },
 *    { configure: false }, {})`. `configure: false` suppresses the
 *    usage dialog; the shiftKey event suppresses the multi-activity
 *    choice dialog. The call is also raced against a 30s timeout
 *    (`USE_TIMED_OUT`) so a hung pipeline call returns a clean error
 *    instead of wedging the MCP call until the protocol timeout.
 *  - `activity.use(...)` returns `{ effects, templates, updates,
 *    message }` on success; `message` is the created `ChatMessage`
 *    (`message.id` is the chat-card id). Charge/quantity bookkeeping is
 *    automatic: a consumable with `uses.autoDestroy` and a stack
 *    decrements `system.quantity` on use (and is DELETED when the last
 *    is consumed); a charge-tracked item decrements `system.uses.spent`.
 *    This evaluator only snapshots before/after — it never mutates
 *    counters itself.
 *  - `cast`-type activities (spell scrolls) are REJECTED
 *    (`CAST_ACTIVITY_UNSUPPORTED`). dnd5e's `CastActivity#use` spawns a
 *    hidden cached-spell item on the actor; when the scroll then
 *    auto-destroys, that cached spell is orphaned, and on the next world
 *    load its dangling `cachedFor` link recurses dnd5e data preparation
 *    into a stack overflow — corrupting the world for EVERY client.
 *    Until a tool can reliably clean that up, casting scrolls is out of
 *    scope: use the scroll from the Foundry UI. When an item carries a
 *    mix of `cast` and non-`cast` activities, auto-selection prefers a
 *    non-`cast` one; only an item whose chosen activity is `cast` is
 *    rejected.
 *  - `activity.canUse` is `false` when an item has no remaining
 *    charges/quantity; the evaluator gates on it up front
 *    (`NO_CHARGES_REMAINING`) so callers never see `ok: true` for a
 *    use that the system would silently refuse.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface Dnd5eUseItemInput {
  actorId: string;
  itemId: string;
  /** Optional activity id to run; when null, the first usable activity is chosen. */
  activityId: string | null;
}

export interface Dnd5eUseItemResultItem {
  id: string;
  name: string;
  type: string;
  /** `system.type.value` (consumable subtype etc.); `null` when absent. */
  subtype: string | null;
  quantityBefore: number | null;
  quantityAfter: number | null;
  /** Present only when the item tracks charges (`uses.max` is a positive number). */
  usesSpentBefore?: number;
  usesSpentAfter?: number;
  usesValueBefore?: number;
  usesValueAfter?: number;
  /** True when the use consumed the last copy and the item was removed. */
  deleted: boolean;
}

export interface Dnd5eUseItemOk {
  ok: true;
  actor: { id: string; name: string };
  operation: 'used';
  activity: { id: string; type: string; name: string };
  item: Dnd5eUseItemResultItem;
  /** Chat message id if a card was posted; `null` otherwise. */
  chatMessageId: string | null;
}

export interface Dnd5eUseItemErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details: Record<string, unknown> & { reason: string };
  };
}

export type Dnd5eUseItemResult = Dnd5eUseItemOk | Dnd5eUseItemErr;

export async function dnd5eUseItemBody(
  input: Dnd5eUseItemInput,
): Promise<Dnd5eUseItemResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ActivityLike {
    id?: string;
    type?: string;
    name?: string;
    canUse?: boolean;
    use(
      usage: AnyRecord,
      dialog: AnyRecord,
      message: AnyRecord,
    ): Promise<{ message?: { id?: string } } | undefined>;
  }
  interface ActivityCollectionLike {
    contents?: ActivityLike[];
    get?(id: string): ActivityLike | undefined;
  }
  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    items?: { get?(id: string): ItemDocLike | undefined };
  }
  interface MessagesLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }

  const SUPPORTED_ACTOR_TYPES = new Set(['character', 'npc']);

  const fail = (
    message: string,
    details: Record<string, unknown> & { reason: string },
  ): Dnd5eUseItemErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const readNumber = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // Snapshot the counters used for before/after comparison.
  const snapshot = (
    item: ItemDocLike | undefined,
  ): {
    quantity: number | null;
    usesSpent: number | null;
    usesValue: number | null;
    usesMax: number | null;
  } => {
    const sys = (item?.system as AnyRecord | undefined) ?? {};
    const uses = sys.uses as AnyRecord | undefined;
    return {
      quantity: readNumber(sys.quantity),
      usesSpent: uses ? readNumber(uses.spent) : null,
      usesValue: uses ? readNumber(uses.value) : null,
      usesMax: uses ? readNumber(uses.max) : null,
    };
  };

  // -- Resolve actor. -------------------------------------------------
  const game = (globalThis as unknown as {
    game?: {
      actors?: { get(id: string): ActorDocLike | undefined };
      messages?: MessagesLike;
    };
  }).game;
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
      `dnd5e_use_item supports character and npc actors; actor '${actor.name ?? input.actorId}' is type '${actorType}'.`,
      { reason: 'ACTOR_TYPE_UNSUPPORTED', actorId: input.actorId, type: actorType },
    );
  }

  // -- Resolve target item. -------------------------------------------
  const item = actor.items?.get?.(input.itemId);
  if (!item || !item.id) {
    return fail(
      `No item found on actor ${actor.id ?? input.actorId} for itemId: ${input.itemId}`,
      { reason: 'ITEM_NOT_FOUND_ON_ACTOR', actorId: input.actorId, itemId: input.itemId },
    );
  }
  const itemName = typeof item.name === 'string' ? item.name : '';
  const itemType = typeof item.type === 'string' ? item.type : '';
  const sys = (item.system as AnyRecord | undefined) ?? {};
  const subtypeRaw = (sys.type as AnyRecord | undefined)?.value;
  const subtype = typeof subtypeRaw === 'string' ? subtypeRaw : null;

  // -- Resolve the activity to run. -----------------------------------
  const activities = sys.activities as ActivityCollectionLike | undefined;
  const activityList = Array.isArray(activities?.contents) ? activities.contents : [];
  if (activityList.length === 0) {
    return fail(
      `Item '${itemName}' has no activities — there is nothing to use. Items without an ` +
        `activity (plain loot, mundane gear) have no use pipeline; for silent inventory ` +
        `edits use dnd5e_update_item_uses or dnd5e_remove_item_from_actor.`,
      { reason: 'ITEM_HAS_NO_ACTIVITIES', itemId: input.itemId, type: itemType },
    );
  }

  let activity: ActivityLike | undefined;
  if (input.activityId !== null) {
    activity = activities?.get?.(input.activityId);
    if (!activity) {
      return fail(
        `Item '${itemName}' has no activity with id '${input.activityId}'.`,
        {
          reason: 'ACTIVITY_NOT_FOUND',
          itemId: input.itemId,
          activityId: input.activityId,
          availableActivityIds: activityList.map((a) => a.id ?? ''),
        },
      );
    }
  } else {
    // Auto-selection prefers a non-`cast` activity so a multi-activity
    // item (cast + something else) is still usable; a scroll whose only
    // activity is `cast` falls through to the rejection below.
    const nonCast = activityList.filter((a) => a.type !== 'cast');
    const pool = nonCast.length > 0 ? nonCast : activityList;
    activity = pool.find((a) => a.canUse === true) ?? pool[0];
  }
  if (!activity) {
    return fail(`Could not resolve an activity to run on item '${itemName}'.`, {
      reason: 'ACTIVITY_NOT_FOUND',
      itemId: input.itemId,
    });
  }
  const activityId = typeof activity.id === 'string' ? activity.id : '';
  const activityType = typeof activity.type === 'string' ? activity.type : '';
  const activityName = typeof activity.name === 'string' ? activity.name : '';

  // -- Reject `cast` activities (spell scrolls). ----------------------
  // dnd5e's CastActivity#use spawns a hidden cached-spell item on the
  // actor; when the scroll auto-destroys, that cached spell is orphaned
  // and its dangling `cachedFor` link recurses world-load data prep
  // into a stack overflow that corrupts the world for every client.
  if (activityType === 'cast') {
    return fail(
      `Activity '${activityName || activityId}' on item '${itemName}' is a spell-scroll ` +
        `cast (activity type 'cast'), which dnd5e_use_item does not support: casting a ` +
        `scroll through the API leaves an orphaned cached-spell item that corrupts world ` +
        `load. Cast the scroll from the Foundry UI instead.`,
      { reason: 'CAST_ACTIVITY_UNSUPPORTED', itemId: input.itemId, activityId },
    );
  }

  // -- Charge gate: the system silently refuses an unusable activity. -
  if (activity.canUse === false) {
    return fail(
      `Activity '${activityName || activityId}' on item '${itemName}' cannot be used right ` +
        `now — it has no remaining charges or quantity. Recharge with dnd5e_update_item_uses ` +
        `or restock with dnd5e_update_item_quantity before using.`,
      { reason: 'NO_CHARGES_REMAINING', itemId: input.itemId, activityId },
    );
  }

  // -- Run the activity-use pipeline (dialog-free path). --------------
  const before = snapshot(item);
  const itemIdBefore = item.id;
  const msgCountBefore = game?.messages?.size ?? 0;

  // The use call is raced against a timeout: a use pipeline that opens
  // an undismissable dialog would otherwise wedge `page.evaluate` until
  // puppeteer's protocol timeout (~180s). Racing returns a clean
  // `USE_TIMED_OUT` instead. (The abandoned operation may still settle
  // browser-side — acceptable: the supported activity types complete in
  // a few seconds, so a timeout here signals a genuine fault.)
  const USE_TIMEOUT_MS = 30000;
  type UseRace =
    | { value: { message?: { id?: string } } | undefined }
    | { error: string }
    | { timedOut: true };
  const raced: UseRace = await Promise.race<UseRace>([
    activity
      .use({ event: { shiftKey: true } }, { configure: false }, {})
      .then((v): UseRace => ({ value: v }))
      .catch((e: unknown): UseRace => ({
        error: e instanceof Error ? e.message : String(e),
      })),
    new Promise<UseRace>((res) =>
      setTimeout(() => res({ timedOut: true }), USE_TIMEOUT_MS),
    ),
  ]);
  if ('timedOut' in raced) {
    return fail(
      `Using activity '${activityName || activityId}' on '${itemName}' did not complete ` +
        `within ${USE_TIMEOUT_MS / 1000}s — the use pipeline may have opened a dialog the ` +
        `headless client cannot dismiss. The operation was abandoned.`,
      { reason: 'USE_TIMED_OUT', itemId: input.itemId, activityId },
    );
  }
  if ('error' in raced) {
    return fail(`Using activity '${activityName || activityId}' threw: ${raced.error}`, {
      reason: 'USE_FAILED',
      itemId: input.itemId,
      activityId,
      error: raced.error,
    });
  }
  const useReturn: { message?: { id?: string } } | undefined = raced.value;

  // -- Re-resolve: autoDestroy may have removed the item. -------------
  const liveAfter = actor.items?.get?.(itemIdBefore);
  const deleted = !liveAfter;
  const after = deleted
    ? { quantity: null, usesSpent: null, usesValue: null, usesMax: null }
    : snapshot(liveAfter);

  // -- Recover the chat message id. -----------------------------------
  let chatMessageId: string | null = null;
  const returnedId = useReturn?.message?.id;
  if (typeof returnedId === 'string' && returnedId.length > 0) {
    chatMessageId = returnedId;
  } else if ((game?.messages?.size ?? 0) > msgCountBefore) {
    const contents = game?.messages?.contents ?? [];
    const latestId = contents[contents.length - 1]?.id;
    if (typeof latestId === 'string') chatMessageId = latestId;
  }

  // -- Detect a silent no-op (returned nothing, changed nothing). -----
  const nothingChanged =
    !deleted &&
    before.quantity === after.quantity &&
    before.usesSpent === after.usesSpent &&
    chatMessageId === null &&
    !useReturn;
  if (nothingChanged) {
    return fail(
      `Using activity '${activityName || activityId}' on '${itemName}' had no effect — no ` +
        `chat card was posted and no charge or quantity changed.`,
      { reason: 'USE_HAD_NO_EFFECT', itemId: input.itemId, activityId },
    );
  }

  const resultItem: Dnd5eUseItemResultItem = {
    id: itemIdBefore,
    name: itemName,
    type: itemType,
    subtype,
    quantityBefore: before.quantity,
    quantityAfter: deleted ? 0 : after.quantity,
    deleted,
  };
  if (typeof before.usesMax === 'number' && before.usesMax > 0) {
    resultItem.usesSpentBefore = before.usesSpent ?? 0;
    resultItem.usesSpentAfter = deleted ? 0 : (after.usesSpent ?? 0);
    resultItem.usesValueBefore = before.usesValue ?? 0;
    resultItem.usesValueAfter = deleted ? 0 : (after.usesValue ?? 0);
  }

  return {
    ok: true,
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    operation: 'used',
    activity: { id: activityId, type: activityType, name: activityName },
    item: resultItem,
    chatMessageId,
  };
}
