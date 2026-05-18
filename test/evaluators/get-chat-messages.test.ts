import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChatMessagesBody } from '../../src/evaluators/get-chat-messages.js';

/**
 * The evaluator body runs in the browser via page.evaluate; here we stub
 * `game.messages` (and `game.system`, which selects the card parser)
 * per-test. The live-Foundry probes (scripts/probe-chat-messages-phase1.mjs
 * for PF2e, scripts/probe-chat-messages-dnd5e.mjs for D&D 5e) confirmed
 * the field shapes the mocks below use — these tests verify our
 * projection over them. The node test environment has no `document`, so
 * the evaluator's regex HTML-strip / title fallbacks are exercised here.
 */

interface RollLike {
  total?: number;
  instances?: unknown[];
  dice?: Array<{ faces?: number; results?: Array<{ result?: number; active?: boolean }> }>;
  options?: Record<string, unknown>;
}

interface MsgLike {
  id: string;
  author?: { id?: string; name?: string } | null;
  _source?: { author?: string; style?: number };
  speaker?: { actor?: string; token?: string; alias?: string } | null;
  timestamp?: number;
  content?: string;
  flavor?: string;
  isRoll?: boolean;
  rolls?: RollLike[];
  whisper?: string[];
  blind?: boolean;
  style?: number;
  flags?: {
    pf2e?: { context?: Record<string, unknown> };
    core?: { initiativeRoll?: boolean };
    dnd5e?: Record<string, unknown>;
  } | null;
}

function installMessages(messages: MsgLike[], systemId: string | null = 'pf2e'): void {
  (globalThis as unknown as { game: unknown }).game = {
    system: systemId === null ? null : { id: systemId },
    messages: {
      contents: messages,
      size: messages.length,
      get: (id: string) => messages.find((m) => m.id === id),
    },
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
        system: 'pf2e',
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
      expect(card.system).toBe('pf2e');
      expect(card.total).toBe(12);
      expect(card.outcome).toBe('success');
      if (card.system === 'pf2e') {
        expect(card.targetActorId).toBe('targetActor001');
        expect(card.instances).toEqual([
          { damageType: 'piercing', category: 'physical', total: 9, persistent: false },
          { damageType: 'fire', category: null, total: 3, persistent: true },
        ]);
      }
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
      expect(result.messages[0]?.card).toEqual({
        kind: 'other',
        system: 'pf2e',
        rawCardType: null,
      });
      expect(result.messages[1]?.card).toEqual({
        kind: 'other',
        system: 'pf2e',
        rawCardType: 'damage-taken',
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

  // -- D&D 5e card parsing ----------------------------------------------

  it('parses a D&D 5e initiative roll from the core flag', () => {
    installMessages(
      [
        makeMsg({
          id: 'init1',
          isRoll: true,
          rolls: [{ total: 21 }],
          flags: { core: { initiativeRoll: true } },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'initiative',
        system: 'dnd5e',
        rollTotal: 21,
      });
    }
  });

  it('parses a D&D 5e usage / activation card, lifting the item name from HTML', () => {
    installMessages(
      [
        makeMsg({
          id: 'use1',
          content:
            '<div class="chat-card activation-card"><span class="title">Scimitar</span></div>',
          flags: {
            dnd5e: {
              activity: { type: 'attack', id: 'act1' },
              item: { type: 'weapon', id: 'itm1', uuid: 'Actor.a1.Item.itm1' },
              targets: [{ name: 'Beiro', uuid: 'Scene.s.Token.t.Actor.beiro1', ac: 15 }],
            },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'item-card',
        system: 'dnd5e',
        activityType: 'attack',
        activityId: 'act1',
        itemType: 'weapon',
        itemId: 'itm1',
        itemUuid: 'Actor.a1.Item.itm1',
        itemName: 'Scimitar',
        targets: [{ name: 'Beiro', uuid: 'Scene.s.Token.t.Actor.beiro1', actorId: 'beiro1', ac: 15 }],
      });
    }
  });

  it('derives a D&D 5e attack hit from rollTotal vs target AC', () => {
    installMessages(
      [
        makeMsg({
          id: 'atk1',
          isRoll: true,
          rolls: [
            {
              total: 18,
              dice: [{ faces: 20, results: [{ result: 14, active: true }] }],
              options: { target: 15, criticalSuccess: 20, criticalFailure: 1 },
            },
          ],
          flags: {
            dnd5e: {
              messageType: 'roll',
              roll: { type: 'attack', attackMode: 'oneHanded' },
              originatingMessage: 'use1',
              targets: [{ name: 'Beiro', uuid: 'Actor.beiro1', ac: 15 }],
            },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'attack',
        system: 'dnd5e',
        originatingMessageId: 'use1',
        rollTotal: 18,
        naturalD20: 14,
        attackMode: 'oneHanded',
        targetAc: 15,
        outcome: 'success',
        targets: [{ name: 'Beiro', uuid: 'Actor.beiro1', actorId: 'beiro1', ac: 15 }],
      });
    }
  });

  it('flags a D&D 5e attack natural 20 as a critical hit regardless of AC', () => {
    installMessages(
      [
        makeMsg({
          id: 'atk2',
          isRoll: true,
          rolls: [
            {
              total: 27,
              dice: [{ faces: 20, results: [{ result: 20, active: true }] }],
              options: { target: 30, criticalSuccess: 20, criticalFailure: 1 },
            },
          ],
          flags: {
            dnd5e: { messageType: 'roll', roll: { type: 'attack' } },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'attack') {
      expect(result.messages[0].card.outcome).toBe('criticalSuccess');
      expect(result.messages[0].card.naturalD20).toBe(20);
    }
  });

  it('flags a D&D 5e attack natural 1 as a critical miss', () => {
    installMessages(
      [
        makeMsg({
          id: 'atk3',
          isRoll: true,
          rolls: [
            {
              total: 19,
              dice: [{ faces: 20, results: [{ result: 1, active: true }] }],
              options: { target: 10, criticalSuccess: 20, criticalFailure: 1 },
            },
          ],
          flags: { dnd5e: { messageType: 'roll', roll: { type: 'attack' } } },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'attack') {
      expect(result.messages[0].card.outcome).toBe('criticalFailure');
    }
  });

  it('leaves a D&D 5e attack outcome null when no target was set', () => {
    installMessages(
      [
        makeMsg({
          id: 'atk4',
          isRoll: true,
          rolls: [
            {
              total: 16,
              dice: [{ faces: 20, results: [{ result: 12, active: true }] }],
              options: { criticalSuccess: 20, criticalFailure: 1 },
            },
          ],
          flags: { dnd5e: { messageType: 'roll', roll: { type: 'attack' } } },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'attack') {
      expect(result.messages[0].card.outcome).toBeNull();
      expect(result.messages[0].card.targetAc).toBeNull();
    }
  });

  it('picks the kept d20 face on a D&D 5e advantage roll', () => {
    installMessages(
      [
        makeMsg({
          id: 'atk5',
          isRoll: true,
          rolls: [
            {
              total: 21,
              dice: [
                {
                  faces: 20,
                  results: [
                    { result: 4, active: false },
                    { result: 18, active: true },
                  ],
                },
              ],
              options: { target: 15, criticalSuccess: 20, criticalFailure: 1 },
            },
          ],
          flags: { dnd5e: { messageType: 'roll', roll: { type: 'attack' } } },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'attack') {
      expect(result.messages[0].card.naturalD20).toBe(18);
      expect(result.messages[0].card.outcome).toBe('success');
    }
  });

  it('dedupes damage types across every roll on a D&D 5e damage card', () => {
    installMessages(
      [
        makeMsg({
          id: 'dmg5e',
          isRoll: true,
          rolls: [
            { total: 7, options: { type: 'fire', types: ['fire'], isCritical: false } },
            { total: 4, options: { types: ['fire', 'radiant'], isCritical: true } },
          ],
          flags: {
            dnd5e: { messageType: 'roll', roll: { type: 'damage' }, originatingMessage: 'use1' },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'damage',
        system: 'dnd5e',
        originatingMessageId: 'use1',
        total: 11,
        damageTypes: ['fire', 'radiant'],
        isCritical: true,
      });
    }
  });

  it('resolves a D&D 5e save DC from the originating usage card and derives pass/fail', () => {
    installMessages(
      [
        makeMsg({
          id: 'usesave1',
          content:
            '<div class="chat-card"><button data-dc="15" data-ability="wis" data-action="rollSave">DC 15</button></div>',
          flags: { dnd5e: { activity: { type: 'save', id: 'sv1' } } },
        }),
        makeMsg({
          id: 'save1',
          isRoll: true,
          rolls: [{ total: 5, dice: [{ faces: 20, results: [{ result: 6, active: true }] }] }],
          flags: {
            dnd5e: {
              messageType: 'roll',
              roll: { type: 'save', ability: 'wis' },
              originatingMessage: 'usesave1',
            },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[1]?.card).toEqual({
        kind: 'save',
        system: 'dnd5e',
        originatingMessageId: 'usesave1',
        ability: 'wis',
        rollTotal: 5,
        naturalD20: 6,
        dc: 15,
        outcome: 'failure',
      });
    }
  });

  it('leaves a D&D 5e save DC null when the originating message is missing', () => {
    installMessages(
      [
        makeMsg({
          id: 'save2',
          isRoll: true,
          rolls: [{ total: 17, dice: [{ faces: 20, results: [{ result: 14, active: true }] }] }],
          flags: {
            dnd5e: {
              messageType: 'roll',
              roll: { type: 'save', ability: 'con' },
              originatingMessage: 'scrolled-off',
            },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok && result.messages[0]?.card.kind === 'save') {
      expect(result.messages[0].card.dc).toBeNull();
      expect(result.messages[0].card.outcome).toBeNull();
    }
  });

  it('parses a D&D 5e skill check with no DC', () => {
    installMessages(
      [
        makeMsg({
          id: 'skl1',
          isRoll: true,
          rolls: [{ total: 16, dice: [{ faces: 20, results: [{ result: 14, active: true }] }] }],
          flags: {
            dnd5e: { messageType: 'roll', roll: { type: 'skill', skillId: 'acr' } },
          },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'check',
        system: 'dnd5e',
        originatingMessageId: null,
        checkType: 'skill',
        key: 'acr',
        rollTotal: 16,
        naturalD20: 14,
        dc: null,
        outcome: null,
      });
    }
  });

  it('routes an unmodeled D&D 5e roll type to kind:"other"', () => {
    installMessages(
      [
        makeMsg({
          id: 'odd1',
          isRoll: true,
          flags: { dnd5e: { messageType: 'roll', roll: { type: 'concentration' } } },
        }),
      ],
      'dnd5e',
    );
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'other',
        system: 'dnd5e',
        rawCardType: 'concentration',
      });
    }
  });

  it('routes a plain D&D 5e message to kind:"other"', () => {
    installMessages([makeMsg({ id: 'plain5e' })], 'dnd5e');
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'other',
        system: 'dnd5e',
        rawCardType: null,
      });
    }
  });

  it('returns a system:null other card for an unsupported game system', () => {
    installMessages([makeMsg({ id: 'swade1' })], 'swade');
    const result = getChatMessagesBody({ limit: 20, sinceMessageId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0]?.card).toEqual({
        kind: 'other',
        system: null,
        rawCardType: null,
      });
    }
  });
});
