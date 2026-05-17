/**
 * page.evaluate body for pf2e_roll_check. Rolls a non-PC actor's real
 * statistic check through the PF2e check pipeline and posts the result
 * to chat.
 *
 * This is the GM rolling for an NPC ("Redcap, roll Stealth") — it runs
 * the actor's actual stat-block modifier, produces a degree of success
 * against an optional DC, and lands the roll in chat as an audit trail.
 *
 * Agency gate: character actors are rejected with ACTOR_IS_PC. The
 * deputy never rolls a PC's checks — use `pf2e_request_check` to ask the
 * player to roll instead. For arbitrary dice unconnected to a stat
 * block, use `roll_dice`.
 *
 * Statistic routing (confirmed against PF2e 8.1.2, Foundry v14.361 by
 * scripts/probe-roll-check-phase1.mjs):
 *   - perception      → actor.perception   (PerceptionStatistic)
 *   - fortitude/reflex/will → actor.saves[slug]   (Statistic)
 *   - the 16 skills   → actor.skills[slug]  (Statistic)
 * All three expose `.roll(args)` and a check modifier at `.check.mod`.
 *
 * Phase-1 findings encoded here:
 *   - `Statistic.roll({ skipDialog: true })` with NO `event` key
 *     bypasses CheckModifiersDialog cleanly — required for headless.
 *   - `roll()` returns a `CheckRoll` (or `null` for an actor type the
 *     pipeline does not support). `null` → ROLL_RETURNED_NULL.
 *   - The returned roll carries `options.degreeOfSuccess` (0-3) when a
 *     DC was supplied, and `null` when no DC was given.
 *   - `messageMode` accepts `public` | `gm` | `blind` (keys of
 *     CONFIG.ChatMessage.modes); `createMessage: true` posts the card.
 *   - `roll()` returns the Roll, not the ChatMessage — the message id
 *     is recovered by a `game.messages.size` diff, mirroring use-item.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export interface RollCheckInput {
  actorId: string;
  /** perception | one of the 16 PF2e skills | fortitude | reflex | will. */
  checkType: string;
  /** Optional DC; `null` rolls with no target (outcome is then null). */
  dc: number | null;
  visibility: 'public' | 'gm' | 'blind';
}

export type CheckOutcome = 'criticalSuccess' | 'success' | 'failure' | 'criticalFailure';

export interface RollCheckOk {
  ok: true;
  actor: { id: string; name: string; type: string };
  checkType: string;
  /** The resolved statistic slug (usually equal to checkType). */
  statisticSlug: string;
  /** The statistic's total check modifier. */
  modifier: number;
  dc: number | null;
  /** Numeric total of the check. */
  total: number;
  /** The natural d20 result. */
  dieResult: number;
  /** Degree of success vs. the DC; `null` when no DC was supplied. */
  outcome: CheckOutcome | null;
  visibility: 'public' | 'gm' | 'blind';
  chatMessageId: string | null;
}

export interface RollCheckErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RollCheckResult = RollCheckOk | RollCheckErr;

export async function rollCheckBody(input: RollCheckInput): Promise<RollCheckResult> {
  interface StatisticLike {
    slug?: unknown;
    mod?: unknown;
    check?: { mod?: unknown };
    roll?: (args: Record<string, unknown>) => Promise<RollLike | null>;
  }
  interface RollResultEntry {
    result?: unknown;
  }
  interface RollLike {
    total?: unknown;
    degreeOfSuccess?: unknown;
    options?: { degreeOfSuccess?: unknown };
    dice?: Array<{ results?: RollResultEntry[] }>;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    perception?: StatisticLike;
    skills?: Record<string, StatisticLike | undefined>;
    saves?: Record<string, StatisticLike | undefined>;
  }
  interface MessagesCollectionLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    messages?: MessagesCollectionLike;
  }

  const fail = (message: string, details: Record<string, unknown>): RollCheckErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const SAVE_SLUGS = new Set(['fortitude', 'reflex', 'will']);
  const OUTCOMES: CheckOutcome[] = ['criticalFailure', 'failure', 'success', 'criticalSuccess'];

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  if (!game) {
    return fail('Foundry game global is unavailable.', {
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

  // -- Agency gate: never roll a PC's checks. pf2e_request_check is the PC path.
  if (actor.type === 'character') {
    return fail(
      `Actor '${actor.name ?? input.actorId}' is a player character. pf2e_roll_check rolls ` +
        `only for non-PC actors (NPCs, hazards, familiars). To ask the player to roll a ` +
        `check for their own character, use pf2e_request_check instead.`,
      { actorId: input.actorId, actorType: actor.type, reason: 'ACTOR_IS_PC' },
    );
  }

  // -- Route to the statistic.
  let statistic: StatisticLike | undefined;
  if (input.checkType === 'perception') {
    statistic = actor.perception;
  } else if (SAVE_SLUGS.has(input.checkType)) {
    statistic = actor.saves?.[input.checkType];
  } else {
    statistic = actor.skills?.[input.checkType];
  }
  if (!statistic || typeof statistic.roll !== 'function') {
    return fail(
      `Actor '${actor.name ?? input.actorId}' (type ${actor.type ?? 'unknown'}) has no ` +
        `rollable '${input.checkType}' statistic. Some actor types (e.g. hazards) do not ` +
        `expose every check.`,
      {
        actorId: input.actorId,
        actorType: actor.type ?? null,
        checkType: input.checkType,
        reason: 'STATISTIC_UNAVAILABLE',
      },
    );
  }

  const statisticSlug = typeof statistic.slug === 'string' ? statistic.slug : input.checkType;
  const modifier =
    typeof statistic.check?.mod === 'number'
      ? statistic.check.mod
      : typeof statistic.mod === 'number'
        ? statistic.mod
        : 0;

  // -- Roll. No `event` key — that re-derives skipDialog/messageMode from
  // keyboard state. skipDialog:true bypasses CheckModifiersDialog.
  const rollArgs: Record<string, unknown> = {
    skipDialog: true,
    createMessage: true,
    messageMode: input.visibility,
  };
  if (typeof input.dc === 'number') rollArgs.dc = input.dc;

  const msgCountBefore = game.messages?.size ?? 0;

  let roll: RollLike | null;
  try {
    roll = await statistic.roll(rollArgs);
  } catch (e: unknown) {
    return fail(
      `Rolling '${input.checkType}' for '${actor.name ?? input.actorId}' threw: ${errText(e)}`,
      {
        actorId: input.actorId,
        checkType: input.checkType,
        error: errText(e),
        reason: 'ROLL_THREW',
      },
    );
  }
  if (roll == null) {
    return fail(
      `PF2e returned no roll for '${input.checkType}' on '${actor.name ?? input.actorId}'. ` +
        `The actor type may be unsupported by the check pipeline.`,
      {
        actorId: input.actorId,
        checkType: input.checkType,
        reason: 'ROLL_RETURNED_NULL',
      },
    );
  }

  // -- Recover chat message id via size diff (roll() returns a Roll).
  let chatMessageId: string | null = null;
  const msgCountAfter = game.messages?.size ?? 0;
  if (msgCountAfter > msgCountBefore) {
    const contents = game.messages?.contents ?? [];
    const latest = contents[contents.length - 1];
    if (latest && typeof latest.id === 'string') chatMessageId = latest.id;
  }

  // -- Project results.
  const total = typeof roll.total === 'number' ? roll.total : 0;
  const dieResultRaw = roll.dice?.[0]?.results?.[0]?.result;
  const dieResult = typeof dieResultRaw === 'number' ? dieResultRaw : 0;
  const degreeRaw =
    typeof roll.options?.degreeOfSuccess === 'number'
      ? roll.options.degreeOfSuccess
      : typeof roll.degreeOfSuccess === 'number'
        ? roll.degreeOfSuccess
        : null;
  const outcome: CheckOutcome | null =
    degreeRaw != null && degreeRaw >= 0 && degreeRaw <= 3 ? (OUTCOMES[degreeRaw] ?? null) : null;

  return {
    ok: true,
    actor: {
      id: actor.id ?? input.actorId,
      name: actor.name ?? '',
      type: actor.type ?? '',
    },
    checkType: input.checkType,
    statisticSlug,
    modifier,
    dc: input.dc,
    total,
    dieResult,
    outcome,
    visibility: input.visibility,
    chatMessageId,
  };
}
