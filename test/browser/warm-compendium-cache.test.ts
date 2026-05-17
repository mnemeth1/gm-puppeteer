import { describe, expect, it } from 'vitest';
import {
  selectWarmPacks,
  type WarmPackInfo,
} from '../../src/browser/warm-compendium-cache.js';

const pack = (collection: string, documentType: string, size: number): WarmPackInfo => ({
  collection,
  documentType,
  size,
});

describe('selectWarmPacks — auto mode', () => {
  it('orders by document-type priority: JournalEntry → Actor → Item → RollTable', () => {
    const inv = [
      pack('w.items', 'Item', 10),
      pack('w.tables', 'RollTable', 10),
      pack('w.actors', 'Actor', 10),
      pack('w.journals', 'JournalEntry', 10),
    ];
    const sel = selectWarmPacks(inv, { budget: 1000, override: [] });
    expect(sel.mode).toBe('auto');
    expect(sel.collections).toEqual(['w.journals', 'w.actors', 'w.items', 'w.tables']);
    expect(sel.cumulativeDocs).toBe(40);
  });

  it('orders smallest pack first within a document type', () => {
    const inv = [
      pack('w.big', 'Actor', 500),
      pack('w.small', 'Actor', 10),
      pack('w.mid', 'Actor', 100),
    ];
    const sel = selectWarmPacks(inv, { budget: 10_000, override: [] });
    expect(sel.collections).toEqual(['w.small', 'w.mid', 'w.big']);
  });

  it('skips over-budget packs but still admits later packs that fit', () => {
    const inv = [
      pack('w.journals', 'JournalEntry', 100),
      pack('w.actors', 'Actor', 5000),
      pack('w.tables', 'RollTable', 50),
    ];
    const sel = selectWarmPacks(inv, { budget: 200, override: [] });
    // journals (100) fits; actors (5000) overflows; tables (50) still fits.
    expect(sel.collections).toEqual(['w.journals', 'w.tables']);
    expect(sel.cumulativeDocs).toBe(150);
    const actors = sel.decisions.find((d) => d.collection === 'w.actors');
    expect(actors).toMatchObject({ admitted: false, reason: 'over-budget' });
  });

  it('admits nothing when the budget is 0', () => {
    const inv = [pack('w.journals', 'JournalEntry', 100), pack('w.actors', 'Actor', 50)];
    const sel = selectWarmPacks(inv, { budget: 0, override: [] });
    expect(sel.collections).toEqual([]);
    expect(sel.cumulativeDocs).toBe(0);
  });

  it('ignores document types that are not warm-relevant', () => {
    const inv = [
      pack('w.macros', 'Macro', 10),
      pack('w.scenes', 'Scene', 10),
      pack('w.actors', 'Actor', 10),
    ];
    const sel = selectWarmPacks(inv, { budget: 1000, override: [] });
    expect(sel.collections).toEqual(['w.actors']);
    expect(sel.decisions.map((d) => d.collection)).toEqual(['w.actors']);
  });

  it('skips empty packs with an "empty" reason', () => {
    const inv = [pack('w.empty', 'Actor', 0), pack('w.full', 'Actor', 5)];
    const sel = selectWarmPacks(inv, { budget: 1000, override: [] });
    expect(sel.collections).toEqual(['w.full']);
    expect(sel.decisions.find((d) => d.collection === 'w.empty')).toMatchObject({
      admitted: false,
      reason: 'empty',
    });
  });
});

describe('selectWarmPacks — override mode', () => {
  it('warms exactly the override list, in order, ignoring the budget', () => {
    const inv = [
      pack('w.actors', 'Actor', 9000),
      pack('w.items', 'Item', 9000),
      pack('w.journals', 'JournalEntry', 9000),
    ];
    const sel = selectWarmPacks(inv, { budget: 10, override: ['w.items', 'w.actors'] });
    expect(sel.mode).toBe('override');
    expect(sel.collections).toEqual(['w.items', 'w.actors']);
    expect(sel.cumulativeDocs).toBe(18_000);
  });

  it('records override ids that are not installed and omits them from the warm list', () => {
    const inv = [pack('w.actors', 'Actor', 100)];
    const sel = selectWarmPacks(inv, {
      budget: 4000,
      override: ['w.actors', 'pf2e.does-not-exist'],
    });
    expect(sel.collections).toEqual(['w.actors']);
    const missing = sel.decisions.find((d) => d.collection === 'pf2e.does-not-exist');
    expect(missing).toMatchObject({ admitted: false, reason: 'not-installed' });
  });
});
