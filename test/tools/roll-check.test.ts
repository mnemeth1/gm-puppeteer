import { describe, expect, it, vi } from 'vitest';
import { rollCheckTool } from '../../src/tools/roll-check.js';
import { ToolError } from '../../src/errors.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';

function makeCtx(evaluate: ReturnType<typeof vi.fn>): {
  browser: BrowserSession;
  log: Logger;
} {
  const page = { evaluate };
  const browser = {
    ensureStarted: vi.fn().mockResolvedValue({ page }),
  };
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { browser: browser as unknown as BrowserSession, log: log as unknown as Logger };
}

describe('pf2e_roll_check', () => {
  it('returns the evaluator result as a JSON content block on success', async () => {
    const evalResult = {
      ok: true,
      actor: { id: 'npc-1', name: 'Goblin Warrior 1', type: 'npc' },
      checkType: 'perception',
      statisticSlug: 'perception',
      modifier: 2,
      dc: 15,
      total: 14,
      dieResult: 12,
      outcome: 'failure',
      visibility: 'public',
      chatMessageId: 'msg-1',
    };
    const evaluate = vi.fn().mockResolvedValueOnce(evalResult);
    const ctx = makeCtx(evaluate);

    const result = await rollCheckTool.handler(
      { actorId: 'npc-1', checkType: 'perception', dc: 15, visibility: 'public' },
      ctx,
    );

    expect(evaluate).toHaveBeenCalledTimes(1);
    const text = result[0] as { type: 'text'; text: string };
    expect(JSON.parse(text.text)).toEqual(evalResult);
  });

  it('normalizes an omitted dc to null when calling the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      actor: { id: 'npc-1', name: 'Goblin', type: 'npc' },
      checkType: 'athletics',
      statisticSlug: 'athletics',
      modifier: 2,
      dc: null,
      total: 9,
      dieResult: 7,
      outcome: null,
      visibility: 'public',
      chatMessageId: 'msg-2',
    });
    const ctx = makeCtx(evaluate);

    await rollCheckTool.handler(
      { actorId: 'npc-1', checkType: 'athletics', visibility: 'public' },
      ctx,
    );

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      actorId: 'npc-1',
      checkType: 'athletics',
      dc: null,
      visibility: 'public',
    });
  });

  it('throws ToolError(INVALID_INPUT) when the evaluator rejects a PC actor', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: "Actor 'Kyra' is a player character.",
        details: { actorId: 'pc-1', reason: 'ACTOR_IS_PC' },
      },
    });
    const ctx = makeCtx(evaluate);

    const err = await rollCheckTool
      .handler({ actorId: 'pc-1', checkType: 'perception', visibility: 'public' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toMatchObject({ reason: 'ACTOR_IS_PC' });
  });

  it('rejects an unknown checkType via the input schema', () => {
    const parsed = rollCheckTool.inputSchema.safeParse({
      actorId: 'npc-1',
      checkType: 'vibes',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-positive dc via the input schema', () => {
    const parsed = rollCheckTool.inputSchema.safeParse({
      actorId: 'npc-1',
      checkType: 'will',
      dc: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults visibility to "public" when omitted', () => {
    const parsed = rollCheckTool.inputSchema.safeParse({
      actorId: 'npc-1',
      checkType: 'stealth',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.visibility).toBe('public');
  });
});
