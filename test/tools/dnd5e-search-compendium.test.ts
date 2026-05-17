import { describe, expect, it, vi } from 'vitest';
import { dnd5eSearchCompendiumTool } from '../../src/tools/dnd5e-search-compendium.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { Dnd5eSearchCompendiumResult } from '../../src/evaluators/dnd5e-search-compendium.js';

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

describe('dnd5e_search_compendium', () => {
  it('forwards a name query with default limit, returns results as text content', async () => {
    const mock: Dnd5eSearchCompendiumResult = {
      query: 'goblin',
      total: 1,
      returned: 1,
      results: [
        {
          id: 'a',
          uuid: 'Compendium.dnd5e.monsters.Actor.a',
          name: 'Goblin',
          type: 'npc',
          pack: 'dnd5e.monsters',
          packLabel: 'Monsters (SRD)',
          img: null,
          cr: 0.25,
          spellLevel: null,
          creatureType: 'humanoid',
          rarity: null,
          source: 'SRD 5.1',
          folderPath: 'Humanoid',
        },
      ],
    };
    const evaluate = vi.fn().mockResolvedValue(mock);
    const ctx = makeCtx(evaluate);

    const blocks = await dnd5eSearchCompendiumTool.handler({ query: 'goblin' }, ctx);

    expect(blocks).toHaveLength(1);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(mock);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toEqual({ query: 'goblin', limit: 20 });
  });

  it('forwards every field and omits absent ones', async () => {
    const evaluate = vi.fn().mockResolvedValue({ total: 0, returned: 0, results: [] });
    const ctx = makeCtx(evaluate);

    await dnd5eSearchCompendiumTool.handler(
      {
        query: 'wolf',
        documentClass: 'Actor',
        types: ['npc'],
        filters: { cr: { min: 1, max: 5 }, size: ['lg'], habitat: ['forest'] },
        pack: 'dnd5e.monsters',
        packs: ['dnd5e.monsters', 'dnd5e.actors24'],
        folder: 'Premades',
        descriptionMatch: 'forest',
        limit: 10,
      },
      ctx,
    );

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      query: 'wolf',
      documentClass: 'Actor',
      types: ['npc'],
      filters: { cr: { min: 1, max: 5 }, size: ['lg'], habitat: ['forest'] },
      pack: 'dnd5e.monsters',
      packs: ['dnd5e.monsters', 'dnd5e.actors24'],
      folder: 'Premades',
      descriptionMatch: 'forest',
      limit: 10,
    });
  });

  it('drives a filter-only search by folder', async () => {
    const evaluate = vi.fn().mockResolvedValue({ total: 0, returned: 0, results: [] });
    const ctx = makeCtx(evaluate);

    await dnd5eSearchCompendiumTool.handler({ folder: 'Level 5' }, ctx);

    expect(evaluate.mock.calls[0]?.[1]).toEqual({ folder: 'Level 5', limit: 20 });
  });

  it('drives a filter-only search by types + filters (no query)', async () => {
    const evaluate = vi.fn().mockResolvedValue({ total: 0, returned: 0, results: [] });
    const ctx = makeCtx(evaluate);

    await dnd5eSearchCompendiumTool.handler(
      { types: ['npc'], filters: { cr: { min: 5, max: 5 }, type: ['dragon'] } },
      ctx,
    );

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      types: ['npc'],
      filters: { cr: { min: 5, max: 5 }, type: ['dragon'] },
      limit: 20,
    });
  });

  it('refuses an empty input without scanning packs', async () => {
    const evaluate = vi.fn();
    const ctx = makeCtx(evaluate);

    const blocks = await dnd5eSearchCompendiumTool.handler({}, ctx);

    expect(evaluate).not.toHaveBeenCalled();
    const parsed = JSON.parse((blocks[0] as { text: string }).text) as {
      ok?: boolean;
      error?: { code?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('NO_FILTERS');
  });

  it('refuses documentClass alone — it does not narrow enough to skip the guard', async () => {
    const evaluate = vi.fn();
    const ctx = makeCtx(evaluate);

    const blocks = await dnd5eSearchCompendiumTool.handler({ documentClass: 'Item' }, ctx);

    expect(evaluate).not.toHaveBeenCalled();
    const parsed = JSON.parse((blocks[0] as { text: string }).text) as {
      error?: { code?: string };
    };
    expect(parsed.error?.code).toBe('NO_FILTERS');
  });

  it('rejects an empty query string', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty folder string', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ folder: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty pack string', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ pack: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty packs array', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ packs: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty types array', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ types: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unsupported documentClass', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({
      query: 'x',
      documentClass: 'NotARealClass',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts every supported documentClass', () => {
    for (const documentClass of ['Item', 'Actor', 'JournalEntry', 'RollTable'] as const) {
      const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({
        query: 'x',
        documentClass,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts the three filter value shapes (range, set, boolean)', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({
      types: ['spell'],
      filters: {
        level: { min: 1, max: 3 },
        school: ['evo', 'abj'],
        properties: { include: ['ritual'], exclude: ['concentration'] },
        hasSpellcasting: true,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a fractional cr range filter', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({
      types: ['npc'],
      filters: { cr: { min: 0.125, max: 0.5 } },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a limit above the cap', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ query: 'x', limit: 1000 });
    expect(parsed.success).toBe(false);
  });

  it('rejects descriptionMatch shorter than 2 chars', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ descriptionMatch: 'a' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = dnd5eSearchCompendiumTool.inputSchema.safeParse({ query: 'x', extraField: 1 });
    expect(parsed.success).toBe(false);
  });
});
