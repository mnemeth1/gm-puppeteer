/**
 * page.evaluate body for roll_dice. Evaluates a raw dice formula via
 * Foundry's core `Roll` class and posts the result to the chat log.
 *
 * This is the GM-side "just roll some dice" path: a private GM d30, a
 * d10 spoken by an NPC, an open table d20. It is core-Foundry only —
 * no PF2e statistic pipeline, no degree-of-success. For an NPC's real
 * stat-block check use `pf2e_roll_check`; to ask a player to roll, use
 * `pf2e_request_check`.
 *
 * Visibility maps to the core `Roll.toMessage` `rollMode` option:
 *   - public → 'publicroll' — visible to everyone (empty whisper).
 *   - gm     → 'gmroll'     — whispered to all GM users.
 *   - blind  → 'blindroll'  — whispered to GMs, hidden from the roller.
 *
 * Speaker: when `speakerActorId` is supplied the roll is attributed to
 * that actor (the chat card reads "as <NPC name>"); otherwise it is
 * attributed to the logged-in GM user.
 *
 * `Roll.toMessage({ create: true })` returns the created ChatMessage, so
 * its id is read directly; a `game.messages.size` diff is kept as a
 * fallback, mirroring `use-item.ts`.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export interface RollDiceInput {
  formula: string;
  /** Optional chat-card label; `null` when not supplied. */
  flavor: string | null;
  /** Optional world actor id to attribute the roll to; `null` for the GM. */
  speakerActorId: string | null;
  visibility: 'public' | 'gm' | 'blind';
}

/** Per-die breakdown of an evaluated roll. */
export interface RollDiceTerm {
  faces: number;
  results: number[];
}

export interface RollDiceOk {
  ok: true;
  formula: string;
  /** Numeric total of the evaluated roll. */
  total: number;
  /** The evaluated expression as a string, e.g. "5 + 3". */
  result: string;
  /** One entry per dice term; constant/operator terms are not included. */
  terms: RollDiceTerm[];
  flavor: string | null;
  visibility: 'public' | 'gm' | 'blind';
  speaker: { actorId: string | null; alias: string | null };
  /** Chat message id if the card posted; `null` only if recovery failed. */
  chatMessageId: string | null;
}

export interface RollDiceErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RollDiceResult = RollDiceOk | RollDiceErr;

export async function rollDiceBody(input: RollDiceInput): Promise<RollDiceResult> {
  interface RollTermResultLike {
    result?: unknown;
  }
  interface DiceTermLike {
    faces?: unknown;
    results?: RollTermResultLike[];
  }
  interface RollLike {
    total?: unknown;
    result?: unknown;
    dice?: DiceTermLike[];
    evaluate(): Promise<unknown>;
    toMessage(
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<{ id?: string } | undefined>;
  }
  interface RollConstructorLike {
    new (formula: string): RollLike;
  }
  interface SpeakerDataLike {
    actor?: string;
    alias?: string;
    token?: string;
    scene?: string;
  }
  interface ChatMessageStaticLike {
    getSpeaker(options?: { actor?: unknown }): SpeakerDataLike;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
  }
  interface MessagesCollectionLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    messages?: MessagesCollectionLike;
  }

  const fail = (message: string, details: Record<string, unknown>): RollDiceErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const RollCtor = (globalThis as unknown as { Roll?: RollConstructorLike }).Roll;
  const ChatMessageCls = (globalThis as unknown as { ChatMessage?: ChatMessageStaticLike })
    .ChatMessage;

  if (!game || !RollCtor || !ChatMessageCls) {
    return fail('Foundry globals (game / Roll / ChatMessage) are unavailable.', {
      reason: 'FOUNDRY_NOT_READY',
    });
  }

  // -- Resolve the chat speaker.
  let speaker: SpeakerDataLike;
  if (typeof input.speakerActorId === 'string') {
    const actor = game.actors?.get(input.speakerActorId);
    if (!actor) {
      return fail(`No actor found for speakerActorId: ${input.speakerActorId}`, {
        speakerActorId: input.speakerActorId,
        reason: 'SPEAKER_ACTOR_NOT_FOUND',
      });
    }
    speaker = ChatMessageCls.getSpeaker({ actor });
  } else {
    speaker = ChatMessageCls.getSpeaker();
  }

  // -- Build and evaluate the roll.
  let roll: RollLike;
  try {
    roll = new RollCtor(input.formula);
    await roll.evaluate();
  } catch (e: unknown) {
    return fail(`Invalid dice formula '${input.formula}': ${errText(e)}`, {
      formula: input.formula,
      error: errText(e),
      reason: 'FORMULA_INVALID',
    });
  }
  if (typeof roll.total !== 'number' || !Number.isFinite(roll.total)) {
    return fail(`Dice formula '${input.formula}' did not evaluate to a finite number.`, {
      formula: input.formula,
      reason: 'FORMULA_INVALID',
    });
  }

  // -- Map visibility to the core Roll.toMessage rollMode.
  const rollMode =
    input.visibility === 'gm'
      ? 'gmroll'
      : input.visibility === 'blind'
        ? 'blindroll'
        : 'publicroll';

  const messageData: Record<string, unknown> = { speaker };
  const hasFlavor = typeof input.flavor === 'string' && input.flavor.length > 0;
  if (hasFlavor) messageData.flavor = input.flavor;

  const msgCountBefore = game.messages?.size ?? 0;

  let message: { id?: string } | undefined;
  try {
    message = await roll.toMessage(messageData, { rollMode, create: true });
  } catch (e: unknown) {
    return fail(`Failed to post roll to chat: ${errText(e)}`, {
      formula: input.formula,
      error: errText(e),
      reason: 'CHAT_POST_FAILED',
    });
  }

  // -- Recover the chat message id (return value first, size diff fallback).
  let chatMessageId: string | null = null;
  if (message && typeof message.id === 'string') {
    chatMessageId = message.id;
  } else {
    const msgCountAfter = game.messages?.size ?? 0;
    if (msgCountAfter > msgCountBefore) {
      const contents = game.messages?.contents ?? [];
      const latest = contents[contents.length - 1];
      if (latest && typeof latest.id === 'string') chatMessageId = latest.id;
    }
  }

  // -- Project the per-die breakdown.
  const terms: RollDiceTerm[] = [];
  const dice = Array.isArray(roll.dice) ? roll.dice : [];
  for (const d of dice) {
    const faces = typeof d.faces === 'number' ? d.faces : 0;
    const results = Array.isArray(d.results)
      ? d.results.map((r) => r.result).filter((n): n is number => typeof n === 'number')
      : [];
    terms.push({ faces, results });
  }

  return {
    ok: true,
    formula: input.formula,
    total: roll.total,
    result: typeof roll.result === 'string' ? roll.result : String(roll.total),
    terms,
    flavor: hasFlavor ? (input.flavor as string) : null,
    visibility: input.visibility,
    speaker: {
      actorId: typeof speaker.actor === 'string' ? speaker.actor : null,
      alias: typeof speaker.alias === 'string' ? speaker.alias : null,
    },
    chatMessageId,
  };
}
