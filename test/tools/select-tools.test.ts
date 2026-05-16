import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { selectTools, tools } from '../../src/tools/index.js';

describe('selectTools', () => {
  it('excludes foundry_eval when allowEval is false', () => {
    const active = selectTools(loadConfig({}));
    expect(active.some((t) => t.name === 'foundry_eval')).toBe(false);
    expect(active).toHaveLength(tools.length - 1);
    // Every other tool is still present.
    for (const t of tools) {
      if (t.name === 'foundry_eval') continue;
      expect(active).toContain(t);
    }
  });

  it('includes the full registry when allowEval is true', () => {
    const active = selectTools(loadConfig({ ALLOW_EVAL: 'true' }));
    expect(active.some((t) => t.name === 'foundry_eval')).toBe(true);
    expect(active).toHaveLength(tools.length);
  });
});
