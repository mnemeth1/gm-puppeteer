import { describe, expect, it, vi } from 'vitest';
import { deleteTokenTool } from '../../src/tools/delete-token.js';
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

describe('delete_token recovery path', () => {
  it('recovers when CDP drops the response but tokens are actually gone', async () => {
    const evaluate = vi
      .fn()
      // First call: deleteTokenBody — throws CDP flake.
      .mockRejectedValueOnce(new Error('Protocol error (Runtime.callFunctionOn): Promise was collected'))
      // Second call: verifyTokensPresentBody — reports all absent.
      .mockResolvedValueOnce({
        ok: true,
        sceneId: 'scene-1',
        stillPresent: [],
        absent: ['tok-a', 'tok-b'],
      });
    const ctx = makeCtx(evaluate);

    const result = await deleteTokenTool.handler({ tokenIds: ['tok-a', 'tok-b'] }, ctx);

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('text');
    const text = result[0] as { type: 'text'; text: string };
    const payload = JSON.parse(text.text);
    expect(payload).toMatchObject({
      sceneId: 'scene-1',
      deleted: [
        { tokenId: 'tok-a', tokenName: '', actorId: null },
        { tokenId: 'tok-b', tokenName: '', actorId: null },
      ],
      notFound: [],
      recovered: true,
    });
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenIds: ['tok-a', 'tok-b'] }),
      'delete_token: Puppeteer Promise-collected flake; verifying scene state',
    );
  });

  it('throws EVAL_FAILED when CDP drops the response and tokens remain', async () => {
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Protocol error (Runtime.callFunctionOn): Promise was collected'))
      .mockResolvedValueOnce({
        ok: true,
        sceneId: 'scene-1',
        stillPresent: ['tok-a'],
        absent: ['tok-b'],
      });
    const ctx = makeCtx(evaluate);

    const err = await deleteTokenTool
      .handler({ tokenIds: ['tok-a', 'tok-b'] }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('EVAL_FAILED');
    expect((err as ToolError).details).toMatchObject({
      stillPresent: ['tok-a'],
      absent: ['tok-b'],
    });
  });

  it('passes through non-flake errors unchanged', async () => {
    const evaluate = vi.fn().mockRejectedValueOnce(new Error('something else broke'));
    const ctx = makeCtx(evaluate);

    await expect(deleteTokenTool.handler({ tokenIds: ['tok-a'] }, ctx)).rejects.toThrow(
      'something else broke',
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('happy path is untouched: returns deleted + notFound from evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      ok: true,
      sceneId: 'scene-1',
      deleted: [{ tokenId: 'tok-a', tokenName: 'Goblin', actorId: 'actor-1' }],
      notFound: ['tok-bogus'],
    });
    const ctx = makeCtx(evaluate);

    const result = await deleteTokenTool.handler(
      { tokenIds: ['tok-a', 'tok-bogus'] },
      ctx,
    );

    const text = result[0] as { type: 'text'; text: string };
    const payload = JSON.parse(text.text);
    expect(payload).toEqual({
      sceneId: 'scene-1',
      deleted: [{ tokenId: 'tok-a', tokenName: 'Goblin', actorId: 'actor-1' }],
      notFound: ['tok-bogus'],
    });
    // No `recovered` field in the happy path.
    expect(payload.recovered).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
