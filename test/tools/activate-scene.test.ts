import { describe, expect, it, vi } from 'vitest';
import { activateSceneTool } from '../../src/tools/activate-scene.js';
import { ToolError } from '../../src/errors.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { ActivateSceneResult } from '../../src/evaluators/activate-scene.js';

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

describe('activate_scene', () => {
  it('returns the activated scene info on success', async () => {
    const mockResult: ActivateSceneResult = {
      ok: true,
      sceneId: 'scene-abc',
      name: 'Tavern Cellar',
      active: true,
      noop: false,
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    };
    const evaluate = vi.fn().mockResolvedValue(mockResult);
    const ctx = makeCtx(evaluate);

    const blocks = await activateSceneTool.handler({ sceneId: 'scene-abc' }, ctx);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const parsed = JSON.parse((blocks[0] as { text: string }).text);
    expect(parsed).toEqual({
      sceneId: 'scene-abc',
      name: 'Tavern Cellar',
      active: true,
      noop: false,
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('passes through noop: true unchanged', async () => {
    const mockResult: ActivateSceneResult = {
      ok: true,
      sceneId: 'scene-abc',
      name: 'Tavern Cellar',
      active: true,
      noop: true,
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const blocks = await activateSceneTool.handler({ sceneId: 'scene-abc' }, ctx);

    const parsed = JSON.parse((blocks[0] as { text: string }).text);
    expect(parsed.noop).toBe(true);
    expect(parsed.active).toBe(true);
  });

  it('maps SCENE_NOT_FOUND to INVALID_INPUT', async () => {
    const mockResult: ActivateSceneResult = {
      ok: false,
      error: {
        code: 'SCENE_NOT_FOUND',
        message: 'No scene with id "missing" in this world.',
        details: { sceneId: 'missing' },
      },
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const err = await activateSceneTool
      .handler({ sceneId: 'missing' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toEqual({ sceneId: 'missing' });
  });

  it('maps ACTIVATE_FAILED to EVAL_FAILED', async () => {
    const mockResult: ActivateSceneResult = {
      ok: false,
      error: {
        code: 'ACTIVATE_FAILED',
        message: 'boom',
        details: { sceneId: 's', activeAfter: null },
      },
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const err = await activateSceneTool.handler({ sceneId: 's' }, ctx).catch((e) => e as ToolError);

    expect((err as ToolError).code).toBe('EVAL_FAILED');
  });

  it('rejects missing sceneId', () => {
    const parsed = activateSceneTool.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects empty sceneId', () => {
    const parsed = activateSceneTool.inputSchema.safeParse({ sceneId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unexpected input keys', () => {
    const parsed = activateSceneTool.inputSchema.safeParse({
      sceneId: 'x',
      broadcast: true,
    });
    expect(parsed.success).toBe(false);
  });
});
