/**
 * page.evaluate body for request_check. Posts a PF2e `@Check[...]`
 * inline-button chat message asking a player to roll a check for their
 * own character. Rolls nothing itself — the player clicks the button.
 *
 * This is the deputy's only player-facing roll path: the GM says
 * "Valeros, roll Perception" and the player keeps agency over the
 * actual roll. The message is whispered to the actor's owner(s) plus
 * GMs, and its speaker is set to the target PC so the PF2e button
 * resolves the roll to that character. For an NPC's real check use
 * `roll_check`; for raw dice use `roll_dice`.
 *
 * The posted content is a full sentence, not a bare button — the
 * enriched `@Check` anchor is wrapped as `<Name>, roll a/an <button>
 * check.` (saves end "saving throw"; `flat` takes no suffix since the
 * button already reads "Flat Check"). The article is picked from the
 * checkType slug's first letter.
 *
 * `@Check[...]` syntax (segments joined by `|`; order: type, dc,
 * basic, traits, showDC):
 *   - type      = the slug verbatim (perception / a skill / a save / flat).
 *   - dc:<n>    appended only when a DC is supplied.
 *   - basic     bare flag, appended only when the check is a save.
 *   - traits:<csv>  appended only when traits are supplied.
 *   - showDC:<all|gm>  ALWAYS emitted — PF2e's implicit default would
 *     reveal the DC to a player-owned actor, so the tool is explicit.
 *
 * Enrichment (confirmed by scripts/probe-request-check-phase1.mjs
 * against Foundry v14.361 + PF2e 8.1.2):
 *   - `foundry.applications.ux.TextEditor.implementation.enrichHTML`
 *     is async and turns the `@Check[...]` string into an
 *     `<a class="inline-check">` anchor — a real clickable button.
 *   - Enriching server-side as the AI-GM user does NOT strip the
 *     anchor to a span; the stored message content keeps the button.
 *   - `game.users` filtered by `actor.testUserPermission(u, "OWNER")`
 *     yields owner players AND all GMs (GMs own every actor), which is
 *     exactly the intended whisper set.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export interface RequestCheckInput {
  actorId: string;
  /** perception | one of the 16 PF2e skills | fortitude | reflex | will | flat. */
  checkType: string;
  dc: number | null;
  /** Bare `basic` flag — only valid for saves. */
  basic: boolean;
  traits: string[];
  /** true → showDC:all (player sees the DC); false → showDC:gm. */
  showDcToPlayers: boolean;
}

export interface RequestCheckOk {
  ok: true;
  actor: { id: string; name: string };
  checkType: string;
  dc: number | null;
  basic: boolean;
  /** The literal @Check[...] string that was enriched and posted. */
  checkExpression: string;
  /** Users the prompt was whispered to (owner players + GMs). */
  whisperedTo: Array<{ id: string; name: string }>;
  chatMessageId: string | null;
}

export interface RequestCheckErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RequestCheckResult = RequestCheckOk | RequestCheckErr;

export async function requestCheckBody(input: RequestCheckInput): Promise<RequestCheckResult> {
  interface ActorDocLike {
    id?: string;
    name?: string;
    type?: string;
    getRollData?: () => Record<string, unknown>;
    testUserPermission?: (user: unknown, level: string) => boolean;
  }
  interface UserLike {
    id?: string;
    name?: string;
  }
  interface UsersCollectionLike {
    contents?: UserLike[];
  }
  interface MessagesCollectionLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    users?: UsersCollectionLike;
    messages?: MessagesCollectionLike;
  }
  interface TextEditorLike {
    enrichHTML(content: string, options?: Record<string, unknown>): Promise<string>;
  }
  interface ChatMessageStaticLike {
    implementation: {
      create(data: Record<string, unknown>): Promise<{ id?: string } | undefined>;
    };
    getSpeaker(opts?: { actor?: unknown }): Record<string, unknown>;
  }

  const fail = (message: string, details: Record<string, unknown>): RequestCheckErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const SAVE_SLUGS = new Set(['fortitude', 'reflex', 'will']);

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const TextEditor = (
    globalThis as unknown as {
      foundry?: { applications?: { ux?: { TextEditor?: { implementation?: TextEditorLike } } } };
    }
  ).foundry?.applications?.ux?.TextEditor?.implementation;
  const ChatMessageCls = (globalThis as unknown as { ChatMessage?: ChatMessageStaticLike })
    .ChatMessage;

  if (!game || !TextEditor || !ChatMessageCls) {
    return fail('Foundry globals (game / TextEditor / ChatMessage) are unavailable.', {
      reason: 'FOUNDRY_NOT_READY',
    });
  }

  // -- Resolve actor; must be a player character.
  const actor = game.actors?.get(input.actorId);
  if (!actor) {
    return fail(`No actor found for actorId: ${input.actorId}`, {
      actorId: input.actorId,
      reason: 'ACTOR_NOT_FOUND',
    });
  }
  if (actor.type !== 'character') {
    return fail(
      `Actor '${actor.name ?? input.actorId}' is not a player character (type ` +
        `${actor.type ?? 'unknown'}). request_check asks a player to roll for their PC. ` +
        `To roll an NPC's check yourself, use roll_check.`,
      { actorId: input.actorId, actorType: actor.type ?? null, reason: 'ACTOR_NOT_A_PC' },
    );
  }

  // -- Guard: `basic` is meaningful only on saves.
  const isSave = SAVE_SLUGS.has(input.checkType);
  if (input.basic && !isSave) {
    return fail(
      `The 'basic' flag applies only to saving throws (fortitude/reflex/will), not ` +
        `'${input.checkType}'.`,
      { checkType: input.checkType, reason: 'BASIC_ON_NON_SAVE' },
    );
  }

  // -- Build the @Check[...] string.
  const parts: string[] = [input.checkType];
  if (typeof input.dc === 'number') parts.push(`dc:${input.dc}`);
  if (input.basic && isSave) parts.push('basic');
  if (Array.isArray(input.traits) && input.traits.length > 0) {
    parts.push(`traits:${input.traits.join(',')}`);
  }
  parts.push(`showDC:${input.showDcToPlayers ? 'all' : 'gm'}`);
  const checkExpression = `@Check[${parts.join('|')}]`;

  // -- Enrich to an inline-check button.
  let enriched: string;
  try {
    const rollData = typeof actor.getRollData === 'function' ? actor.getRollData() : {};
    enriched = await TextEditor.enrichHTML(checkExpression, { rollData });
  } catch (e: unknown) {
    return fail(`Failed to enrich '${checkExpression}': ${errText(e)}`, {
      checkExpression,
      error: errText(e),
      reason: 'ENRICH_FAILED',
    });
  }
  if (typeof enriched !== 'string' || !/<a[^>]*class="[^"]*inline-check/.test(enriched)) {
    return fail(
      `Enriching '${checkExpression}' did not produce a clickable check button. ` +
        `The checkType or traits may be unrecognized by PF2e.`,
      { checkExpression, enriched, reason: 'ENRICH_FAILED' },
    );
  }

  // -- Wrap the button in an explicit sentence: "<Name>, roll a/an <button> <suffix>."
  const suffix = isSave ? ' saving throw' : input.checkType === 'flat' ? '' : ' check';
  const article = /^[aeiou]/.test(input.checkType) ? 'an' : 'a';
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const actorName = escapeHtml(actor.name ?? 'The character');
  const content = `${actorName}, roll ${article} ${enriched}${suffix}.`;

  // -- Resolve whisper recipients: owner players + GMs (GMs own all actors).
  const users = game.users?.contents ?? [];
  const recipients =
    typeof actor.testUserPermission === 'function'
      ? users.filter((u) => actor.testUserPermission!(u, 'OWNER'))
      : [];
  if (recipients.length === 0) {
    return fail(
      `No users own actor '${actor.name ?? input.actorId}' — the check prompt would ` +
        `reach nobody.`,
      { actorId: input.actorId, reason: 'NO_RECIPIENTS' },
    );
  }
  const whisperIds = recipients
    .map((u) => u.id)
    .filter((id): id is string => typeof id === 'string');

  // -- Post the whispered message; speaker is the target PC.
  const msgCountBefore = game.messages?.size ?? 0;
  let message: { id?: string } | undefined;
  try {
    message = await ChatMessageCls.implementation.create({
      content,
      speaker: ChatMessageCls.getSpeaker({ actor }),
      whisper: whisperIds,
    });
  } catch (e: unknown) {
    return fail(`Failed to post the check prompt to chat: ${errText(e)}`, {
      checkExpression,
      error: errText(e),
      reason: 'CHAT_POST_FAILED',
    });
  }

  // -- Recover the chat message id.
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
    actor: { id: actor.id ?? input.actorId, name: actor.name ?? '' },
    checkType: input.checkType,
    dc: input.dc,
    basic: input.basic && isSave,
    checkExpression,
    whisperedTo: recipients.map((u) => ({
      id: typeof u.id === 'string' ? u.id : '',
      name: typeof u.name === 'string' ? u.name : '',
    })),
    chatMessageId,
  };
}
