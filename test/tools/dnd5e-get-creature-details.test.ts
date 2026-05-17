import { describe, expect, it, vi } from 'vitest';
import { dnd5eGetCreatureDetailsTool } from '../../src/tools/dnd5e-get-creature-details.js';
import type { BrowserSession } from '../../src/browser/session.js';
import type { Logger } from '../../src/logging.js';
import type { Dnd5eGetCreatureDetailsResult } from '../../src/evaluators/dnd5e-get-creature-details.js';

function makeCtx(evaluate: ReturnType<typeof vi.fn>): {
  browser: BrowserSession;
  log: Logger;
  warn: ReturnType<typeof vi.fn>;
} {
  const page = { evaluate };
  const browser = {
    ensureStarted: vi.fn().mockResolvedValue({ page }),
  };
  const warn = vi.fn();
  const log = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
  return {
    browser: browser as unknown as BrowserSession,
    log: log as unknown as Logger,
    warn,
  };
}

const okNpc: Dnd5eGetCreatureDetailsResult = {
  ok: true,
  uuid: 'Compendium.dnd5e.monsters.Actor.abc',
  id: 'abc',
  name: 'Goblin',
  type: 'npc',
  img: 'icon.webp',
  cr: 0.25,
  creatureType: { value: 'humanoid', subtype: 'Goblinoid', swarm: '' },
  size: 'sm',
  source: 'SRD 5.1',
  sourceUuid: null,
};

describe('dnd5e_get_creature_details', () => {
  it('forwards uuid with defaults and returns the result as text content', async () => {
    const evaluate = vi.fn().mockResolvedValue(okNpc);
    const ctx = makeCtx(evaluate);

    const blocks = await dnd5eGetCreatureDetailsTool.handler(
      { uuid: 'Compendium.dnd5e.monsters.Actor.abc' },
      ctx,
    );

    expect(blocks).toHaveLength(1);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(okNpc);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      uuid: 'Compendium.dnd5e.monsters.Actor.abc',
      descriptionFormat: 'both',
      includeEffects: false,
      includeRawSystem: false,
    });
  });

  it('forwards every explicitly-set field', async () => {
    const evaluate = vi.fn().mockResolvedValue(okNpc);
    const ctx = makeCtx(evaluate);

    await dnd5eGetCreatureDetailsTool.handler(
      {
        uuid: 'Actor.xyz',
        descriptionFormat: 'text',
        includeEffects: true,
        includeRawSystem: true,
      },
      ctx,
    );

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      uuid: 'Actor.xyz',
      descriptionFormat: 'text',
      includeEffects: true,
      includeRawSystem: true,
    });
  });

  it('throws INVALID_INPUT when the evaluator returns an error result', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'No actor found', details: { uuid: 'x' } },
    } satisfies Dnd5eGetCreatureDetailsResult);
    const ctx = makeCtx(evaluate);

    await expect(
      dnd5eGetCreatureDetailsTool.handler({ uuid: 'Actor.missing' }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'No actor found' });
  });

  it('warns when the result type falls outside the supported set', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ...okNpc, type: 'group' });
    const ctx = makeCtx(evaluate);

    await dnd5eGetCreatureDetailsTool.handler({ uuid: 'Actor.party' }, ctx);

    expect(ctx.warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a supported type', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ...okNpc, type: 'vehicle' });
    const ctx = makeCtx(evaluate);

    await dnd5eGetCreatureDetailsTool.handler({ uuid: 'Actor.ship' }, ctx);

    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it('rejects an empty uuid', () => {
    const parsed = dnd5eGetCreatureDetailsTool.inputSchema.safeParse({ uuid: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = dnd5eGetCreatureDetailsTool.inputSchema.safeParse({
      uuid: 'Actor.x',
      extraField: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a bad descriptionFormat', () => {
    const parsed = dnd5eGetCreatureDetailsTool.inputSchema.safeParse({
      uuid: 'Actor.x',
      descriptionFormat: 'markdown',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts every valid descriptionFormat', () => {
    for (const descriptionFormat of ['html', 'text', 'both'] as const) {
      const parsed = dnd5eGetCreatureDetailsTool.inputSchema.safeParse({
        uuid: 'Actor.x',
        descriptionFormat,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts the boolean opt-ins', () => {
    const parsed = dnd5eGetCreatureDetailsTool.inputSchema.safeParse({
      uuid: 'Actor.x',
      includeEffects: true,
      includeRawSystem: false,
    });
    expect(parsed.success).toBe(true);
  });
});
