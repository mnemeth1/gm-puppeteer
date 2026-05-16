import { describe, expect, it } from 'vitest';
import { resources } from '../src/resources.js';

describe('resources registry', () => {
  it('exposes at least one resource', () => {
    expect(resources.length).toBeGreaterThan(0);
  });

  it('every resource has unique URI and non-empty fields', () => {
    const uris = new Set<string>();
    for (const r of resources) {
      expect(r.uri).toMatch(/^gm-puppeteer:\/\//);
      expect(uris.has(r.uri)).toBe(false);
      uris.add(r.uri);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.mimeType.length).toBeGreaterThan(0);
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it('the scope reference points AI clients at Archives of Nethys for rules text', () => {
    const scope = resources.find((r) => r.uri === 'gm-puppeteer://reference/scope');
    expect(scope).toBeDefined();
    expect(scope?.text).toContain('2e.aonprd.com');
  });
});
