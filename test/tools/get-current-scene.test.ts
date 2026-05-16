import { describe, expect, it, vi } from 'vitest';
import { getCurrentSceneTool } from '../../src/tools/get-current-scene.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { GetCurrentSceneResult } from '../../src/evaluators/get-current-scene.js';

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

describe('get_current_scene', () => {
  it('returns the scene info as a text content block', async () => {
    const mockResult: GetCurrentSceneResult = {
      scene: {
        id: 'abc123',
        name: 'Test Scene',
        active: true,
        width: 4000,
        height: 3000,
        padding: 0.25,
        backgroundImage: 'worlds/test/scene.webp',
        foregroundImage: null,
        grid: { type: 1, size: 100, distance: 5, units: 'ft' },
        counts: {
          walls: 12,
          tokens: 3,
          lights: 4,
          sounds: 0,
          drawings: 0,
          templates: 0,
          notes: 1,
          regions: 0,
        },
      },
    };
    const evaluate = vi.fn().mockResolvedValue(mockResult);
    const ctx = makeCtx(evaluate);

    const blocks = await getCurrentSceneTool.handler({}, ctx);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const parsed = JSON.parse((blocks[0] as { text: string }).text);
    expect(parsed).toEqual(mockResult);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('passes through the "no active scene" sentinel', async () => {
    const mockResult: GetCurrentSceneResult = {
      scene: null,
      reason: 'No scene is set as active in this world.',
    };
    const ctx = makeCtx(vi.fn().mockResolvedValue(mockResult));

    const blocks = await getCurrentSceneTool.handler({}, ctx);

    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(mockResult);
  });

  it('rejects unexpected input keys', () => {
    const parsed = getCurrentSceneTool.inputSchema.safeParse({ unknown: true });
    expect(parsed.success).toBe(false);
  });
});
