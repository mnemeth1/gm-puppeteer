/**
 * page.evaluate body for get_chat_messages. Read-only projection of the
 * Foundry chat log: a window of recent messages, each with author,
 * speaker, content, roll info, whisper recipients, and a structured
 * `card` shape parsed per game system.
 *
 * Selection (mirrors a recent-N + forward-paging window):
 *  - `game.messages.contents` is creation-ordered (oldest → newest).
 *  - `sinceMessageId`, when given, is exclusive and forward: the window
 *    is everything created AFTER that id. A `sinceMessageId` not in the
 *    log is `SINCE_MESSAGE_NOT_FOUND` (it has scrolled off, or is wrong).
 *  - `limit` then keeps the newest `limit` of the candidate window.
 *  - The returned array stays chronological so a round reads top-down.
 *
 * Behaviour nuances confirmed against Foundry v14.361 by
 * `scripts/probe-chat-messages-phase1.mjs` (PF2e 8.1.2) and
 * `scripts/probe-chat-messages-dnd5e.mjs` (D&D 5e 5.3.3):
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
 *  - **Cards are system-switched.** `game.system.id` selects the parser;
 *    every card carries a `system` field ("pf2e" | "dnd5e" | null) and a
 *    `kind`. A message is never dropped — every entry carries a `card`.
 *  - **PF2e cards.** PF2e bakes everything into one card:
 *    `flags.pf2e.context.type` routes it — "damage-roll" → damage; the
 *    check family ("attack-roll", "skill-check", "perception-check",
 *    "saving-throw", "flat-check", "initiative") → check; anything else
 *    (e.g. "damage-taken") or no `flags.pf2e.context` → `kind:"other"`.
 *    A damage message's `rolls[0]` is a `DamageRoll` whose `instances`
 *    getter yields `DamageInstance`s with `{type, category, total,
 *    persistent}`. `context.target.actor` is a UUID — the trailing id is
 *    extracted.
 *  - **D&D 5e cards.** 5e splits one action across a roll-less *usage*
 *    card (`flags.dnd5e.activity`, no `messageType`) plus separate *roll*
 *    messages (`flags.dnd5e.messageType === "roll"`), joined by
 *    `flags.dnd5e.originatingMessage`. 5e never bakes an outcome into a
 *    message: an attack outcome is derived from the natural d20 vs the
 *    roll's `criticalSuccess`/`criticalFailure` and `rollTotal` vs the
 *    target AC; a save/check outcome needs the DC, which lives only as
 *    `data-dc="N"` in the originating usage card's HTML — recovered via
 *    an `originatingMessage` lookup. Initiative carries no `flags.dnd5e`,
 *    only `flags.core.initiativeRoll`.
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

/** Which system's parser produced a card; `null` for unsupported systems. */
export type CardSystem = 'pf2e' | 'dnd5e' | null;

// -- PF2e cards ----------------------------------------------------------

export interface ChatCardPf2eCheck {
  kind: 'check';
  system: 'pf2e';
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

export interface ChatCardPf2eDamage {
  kind: 'damage';
  system: 'pf2e';
  total: number;
  instances: ChatDamageInstance[];
  outcome: DegreeOfSuccess | null;
  /** Actor id of the damage target, extracted from the context UUID. */
  targetActorId: string | null;
}

// -- D&D 5e cards --------------------------------------------------------

/** A targeted token/actor on a 5e usage card or attack roll. */
export interface Dnd5eTarget {
  name: string | null;
  uuid: string | null;
  /** Trailing actor id extracted from `uuid`. */
  actorId: string | null;
  ac: number | null;
}

/** The roll-less 5e usage / activation card ("X attacks with its Y"). */
export interface ChatCardDnd5eItem {
  kind: 'item-card';
  system: 'dnd5e';
  /** Activity type: "attack" | "save" | "damage" | "utility" | … */
  activityType: string | null;
  activityId: string | null;
  itemType: string | null;
  itemId: string | null;
  itemUuid: string | null;
  /** Item name lifted from the card HTML, else null. */
  itemName: string | null;
  targets: Dnd5eTarget[];
}

export interface ChatCardDnd5eAttack {
  kind: 'attack';
  system: 'dnd5e';
  /** Id of the usage card this roll belongs to, if any. */
  originatingMessageId: string | null;
  rollTotal: number | null;
  /** The kept d20 face (advantage/disadvantage already resolved). */
  naturalD20: number | null;
  attackMode: string | null;
  /** Target AC the roll was made against, if a target was set. */
  targetAc: number | null;
  /** Derived: crit/fumble from the natural d20, hit/miss vs targetAc. */
  outcome: DegreeOfSuccess | null;
  targets: Dnd5eTarget[];
}

export interface ChatCardDnd5eDamage {
  kind: 'damage';
  system: 'dnd5e';
  originatingMessageId: string | null;
  total: number;
  /** Distinct 5e damage types across every roll on the message. */
  damageTypes: string[];
  isCritical: boolean;
}

export interface ChatCardDnd5eSave {
  kind: 'save';
  system: 'dnd5e';
  originatingMessageId: string | null;
  /** Ability key the save was rolled with (str|dex|con|int|wis|cha). */
  ability: string | null;
  rollTotal: number | null;
  naturalD20: number | null;
  /** DC recovered from the originating usage card, else null. */
  dc: number | null;
  /** Derived from rollTotal vs dc; null when the DC is unknown. */
  outcome: 'success' | 'failure' | null;
}

export interface ChatCardDnd5eCheck {
  kind: 'check';
  system: 'dnd5e';
  originatingMessageId: string | null;
  /** "ability" | "skill" | "tool". */
  checkType: 'ability' | 'skill' | 'tool';
  /** The specific stat: ability key, skill id, or tool id. */
  key: string | null;
  rollTotal: number | null;
  naturalD20: number | null;
  /** Checks rarely carry a DC; null is the normal case. */
  dc: number | null;
  outcome: 'success' | 'failure' | null;
}

export interface ChatCardDnd5eInitiative {
  kind: 'initiative';
  system: 'dnd5e';
  rollTotal: number | null;
}

// -- Shared fallthrough --------------------------------------------------

export interface ChatCardOther {
  kind: 'other';
  system: CardSystem;
  /** Raw card type when present but unmodeled (PF2e context type or 5e
   *  roll type), else null. */
  rawCardType: string | null;
}

export type ChatCard =
  | ChatCardPf2eCheck
  | ChatCardPf2eDamage
  | ChatCardDnd5eItem
  | ChatCardDnd5eAttack
  | ChatCardDnd5eDamage
  | ChatCardDnd5eSave
  | ChatCardDnd5eCheck
  | ChatCardDnd5eInitiative
  | ChatCardOther;

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
    dice?: unknown;
    options?: unknown;
  }
  interface DamageInstanceLike {
    type?: unknown;
    category?: unknown;
    total?: unknown;
    persistent?: unknown;
  }
  interface DieLike {
    faces?: unknown;
    results?: unknown;
  }
  interface DieResultLike {
    result?: unknown;
    active?: unknown;
  }
  interface Dnd5eRollOptionsLike {
    target?: unknown;
    criticalSuccess?: unknown;
    criticalFailure?: unknown;
    type?: unknown;
    types?: unknown;
    isCritical?: unknown;
  }
  interface Dnd5eRollDescriptorLike {
    type?: unknown;
    ability?: unknown;
    skillId?: unknown;
    toolId?: unknown;
    attackMode?: unknown;
  }
  interface Dnd5eFlagsLike {
    messageType?: unknown;
    roll?: Dnd5eRollDescriptorLike;
    activity?: { type?: unknown; id?: unknown } | null;
    item?: { type?: unknown; id?: unknown; uuid?: unknown } | null;
    targets?: unknown;
    originatingMessage?: unknown;
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
    flags?: {
      pf2e?: { context?: Pf2eContextLike };
      core?: { initiativeRoll?: unknown };
      dnd5e?: Dnd5eFlagsLike;
    } | null;
  }
  interface MessagesCollectionLike {
    contents?: MessageLike[];
    size?: number;
    get?: (id: string) => MessageLike | undefined;
  }
  interface FoundryGameLike {
    messages?: MessagesCollectionLike;
    system?: { id?: unknown } | null;
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

  const systemId = typeof game.system?.id === 'string' ? game.system.id : null;

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

  // -- Lift an item/card title out of message HTML. Browser path uses a
  // real DOM query; the node test env falls back to a regex.
  const titleFromHtml = (html: unknown): string | null => {
    if (typeof html !== 'string' || html.length === 0) return null;
    if (typeof document !== 'undefined' && document.createElement) {
      const div = document.createElement('div');
      div.innerHTML = html;
      const el = div.querySelector('.title');
      const txt = el && el.textContent ? el.textContent.trim() : '';
      return txt.length > 0 ? txt : null;
    }
    const m = html.match(/<span class="title">([^<]*)<\/span>/);
    const title = m && typeof m[1] === 'string' ? m[1].trim() : '';
    return title.length > 0 ? title : null;
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

  // -- The kept d20 face of the first roll. With advantage/disadvantage
  // the d20 die carries two results; only one is `active`.
  const naturalD20From = (rolls: RollLike[] | undefined): number | null => {
    if (!Array.isArray(rolls) || rolls.length === 0) return null;
    const dice = (rolls[0] as RollLike).dice;
    if (!Array.isArray(dice)) return null;
    for (const d of dice as DieLike[]) {
      if (!d || d.faces !== 20 || !Array.isArray(d.results)) continue;
      const results = d.results as DieResultLike[];
      const active = results.find((r) => r && r.active === true);
      const picked = active ?? results[0];
      if (picked && typeof picked.result === 'number') return picked.result;
    }
    return null;
  };

  // -- Recover a 5e save/check DC from the originating usage card. The DC
  // appears only as `data-dc="N"` on the card's roll button. The lookup
  // is over the full `game.messages` collection, so it resolves even
  // when the usage card has scrolled out of the returned window.
  const dcFromOriginating = (originatingId: unknown): number | null => {
    if (typeof originatingId !== 'string' || originatingId.length === 0) return null;
    const src =
      game.messages && typeof game.messages.get === 'function'
        ? game.messages.get(originatingId)
        : undefined;
    const html = src && typeof src.content === 'string' ? src.content : '';
    const m = html.match(/data-dc="(\d+)"/);
    return m ? Number(m[1]) : null;
  };

  const dnd5eTargets = (raw: unknown): Dnd5eTarget[] => {
    if (!Array.isArray(raw)) return [];
    return (raw as Array<Record<string, unknown>>).map((t) => ({
      name: typeof t.name === 'string' ? t.name : null,
      uuid: typeof t.uuid === 'string' ? t.uuid : null,
      actorId: actorIdFromUuid(t.uuid),
      ac: typeof t.ac === 'number' ? t.ac : null,
    }));
  };

  const STYLE_NAMES: Record<number, string> = {
    0: 'OTHER',
    1: 'OOC',
    2: 'IC',
    3: 'EMOTE',
  };

  // -- PF2e: one baked card per message, routed by flags.pf2e.context.type.
  const CHECK_TYPES = new Set([
    'attack-roll',
    'skill-check',
    'perception-check',
    'saving-throw',
    'flat-check',
    'initiative',
  ]);

  const parsePf2eCard = (m: MessageLike): ChatCard => {
    const ctx = m.flags?.pf2e?.context;
    if (!ctx || typeof ctx.type !== 'string') {
      return { kind: 'other', system: 'pf2e', rawCardType: null };
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
        system: 'pf2e',
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
        system: 'pf2e',
        checkType: ctx.type,
        dc,
        outcome,
        domains: Array.isArray(ctx.domains)
          ? (ctx.domains as unknown[]).filter((d): d is string => typeof d === 'string')
          : [],
        rollTotal: sumRollTotals(m.rolls),
      };
    }

    return { kind: 'other', system: 'pf2e', rawCardType: ctx.type };
  };

  // -- D&D 5e: a usage card + separate roll messages, joined by
  // flags.dnd5e.originatingMessage; initiative is a bare core flag.
  const parseDnd5eCard = (m: MessageLike): ChatCard => {
    // Initiative carries no flags.dnd5e — test the core flag first.
    if (m.flags?.core?.initiativeRoll === true) {
      return { kind: 'initiative', system: 'dnd5e', rollTotal: sumRollTotals(m.rolls) };
    }
    const dnd = m.flags?.dnd5e;
    if (!dnd || typeof dnd !== 'object') {
      return { kind: 'other', system: 'dnd5e', rawCardType: null };
    }

    // Roll message: messageType "roll" + a roll descriptor.
    if (dnd.messageType === 'roll' && dnd.roll && typeof dnd.roll === 'object') {
      const roll = dnd.roll;
      const rollType = typeof roll.type === 'string' ? roll.type : null;
      const originatingMessageId =
        typeof dnd.originatingMessage === 'string' ? dnd.originatingMessage : null;
      const rollTotal = sumRollTotals(m.rolls);
      const naturalD20 = naturalD20From(m.rolls);

      if (rollType === 'attack') {
        const opts =
          Array.isArray(m.rolls) && m.rolls[0]
            ? ((m.rolls[0].options ?? null) as Dnd5eRollOptionsLike | null)
            : null;
        const targetAc =
          opts && typeof opts.target === 'number' && Number.isFinite(opts.target)
            ? opts.target
            : null;
        const critSuccess =
          opts && typeof opts.criticalSuccess === 'number' ? opts.criticalSuccess : 20;
        const critFailure =
          opts && typeof opts.criticalFailure === 'number' ? opts.criticalFailure : 1;
        let outcome: DegreeOfSuccess | null = null;
        if (naturalD20 !== null && naturalD20 >= critSuccess) outcome = 'criticalSuccess';
        else if (naturalD20 !== null && naturalD20 <= critFailure) outcome = 'criticalFailure';
        else if (targetAc !== null && rollTotal !== null)
          outcome = rollTotal >= targetAc ? 'success' : 'failure';
        return {
          kind: 'attack',
          system: 'dnd5e',
          originatingMessageId,
          rollTotal,
          naturalD20,
          attackMode: typeof roll.attackMode === 'string' ? roll.attackMode : null,
          targetAc,
          outcome,
          targets: dnd5eTargets(dnd.targets),
        };
      }

      if (rollType === 'damage') {
        const types = new Set<string>();
        let isCritical = false;
        for (const r of Array.isArray(m.rolls) ? m.rolls : []) {
          const opts = (r as RollLike).options as Dnd5eRollOptionsLike | undefined;
          if (!opts) continue;
          if (opts.isCritical === true) isCritical = true;
          if (Array.isArray(opts.types)) {
            for (const t of opts.types) if (typeof t === 'string') types.add(t);
          } else if (typeof opts.type === 'string') {
            types.add(opts.type);
          }
        }
        return {
          kind: 'damage',
          system: 'dnd5e',
          originatingMessageId,
          total: sumRollTotals(m.rolls) ?? 0,
          damageTypes: [...types],
          isCritical,
        };
      }

      if (rollType === 'save') {
        const dc = dcFromOriginating(dnd.originatingMessage);
        const outcome =
          dc !== null && rollTotal !== null ? (rollTotal >= dc ? 'success' : 'failure') : null;
        return {
          kind: 'save',
          system: 'dnd5e',
          originatingMessageId,
          ability: typeof roll.ability === 'string' ? roll.ability : null,
          rollTotal,
          naturalD20,
          dc,
          outcome,
        };
      }

      if (rollType === 'ability' || rollType === 'skill' || rollType === 'tool') {
        const dc = dcFromOriginating(dnd.originatingMessage);
        const outcome =
          dc !== null && rollTotal !== null ? (rollTotal >= dc ? 'success' : 'failure') : null;
        const key =
          typeof roll.ability === 'string'
            ? roll.ability
            : typeof roll.skillId === 'string'
              ? roll.skillId
              : typeof roll.toolId === 'string'
                ? roll.toolId
                : null;
        return {
          kind: 'check',
          system: 'dnd5e',
          originatingMessageId,
          checkType: rollType,
          key,
          rollTotal,
          naturalD20,
          dc,
          outcome,
        };
      }

      return { kind: 'other', system: 'dnd5e', rawCardType: rollType };
    }

    // Usage / activation card: an activity, no messageType.
    if (dnd.activity && typeof dnd.activity === 'object') {
      const activity = dnd.activity;
      const item = dnd.item && typeof dnd.item === 'object' ? dnd.item : {};
      return {
        kind: 'item-card',
        system: 'dnd5e',
        activityType: typeof activity.type === 'string' ? activity.type : null,
        activityId: typeof activity.id === 'string' ? activity.id : null,
        itemType: typeof item.type === 'string' ? item.type : null,
        itemId: typeof item.id === 'string' ? item.id : null,
        itemUuid: typeof item.uuid === 'string' ? item.uuid : null,
        itemName: titleFromHtml(m.content),
        targets: dnd5eTargets(dnd.targets),
      };
    }

    return { kind: 'other', system: 'dnd5e', rawCardType: null };
  };

  const parseCard = (m: MessageLike): ChatCard => {
    if (systemId === 'pf2e') return parsePf2eCard(m);
    if (systemId === 'dnd5e') return parseDnd5eCard(m);
    return { kind: 'other', system: null, rawCardType: null };
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
