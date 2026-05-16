import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  foundryScreenshotTransformBody,
  type ScreenshotTransformResult,
} from '../evaluators/foundry-screenshot-transform.js';
import { jsonText, type ContentBlock, type ToolDefinition } from './types.js';

const ClipSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const FormatSchema = z.enum(['jpeg', 'png']);

/**
 * Default base64-string size cap. MCP result envelopes are commonly
 * limited to ~1 MB, so we leave headroom for JSON framing and any
 * other content blocks in the same response.
 */
const DEFAULT_MAX_BYTES = 900_000;

/** Quality fallbacks used when the initial JPEG quality blows past maxBytes. */
const QUALITY_FALLBACKS = [80, 60, 40, 25, 20] as const;
const MIN_JPEG_QUALITY = 20;

const FoundryScreenshotInput = z
  .object({
    fullPage: z
      .boolean()
      .optional()
      .describe('Capture the full scrollable page instead of just the viewport. Default false.'),
    clip: ClipSchema.optional().describe(
      'Optional pixel-space region to crop. Mutually exclusive with fullPage.',
    ),
    format: FormatSchema.optional().describe(
      'Image format. "jpeg" (default) is much smaller and fine for diagnostics; ' +
        '"png" is lossless but typically 5-10x larger and may not fit the MCP result cap.',
    ),
    quality: z
      .number()
      .int()
      .min(MIN_JPEG_QUALITY)
      .max(100)
      .optional()
      .describe('JPEG quality 20-100. Default 80. Ignored when format is "png".'),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Cap on the returned base64-string length. Default ${DEFAULT_MAX_BYTES}. ` +
          'For JPEG, quality is automatically reduced (down to 20) until the result fits; ' +
          'a PNG that exceeds the cap fails with PAYLOAD_TOO_LARGE.',
      ),
  })
  .strict()
  .refine((v) => !(v.fullPage === true && v.clip !== undefined), {
    message: 'fullPage and clip cannot be used together',
    path: ['fullPage'],
  })
  .refine((v) => !(v.format === 'png' && v.quality !== undefined), {
    message: 'quality is only valid when format is "jpeg"',
    path: ['quality'],
  });

export const foundryScreenshotTool: ToolDefinition<typeof FoundryScreenshotInput> = {
  name: 'foundry_screenshot',
  description:
    'Capture the current Foundry GM client view and return it as an MCP image content block ' +
    `(no disk writes). Default output is JPEG at quality 80, capped at ${DEFAULT_MAX_BYTES} base64 ` +
    'chars to stay under the ~1 MB MCP result limit common to MCP clients; quality is automatically reduced ' +
    'if needed. Pass `format: "png"` for a lossless capture (typically 5-10x larger — use `clip` ' +
    'to crop). Use `fullPage: true` for the entire scrollable page or `clip` for a specific region; ' +
    'the two are mutually exclusive. Returns TWO content blocks: an image block plus a JSON text ' +
    'block carrying the page-pixel ↔ scene-canvas-pixel transform — ' +
    '`{transform: {stage, sceneDimensions, derived: {offsetX, offsetY, scale}}, clip}` — so a ' +
    'caller can convert a screenshot pixel to a scene canvas coord via ' +
    '`canvas = (screen - offset) / scale` (or the inverse). When the canvas is not ready ' +
    '(no active scene), the text block carries `{transform: null, reason}` and the image block ' +
    'is still returned.',
  inputSchema: FoundryScreenshotInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const format = input.format ?? 'jpeg';
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const fullPage = input.fullPage ?? false;

    const capture = (quality: number | undefined): Promise<string> =>
      page.screenshot({
        type: format,
        encoding: 'base64',
        fullPage,
        ...(input.clip !== undefined ? { clip: input.clip } : {}),
        ...(format === 'jpeg' && quality !== undefined ? { quality } : {}),
      }) as Promise<string>;

    const captureTransform = async (): Promise<ScreenshotTransformResult> => {
      try {
        return (await page.evaluate(foundryScreenshotTransformBody)) as ScreenshotTransformResult;
      } catch (err) {
        ctx.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'transform extraction failed; returning null sidecar',
        );
        return { transform: null, reason: 'CANVAS_NOT_READY' };
      }
    };

    const buildSidecar = (transform: ScreenshotTransformResult): ContentBlock =>
      jsonText({ ...transform, clip: input.clip ?? null });

    if (format === 'png') {
      const data = await capture(undefined);
      if (data.length > maxBytes) {
        throw new ToolError(
          'PAYLOAD_TOO_LARGE',
          `PNG screenshot is ${data.length} base64 bytes, exceeds maxBytes ${maxBytes}. ` +
            'Pass format: "jpeg", supply a smaller `clip` region, or raise maxBytes.',
          { bytes: data.length, maxBytes, format },
        );
      }
      const transform = await captureTransform();
      return [pngBlock(data), buildSidecar(transform)];
    }

    // JPEG: try the requested (or default) quality, then step down through
    // the fallback ladder until the result fits or we exhaust the floor.
    const initial = input.quality ?? QUALITY_FALLBACKS[0];
    const stops = uniqueDescending([initial, ...QUALITY_FALLBACKS]).filter(
      (q) => q >= MIN_JPEG_QUALITY,
    );

    let lastData = '';
    let lastQuality = initial;
    for (const quality of stops) {
      const data = await capture(quality);
      lastData = data;
      lastQuality = quality;
      if (data.length <= maxBytes) {
        if (quality !== initial) {
          ctx.log.info(
            { initialQuality: initial, usedQuality: quality, bytes: data.length, maxBytes },
            'screenshot quality reduced to fit maxBytes',
          );
        }
        const transform = await captureTransform();
        return [jpegBlock(data), buildSidecar(transform)];
      }
    }

    throw new ToolError(
      'PAYLOAD_TOO_LARGE',
      `JPEG screenshot is ${lastData.length} base64 bytes at quality ${lastQuality} (the floor), ` +
        `still exceeds maxBytes ${maxBytes}. Supply a smaller \`clip\` region or raise maxBytes.`,
      { bytes: lastData.length, quality: lastQuality, maxBytes, format },
    );
  },
};

function pngBlock(data: string): ContentBlock {
  return { type: 'image', mimeType: 'image/png', data };
}

function jpegBlock(data: string): ContentBlock {
  return { type: 'image', mimeType: 'image/jpeg', data };
}

function uniqueDescending(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => b - a);
}
