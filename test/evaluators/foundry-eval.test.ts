import { describe, expect, it } from 'vitest';
import { foundryEvalBody } from '../../src/evaluators/foundry-eval.js';

describe('foundryEvalBody', () => {
  it('returns ok with the value for a synchronous expression', async () => {
    const result = await foundryEvalBody('return 1 + 2;');
    expect(result).toEqual({ ok: true, value: 3 });
  });

  it('awaits async scripts', async () => {
    const result = await foundryEvalBody('return await Promise.resolve(42);');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('captures thrown errors as structured failures', async () => {
    const result = await foundryEvalBody('throw new TypeError("nope");');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('TypeError');
      expect(result.error.message).toBe('nope');
    }
  });
});
