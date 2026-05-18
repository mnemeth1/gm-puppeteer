/**
 * page.evaluate body for dnd5e_roll_check. Rolls a non-PC D&D 5e actor's
 * real ability / skill / save / tool check through the dnd5e roll
 * pipeline and posts the result to chat.
 *
 * This is the GM rolling for an NPC ("the Archmage rolls Arcana") — it
 * runs the actor's actual stat-block modifier, compares it to an optional
 * DC, and lands the roll in chat as an audit trail.
 *
 * Agency gate: character actors are rejected with ACTOR_IS_PC. The deputy
 * never rolls a PC's checks — use `dnd5e_request_check` to ask the player
 * to roll instead. For arbitrary dice unconnected to a stat block, use
 * `roll_dice`.
 *
 * D&D 5e has no PF2e `Statistic` class and no four-tier degree of
 * success — a check is success or failure, full stop. The check is
 * addressed by a (category, key) pair rather than a single slug because
 * a save reuses an ability key (a "Dexterity check" and a "Dexterity
 * save" share `dex`).
 *
 * Phase-1/2 findings encoded here (verified against dnd5e 5.3.3 +
 * Foundry v14.361 by scripts/probe-dnd5e-roll-check-phase1.mjs and
 * scripts/probe-dnd5e-roll-check-phase2.mjs):
 *   - Roll methods per category: ability → actor.rollAbilityCheck,
 *     skill → actor.rollSkill, save → actor.rollSavingThrow, tool →
 *     actor.rollToolCheck. (rollAbilityTest / rollAbilitySave do NOT
 *     exist in 5.3.3 — they were renamed.)
 *   - All four take the modern (rollConfig, dialogConfig, messageConfig)
 *     triad. rollConfig carries the subject key (`ability` / `skill` /
 *     `tool`) and, for a DC, `target`. dialogConfig `{ configure: false }`
 *     skips the roll-config dialog — confirmed dialog-free (no Application
 *     window opens), so the headless client never hangs. messageConfig
 *     carries `rollMode`.
 *   - A roll returns a `D20Roll[]` of length 1 (no advantage requested).
 *     `roll.total`, natural d20 at `roll.dice[0].results[0].result`.
 *   - DC: passed as `rollConfig.target`. Outcome read from the roll's
 *     `isSuccess` / `isFailure` getters (both false when no target);
 *     falls back to `total >= dc`.
 *   - `rollMode` accepts CONST.DICE_ROLL_MODES values — public →
 *     `publicroll`, gm → `gmroll`, blind → `blindroll`.
 *   - The roll posts its own chat card; the return is the roll array,
 *     not the message, so the message id is recovered by a
 *     `game.messages.size` diff.
 *   - Cold start: the FIRST roll-pipeline call of a browser session
 *     takes ~20s while dnd5e compiles roll templates; subsequent calls
 *     are sub-second. This is slow, not a hang — no timeout is imposed.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export type Dnd5eCheckCategory = 'ability' | 'skill' | 'save' | 'tool';

export interface Dnd5eRollCheckInput {
  actorId: string;
  category: Dnd5eCheckCategory;
  /** Ability key (str/dex/...) for ability & save; skill key (acr/...) for skill; tool key for tool. */
  key: string;
  /** Optional DC; `null` rolls with no target (outcome is then null). */
  dc: number | null;
  visibility: 'public' | 'gm' | 'blind';
}

export type Dnd5eCheckOutcome = 'success' | 'failure';

export interface Dnd5eRollCheckOk {
  ok: true;
  actor: { id: string; name: string; type: string };
  category: Dnd5eCheckCategory;
  key: string;
  dc: number | null;
  /** Numeric total of the check. */
  total: number;
  /** The natural d20 result. */
  dieResult: number;
  /** total − dieResult: the net modifier added to the d20. */
  modifier: number;
  /** Success / failure vs. the DC; `null` when no DC was supplied. */
  outcome: Dnd5eCheckOutcome | null;
  visibility: 'public' | 'gm' | 'blind';
  chatMessageId: string | null;
}

export interface Dnd5eRollCheckErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eRollCheckResult = Dnd5eRollCheckOk | Dnd5eRollCheckErr;

export async function dnd5eRollCheckBody(
  input: Dnd5eRollCheckInput,
): Promise<Dnd5eRollCheckResult> {
  interface RollResultEntry {
    result?: unknown;
  }
  interface RollLike {
    total?: unknown;
    isSuccess?: unknown;
    isFailure?: unknown;
    dice?: Array<{ results?: RollResultEntry[] }>;
  }
  type RollFn = (
    rollConfig: Record<string, unknown>,
    dialogConfig: Record<string, unknown>,
    messageConfig: Record<string, unknown>,
  ) => Promise<unknown>;
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    rollAbilityCheck?: RollFn;
    rollSkill?: RollFn;
    rollSavingThrow?: RollFn;
    rollToolCheck?: RollFn;
  }
  interface MessagesCollectionLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    messages?: MessagesCollectionLike;
  }
  interface Dnd5eConfigLike {
    abilities?: Record<string, unknown>;
    skills?: Record<string, unknown>;
    tools?: Record<string, unknown>;
  }

  const fail = (message: string, details: Record<string, unknown>): Dnd5eRollCheckErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const ROLL_MODES: Record<string, string> = {
    public: 'publicroll',
    gm: 'gmroll',
    blind: 'blindroll',
  };

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  if (!game) {
    return fail('Foundry game global is unavailable.', { reason: 'FOUNDRY_NOT_READY' });
  }
  const dnd5eConfig = (globalThis as unknown as { CONFIG?: { DND5E?: Dnd5eConfigLike } }).CONFIG
    ?.DND5E;
  if (!dnd5eConfig) {
    return fail('CONFIG.DND5E is unavailable — is this a D&D 5e world?', {
      reason: 'FOUNDRY_NOT_READY',
    });
  }

  // -- Resolve actor.
  const actor = game.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, {
      actorId: input.actorId,
      reason: 'ACTOR_NOT_FOUND',
    });
  }

  // -- Agency gate: never roll a PC's checks. dnd5e_request_check is the PC path.
  if (actor.type === 'character') {
    return fail(
      `Actor '${actor.name ?? input.actorId}' is a player character. dnd5e_roll_check rolls ` +
        `only for non-PC actors. To ask the player to roll a check for their own character, ` +
        `use dnd5e_request_check instead.`,
      { actorId: input.actorId, actorType: actor.type, reason: 'ACTOR_IS_PC' },
    );
  }
  if (actor.type !== 'npc') {
    return fail(
      `Actor '${actor.name ?? input.actorId}' has type '${actor.type ?? 'unknown'}'. ` +
        `dnd5e_roll_check supports npc actors only (vehicle / group actors do not roll checks).`,
      { actorId: input.actorId, actorType: actor.type ?? null, reason: 'ACTOR_TYPE_UNSUPPORTED' },
    );
  }

  // -- Route to the roll method and validate the key against CONFIG.DND5E.
  let rollFn: RollFn | undefined;
  let configKey: string;
  let validKeys: Record<string, unknown> | undefined;
  if (input.category === 'ability') {
    rollFn = actor.rollAbilityCheck;
    configKey = 'ability';
    validKeys = dnd5eConfig.abilities;
  } else if (input.category === 'save') {
    rollFn = actor.rollSavingThrow;
    configKey = 'ability';
    validKeys = dnd5eConfig.abilities;
  } else if (input.category === 'skill') {
    rollFn = actor.rollSkill;
    configKey = 'skill';
    validKeys = dnd5eConfig.skills;
  } else {
    rollFn = actor.rollToolCheck;
    configKey = 'tool';
    validKeys = dnd5eConfig.tools;
  }

  if (!validKeys || !(input.key in validKeys)) {
    return fail(
      `'${input.key}' is not a valid D&D 5e ${input.category} key. Expected one of: ` +
        `${Object.keys(validKeys ?? {}).join(', ')}.`,
      {
        category: input.category,
        key: input.key,
        validKeys: Object.keys(validKeys ?? {}),
        reason: 'CHECK_KEY_INVALID',
      },
    );
  }
  if (typeof rollFn !== 'function') {
    return fail(
      `Actor '${actor.name ?? input.actorId}' does not expose the roll method for a ` +
        `${input.category} check.`,
      { actorId: input.actorId, category: input.category, reason: 'ROLL_METHOD_MISSING' },
    );
  }

  // -- Build the (rollConfig, dialogConfig, messageConfig) triad.
  const rollConfig: Record<string, unknown> = { [configKey]: input.key };
  if (typeof input.dc === 'number') rollConfig.target = input.dc;
  const dialogConfig = { configure: false };
  const messageConfig = { rollMode: ROLL_MODES[input.visibility] ?? 'publicroll' };

  const msgCountBefore = game.messages?.size ?? 0;

  let raw: unknown;
  try {
    raw = await rollFn.call(actor, rollConfig, dialogConfig, messageConfig);
  } catch (e: unknown) {
    return fail(
      `Rolling the ${input.category} check '${input.key}' for ` +
        `'${actor.name ?? input.actorId}' threw: ${errText(e)}`,
      {
        actorId: input.actorId,
        category: input.category,
        key: input.key,
        error: errText(e),
        reason: 'ROLL_THREW',
      },
    );
  }

  const roll: RollLike | undefined = Array.isArray(raw)
    ? (raw[0] as RollLike | undefined)
    : (raw as RollLike | undefined);
  if (!roll || typeof roll.total !== 'number') {
    return fail(
      `dnd5e returned no usable roll for the ${input.category} check '${input.key}' on ` +
        `'${actor.name ?? input.actorId}'.`,
      {
        actorId: input.actorId,
        category: input.category,
        key: input.key,
        reason: 'ROLL_RETURNED_NULL',
      },
    );
  }

  // -- Recover chat message id via size diff (the roll posts its own card).
  let chatMessageId: string | null = null;
  const msgCountAfter = game.messages?.size ?? 0;
  if (msgCountAfter > msgCountBefore) {
    const contents = game.messages?.contents ?? [];
    const latest = contents[contents.length - 1];
    if (latest && typeof latest.id === 'string') chatMessageId = latest.id;
  }

  // -- Project results.
  const total = roll.total;
  const dieResultRaw = roll.dice?.[0]?.results?.[0]?.result;
  const dieResult = typeof dieResultRaw === 'number' ? dieResultRaw : 0;
  let outcome: Dnd5eCheckOutcome | null = null;
  if (typeof input.dc === 'number') {
    if (roll.isSuccess === true) outcome = 'success';
    else if (roll.isFailure === true) outcome = 'failure';
    else outcome = total >= input.dc ? 'success' : 'failure';
  }

  return {
    ok: true,
    actor: {
      id: actor.id ?? input.actorId,
      name: actor.name ?? '',
      type: actor.type ?? '',
    },
    category: input.category,
    key: input.key,
    dc: input.dc,
    total,
    dieResult,
    modifier: total - dieResult,
    outcome,
    visibility: input.visibility,
    chatMessageId,
  };
}
