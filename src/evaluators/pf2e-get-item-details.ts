/**
 * page.evaluate body for pf2e_get_item_details. Returns full per-item data for
 * any Foundry Item resolved by UUID. Companion to pf2e_get_actor_inventory:
 * inventory returns only structural fields, this returns the detail view
 * (description, traits, runes, type-specific projection, plus the shared
 * physical-item block).
 *
 * Behavior nuances confirmed by scripts/probe-get-item-details.mjs against
 * Foundry v14.361 + PF2e 8.1.2:
 *  - `await fromUuid(uuid)` resolves both `Actor.{actorId}.Item.{itemId}`
 *    (world-actor-embedded) and `Compendium.{packId}.Item.{docId}`
 *    (compendium-resident) uniformly, returning null for malformed/missing
 *    UUIDs without throwing. We use the async form rather than
 *    `fromUuidSync` because the sync variant returns null for compendium
 *    packs that haven't been preloaded.
 *  - `item._stats.compendiumSource` is the canonical v14 field for
 *    "original compendium source UUID". Present on both world-actor items
 *    (pointing back to the compendium template) and compendium items
 *    (equal to the item's own uuid). Legacy `flags.core.sourceId` exists
 *    for back-compat but is the deprecated path.
 *  - `system.publication` is PF2e sourcebook info — `{title, authors,
 *    license, remaster}`. Useful provenance for AI consumers wanting to
 *    cite rules. PF2e gives ad-hoc / system-default items an empty stamp
 *    (`{title: "", ..., license: "OGL", remaster: false}`); we collapse
 *    that to `null` so consumers can use `publication == null` as the
 *    unambiguous "no real source" check.
 *  - PF2e 8.1.2 weapons have no top-level `system.hands` field; the
 *    hands count lives at `system.usage.hands` and is surfaced via the
 *    shared `physical.usage.hands` block. We deliberately do not emit
 *    a `weapon.hands` field.
 *  - PF2e descriptions are HTML with @-syntax inline references
 *    (`@UUID[...]{Label}`, `@Damage[1d6[slashing]]`, `@Check[reflex|dc:20]`).
 *    These are semantic. When stripping HTML, we strip only the tags;
 *    @-syntax is preserved verbatim.
 *  - Rune shape is asymmetric per type (this already bit pf2e_get_actor_inventory):
 *      weapon: {potency, striking, property[], effects[]}
 *      armor:  {potency, resilient, property[]}
 *      shield: {reinforcing}  — a single number, NOT a nested object
 *      other:  no `runes` field at all
 *  - `system.identification.status` is "identified" or "unidentified".
 *    `system.identification.identified.name` and `unidentified.name` carry
 *    the alternate names. We surface both.
 *  - Keyed-object shapes (`{<randomId>: {...}}`) for variable-length embedded
 *    sub-documents get flattened to arrays for consumer ergonomics. This
 *    applies to: feat `prerequisites.value`, ancestry/background `items`,
 *    spell `damage` and `heightening.damage`. For spell damage, the
 *    original key is preserved as an `id` field on each entry so the
 *    heightening damage entries can be matched back to the base ones.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline.
 */
export interface Pf2eGetItemDetailsInput {
  uuid: string;
  descriptionFormat: 'html' | 'text' | 'both';
  includeRules: boolean;
  includeRawSystem: boolean;
}

export interface PublicationInfo {
  title: string;
  authors: string;
  license: string;
  remaster: boolean;
}

export interface PriceValue {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
  credits: number;
  upb: number;
}

export interface PhysicalBlock {
  bulk: { value: number; per: number };
  price: { value: PriceValue; per: number };
  /** Largest-first, space-joined ("1 gp 3 sp"). Empty string when price is zero across all denominations. */
  priceFormatted: string;
  quantity: number;
  equipped: Record<string, unknown>;
  identification: {
    status: 'identified' | 'unidentified';
    identifiedName: string;
    unidentifiedName: string;
  };
  hardness: number;
  hp: { value: number; max: number; brokenThreshold?: number };
  size: string;
  material: Record<string, unknown> | null;
  containerId: string | null;
  stackGroup: string | null;
  usage: { value: string; type: string; hands?: number; where?: string };
}

export interface Pf2eGetItemDetailsOk {
  ok: true;
  uuid: string;
  id: string;
  name: string;
  type: string;
  img: string;

  sourceUuid: string | null;
  /**
   * PF2e sourcebook citation. Normalized to `null` when no real source is
   * present — PF2e gives ad-hoc / system-default items (player-added Lore
   * items, etc.) an effectively empty publication stamp like `{title: "",
   * authors: "", license: "OGL", remaster: false}`; an empty `title` is
   * treated as the sentinel and collapses to `null`. Consumers can rely
   * on `publication == null` as the unambiguous "no source" check.
   */
  publication: PublicationInfo | null;

  description?: string;
  descriptionText?: string;

  traits: string[];
  rarity: string | null;
  level: number | null;
  slug: string | null;

  // Exactly one of the following is populated based on `type`. Unknown
  // types fall through to the `rawSystem` escape hatch.
  weapon?: Record<string, unknown>;
  armor?: Record<string, unknown>;
  shield?: Record<string, unknown>;
  consumable?: Record<string, unknown>;
  equipment?: Record<string, unknown>;
  container?: Record<string, unknown>;
  treasure?: Record<string, unknown>;
  ammo?: Record<string, unknown>;
  feat?: Record<string, unknown>;
  action?: Record<string, unknown>;
  ancestry?: Record<string, unknown>;
  heritage?: Record<string, unknown>;
  background?: Record<string, unknown>;
  class?: Record<string, unknown>;
  lore?: Record<string, unknown>;
  spell?: Record<string, unknown>;

  physical?: PhysicalBlock;

  rules?: unknown[];
  rawSystem?: Record<string, unknown>;
}

export interface Pf2eGetItemDetailsErr {
  ok: false;
  error: {
    code: 'NOT_FOUND' | 'WRONG_DOCUMENT_TYPE';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Pf2eGetItemDetailsResult = Pf2eGetItemDetailsOk | Pf2eGetItemDetailsErr;

declare function fromUuid(uuid: string): Promise<unknown>;

/**
 * Item types this evaluator emits a typed projection for. Exported so the
 * tool layer can determine whether to surface the unknown-type warning
 * (the evaluator already forces `rawSystem` inclusion in that case).
 */
export const PROJECTED_ITEM_TYPES = [
  'weapon',
  'armor',
  'shield',
  'consumable',
  'equipment',
  'backpack',
  'treasure',
  'ammo',
  'feat',
  'action',
  'ancestry',
  'heritage',
  'background',
  'class',
  'lore',
  'spell',
] as const;

export async function pf2eGetItemDetailsBody(
  input: Pf2eGetItemDetailsInput,
): Promise<Pf2eGetItemDetailsResult> {
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

  // The Foundry document shape is dynamic across PF2e item types; cast once
  // at the boundary and rely on `?.` access below rather than threading a
  // forest of structural types through every per-type projection.
  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };
  interface FoundryDoc {
    documentName?: string;
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    img?: string;
    system?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
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
  const type: string = doc.type ?? '';

  // ---- helpers (inlined; closures don't survive page.evaluate) -----------

  const get = (obj: unknown, key: string): unknown =>
    obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;

  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

  /** Strip HTML tags while preserving paragraph structure and @-syntax. */
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

  /** Flatten PF2e's `{<key>: {...}}` keyed-object pattern into a plain array. */
  const flattenKeyed = (v: unknown): unknown[] => {
    const o = obj(v);
    return o ? Object.values(o) : [];
  };

  /** Flatten and preserve the original key as an `id` field on each entry. */
  const flattenKeyedWithId = (v: unknown): Record<string, unknown>[] => {
    const o = obj(v);
    if (!o) return [];
    return Object.entries(o).map(([id, value]) => {
      const inner = obj(value);
      return inner ? { id, ...inner } : { id, value };
    });
  };

  /** Format a price value to a human string: "1 gp 3 sp", "" if all zero. */
  const formatPrice = (value: PriceValue): string => {
    const parts: string[] = [];
    if (value.pp > 0) parts.push(`${value.pp} pp`);
    if (value.gp > 0) parts.push(`${value.gp} gp`);
    if (value.sp > 0) parts.push(`${value.sp} sp`);
    if (value.cp > 0) parts.push(`${value.cp} cp`);
    return parts.join(' ');
  };

  // ---- common fields -----------------------------------------------------

  const traitsRaw = get(get(sys, 'traits'), 'value');
  const traits: string[] =
    Array.isArray(traitsRaw) && traitsRaw.every((t) => typeof t === 'string')
      ? (traitsRaw as string[])
      : [];
  const rarityRaw = get(get(sys, 'traits'), 'rarity');
  const rarity = typeof rarityRaw === 'string' ? rarityRaw : null;

  let level: number | null = null;
  const levelRaw = get(sys, 'level');
  if (typeof levelRaw === 'number') {
    level = levelRaw;
  } else {
    const lv = get(levelRaw, 'value');
    if (typeof lv === 'number') level = lv;
  }

  const slugRaw = get(sys, 'slug');
  const slug = typeof slugRaw === 'string' ? slugRaw : null;

  const sourceUuidRaw = get(doc._stats, 'compendiumSource');
  const sourceUuid = typeof sourceUuidRaw === 'string' ? sourceUuidRaw : null;

  // Normalize empty publication objects to null. PF2e gives ad-hoc /
  // system-default items (e.g. a player-added Lore item) an effectively
  // empty publication stamp like `{title: "", authors: "", license:
  // "OGL", remaster: false}`. Treat an empty `title` as the sentinel for
  // "no real source"; consumers can rely on `publication == null` as the
  // unambiguous check.
  let publication: PublicationInfo | null = null;
  const pubRaw = obj(get(sys, 'publication'));
  if (pubRaw) {
    const title = str(pubRaw.title);
    if (title.length > 0) {
      publication = {
        title,
        authors: str(pubRaw.authors),
        license: str(pubRaw.license),
        remaster: pubRaw.remaster === true,
      };
    }
  }

  const out: Pf2eGetItemDetailsOk = {
    ok: true,
    uuid: str(doc.uuid, input.uuid),
    id: str(doc.id),
    name: str(doc.name),
    type,
    img: str(doc.img),
    sourceUuid,
    publication,
    traits,
    rarity,
    level,
    slug,
  };

  // ---- description -------------------------------------------------------
  const rawHtml = get(get(sys, 'description'), 'value');
  if (input.descriptionFormat === 'html' || input.descriptionFormat === 'both') {
    out.description = typeof rawHtml === 'string' ? rawHtml : '';
  }
  if (input.descriptionFormat === 'text' || input.descriptionFormat === 'both') {
    out.descriptionText = stripHtml(rawHtml);
  }

  // ---- per-type projection ----------------------------------------------
  let projected = false;
  switch (type) {
    case 'weapon': {
      // Note: hands-count info for weapons lives at `system.usage.hands`,
      // surfaced via the shared `physical.usage.hands` block — NOT at
      // `system.hands`, which is absent on PF2e 8.1.2 weapons. We
      // deliberately do not project a `weapon.hands` field; readers
      // wanting the hands count should look at `physical.usage.hands`.
      const damage = obj(get(sys, 'damage')) ?? {};
      out.weapon = {
        damage: {
          dice: num(damage.dice, 0),
          die: str(damage.die),
          damageType: str(damage.damageType),
          modifier: num(damage.modifier, 0),
          persistent: damage.persistent ?? null,
        },
        group: str(get(sys, 'group')),
        range: get(sys, 'range') ?? null,
        reload: get(get(sys, 'reload'), 'value') ?? null,
        runes: get(sys, 'runes') ?? null,
        splashDamage: get(get(sys, 'splashDamage'), 'value') ?? null,
        bonusDamage: get(get(sys, 'bonusDamage'), 'value') ?? null,
        category: str(get(sys, 'category')),
        baseItem: get(sys, 'baseItem') ?? null,
      };
      projected = true;
      break;
    }
    case 'armor': {
      out.armor = {
        acBonus: num(get(sys, 'acBonus'), 0),
        dexCap: num(get(sys, 'dexCap'), 0),
        checkPenalty: num(get(sys, 'checkPenalty'), 0),
        speedPenalty: num(get(sys, 'speedPenalty'), 0),
        strength: get(sys, 'strength') ?? null,
        category: str(get(sys, 'category')),
        group: str(get(sys, 'group')),
        baseItem: get(sys, 'baseItem') ?? null,
        runes: get(sys, 'runes') ?? null,
      };
      projected = true;
      break;
    }
    case 'shield': {
      out.shield = {
        acBonus: num(get(sys, 'acBonus'), 0),
        speedPenalty: num(get(sys, 'speedPenalty'), 0),
        runes: get(sys, 'runes') ?? null,
        specific: get(sys, 'specific') ?? null,
        baseItem: get(sys, 'baseItem') ?? null,
      };
      projected = true;
      break;
    }
    case 'consumable': {
      const uses = obj(get(sys, 'uses'));
      out.consumable = {
        category: str(get(sys, 'category')),
        uses: uses
          ? {
              value: num(uses.value, 0),
              max: num(uses.max, 0),
              autoDestroy: uses.autoDestroy === true,
            }
          : null,
        damage: get(sys, 'damage') ?? null,
        spell: get(sys, 'spell') ?? null,
        baseItem: get(sys, 'baseItem') ?? null,
      };
      projected = true;
      break;
    }
    case 'equipment': {
      out.equipment = {
        baseItem: get(sys, 'baseItem') ?? null,
        category: str(get(sys, 'category')),
      };
      projected = true;
      break;
    }
    case 'backpack': {
      out.container = {
        stowing: get(sys, 'stowing') === true,
        collapsed: get(sys, 'collapsed') === true,
        baseItem: get(sys, 'baseItem') ?? null,
      };
      projected = true;
      break;
    }
    case 'treasure': {
      out.treasure = {
        category: str(get(sys, 'category')),
      };
      projected = true;
      break;
    }
    case 'ammo': {
      out.ammo = {
        stackGroup: get(sys, 'stackGroup') ?? null,
        category: str(get(sys, 'category')),
      };
      projected = true;
      break;
    }
    case 'feat': {
      const prereqs = get(get(sys, 'prerequisites'), 'value');
      const prerequisites: string[] = Array.isArray(prereqs)
        ? prereqs
            .map((p: unknown) => {
              const inner = obj(p);
              return inner && typeof inner.value === 'string' ? inner.value : null;
            })
            .filter((v): v is string => typeof v === 'string')
        : [];
      out.feat = {
        actionType: get(get(sys, 'actionType'), 'value') ?? null,
        actions: get(get(sys, 'actions'), 'value') ?? null,
        prerequisites,
        category: str(get(sys, 'category')),
        frequency: get(sys, 'frequency') ?? null,
        trigger: get(sys, 'trigger') ?? null,
        requirements: get(sys, 'requirements') ?? null,
        maxTakable: get(sys, 'maxTakable') ?? null,
        onlyLevel1: get(sys, 'onlyLevel1') === true,
        taken: get(get(sys, 'level'), 'taken') ?? null,
      };
      projected = true;
      break;
    }
    case 'action': {
      out.action = {
        actionType: get(get(sys, 'actionType'), 'value') ?? null,
        actions: get(get(sys, 'actions'), 'value') ?? null,
        category: str(get(sys, 'category')),
        frequency: get(sys, 'frequency') ?? null,
        trigger: get(sys, 'trigger') ?? null,
        requirements: get(sys, 'requirements') ?? null,
      };
      projected = true;
      break;
    }
    case 'ancestry': {
      out.ancestry = {
        hp: num(get(sys, 'hp'), 0),
        size: str(get(sys, 'size')),
        speed: num(get(sys, 'speed'), 0),
        vision: str(get(sys, 'vision')),
        reach: num(get(sys, 'reach'), 0),
        hands: num(get(sys, 'hands'), 2),
        boosts: get(sys, 'boosts') ?? null,
        flaws: get(sys, 'flaws') ?? null,
        languages: get(sys, 'languages') ?? null,
        additionalLanguages: get(sys, 'additionalLanguages') ?? null,
        grantedItems: flattenKeyed(get(sys, 'items')),
      };
      projected = true;
      break;
    }
    case 'heritage': {
      const ancestrySlug = get(get(sys, 'ancestry'), 'slug');
      out.heritage = {
        ancestry: ancestrySlug ?? get(sys, 'ancestry') ?? null,
      };
      projected = true;
      break;
    }
    case 'background': {
      out.background = {
        boosts: get(sys, 'boosts') ?? null,
        trainedSkills: get(sys, 'trainedSkills') ?? null,
        grantedItems: flattenKeyed(get(sys, 'items')),
      };
      projected = true;
      break;
    }
    case 'class': {
      out.class = {
        hp: num(get(sys, 'hp'), 0),
        keyAbility: get(sys, 'keyAbility') ?? null,
        attacks: get(sys, 'attacks') ?? null,
        defenses: get(sys, 'defenses') ?? null,
        savingThrows: get(sys, 'savingThrows') ?? null,
        perception: get(sys, 'perception') ?? null,
        trainedSkills: get(sys, 'trainedSkills') ?? null,
        classFeatLevels: get(sys, 'classFeatLevels') ?? null,
        ancestryFeatLevels: get(sys, 'ancestryFeatLevels') ?? null,
        generalFeatLevels: get(sys, 'generalFeatLevels') ?? null,
        skillFeatLevels: get(sys, 'skillFeatLevels') ?? null,
        skillIncreaseLevels: get(sys, 'skillIncreaseLevels') ?? null,
        spellcasting: get(sys, 'spellcasting') ?? null,
      };
      projected = true;
      break;
    }
    case 'lore': {
      const rank = num(get(get(sys, 'proficient'), 'value'), 0);
      const labels = ['untrained', 'trained', 'expert', 'master', 'legendary'];
      out.lore = {
        mod: num(get(get(sys, 'mod'), 'value'), 0),
        proficiencyRank: rank,
        proficiencyLabel: labels[rank] ?? 'untrained',
      };
      projected = true;
      break;
    }
    case 'spell': {
      const damageArr = flattenKeyedWithId(get(sys, 'damage'));
      const heightening = obj(get(sys, 'heightening'));
      const heighteningDamageRaw = obj(heightening?.damage);
      const heighteningDamage: Array<{ id: string; formula: string }> = heighteningDamageRaw
        ? Object.entries(heighteningDamageRaw).map(([id, formula]) => ({
            id,
            formula: typeof formula === 'string' ? formula : str(formula),
          }))
        : [];
      // Spell traditions live on `system.traits.traditions` in PF2e remaster
      // — NOT on `system.traditions` (that path is empty / absent).
      out.spell = {
        level: num(get(get(sys, 'level'), 'value'), 0),
        traditions: get(get(sys, 'traits'), 'traditions') ?? null,
        time: get(get(sys, 'time'), 'value') ?? null,
        target: get(get(sys, 'target'), 'value') ?? null,
        range: get(get(sys, 'range'), 'value') ?? null,
        area: get(sys, 'area') ?? null,
        duration: get(get(sys, 'duration'), 'value') ?? null,
        defense: get(sys, 'defense') ?? null,
        damage: damageArr,
        heightening: heightening
          ? {
              type: heightening.type ?? null,
              interval: heightening.interval ?? null,
              damage: heighteningDamage,
            }
          : null,
        category: get(get(sys, 'category'), 'value') ?? get(sys, 'category') ?? null,
        cost: get(get(sys, 'cost'), 'value') ?? null,
        requirements: get(sys, 'requirements') ?? null,
        counteraction: get(sys, 'counteraction') === true,
      };
      projected = true;
      break;
    }
    default:
      projected = false;
  }

  // ---- shared physical block --------------------------------------------
  if (PHYSICAL_ITEM_TYPES.has(type)) {
    const priceValueRaw = obj(get(get(sys, 'price'), 'value')) ?? {};
    const priceValue: PriceValue = {
      pp: num(priceValueRaw.pp, 0),
      gp: num(priceValueRaw.gp, 0),
      sp: num(priceValueRaw.sp, 0),
      cp: num(priceValueRaw.cp, 0),
      credits: num(priceValueRaw.credits, 0),
      upb: num(priceValueRaw.upb, 0),
    };

    const identStatus: 'identified' | 'unidentified' =
      get(get(sys, 'identification'), 'status') === 'unidentified' ? 'unidentified' : 'identified';

    const equippedSource = obj(get(sys, 'equipped')) ?? {};
    const equipped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(equippedSource)) {
      if (v !== undefined) equipped[k] = v;
    }

    const hpRaw = obj(get(sys, 'hp')) ?? {};
    const hp: { value: number; max: number; brokenThreshold?: number } = {
      value: num(hpRaw.value, 0),
      max: num(hpRaw.max, 0),
    };
    if (typeof hpRaw.brokenThreshold === 'number') {
      hp.brokenThreshold = hpRaw.brokenThreshold;
    }

    const usageRaw = obj(get(sys, 'usage')) ?? {};
    const usage: { value: string; type: string; hands?: number; where?: string } = {
      value: str(usageRaw.value),
      type: str(usageRaw.type),
    };
    if (typeof usageRaw.hands === 'number') usage.hands = usageRaw.hands;
    if (typeof usageRaw.where === 'string') usage.where = usageRaw.where;

    const containerIdRaw = get(sys, 'containerId');
    const stackGroupRaw = get(sys, 'stackGroup');

    out.physical = {
      bulk: {
        value: num(get(get(sys, 'bulk'), 'value'), 0),
        per: num(get(get(sys, 'bulk'), 'per'), 1),
      },
      price: {
        value: priceValue,
        per: num(get(get(sys, 'price'), 'per'), 1),
      },
      priceFormatted: formatPrice(priceValue),
      quantity: num(get(sys, 'quantity'), 1),
      equipped,
      identification: {
        status: identStatus,
        identifiedName: str(get(get(get(sys, 'identification'), 'identified'), 'name')),
        unidentifiedName: str(get(get(get(sys, 'identification'), 'unidentified'), 'name')),
      },
      hardness: num(get(sys, 'hardness'), 0),
      hp,
      size: str(get(sys, 'size')),
      material: obj(get(sys, 'material')),
      containerId:
        typeof containerIdRaw === 'string' && containerIdRaw.length > 0 ? containerIdRaw : null,
      stackGroup:
        typeof stackGroupRaw === 'string' && stackGroupRaw.length > 0 ? stackGroupRaw : null,
      usage,
    };
  }

  // ---- opt-in escape hatches --------------------------------------------
  if (input.includeRules) {
    const rulesRaw = get(sys, 'rules');
    out.rules = Array.isArray(rulesRaw) ? rulesRaw : [];
  }
  // Force-include rawSystem when no typed projection was emitted (the
  // projection is the ergonomic surface; without one, fall back to raw).
  if (input.includeRawSystem || !projected) {
    out.rawSystem = sys;
  }

  return out;
}
