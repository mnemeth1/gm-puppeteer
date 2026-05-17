import { describe, expect, it, vi } from 'vitest';
import { dnd5eSearchRulesTool } from '../../src/tools/dnd5e-search-rules.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { Dnd5eSearchRulesResult } from '../../src/evaluators/dnd5e-search-rules.js';

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

const okResult: Dnd5eSearchRulesResult = {
  ok: true,
  query: 'grappled',
  hitCount: 1,
  scannedPacks: 3,
  scannedEntries: 47,
  scannedPages: 600,
  truncated: false,
  hits: [
    {
      pack: 'dnd-players-handbook.content',
      packLabel: "Player's Handbook",
      entryId: 'phbAppendixCRule',
      entryName: 'Appendix C: Rules Glossary',
      entryUuid: 'Compendium.dnd-players-handbook.content.JournalEntry.phbAppendixCRule',
      pageId: 'KbQ1k0OIowtZeQgp',
      pageName: 'Grappled',
      pageUuid:
        'Compendium.dnd-players-handbook.content.JournalEntry.phbAppendixCRule.JournalEntryPage.KbQ1k0OIowtZeQgp',
      pageType: 'rule',
      matchField: 'page.name',
      snippet: 'While you have the Grappled condition…',
      pageText: 'While you have the Grappled condition, you experience the following effects.',
    },
  ],
};

describe('dnd5e_search_rules', () => {
  it('forwards the query and returns the result as text content', async () => {
    const evaluate = vi.fn().mockResolvedValue(okResult);
    const ctx = makeCtx(evaluate);

    const blocks = await dnd5eSearchRulesTool.handler({ query: 'grappled' }, ctx);

    expect(blocks).toHaveLength(1);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(okResult);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ query: 'grappled' });
  });

  it('forwards every optional filter', async () => {
    const evaluate = vi.fn().mockResolvedValue(okResult);
    const ctx = makeCtx(evaluate);

    await dnd5eSearchRulesTool.handler(
      {
        query: 'grappled',
        packs: ['dnd5e.content24'],
        pageTypes: ['rule'],
        limit: 10,
        snippetLength: 400,
      },
      ctx,
    );

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      query: 'grappled',
      packs: ['dnd5e.content24'],
      pageTypes: ['rule'],
      limit: 10,
      snippetLength: 400,
    });
  });

  it('throws a ToolError when the evaluator reports !ok', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Query must be a non-empty string.' },
    } satisfies Dnd5eSearchRulesResult);
    const ctx = makeCtx(evaluate);

    await expect(dnd5eSearchRulesTool.handler({ query: 'x' }, ctx)).rejects.toThrow(
      'Query must be a non-empty string.',
    );
  });

  it('rejects a missing query', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty query string', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a query-only search', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'grappled' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty packs array', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', packs: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty pageTypes array', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', pageTypes: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit above the cap', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', limit: 101 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit below 1', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', limit: 0 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a snippetLength below the floor', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', snippetLength: 39 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a snippetLength above the cap', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', snippetLength: 2001 });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = dnd5eSearchRulesTool.inputSchema.safeParse({ query: 'x', extraField: 1 });
    expect(parsed.success).toBe(false);
  });
});
