/**
 * page.evaluate body for get_actor_inventory. Returns a lightweight
 * structural projection of an actor's physical inventory plus their
 * currency. No description text — get_item_details handles the
 * detail-view shape.
 *
 * Behavior nuances confirmed by scripts/probe-actor-inventory*.mjs
 * against Foundry v14.361 + PF2e 8.1.2:
 *  - Physical inventory types are: weapon, armor, shield, consumable,
 *    equipment, treasure, backpack, ammo. All other item.type values
 *    (lore, ancestry, background, feat, class, action, heritage, spell,
 *    condition, effect, melee, etc.) are non-physical and excluded.
 *    `melee` in particular is NPC strike definitions, NOT a melee weapon.
 *  - `system.equipped` on physical items is an object with
 *    `{carryType, handsHeld, invested?, inSlot?}`. carryType is one of
 *    "worn" | "stowed" | "held". We surface the structured shape as-is.
 *  - `system.containerId` is a key on physical items (null for top-level,
 *    string id for items inside a container). It is absent entirely on
 *    non-physical items; we project null when absent or null.
 *  - `system.bulk` is `{value, per, heldOrStowed?, capacity?, ignored?}`.
 *    Only `value` and `per` are inventory-relevant — the others are
 *    container internals. value=0.1 displays as "L" (light) in the PF2e
 *    UI; per matters for stacks (ammo per:10, copper per:1000).
 *  - `system.runes` lives only on weapon/armor/shield and has DIFFERENT
 *    shapes per type:
 *      weapon: {potency, striking, property[], effects[]}
 *      armor:  {potency, resilient, property[]}  (note: resilient, not striking)
 *      shield: {reinforcing}
 *    The legacy potencyRune/strikingRune/propertyRuneN fields are
 *    consolidated and no longer set. We pass through PF2e's shape rather
 *    than imposing a single one, so per-type rune branching lives in the
 *    consumer.
 *  - Currency is NOT on `actor.system.coins` (that field is absent). The
 *    canonical aggregator is `actor.inventory.coins`, a Coins instance
 *    with `{pp, gp, sp, cp}` numeric fields, computed from treasure items
 *    with stackGroup: "coins". Always present, zero on NPCs without coin
 *    items. PF2e also exposes `credits` and `upb` (Starfinder denominations)
 *    on the same object — we omit those.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface GetActorInventoryInput {
  actorId: string;
}

export interface InventoryItem {
  id: string;
  uuid: string;
  name: string;
  type: string;
  category: 'weapon' | 'armor' | 'shield' | 'consumable' | 'equipment' | 'treasure' | 'container';
  quantity: number;
  equipped: Record<string, unknown> | null;
  containerId: string | null;
  bulk: { value: number; per: number } | null;
  traits: string[];
  level: number | null;
  // Present only on weapon/armor/shield. Shape varies by type; see file header.
  runes?: Record<string, unknown>;
}

export interface Currency {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
}

export interface GetActorInventoryOk {
  ok: true;
  actorId: string;
  actorName: string;
  items: InventoryItem[];
  currency: Currency;
}

export interface GetActorInventoryErr {
  ok: false;
  error: {
    code: 'ACTOR_NOT_FOUND';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type GetActorInventoryResult = GetActorInventoryOk | GetActorInventoryErr;

interface FoundryItemLike {
  id?: string;
  uuid?: string;
  name?: string;
  type?: string;
  system?: {
    equipped?: Record<string, unknown>;
    containerId?: string | null;
    bulk?: { value?: unknown; per?: unknown };
    traits?: { value?: unknown };
    level?: { value?: unknown } | number;
    quantity?: unknown;
    runes?: Record<string, unknown>;
  };
}

interface FoundryActorLike {
  id?: string;
  name?: string;
  items?: { contents?: FoundryItemLike[] };
  inventory?: {
    coins?: { pp?: unknown; gp?: unknown; sp?: unknown; cp?: unknown };
  };
}

interface FoundryGameLike {
  actors?: { get(id: string): FoundryActorLike | undefined };
}

export async function getActorInventoryBody(
  input: GetActorInventoryInput,
): Promise<GetActorInventoryResult> {
  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return {
      ok: false,
      error: {
        code: 'ACTOR_NOT_FOUND',
        message: `No world actor with id "${input.actorId}".`,
        details: { actorId: input.actorId },
      },
    };
  }

  // Physical-inventory type → category mapping. Anything not in this map
  // is non-physical and excluded entirely.
  const categoryByType: Record<string, InventoryItem['category']> = {
    weapon: 'weapon',
    armor: 'armor',
    shield: 'shield',
    consumable: 'consumable',
    equipment: 'equipment',
    treasure: 'treasure',
    backpack: 'container',
    ammo: 'consumable',
  };

  // Types that carry rune data. Other physical types (consumable, equipment,
  // treasure, backpack, ammo) never have a runes field.
  const typesWithRunes = new Set(['weapon', 'armor', 'shield']);

  const toNumber = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const items: InventoryItem[] = [];
  for (const item of actor.items?.contents ?? []) {
    const type = item.type ?? '';
    const category = categoryByType[type];
    if (!category) continue;
    if (!item.id) continue;

    const sys = item.system ?? {};

    // Equipped: pass through the structured object as PF2e exposes it,
    // dropping only undefined values. carryType / handsHeld / invested /
    // inSlot are kept even when null because null is semantically meaningful
    // ("invested: null" = invested doesn't apply to this item).
    let equipped: Record<string, unknown> | null = null;
    if (sys.equipped && typeof sys.equipped === 'object') {
      equipped = {};
      for (const [k, v] of Object.entries(sys.equipped)) {
        if (v !== undefined) equipped[k] = v;
      }
    }

    // containerId: null when absent or explicitly null; string id otherwise.
    const containerId =
      typeof sys.containerId === 'string' && sys.containerId.length > 0 ? sys.containerId : null;

    // Bulk: project only value + per. Other fields are container internals.
    let bulk: { value: number; per: number } | null = null;
    if (sys.bulk && typeof sys.bulk === 'object') {
      const value = sys.bulk.value;
      const per = sys.bulk.per;
      if (typeof value === 'number') {
        bulk = { value, per: typeof per === 'number' ? per : 1 };
      }
    }

    // Traits: array of slug strings; default to [] when absent or malformed.
    const traitsRaw = sys.traits?.value;
    const traits =
      Array.isArray(traitsRaw) && traitsRaw.every((t) => typeof t === 'string')
        ? (traitsRaw as string[])
        : [];

    // Level: PF2e stores level as {value: number} on physical items. Some
    // homebrew may store it as a bare number; accept both. Null when absent.
    let level: number | null = null;
    if (sys.level !== undefined) {
      if (typeof sys.level === 'number') {
        level = sys.level;
      } else if (sys.level && typeof sys.level.value === 'number') {
        level = sys.level.value;
      }
    }

    const projected: InventoryItem = {
      id: item.id,
      uuid: item.uuid ?? '',
      name: item.name ?? '',
      type,
      category,
      quantity: toNumber(sys.quantity, 1),
      equipped,
      containerId,
      bulk,
      traits,
      level,
    };

    // Runes are present only on weapon/armor/shield. Shape varies; pass
    // through unchanged so the consumer sees whatever PF2e actually stores.
    if (typesWithRunes.has(type) && sys.runes && typeof sys.runes === 'object') {
      projected.runes = sys.runes;
    }

    items.push(projected);
  }

  const coins = actor.inventory?.coins ?? null;
  const currency: Currency = {
    pp: toNumber(coins?.pp, 0),
    gp: toNumber(coins?.gp, 0),
    sp: toNumber(coins?.sp, 0),
    cp: toNumber(coins?.cp, 0),
  };

  return {
    ok: true,
    actorId: actor.id ?? input.actorId,
    actorName: actor.name ?? '',
    items,
    currency,
  };
}
