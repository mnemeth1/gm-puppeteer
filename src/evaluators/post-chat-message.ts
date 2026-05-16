/**
 * page.evaluate body for post_chat_message. Writes one message to the
 * Foundry chat log: GM narration, NPC dialogue, a private GM-only note,
 * or a whisper to a player. The speaker (GM vs NPC) and the audience
 * (public / GM-only / whisper-to-PC) are independent, so all the useful
 * combinations are reachable.
 *
 * Parameters:
 *  - `content` is raw HTML, stored verbatim. Foundry's `ChatMessage`
 *    `content` field IS an HTML string and the chat log renders it
 *    as-is; the probe confirmed no escaping or sanitization of a
 *    GM-authored message. The caller owns valid markup — newlines are
 *    not significant, use <p> / <br>.
 *  - `speakerActorId`, when set, attributes the message to that actor
 *    (the card reads "as <actor name>"); omitted → the logged-in GM.
 *  - `visibility` is "public" (everyone) or "gm" (whispered to all GM
 *    users only — a private GM note). It mirrors `roll_dice`'s
 *    vocabulary.
 *  - `whisperTo` is a list of player-character actor ids; the message
 *    is whispered to all their owning users. `whisperTo` is the
 *    PC-audience axis and cannot be combined with `visibility: "gm"` —
 *    those are different audiences (`VISIBILITY_WHISPER_CONFLICT`).
 *
 * Behaviour confirmed against Foundry v14.361 + PF2e 8.1.2 by
 * `scripts/probe-chat-post-phase1.mjs`:
 *
 *  - **Owner resolution.** `game.users.filter(u =>
 *    actor.testUserPermission(u, "OWNER"))` returns owner players AND
 *    all GMs (GMs own every actor). "Has a player owner" therefore
 *    means "some NON-GM user owns it" — an actor with only GM owners
 *    (a plain NPC) is rejected with NO_PLAYER_OWNER, because a whisper
 *    to it would reach no player.
 *  - **GM oversight.** A whisper addressed only to a player is still
 *    `visible` to GM clients, so whispering to the GMs as well is not
 *    needed for the human GM to see it — but the resolved owner set
 *    includes the GMs anyway (they own the actor), and that is kept:
 *    it matches `request_check` and makes the whisper explicit.
 *  - **Speaker.** `ChatMessage.getSpeaker({actor})` sets `speaker.actor`
 *    + `speaker.alias`; `ChatMessage.getSpeaker()` (no args) yields the
 *    GM user as speaker with `actor` null.
 *  - **Id.** `ChatMessage.implementation.create(...)` returns the
 *    created document with a usable `.id`; a `game.messages.size` diff
 *    is kept as a fallback (mirrors `roll-dice.ts` / `request-check.ts`).
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export interface PostChatMessageInput {
  /** Raw HTML, stored verbatim. */
  content: string;
  /** World actor id to speak as; `null` for the logged-in GM. */
  speakerActorId: string | null;
  /** "public" = everyone; "gm" = whispered to all GM users only. */
  visibility: 'public' | 'gm';
  /** Player-character actor ids to whisper to; empty array = no PC whisper. */
  whisperTo: string[];
}

export interface PostChatMessageOk {
  ok: true;
  /** Chat message id if the message posted; `null` only if recovery failed. */
  chatMessageId: string | null;
  speaker: { actorId: string | null; alias: string | null };
  visibility: 'public' | 'gm';
  /** True when the message was whispered (GM-only or to PC owners). */
  isWhisper: boolean;
  /**
   * Resolved user recipients (deduplicated). `viaActorId` is the
   * whisperTo actor that resolved the user, or `null` for a GM-only
   * recipient (not resolved through an actor).
   */
  whisperedTo: Array<{
    userId: string;
    userName: string;
    viaActorId: string | null;
  }>;
  /** The player-character actors named in `whisperTo`. */
  whisperTargets: Array<{ actorId: string; actorName: string }>;
}

export interface PostChatMessageErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type PostChatMessageResult = PostChatMessageOk | PostChatMessageErr;

export async function postChatMessageBody(
  input: PostChatMessageInput,
): Promise<PostChatMessageResult> {
  interface UserLike {
    id?: unknown;
    name?: unknown;
    isGM?: unknown;
  }
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    testUserPermission?: (user: unknown, level: string) => boolean;
  }
  interface SpeakerDataLike {
    actor?: string;
    alias?: string;
    token?: string;
    scene?: string;
  }
  interface ChatMessageStaticLike {
    implementation: {
      create(
        data: Record<string, unknown>,
      ): Promise<{ id?: string } | undefined>;
    };
    getSpeaker(opts?: { actor?: unknown }): SpeakerDataLike;
  }
  interface MessagesCollectionLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    users?: { contents?: UserLike[] };
    messages?: MessagesCollectionLike;
  }

  const fail = (
    message: string,
    details: Record<string, unknown>,
  ): PostChatMessageErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const errText = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const ChatMessageCls = (
    globalThis as unknown as { ChatMessage?: ChatMessageStaticLike }
  ).ChatMessage;

  if (!game || !ChatMessageCls) {
    return fail('Foundry globals (game / ChatMessage) are unavailable.', {
      reason: 'FOUNDRY_NOT_READY',
    });
  }

  // -- Resolve the chat speaker (GM by default, NPC when supplied).
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

  // -- Determine the audience: a GM-only whisper, a whisper to the
  // owners of named PCs, or a public broadcast. visibility "gm" and
  // whisperTo are different audiences and cannot be combined.
  const users = game.users?.contents ?? [];
  const isGmOnly = input.visibility === 'gm';
  if (isGmOnly && input.whisperTo.length > 0) {
    return fail(
      'visibility "gm" cannot be combined with whisperTo — a GM-only message ' +
        'and a whisper to specific players are different audiences. Use one ' +
        'or the other.',
      { reason: 'VISIBILITY_WHISPER_CONFLICT' },
    );
  }

  const whisperTargets: Array<{ actorId: string; actorName: string }> = [];
  const whisperedTo: Array<{
    userId: string;
    userName: string;
    viaActorId: string | null;
  }> = [];
  const seenUserIds = new Set<string>();

  for (const actorId of input.whisperTo) {
    const actor = game.actors?.get(actorId);
    if (!actor) {
      return fail(`No actor found for whisperTo id: ${actorId}`, {
        actorId,
        reason: 'WHISPER_TARGET_NOT_FOUND',
      });
    }
    if (actor.type !== 'character') {
      return fail(
        `whisperTo actor '${actor.name ?? actorId}' is not a player character ` +
          `(type ${actor.type ?? 'unknown'}). whisperTo takes PC actor ids; ` +
          `to send a GM-only message use visibility "gm" instead.`,
        { actorId, actorType: actor.type ?? null, reason: 'WHISPER_TARGET_NOT_A_PC' },
      );
    }
    const owners =
      typeof actor.testUserPermission === 'function'
        ? users.filter((u) => actor.testUserPermission!(u, 'OWNER'))
        : [];
    const hasPlayerOwner = owners.some((u) => u.isGM !== true);
    if (!hasPlayerOwner) {
      return fail(
        `Actor '${actor.name ?? actorId}' has no non-GM owner — a whisper to it ` +
          `would reach no player. Assign a player as owner first.`,
        { actorId, reason: 'NO_PLAYER_OWNER' },
      );
    }
    whisperTargets.push({
      actorId: actor.id ?? actorId,
      actorName: actor.name ?? '',
    });
    for (const u of owners) {
      const uid = typeof u.id === 'string' ? u.id : null;
      if (!uid || seenUserIds.has(uid)) continue;
      seenUserIds.add(uid);
      whisperedTo.push({
        userId: uid,
        userName: typeof u.name === 'string' ? u.name : '',
        viaActorId: actor.id ?? actorId,
      });
    }
  }

  if (isGmOnly) {
    for (const u of users) {
      if (u.isGM !== true) continue;
      const uid = typeof u.id === 'string' ? u.id : null;
      if (!uid || seenUserIds.has(uid)) continue;
      seenUserIds.add(uid);
      whisperedTo.push({
        userId: uid,
        userName: typeof u.name === 'string' ? u.name : '',
        viaActorId: null,
      });
    }
    if (whisperedTo.length === 0) {
      return fail(
        'visibility "gm" was requested but this world has no GM users.',
        { reason: 'NO_GM_USERS' },
      );
    }
  }

  const whisperIds = whisperedTo.map((w) => w.userId);
  const isWhisper = whisperIds.length > 0;
  const messageData: Record<string, unknown> = {
    content: input.content,
    speaker,
  };
  if (isWhisper) messageData.whisper = whisperIds;

  // -- Post the message.
  const msgCountBefore = game.messages?.size ?? 0;
  let message: { id?: string } | undefined;
  try {
    message = await ChatMessageCls.implementation.create(messageData);
  } catch (e: unknown) {
    return fail(`Failed to post the message to chat: ${errText(e)}`, {
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

  return {
    ok: true,
    chatMessageId,
    speaker: {
      actorId: typeof speaker.actor === 'string' ? speaker.actor : null,
      alias: typeof speaker.alias === 'string' ? speaker.alias : null,
    },
    visibility: input.visibility,
    isWhisper,
    whisperedTo,
    whisperTargets,
  };
}
