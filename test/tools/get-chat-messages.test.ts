import { describe, expect, it, vi } from 'vitest';
import { getChatMessagesTool } from '../../src/tools/get-chat-messages.js';
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

describe('get_chat_messages', () => {
  it('returns the evaluator result as a JSON content block on success', async () => {
    const evalResult = {
      ok: true,
      messages: [{ id: 'm1' }],
      totalInLog: 42,
      returnedCount: 1,
    };
    const evaluate = vi.fn().mockResolvedValueOnce(evalResult);
    const ctx = makeCtx(evaluate);

    const result = await getChatMessagesTool.handler({ limit: 20 }, ctx);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('text');
    expect(JSON.parse((result[0] as { text: string }).text)).toEqual(evalResult);
  });

  it('normalizes an omitted sinceMessageId to null when calling the evaluator', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, messages: [], totalInLog: 0, returnedCount: 0 });
    const ctx = makeCtx(evaluate);

    await getChatMessagesTool.handler({ limit: 20 }, ctx);

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      limit: 20,
      sinceMessageId: null,
    });
  });

  it('throws ToolError(INVALID_INPUT) when the evaluator reports failure', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'No chat message with id "gone"',
        details: { sinceMessageId: 'gone', reason: 'SINCE_MESSAGE_NOT_FOUND' },
      },
    });
    const ctx = makeCtx(evaluate);

    const err = await getChatMessagesTool
      .handler({ limit: 20, sinceMessageId: 'gone' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toMatchObject({ reason: 'SINCE_MESSAGE_NOT_FOUND' });
  });

  it('defaults limit to 20 when omitted', () => {
    const parsed = getChatMessagesTool.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(20);
  });

  it('rejects a limit above 200', () => {
    expect(getChatMessagesTool.inputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('rejects an empty sinceMessageId and unknown keys', () => {
    expect(getChatMessagesTool.inputSchema.safeParse({ sinceMessageId: '' }).success).toBe(false);
    expect(getChatMessagesTool.inputSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
