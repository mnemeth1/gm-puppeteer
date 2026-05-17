/**
 * page.evaluate body for `dnd5e_get_actor_state`. Returns a focused
 * projection of a D&D 5e actor's combat-relevant *runtime* state: HP, AC,
 * abilities + saves, senses, speeds, active conditions, active effects,
 * resources (hit dice, custom pools, legendary), vitals (death saves /
 * exhaustion / inspiration), and encounter membership. Opt-in flags expand
 * into skills, spellcasting, the full combatant shape, and the raw system
 * blob.
 *
 * D&D 5e sibling of `pf2e_get_actor_state`. Where `dnd5e_get_creature_details`
 * is the read-only *stat-block* reference (and rejects PCs), this is the
 * *runtime-state* surface — it works on world `character` and `npc` actors
 * and is the foundation read tool for the future `dnd5e_` condition-mutation
 * cluster (`dnd5e_apply_condition` etc.): those tools need to see what is
 * already on an actor before mutating.
 *
 * Behaviour nuances confirmed by live probing against dnd5e 5.3.3 /
 * Foundry v14.361 (`scripts/probe-dnd5e-get-actor-state.mjs`). Every field
 * path below is probe-verified — none were ported from the PF2e sibling on
 * faith, the 5e schema is entirely different:
 *
 *  - **Actor types** (`CONFIG.Actor.dataModels`): `character`, `encounter`,
 *    `group`, `npc`, `vehicle`. This tool supports `character` and `npc`;
 *    `vehicle` / `group` / `encounter` are rejected with
 *    ACTOR_TYPE_UNSUPPORTED. 5e has no `familiar` actor type.
 *
 *  - **Identity.** `character`: total level is `system.details.level` (a
 *    bare number); XP is `system.details.xp.{value,max}`; class breakdown
 *    comes from embedded `class`-type items (`system.identifier`,
 *    `system.levels`), each joined to a `subclass`-type item by
 *    `subclass.system.classIdentifier`; race and background are the names
 *    of the single embedded `race` / `background` items. `npc`:
 *    `system.details.cr` (a bare number, fractions like `0.25`) and the
 *    `system.details.type` object `{value,subtype,swarm}`.
 *
 *  - **HP** = `system.attributes.hp.{value,max,temp}`. `temp` is `null`
 *    (not 0) when unset — coerce.
 *
 *  - **AC** = `system.attributes.ac.value` (the effective AC).
 *
 *  - **Abilities** = `system.abilities.{str,dex,con,int,wis,cha}` — each
 *    `{value (the SCORE), mod, save: {value}, proficient (0/1)}`. Saving
 *    throws live ON the abilities — there is NO top-level `system.saves`.
 *    `saves` is a flat six-entry summary derived from the abilities.
 *
 *  - **Senses** = `system.attributes.senses.{darkvision,blindsight,
 *    tremorsense,truesight,special,units}` — bare numbers (`0` = absent).
 *
 *  - **Speeds** = `system.attributes.movement.{walk,burrow,climb,fly,swim,
 *    hover,units}` — bare numbers (`0` = absent), `hover` a boolean.
 *
 *  - **Conditions.** 5e has NO `condition` item type (PF2e does). A
 *    condition is a status effect: `actor.statuses` is a `Set<string>` of
 *    active status ids; the applied Active Effect carries the same id in
 *    its own `statuses` set. Exhaustion is the one *valued* condition —
 *    its level is `system.attributes.exhaustion` (a number), not the
 *    status set. We project a `ConditionEntry` per status id, linking the
 *    backing Active Effect's id when one exists (`effectId` — the handle
 *    the future `dnd5e_remove_condition` needs; `null` for a bare status),
 *    and additionally emit an `exhaustion` entry (with `value`) whenever
 *    the level is > 0. NOTE: `actor.statuses` being a `Set`, a
 *    `JSON.stringify` of it yields `{}` — it MUST be read with
 *    `Array.from()` inside this evaluator (the browser context where the
 *    live `Set` exists).
 *
 *  - **Effects** = `actor.effects.contents` — Active Effect documents,
 *    projected slim (`{id,name,disabled,transfer,durationSeconds,
 *    changesCount}`). `conditions[]` and `effects[]` INTENTIONALLY overlap:
 *    a condition's backing Active Effect appears in both — `conditions[]`
 *    is the status-centric view, `effects[]` the document-centric one.
 *
 *  - **Vitals.** The 5e analogue of PF2e dying/wounded/doomed. Death saves
 *    live at `system.attributes.death.{success,failure}` (counts 0..3 —
 *    the keys are singular, `success`/`failure`, present on `npc` too).
 *    Exhaustion level is `system.attributes.exhaustion`. Inspiration is
 *    `system.attributes.inspiration` (a boolean; `false` when absent).
 *
 *  - **Resources.** `character`: `system.resources.{primary,secondary,
 *    tertiary}` are named custom pools `{value,max,sr,lr,label}` — we
 *    surface only those with a non-empty label or a positive max. `npc`:
 *    `system.resources.{legact,legres}` are legendary actions / resistances
 *    `{value,max}`. Hit dice: `system.attributes.hd` — on a `character`
 *    this is a live `HitDice` class instance exposing `.value` / `.max`
 *    GETTERS (its enumerable own keys are `actor,sizes,classes`, so a JSON
 *    round-trip would dump the whole actor — read `.value`/`.max`
 *    directly); on an `npc` it is a plain `{value,max,spent,denomination}`
 *    object. Reading `.value`/`.max` works for both.
 *
 *  - **Encounter** = `game.combat` (active combat or null) +
 *    `actor.combatant`. Identical to the PF2e sibling: default shape is
 *    `{inCombat: bool}`; `includeEncounterState` expands it to the full
 *    combatant shape.
 *
 *  - **Skills** (opt-in) = `system.skills` keyed by 3-letter abbreviation
 *    (`acr`, `prc`, `ste`, …) — each `{ability, proficient (0/1/2), total,
 *    passive, mod}`. Unlike `dnd5e_get_creature_details` (which curates to
 *    `proficient !== 0` for a tight stat block) this returns all 18 skills
 *    — a PC sheet wants the full list. 5e has no separate perception stat;
 *    perception is the `prc` skill, and `senses` (darkvision etc.) is the
 *    distinct top-level block.
 *
 *  - **Spellcasting** (opt-in) = `system.spells.{spell1..spell9, pact}`
 *    (each `{value,max,level}`); the spellcasting ability is
 *    `system.attributes.spellcasting`; the save DC is
 *    `system.abilities[ability].dc`.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`, which
 * ships only the function's own source string to the browser. Module-scope
 * helpers, imports, and outer closures are NOT available at runtime —
 * every helper is defined inline. Only erased-at-runtime `type`/`interface`
 * declarations and the exported `SUPPORTED_ACTOR_TYPES` const (consumed by
 * the tool layer only) live at module scope.
 */
export interface Dnd5eGetActorStateInput {
  actorId: string;
  includeSkills: boolean;
  includeSpellcasting: boolean;
  includeEncounterState: boolean;
  includeRawSystem: boolean;
}

export interface CreatureType {
  value: string;
  subtype: string;
  swarm: string;
}

export interface ClassEntry {
  name: string;
  identifier: string;
  levels: number;
  subclass: string | null;
}

export interface Dnd5eActorIdentity {
  id: string;
  name: string;
  type: 'character' | 'npc';
  /** Character total level; `0` on npc. */
  level: number;
  /** Character-only — `null` on npc. */
  xp: { value: number; max: number } | null;
  /** Character-only — `null` on npc. */
  race: string | null;
  /** Character-only — `null` on npc. */
  background: string | null;
  /** Character class breakdown; `[]` on npc. */
  classes: ClassEntry[];
  /** npc-only — `null` on character. */
  cr: number | null;
  /** npc-only — `null` on character. */
  creatureType: CreatureType | null;
}

export interface HPBlock {
  value: number;
  max: number;
  temp: number;
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

export interface ConditionEntry {
  /** The 5e status id, e.g. "prone", "poisoned", "exhaustion". */
  statusId: string;
  name: string;
  /** Non-null only for valued conditions — in practice exhaustion. */
  value: number | null;
  /** Backing Active Effect id, or `null` for a status with no effect. */
  effectId: string | null;
  disabled: boolean;
}

export interface EffectEntry {
  id: string;
  name: string;
  disabled: boolean;
  transfer: boolean;
  durationSeconds: number | null;
  changesCount: number;
}

export interface ResourceEntry {
  key: string;
  label: string;
  value: number;
  max: number;
}

export interface ResourcesBlock {
  /** Character custom pools (primary/secondary/tertiary) in use. */
  custom: ResourceEntry[];
  hitDice: { value: number; max: number } | null;
  /** npc legendary actions — `null` on character / when none. */
  legendaryActions: { value: number; max: number } | null;
  /** npc legendary resistances — `null` on character / when none. */
  legendaryResistances: { value: number; max: number } | null;
}

export interface VitalsBlock {
  deathSaves: { success: number; failure: number };
  exhaustion: number;
  inspiration: boolean;
}

export type EncounterBlockDefault = { inCombat: boolean };
export type EncounterBlockFull =
  | {
      inCombat: false;
      combatId: null;
      combatantId: null;
      initiative: null;
      isCurrentTurn: false;
      round: null;
      roundOfLastTurn: null;
    }
  | {
      inCombat: true;
      combatId: string;
      combatantId: string;
      initiative: number | null;
      isCurrentTurn: boolean;
      round: number;
      roundOfLastTurn: number | null;
    };

export interface SkillEntry {
  key: string;
  name: string;
  ability: string;
  modifier: number;
  passive: number;
  proficiency: number;
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

export interface Dnd5eGetActorStateOk {
  ok: true;
  actor: Dnd5eActorIdentity;
  hp: HPBlock;
  ac: { value: number };
  abilities: Abilities;
  saves: SaveSummary[];
  senses: SensesBlock;
  speeds: SpeedsBlock;
  conditions: ConditionEntry[];
  effects: EffectEntry[];
  resources: ResourcesBlock;
  vitals: VitalsBlock;
  encounter: EncounterBlockDefault | EncounterBlockFull;
  skills?: SkillEntry[];
  spellcasting?: SpellcastingBlock;
  rawSystem?: Record<string, unknown>;
}

export interface Dnd5eGetActorStateErr {
  ok: false;
  error: {
    code: 'ACTOR_NOT_FOUND' | 'ACTOR_TYPE_UNSUPPORTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eGetActorStateResult = Dnd5eGetActorStateOk | Dnd5eGetActorStateErr;

/**
 * Actor types this evaluator emits a projection for. Exported so the tool
 * layer can name them in user-facing error messages and warn on a
 * projection that returns a type outside the set.
 */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc'] as const;

export async function dnd5eGetActorStateBody(
  input: Dnd5eGetActorStateInput,
): Promise<Dnd5eGetActorStateResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc']);

  // D&D 5e's 18 skill abbreviations → display labels.
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

  // Core 5e status ids → display labels; fallback is the raw id. Only used
  // when a status has no backing Active Effect to take a name from.
  const STATUS_LABELS: Record<string, string> = {
    blinded: 'Blinded',
    charmed: 'Charmed',
    deafened: 'Deafened',
    exhaustion: 'Exhaustion',
    frightened: 'Frightened',
    grappled: 'Grappled',
    incapacitated: 'Incapacitated',
    invisible: 'Invisible',
    paralyzed: 'Paralyzed',
    petrified: 'Petrified',
    poisoned: 'Poisoned',
    prone: 'Prone',
    restrained: 'Restrained',
    stunned: 'Stunned',
    unconscious: 'Unconscious',
  };

  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
  }
  interface EffectDocLike {
    id?: string;
    name?: string;
    disabled?: boolean;
    transfer?: boolean;
    duration?: { seconds?: unknown };
    changes?: unknown[];
    statuses?: Iterable<string>;
  }
  interface CombatantDocLike {
    id?: string;
    initiative?: number | null;
    roundOfLastTurn?: number | null;
  }
  interface CombatDocLike {
    id?: string;
    round?: number;
    combatant?: CombatantDocLike | null;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    statuses?: Iterable<string>;
    items?: { contents?: ItemDocLike[] };
    effects?: { contents?: EffectDocLike[] };
    combatant?: CombatantDocLike | null;
    inCombat?: boolean;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    combat?: CombatDocLike | null;
  }

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const actor = game?.actors?.get(input.actorId);
  if (!actor) {
    return {
      ok: false,
      error: {
        code: 'ACTOR_NOT_FOUND',
        message: `No world actor with id "${input.actorId}".`,
        details: { actorId: input.actorId, reason: 'ACTOR_NOT_FOUND' },
      },
    };
  }

  const actorType = typeof actor.type === 'string' ? actor.type : '';
  if (!SUPPORTED.has(actorType)) {
    return {
      ok: false,
      error: {
        code: 'ACTOR_TYPE_UNSUPPORTED',
        message:
          `Actor type '${actorType}' is not supported by dnd5e_get_actor_state. ` +
          `Supported types: character, npc. ` +
          `(vehicle / group / encounter actors have a different shape — use ` +
          `dnd5e_get_creature_details for vehicle stat blocks, or foundry_eval.)`,
        details: { actorId: input.actorId, type: actorType, reason: 'ACTOR_TYPE_UNSUPPORTED' },
      },
    };
  }

  const sys = (actor.system ?? {}) as AnyRecord;

  // ---- helpers (inlined; closures don't survive page.evaluate) -----------

  const get = (o: unknown, k: string): unknown =>
    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;

  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

  // Resolve a Set / array / keyed object to a string array. `actor.statuses`
  // and `effect.statuses` are live `Set`s — `JSON.stringify` flattens a Set
  // to `{}`, so this MUST run in the browser context.
  const setToArray = (v: unknown): string[] => {
    if (v instanceof Set) return Array.from(v).filter((x): x is string => typeof x === 'string');
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (v && typeof v === 'object') return Object.keys(v);
    return [];
  };

  const attributes = obj(get(sys, 'attributes')) ?? {};
  const details = obj(get(sys, 'details')) ?? {};
  const itemContents = Array.isArray(actor.items?.contents) ? actor.items.contents : [];

  // ---- identity ----------------------------------------------------------
  const classes: ClassEntry[] = [];
  if (actorType === 'character') {
    const subclassItems = itemContents.filter((it) => it?.type === 'subclass');
    for (const it of itemContents) {
      if (it?.type !== 'class' || !it.id) continue;
      const cSys = obj(it.system) ?? {};
      const identifier = str(cSys.identifier);
      const sub = subclassItems.find(
        (s) => str(get(obj(s.system), 'classIdentifier')) === identifier,
      );
      classes.push({
        name: str(it.name),
        identifier,
        levels: num(cSys.levels, 0),
        subclass: sub ? str(sub.name) : null,
      });
    }
  }
  const raceItem = itemContents.find((it) => it?.type === 'race');
  const bgItem = itemContents.find((it) => it?.type === 'background');
  const xpRaw = obj(get(details, 'xp'));
  const typeObj = obj(get(details, 'type'));
  const identity: Dnd5eActorIdentity = {
    id: str(actor.id, input.actorId),
    name: str(actor.name),
    type: actorType as 'character' | 'npc',
    level: num(get(details, 'level'), 0),
    xp:
      actorType === 'character' && xpRaw
        ? { value: num(xpRaw.value, 0), max: num(xpRaw.max, 0) }
        : null,
    race: actorType === 'character' && raceItem ? str(raceItem.name) : null,
    background: actorType === 'character' && bgItem ? str(bgItem.name) : null,
    classes,
    cr: actorType === 'npc' ? num(get(details, 'cr'), 0) : null,
    creatureType:
      actorType === 'npc' && typeObj
        ? {
            value: str(typeObj.value),
            subtype: str(typeObj.subtype),
            swarm: str(typeObj.swarm),
          }
        : null,
  };

  // ---- HP / AC -----------------------------------------------------------
  const hpRaw = obj(get(attributes, 'hp')) ?? {};
  const hp: HPBlock = {
    value: num(hpRaw.value, 0),
    max: num(hpRaw.max, 0),
    temp: num(hpRaw.temp, 0), // `temp` is null when unset — coerce to 0.
  };
  const ac = { value: num(get(obj(get(attributes, 'ac')), 'value'), 0) };

  // ---- abilities / saves -------------------------------------------------
  const abilitiesRaw = obj(get(sys, 'abilities')) ?? {};
  const oneAbility = (k: string): AbilityEntry => {
    const a = obj(abilitiesRaw[k]) ?? {};
    return {
      score: num(a.value, 0),
      mod: num(a.mod, 0),
      save: num(get(obj(a.save), 'value'), 0),
      proficient: num(a.proficient, 0) !== 0,
    };
  };
  const abilities: Abilities = {
    str: oneAbility('str'),
    dex: oneAbility('dex'),
    con: oneAbility('con'),
    int: oneAbility('int'),
    wis: oneAbility('wis'),
    cha: oneAbility('cha'),
  };
  const saves: SaveSummary[] = ABILITY_KEYS.map((k) => ({
    ability: k,
    modifier: abilities[k].save,
    proficient: abilities[k].proficient,
  }));

  // ---- senses / speeds ---------------------------------------------------
  const sensesRaw = obj(get(attributes, 'senses')) ?? {};
  const senses: SensesBlock = { units: str(sensesRaw.units, 'ft') };
  for (const k of ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const) {
    const v = num(sensesRaw[k], 0);
    if (v > 0) senses[k] = v;
  }
  const sensesSpecial = str(sensesRaw.special);
  if (sensesSpecial.length > 0) senses.special = sensesSpecial;

  const moveRaw = obj(get(attributes, 'movement')) ?? {};
  const speeds: SpeedsBlock = { walk: num(moveRaw.walk, 0), units: str(moveRaw.units, 'ft') };
  for (const k of ['burrow', 'climb', 'fly', 'swim'] as const) {
    const v = num(moveRaw[k], 0);
    if (v > 0) speeds[k] = v;
  }
  if (moveRaw.hover === true) speeds.hover = true;

  // ---- effects -----------------------------------------------------------
  const effectContents = Array.isArray(actor.effects?.contents) ? actor.effects.contents : [];
  const effects: EffectEntry[] = effectContents.map((e) => {
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

  // ---- conditions --------------------------------------------------------
  // Build one entry per active status id, linking the backing Active Effect
  // (the effect whose own `statuses` set contains the id) when present.
  // Exhaustion's level lives on `system.attributes.exhaustion`, not the
  // status set — surface it separately whenever > 0.
  const conditions: ConditionEntry[] = [];
  const statusIds = setToArray(actor.statuses);
  const exhaustion = num(get(attributes, 'exhaustion'), 0);
  for (const statusId of statusIds) {
    const backing = effectContents.find((e) => setToArray(e.statuses).includes(statusId));
    conditions.push({
      statusId,
      name: backing ? str(backing.name) : (STATUS_LABELS[statusId] ?? statusId),
      value: statusId === 'exhaustion' && exhaustion > 0 ? exhaustion : null,
      effectId: backing && backing.id ? backing.id : null,
      disabled: backing ? backing.disabled === true : false,
    });
  }
  // Exhaustion can be a non-zero level without appearing in `actor.statuses`
  // — ensure it is represented.
  if (exhaustion > 0 && !conditions.some((c) => c.statusId === 'exhaustion')) {
    conditions.push({
      statusId: 'exhaustion',
      name: STATUS_LABELS.exhaustion ?? 'Exhaustion',
      value: exhaustion,
      effectId: null,
      disabled: false,
    });
  }

  // ---- resources ---------------------------------------------------------
  const resourcesRaw = obj(get(sys, 'resources')) ?? {};
  const custom: ResourceEntry[] = [];
  if (actorType === 'character') {
    for (const key of ['primary', 'secondary', 'tertiary']) {
      const r = obj(resourcesRaw[key]);
      if (!r) continue;
      const label = str(r.label);
      const max = num(r.max, 0);
      if (label.length === 0 && max === 0) continue;
      custom.push({ key, label, value: num(r.value, 0), max });
    }
  }
  const legendaryPool = (key: string): { value: number; max: number } | null => {
    if (actorType !== 'npc') return null;
    const r = obj(resourcesRaw[key]);
    if (!r) return null;
    const max = num(r.max, 0);
    if (max === 0) return null;
    return { value: num(r.value, 0), max };
  };
  // Hit dice: `hd` is a HitDice class instance on characters (read .value /
  // .max getters — never JSON round-trip) and a plain object on npc.
  const hdRaw = get(attributes, 'hd');
  let hitDice: { value: number; max: number } | null = null;
  if (hdRaw && typeof hdRaw === 'object') {
    const hdMax = num((hdRaw as Record<string, unknown>).max, 0);
    if (hdMax > 0) {
      hitDice = { value: num((hdRaw as Record<string, unknown>).value, 0), max: hdMax };
    }
  }
  const resources: ResourcesBlock = {
    custom,
    hitDice,
    legendaryActions: legendaryPool('legact'),
    legendaryResistances: legendaryPool('legres'),
  };

  // ---- vitals ------------------------------------------------------------
  const deathRaw = obj(get(attributes, 'death')) ?? {};
  const vitals: VitalsBlock = {
    deathSaves: { success: num(deathRaw.success, 0), failure: num(deathRaw.failure, 0) },
    exhaustion,
    inspiration: get(attributes, 'inspiration') === true,
  };

  // ---- encounter ---------------------------------------------------------
  const combat = game?.combat ?? null;
  const combatant = actor.combatant ?? null;
  const inCombat = Boolean(actor.inCombat) || (combatant != null && combat != null);

  let encounter: EncounterBlockDefault | EncounterBlockFull;
  if (input.includeEncounterState) {
    if (!inCombat || !combat || !combatant) {
      encounter = {
        inCombat: false,
        combatId: null,
        combatantId: null,
        initiative: null,
        isCurrentTurn: false,
        round: null,
        roundOfLastTurn: null,
      };
    } else {
      encounter = {
        inCombat: true,
        combatId: str(combat.id),
        combatantId: str(combatant.id),
        initiative: typeof combatant.initiative === 'number' ? combatant.initiative : null,
        isCurrentTurn: combat.combatant?.id === combatant.id,
        round: num(combat.round, 0),
        roundOfLastTurn:
          typeof combatant.roundOfLastTurn === 'number' ? combatant.roundOfLastTurn : null,
      };
    }
  } else {
    encounter = { inCombat };
  }

  // ---- assemble base result ---------------------------------------------
  const out: Dnd5eGetActorStateOk = {
    ok: true,
    actor: identity,
    hp,
    ac,
    abilities,
    saves,
    senses,
    speeds,
    conditions,
    effects,
    resources,
    vitals,
    encounter,
  };

  // ---- skills (opt-in) ---------------------------------------------------
  // All 18 skills, no `proficient !== 0` curation — a PC wants the full list.
  if (input.includeSkills) {
    const skillsRaw = obj(get(sys, 'skills')) ?? {};
    const skills: SkillEntry[] = [];
    for (const [key, raw] of Object.entries(skillsRaw)) {
      const so = obj(raw);
      if (!so) continue;
      skills.push({
        key,
        name: SKILL_LABELS[key] ?? key,
        ability: str(so.ability),
        modifier: num(so.total, num(so.mod, 0)),
        passive: num(so.passive, 0),
        proficiency: num(so.proficient, 0),
      });
    }
    out.skills = skills;
  }

  // ---- spellcasting (opt-in) --------------------------------------------
  if (input.includeSpellcasting) {
    const spellsRaw = obj(get(sys, 'spells')) ?? {};
    const slots: SpellSlotEntry[] = [];
    for (let i = 0; i <= 9; i += 1) {
      const slot = obj(spellsRaw[`spell${i}`]);
      if (!slot) continue;
      const max = num(slot.max, 0);
      if (max === 0) continue;
      slots.push({
        level: typeof slot.level === 'number' ? slot.level : i,
        value: num(slot.value, 0),
        max,
      });
    }
    const pactRaw = obj(spellsRaw.pact);
    let pact: SpellSlotEntry | undefined;
    if (pactRaw && num(pactRaw.max, 0) > 0) {
      pact = {
        level: num(pactRaw.level, 0),
        value: num(pactRaw.value, 0),
        max: num(pactRaw.max, 0),
      };
    }
    const abilityKey = str(get(attributes, 'spellcasting'));
    const knownSpellCount = itemContents.filter((it) => it?.type === 'spell').length;
    const isAbilityKey = (k: string): k is keyof Abilities =>
      k === 'str' || k === 'dex' || k === 'con' || k === 'int' || k === 'wis' || k === 'cha';
    let saveDc: number | null = null;
    let attackBonus: number | null = null;
    if (isAbilityKey(abilityKey)) {
      const dcRaw = get(obj(abilitiesRaw[abilityKey]), 'dc');
      saveDc = typeof dcRaw === 'number' ? dcRaw : null;
      attackBonus = abilities[abilityKey].mod + num(get(attributes, 'prof'), 0);
    }
    out.spellcasting = {
      ability: abilityKey.length > 0 ? abilityKey : null,
      saveDc,
      attackBonus,
      slots,
      ...(pact ? { pact } : {}),
      knownSpellCount,
    };
  }

  // ---- raw system (opt-in escape hatch) ---------------------------------
  // The live `actor.system` carries class instances (HitDice, Set, etc.)
  // that the CDP structured-clone pipeline drops to `undefined`. A JSON
  // round-trip coerces the tree to plain wire-safe values.
  if (input.includeRawSystem) {
    try {
      out.rawSystem = JSON.parse(JSON.stringify(sys)) as Record<string, unknown>;
    } catch {
      out.rawSystem = {};
    }
  }

  return out;
}
