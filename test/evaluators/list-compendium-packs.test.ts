import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCompendiumPacksBody } from '../../src/evaluators/list-compendium-packs.js';

/**
 * The evaluator body is designed to run inside the browser via
 * `page.evaluate`. The only global it touches is `game.packs`. We stub it
 * directly on `globalThis` per test rather than pull in jsdom.
 *
 * The live-Foundry probe (scripts/probe-list-compendium-packs.mjs) has
 * already verified that the real CompendiumCollection objects expose
 * `collection`, `documentName`, `metadata.label`, `metadata.packageName`,
 * and `title` — these tests verify our projection logic and filter /
 * sort behavior against synthetic packs.
 */

interface PackLike {
  collection?: unknown;
  documentName?: unknown;
  metadata?: { label?: unknown; packageName?: unknown } | null;
  title?: unknown;
}

function setPacks(packs: PackLike[]): void {
  (globalThis as unknown as { game: { packs: Iterable<PackLike> } }).game = {
    packs,
  };
}

beforeEach(() => {
  (globalThis as unknown as { game?: unknown }).game = undefined;
});

afterEach(() => {
  (globalThis as unknown as { game?: unknown }).game = undefined;
});

describe('listCompendiumPacksBody', () => {
  it('projects {id, label, system, documentType} from a typical PF2e pack', () => {
    setPacks([
      {
        collection: 'pf2e.pathfinder-bestiary',
        documentName: 'Actor',
        metadata: { label: 'Pathfinder Bestiary', packageName: 'pf2e' },
        title: 'Pathfinder Bestiary',
      },
    ]);

    const result = listCompendiumPacksBody({});

    expect(result.packs).toEqual([
      {
        id: 'pf2e.pathfinder-bestiary',
        label: 'Pathfinder Bestiary',
        system: 'pf2e',
        documentType: 'Actor',
      },
    ]);
  });

  it('falls back through the label cascade: metadata.label → title → id', () => {
    setPacks([
      {
        collection: 'pf2e.has-meta-label',
        documentName: 'Item',
        metadata: { label: 'Meta Label Wins', packageName: 'pf2e' },
        title: 'Title Loses',
      },
      {
        collection: 'pf2e.has-title-only',
        documentName: 'Item',
        metadata: { packageName: 'pf2e' },
        title: 'Title Used',
      },
      {
        collection: 'pf2e.id-only',
        documentName: 'Item',
        metadata: null,
      },
    ]);

    const labelsById = Object.fromEntries(
      listCompendiumPacksBody({}).packs.map((p) => [p.id, p.label]),
    );

    expect(labelsById['pf2e.has-meta-label']).toBe('Meta Label Wins');
    expect(labelsById['pf2e.has-title-only']).toBe('Title Used');
    expect(labelsById['pf2e.id-only']).toBe('pf2e.id-only');
  });

  it('treats empty-string label / title as absent in the cascade', () => {
    setPacks([
      {
        collection: 'pf2e.empty-label',
        documentName: 'Item',
        metadata: { label: '', packageName: 'pf2e' },
        title: 'Title Used',
      },
      {
        collection: 'pf2e.both-empty',
        documentName: 'Item',
        metadata: { label: '', packageName: 'pf2e' },
        title: '',
      },
    ]);

    const labelsById = Object.fromEntries(
      listCompendiumPacksBody({}).packs.map((p) => [p.id, p.label]),
    );

    expect(labelsById['pf2e.empty-label']).toBe('Title Used');
    expect(labelsById['pf2e.both-empty']).toBe('pf2e.both-empty');
  });

  it("prefers metadata.packageName for system; falls back to the id's prefix", () => {
    setPacks([
      {
        collection: 'pf2e-bestiary-tokens.something',
        documentName: 'Actor',
        metadata: { label: 'A', packageName: 'pf2e-bestiary-tokens' },
      },
      {
        collection: 'someworld.world-actors',
        documentName: 'Actor',
        metadata: { label: 'B' },
      },
      {
        collection: 'no-dot-id',
        documentName: 'Actor',
        metadata: { label: 'C' },
      },
    ]);

    const systemsById = Object.fromEntries(
      listCompendiumPacksBody({}).packs.map((p) => [p.id, p.system]),
    );

    expect(systemsById['pf2e-bestiary-tokens.something']).toBe('pf2e-bestiary-tokens');
    expect(systemsById['someworld.world-actors']).toBe('someworld');
    expect(systemsById['no-dot-id']).toBe('no-dot-id');
  });

  it('filters by documentType (exact match)', () => {
    setPacks([
      {
        collection: 'pf2e.a',
        documentName: 'Actor',
        metadata: { label: 'A', packageName: 'pf2e' },
      },
      {
        collection: 'pf2e.b',
        documentName: 'Item',
        metadata: { label: 'B', packageName: 'pf2e' },
      },
      {
        collection: 'pf2e.c',
        documentName: 'RollTable',
        metadata: { label: 'C', packageName: 'pf2e' },
      },
    ]);

    const ids = listCompendiumPacksBody({ documentType: 'Actor' }).packs.map((p) => p.id);
    expect(ids).toEqual(['pf2e.a']);
  });

  it('filters by system (exact match) — including module packs', () => {
    setPacks([
      {
        collection: 'pf2e.a',
        documentName: 'Actor',
        metadata: { label: 'A', packageName: 'pf2e' },
      },
      {
        collection: 'pf2e-bestiary-tokens.x',
        documentName: 'Actor',
        metadata: { label: 'Z', packageName: 'pf2e-bestiary-tokens' },
      },
      {
        collection: 'pf2e.b',
        documentName: 'Item',
        metadata: { label: 'B', packageName: 'pf2e' },
      },
    ]);

    const ids = listCompendiumPacksBody({ system: 'pf2e-bestiary-tokens' }).packs.map(
      (p) => p.id,
    );
    expect(ids).toEqual(['pf2e-bestiary-tokens.x']);
  });

  it('applies both filters with AND semantics', () => {
    setPacks([
      {
        collection: 'pf2e.a',
        documentName: 'Actor',
        metadata: { label: 'A', packageName: 'pf2e' },
      },
      {
        collection: 'pf2e.b',
        documentName: 'Item',
        metadata: { label: 'B', packageName: 'pf2e' },
      },
      {
        collection: 'mod.a',
        documentName: 'Actor',
        metadata: { label: 'Mod-A', packageName: 'mod' },
      },
    ]);

    const ids = listCompendiumPacksBody({ documentType: 'Actor', system: 'pf2e' }).packs.map(
      (p) => p.id,
    );
    expect(ids).toEqual(['pf2e.a']);
  });

  it('sorts by label, case-insensitive', () => {
    setPacks([
      {
        collection: 'pf2e.zebra',
        documentName: 'Actor',
        metadata: { label: 'zebra', packageName: 'pf2e' },
      },
      {
        collection: 'pf2e.alpha',
        documentName: 'Actor',
        metadata: { label: 'Alpha', packageName: 'pf2e' },
      },
      {
        collection: 'pf2e.bravo',
        documentName: 'Actor',
        metadata: { label: 'bravo', packageName: 'pf2e' },
      },
    ]);

    const labels = listCompendiumPacksBody({}).packs.map((p) => p.label);
    expect(labels).toEqual(['Alpha', 'bravo', 'zebra']);
  });

  it('skips packs whose collection or documentName is missing or non-string', () => {
    setPacks([
      { collection: 'pf2e.ok', documentName: 'Actor', metadata: { label: 'Good' } },
      { collection: undefined, documentName: 'Actor', metadata: { label: 'No collection' } },
      { collection: 'pf2e.no-doctype', documentName: undefined, metadata: { label: 'X' } },
      { collection: 42, documentName: 'Actor', metadata: { label: 'Non-string collection' } },
    ]);

    const ids = listCompendiumPacksBody({}).packs.map((p) => p.id);
    expect(ids).toEqual(['pf2e.ok']);
  });

  it('returns an empty list when game.packs is absent', () => {
    expect(listCompendiumPacksBody({}).packs).toEqual([]);
  });
});
