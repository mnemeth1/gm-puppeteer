import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dismissHwAccelWarningBody } from '../../src/evaluators/dismiss-hw-accel-warning.js';

interface FakeNode {
  textContent: string;
  remove: () => void;
}

/**
 * The evaluator body is designed to run inside the browser via
 * `page.evaluate`, but it only touches `document.querySelectorAll` and
 * `node.textContent` / `node.remove`. We stub document minimally rather
 * than pull jsdom in for one test file.
 */
describe('dismissHwAccelWarningBody', () => {
  const HW = 'Your web browser does not have hardware acceleration enabled.';
  const NON_HW = 'Welcome back, Gamemaster.';

  let nodes: FakeNode[] = [];

  beforeEach(() => {
    nodes = [];
    (globalThis as { document?: unknown }).document = {
      querySelectorAll: (_sel: string) => nodes,
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  const seed = (texts: string[]): void => {
    nodes = texts.map((text) => ({
      textContent: text,
      remove() {
        const idx = nodes.indexOf(this as unknown as FakeNode);
        if (idx >= 0) nodes.splice(idx, 1);
      },
    }));
  };

  it('returns removed=0 when no notification root exists', () => {
    expect(dismissHwAccelWarningBody()).toEqual({ removed: 0 });
  });

  it('removes only the HW-accel <li>, leaving others intact', () => {
    seed([HW, NON_HW]);

    const result = dismissHwAccelWarningBody();

    expect(result.removed).toBe(1);
    expect(nodes.map((n) => n.textContent)).toEqual([NON_HW]);
  });

  it('is idempotent: a second call with nothing matching is a no-op', () => {
    seed([NON_HW]);

    const result = dismissHwAccelWarningBody();

    expect(result.removed).toBe(0);
    expect(nodes).toHaveLength(1);
  });

  it('matches case-insensitively and tolerates extra whitespace', () => {
    seed(['  Your Browser Does Not Have HARDWARE   acceleration enabled  ']);

    expect(dismissHwAccelWarningBody().removed).toBe(1);
    expect(nodes).toHaveLength(0);
  });

  it('never throws when document is missing', () => {
    delete (globalThis as { document?: unknown }).document;
    expect(() => dismissHwAccelWarningBody()).not.toThrow();
    expect(dismissHwAccelWarningBody()).toEqual({ removed: 0 });
  });

  it('never throws when querySelectorAll itself throws', () => {
    (globalThis as { document?: unknown }).document = {
      querySelectorAll: () => {
        throw new Error('boom');
      },
    };
    expect(() => dismissHwAccelWarningBody()).not.toThrow();
  });
});
