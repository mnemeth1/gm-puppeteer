import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  postChatMessageBody,
  type PostChatMessageInput,
} from '../../src/evaluators/post-chat-message.js';

/**
 * The evaluator body runs in the browser via page.evaluate; here we stub
 * `game` and the `ChatMessage` class per-test. The live-Foundry probe
 * (scripts/probe-chat-post-phase1.mjs) confirmed the write behaviour the
 * mocks below assume — owner resolution, getSpeaker shape, create()
 * returning the document.
 */

interface UserLike {
  id: string;
  name: string;
  isGM: boolean;
}
interface ActorLike {
  id: string;
  name: string;
  type: string;
  ownerUserIds: string[];
}

let createCalls: Array<Record<string, unknown>>;
let messageSize: number;

function installGlobals(opts: {
  actors: ActorLike[];
  users: UserLike[];
  createReturnsId?: string | null;
}): void {
  const actorDocs = new Map(
    opts.actors.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        type: a.type,
        testUserPermission: (user: UserLike, _level: string): boolean =>
          a.ownerUserIds.includes(user.id),
      },
    ]),
  );
  createCalls = [];
  messageSize = 0;
  const messageContents: Array<{ id: string }> = [];

  (globalThis as unknown as { game: unknown }).game = {
    actors: { get: (id: string) => actorDocs.get(id) },
    users: { contents: opts.users },
    messages: {
      get size() {
        return messageSize;
      },
      contents: messageContents,
    },
  };
  (globalThis as unknown as { ChatMessage: unknown }).ChatMessage = {
    implementation: {
      create: async (data: Record<string, unknown>) => {
        createCalls.push(data);
        messageSize += 1;
        const created =
          opts.createReturnsId === undefined
            ? { id: 'createdMsg000001' }
            : opts.createReturnsId === null
              ? {}
              : { id: opts.createReturnsId };
        if (opts.createReturnsId === null) {
          messageContents.push({ id: 'fallbackMsgId001' });
        }
        return created;
      },
    },
    getSpeaker: (o?: { actor?: { id: string; name: string } }) =>
      o?.actor
        ? { actor: o.actor.id, alias: o.actor.name, scene: 's1' }
        : { alias: 'AI-GM', scene: 's1' },
  };
}

/** Build an input with `visibility: "public"` unless overridden. */
function makeInput(over: Partial<PostChatMessageInput>): PostChatMessageInput {
  return {
    content: '<p>x</p>',
    speakerActorId: null,
    visibility: 'public',
    whisperTo: [],
    ...over,
  };
}

const GM: UserLike = { id: 'gm1', name: 'AI-GM', isGM: true };
const GM2: UserLike = { id: 'gm2', name: 'Michael-GM', isGM: true };
const PLAYER1: UserLike = { id: 'p1', name: 'Player1', isGM: false };
const PLAYER2: UserLike = { id: 'p2', name: 'Player2', isGM: false };

describe('postChatMessageBody', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
    delete (globalThis as unknown as { ChatMessage?: unknown }).ChatMessage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
    delete (globalThis as unknown as { ChatMessage?: unknown }).ChatMessage;
  });

  it('returns FOUNDRY_NOT_READY when globals are unavailable', async () => {
    const result = await postChatMessageBody(makeInput({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('FOUNDRY_NOT_READY');
  });

  it('posts a public message spoken by the GM (no speaker, no whisper)', async () => {
    installGlobals({ actors: [], users: [GM] });
    const result = await postChatMessageBody(makeInput({ content: '<p>narration</p>' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.speaker).toEqual({ actorId: null, alias: 'AI-GM' });
      expect(result.visibility).toBe('public');
      expect(result.isWhisper).toBe(false);
      expect(result.chatMessageId).toBe('createdMsg000001');
    }
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({
      content: '<p>narration</p>',
      speaker: { alias: 'AI-GM', scene: 's1' },
    });
    expect('whisper' in (createCalls[0] ?? {})).toBe(false);
  });

  it('posts a public message spoken as an NPC', async () => {
    const npc: ActorLike = { id: 'npc1', name: 'Goblin', type: 'npc', ownerUserIds: ['gm1'] };
    installGlobals({ actors: [npc], users: [GM] });
    const result = await postChatMessageBody(makeInput({ speakerActorId: 'npc1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.speaker).toEqual({ actorId: 'npc1', alias: 'Goblin' });
      expect(result.isWhisper).toBe(false);
    }
  });

  it('rejects an unresolvable speakerActorId', async () => {
    installGlobals({ actors: [], users: [GM] });
    const result = await postChatMessageBody(makeInput({ speakerActorId: 'ghost' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('SPEAKER_ACTOR_NOT_FOUND');
  });

  it('whispers to all GM users when visibility is "gm"', async () => {
    installGlobals({ actors: [], users: [GM, GM2, PLAYER1] });
    const result = await postChatMessageBody(makeInput({ visibility: 'gm' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibility).toBe('gm');
      expect(result.isWhisper).toBe(true);
      expect(result.whisperTargets).toEqual([]);
      expect(result.whisperedTo).toEqual([
        { userId: 'gm1', userName: 'AI-GM', viaActorId: null },
        { userId: 'gm2', userName: 'Michael-GM', viaActorId: null },
      ]);
    }
    expect(createCalls[0]?.whisper).toEqual(['gm1', 'gm2']);
  });

  it('rejects visibility "gm" combined with whisperTo', async () => {
    const pc: ActorLike = {
      id: 'pc1',
      name: 'Kyra',
      type: 'character',
      ownerUserIds: ['gm1', 'p1'],
    };
    installGlobals({ actors: [pc], users: [GM, PLAYER1] });
    const result = await postChatMessageBody(
      makeInput({ visibility: 'gm', whisperTo: ['pc1'] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.reason).toBe('VISIBILITY_WHISPER_CONFLICT');
    }
    expect(createCalls).toHaveLength(0);
  });

  it('rejects visibility "gm" when the world has no GM users', async () => {
    installGlobals({ actors: [], users: [PLAYER1] });
    const result = await postChatMessageBody(makeInput({ visibility: 'gm' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('NO_GM_USERS');
  });

  it('whispers to the owning players of a PC and reports recipients', async () => {
    const pc: ActorLike = {
      id: 'pc1',
      name: 'Kyra',
      type: 'character',
      ownerUserIds: ['gm1', 'p1'],
    };
    installGlobals({ actors: [pc], users: [GM, PLAYER1] });
    const result = await postChatMessageBody(makeInput({ whisperTo: ['pc1'] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isWhisper).toBe(true);
      expect(result.whisperTargets).toEqual([{ actorId: 'pc1', actorName: 'Kyra' }]);
      expect(result.whisperedTo).toEqual([
        { userId: 'gm1', userName: 'AI-GM', viaActorId: 'pc1' },
        { userId: 'p1', userName: 'Player1', viaActorId: 'pc1' },
      ]);
    }
    expect(createCalls[0]?.whisper).toEqual(['gm1', 'p1']);
  });

  it('rejects a whisperTo id that does not resolve', async () => {
    installGlobals({ actors: [], users: [GM] });
    const result = await postChatMessageBody(makeInput({ whisperTo: ['nope'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('WHISPER_TARGET_NOT_FOUND');
  });

  it('rejects a whisperTo id that is not a character actor', async () => {
    const npc: ActorLike = { id: 'npc1', name: 'Goblin', type: 'npc', ownerUserIds: ['gm1'] };
    installGlobals({ actors: [npc], users: [GM] });
    const result = await postChatMessageBody(makeInput({ whisperTo: ['npc1'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('WHISPER_TARGET_NOT_A_PC');
  });

  it('rejects a PC whisper target with no non-GM owner', async () => {
    const pc: ActorLike = {
      id: 'pc1',
      name: 'Orphan PC',
      type: 'character',
      ownerUserIds: ['gm1'],
    };
    installGlobals({ actors: [pc], users: [GM] });
    const result = await postChatMessageBody(makeInput({ whisperTo: ['pc1'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('NO_PLAYER_OWNER');
  });

  it('deduplicates recipients shared across whisper targets', async () => {
    const pc1: ActorLike = {
      id: 'pc1',
      name: 'Kyra',
      type: 'character',
      ownerUserIds: ['gm1', 'p1'],
    };
    const pc2: ActorLike = {
      id: 'pc2',
      name: 'Valeros',
      type: 'character',
      ownerUserIds: ['gm1', 'p1', 'p2'],
    };
    installGlobals({ actors: [pc1, pc2], users: [GM, PLAYER1, PLAYER2] });
    const result = await postChatMessageBody(makeInput({ whisperTo: ['pc1', 'pc2'] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.whisperedTo.map((w) => w.userId)).toEqual(['gm1', 'p1', 'p2']);
      // gm1 / p1 first seen via pc1, p2 via pc2.
      expect(result.whisperedTo.map((w) => w.viaActorId)).toEqual(['pc1', 'pc1', 'pc2']);
    }
    expect(createCalls[0]?.whisper).toEqual(['gm1', 'p1', 'p2']);
  });

  it('recovers the chat message id via the size diff when create returns no id', async () => {
    installGlobals({ actors: [], users: [GM], createReturnsId: null });
    const result = await postChatMessageBody(makeInput({}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.chatMessageId).toBe('fallbackMsgId001');
  });
});
