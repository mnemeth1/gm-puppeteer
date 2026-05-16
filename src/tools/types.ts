import type { z } from 'zod';
import type { BrowserSession } from '../browser/session.js';
import type { Logger } from '../logging.js';

export interface ToolContext {
  readonly browser: BrowserSession;
  readonly log: Logger;
}

/**
 * MCP content blocks returned by tools. Mirrors the subset of the MCP
 * spec's content types we currently produce — extend the union when
 * a tool legitimately needs another shape.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ToolDefinition<TInput extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  handler(input: z.infer<TInput>, ctx: ToolContext): Promise<ContentBlock[]>;
}

/** Wrap a JSON-serializable value in a single text content block. */
export function jsonText(value: unknown): ContentBlock {
  return { type: 'text', text: JSON.stringify(value) };
}
