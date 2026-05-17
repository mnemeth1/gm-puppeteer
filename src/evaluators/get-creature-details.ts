/**
 * page.evaluate body for pf2e_get_creature_details. Returns full per-creature
 * data for any Foundry Actor of type `npc`, `hazard`, or `familiar`
 * resolved by UUID. NPC sibling of pf2e_get_item_details: UUID-input, per-type
 * projection, opt-in escape hatches.
 *
 * **Scope vs pf2e_get_actor_state.** This tool is the **static stat-block**
 * reference — AC, HP, saves, perception, abilities, speeds, strikes,
 * spellcasting, skills. It works on BOTH compendium-resident creatures
 * (for encounter prep before spawning) and world-resident NPCs (for
 * inspection after spawning). It deliberately does NOT enumerate
 * conditions, effects, vitals (dying/wounded/doomed), resources (hero
 * points, focus pool), or encounter state — those are runtime concerns
 * that belong to pf2e_get_actor_state.
 *
 * **Scope vs pf2e_get_actor_state on PCs.** PC actors (`type === 'character'`)
 * are rejected with ACTOR_TYPE_UNSUPPORTED. PCs go through
 * pf2e_get_actor_state — they have a different surface (class/ancestry/
 * heritage identity, hero points, full skill tree by rank) that this
 * tool doesn't model.
 *
 * Behavior nuances confirmed by Phase 1 probes against Foundry v14.361
 * + PF2e 8.1.2 (`scripts/probe-get-creature-details-phase1.mjs`):
 *
 *  - **Identification.** `actor.system.details.level.value` is the level
 *    path (same as PCs). Actors do NOT carry `system.slug` or
 *    `system.details.slug` — slugs live on items and stat children, not
 *    actor documents. We omit `slug` from the result entirely.
 *  - **Publication.** Lives at `system.details.publication`, NOT
 *    `system.publication` (the item path). Same `{title, authors,
 *    license, remaster}` shape. PF2e gives ad-hoc / system-default
 *    actors an empty stamp (`{title: "", ...}`); we collapse that to
 *    `null` using the same empty-title-sentinel as pf2e_get_item_details.
 *  - **Traits / rarity / size.** `system.traits.value` (array),
 *    `system.traits.rarity` (string), `system.traits.size.value`
 *    (e.g. "tiny", "sm", "med", "lg", etc.).
 *  - **HP.** `system.attributes.hp.{value, max, temp}` is the canonical
 *    NPC / hazard / familiar path (same field name as character).
 *    Hazard `hp` additionally exposes `brokenThreshold`. Compendium-
 *    resident familiars show `hp.value === hp.max === 0` because HP is
 *    inherited from the master at instantiation time — that's not a
 *    projection bug, that's intrinsic to the compendium snapshot.
 *  - **AC.** `system.attributes.ac.value` is the effective AC.
 *    Compendium familiars show ac.value 10 (base, master-less).
 *  - **Saves.** `system.saves.{fortitude,reflex,will}.value` is the
 *    effective save modifier (same path as character). Hazards that
 *    don't roll a particular save show `value: 0` (with `dc: 10` = base
 *    plus 10).
 *  - **Perception.** `system.perception.{value, senses}` where `value`
 *    is the effective modifier and `senses` is `[{type, range, acuity,
 *    label, ...}]`. Compendium familiars show perception.value 0
 *    (modifier inherited from master at instantiation).
 *  - **Abilities.** `system.abilities.{str,dex,con,int,wis,cha}.mod`
 *    on NPCs. **Familiars omit `system.abilities` entirely** — they use
 *    their master's modifiers per PF2e rules. We project `null` (not
 *    a zero-filled object) so consumers can tell "no ability scores
 *    here, ask the master" from "all zeros". Hazards also omit
 *    `system.abilities`; project `null` for them too.
 *  - **Speeds.** Live at `system.attributes.speed` on NPCs and
 *    `system.movement.speeds` on familiars (PF2e mirrors the character
 *    path for familiars). Both expose `{land, burrow, climb, fly, swim,
 *    travel}` as objects with `{value, base, ...}`. `land` is always
 *    present; the rest are `null` when the creature lacks that movement
 *    type. `travel` is computed and skipped. We try both paths.
 *  - **Languages.** `system.details.languages.value` — array of
 *    lowercase strings (e.g. `["common", "gnomish"]`). May be absent
 *    on hazards/familiars.
 *  - **Skills.** `system.skills` is a keyed object with ALL standard PF2e
 *    skills (acrobatics, arcana, athletics, ...) intermixed with lore
 *    skills — even for an NPC that "only has Athletics +N" in its stat
 *    block. The canonical "curated" stat-block skills are those with
 *    `base !== 0`: PF2e fills `base` from the stat-block writer's
 *    explicit modifier and leaves it 0 for skills the creature isn't
 *    trained in (the `value` may still be non-zero from ability mods).
 *    We filter to `base !== 0` and project `{slug, name, modifier}`.
 *    `rank` is `null` on NPC skills (PF2e doesn't use the proficiency-
 *    rank system on stat-block creatures); we omit it from the
 *    projection.
 *  - **Strikes.** `system.actions[]` carries the strike projection (and
 *    other action-like entries). Each strike has
 *    `{slug, label, type: 'strike', totalModifier, traits, item: {id,
 *    type: 'melee', name}, variants: [...]}`. **The embedded item is
 *    ALWAYS `type === 'melee'`** for both melee and ranged Strikes in
 *    PF2e 8.1.2 — yes, even ranged Strikes use the `melee` document
 *    type (legacy naming). Discrimination of melee-vs-ranged is on the
 *    item's `system.range` (null = melee, number = ranged). The item
 *    also carries `system.damageRolls` (keyed object, each entry
 *    `{damage, damageType, category}`) and `system.bonus.value`
 *    (redundant with action.totalModifier — we use the action's
 *    modifier as canonical). `variants` is the array of map-stepped
 *    attack rolls (Strike +N, +N MAP-5, +N MAP-10 — or -4/-8 for agile
 *    weapons). We surface `attackBonus` (first attack) plus traits —
 *    callers compute MAP from agile-trait presence.
 *  - **Actions (non-strikes).** Embedded items with `type === 'action'`
 *    capture passive, reaction, free, and active abilities. Per item:
 *    `system.actionType.value` ∈ {"action", "reaction", "free",
 *    "passive"}, `system.actions.value` ∈ {1, 2, 3, null} (only
 *    meaningful when actionType === 'action'), `system.traits.value`,
 *    `system.description.value`. We project as a single unified
 *    `actions[]` array — PF2e does NOT tag defensive-vs-offensive at
 *    the data layer; that's a stat-block layout convention. Callers
 *    wanting reactions filter on `actionType === 'reaction'`.
 *  - **Spellcasting.** `actor.spellcasting` iterates spellcasting
 *    entries plus a "rituals" pseudo-container (id="rituals",
 *    `type === null`). FILTER to `entry.type === 'spellcastingEntry'`
 *    to exclude the pseudo. Per real entry: `system.prepared.value` =
 *    category ("prepared" | "spontaneous" | "focus" | "innate"),
 *    `system.tradition.value` ∈ {"arcane","divine","occult","primal"}
 *    or "" (none), `system.slots.slot0..slot11.{value, max,
 *    prepared[]}` where slot0 = cantrips and slotN = spell rank N. NPC
 *    casters use the same shape as PC casters — a Lich's "Primal
 *    Prepared Spells" entry looks identical in structure to a Druid's.
 *  - **Hazard shape.** `system.details.isComplex: boolean` is the
 *    simple-vs-complex discriminant. `system.details.disable`,
 *    `system.details.routine`, `system.details.reset` are HTML strings
 *    (may be empty). `system.attributes.hardness: number` (NOT an
 *    object). `system.attributes.stealth.{value, dc, details}` — `dc`
 *    is the canonical Stealth DC. Some hazards (haunts, illusions)
 *    have `hp.{value, max}` both 0 — they aren't destructible.
 *    Hazards can carry embedded `melee` items for strike abilities;
 *    project those into `attacks[]` using the same StrikeEntry shape.
 *  - **Familiar shape.** `system.master: {id: string|null, ability:
 *    string}` is the master pointer. `id` is null on compendium-
 *    resident familiars (no master yet). `system.abilities` is
 *    ABSENT — confirmed; we surface `abilities: null` for familiars
 *    so consumers know to look at the master. Familiars have
 *    `system.attributes.reach` (typically 5). Their `system.attributes.hp`
 *    + `system.attributes.ac` are populated, but compendium copies
 *    show 0/0 / base 10 because those values derive from the master
 *    at instantiation. The `level` field on a compendium familiar is
 *    often 0 (informational — combat math uses master's level).
 *  - **Description.** `system.details.publicNotes` (HTML, the
 *    statblock prose) is the typical creature description path on
 *    NPCs. `system.description.value` is the item-pattern path used by
 *    items; actors typically don't populate it. We try `publicNotes`
 *    first and fall back to `description.value`. Subject to the
 *    `descriptionFormat` flag like pf2e_get_item_details.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface GetCreatureDetailsInput {
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

export interface SenseEntry {
  type: string;
  range: number | null;
  acuity: string | null;
  label: string | null;
}

export interface PerceptionBlock {
  modifier: number;
  senses: SenseEntry[];
}

export interface AbilityMods {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface SpeedsBlock {
  land: number;
  fly?: number;
  swim?: number;
  climb?: number;
  burrow?: number;
}

export interface SaveBlock {
  modifier: number;
}

export interface SkillEntry {
  slug: string;
  name: string;
  modifier: number;
}

export interface DamageRoll {
  damage: string;
  damageType: string;
  category: string | null;
}

export interface StrikeEntry {
  slug: string;
  label: string;
  weaponType: 'melee' | 'ranged';
  attackBonus: number;
  damageRolls: DamageRoll[];
  traits: string[];
  range: number | null;
  itemId: string | null;
}

export interface ActionEntry {
  id: string;
  slug: string;
  name: string;
  actionType: 'free' | 'reaction' | 'passive' | 'action' | string;
  actionCount: number | null;
  traits: string[];
  trigger: string | null;
  requirements: string | null;
  frequency: string | null;
  description?: string;
  descriptionText?: string;
}

export interface SpellSlotEntry {
  level: number;
  value: number;
  max: number;
  prepared: number;
}

export interface SpellcastingEntry {
  entryId: string;
  name: string;
  category: 'prepared' | 'spontaneous' | 'focus' | 'innate' | string;
  tradition: 'arcane' | 'divine' | 'occult' | 'primal' | null;
  slots: SpellSlotEntry[];
}

export interface ImmunityEntry {
  type: string;
  exceptions: string[];
}

export interface WeaknessEntry {
  type: string;
  value: number;
  exceptions: string[];
}

export interface ResistanceEntry {
  type: string;
  value: number;
  exceptions: string[];
  doubleVs: string[];
}

export interface IWRBlock {
  immunities: ImmunityEntry[];
  weaknesses: WeaknessEntry[];
  resistances: ResistanceEntry[];
}

export interface NpcBlock {
  ac: { value: number };
  hp: { value: number; max: number; temp: number };
  saves: { fortitude: SaveBlock; reflex: SaveBlock; will: SaveBlock };
  perception: PerceptionBlock;
  abilities: AbilityMods | null;
  speeds: SpeedsBlock;
  languages: string[];
  skills: SkillEntry[];
  strikes: StrikeEntry[];
  actions: ActionEntry[];
  spellcasting: SpellcastingEntry[];
  iwr: IWRBlock;
}

export interface HazardBlock {
  isComplex: boolean;
  hardness: number;
  hp: { value: number; max: number; brokenThreshold: number };
  stealth: { modifier: number; dc: number; details: string };
  saves: { fortitude: SaveBlock; reflex: SaveBlock; will: SaveBlock };
  disable?: string;
  disableText?: string;
  routine?: string;
  routineText?: string;
  reset?: string;
  resetText?: string;
  attacks: StrikeEntry[];
  actions: ActionEntry[];
  iwr: IWRBlock;
}

export interface FamiliarBlock {
  master: { id: string | null; ability: string } | null;
  ac: { value: number };
  hp: { value: number; max: number; temp: number };
  perception: PerceptionBlock;
  speeds: SpeedsBlock;
  abilities: null;
  reach: number | null;
  actions: ActionEntry[];
}

export interface GetCreatureDetailsOk {
  ok: true;
  uuid: string;
  id: string;
  name: string;
  type: string;
  img: string;
  level: number | null;
  traits: string[];
  rarity: string | null;
  size: string;
  sourceUuid: string | null;
  publication: PublicationInfo | null;
  description?: string;
  descriptionText?: string;

  // Exactly one of the following is populated, keyed by `type`. Unknown
  // actor subtypes (none expected — schema-enforced) fall through to
  // `rawSystem`.
  npc?: NpcBlock;
  hazard?: HazardBlock;
  familiar?: FamiliarBlock;

  rules?: unknown[];
  rawSystem?: Record<string, unknown>;
}

export interface GetCreatureDetailsErr {
  ok: false;
  error: {
    code: 'NOT_FOUND' | 'WRONG_DOCUMENT_TYPE' | 'ACTOR_TYPE_UNSUPPORTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type GetCreatureDetailsResult = GetCreatureDetailsOk | GetCreatureDetailsErr;

declare function fromUuid(uuid: string): Promise<unknown>;

/**
 * Actor types this evaluator emits a typed projection for. Exported so
 * the tool layer can warn on the (unreachable, but defensible) case of
 * the projection returning a type that isn't one of these.
 */
export const SUPPORTED_CREATURE_TYPES = ['npc', 'hazard', 'familiar'] as const;

export async function getCreatureDetailsBody(
  input: GetCreatureDetailsInput,
): Promise<GetCreatureDetailsResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['npc', 'hazard', 'familiar']);

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    flags?: AnyRecord;
  }
  interface SpellcastingEntryDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
  }
  interface FoundryDoc {
    documentName?: string;
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    img?: string;
    system?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
    items?: { contents?: ItemDocLike[]; get?(id: string): ItemDocLike | undefined };
    spellcasting?: Iterable<SpellcastingEntryDocLike>;
  }

  const doc = (await fromUuid(input.uuid)) as FoundryDoc | null;
  if (!doc) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `No actor found for uuid: ${input.uuid}`,
        details: { uuid: input.uuid },
      },
    };
  }
  if (doc.documentName !== 'Actor') {
    return {
      ok: false,
      error: {
        code: 'WRONG_DOCUMENT_TYPE',
        message: `UUID resolved to ${doc.documentName ?? 'unknown'}, expected Actor: ${input.uuid}`,
        details: { uuid: input.uuid, documentName: doc.documentName ?? null },
      },
    };
  }
  const actorType: string = doc.type ?? '';
  if (!SUPPORTED.has(actorType)) {
    return {
      ok: false,
      error: {
        code: 'ACTOR_TYPE_UNSUPPORTED',
        message:
          `Actor type '${actorType}' is not supported by pf2e_get_creature_details. ` +
          `Supported types: npc, hazard, familiar. ` +
          `For PC actors (type='character'), use pf2e_get_actor_state. ` +
          `For army/loot/party/vehicle, use foundry_eval — this tool is for creature stat blocks.`,
        details: { uuid: input.uuid, type: actorType, reason: 'ACTOR_TYPE_UNSUPPORTED' },
      },
    };
  }

  const sys = (doc.system ?? {}) as AnyRecord;

  // ---- helpers (inlined; closures don't survive page.evaluate) -----------

  const get = (o: unknown, k: string): unknown =>
    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;

  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

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

  // Apply the descriptionFormat-driven dual-shape conditionally to any
  // HTML field. Used for the base description and the hazard's
  // disable/routine/reset prose blocks.
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

  // ---- common fields -----------------------------------------------------

  const traits = strArr(get(get(sys, 'traits'), 'value'));
  const rarityRaw = get(get(sys, 'traits'), 'rarity');
  const rarity = typeof rarityRaw === 'string' ? rarityRaw : null;
  const size = str(get(get(get(sys, 'traits'), 'size'), 'value'));

  const levelRaw = get(get(sys, 'details'), 'level');
  const levelVal = get(levelRaw, 'value');
  const level: number | null = typeof levelVal === 'number' ? levelVal : null;

  const sourceUuidRaw = get(doc._stats, 'compendiumSource');
  const sourceUuid = typeof sourceUuidRaw === 'string' ? sourceUuidRaw : null;

  // Empty-title sentinel collapses to null — same rule as pf2e_get_item_details.
  let publication: PublicationInfo | null = null;
  const pubRaw = obj(get(get(sys, 'details'), 'publication'));
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

  const out: GetCreatureDetailsOk = {
    ok: true,
    uuid: str(doc.uuid, input.uuid),
    id: str(doc.id),
    name: str(doc.name),
    type: actorType,
    img: str(doc.img),
    level,
    traits,
    rarity,
    size,
    sourceUuid,
    publication,
  };

  // ---- description -------------------------------------------------------
  // NPCs and hazards use `system.details.publicNotes` for the prose
  // stat-block description; familiars (and as a fallback) may have
  // `system.description.value`. Try publicNotes first.
  const publicNotes = get(get(sys, 'details'), 'publicNotes');
  const fallbackDesc = get(get(sys, 'description'), 'value');
  const descRaw =
    typeof publicNotes === 'string' && publicNotes.length > 0 ? publicNotes : fallbackDesc;
  applyDescFormat(
    out as unknown as Record<string, unknown>,
    'description',
    'descriptionText',
    descRaw,
  );

  // ---- shared sub-projections (used by npc + hazard + familiar) ---------

  const projectSaves = (): { fortitude: SaveBlock; reflex: SaveBlock; will: SaveBlock } => {
    const savesRaw = obj(get(sys, 'saves')) ?? {};
    const f = obj(savesRaw.fortitude) ?? {};
    const r = obj(savesRaw.reflex) ?? {};
    const w = obj(savesRaw.will) ?? {};
    return {
      fortitude: { modifier: num(f.value, num(f.totalModifier, 0)) },
      reflex: { modifier: num(r.value, num(r.totalModifier, 0)) },
      will: { modifier: num(w.value, num(w.totalModifier, 0)) },
    };
  };

  const projectPerception = (): PerceptionBlock => {
    const percRaw = obj(get(sys, 'perception')) ?? {};
    const sensesRaw = Array.isArray(percRaw.senses) ? (percRaw.senses as unknown[]) : [];
    const senses: SenseEntry[] = sensesRaw
      .map((s) => {
        const so = obj(s);
        if (!so) return null;
        const senseType = str(so.type);
        if (!senseType) return null;
        return {
          type: senseType,
          range: typeof so.range === 'number' ? so.range : null,
          acuity: typeof so.acuity === 'string' ? so.acuity : null,
          label: typeof so.label === 'string' ? so.label : null,
        };
      })
      .filter((s): s is SenseEntry => s !== null);
    return {
      modifier: num(percRaw.value, num(percRaw.totalModifier, 0)),
      senses,
    };
  };

  const projectSpeeds = (): SpeedsBlock => {
    // NPCs use system.attributes.speed; familiars use system.movement.speeds.
    // Try attributes first, fall back to movement.
    const fromAttrs = obj(get(obj(get(sys, 'attributes')), 'speed'));
    const fromMovement = obj(get(obj(get(sys, 'movement')), 'speeds'));
    const speedsRaw = fromAttrs ?? fromMovement ?? {};
    const speedValue = (key: string): number | null => {
      const v = (speedsRaw as Record<string, unknown>)[key];
      if (typeof v === 'number') return v;
      const e = obj(v);
      if (!e) return null;
      return num(e.value, 0);
    };
    const out: SpeedsBlock = { land: speedValue('land') ?? 0 };
    for (const k of ['fly', 'swim', 'climb', 'burrow'] as const) {
      const v = speedValue(k);
      if (v !== null && v > 0) out[k] = v;
    }
    return out;
  };

  const projectIwr = (): IWRBlock => {
    const attrRaw = obj(get(sys, 'attributes')) ?? {};
    const immunitiesRaw = Array.isArray(attrRaw.immunities)
      ? (attrRaw.immunities as unknown[])
      : [];
    const weaknessesRaw = Array.isArray(attrRaw.weaknesses)
      ? (attrRaw.weaknesses as unknown[])
      : [];
    const resistancesRaw = Array.isArray(attrRaw.resistances)
      ? (attrRaw.resistances as unknown[])
      : [];
    return {
      immunities: immunitiesRaw
        .map((i) => {
          const io = obj(i);
          if (!io || typeof io.type !== 'string') return null;
          return { type: io.type, exceptions: strArr(io.exceptions) };
        })
        .filter((x): x is ImmunityEntry => x !== null),
      weaknesses: weaknessesRaw
        .map((w) => {
          const wo = obj(w);
          if (!wo || typeof wo.type !== 'string') return null;
          return {
            type: wo.type,
            value: num(wo.value, 0),
            exceptions: strArr(wo.exceptions),
          };
        })
        .filter((x): x is WeaknessEntry => x !== null),
      resistances: resistancesRaw
        .map((r) => {
          const ro = obj(r);
          if (!ro || typeof ro.type !== 'string') return null;
          return {
            type: ro.type,
            value: num(ro.value, 0),
            exceptions: strArr(ro.exceptions),
            doubleVs: strArr(ro.doubleVs),
          };
        })
        .filter((x): x is ResistanceEntry => x !== null),
    };
  };

  // Build an item-by-id lookup once for strike/action projections that
  // need to dereference `action.item.id` back to the underlying melee /
  // action document.
  const itemContents = Array.isArray(doc.items?.contents) ? doc.items.contents : [];
  const itemById = new Map<string, ItemDocLike>();
  for (const it of itemContents) {
    if (it && it.id) itemById.set(it.id, it);
  }

  const projectStrike = (action: AnyRecord): StrikeEntry => {
    const linkedId = str(get(obj(get(action, 'item')), 'id'));
    const linked = linkedId ? itemById.get(linkedId) : null;
    const linkedSys = (linked?.system as AnyRecord | undefined) ?? {};
    const damageMap = obj(linkedSys.damageRolls) ?? {};
    const damageRolls: DamageRoll[] = Object.values(damageMap)
      .map((d) => {
        const dr = obj(d);
        if (!dr) return null;
        return {
          damage: str(dr.damage),
          damageType: str(dr.damageType),
          category: typeof dr.category === 'string' ? dr.category : null,
        };
      })
      .filter((d): d is DamageRoll => d !== null);
    const rangeRaw = linkedSys.range;
    const range: number | null = typeof rangeRaw === 'number' ? rangeRaw : null;
    const weaponType: 'melee' | 'ranged' = range !== null ? 'ranged' : 'melee';
    // Merge traits from both action and linked item — action.traits are
    // the canonical "as a strike" trait list; linked item.system.traits.value
    // catches anything specific to the weapon. De-dupe.
    const actionTraits = strArr(get(action, 'traits'));
    const itemTraits = strArr(get(obj(linkedSys.traits), 'value'));
    const traits = Array.from(new Set([...actionTraits, ...itemTraits]));
    return {
      slug: str(action.slug),
      label: str(action.label),
      weaponType,
      attackBonus: num(action.totalModifier, num(get(obj(linkedSys.bonus), 'value'), 0)),
      damageRolls,
      traits,
      range,
      itemId: linkedId || null,
    };
  };

  const projectStrikes = (): StrikeEntry[] => {
    const actionsArr = Array.isArray(sys.actions) ? (sys.actions as unknown[]) : [];
    const out: StrikeEntry[] = [];
    for (const a of actionsArr) {
      const ao = obj(a);
      if (!ao) continue;
      if (ao.type !== 'strike') continue;
      out.push(projectStrike(ao));
    }
    return out;
  };

  const projectActionItem = (item: ItemDocLike): ActionEntry => {
    const itemSys = (item.system as AnyRecord | undefined) ?? {};
    const actionTypeV = str(get(obj(itemSys.actionType), 'value'));
    const actionCountRaw = get(obj(itemSys.actions), 'value');
    const actionCount: number | null = typeof actionCountRaw === 'number' ? actionCountRaw : null;
    const entry: ActionEntry = {
      id: str(item.id),
      slug: str(itemSys.slug),
      name: str(item.name),
      actionType: actionTypeV,
      actionCount,
      traits: strArr(get(obj(itemSys.traits), 'value')),
      trigger:
        typeof itemSys.trigger === 'string' && itemSys.trigger.length > 0 ? itemSys.trigger : null,
      requirements:
        typeof itemSys.requirements === 'string' && itemSys.requirements.length > 0
          ? itemSys.requirements
          : null,
      frequency:
        typeof itemSys.frequency === 'string' && itemSys.frequency.length > 0
          ? itemSys.frequency
          : null,
    };
    const descRaw = get(obj(itemSys.description), 'value');
    applyDescFormat(
      entry as unknown as Record<string, unknown>,
      'description',
      'descriptionText',
      descRaw,
    );
    return entry;
  };

  const projectActions = (): ActionEntry[] => {
    const out: ActionEntry[] = [];
    for (const item of itemContents) {
      if (item?.type === 'action' && item.id) {
        out.push(projectActionItem(item));
      }
    }
    return out;
  };

  const projectSpellcasting = (): SpellcastingEntry[] => {
    const out: SpellcastingEntry[] = [];
    const iterable = doc.spellcasting;
    if (!iterable) return out;
    for (const entry of iterable) {
      // Exclude the "rituals" pseudo-container and per-scroll consumable
      // casting entries. Real spellcasting entries always carry
      // entry.type === 'spellcastingEntry'.
      if (!entry || entry.type !== 'spellcastingEntry') continue;
      const eSys = (entry.system as AnyRecord | undefined) ?? {};
      const prepared = obj(eSys.prepared);
      const tradition = obj(eSys.tradition);
      const slotsRaw = obj(eSys.slots) ?? {};
      const slots: SpellSlotEntry[] = [];
      for (let i = 0; i <= 11; i += 1) {
        const slot = obj((slotsRaw as Record<string, unknown>)[`slot${i}`]);
        if (!slot) continue;
        const maxV = num(slot.max, 0);
        if (maxV === 0) continue;
        slots.push({
          level: i,
          value: num(slot.value, 0),
          max: maxV,
          prepared: Array.isArray(slot.prepared) ? slot.prepared.length : 0,
        });
      }
      const traditionV = typeof tradition?.value === 'string' ? tradition.value : '';
      out.push({
        entryId: str(entry.id),
        name: str(entry.name),
        category: typeof prepared?.value === 'string' ? prepared.value : 'prepared',
        tradition:
          traditionV === 'arcane' ||
          traditionV === 'divine' ||
          traditionV === 'occult' ||
          traditionV === 'primal'
            ? traditionV
            : null,
        slots,
      });
    }
    return out;
  };

  // ---- per-type projection ----------------------------------------------

  if (actorType === 'npc') {
    const attrRaw = obj(get(sys, 'attributes')) ?? {};
    const hpRaw = obj(attrRaw.hp) ?? {};
    const acRaw = obj(attrRaw.ac) ?? {};
    const abRaw = obj(get(sys, 'abilities'));
    const abilityMod = (k: string): number => {
      const a = obj(get(abRaw ?? {}, k));
      return a ? num(a.mod, 0) : 0;
    };
    const abilities: AbilityMods | null = abRaw
      ? {
          str: abilityMod('str'),
          dex: abilityMod('dex'),
          con: abilityMod('con'),
          int: abilityMod('int'),
          wis: abilityMod('wis'),
          cha: abilityMod('cha'),
        }
      : null;

    const languages = strArr(get(obj(get(get(sys, 'details'), 'languages')), 'value'));

    // Skills: filter to curated stat-block entries (base !== 0).
    const skillsRaw = obj(get(sys, 'skills')) ?? {};
    const skills: SkillEntry[] = [];
    for (const [slug, raw] of Object.entries(skillsRaw)) {
      const so = obj(raw);
      if (!so) continue;
      const base = typeof so.base === 'number' ? so.base : 0;
      if (base === 0) continue;
      skills.push({
        slug,
        name: typeof so.label === 'string' ? so.label : slug,
        modifier: num(so.value, num(so.totalModifier, base)),
      });
    }

    out.npc = {
      ac: { value: num(acRaw.value, 0) },
      hp: {
        value: num(hpRaw.value, 0),
        max: num(hpRaw.max, 0),
        temp: num(hpRaw.temp, 0),
      },
      saves: projectSaves(),
      perception: projectPerception(),
      abilities,
      speeds: projectSpeeds(),
      languages,
      skills,
      strikes: projectStrikes(),
      actions: projectActions(),
      spellcasting: projectSpellcasting(),
      iwr: projectIwr(),
    };
  } else if (actorType === 'hazard') {
    const attrRaw = obj(get(sys, 'attributes')) ?? {};
    const hpRaw = obj(attrRaw.hp) ?? {};
    const stealthRaw = obj(attrRaw.stealth) ?? {};
    const details = obj(get(sys, 'details')) ?? {};

    const hazard: HazardBlock = {
      isComplex: details.isComplex === true,
      hardness: num(attrRaw.hardness, 0),
      hp: {
        value: num(hpRaw.value, 0),
        max: num(hpRaw.max, 0),
        brokenThreshold: num(hpRaw.brokenThreshold, 0),
      },
      stealth: {
        modifier: num(stealthRaw.value, num(stealthRaw.totalModifier, 0)),
        dc: num(stealthRaw.dc, 0),
        details: str(stealthRaw.details),
      },
      saves: projectSaves(),
      attacks: projectStrikes(),
      actions: projectActions(),
      iwr: projectIwr(),
    };

    applyDescFormat(
      hazard as unknown as Record<string, unknown>,
      'disable',
      'disableText',
      details.disable,
    );
    applyDescFormat(
      hazard as unknown as Record<string, unknown>,
      'routine',
      'routineText',
      details.routine,
    );
    applyDescFormat(
      hazard as unknown as Record<string, unknown>,
      'reset',
      'resetText',
      details.reset,
    );

    out.hazard = hazard;
  } else if (actorType === 'familiar') {
    const attrRaw = obj(get(sys, 'attributes')) ?? {};
    const hpRaw = obj(attrRaw.hp) ?? {};
    const acRaw = obj(attrRaw.ac) ?? {};
    const masterRaw = obj(get(sys, 'master'));
    const master = masterRaw
      ? {
          id: typeof masterRaw.id === 'string' ? masterRaw.id : null,
          ability: str(masterRaw.ability),
        }
      : null;
    const reachRaw = attrRaw.reach;
    const reach: number | null =
      typeof reachRaw === 'number'
        ? reachRaw
        : typeof obj(reachRaw)?.value === 'number'
          ? (obj(reachRaw)?.value as number)
          : null;

    out.familiar = {
      master,
      ac: { value: num(acRaw.value, 0) },
      hp: {
        value: num(hpRaw.value, 0),
        max: num(hpRaw.max, 0),
        temp: num(hpRaw.temp, 0),
      },
      perception: projectPerception(),
      speeds: projectSpeeds(),
      abilities: null,
      reach,
      actions: projectActions(),
    };
  }

  // ---- opt-in escape hatches --------------------------------------------
  if (input.includeRules) {
    const rulesRaw = get(sys, 'rules');
    out.rules = Array.isArray(rulesRaw) ? rulesRaw : [];
  }
  // PF2e's live `actor.system` includes Stat instances, Map-like
  // collections, and other class instances that CDP's structured-clone
  // pipeline drops to `undefined`. JSON-roundtrip coerces them to plain
  // values that survive the wire — same pattern as pf2e_get_actor_state.
  if (input.includeRawSystem) {
    try {
      out.rawSystem = JSON.parse(JSON.stringify(sys)) as Record<string, unknown>;
    } catch {
      out.rawSystem = {};
    }
  }

  return out;
}
