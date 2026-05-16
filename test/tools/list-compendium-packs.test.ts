import { describe, expect, it, vi } from 'vitest';
import { listCompendiumPacksTool } from '../../src/tools/list-compendium-packs.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { ListCompendiumPacksResult } from '../../src/evaluators/list-compendium-packs.js';

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

describe('list_compendium_packs', () => {
  it('returns the evaluator packs as a single JSON text block', async () => {
    const mock: ListCompendiumPacksResult = {
      packs: [
        {
          id: 'pf2e.pathfinder-bestiary',
          label: 'Pathfinder Bestiary',
          system: 'pf2e',
          documentType: 'Actor',
        },
      ],
    };
    const evaluate = vi.fn().mockResolvedValue(mock);
    const ctx = makeCtx(evaluate);

    const blocks = await listCompendiumPacksTool.handler({}, ctx);

    expect(blocks).toHaveLength(1);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(mock);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toEqual({});
  });

  it('forwards documentType and system filters to the evaluator', async () => {
    const evaluate = vi.fn().mockResolvedValue({ packs: [] });
    const ctx = makeCtx(evaluate);

    await listCompendiumPacksTool.handler({ documentType: 'Actor', system: 'pf2e' }, ctx);

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      documentType: 'Actor',
      system: 'pf2e',
    });
  });

  it('omits absent filters rather than forwarding undefined', async () => {
    const evaluate = vi.fn().mockResolvedValue({ packs: [] });
    const ctx = makeCtx(evaluate);

    await listCompendiumPacksTool.handler({ documentType: 'Actor' }, ctx);

    expect(evaluate.mock.calls[0]?.[1]).toEqual({ documentType: 'Actor' });
  });

  it('rejects empty-string filter values', () => {
    expect(listCompendiumPacksTool.inputSchema.safeParse({ documentType: '' }).success).toBe(false);
    expect(listCompendiumPacksTool.inputSchema.safeParse({ system: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(listCompendiumPacksTool.inputSchema.safeParse({ extraField: 1 }).success).toBe(false);
  });

  it('accepts an empty input object', () => {
    expect(listCompendiumPacksTool.inputSchema.safeParse({}).success).toBe(true);
  });
});
