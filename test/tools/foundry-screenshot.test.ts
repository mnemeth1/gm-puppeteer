import { describe, expect, it, vi } from 'vitest';
import { foundryScreenshotTool } from '../../src/tools/foundry-screenshot.js';
import { ToolError } from '../../src/errors.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';

const STUB_TRANSFORM = {
  transform: {
    stage: { position: { x: 0, y: 0 }, pivot: { x: 0, y: 0 }, scale: 1 },
    sceneDimensions: {
      sceneX: 200,
      sceneY: 150,
      sceneWidth: 1190,
      sceneHeight: 813,
      size: 50,
      distance: 5,
      width: 1590,
      height: 1113,
      rows: 23,
      columns: 32,
    },
    derived: { offsetX: 165, offsetY: -16.5, scale: 1 },
  },
};

function makeCtx(
  screenshot: ReturnType<typeof vi.fn>,
  evaluate: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(STUB_TRANSFORM),
): {
  browser: BrowserSession;
  log: Logger;
} {
  const page = { screenshot, evaluate };
  const browser = {
    ensureStarted: vi.fn().mockResolvedValue({ page }),
  };
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { browser: browser as unknown as BrowserSession, log: log as unknown as Logger };
}

const small = (n: number): string => 'A'.repeat(n);

function expectSidecar(
  block: { type: string; text?: string } | undefined,
  expectedClip: unknown,
): void {
  expect(block?.type).toBe('text');
  const parsed = JSON.parse(block?.text ?? '');
  expect(parsed).toEqual({ ...STUB_TRANSFORM, clip: expectedClip });
}

describe('foundry_screenshot', () => {
  it('defaults to JPEG at quality 80 when the payload fits', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(1000));
    const ctx = makeCtx(screenshot);

    const result = await foundryScreenshotTool.handler({}, ctx);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: small(1000) });
    expectSidecar(result[1], null);
    expect(screenshot).toHaveBeenCalledWith({
      type: 'jpeg',
      encoding: 'base64',
      fullPage: false,
      quality: 80,
    });
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('returns a PNG block when format: "png" is requested', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(500));
    const ctx = makeCtx(screenshot);

    const result = await foundryScreenshotTool.handler({ format: 'png' }, ctx);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'image', mimeType: 'image/png', data: small(500) });
    expectSidecar(result[1], null);
    expect(screenshot).toHaveBeenCalledWith({
      type: 'png',
      encoding: 'base64',
      fullPage: false,
    });
  });

  it('passes fullPage through when requested', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(100));
    const ctx = makeCtx(screenshot);

    await foundryScreenshotTool.handler({ fullPage: true }, ctx);

    expect(screenshot).toHaveBeenCalledWith({
      type: 'jpeg',
      encoding: 'base64',
      fullPage: true,
      quality: 80,
    });
  });

  it('passes a clip region through when provided', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(100));
    const ctx = makeCtx(screenshot);
    const clip = { x: 10, y: 20, width: 300, height: 400 };

    await foundryScreenshotTool.handler({ clip }, ctx);

    expect(screenshot).toHaveBeenCalledWith({
      type: 'jpeg',
      encoding: 'base64',
      fullPage: false,
      quality: 80,
      clip,
    });
  });

  it('steps down JPEG quality until the result fits under maxBytes', async () => {
    // First call (quality 80) returns 5000 bytes; next try (60) returns 2000;
    // third try would be 40 but should not be reached.
    const screenshot = vi
      .fn()
      .mockResolvedValueOnce(small(5000))
      .mockResolvedValueOnce(small(2000));
    const ctx = makeCtx(screenshot);

    const result = await foundryScreenshotTool.handler({ maxBytes: 3000 }, ctx);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: small(2000) });
    expectSidecar(result[1], null);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(screenshot.mock.calls[0]?.[0]).toMatchObject({ quality: 80 });
    expect(screenshot.mock.calls[1]?.[0]).toMatchObject({ quality: 60 });
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ initialQuality: 80, usedQuality: 60 }),
      'screenshot quality reduced to fit maxBytes',
    );
  });

  it('throws PAYLOAD_TOO_LARGE when even the lowest JPEG quality exceeds maxBytes', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(10_000));
    const ctx = makeCtx(screenshot);

    await expect(foundryScreenshotTool.handler({ maxBytes: 1000 }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('throws PAYLOAD_TOO_LARGE for PNG that exceeds maxBytes (no quality knob)', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(10_000));
    const ctx = makeCtx(screenshot);

    const err = await foundryScreenshotTool
      .handler({ format: 'png', maxBytes: 1000 }, ctx)
      .catch((e) => e as ToolError);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('PAYLOAD_TOO_LARGE');
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('uses the requested initial quality before falling back', async () => {
    const screenshot = vi.fn().mockResolvedValue(small(100));
    const ctx = makeCtx(screenshot);

    await foundryScreenshotTool.handler({ quality: 95 }, ctx);

    expect(screenshot.mock.calls[0]?.[0]).toMatchObject({ quality: 95 });
  });

  it('rejects fullPage and clip together at the schema layer', () => {
    const parsed = foundryScreenshotTool.inputSchema.safeParse({
      fullPage: true,
      clip: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects quality with format: png', () => {
    const parsed = foundryScreenshotTool.inputSchema.safeParse({
      format: 'png',
      quality: 80,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects negative clip coordinates', () => {
    const parsed = foundryScreenshotTool.inputSchema.safeParse({
      clip: { x: -1, y: 0, width: 100, height: 100 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects out-of-range quality', () => {
    expect(foundryScreenshotTool.inputSchema.safeParse({ quality: 10 }).success).toBe(false);
    expect(foundryScreenshotTool.inputSchema.safeParse({ quality: 101 }).success).toBe(false);
  });
});
