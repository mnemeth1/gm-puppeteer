import { describe, expect, it, vi } from 'vitest';
import { rollDiceTool } from '../../src/tools/roll-dice.js';
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

describe('roll_dice', () => {
  it('returns the evaluator result as a JSON content block on success', async () => {
    const evalResult = {
      ok: true,
      formula: '2d6+3',
      total: 11,
      result: '8 + 3',
      terms: [{ faces: 6, results: [4, 4] }],
      flavor: null,
      visibility: 'public',
      speaker: { actorId: null, alias: 'AI-GM' },
      chatMessageId: 'msg-1',
    };
    const evaluate = vi.fn().mockResolvedValueOnce(evalResult);
    const ctx = makeCtx(evaluate);

    const result = await rollDiceTool.handler({ formula: '2d6+3', visibility: 'public' }, ctx);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('text');
    const text = result[0] as { type: 'text'; text: string };
    expect(JSON.parse(text.text)).toEqual(evalResult);
  });

  it('normalizes omitted optional fields to null when calling the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      formula: '1d20',
      total: 14,
      result: '14',
      terms: [{ faces: 20, results: [14] }],
      flavor: null,
      visibility: 'public',
      speaker: { actorId: null, alias: 'AI-GM' },
      chatMessageId: 'msg-2',
    });
    const ctx = makeCtx(evaluate);

    await rollDiceTool.handler({ formula: '1d20', visibility: 'public' }, ctx);

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      formula: '1d20',
      flavor: null,
      speakerActorId: null,
      visibility: 'public',
    });
  });

  it('throws ToolError(INVALID_INPUT) when the evaluator reports failure', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: "Invalid dice formula '1d6 + '",
        details: { formula: '1d6 + ', reason: 'FORMULA_INVALID' },
      },
    });
    const ctx = makeCtx(evaluate);

    const err = await rollDiceTool
      .handler({ formula: '1d6 + ', visibility: 'public' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toMatchObject({ reason: 'FORMULA_INVALID' });
  });

  it('rejects an unknown formula via the input schema', () => {
    const parsed = rollDiceTool.inputSchema.safeParse({ formula: '' });
    expect(parsed.success).toBe(false);
  });

  it('defaults visibility to "public" when omitted', () => {
    const parsed = rollDiceTool.inputSchema.safeParse({ formula: '1d20' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.visibility).toBe('public');
  });

  it('rejects an unknown visibility value', () => {
    const parsed = rollDiceTool.inputSchema.safeParse({
      formula: '1d20',
      visibility: 'secret',
    });
    expect(parsed.success).toBe(false);
  });
});
