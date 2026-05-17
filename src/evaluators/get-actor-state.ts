/**
 * page.evaluate body for pf2e_get_actor_state. Returns a focused projection
 * of an actor's combat-relevant state: HP, AC, saves, perception,
 * attributes, speeds, conditions, effects, resources, IWR, vitals
 * (dying/wounded/doomed). Opt-in flags expand into skills, spellcasting,
 * encounter state, and the full raw system blob.
 *
 * Foundation read-tool for the condition-mutation cluster
 * (`pf2e_apply_condition` / `pf2e_remove_condition` / `pf2e_set_condition_value`): those
 * tools need to know what's already on an actor before mutating, and the
 * projection's `conditions[]` shape (slug + value + grantedBy) directly
 * informs their input/response surface.
 *
 * Behavior nuances confirmed by Phase 1 probes against Foundry v14.361
 * + PF2e 8.1.2:
 *
 *  - **Conditions** live as embedded items with `type === 'condition'`,
 *    enumerable via `actor.itemTypes.condition`. Per-item fields:
 *      `system.slug` — canonical PF2e slug, e.g. "frightened",
 *        "off-guard". This is what apply/pf2e_remove_condition will accept.
 *      `system.value: {isValued: bool, value: number | null}` —
 *        non-valued conditions (off-guard, prone) have
 *        `isValued: false, value: null`; valued (frightened, sickened,
 *        dying) have `isValued: true` + numeric value.
 *      `system.persistent: {formula, damageType, dc, criticalHit}|null`
 *        — populated only on the "persistent-damage" slug.
 *      `system.group: string | null` — loose category, e.g. "death"
 *        (wounded/dying/doomed), "senses" (dazzled/blinded), "abilities"
 *        (drained). Useful for caller-side filtering; not a stable taxonomy.
 *      `flags.pf2e.grantedBy: {id, onDelete} | null` — when a condition
 *        is cascaded from a parent (e.g. `dying` grants `unconscious`
 *        grants `blinded`+`prone`), the child carries grantedBy pointing
 *        at the parent's embedded id. Tools that delete a parent should
 *        be aware Foundry/PF2e auto-deletes children with onDelete:
 *        "cascade".
 *      Conditions DO carry `system.duration: {value:-1, unit:"unlimited"}`
 *        in the compendium template, but it's uniform across all
 *        conditions — PF2e does NOT encode "permanent vs encounter-bound"
 *        on the condition itself. We do not surface this field.
 *
 *  - **Effects** live as embedded items with `type === 'effect'`,
 *    enumerable via `actor.itemTypes.effect`. Per-item fields:
 *      `_stats.compendiumSource` — the compendium UUID the effect was
 *        imported from (consistent with other Foundry items).
 *      `system.duration: {value: number, unit: string, expiry: string|null,
 *        sustained: bool}` — structured, not free-text. value=-1 +
 *        unit="unlimited" means no time limit. Surface verbatim plus a
 *        derived human-readable `durationLabel`.
 *      `system.level.value` — effect level (relevant for some traditions).
 *      `system.badge` — null or a stacking-counter object.
 *      `effect.remainingDuration: {remaining: number, expired: bool}` —
 *        live computed seconds remaining; we don't surface this in
 *        default (it changes every round) but it's available behind
 *        rawSystem.
 *
 *  - **Vitals** (dying/wounded/doomed): live BOTH as conditions (when
 *    value > 0) AND at `system.attributes.{dying|wounded|doomed}` —
 *    `{value, max, recoveryDC?}` — always present on character/npc/
 *    familiar even at 0. The attribute path is canonical (the condition
 *    entry is a UI/cascade reflection of the numeric attribute). We
 *    surface a top-level `vitals` block from the attribute path; the
 *    conditions[] array independently reflects whichever are currently
 *    "in effect" (value > 0). NOT duplication — vitals = always-present
 *    numeric state; conditions = active item entries.
 *
 *  - **HP** = `system.attributes.hp.{value, max, temp}`. `temp` is the
 *    canonical field name in PF2e 8.1.2 (NOT `tempHp` / `temporary`);
 *    defaults to 0.
 *
 *  - **AC** = `system.attributes.ac.value` IS the effective AC. PF2e's
 *    stat machinery folds raised-shield, frightened, off-guard,
 *    unconscious, etc. into `value` at preparation time. The
 *    `modifiers[]` array can be inspected for breakdown; we don't expose
 *    that in default to keep the projection small.
 *
 *  - **Saves** = `system.saves.{fortitude, reflex, will}.value` — same
 *    "effective modifier" semantics as AC. `totalModifier` is a synonym.
 *
 *  - **Perception** = `system.perception.{value, senses}`. `value` is
 *    the effective modifier. `senses` is an array of
 *    `{type, acuity, range, label, ...}` — we keep type, acuity, range,
 *    label. Range is `null` when unlimited (e.g. darkvision).
 *
 *  - **Abilities** = `system.abilities.{str|dex|con|int|wis|cha}.mod`
 *    on character + npc. **Familiar exception:** `system.abilities` is
 *    ABSENT on familiars (they use their master's modifiers per PF2e
 *    rules). We project 0 for absent ability mods on familiars and call
 *    that out in the result-shape contract.
 *
 *  - **Speeds** live at `system.movement.speeds.{land, burrow, climb,
 *    fly, swim, travel}`. `land` is always an object `{value, ...}`
 *    even at 0; `burrow/climb/fly/swim` are `null` when the creature
 *    lacks that movement; `travel` is computed and ignored.
 *    `system.attributes.speed` does NOT exist in PF2e 8.1.2 — checking
 *    that path returns undefined.
 *
 *  - **Resources** = `system.resources`. Character has
 *    `heroPoints.{value, max}`; absent on npc/familiar (project null).
 *    `focus.{value, max, cap}` exists on all but is meaningful only
 *    when `max > 0` (treat max===0 as no focus pool, project null).
 *
 *  - **IWR** at `system.attributes.{immunities, weaknesses,
 *    resistances}` as arrays. Immunity entries: `{type, exceptions[]}`.
 *    Weakness entries: `{type, value, exceptions[]}`. Resistance
 *    entries: `{type, value, exceptions[], doubleVs[]}`. We strip
 *    PF2e's i18n `typeLabels` blob (it's the full IWR type dictionary,
 *    cluttering output by ~80×). Also strip `definition`/`source` —
 *    debugging info, not consumer-relevant.
 *
 *  - **Skills** (opt-in) = `system.skills.{slug}.{rank, value,
 *    totalModifier, attribute, label, slug}`. Lore skills are
 *    intermixed (e.g. "farming-lore"). rank 0..4 maps to
 *    untrained..legendary.
 *
 *  - **Spellcasting** (opt-in) = `actor.spellcasting` iterable. Must
 *    FILTER to `entry.type === 'spellcastingEntry'` — the iterable also
 *    yields a "rituals" pseudo-container and per-scroll consumable
 *    casting entries (ids ending in "-casting"). Per real entry:
 *    `system.prepared.value` is the category
 *    ("prepared"|"spontaneous"|"focus"|"innate"), `system.tradition.value`
 *    is the tradition or "", `system.slots.{slot0..slot11}.{prepared[],
 *    value, max}` where slot0 = cantrips and slotN = spell rank N.
 *
 *  - **Encounter** (opt-in) = `game.combat` (active combat or null) +
 *    `actor.combatant` (Combatant document or null). Combatant fields:
 *    `id`, `initiative` (number|null), `roundOfLastTurn`. Current-turn
 *    detection: `game.combat?.combatant?.id === actor.combatant?.id`.
 *    The default `encounter: {inCombat: bool}` shape collapses to just
 *    the boolean; opt-in expands.
 *
 *  - **Actor type support:** `character`, `npc`, `familiar`. Reject
 *    `army`, `hazard`, `loot`, `party`, `vehicle`, or any unknown type
 *    with ACTOR_TYPE_UNSUPPORTED. The error message names the supported
 *    types.
 *
 *  - **Level:** `system.details.level.value` on all three supported
 *    types (familiar level is informational — familiars take their
 *    master's level for combat math, but the stored field is meaningful
 *    for the projection).
 *
 *  - **Character-only identity fields** (`ancestry`, `heritage`, `class`):
 *    Read from the prepared actor's convenience accessors
 *    (`actor.ancestry?.name`, etc.). For npc/familiar these are null.
 *
 * Note: This function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source string to the browser.
 * Module-scope helpers, imports, and outer closures are NOT available
 * at runtime — every helper is defined inline.
 */
export interface GetActorStateInput {
  actorId: string;
  includeSkills: boolean;
  includeSpellcasting: boolean;
  includeEncounterState: boolean;
  includeRawSystem: boolean;
}

export interface ActorIdentity {
  id: string;
  name: string;
  type: 'character' | 'npc' | 'familiar';
  level: number;
  ancestry: string | null;
  heritage: string | null;
  class: string | null;
}

export interface HPBlock {
  value: number;
  max: number;
  temp: number;
}

export interface SaveBlock {
  modifier: number;
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

export interface ConditionEntry {
  id: string;
  slug: string;
  name: string;
  value: number | null;
  group: string | null;
  grantedBy: string | null;
  persistent: {
    formula: string;
    damageType: string;
    dc: number | null;
  } | null;
}

export interface EffectEntry {
  id: string;
  name: string;
  sourceUuid: string | null;
  durationLabel: string | null;
  level: number | null;
}

export interface ResourcesBlock {
  heroPoints: { value: number; max: number } | null;
  focus: { value: number; max: number } | null;
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

export interface VitalEntry {
  value: number;
  max: number;
  recoveryDC?: number;
}

export interface VitalsBlock {
  dying: VitalEntry;
  wounded: VitalEntry;
  doomed: VitalEntry;
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
  slug: string;
  name: string;
  modifier: number;
  proficiency: 'untrained' | 'trained' | 'expert' | 'master' | 'legendary';
}

export interface SpellSlotEntry {
  level: number;
  value: number;
  max: number;
}

export interface SpellcastingEntry {
  entryId: string;
  name: string;
  type: 'prepared' | 'spontaneous' | 'focus' | 'innate' | string;
  tradition: 'arcane' | 'divine' | 'occult' | 'primal' | null;
  slots: SpellSlotEntry[];
}

export interface GetActorStateOk {
  ok: true;
  actor: ActorIdentity;
  hp: HPBlock;
  ac: { value: number };
  saves: { fortitude: SaveBlock; reflex: SaveBlock; will: SaveBlock };
  perception: PerceptionBlock;
  attributes: AbilityMods;
  speeds: SpeedsBlock;
  conditions: ConditionEntry[];
  effects: EffectEntry[];
  resources: ResourcesBlock;
  iwr: IWRBlock;
  vitals: VitalsBlock;
  encounter: EncounterBlockDefault | EncounterBlockFull;
  skills?: SkillEntry[];
  spellcasting?: SpellcastingEntry[];
  rawSystem?: Record<string, unknown>;
}

export interface GetActorStateErr {
  ok: false;
  error: {
    code: 'ACTOR_NOT_FOUND' | 'ACTOR_TYPE_UNSUPPORTED';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type GetActorStateResult = GetActorStateOk | GetActorStateErr;

/** Actor types this evaluator emits a projection for. Exported so the
 * tool layer can name them in user-facing error messages. */
export const SUPPORTED_ACTOR_TYPES = ['character', 'npc', 'familiar'] as const;

export async function getActorStateBody(input: GetActorStateInput): Promise<GetActorStateResult> {
  // Inlined: module-scope identifiers do NOT survive page.evaluate
  // serialization — only the function source is shipped to the browser.
  const SUPPORTED = new Set(['character', 'npc', 'familiar']);
  const PROFICIENCY_LABELS = ['untrained', 'trained', 'expert', 'master', 'legendary'] as const;
  type ProficiencyLabel = (typeof PROFICIENCY_LABELS)[number];

  type AnyRecord = Record<string, unknown> & { [k: string]: unknown };

  interface ItemDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    flags?: AnyRecord;
    _stats?: { compendiumSource?: unknown };
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
  interface SpellcastingEntryDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    system?: AnyRecord;
    itemTypes?: {
      condition?: ItemDocLike[];
      effect?: ItemDocLike[];
    };
    spellcasting?: Iterable<SpellcastingEntryDocLike>;
    combatant?: CombatantDocLike | null;
    inCombat?: boolean;
    ancestry?: { name?: string } | null;
    heritage?: { name?: string } | null;
    class?: { name?: string } | null;
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
        message: `No actor found for actorId: ${input.actorId}`,
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
          `Actor type '${actorType}' is not supported by pf2e_get_actor_state. ` +
          `Supported types: character, npc, familiar. ` +
          `(party/loot/hazard/vehicle/army actors have a different shape ` +
          `and should be queried with their own future tools or foundry_eval.)`,
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

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  // Map a PF2e proficiency rank (0..4) to its label.
  const proficiencyLabel = (rank: unknown): ProficiencyLabel => {
    const r = num(rank, 0);
    return PROFICIENCY_LABELS[r] ?? 'untrained';
  };

  // Format a PF2e effect duration into a human-readable label.
  // `{value: 10, unit: 'minutes'}` → "10 minutes".
  // `{value: -1, unit: 'unlimited'}` → "unlimited".
  // `{value: 0, unit: 'encounter'}` → "encounter".
  const formatDuration = (durRaw: unknown): string | null => {
    const d = obj(durRaw);
    if (!d) return null;
    const unit = str(d.unit);
    if (!unit) return null;
    const value = num(d.value, 0);
    if (unit === 'unlimited' || unit === 'encounter') return unit;
    if (value <= 0) return unit;
    return `${value} ${unit}`;
  };

  // ---- identity ----------------------------------------------------------
  const level = num(get(obj(get(sys, 'details')), 'level'), 0);
  const levelObj = obj(get(obj(get(sys, 'details')), 'level'));
  const actualLevel = levelObj ? num(levelObj.value, level) : level;

  const identity: ActorIdentity = {
    id: str(actor.id, input.actorId),
    name: str(actor.name),
    type: actorType as 'character' | 'npc' | 'familiar',
    level: actualLevel,
    ancestry:
      actorType === 'character' && actor.ancestry && typeof actor.ancestry.name === 'string'
        ? actor.ancestry.name
        : null,
    heritage:
      actorType === 'character' && actor.heritage && typeof actor.heritage.name === 'string'
        ? actor.heritage.name
        : null,
    class:
      actorType === 'character' && actor.class && typeof actor.class.name === 'string'
        ? actor.class.name
        : null,
  };

  // ---- HP / AC / saves / perception --------------------------------------
  const hpRaw = obj(get(obj(get(sys, 'attributes')), 'hp')) ?? {};
  const hp: HPBlock = {
    value: num(hpRaw.value, 0),
    max: num(hpRaw.max, 0),
    temp: num(hpRaw.temp, 0),
  };

  const acRaw = obj(get(obj(get(sys, 'attributes')), 'ac')) ?? {};
  const ac = { value: num(acRaw.value, 0) };

  const savesRaw = obj(get(sys, 'saves')) ?? {};
  const fortRaw = obj(savesRaw.fortitude) ?? {};
  const refRaw = obj(savesRaw.reflex) ?? {};
  const willRaw = obj(savesRaw.will) ?? {};
  const saves = {
    fortitude: { modifier: num(fortRaw.value, num(fortRaw.totalModifier, 0)) },
    reflex: { modifier: num(refRaw.value, num(refRaw.totalModifier, 0)) },
    will: { modifier: num(willRaw.value, num(willRaw.totalModifier, 0)) },
  };

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
  const perception: PerceptionBlock = {
    modifier: num(percRaw.value, num(percRaw.totalModifier, 0)),
    senses,
  };

  // ---- attributes (ability mods) -----------------------------------------
  // PF2e exposes ability MODIFIERS at system.abilities.{x}.mod. Familiars
  // omit `system.abilities` entirely (they inherit from their master).
  // We project 0 for absent ability mods on familiars; callers detecting
  // `actor.type === 'familiar'` and needing the master's stats should
  // query that actor separately.
  const abRaw = obj(get(sys, 'abilities')) ?? {};
  const abilityMod = (k: string): number => {
    const a = obj(get(abRaw, k));
    return a ? num(a.mod, 0) : 0;
  };
  const attributes: AbilityMods = {
    str: abilityMod('str'),
    dex: abilityMod('dex'),
    con: abilityMod('con'),
    int: abilityMod('int'),
    wis: abilityMod('wis'),
    cha: abilityMod('cha'),
  };

  // ---- speeds ------------------------------------------------------------
  // Live at system.movement.speeds. land is always present (even at 0);
  // burrow/climb/fly/swim are null when absent. We skip travel (derived).
  const speedsRaw = obj(get(obj(get(sys, 'movement')), 'speeds')) ?? {};
  const speedValue = (key: string): number | null => {
    const entry = obj(get(speedsRaw, key));
    if (!entry) return null;
    return num(entry.value, 0);
  };
  const speeds: SpeedsBlock = { land: speedValue('land') ?? 0 };
  for (const k of ['fly', 'swim', 'climb', 'burrow'] as const) {
    const v = speedValue(k);
    if (v !== null && v > 0) speeds[k] = v;
  }

  // ---- conditions --------------------------------------------------------
  const condItems = actor.itemTypes?.condition ?? [];
  const conditions: ConditionEntry[] = [];
  for (const c of condItems) {
    if (!c || !c.id) continue;
    const cSys = (c.system as AnyRecord | undefined) ?? {};
    const valueObj = obj(cSys.value);
    const isValued = valueObj?.isValued === true;
    const condValue = isValued ? num(valueObj?.value, 0) : null;
    const persistentRaw = obj(cSys.persistent);
    const persistent = persistentRaw
      ? {
          formula: str(persistentRaw.formula),
          damageType: str(persistentRaw.damageType),
          dc: typeof persistentRaw.dc === 'number' ? persistentRaw.dc : null,
        }
      : null;
    const grantedByRaw = obj(get(obj(get(c.flags, 'pf2e')), 'grantedBy'));
    const grantedBy =
      grantedByRaw && typeof grantedByRaw.id === 'string' && grantedByRaw.id.length > 0
        ? grantedByRaw.id
        : null;
    conditions.push({
      id: c.id,
      slug: str(cSys.slug),
      name: str(c.name),
      value: condValue,
      group: typeof cSys.group === 'string' ? cSys.group : null,
      grantedBy,
      persistent,
    });
  }

  // ---- effects -----------------------------------------------------------
  const effItems = actor.itemTypes?.effect ?? [];
  const effects: EffectEntry[] = [];
  for (const e of effItems) {
    if (!e || !e.id) continue;
    const eSys = (e.system as AnyRecord | undefined) ?? {};
    const sourceRaw = e._stats?.compendiumSource;
    const levelRaw = obj(eSys.level);
    effects.push({
      id: e.id,
      name: str(e.name),
      sourceUuid: typeof sourceRaw === 'string' ? sourceRaw : null,
      durationLabel: formatDuration(eSys.duration),
      level: levelRaw && typeof levelRaw.value === 'number' ? levelRaw.value : null,
    });
  }

  // ---- resources ---------------------------------------------------------
  const resRaw = obj(get(sys, 'resources')) ?? {};
  const hpRes = obj(resRaw.heroPoints);
  const focusRes = obj(resRaw.focus);
  const resources: ResourcesBlock = {
    heroPoints: hpRes ? { value: num(hpRes.value, 0), max: num(hpRes.max, 0) } : null,
    focus:
      focusRes && num(focusRes.max, 0) > 0
        ? { value: num(focusRes.value, 0), max: num(focusRes.max, 0) }
        : null,
  };

  // ---- IWR ---------------------------------------------------------------
  const attrRaw = obj(get(sys, 'attributes')) ?? {};
  const immunitiesRaw = Array.isArray(attrRaw.immunities) ? (attrRaw.immunities as unknown[]) : [];
  const weaknessesRaw = Array.isArray(attrRaw.weaknesses) ? (attrRaw.weaknesses as unknown[]) : [];
  const resistancesRaw = Array.isArray(attrRaw.resistances)
    ? (attrRaw.resistances as unknown[])
    : [];
  const iwr: IWRBlock = {
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

  // ---- vitals (dying / wounded / doomed) ---------------------------------
  // Always present on character/npc/familiar at
  // system.attributes.{dying|wounded|doomed} as {value, max, recoveryDC?}.
  const vitalEntry = (key: string): VitalEntry => {
    const v = obj(get(attrRaw, key));
    if (!v) return { value: 0, max: 0 };
    const out: VitalEntry = {
      value: num(v.value, 0),
      max: num(v.max, 0),
    };
    if (typeof v.recoveryDC === 'number') out.recoveryDC = v.recoveryDC;
    return out;
  };
  const vitals: VitalsBlock = {
    dying: vitalEntry('dying'),
    wounded: vitalEntry('wounded'),
    doomed: vitalEntry('doomed'),
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
  const out: GetActorStateOk = {
    ok: true,
    actor: identity,
    hp,
    ac,
    saves,
    perception,
    attributes,
    speeds,
    conditions,
    effects,
    resources,
    iwr,
    vitals,
    encounter,
  };

  // ---- skills (opt-in) ---------------------------------------------------
  if (input.includeSkills) {
    const skillsRaw = obj(get(sys, 'skills')) ?? {};
    const skills: SkillEntry[] = [];
    for (const [slug, raw] of Object.entries(skillsRaw)) {
      const so = obj(raw);
      if (!so) continue;
      skills.push({
        slug,
        name: typeof so.label === 'string' ? so.label : slug,
        modifier: num(so.value, num(so.totalModifier, 0)),
        proficiency: proficiencyLabel(so.rank),
      });
    }
    out.skills = skills;
  }

  // ---- spellcasting (opt-in) --------------------------------------------
  if (input.includeSpellcasting) {
    const sc: SpellcastingEntry[] = [];
    const iterable = actor.spellcasting;
    if (iterable) {
      for (const entry of iterable) {
        if (!entry || entry.type !== 'spellcastingEntry') continue;
        const eSys = (entry.system as AnyRecord | undefined) ?? {};
        const prepared = obj(eSys.prepared);
        const tradition = obj(eSys.tradition);
        const slotsRaw = obj(eSys.slots) ?? {};
        const slots: SpellSlotEntry[] = [];
        for (let i = 0; i <= 11; i += 1) {
          const slot = obj(slotsRaw[`slot${i}`]);
          if (!slot) continue;
          const maxV = num(slot.max, 0);
          if (maxV === 0) continue; // skip empty slot levels
          slots.push({
            level: i,
            value: num(slot.value, 0),
            max: maxV,
          });
        }
        const traditionV = typeof tradition?.value === 'string' ? tradition.value : '';
        sc.push({
          entryId: str(entry.id),
          name: str(entry.name),
          type: typeof prepared?.value === 'string' ? prepared.value : 'prepared',
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
    }
    out.spellcasting = sc;
  }

  // ---- raw system (opt-in escape hatch) ---------------------------------
  // PF2e's live `actor.system` includes Stat instances, Map-like
  // collections, and other class instances that CDP's structured-clone
  // pipeline drops to `undefined` (which would tank the whole page.evaluate
  // result). PF2e implements `toJSON` on its stat objects, so a
  // JSON.stringify roundtrip coerces the tree to plain objects/arrays/
  // primitives that survive the wire. This is the same pattern
  // pf2e_search_compendium uses when shipping index entries.
  if (input.includeRawSystem) {
    try {
      out.rawSystem = JSON.parse(JSON.stringify(sys)) as Record<string, unknown>;
    } catch {
      out.rawSystem = {};
    }
  }

  return out;
}
