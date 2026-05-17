/**
 * page.evaluate body for `dnd5e_get_item_details`. Returns full per-item
 * data for any D&D 5e Foundry Item resolved by UUID. D&D 5e sibling of
 * `pf2e_get_item_details`: UUID-input, shared physical block, per-type
 * projection, dual-shape descriptions, opt-in escape hatches.
 *
 * **Scope.** Read-only. Works on compendium-resident items (the `uuid`
 * returned by `dnd5e_search_compendium`) and actor-embedded items
 * (`Actor.{id}.Item.{id}`). Every D&D 5e Item type gets a typed projection.
 *
 * Behaviour nuances confirmed by live probing against dnd5e 5.3.3 /
 * Foundry v14.361 (`scripts/probe-dnd5e-get-item-details.mjs`). No field
 * path is ported from the PF2e sibling on faith — the 5e schema differs:
 *
 *  - **Item subtypes** (`CONFIG.Item.dataModels`): `weapon`, `equipment`,
 *    `consumable`, `tool`, `loot`, `container`, `feat`, `spell`,
 *    `background`, `class`, `subclass`, `race`, `facility`. All thirteen
 *    get a typed projection.
 *  - **Physical types** carry `system.quantity` / `weight` / `price`:
 *    `weapon`, `equipment`, `consumable`, `tool`, `loot`, `container`.
 *    They get the shared `physical` block. `loot` is the odd one — it has
 *    quantity/weight/price/identified/container but NOT equipped /
 *    attunement / attuned (those default to false / "").
 *  - **Subtype.** Most physical types carry `system.type` as an OBJECT
 *    `{value, baseItem?, subtype?, label?}` — `value` is the mechanical
 *    subtype (weapon "martialM", equipment "light", consumable "scroll",
 *    tool "art", loot category). `container`, `spell`, `background`,
 *    `class`, `subclass` have NO `system.type`; `race` and `feat` carry it.
 *  - **Price.** `system.price` is `{value, denomination, valueInGP}` —
 *    denomination is one of pp/gp/ep/sp/cp. Not the PF2e per-denomination
 *    coin object.
 *  - **Weight.** `system.weight` is `{value, units}`.
 *  - **`system.uses`** is `{spent, max, recovery, value, label}` (+
 *    `autoDestroy` on consumables). `max` is `""` when the item has no
 *    charge limit; `value` is the system-computed *remaining* count. This
 *    evaluator surfaces `uses` at the top level ONLY when `max` is a
 *    positive number (real charge tracking) — exposing `spent`, `max`,
 *    `value` (remaining), `recovery`, and `autoDestroy` verbatim.
 *  - **Sets.** `system.properties` (weapon/equipment/consumable/tool/loot/
 *    container/spell/feat/class) and `system.damage.base.types` are `Set`
 *    instances. `JSON.stringify` of a `Set` yields `{}` — every Set MUST
 *    be read with `Array.from()` inside this evaluator (see `setToArray`).
 *  - **`system.advancement`** is an `AdvancementCollection` — Map-like,
 *    NOT an array; `Object.keys()` returns `[]`. Iterate `.contents`.
 *    Projected as a lightweight `[{type, title, level}]` summary.
 *  - **`item.labels`.** The dnd5e system computes a fully-resolved,
 *    sheet-ready `labels` object during data prep: `labels.damage`,
 *    `labels.damages: [{formula, label, damageType}]`, `labels.toHit`,
 *    `labels.range`, `labels.reach`, `labels.activation`, `labels.duration`,
 *    `labels.components: {vsm, tags, full, all}` (spells), `labels.school`,
 *    `labels.level`, `labels.armor`. Used for the human-readable strings —
 *    it sidesteps re-deriving 2014-vs-2024 ruleset math.
 *  - **`system.container`** is a bare item-id string (or `null`) — the
 *    container-membership link, the 5e analogue of PF2e `containerId`.
 *  - **Description.** `system.description.value` (HTML). Physical items
 *    also carry `system.description.unidentified`; not projected.
 *  - **`_stats.compendiumSource`** is the canonical source UUID;
 *    `system.source` is `{book, page, license, rules, label, value}`.
 *  - **5e spell scrolls** do NOT embed a spell document the way PF2e
 *    scroll/wand consumables do — a scroll is a `consumable` with
 *    `type.value === "scroll"` and its effect lives in `system.activities`.
 *    There is no embedded-spell expansion to do.
 *
 * `includeEffects` (named to match `dnd5e_get_creature_details`) projects
 * the item's Active Effects — the D&D 5e analogue of the PF2e
 * rule-elements opt-in. `includeRawSystem` dumps the full `system` blob.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline. Only erased-at-runtime `type`/`interface`
 * declarations and the exported `PROJECTED_ITEM_TYPES` const (consumed by
 * the tool layer only) live at module scope.
 */
export interface Dnd5eGetItemDetailsInput {
  uuid: string;
  descriptionFormat: 'html' | 'text' | 'both';
  includeEffects: boolean;
  includeRawSystem: boolean;
}

export interface UsesBlock {
  /** Charges consumed. */
  spent: number;
  /** Maximum charges (always a positive number when this block is present). */
  max: number;
  /** System-computed remaining charges (`max - spent`). */
  value: number;
  /** Raw recovery-period descriptors. */
  recovery: unknown[];
  /** Consumables only — destroy the item when the last charge is spent. */
  autoDestroy?: boolean;
}

export interface PhysicalBlock {
  quantity: number;
  weight: { value: number; units: string };
  price: { value: number; denomination: string; valueInGP: number };
  /** "200 gp"; empty string when the price value is zero. */
  priceFormatted: string;
  equipped: boolean;
  /** "required" | "optional" | "" — `loot` has no attunement and reports "". */
  attunement: string;
  attuned: boolean;
  identified: boolean;
  /** Owning container's item id, or `null` when at inventory root. */
  container: string | null;
  /** Item durability — present on weapon/equipment; omitted otherwise. */
  hp?: { value: number; max: number; dt: number | null };
}

export interface AdvancementSummary {
  type: string;
  title: string;
  level: number;
}

export interface EffectEntry {
  id: string;
  name: string;
  disabled: boolean;
  transfer: boolean;
  durationSeconds: number | null;
  changesCount: number;
}

export interface Dnd5eGetItemDetailsOk {
  ok: true;
  uuid: string;
  id: string;
  name: string;
  type: string;
  img: string;

  sourceUuid: string | null;
  source: string | null;
  /** The dnd5e slug-style identifier (`system.identifier`), or null. */
  identifier: string | null;
  /** "" for mundane physical items, a rarity tier when magical, null when the type has no rarity. */
  rarity: string | null;

  description?: string;
  descriptionText?: string;

  /** Present only when the item tracks a finite charge pool (`uses.max > 0`). */
  uses?: UsesBlock;

  // Exactly one of the following is populated, keyed by `type`.
  weapon?: Record<string, unknown>;
  equipment?: Record<string, unknown>;
  consumable?: Record<string, unknown>;
  tool?: Record<string, unknown>;
  loot?: Record<string, unknown>;
  container?: Record<string, unknown>;
  spell?: Record<string, unknown>;
  feat?: Record<string, unknown>;
  background?: Record<string, unknown>;
  class?: Record<string, unknown>;
  subclass?: Record<string, unknown>;
  race?: Record<string, unknown>;
  facility?: Record<string, unknown>;

  physical?: PhysicalBlock;

  effects?: EffectEntry[];
  rawSystem?: Record<string, unknown>;
}

export interface Dnd5eGetItemDetailsErr {
  ok: false;
  error: {
    code: 'NOT_FOUND' | 'WRONG_DOCUMENT_TYPE';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eGetItemDetailsResult = Dnd5eGetItemDetailsOk | Dnd5eGetItemDetailsErr;

declare function fromUuid(uuid: string): Promise<unknown>;

/**
 * Item types this evaluator emits a typed projection for. Exported so the
 * tool layer can warn on the (schema-unreachable, but defensible) case of
 * the projection returning a type that isn't one of these — in which case
 * the evaluator force-includes `rawSystem`.
 */
export const PROJECTED_ITEM_TYPES = [
  'weapon',
  'equipment',
  'consumable',
  'tool',
  'loot',
  'container',
  'spell',
  'feat',
  'background',
  'class',
  'subclass',
  'race',
  'facility',
] as const;

export async function dnd5eGetItemDetailsBody(
  input: Dnd5eGetItemDetailsInput,
): Promise<Dnd5eGetItemDetailsResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const PHYSICAL_ITEM_TYPES = new Set([
    'weapon',
    'equipment',
    'consumable',
    'tool',
    'loot',
    'container',
  ]);

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface FoundryDoc {
    documentName?: string;
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    img?: string;
    system?: AnyRecord;
    labels?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
    effects?: { contents?: EffectDocLike[] };
  }
  interface EffectDocLike {
    id?: string;
    name?: string;
    disabled?: boolean;
    transfer?: boolean;
    duration?: { seconds?: unknown };
    changes?: unknown[];
  }

  const doc = (await fromUuid(input.uuid)) as FoundryDoc | null;
  if (!doc) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `No item found for uuid: ${input.uuid}`,
        details: { uuid: input.uuid },
      },
    };
  }
  if (doc.documentName !== 'Item') {
    return {
      ok: false,
      error: {
        code: 'WRONG_DOCUMENT_TYPE',
        message: `UUID resolved to ${doc.documentName ?? 'unknown'}, expected Item: ${input.uuid}`,
        details: { uuid: input.uuid, documentName: doc.documentName ?? null },
      },
    };
  }

  const sys = (doc.system ?? {}) as AnyRecord;
  const labels = (doc.labels ?? {}) as AnyRecord;
  const type: string = doc.type ?? '';

  // ---- helpers (inlined; closures don't survive page.evaluate) -----------

  const get = (o: unknown, k: string): unknown =>
    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;

  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

  /** Resolve a `Set` (or array / keyed object) to a string array. */
  const setToArray = (v: unknown): string[] => {
    if (v instanceof Set) return Array.from(v).filter((x): x is string => typeof x === 'string');
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (v && typeof v === 'object') return Object.keys(v);
    return [];
  };

  /** Strip HTML tags while preserving paragraph structure. */
  const stripHtml = (html: unknown): string => {
    if (typeof html !== 'string' || html.length === 0) return '';
    const withBreaks = html
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '</$1>\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(ul|ol)>/gi, '\n');
    const div = document.createElement('div');
    div.innerHTML = withBreaks;
    const text = (div.textContent ?? '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  };

  // Apply the descriptionFormat-driven dual-shape to any HTML field.
  const applyDescFormat = (
    target: Record<string, unknown>,
    htmlField: string,
    textField: string,
    raw: unknown,
  ): void => {
    if (input.descriptionFormat === 'html' || input.descriptionFormat === 'both') {
      target[htmlField] = typeof raw === 'string' ? raw : '';
    }
    if (input.descriptionFormat === 'text' || input.descriptionFormat === 'both') {
      target[textField] = stripHtml(raw);
    }
  };

  /** Project a `{number, denomination, bonus, types}` dice descriptor. */
  const projectDicePart = (v: unknown): Record<string, unknown> => {
    const o = obj(v) ?? {};
    return {
      number: typeof o.number === 'number' ? o.number : null,
      denomination: typeof o.denomination === 'number' ? o.denomination : null,
      bonus: str(o.bonus),
      types: setToArray(o.types),
    };
  };

  /** Project `system.advancement` (an AdvancementCollection) to a slim summary. */
  const projectAdvancement = (): AdvancementSummary[] => {
    const advRaw = get(sys, 'advancement');
    let entries: unknown[] = [];
    if (Array.isArray(advRaw)) entries = advRaw;
    else if (advRaw && Array.isArray((advRaw as { contents?: unknown[] }).contents)) {
      entries = (advRaw as { contents: unknown[] }).contents;
    } else if (advRaw && typeof advRaw === 'object') entries = Object.values(advRaw);
    return entries
      .map((a) => ({
        type: str(get(a, 'type')),
        title: str(get(a, 'title')),
        level: num(get(a, 'level')),
      }))
      .filter((a) => a.type.length > 0);
  };

  // ---- common fields -----------------------------------------------------

  const sourceObj = obj(get(sys, 'source'));
  const source = sourceObj
    ? str(sourceObj.label) || str(sourceObj.value) || str(sourceObj.book) || null
    : null;
  const sourceUuidRaw = get(doc._stats, 'compendiumSource');
  const sourceUuid = typeof sourceUuidRaw === 'string' ? sourceUuidRaw : null;

  const identifierRaw = get(sys, 'identifier');
  const identifier = typeof identifierRaw === 'string' ? identifierRaw : null;
  const rarityRaw = get(sys, 'rarity');
  const rarity = typeof rarityRaw === 'string' ? rarityRaw : null;

  const out: Dnd5eGetItemDetailsOk = {
    ok: true,
    uuid: str(doc.uuid, input.uuid),
    id: str(doc.id),
    name: str(doc.name),
    type,
    img: str(doc.img),
    sourceUuid,
    source,
    identifier,
    rarity,
  };

  applyDescFormat(
    out as unknown as Record<string, unknown>,
    'description',
    'descriptionText',
    get(obj(get(sys, 'description')), 'value'),
  );

  // ---- shared uses block -------------------------------------------------
  // 5e's uses model is cross-cutting (weapon/equipment/consumable/tool/feat/
  // spell/facility). Surface it once, at the top level, only when there is
  // a real finite charge pool (`max` is a positive number).
  const usesRaw = obj(get(sys, 'uses'));
  if (usesRaw) {
    const maxRaw = usesRaw.max;
    const max = typeof maxRaw === 'number' ? maxRaw : null;
    if (max !== null && max > 0) {
      const usesBlock: UsesBlock = {
        spent: num(usesRaw.spent),
        max,
        value: num(usesRaw.value),
        recovery: Array.isArray(usesRaw.recovery) ? (usesRaw.recovery as unknown[]) : [],
      };
      if (typeof usesRaw.autoDestroy === 'boolean') usesBlock.autoDestroy = usesRaw.autoDestroy;
      out.uses = usesBlock;
    }
  }

  // ---- per-type projection ----------------------------------------------
  const typeObj = obj(get(sys, 'type'));
  const properties = setToArray(get(sys, 'properties'));
  let projected = false;

  switch (type) {
    case 'weapon': {
      const damageRaw = obj(get(sys, 'damage')) ?? {};
      const versRaw = obj(damageRaw.versatile);
      out.weapon = {
        weaponType: str(get(typeObj, 'value')),
        baseItem: str(get(typeObj, 'baseItem')) || null,
        damage: {
          formula: str(get(labels, 'damage')) || null,
          parts: Array.isArray(get(labels, 'damages'))
            ? (get(labels, 'damages') as unknown[]).map((d) => ({
                formula: str(get(d, 'formula')),
                label: str(get(d, 'label')),
                damageType: str(get(d, 'damageType')),
              }))
            : [],
          base: projectDicePart(damageRaw.base),
          versatile:
            versRaw && typeof versRaw.number === 'number' ? projectDicePart(versRaw) : null,
        },
        range: ((): Record<string, unknown> | null => {
          const r = obj(get(sys, 'range'));
          return r
            ? {
                value: typeof r.value === 'number' ? r.value : null,
                long: typeof r.long === 'number' ? r.long : null,
                reach: typeof r.reach === 'number' ? r.reach : null,
                units: str(r.units),
              }
            : null;
        })(),
        properties,
        mastery: str(get(sys, 'mastery')) || null,
        magicalBonus: get(sys, 'magicalBonus') ?? null,
        proficient: get(sys, 'proficient') ?? null,
        attackLabel: str(get(labels, 'toHit')) || null,
        ammunition: get(sys, 'ammunition') ?? null,
      };
      projected = true;
      break;
    }
    case 'equipment': {
      const armorRaw = obj(get(sys, 'armor'));
      out.equipment = {
        equipmentType: str(get(typeObj, 'value')),
        baseItem: str(get(typeObj, 'baseItem')) || null,
        armor: armorRaw
          ? {
              value: typeof armorRaw.value === 'number' ? armorRaw.value : null,
              base: typeof armorRaw.base === 'number' ? armorRaw.base : null,
              dex: typeof armorRaw.dex === 'number' ? armorRaw.dex : null,
              magicalBonus: armorRaw.magicalBonus ?? null,
            }
          : null,
        armorClassLabel: str(get(labels, 'armor')) || null,
        strength: get(sys, 'strength') ?? null,
        proficient: get(sys, 'proficient') ?? null,
        properties,
      };
      projected = true;
      break;
    }
    case 'consumable': {
      const damageRaw = obj(get(sys, 'damage'));
      out.consumable = {
        consumableType: str(get(typeObj, 'value')),
        subtype: str(get(typeObj, 'subtype')) || null,
        magicalBonus: get(sys, 'magicalBonus') ?? null,
        damage: damageRaw
          ? { base: projectDicePart(damageRaw.base), replace: damageRaw.replace === true }
          : null,
        properties,
      };
      projected = true;
      break;
    }
    case 'tool': {
      out.tool = {
        toolType: str(get(typeObj, 'value')),
        baseItem: str(get(typeObj, 'baseItem')) || null,
        ability: str(get(sys, 'ability')) || null,
        proficient: get(sys, 'proficient') ?? null,
        bonus: get(sys, 'bonus') ?? null,
        properties,
      };
      projected = true;
      break;
    }
    case 'loot': {
      out.loot = {
        lootType: str(get(typeObj, 'value')) || null,
        subtype: str(get(typeObj, 'subtype')) || null,
        properties,
      };
      projected = true;
      break;
    }
    case 'container': {
      out.container = {
        capacity: obj(get(sys, 'capacity')) ?? null,
        currency: obj(get(sys, 'currency')) ?? null,
        properties,
      };
      projected = true;
      break;
    }
    case 'spell': {
      out.spell = {
        level: num(get(sys, 'level')),
        levelLabel: str(get(labels, 'level')) || null,
        school: str(get(sys, 'school')) || null,
        schoolLabel: str(get(labels, 'school')) || null,
        properties,
        components: obj(get(labels, 'components')) ?? null,
        materials: obj(get(sys, 'materials')) ?? null,
        activation: ((): Record<string, unknown> => {
          const a = obj(get(sys, 'activation')) ?? {};
          return {
            type: str(a.type) || null,
            value: typeof a.value === 'number' ? a.value : null,
            condition: str(a.condition) || null,
            label: str(get(labels, 'activation')) || null,
          };
        })(),
        duration: ((): Record<string, unknown> => {
          const d = obj(get(sys, 'duration')) ?? {};
          return {
            value: typeof d.value === 'number' ? d.value : d.value ?? null,
            units: str(d.units) || null,
            concentration: d.concentration === true,
            label: str(get(labels, 'duration')) || null,
          };
        })(),
        range: ((): Record<string, unknown> => {
          const r = obj(get(sys, 'range')) ?? {};
          return {
            value: typeof r.value === 'number' ? r.value : r.value ?? null,
            units: str(r.units) || null,
            label: str(get(labels, 'range')) || null,
          };
        })(),
        target: ((): Record<string, unknown> => {
          const t = obj(get(sys, 'target')) ?? {};
          const affects = obj(t.affects) ?? {};
          return {
            affects: {
              count: affects.count ?? null,
              type: str(affects.type) || null,
              choice: affects.choice === true,
            },
            label: str(get(labels, 'target')) || null,
          };
        })(),
        method: str(get(sys, 'method')) || null,
        prepared: get(sys, 'prepared') ?? null,
      };
      projected = true;
      break;
    }
    case 'feat': {
      out.feat = {
        featType: str(get(typeObj, 'value')) || null,
        subtype: str(get(typeObj, 'subtype')) || null,
        requirements: str(get(sys, 'requirements')) || null,
        prerequisites: obj(get(sys, 'prerequisites')) ?? null,
        properties,
        advancement: projectAdvancement(),
      };
      projected = true;
      break;
    }
    case 'background': {
      out.background = {
        startingEquipment: Array.isArray(get(sys, 'startingEquipment'))
          ? (get(sys, 'startingEquipment') as unknown[])
          : [],
        wealth: get(sys, 'wealth') ?? null,
        advancement: projectAdvancement(),
      };
      projected = true;
      break;
    }
    case 'class': {
      const hdRaw = obj(get(sys, 'hd'));
      out.class = {
        identifier,
        hitDice: str(get(hdRaw, 'denomination')) || null,
        hd: hdRaw
          ? {
              denomination: str(hdRaw.denomination) || null,
              spent: num(hdRaw.spent),
              max: num(hdRaw.max),
              value: num(hdRaw.value),
              additional: num(hdRaw.additional),
            }
          : null,
        levels: typeof get(sys, 'levels') === 'number' ? get(sys, 'levels') : null,
        primaryAbility: obj(get(sys, 'primaryAbility')) ?? null,
        spellcasting: obj(get(sys, 'spellcasting')) ?? null,
        isOriginalClass: get(sys, 'isOriginalClass') === true,
        startingEquipment: Array.isArray(get(sys, 'startingEquipment'))
          ? (get(sys, 'startingEquipment') as unknown[])
          : [],
        properties,
        advancement: projectAdvancement(),
      };
      projected = true;
      break;
    }
    case 'subclass': {
      out.subclass = {
        identifier,
        classIdentifier: str(get(sys, 'classIdentifier')) || null,
        spellcasting: obj(get(sys, 'spellcasting')) ?? null,
        advancement: projectAdvancement(),
      };
      projected = true;
      break;
    }
    case 'race': {
      const moveRaw = obj(get(sys, 'movement')) ?? {};
      const sensesRaw = obj(get(sys, 'senses')) ?? {};
      out.race = {
        creatureType: typeObj
          ? {
              value: str(typeObj.value),
              subtype: str(typeObj.subtype),
              custom: str(typeObj.custom),
            }
          : null,
        movement: {
          walk: num(moveRaw.walk),
          units: str(moveRaw.units, 'ft'),
          hover: moveRaw.hover === true,
        },
        senses: {
          darkvision: num(sensesRaw.darkvision),
          blindsight: num(sensesRaw.blindsight),
          tremorsense: num(sensesRaw.tremorsense),
          truesight: num(sensesRaw.truesight),
          special: str(sensesRaw.special),
          units: str(sensesRaw.units, 'ft'),
        },
        advancement: projectAdvancement(),
      };
      projected = true;
      break;
    }
    case 'facility': {
      out.facility = {
        facilityType: str(get(typeObj, 'value')) || null,
        subtype: str(get(typeObj, 'subtype')) || null,
        size: str(get(sys, 'size')) || null,
        level: typeof get(sys, 'level') === 'number' ? get(sys, 'level') : null,
        order: str(get(sys, 'order')) || null,
        building: obj(get(sys, 'building')) ?? null,
        progress: obj(get(sys, 'progress')) ?? null,
        disabled: get(sys, 'disabled') === true,
        free: get(sys, 'free') === true,
        hirelings: get(sys, 'hirelings') ?? null,
        defenders: get(sys, 'defenders') ?? null,
        craft: get(sys, 'craft') ?? null,
        trade: get(sys, 'trade') ?? null,
      };
      projected = true;
      break;
    }
    default:
      projected = false;
  }

  // ---- shared physical block --------------------------------------------
  if (PHYSICAL_ITEM_TYPES.has(type)) {
    const priceRaw = obj(get(sys, 'price')) ?? {};
    const weightRaw = obj(get(sys, 'weight')) ?? {};
    const priceValue = num(priceRaw.value);
    const denomination = str(priceRaw.denomination);
    const containerRaw = get(sys, 'container');

    const physical: PhysicalBlock = {
      quantity: num(get(sys, 'quantity'), 1),
      weight: { value: num(weightRaw.value), units: str(weightRaw.units, 'lb') },
      price: {
        value: priceValue,
        denomination,
        valueInGP: num(priceRaw.valueInGP),
      },
      priceFormatted: priceValue > 0 ? `${priceValue} ${denomination}` : '',
      equipped: get(sys, 'equipped') === true,
      attunement: str(get(sys, 'attunement')),
      attuned: get(sys, 'attuned') === true,
      identified: get(sys, 'identified') !== false,
      container: typeof containerRaw === 'string' && containerRaw.length > 0 ? containerRaw : null,
    };

    const hpRaw = obj(get(sys, 'hp'));
    if (hpRaw && (typeof hpRaw.max === 'number' || typeof hpRaw.value === 'number')) {
      physical.hp = {
        value: num(hpRaw.value),
        max: num(hpRaw.max),
        dt: typeof hpRaw.dt === 'number' ? hpRaw.dt : null,
      };
    }

    out.physical = physical;
  }

  // ---- opt-in escape hatches --------------------------------------------
  if (input.includeEffects) {
    const effectContents = Array.isArray(doc.effects?.contents) ? doc.effects.contents : [];
    out.effects = effectContents.map((e) => {
      const secs = get(e.duration, 'seconds');
      return {
        id: str(e.id),
        name: str(e.name),
        disabled: e.disabled === true,
        transfer: e.transfer === true,
        durationSeconds: typeof secs === 'number' ? secs : null,
        changesCount: Array.isArray(e.changes) ? e.changes.length : 0,
      };
    });
  }

  // The live `system` carries class instances (Set, AdvancementCollection,
  // ActivityCollection) that the CDP structured-clone pipeline drops to
  // `undefined`. A JSON round-trip coerces them to plain wire-safe values.
  // Force-included when no typed projection was emitted.
  if (input.includeRawSystem || !projected) {
    try {
      out.rawSystem = JSON.parse(JSON.stringify(sys)) as Record<string, unknown>;
    } catch {
      out.rawSystem = {};
    }
  }

  return out;
}
