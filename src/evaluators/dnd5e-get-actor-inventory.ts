/**
 * page.evaluate body for `dnd5e_get_actor_inventory`. Returns a lightweight
 * structural projection of a D&D 5e actor's physical inventory plus their
 * currency. No description text — `dnd5e_get_item_details` handles the
 * detail-view shape. D&D 5e sibling of `pf2e_get_actor_inventory`.
 *
 * Behaviour nuances confirmed by live probing against dnd5e 5.3.3 /
 * Foundry v14.361 (`scripts/probe-dnd5e-get-actor-inventory.mjs`). The 5e
 * schema differs from PF2e — no field path is ported on faith. The
 * physical-item paths are the same ones probe-verified for
 * `dnd5e_get_item_details` (see that evaluator's header):
 *
 *  - **Physical inventory types** are `weapon`, `equipment`, `consumable`,
 *    `tool`, `loot`, `container`. Every other `item.type` (`spell`, `feat`,
 *    `background`, `class`, `subclass`, `race`, `facility`) is non-physical
 *    and excluded entirely.
 *  - **No type→category remap.** Unlike PF2e (`backpack`→`container`,
 *    `ammo`→`consumable`), 5e's physical `item.type` values double as their
 *    own category — so this tool surfaces `type` only, no `category` field.
 *  - **`system.equipped`** is a bare boolean, NOT PF2e's structured
 *    `{carryType, handsHeld, ...}` object. `loot` items have no equipped
 *    state and report `false`.
 *  - **`system.attunement`** is `"required" | "optional" | ""`;
 *    `system.attuned` is a boolean. `loot` reports `""` / `false`.
 *  - **`system.identified`** defaults to `true`; explicit `false` only on
 *    unidentified items.
 *  - **`system.container`** is a bare item-id string (or absent/`null`) —
 *    the owning container's id, the 5e analogue of PF2e `system.containerId`.
 *  - **`system.price`** is `{value, denomination, valueInGP}` — denomination
 *    is one of pp/gp/ep/sp/cp. Not the PF2e per-denomination coin object.
 *  - **`system.weight`** is `{value, units}` (units typically `"lb"`).
 *  - **`system.uses`** is `{spent, max, value, recovery, ...}`. `max` is a
 *    number when the item tracks a finite charge pool, `""` when unlimited.
 *    This tool surfaces a slim `uses` block (`spent`/`max`/`value`) per item
 *    ONLY when `max` is a positive number. This is a deliberate divergence
 *    from the PF2e sibling, which omits uses entirely — 5e's charge model
 *    (wands, limited-use items) is list-view-relevant.
 *  - **Currency** lives at `actor.system.currency`, a `{pp, gp, ep, sp, cp}`
 *    object — five denominations including electrum (`ep`), which PF2e
 *    lacks. Always present, zeroed when empty. NOT at `actor.system.coins`
 *    or `actor.inventory.coins` (those are PF2e paths).
 *  - **Container coins.** `container`-type items carry their OWN
 *    `system.currency` pool (coins inside a Bag of Holding), separate from
 *    the actor's purse. Surfaced per-container as a `currency` field on the
 *    container item's projection; non-container items never carry it.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline. Only erased-at-runtime `type`/`interface`
 * declarations and the exported `PHYSICAL_ITEM_TYPES` const (consumed by
 * the tool layer only) live at module scope.
 */
export interface Dnd5eGetActorInventoryInput {
  actorId: string;
}

export interface Dnd5eCurrency {
  pp: number;
  gp: number;
  ep: number;
  sp: number;
  cp: number;
}

export interface Dnd5eInventoryItem {
  id: string;
  uuid: string;
  name: string;
  type: string;
  quantity: number;
  weight: { value: number; units: string };
  price: { value: number; denomination: string; valueInGP: number };
  /** Bare boolean (unlike PF2e's structured object); `false` on `loot`. */
  equipped: boolean;
  /** "required" | "optional" | "" — `loot` reports "". */
  attunement: string;
  attuned: boolean;
  /** Defaults to `true`; explicit `false` only on unidentified items. */
  identified: boolean;
  /** Owning container's item id, or `null` when at inventory root. */
  container: string | null;
  /** Present only when the item tracks a finite charge pool (`uses.max > 0`). */
  uses?: { spent: number; max: number; value: number };
  /** Present only on `container` items — their own coin pool. */
  currency?: Dnd5eCurrency;
}

export interface Dnd5eGetActorInventoryOk {
  ok: true;
  actorId: string;
  actorName: string;
  items: Dnd5eInventoryItem[];
  currency: Dnd5eCurrency;
}

export interface Dnd5eGetActorInventoryErr {
  ok: false;
  error: {
    code: 'ACTOR_NOT_FOUND';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eGetActorInventoryResult = Dnd5eGetActorInventoryOk | Dnd5eGetActorInventoryErr;

/**
 * The D&D 5e physical-inventory item types. Exported for the tool layer's
 * reference; the evaluator re-declares this set inline because module-scope
 * identifiers do not survive `page.evaluate` serialization.
 */
export const PHYSICAL_ITEM_TYPES = [
  'weapon',
  'equipment',
  'consumable',
  'tool',
  'loot',
  'container',
] as const;

interface FoundryItemLike {
  id?: string;
  uuid?: string;
  name?: string;
  type?: string;
  system?: Record<string, unknown>;
}

interface FoundryActorLike {
  id?: string;
  name?: string;
  items?: { contents?: FoundryItemLike[] };
  system?: { currency?: Record<string, unknown> };
}

interface FoundryGameLike {
  actors?: { get(id: string): FoundryActorLike | undefined };
}

export async function dnd5eGetActorInventoryBody(
  input: Dnd5eGetActorInventoryInput,
): Promise<Dnd5eGetActorInventoryResult> {
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

  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const PHYSICAL = new Set(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container']);

  const toNumber = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  // Build a {pp,gp,ep,sp,cp} pool from a raw currency object, zero-defaulted.
  const toCurrency = (raw: unknown): Dnd5eCurrency => {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      pp: toNumber(o.pp, 0),
      gp: toNumber(o.gp, 0),
      ep: toNumber(o.ep, 0),
      sp: toNumber(o.sp, 0),
      cp: toNumber(o.cp, 0),
    };
  };

  const items: Dnd5eInventoryItem[] = [];
  for (const item of actor.items?.contents ?? []) {
    const type = item.type ?? '';
    if (!PHYSICAL.has(type)) continue;
    if (!item.id) continue;

    const sys = item.system ?? {};

    // Price: {value, denomination, valueInGP}; defensive defaults.
    const priceRaw =
      sys.price && typeof sys.price === 'object' ? (sys.price as Record<string, unknown>) : {};
    // Weight: {value, units}; defensive defaults.
    const weightRaw =
      sys.weight && typeof sys.weight === 'object' ? (sys.weight as Record<string, unknown>) : {};

    // container: bare item-id string, or null at inventory root.
    const containerRaw = sys.container;
    const container =
      typeof containerRaw === 'string' && containerRaw.length > 0 ? containerRaw : null;

    const projected: Dnd5eInventoryItem = {
      id: item.id,
      uuid: item.uuid ?? '',
      name: item.name ?? '',
      type,
      quantity: toNumber(sys.quantity, 1),
      weight: {
        value: toNumber(weightRaw.value, 0),
        units: typeof weightRaw.units === 'string' ? weightRaw.units : 'lb',
      },
      price: {
        value: toNumber(priceRaw.value, 0),
        denomination: typeof priceRaw.denomination === 'string' ? priceRaw.denomination : 'gp',
        valueInGP: toNumber(priceRaw.valueInGP, 0),
      },
      equipped: sys.equipped === true,
      attunement: typeof sys.attunement === 'string' ? sys.attunement : '',
      attuned: sys.attuned === true,
      identified: sys.identified !== false,
      container,
    };

    // Uses: surface a slim block only for a real finite charge pool. `max`
    // is a positive number when tracking charges, "" (or absent) otherwise.
    if (sys.uses && typeof sys.uses === 'object') {
      const usesRaw = sys.uses as Record<string, unknown>;
      const max = usesRaw.max;
      if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
        projected.uses = {
          spent: toNumber(usesRaw.spent, 0),
          max,
          value: toNumber(usesRaw.value, 0),
        };
      }
    }

    // Container coins: containers carry their own currency pool, separate
    // from the actor's purse. Surface it per-container.
    if (type === 'container' && sys.currency && typeof sys.currency === 'object') {
      projected.currency = toCurrency(sys.currency);
    }

    items.push(projected);
  }

  const currency = toCurrency(actor.system?.currency);

  return {
    ok: true,
    actorId: actor.id ?? input.actorId,
    actorName: actor.name ?? '',
    items,
    currency,
  };
}
