/**
 * page.evaluate body for dnd5e_request_check. Posts a D&D 5e inline
 * roll-link chat message asking a player to roll a check for their own
 * character. Rolls nothing itself — the player clicks the button.
 *
 * This is the deputy's only player-facing roll path: the GM says "Bard,
 * roll Acrobatics" and the player keeps agency over the actual roll. The
 * message is whispered to the actor's owner(s) plus GMs, and its speaker
 * is set to the target PC. For an NPC's real check use `dnd5e_roll_check`;
 * for raw dice use `roll_dice`.
 *
 * The check is addressed by a (category, key) pair: a save reuses an
 * ability key, so a single slug cannot tell a "Dexterity check" from a
 * "Dexterity save".
 *
 * Phase-1 findings encoded here (verified against dnd5e 5.3.3 + Foundry
 * v14.361 by scripts/probe-dnd5e-request-check-phase1.mjs):
 *   - The dnd5e check enrichers are `[[/check ability=<k>]]`,
 *     `[[/check skill=<k>]]`, `[[/save ability=<k>]]`,
 *     `[[/tool tool=<k>]]`; an optional ` dc=<n>` segment sets the DC.
 *   - `foundry.applications.ux.TextEditor.implementation.enrichHTML` is
 *     async and turns the expression into an
 *     `<enriched-content enricher="dnd5e-enricher">` element wrapping an
 *     `<a class="roll-link">` clickable button (plus a secondary
 *     `<a class="enricher-action">` "request roll" icon). Enriching
 *     server-side as the AI-GM user keeps the anchor clickable in the
 *     stored message.
 *   - The DC is always rendered on the button text ("DC 15 Dexterity").
 *     There is no showDC-style toggle — unlike PF2e, the DC cannot be
 *     hidden from the player, so this tool exposes no DC-visibility flag.
 *   - `game.users` filtered by `actor.testUserPermission(u, "OWNER")`
 *     yields owner players AND all GMs (GMs own every actor).
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export type Dnd5eRequestCheckCategory = 'ability' | 'skill' | 'save' | 'tool';

export interface Dnd5eRequestCheckInput {
  actorId: string;
  category: Dnd5eRequestCheckCategory;
  /** Ability key (str/dex/...) for ability & save; skill key (acr/...) for skill; tool key for tool. */
  key: string;
  dc: number | null;
}

export interface Dnd5eRequestCheckOk {
  ok: true;
  actor: { id: string; name: string };
  category: Dnd5eRequestCheckCategory;
  key: string;
  dc: number | null;
  /** The literal [[/...]] enricher string that was enriched and posted. */
  checkExpression: string;
  /** Users the prompt was whispered to (owner players + GMs). */
  whisperedTo: Array<{ id: string; name: string }>;
  chatMessageId: string | null;
}

export interface Dnd5eRequestCheckErr {
  ok: false;
  error: {
    code: 'INVALID_INPUT';
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Dnd5eRequestCheckResult = Dnd5eRequestCheckOk | Dnd5eRequestCheckErr;

export async function dnd5eRequestCheckBody(
  input: Dnd5eRequestCheckInput,
): Promise<Dnd5eRequestCheckResult> {
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
  interface MessagesCollectionLike {
    size: number;
    contents?: Array<{ id?: string }>;
  }
  interface FoundryGameLike {
    actors?: { get(id: string): ActorDocLike | undefined };
    users?: { contents?: UserLike[] };
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
  interface Dnd5eConfigLike {
    abilities?: Record<string, unknown>;
    skills?: Record<string, unknown>;
    tools?: Record<string, unknown>;
  }

  const fail = (message: string, details: Record<string, unknown>): Dnd5eRequestCheckErr => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  const TextEditor = (
    globalThis as unknown as {
      foundry?: { applications?: { ux?: { TextEditor?: { implementation?: TextEditorLike } } } };
    }
  ).foundry?.applications?.ux?.TextEditor?.implementation;
  const ChatMessageCls = (globalThis as unknown as { ChatMessage?: ChatMessageStaticLike })
    .ChatMessage;
  const dnd5eConfig = (globalThis as unknown as { CONFIG?: { DND5E?: Dnd5eConfigLike } }).CONFIG
    ?.DND5E;

  if (!game || !TextEditor || !ChatMessageCls || !dnd5eConfig) {
    return fail(
      'Foundry globals (game / TextEditor / ChatMessage / CONFIG.DND5E) are unavailable — ' +
        'is this a D&D 5e world?',
      { reason: 'FOUNDRY_NOT_READY' },
    );
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
        `${actor.type ?? 'unknown'}). dnd5e_request_check asks a player to roll for their PC. ` +
        `To roll an NPC's check yourself, use dnd5e_roll_check.`,
      { actorId: input.actorId, actorType: actor.type ?? null, reason: 'ACTOR_NOT_A_PC' },
    );
  }

  // -- Validate the key against CONFIG.DND5E.
  const validKeys =
    input.category === 'skill'
      ? dnd5eConfig.skills
      : input.category === 'tool'
        ? dnd5eConfig.tools
        : dnd5eConfig.abilities;
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

  // -- Build the [[/...]] enricher string.
  const segment =
    input.category === 'skill'
      ? `check skill=${input.key}`
      : input.category === 'tool'
        ? `tool tool=${input.key}`
        : input.category === 'save'
          ? `save ability=${input.key}`
          : `check ability=${input.key}`;
  const dcSegment = typeof input.dc === 'number' ? ` dc=${input.dc}` : '';
  const checkExpression = `[[/${segment}${dcSegment}]]`;

  // -- Enrich to a clickable roll-link button.
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
  if (typeof enriched !== 'string' || !/<a[^>]*class="[^"]*roll-link/.test(enriched)) {
    return fail(
      `Enriching '${checkExpression}' did not produce a clickable roll button. The ` +
        `category or key may be unrecognized by D&D 5e.`,
      { checkExpression, enriched, reason: 'ENRICH_FAILED' },
    );
  }

  // -- Wrap the button in an explicit sentence.
  const suffix = input.category === 'save' ? ' saving throw' : '';
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const actorName = escapeHtml(actor.name ?? 'The character');
  const content = `${actorName}, roll ${enriched}${suffix}.`;

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
    category: input.category,
    key: input.key,
    dc: input.dc,
    checkExpression,
    whisperedTo: recipients.map((u) => ({
      id: typeof u.id === 'string' ? u.id : '',
      name: typeof u.name === 'string' ? u.name : '',
    })),
    chatMessageId,
  };
}
