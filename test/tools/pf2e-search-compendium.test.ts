import { describe, expect, it, vi } from 'vitest';
import { pf2eSearchCompendiumTool } from '../../src/tools/pf2e-search-compendium.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { Pf2eSearchCompendiumResult } from '../../src/evaluators/pf2e-search-compendium.js';

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

describe('pf2e_search_compendium', () => {
  it('forwards a name query with default limit, returns results as text content', async () => {
    const mock: Pf2eSearchCompendiumResult = {
      query: 'goblin',
      total: 1,
      returned: 1,
      results: [
        {
          id: 'a',
          uuid: 'Compendium.pf2e.x.Actor.a',
          name: 'Goblin Warrior',
          type: 'npc',
          pack: 'pf2e.x',
          packLabel: 'X',
          img: null,
          level: 1,
          traits: ['goblin', 'humanoid'],
          rarity: 'common',
          source: 'Pathfinder Bestiary',
        },
      ],
    };
    const evaluate = vi.fn().mockResolvedValue(mock);
    const ctx = makeCtx(evaluate);

    const blocks = await pf2eSearchCompendiumTool.handler({ query: 'goblin' }, ctx);

    expect(blocks).toHaveLength(1);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(mock);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toEqual({ query: 'goblin', limit: 20 });
  });

  it('forwards every filter and omits absent ones', async () => {
    const evaluate = vi.fn().mockResolvedValue({ total: 0, returned: 0, results: [] });
    const ctx = makeCtx(evaluate);

    await pf2eSearchCompendiumTool.handler(
      {
        query: 'wolf',
        pack: 'pf2e.pathfinder-bestiary',
        packs: ['pf2e.pathfinder-bestiary', 'pf2e.pathfinder-monster-core'],
        type: 'Actor',
        level: { min: 2, max: 8 },
        traits: ['animal', 'beast'],
        rarity: 'common',
        source: ['Bestiary'],
        actorType: 'npc',
        descriptionMatch: 'forest',
        limit: 10,
      },
      ctx,
    );

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      query: 'wolf',
      pack: 'pf2e.pathfinder-bestiary',
      packs: ['pf2e.pathfinder-bestiary', 'pf2e.pathfinder-monster-core'],
      type: 'Actor',
      level: { min: 2, max: 8 },
      traits: ['animal', 'beast'],
      rarity: 'common',
      source: ['Bestiary'],
      actorType: 'npc',
      descriptionMatch: 'forest',
      limit: 10,
    });
  });

  it('drives a filter-only search (no query)', async () => {
    const evaluate = vi.fn().mockResolvedValue({ total: 0, returned: 0, results: [] });
    const ctx = makeCtx(evaluate);

    await pf2eSearchCompendiumTool.handler(
      { actorType: 'npc', level: { min: 5, max: 5 }, traits: ['dragon'] },
      ctx,
    );

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      actorType: 'npc',
      level: { min: 5, max: 5 },
      traits: ['dragon'],
      limit: 20,
    });
  });

  it('refuses an empty input without scanning packs', async () => {
    const evaluate = vi.fn();
    const ctx = makeCtx(evaluate);

    const blocks = await pf2eSearchCompendiumTool.handler({}, ctx);

    expect(evaluate).not.toHaveBeenCalled();
    const parsed = JSON.parse((blocks[0] as { text: string }).text) as {
      ok?: boolean;
      error?: { code?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('NO_FILTERS');
  });

  it('rejects an empty query string', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unsupported document type', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({
      query: 'x',
      type: 'NotARealType',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unsupported actorType', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({ actorType: 'monster' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unsupported rarity', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({
      query: 'x',
      rarity: 'legendary',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit above the cap', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({ query: 'x', limit: 1000 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty traits array', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({ traits: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects descriptionMatch shorter than 2 chars', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({ descriptionMatch: 'a' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = pf2eSearchCompendiumTool.inputSchema.safeParse({ query: 'x', extraField: 1 });
    expect(parsed.success).toBe(false);
  });
});
