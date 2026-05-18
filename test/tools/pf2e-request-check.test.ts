import { describe, expect, it, vi } from 'vitest';
import { pf2eRequestCheckTool } from '../../src/tools/pf2e-request-check.js';
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

describe('pf2e_request_check', () => {
  it('returns the evaluator result as a JSON content block on success', async () => {
    const evalResult = {
      ok: true,
      actor: { id: 'pc-1', name: 'Valeros' },
      checkType: 'perception',
      dc: 20,
      basic: false,
      checkExpression: '@Check[perception|dc:20|showDC:gm]',
      whisperedTo: [{ id: 'u-1', name: 'Player1' }],
      chatMessageId: 'msg-1',
    };
    const evaluate = vi.fn().mockResolvedValueOnce(evalResult);
    const ctx = makeCtx(evaluate);

    const result = await pf2eRequestCheckTool.handler(
      { actorId: 'pc-1', checkType: 'perception', dc: 20 },
      ctx,
    );

    expect(evaluate).toHaveBeenCalledTimes(1);
    const text = result[0] as { type: 'text'; text: string };
    expect(JSON.parse(text.text)).toEqual(evalResult);
  });

  it('normalizes omitted optional fields when calling the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      actor: { id: 'pc-1', name: 'Valeros' },
      checkType: 'stealth',
      dc: null,
      basic: false,
      checkExpression: '@Check[stealth|showDC:gm]',
      whisperedTo: [{ id: 'u-1', name: 'Player1' }],
      chatMessageId: 'msg-2',
    });
    const ctx = makeCtx(evaluate);

    await pf2eRequestCheckTool.handler({ actorId: 'pc-1', checkType: 'stealth' }, ctx);

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      actorId: 'pc-1',
      checkType: 'stealth',
      dc: null,
      basic: false,
      traits: [],
      showDcToPlayers: false,
    });
  });

  it('throws ToolError(INVALID_INPUT) when the evaluator rejects a non-PC actor', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: "Actor 'Goblin' is not a player character.",
        details: { actorId: 'npc-1', reason: 'ACTOR_NOT_A_PC' },
      },
    });
    const ctx = makeCtx(evaluate);

    const err = await pf2eRequestCheckTool
      .handler({ actorId: 'npc-1', checkType: 'perception' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toMatchObject({ reason: 'ACTOR_NOT_A_PC' });
  });

  it('rejects an unknown checkType via the input schema', () => {
    const parsed = pf2eRequestCheckTool.inputSchema.safeParse({
      actorId: 'pc-1',
      checkType: 'vibes',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty trait string via the input schema', () => {
    const parsed = pf2eRequestCheckTool.inputSchema.safeParse({
      actorId: 'pc-1',
      checkType: 'reflex',
      traits: [''],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a minimal valid input', () => {
    const parsed = pf2eRequestCheckTool.inputSchema.safeParse({
      actorId: 'pc-1',
      checkType: 'will',
    });
    expect(parsed.success).toBe(true);
  });
});
