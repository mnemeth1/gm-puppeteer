/**
 * page.evaluate body for `dnd5e_get_creature_details`. Returns full
 * per-creature stat-block data for any D&D 5e Foundry Actor of type `npc`
 * or `vehicle` resolved by UUID. D&D 5e sibling of
 * `pf2e_get_creature_details`: UUID-input, per-type projection, opt-in
 * escape hatches.
 *
 * **Scope.** This is the read-only **stat-block** reference — it works on
 * compendium-resident creatures (encounter prep before spawning) and
 * world-resident NPCs/vehicles (inspection after spawning). PC actors
 * (`type === 'character'`) are rejected with ACTOR_TYPE_UNSUPPORTED — PCs
 * have a runtime-state surface (HP/conditions/resources) that belongs to a
 * future `dnd5e_get_actor_state`. `group` and `encounter` actors are also
 * rejected.
 *
 * Behaviour nuances confirmed by live probing against dnd5e 5.3.3 /
 * Foundry v14.361 (`scripts/probe-dnd5e-get-creature-details.mjs`). Every
 * field path below is probe-verified — none were ported from the PF2e
 * sibling on faith, the 5e schema is entirely different:
 *
 *  - **Actor subtypes** (`CONFIG.Actor.dataModels`): `character`,
 *    `encounter`, `group`, `npc`, `vehicle`. This tool supports `npc` and
 *    `vehicle`.
 *  - **Identification.** NPC identity is `system.details.cr` (a bare
 *    number, fractions included like `0.25`) — NOT `system.details.level`,
 *    which is `0` on NPCs. Creature type is `system.details.type`, an
 *    OBJECT `{value, subtype, swarm, custom}` on NPCs. On VEHICLES,
 *    `system.details.type` is instead a bare STRING (`"water"`, `"land"`,
 *    `"air"`, `"space"`) — the vehicle category. This asymmetry is why the
 *    common `creatureType` field is populated for NPCs only and vehicles
 *    carry their category in `vehicle.vehicleType`.
 *  - **Source.** `system.source` is an object `{book, page, license,
 *    rules ("2014"|"2024"), label, value, slug}`. `label` is the display
 *    string. There is no PF2e-style `publication` block.
 *  - **AC / HP.** `system.attributes.ac.value` is the effective AC.
 *    `system.attributes.hp.{value, max, temp}` — `temp` may be `null`
 *    (not 0) when unset; coerce. Vehicle HP additionally carries `dt`
 *    (damage threshold) and `mt` (mishap threshold).
 *  - **Proficiency / initiative.** `system.attributes.prof` is a bare
 *    number; `system.attributes.init.total` is the initiative modifier.
 *  - **Movement.** `system.attributes.movement.{walk, burrow, climb, fly,
 *    swim, hover, units}` — bare numbers (`0` = absent), `hover` boolean.
 *    `jump`, `speed`, `max` are derived and skipped.
 *  - **Senses.** `system.attributes.senses.{darkvision, blindsight,
 *    tremorsense, truesight, special, units}` — bare numbers (`0` =
 *    absent), `special` a free-text string.
 *  - **Abilities.** `system.abilities.{str,dex,con,int,wis,cha}` — each
 *    `{value (the SCORE), mod, save: {value}, proficient, dc}`. Unlike
 *    PF2e (mod only), a 5e ability carries the score, the modifier, the
 *    saving-throw bonus (`save.value`), a proficiency flag, and a
 *    per-ability spell DC. Saving throws live ON the abilities — there is
 *    no top-level `system.saves`.
 *  - **Skills.** `system.skills` keyed by 3-letter abbreviations (`acr`,
 *    `ste`, …). Each `{ability, proficient (0/1/2 multiplier), total,
 *    passive, mod}`. The curated stat-block skills are those with
 *    `proficient !== 0` — the 5e analogue of PF2e's `base !== 0` filter.
 *    `total` is the effective modifier, `passive` the 10+total score.
 *  - **Traits — Sets, not arrays.** `system.traits.{di, dr, dv, ci}` are
 *    damage immunity / resistance / vulnerability / condition immunity.
 *    Each is `{value, custom, bypasses}` and **`value` is a `Set`**, not
 *    an array or plain object. `JSON.stringify` of a `Set` yields `{}` —
 *    so the value MUST be read with `Array.from()` inside this evaluator
 *    (which runs in the browser context where the live `Set` exists). A
 *    probed Skeleton's `di.value` `Set` → `["poison"]`, `ci.value` →
 *    `["poisoned","exhaustion"]`. `system.traits.languages.value` is also
 *    a `Set`; `system.traits.languages.labels.languages` is the resolved
 *    human-readable string array — use the labels.
 *  - **Embedded items.** NPC attacks/actions are embedded `weapon`-type
 *    and `feat`-type items — there is no PF2e `system.actions[]` strike
 *    array and no `melee` document type. `equipment`-type items (armour,
 *    shields) are gear, not actions, and are skipped.
 *  - **`item.system.activities` is an `ActivityCollection`** — a Map-like
 *    object, NOT a plain object. `Object.keys(activities)` returns `[]`;
 *    use `.contents` / `.getByType()`. Populated after `fromUuid` (data
 *    prep runs on compendium fetch). This evaluator does not read
 *    activities directly — see next item.
 *  - **`item.labels`.** The dnd5e system computes a fully-resolved,
 *    sheet-ready `item.labels` object during data prep:
 *    `labels.attacks: [{toHit, modifier}]`, `labels.damages: [{formula,
 *    label, damageType}]`, `labels.activations: [{activation, ...}]`,
 *    `labels.activation`, `labels.range`, `labels.reach`,
 *    `labels.properties: [{abbr, label}]`. This is the projection source
 *    for attacks — it sidesteps re-deriving to-hit/damage from raw
 *    activity math (which differs between the 2014 and 2024 rulesets).
 *  - **Spells.** `system.spells.{spell0..spell9, pact}` — each `{value,
 *    max, level}` (`spell0` = cantrips). Slot levels with `max === 0` are
 *    unused. Spellcasting ability is `system.attributes.spellcasting` (an
 *    ability key, `""` if none); the spell save DC is
 *    `system.abilities[ability].dc`. There is no `system.attributes.spelldc`.
 *  - **Description.** `system.details.biography.value` (HTML). Not
 *    `publicNotes` (that is PF2e).
 *  - **`_stats.compendiumSource`** is the canonical source UUID.
 *
 * `includeRules` (the PF2e flag) is renamed `includeEffects` here: D&D 5e
 * has no PF2e-style rule-element array — the analogue is ActiveEffects
 * (`actor.effects`).
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline. Only erased-at-runtime `type`/`interface`
 * declarations and the exported `SUPPORTED_CREATURE_TYPES` const (consumed
 * by the tool layer only) live at module scope.
 */
export interface Dnd5eGetCreatureDetailsInput {
  uuid: string;
  descriptionFormat: 'html' | 'text' | 'both';
  includeEffects: boolean;
  includeRawSystem: boolean;
}

export interface CreatureType {
  value: string;
  subtype: string;
  swarm: string;
}

export interface AbilityEntry {
  score: number;
  mod: number;
  save: number;
  proficient: boolean;
}

export interface Abilities {
  str: AbilityEntry;
  dex: AbilityEntry;
  con: AbilityEntry;
  int: AbilityEntry;
  wis: AbilityEntry;
  cha: AbilityEntry;
}

export interface SaveSummary {
  ability: string;
  modifier: number;
  proficient: boolean;
}

export interface SensesBlock {
  darkvision?: number;
  blindsight?: number;
  tremorsense?: number;
  truesight?: number;
  special?: string;
  units: string;
}

export interface SpeedsBlock {
  walk: number;
  burrow?: number;
  climb?: number;
  fly?: number;
  swim?: number;
  hover?: boolean;
  units: string;
}

export interface SkillEntry {
  key: string;
  name: string;
  ability: string;
  modifier: number;
  passive: number;
  proficiency: number;
}

export interface DamageInteractions {
  immunities: string[];
  resistances: string[];
  vulnerabilities: string[];
  conditionImmunities: string[];
}

export interface AttackEntry {
  itemId: string;
  name: string;
  itemType: string;
  attackBonus: string | null;
  damage: string | null;
  range: string | null;
  activation: string | null;
  properties: string[];
}

export interface FeatureEntry {
  itemId: string;
  name: string;
  activation: string | null;
  uses: string | null;
  requirements: string | null;
  description?: string;
  descriptionText?: string;
}

export interface SpellSlotEntry {
  level: number;
  value: number;
  max: number;
}

export interface SpellcastingBlock {
  ability: string | null;
  saveDc: number | null;
  attackBonus: number | null;
  slots: SpellSlotEntry[];
  pact?: SpellSlotEntry;
  knownSpellCount: number;
}

export interface EffectEntry {
  id: string;
  name: string;
  disabled: boolean;
  transfer: boolean;
  durationSeconds: number | null;
  changesCount: number;
}

export interface NpcBlock {
  ac: { value: number };
  hp: { value: number; max: number; temp: number };
  proficiencyBonus: number;
  xp: number | null;
  alignment: string;
  initiative: number;
  abilities: Abilities;
  saves: SaveSummary[];
  skills: SkillEntry[];
  senses: SensesBlock;
  speeds: SpeedsBlock;
  languages: string[];
  damageInteractions: DamageInteractions;
  attacks: AttackEntry[];
  features: FeatureEntry[];
  spellcasting: SpellcastingBlock | null;
}

export interface VehicleBlock {
  vehicleType: string;
  ac: { value: number; motionless: number };
  hp: {
    value: number;
    max: number;
    temp: number;
    damageThreshold: number | null;
    mishapThreshold: number | null;
  };
  abilities: Abilities;
  speeds: SpeedsBlock;
  capacity: { cargo: { value: number; units: string }; creature: string };
  dimensions: string;
  damageInteractions: DamageInteractions;
  actions: (AttackEntry | FeatureEntry)[];
  crew: unknown[];
  passengers: unknown[];
}

export interface Dnd5eGetCreatureDetailsOk {
  ok: true;
  uuid: string;
  id: string;
  name: string;
  type: string;
  img: string;
  cr: number | null;
  creatureType: CreatureType | null;
  size: string;
  source: string | null;
  sourceUuid: string | null;
  description?: string;
  descriptionText?: string;

  // Exactly one of the following is populated, keyed by `type`.
  npc?: NpcBlock;
  vehicle?: VehicleBlock;

  effects?: EffectEntry[];
  rawSystem?: Record<string, unknown>;
}

export interface Dnd5eGetCreatureDetailsErr {
  ok: false;
  error: {
    code: 'NOT_FOUND' | 'WRONG_DOCUMENT_TYPE' | 'ACTOR_TYPE_UNSUPPORTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eGetCreatureDetailsResult =
  | Dnd5eGetCreatureDetailsOk
  | Dnd5eGetCreatureDetailsErr;

declare function fromUuid(uuid: string): Promise<unknown>;

/**
 * Actor types this evaluator emits a typed projection for. Exported so
 * the tool layer can warn on the (schema-unreachable, but defensible)
 * case of the projection returning a type that isn't one of these.
 */
export const SUPPORTED_CREATURE_TYPES = ['npc', 'vehicle'] as const;

export async function dnd5eGetCreatureDetailsBody(
  input: Dnd5eGetCreatureDetailsInput,
): Promise<Dnd5eGetCreatureDetailsResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['npc', 'vehicle']);

  // D&D 5e's 18 skill abbreviations → display labels. Inlined rather than
  // read from CONFIG.DND5E so the evaluator has no global dependency.
  const SKILL_LABELS: Record<string, string> = {
    acr: 'Acrobatics',
    ani: 'Animal Handling',
    arc: 'Arcana',
    ath: 'Athletics',
    dec: 'Deception',
    his: 'History',
    ins: 'Insight',
    itm: 'Intimidation',
    inv: 'Investigation',
    med: 'Medicine',
    nat: 'Nature',
    prc: 'Perception',
    prf: 'Performance',
    per: 'Persuasion',
    rel: 'Religion',
    slt: 'Sleight of Hand',
    ste: 'Stealth',
    sur: 'Survival',
  };
  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    labels?: AnyRecord;
  }
  interface EffectDocLike {
    id?: string;
    name?: string;
    disabled?: boolean;
    transfer?: boolean;
    duration?: { seconds?: unknown };
    changes?: unknown[];
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
    items?: { contents?: ItemDocLike[] };
    effects?: { contents?: EffectDocLike[] };
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
    const hint =
      actorType === 'character'
        ? 'For PC actors (type=character), use dnd5e_get_actor_state.'
        : 'This tool covers creature/vehicle stat blocks; for group/encounter actors use foundry_eval.';
    return {
      ok: false,
      error: {
        code: 'ACTOR_TYPE_UNSUPPORTED',
        message:
          `Actor type '${actorType}' is not supported by dnd5e_get_creature_details. ` +
          `Supported types: npc, vehicle. ${hint}`,
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

  /**
   * Resolve a `system.traits.*.value` collection to a string array. The
   * live value is a `Set` (which `JSON.stringify` flattens to `{}`); also
   * tolerate a plain array or keyed object for forward-compat.
   */
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

  const attributes = obj(get(sys, 'attributes')) ?? {};
  const details = obj(get(sys, 'details')) ?? {};
  const traits = obj(get(sys, 'traits')) ?? {};

  // ---- common fields -----------------------------------------------------

  const crRaw = get(details, 'cr');
  const cr: number | null = typeof crRaw === 'number' ? crRaw : null;

  // NPC: system.details.type is an object. Vehicle: a bare string (the
  // vehicle category) — surfaced on the vehicle block, not here.
  const typeRaw = get(details, 'type');
  let creatureType: CreatureType | null = null;
  const typeObj = obj(typeRaw);
  if (typeObj) {
    creatureType = {
      value: str(typeObj.value),
      subtype: str(typeObj.subtype),
      swarm: str(typeObj.swarm),
    };
  }

  const size = str(get(traits, 'size'));
  const sourceObj = obj(get(sys, 'source'));
  const source = sourceObj
    ? str(sourceObj.label) || str(sourceObj.value) || str(sourceObj.book) || null
    : null;
  const sourceUuidRaw = get(doc._stats, 'compendiumSource');
  const sourceUuid = typeof sourceUuidRaw === 'string' ? sourceUuidRaw : null;

  const out: Dnd5eGetCreatureDetailsOk = {
    ok: true,
    uuid: str(doc.uuid, input.uuid),
    id: str(doc.id),
    name: str(doc.name),
    type: actorType,
    img: str(doc.img),
    cr,
    creatureType,
    size,
    source,
    sourceUuid,
  };

  applyDescFormat(
    out as unknown as Record<string, unknown>,
    'description',
    'descriptionText',
    get(obj(get(details, 'biography')), 'value'),
  );

  // ---- shared sub-projections -------------------------------------------

  const abilitiesRaw = obj(get(sys, 'abilities')) ?? {};
  const projectAbilities = (): Abilities => {
    const one = (k: string): AbilityEntry => {
      const a = obj(abilitiesRaw[k]) ?? {};
      return {
        score: num(a.value),
        mod: num(a.mod),
        save: num(get(obj(a.save), 'value')),
        proficient: num(a.proficient) !== 0,
      };
    };
    return {
      str: one('str'),
      dex: one('dex'),
      con: one('con'),
      int: one('int'),
      wis: one('wis'),
      cha: one('cha'),
    };
  };

  const projectSaves = (abilities: Abilities): SaveSummary[] =>
    ABILITY_KEYS.map((k) => ({
      ability: k,
      modifier: abilities[k].save,
      proficient: abilities[k].proficient,
    }));

  const projectSenses = (): SensesBlock => {
    const sensesRaw = obj(get(attributes, 'senses')) ?? {};
    const block: SensesBlock = { units: str(sensesRaw.units, 'ft') };
    for (const k of ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const) {
      const v = num(sensesRaw[k]);
      if (v > 0) block[k] = v;
    }
    const special = str(sensesRaw.special);
    if (special.length > 0) block.special = special;
    return block;
  };

  const projectSpeeds = (): SpeedsBlock => {
    const moveRaw = obj(get(attributes, 'movement')) ?? {};
    const block: SpeedsBlock = { walk: num(moveRaw.walk), units: str(moveRaw.units, 'ft') };
    for (const k of ['burrow', 'climb', 'fly', 'swim'] as const) {
      const v = num(moveRaw[k]);
      if (v > 0) block[k] = v;
    }
    if (moveRaw.hover === true) block.hover = true;
    return block;
  };

  const projectDamageInteractions = (): DamageInteractions => ({
    immunities: setToArray(get(obj(get(traits, 'di')), 'value')),
    resistances: setToArray(get(obj(get(traits, 'dr')), 'value')),
    vulnerabilities: setToArray(get(obj(get(traits, 'dv')), 'value')),
    conditionImmunities: setToArray(get(obj(get(traits, 'ci')), 'value')),
  });

  // Project a weapon/feat item's `labels` block into an AttackEntry.
  const projectAttack = (item: ItemDocLike): AttackEntry => {
    const labels = obj(item.labels) ?? {};
    const attacksArr = Array.isArray(labels.attacks) ? (labels.attacks as unknown[]) : [];
    const firstAttack = obj(attacksArr[0]);
    const damagesArr = Array.isArray(labels.damages) ? (labels.damages as unknown[]) : [];
    const damageStr = damagesArr
      .map((d) => str(get(obj(d), 'label')))
      .filter((s) => s.length > 0)
      .join(', ');
    const propsArr = Array.isArray(labels.properties) ? (labels.properties as unknown[]) : [];
    const properties = propsArr
      .map((p) => str(get(obj(p), 'label')))
      .filter((s) => s.length > 0);
    const activationsArr = Array.isArray(labels.activations)
      ? (labels.activations as unknown[])
      : [];
    return {
      itemId: str(item.id),
      name: str(item.name),
      itemType: str(item.type),
      attackBonus:
        str(get(firstAttack, 'toHit')) || (typeof labels.toHit === 'string' ? labels.toHit : '') ||
        null,
      damage: damageStr || (typeof labels.damage === 'string' ? labels.damage : '') || null,
      range:
        str(labels.range) || str(labels.reach) || str(get(activationsArr[0], 'range')) || null,
      activation:
        str(labels.activation) || str(get(obj(activationsArr[0]), 'activation')) || null,
      properties,
    };
  };

  // Project a non-attack feat item into a FeatureEntry.
  const projectFeature = (item: ItemDocLike): FeatureEntry => {
    const itemSys = obj(item.system) ?? {};
    const labels = obj(item.labels) ?? {};
    const activationsArr = Array.isArray(labels.activations)
      ? (labels.activations as unknown[])
      : [];
    const usesRaw = obj(itemSys.uses) ?? {};
    const usesMax = usesRaw.max;
    let uses: string | null = null;
    if (typeof usesMax === 'number' && usesMax > 0) {
      uses = `${num(usesRaw.value)}/${usesMax}`;
    } else if (typeof usesMax === 'string' && usesMax.length > 0) {
      uses = `${num(usesRaw.value)}/${usesMax}`;
    }
    const entry: FeatureEntry = {
      itemId: str(item.id),
      name: str(item.name),
      activation: str(get(obj(activationsArr[0]), 'activation')) || null,
      uses,
      requirements:
        typeof itemSys.requirements === 'string' && itemSys.requirements.length > 0
          ? itemSys.requirements
          : null,
    };
    applyDescFormat(
      entry as unknown as Record<string, unknown>,
      'description',
      'descriptionText',
      get(obj(itemSys.description), 'value'),
    );
    return entry;
  };

  // Split embedded items into attacks vs features. A `weapon` is always an
  // attack; a `feat` is an attack when its `labels.attacks` is non-empty,
  // otherwise a feature. Other item types (equipment, etc.) are gear, not
  // actions, and are dropped.
  const itemContents = Array.isArray(doc.items?.contents) ? doc.items.contents : [];
  const splitItems = (): { attacks: AttackEntry[]; features: FeatureEntry[] } => {
    const attacks: AttackEntry[] = [];
    const features: FeatureEntry[] = [];
    for (const item of itemContents) {
      if (!item || !item.id) continue;
      const labels = obj(item.labels) ?? {};
      const hasAttack =
        Array.isArray(labels.attacks) && (labels.attacks as unknown[]).length > 0;
      if (item.type === 'weapon' || (item.type === 'feat' && hasAttack)) {
        attacks.push(projectAttack(item));
      } else if (item.type === 'feat') {
        features.push(projectFeature(item));
      }
    }
    return { attacks, features };
  };

  const projectSpellcasting = (abilities: Abilities): SpellcastingBlock | null => {
    const spellsRaw = obj(get(sys, 'spells')) ?? {};
    const slots: SpellSlotEntry[] = [];
    for (let i = 0; i <= 9; i += 1) {
      const slot = obj(spellsRaw[`spell${i}`]);
      if (!slot) continue;
      const max = num(slot.max);
      if (max === 0) continue;
      slots.push({
        level: typeof slot.level === 'number' ? slot.level : i,
        value: num(slot.value),
        max,
      });
    }
    const pactRaw = obj(spellsRaw.pact);
    let pact: SpellSlotEntry | undefined;
    if (pactRaw && num(pactRaw.max) > 0) {
      pact = {
        level: num(pactRaw.level),
        value: num(pactRaw.value),
        max: num(pactRaw.max),
      };
    }
    const abilityKey = str(get(attributes, 'spellcasting'));
    const knownSpellCount = itemContents.filter((it) => it?.type === 'spell').length;
    if (abilityKey.length === 0 && slots.length === 0 && !pact && knownSpellCount === 0) {
      return null;
    }
    const isAbilityKey = (k: string): k is keyof Abilities =>
      k === 'str' || k === 'dex' || k === 'con' || k === 'int' || k === 'wis' || k === 'cha';
    let saveDc: number | null = null;
    let attackBonus: number | null = null;
    if (isAbilityKey(abilityKey)) {
      const dcRaw = get(obj(abilitiesRaw[abilityKey]), 'dc');
      saveDc = typeof dcRaw === 'number' ? dcRaw : null;
      attackBonus = abilities[abilityKey].mod + num(get(attributes, 'prof'));
    }
    return {
      ability: abilityKey.length > 0 ? abilityKey : null,
      saveDc,
      attackBonus,
      slots,
      ...(pact ? { pact } : {}),
      knownSpellCount,
    };
  };

  // ---- per-type projection ----------------------------------------------

  if (actorType === 'npc') {
    const hpRaw = obj(get(attributes, 'hp')) ?? {};
    const acRaw = obj(get(attributes, 'ac')) ?? {};
    const abilities = projectAbilities();

    const skillsRaw = obj(get(sys, 'skills')) ?? {};
    const skills: SkillEntry[] = [];
    for (const [key, raw] of Object.entries(skillsRaw)) {
      const so = obj(raw);
      if (!so) continue;
      const proficiency = num(so.proficient);
      if (proficiency === 0) continue;
      skills.push({
        key,
        name: SKILL_LABELS[key] ?? key,
        ability: str(so.ability),
        modifier: num(so.total, num(so.mod)),
        passive: num(so.passive),
        proficiency,
      });
    }

    const xpRaw = get(obj(get(details, 'xp')), 'value');
    const { attacks, features } = splitItems();

    out.npc = {
      ac: { value: num(acRaw.value) },
      hp: { value: num(hpRaw.value), max: num(hpRaw.max), temp: num(hpRaw.temp) },
      proficiencyBonus: num(get(attributes, 'prof')),
      xp: typeof xpRaw === 'number' ? xpRaw : null,
      alignment: str(get(details, 'alignment')),
      initiative: num(get(obj(get(attributes, 'init')), 'total')),
      abilities,
      saves: projectSaves(abilities),
      skills,
      senses: projectSenses(),
      speeds: projectSpeeds(),
      languages: strArr(get(obj(get(obj(get(traits, 'languages')), 'labels')), 'languages')),
      damageInteractions: projectDamageInteractions(),
      attacks,
      features,
      spellcasting: projectSpellcasting(abilities),
    };
  } else if (actorType === 'vehicle') {
    const hpRaw = obj(get(attributes, 'hp')) ?? {};
    const acRaw = obj(get(attributes, 'ac')) ?? {};
    const capacityRaw = obj(get(attributes, 'capacity')) ?? {};
    const cargoRaw = obj(get(capacityRaw, 'cargo')) ?? {};
    const cargoCollection = obj(get(sys, 'cargo')) ?? {};
    const { attacks, features } = splitItems();

    out.vehicle = {
      vehicleType: typeof typeRaw === 'string' ? typeRaw : str(get(typeObj, 'value')),
      ac: { value: num(acRaw.value), motionless: num(acRaw.motionless, num(acRaw.value)) },
      hp: {
        value: num(hpRaw.value),
        max: num(hpRaw.max),
        temp: num(hpRaw.temp),
        damageThreshold: typeof hpRaw.dt === 'number' ? hpRaw.dt : null,
        mishapThreshold: typeof hpRaw.mt === 'number' ? hpRaw.mt : null,
      },
      abilities: projectAbilities(),
      speeds: projectSpeeds(),
      capacity: {
        cargo: { value: num(cargoRaw.value), units: str(cargoRaw.units) },
        creature: typeof capacityRaw.creature === 'string'
          ? capacityRaw.creature
          : String(num(capacityRaw.creature)),
      },
      dimensions: str(get(traits, 'dimensions')),
      damageInteractions: projectDamageInteractions(),
      actions: [...attacks, ...features],
      crew: Array.isArray(cargoCollection.crew) ? (cargoCollection.crew as unknown[]) : [],
      passengers: Array.isArray(cargoCollection.passengers)
        ? (cargoCollection.passengers as unknown[])
        : [],
    };
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

  // The live `system` carries class instances (ActivityCollection, Set,
  // etc.) that the CDP structured-clone pipeline drops to `undefined`. A
  // JSON round-trip coerces them to plain wire-safe values.
  if (input.includeRawSystem) {
    try {
      out.rawSystem = JSON.parse(JSON.stringify(sys)) as Record<string, unknown>;
    } catch {
      out.rawSystem = {};
    }
  }

  return out;
}
