import { describe, expect, it, vi } from 'vitest';
import { postChatMessageTool } from '../../src/tools/post-chat-message.js';
import { ToolError } from '../../src/errors.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';

function makeCtx(evaluate: ReturnType<typeof vi.fn>): {
  browser: BrowserSession;
  log: Logger;
} {
  const page = { evaluate };
  const browser = { ensureStarted: vi.fn().mockResolvedValue({ page }) };
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { browser: browser as unknown as BrowserSession, log: log as unknown as Logger };
}

describe('post_chat_message', () => {
  it('returns the evaluator result as a JSON content block on success', async () => {
    const evalResult = {
      ok: true,
      chatMessageId: 'msg-1',
      speaker: { actorId: null, alias: 'AI-GM' },
      isWhisper: false,
      whisperedTo: [],
      whisperTargets: [],
    };
    const evaluate = vi.fn().mockResolvedValueOnce(evalResult);
    const ctx = makeCtx(evaluate);

    const result = await postChatMessageTool.handler({ content: '<p>hi</p>' }, ctx);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('text');
    expect(JSON.parse((result[0] as { text: string }).text)).toEqual(evalResult);
  });

  it('normalizes omitted optional fields when calling the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      chatMessageId: 'm',
      speaker: { actorId: null, alias: 'AI-GM' },
      isWhisper: false,
      whisperedTo: [],
      whisperTargets: [],
    });
    const ctx = makeCtx(evaluate);

    await postChatMessageTool.handler({ content: '<p>hi</p>', visibility: 'public' }, ctx);

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      content: '<p>hi</p>',
      speakerActorId: null,
      visibility: 'public',
      whisperTo: [],
    });
  });

  it('forwards speakerActorId and whisperTo to the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      chatMessageId: 'm',
      speaker: { actorId: 'npc1', alias: 'Goblin' },
      isWhisper: true,
      whisperedTo: [],
      whisperTargets: [],
    });
    const ctx = makeCtx(evaluate);

    await postChatMessageTool.handler(
      { content: '<p>psst</p>', speakerActorId: 'npc1', visibility: 'public', whisperTo: ['pc1'] },
      ctx,
    );

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      content: '<p>psst</p>',
      speakerActorId: 'npc1',
      visibility: 'public',
      whisperTo: ['pc1'],
    });
  });

  it('forwards visibility "gm" to the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      chatMessageId: 'm',
      speaker: { actorId: null, alias: 'AI-GM' },
      visibility: 'gm',
      isWhisper: true,
      whisperedTo: [],
      whisperTargets: [],
    });
    const ctx = makeCtx(evaluate);

    await postChatMessageTool.handler({ content: '<p>note</p>', visibility: 'gm' }, ctx);

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      content: '<p>note</p>',
      speakerActorId: null,
      visibility: 'gm',
      whisperTo: [],
    });
  });

  it('defaults visibility to "public" and rejects an unknown value', () => {
    const parsed = postChatMessageTool.inputSchema.safeParse({ content: '<p>x</p>' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.visibility).toBe('public');
    expect(
      postChatMessageTool.inputSchema.safeParse({ content: '<p>x</p>', visibility: 'blind' })
        .success,
    ).toBe(false);
  });

  it('throws ToolError(INVALID_INPUT) when the evaluator reports failure', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: "Actor 'Orphan PC' has no non-GM owner",
        details: { actorId: 'pc1', reason: 'NO_PLAYER_OWNER' },
      },
    });
    const ctx = makeCtx(evaluate);

    const err = await postChatMessageTool
      .handler({ content: '<p>x</p>', whisperTo: ['pc1'] }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toMatchObject({ reason: 'NO_PLAYER_OWNER' });
  });

  it('rejects empty content', () => {
    expect(postChatMessageTool.inputSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('rejects an empty whisperTo array', () => {
    expect(
      postChatMessageTool.inputSchema.safeParse({ content: '<p>x</p>', whisperTo: [] }).success,
    ).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(
      postChatMessageTool.inputSchema.safeParse({ content: '<p>x</p>', nope: 1 }).success,
    ).toBe(false);
  });
});
