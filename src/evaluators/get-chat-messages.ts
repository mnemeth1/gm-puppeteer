/**
 * page.evaluate body for get_chat_messages. Read-only projection of the
 * Foundry chat log: a window of recent messages, each with author,
 * speaker, content, roll info, whisper recipients, and — for PF2e check
 * and damage cards — a structured `card` shape.
 *
 * Selection (mirrors a recent-N + forward-paging window):
 *  - `game.messages.contents` is creation-ordered (oldest → newest).
 *  - `sinceMessageId`, when given, is exclusive and forward: the window
 *    is everything created AFTER that id. A `sinceMessageId` not in the
 *    log is `SINCE_MESSAGE_NOT_FOUND` (it has scrolled off, or is wrong).
 *  - `limit` then keeps the newest `limit` of the candidate window.
 *  - The returned array stays chronological so a round reads top-down.
 *
 * Behaviour nuances confirmed against Foundry v14.361 + PF2e 8.1.2 by
 * `scripts/probe-chat-messages-phase1.mjs`:
 *
 *  - **Author.** v14 stores the user id in `_source.author` (the legacy
 *    `_source.user` is null). The `message.author` getter resolves it to
 *    a `User` document, or `null` when the user was deleted — an
 *    orphaned message keeps the id in `_source` but has no name.
 *  - **Roll cards.** A roll message's `content` is just the numeric
 *    total ("30"); the human-readable card markup lives in `flavor`.
 *    `text` therefore strips `flavor` + `content` together.
 *  - **Style.** `CONST.CHAT_MESSAGE_STYLES` is `{OTHER:0, OOC:1, IC:2,
 *    EMOTE:3}`; `_source.type` was the string "base" on every observed
 *    message, so `type` is not projected — `style` carries the useful
 *    signal.
 *  - **PF2e cards.** `flags.pf2e.context.type` routes the card:
 *    "damage-roll" → damage; the check family ("attack-roll",
 *    "skill-check", "perception-check", "saving-throw", "flat-check",
 *    "initiative") → check; anything else with a context (e.g.
 *    "damage-taken") or no `flags.pf2e.context` at all → `kind:"other"`.
 *    A message is never dropped — every entry carries a `card`.
 *  - **Damage breakdown.** A damage message's `rolls[0]` is a
 *    `DamageRoll` whose `instances` getter yields `DamageInstance`s with
 *    `{type, category, total, persistent}` — the per-type breakdown.
 *  - **Targets.** `context.target.actor` is a UUID ("Actor.<id>" or
 *    "Scene.<id>.Token.<id>.Actor.<id>"); the trailing id is extracted.
 *
 * Note: this function is serialized via Puppeteer's `page.evaluate`,
 * which ships only the function's own source to the browser. Module-
 * scope helpers, imports, and outer closures are NOT available at
 * runtime — every helper is defined inline.
 */
export interface GetChatMessagesInput {
  /** Newest-N window size; `null` falls back to the default in-body. */
  limit: number | null;
  /** Exclusive, forward: only messages created after this id. */
  sinceMessageId: string | null;
}

export type DegreeOfSuccess = 'criticalSuccess' | 'success' | 'failure' | 'criticalFailure';

export interface ChatCardCheck {
  kind: 'check';
  /** PF2e context type: attack-roll | skill-check | perception-check | … */
  checkType: string;
  dc: number | null;
  outcome: DegreeOfSuccess | null;
  domains: string[];
  rollTotal: number | null;
}

export interface ChatDamageInstance {
  damageType: string | null;
  /** "physical" | "persistent" | "splash" | "precision" | … | null. */
  category: string | null;
  total: number;
  persistent: boolean;
}

export interface ChatCardDamage {
  kind: 'damage';
  total: number;
  instances: ChatDamageInstance[];
  outcome: DegreeOfSuccess | null;
  /** Actor id of the damage target, extracted from the context UUID. */
  targetActorId: string | null;
}

export interface ChatCardOther {
  kind: 'other';
  /** Raw `flags.pf2e.context.type` if present but unmodeled, else null. */
  pf2eCardType: string | null;
}

export type ChatCard = ChatCardCheck | ChatCardDamage | ChatCardOther;

export interface ChatMessageEntry {
  id: string;
  author: { userId: string | null; name: string | null };
  speaker: { actorId: string | null; tokenId: string | null; alias: string | null };
  /** Epoch milliseconds. */
  timestamp: number;
  /** Raw stored HTML of the message body. */
  contentHtml: string;
  /** Raw stored HTML of the flavor / card header (empty string if none). */
  flavorHtml: string;
  /** HTML-stripped, whitespace-collapsed flavor + content. */
  text: string;
  isRoll: boolean;
  /** Aggregate total across all rolls when `isRoll`; otherwise null. */
  rollTotal: number | null;
  /** User ids the message is whispered to; empty array = public. */
  whisper: string[];
  blind: boolean;
  /** "OTHER" | "OOC" | "IC" | "EMOTE" | null. */
  style: string | null;
  card: ChatCard;
}

export type GetChatMessagesResult =
  | {
      ok: true;
      messages: ChatMessageEntry[];
      /** Total messages in the log at read time. */
      totalInLog: number;
      returnedCount: number;
    }
  | {
      ok: false;
      error: {
        code: 'INVALID_INPUT';
        message: string;
        details?: Record<string, unknown>;
      };
    };

export function getChatMessagesBody(input: GetChatMessagesInput): GetChatMessagesResult {
  interface RollLike {
    total?: unknown;
    instances?: unknown;
  }
  interface DamageInstanceLike {
    type?: unknown;
    category?: unknown;
    total?: unknown;
    persistent?: unknown;
  }
  interface SpeakerLike {
    actor?: unknown;
    token?: unknown;
    alias?: unknown;
  }
  interface Pf2eContextLike {
    type?: unknown;
    dc?: unknown;
    outcome?: unknown;
    domains?: unknown;
    target?: { actor?: unknown } | null;
  }
  interface MessageLike {
    id?: string;
    author?: { id?: unknown; name?: unknown } | null;
    _source?: { author?: unknown; style?: unknown };
    speaker?: SpeakerLike | null;
    timestamp?: unknown;
    content?: unknown;
    flavor?: unknown;
    isRoll?: unknown;
    rolls?: RollLike[];
    whisper?: unknown;
    blind?: unknown;
    style?: unknown;
    flags?: { pf2e?: { context?: Pf2eContextLike } } | null;
  }
  interface MessagesCollectionLike {
    contents?: MessageLike[];
    size?: number;
  }
  interface FoundryGameLike {
    messages?: MessagesCollectionLike;
  }

  const fail = (message: string, details: Record<string, unknown>): GetChatMessagesResult => ({
    ok: false,
    error: { code: 'INVALID_INPUT', message, details },
  });

  const game = (globalThis as unknown as { game?: FoundryGameLike }).game;
  if (!game || !game.messages) {
    return fail('Foundry globals (game / game.messages) are unavailable.', {
      reason: 'FOUNDRY_NOT_READY',
    });
  }

  const DEFAULT_LIMIT = 20;
  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : DEFAULT_LIMIT;

  // -- HTML strip. In the browser page `document` is available and gives
  // the robust parse (entities, nested tags); under the node unit-test
  // environment it is not, so a regex strip is the fallback. Both paths
  // are exercised — this is not a speculative branch.
  const stripHtml = (html: unknown): string => {
    if (typeof html !== 'string' || html.length === 0) return '';
    if (typeof document !== 'undefined' && document.createElement) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return (div.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  };

  // -- Pull the trailing actor id out of a Foundry UUID.
  const actorIdFromUuid = (uuid: unknown): string | null => {
    if (typeof uuid !== 'string' || uuid.length === 0) return null;
    const parts = uuid.split('.');
    const idx = parts.lastIndexOf('Actor');
    return idx >= 0 && typeof parts[idx + 1] === 'string' ? (parts[idx + 1] as string) : null;
  };

  const sumRollTotals = (rolls: RollLike[] | undefined): number | null => {
    if (!Array.isArray(rolls) || rolls.length === 0) return null;
    let total = 0;
    let any = false;
    for (const r of rolls) {
      if (typeof r.total === 'number' && Number.isFinite(r.total)) {
        total += r.total;
        any = true;
      }
    }
    return any ? total : null;
  };

  const STYLE_NAMES: Record<number, string> = {
    0: 'OTHER',
    1: 'OOC',
    2: 'IC',
    3: 'EMOTE',
  };

  const CHECK_TYPES = new Set([
    'attack-roll',
    'skill-check',
    'perception-check',
    'saving-throw',
    'flat-check',
    'initiative',
  ]);

  const parseCard = (m: MessageLike): ChatCard => {
    const ctx = m.flags?.pf2e?.context;
    if (!ctx || typeof ctx.type !== 'string') {
      return { kind: 'other', pf2eCardType: null };
    }
    const outcome = typeof ctx.outcome === 'string' ? (ctx.outcome as DegreeOfSuccess) : null;

    if (ctx.type === 'damage-roll') {
      const instances: ChatDamageInstance[] = [];
      for (const roll of Array.isArray(m.rolls) ? m.rolls : []) {
        const raw = (roll as RollLike).instances;
        if (!Array.isArray(raw)) continue;
        for (const inst of raw as DamageInstanceLike[]) {
          instances.push({
            damageType: typeof inst.type === 'string' ? inst.type : null,
            category: typeof inst.category === 'string' ? inst.category : null,
            total: typeof inst.total === 'number' && Number.isFinite(inst.total) ? inst.total : 0,
            persistent: inst.persistent === true,
          });
        }
      }
      return {
        kind: 'damage',
        total: sumRollTotals(m.rolls) ?? 0,
        instances,
        outcome,
        targetActorId: actorIdFromUuid(ctx.target?.actor),
      };
    }

    if (CHECK_TYPES.has(ctx.type)) {
      let dc: number | null = null;
      if (typeof ctx.dc === 'number' && Number.isFinite(ctx.dc)) {
        dc = ctx.dc;
      } else if (
        ctx.dc &&
        typeof ctx.dc === 'object' &&
        typeof (ctx.dc as { value?: unknown }).value === 'number'
      ) {
        dc = (ctx.dc as { value: number }).value;
      }
      return {
        kind: 'check',
        checkType: ctx.type,
        dc,
        outcome,
        domains: Array.isArray(ctx.domains)
          ? (ctx.domains as unknown[]).filter((d): d is string => typeof d === 'string')
          : [],
        rollTotal: sumRollTotals(m.rolls),
      };
    }

    return { kind: 'other', pf2eCardType: ctx.type };
  };

  // -- Select the window.
  const contents = Array.isArray(game.messages.contents) ? game.messages.contents : [];
  let candidates = contents;
  if (input.sinceMessageId !== null) {
    const idx = contents.findIndex((m) => m.id === input.sinceMessageId);
    if (idx === -1) {
      return fail(
        `No chat message with id "${input.sinceMessageId}" — it may have ` +
          `scrolled out of the log, or the id is wrong.`,
        { sinceMessageId: input.sinceMessageId, reason: 'SINCE_MESSAGE_NOT_FOUND' },
      );
    }
    candidates = contents.slice(idx + 1);
  }
  const windowed =
    candidates.length > limit ? candidates.slice(candidates.length - limit) : candidates;

  const messages: ChatMessageEntry[] = windowed.map((m) => {
    const speaker = m.speaker ?? {};
    const styleNum = typeof m.style === 'number' ? m.style : undefined;
    const flavorHtml = typeof m.flavor === 'string' ? m.flavor : '';
    const contentHtml = typeof m.content === 'string' ? m.content : '';
    const isRoll = m.isRoll === true;
    return {
      id: typeof m.id === 'string' ? m.id : '',
      author: {
        userId:
          (m.author && typeof m.author.id === 'string' ? m.author.id : null) ??
          (m._source && typeof m._source.author === 'string' ? m._source.author : null),
        name: m.author && typeof m.author.name === 'string' ? m.author.name : null,
      },
      speaker: {
        actorId: typeof speaker.actor === 'string' ? speaker.actor : null,
        tokenId: typeof speaker.token === 'string' ? speaker.token : null,
        alias: typeof speaker.alias === 'string' ? speaker.alias : null,
      },
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
      contentHtml,
      flavorHtml,
      text: stripHtml(`${flavorHtml} ${contentHtml}`),
      isRoll,
      rollTotal: isRoll ? sumRollTotals(m.rolls) : null,
      whisper: Array.isArray(m.whisper)
        ? (m.whisper as unknown[]).filter((w): w is string => typeof w === 'string')
        : [],
      blind: m.blind === true,
      style: styleNum !== undefined ? (STYLE_NAMES[styleNum] ?? null) : null,
      card: parseCard(m),
    };
  });

  return {
    ok: true,
    messages,
    totalInLog: typeof game.messages.size === 'number' ? game.messages.size : contents.length,
    returnedCount: messages.length,
  };
}
