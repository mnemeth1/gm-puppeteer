import { describe, expect, it, vi } from 'vitest';
import { viewSceneTool } from '../../src/tools/view-scene.js';
import { ToolError } from '../../src/errors.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { ViewSceneResult } from '../../src/evaluators/view-scene.js';

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

describe('view_scene', () => {
  it('returns the projected scene info on success', async () => {
    const mockResult: ViewSceneResult = {
      ok: true,
      sceneId: 'scene-abc',
      name: 'Forest Clearing',
      active: false,
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    };
    const evaluate = vi.fn().mockResolvedValue(mockResult);
    const ctx = makeCtx(evaluate);

    const blocks = await viewSceneTool.handler({ sceneId: 'scene-abc' }, ctx);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const parsed = JSON.parse((blocks[0] as { text: string }).text);
    expect(parsed).toEqual({
      sceneId: 'scene-abc',
      name: 'Forest Clearing',
      active: false,
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { type: 1, size: 100, distance: 5, units: 'ft' },
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('maps SCENE_NOT_FOUND to INVALID_INPUT', async () => {
    const mockResult: ViewSceneResult = {
      ok: false,
      error: {
        code: 'SCENE_NOT_FOUND',
        message: 'No scene with id "missing" in this world.',
        details: { sceneId: 'missing' },
      },
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const err = await viewSceneTool
      .handler({ sceneId: 'missing' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID_INPUT');
    expect((err as ToolError).details).toEqual({ sceneId: 'missing' });
  });

  it('maps CANVAS_REDRAW_TIMEOUT to EVAL_FAILED', async () => {
    const mockResult: ViewSceneResult = {
      ok: false,
      error: {
        code: 'CANVAS_REDRAW_TIMEOUT',
        message: 'timeout',
        details: { sceneId: 's', canvasSceneId: null },
      },
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const err = await viewSceneTool
      .handler({ sceneId: 's' }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('EVAL_FAILED');
  });

  it('maps VIEW_FAILED to EVAL_FAILED', async () => {
    const mockResult: ViewSceneResult = {
      ok: false,
      error: {
        code: 'VIEW_FAILED',
        message: 'boom',
        details: { sceneId: 's' },
      },
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const err = await viewSceneTool
      .handler({ sceneId: 's' }, ctx)
      .catch((e) => e as ToolError);

    expect((err as ToolError).code).toBe('EVAL_FAILED');
  });

  it('rejects missing sceneId', () => {
    const parsed = viewSceneTool.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects empty sceneId', () => {
    const parsed = viewSceneTool.inputSchema.safeParse({ sceneId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unexpected input keys', () => {
    const parsed = viewSceneTool.inputSchema.safeParse({
      sceneId: 'x',
      activate: true,
    });
    expect(parsed.success).toBe(false);
  });
});
