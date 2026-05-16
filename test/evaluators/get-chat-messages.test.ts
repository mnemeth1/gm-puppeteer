import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChatMessagesBody } from '../../src/evaluators/get-chat-messages.js';

/**
 * The evaluator body runs in the browser via page.evaluate; here we stub
 * `game.messages` per-test. The live-Foundry probe
 * (scripts/probe-chat-messages-phase1.mjs) confirmed the field shapes the
 * mocks below use — these tests verify our projection over them. The
 * node test environment has no `document`, so the evaluator's regex
 * HTML-strip fallback is the path exercised here.
 */

interface MsgLike {
  id: string;
  author?: { id?: string; name?: string } | null;
  _source?: { author?: string; style?: number };
  speaker?: { actor?: string; token?: string; alias?: string } | null;
  timestamp?: number;
  content?: string;
  flavor?: string;
  isRoll?: boolean;
  rolls?: Array<{ total?: number; instances?: unknown[] }>;
  whisper?: string[];
  blind?: boolean;
  style?: number;
  flags?: { pf2e?: { context?: Record<string, unknown> } } | null;
}

function installMessages(messages: MsgLike[]): void {
  (globalThis as unknown as { game: unknown }).game = {
    messages: { contents: messages, size: messages.length },
  };
}

function makeMsg(overrides: Partial<MsgLike> = {}): MsgLike {
  return {
    id: 'msg0000000000001',
    author: { id: 'userGM0000000001', name: 'AI-GM' },
    _source: { author: 'userGM0000000001', style: 0 },
    speaker: { alias: 'AI-GM' },
    timestamp: 1778948698188,
    content: '<p>Hello table.</p>',
    flavor: '',
    isRoll: false,
    rolls: [],
    whisper: [],
    blind: false,
    style: 0,
    flags: null,
    ...overrides,
  };
}

describe('getChatMessagesBody', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
  });
  afterEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
  });

  it('returns FOUNDRY_NOT_READY when game.messages is unavailable', () => {
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.details?.reason).toBe('FOUNDRY_NOT_READY');
    }
  });

  it('returns an empty window for an empty log', () => {
    installMessages([]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toEqual([]);
      expect(result.totalInLog).toBe(0);
      expect(result.returnedCount).toBe(0);
    }
  });

  it('keeps only the newest `limit` messages, in chronological order', () => {
    const msgs = [1, 2, 3, 4, 5].map((n) => makeMsg({ id: `m${n}` }));
    installMessages(msgs);
    const result = getChatMessagesBody({ limit: 2, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((m) => m.id)).toEqual(['m4', 'm5']);
      expect(result.totalInLog).toBe(5);
      expect(result.returnedCount).toBe(2);
    }
  });

  it('slices forward and exclusively from sinceMessageId', () => {
    const msgs = [1, 2, 3, 4, 5].map((n) => makeMsg({ id: `m${n}` }));
    installMessages(msgs);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: 'm3' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((m) => m.id)).toEqual(['m4', 'm5']);
    }
  });

  it('rejects a sinceMessageId that is not in the log', () => {
    installMessages([makeMsg({ id: 'm1' })]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: 'gone' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.reason).toBe('SINCE_MESSAGE_NOT_FOUND');
      expect(result.error.details?.sinceMessageId).toBe('gone');
    }
  });

  it('parses a PF2e check card with dc, outcome, and domains', () => {
    installMessages([
      makeMsg({
        id: 'chk1',
        isRoll: true,
        rolls: [{ total: 24 }],
        flags: {
          pf2e: {
            context: {
              type: 'perception-check',
              dc: 18,
              outcome: 'success',
              domains: ['perception', 'all'],
            },
          },
        },
      }),
    ]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'check',
        checkType: 'perception-check',
        dc: 18,
        outcome: 'success',
        domains: ['perception', 'all'],
        rollTotal: 24,
      });
      expect(result.messages[0]?.rollTotal).toBe(24);
    }
  });

  it('normalizes an object-form check dc to dc.value', () => {
    installMessages([
      makeMsg({
        id: 'chk2',
        flags: {
          pf2e: { context: { type: 'saving-throw', dc: { value: 21 } } },
        },
      }),
    ]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'check') {
      expect(result.messages[0].card.dc).toBe(21);
    }
  });

  it('parses a PF2e damage card with per-type instances', () => {
    installMessages([
      makeMsg({
        id: 'dmg1',
        isRoll: true,
        rolls: [
          {
            total: 12,
            instances: [
              { type: 'piercing', category: 'physical', total: 9, persistent: false },
              { type: 'fire', category: null, total: 3, persistent: true },
            ],
          },
        ],
        flags: {
          pf2e: {
            context: {
              type: 'damage-roll',
              outcome: 'success',
              target: { actor: 'Scene.s1.Token.t1.Actor.targetActor001' },
            },
          },
        },
      }),
    ]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'damage') {
      const card = result.messages[0].card;
      expect(card.total).toBe(12);
      expect(card.outcome).toBe('success');
      expect(card.targetActorId).toBe('targetActor001');
      expect(card.instances).toEqual([
        { damageType: 'piercing', category: 'physical', total: 9, persistent: false },
        { damageType: 'fire', category: null, total: 3, persistent: true },
      ]);
    }
  });

  it('routes a plain message and an unmodeled pf2e card to kind:"other"', () => {
    installMessages([
      makeMsg({ id: 'plain' }),
      makeMsg({
        id: 'taken',
        flags: { pf2e: { context: { type: 'damage-taken' } } },
      }),
    ]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({ kind: 'other', pf2eCardType: null });
      expect(result.messages[1]?.card).toEqual({
        kind: 'other',
        pf2eCardType: 'damage-taken',
      });
    }
  });

  it('strips HTML from flavor + content into the text field', () => {
    installMessages([
      makeMsg({
        id: 'rich',
        flavor: '<h4>Initiative</h4>',
        content: '<p>The door <strong>creaks</strong> &amp; opens.</p>',
      }),
    ]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.text).toBe('Initiative The door creaks & opens.');
    }
  });

  it('falls back to _source.author for the user id when the author getter is null', () => {
    installMessages([
      makeMsg({ id: 'orphan', author: null, _source: { author: 'deletedUser01', style: 0 } }),
    ]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.author).toEqual({ userId: 'deletedUser01', name: null });
    }
  });

  it('maps the numeric style to its name and projects whisper/blind', () => {
    installMessages([makeMsg({ id: 'ic', style: 2, whisper: ['u1', 'u2'], blind: true })]);
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.style).toBe('IC');
      expect(result.messages[0]?.whisper).toEqual(['u1', 'u2']);
      expect(result.messages[0]?.blind).toBe(true);
    }
  });
});
