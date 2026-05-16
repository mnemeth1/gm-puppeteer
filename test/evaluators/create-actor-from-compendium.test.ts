import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActorFromCompendiumBody } from '../../src/evaluators/create-actor-from-compendium.js';

/**
 * The evaluator body is designed to run inside the browser via
 * `page.evaluate`. It only touches three globals: `fromUuid`, `Actor`,
 * and (indirectly) `Promise`. We stub the first two on `globalThis` per
 * test rather than pull in jsdom.
 *
 * Captured `createPayload` is the data passed into
 * `Actor.implementation.create()` — letting us assert the payload our
 * evaluator built before delegating to Foundry. The live-Foundry probes
 * already verified that Foundry actually persists what we pass; the
 * unit tests verify our payload construction is correct.
 */

interface ProtoLike {
  name?: string;
  actorLink?: boolean;
  texture?: { src?: string | null };
}
interface SourceLike {
  _id?: string;
  name?: string;
  type?: string;
  prototypeToken?: ProtoLike;
  folder?: string | null;
}
interface DocLike {
  documentName: string;
  toObject(): SourceLike;
}

function makeSourceActor(overrides: Partial<SourceLike> = {}): DocLike & SourceLike {
  const source: SourceLike = {
    _id: 'srcActor000000000',
    name: 'Original Name',
    type: 'character',
    prototypeToken: {
      name: 'Original Name',
      actorLink: false,
      texture: { src: 'icons/portraits/original.webp' },
    },
    folder: null,
    ...overrides,
  };
  return {
    documentName: 'Actor',
    ...source,
    toObject() {
      // Deep-ish clone so the evaluator's `delete data._id` etc. don't
      // mutate the test's source object.
      return JSON.parse(JSON.stringify(source)) as SourceLike;
    },
  };
}

function makeNonActor(documentName = 'Item'): DocLike {
  return {
    documentName,
    toObject() {
      return { name: "shouldn't be called" };
    },
  };
}

interface CreateCall {
  payload: SourceLike;
}

function installFoundryGlobals(opts: {
  fromUuidReturn: DocLike | null;
  createImpl?: (data: SourceLike) => Promise<unknown>;
}): { calls: CreateCall[]; createdId: string } {
  const calls: CreateCall[] = [];
  const createdId = 'newActorId12345A';
  const defaultCreate = async (data: SourceLike) => {
    calls.push({ payload: data });
    return {
      id: createdId,
      name: data.name ?? '',
      type: data.type ?? '',
      prototypeToken: {
        name: data.prototypeToken?.name ?? data.name ?? '',
        actorLink: data.prototypeToken?.actorLink === true,
        texture: data.prototypeToken?.texture ?? { src: null },
      },
      folder: data.folder ?? null,
    };
  };
  (globalThis as { fromUuid?: unknown }).fromUuid = vi
    .fn()
    .mockResolvedValue(opts.fromUuidReturn);
  (globalThis as { Actor?: unknown }).Actor = {
    implementation: {
      create: opts.createImpl ?? defaultCreate,
    },
  };
  return { calls, createdId };
}

describe('createActorFromCompendiumBody', () => {
  beforeEach(() => {
    delete (globalThis as { fromUuid?: unknown }).fromUuid;
    delete (globalThis as { Actor?: unknown }).Actor;
  });
  afterEach(() => {
    delete (globalThis as { fromUuid?: unknown }).fromUuid;
    delete (globalThis as { Actor?: unknown }).Actor;
  });

  it('strips _id from the create payload', async () => {
    const source = makeSourceActor();
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    const result = await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect('_id' in (calls[0]?.payload ?? {})).toBe(false);
  });

  it('mirrors name override to prototypeToken.name', async () => {
    const source = makeSourceActor({ name: 'Valeros', prototypeToken: { name: 'Valeros' } });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    const result = await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
      name: 'Test Valeros',
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.payload.name).toBe('Test Valeros');
    expect(calls[0]?.payload.prototypeToken?.name).toBe('Test Valeros');
  });

  it('leaves source name + prototype name intact when no name override is given', async () => {
    const source = makeSourceActor({ name: 'Valeros', prototypeToken: { name: 'Valeros' } });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({ uuid: 'Compendium.pf2e.iconics.Actor.X' });

    expect(calls[0]?.payload.name).toBe('Valeros');
    expect(calls[0]?.payload.prototypeToken?.name).toBe('Valeros');
  });

  it('heuristic: type=character → actorLink=true', async () => {
    const source = makeSourceActor({
      type: 'character',
      prototypeToken: { name: 'P', actorLink: false },
    });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({ uuid: 'Compendium.pf2e.iconics.Actor.X' });

    expect(calls[0]?.payload.prototypeToken?.actorLink).toBe(true);
  });

  it('heuristic: type=npc → actorLink=false', async () => {
    const source = makeSourceActor({
      type: 'npc',
      prototypeToken: { name: 'P', actorLink: false },
    });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({ uuid: 'Compendium.pf2e.bestiary.Actor.X' });

    expect(calls[0]?.payload.prototypeToken?.actorLink).toBe(false);
  });

  it('explicit actorLink:false on character wins over the heuristic at payload level', async () => {
    const source = makeSourceActor({ type: 'character' });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
      actorLink: false,
    });

    expect(calls[0]?.payload.prototypeToken?.actorLink).toBe(false);
  });

  it('explicit actorLink:true on NPC wins over the heuristic at payload level', async () => {
    const source = makeSourceActor({ type: 'npc' });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.bestiary.Actor.X',
      actorLink: true,
    });

    expect(calls[0]?.payload.prototypeToken?.actorLink).toBe(true);
  });

  it('passes folder id through to the create payload', async () => {
    const source = makeSourceActor();
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
      folder: 'someFolderId1234',
    });

    expect(calls[0]?.payload.folder).toBe('someFolderId1234');
  });

  it('omits folder from the payload when not provided', async () => {
    const source = makeSourceActor({ folder: null });
    const { calls } = installFoundryGlobals({ fromUuidReturn: source });

    await createActorFromCompendiumBody({ uuid: 'Compendium.pf2e.iconics.Actor.X' });

    expect(calls[0]?.payload.folder).toBeNull();
  });

  it('returns UUID_NOT_FOUND when fromUuid resolves to null', async () => {
    installFoundryGlobals({ fromUuidReturn: null });

    const result = await createActorFromCompendiumBody({ uuid: 'Compendium.bad.Actor.X' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UUID_NOT_FOUND');
      expect(result.error.message).toContain('Compendium.bad.Actor.X');
    }
  });

  it('returns NOT_AN_ACTOR when fromUuid resolves to an Item', async () => {
    installFoundryGlobals({ fromUuidReturn: makeNonActor('Item') });

    const result = await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.actionspf2e.Item.X',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_AN_ACTOR');
      expect(result.error.message).toContain('Item');
    }
  });

  it('returns CREATE_FAILED when Actor.implementation.create throws', async () => {
    installFoundryGlobals({
      fromUuidReturn: makeSourceActor(),
      createImpl: async () => {
        throw new Error('folder: must be a valid 16-character alphanumeric ID');
      },
    });

    const result = await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
      folder: 'tooShort',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CREATE_FAILED');
      expect(result.error.message).toContain('16-character');
    }
  });

  it('returns the actually-stored actorLink from the created doc (PF2e override case)', async () => {
    // Simulate PF2e: caller wanted unlinked character, system forces linked.
    const source = makeSourceActor({ type: 'character' });
    installFoundryGlobals({
      fromUuidReturn: source,
      createImpl: async (data) => ({
        id: 'forced0000000000',
        name: data.name,
        type: data.type,
        prototypeToken: {
          name: data.prototypeToken?.name,
          actorLink: true, // PF2e overrode caller's `false`
          texture: data.prototypeToken?.texture,
        },
        folder: data.folder ?? null,
      }),
    });

    const result = await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
      actorLink: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actorLink).toBe(true); // reflects PF2e-stored value
    }
  });

  it('returns the expected success shape', async () => {
    const source = makeSourceActor({
      name: 'Valeros',
      type: 'character',
      prototypeToken: {
        name: 'Valeros',
        actorLink: false,
        texture: { src: 'icons/portraits/valeros.webp' },
      },
    });
    installFoundryGlobals({ fromUuidReturn: source });

    const result = await createActorFromCompendiumBody({
      uuid: 'Compendium.pf2e.iconics.Actor.X',
      name: 'Test Valeros',
    });

    expect(result).toEqual({
      ok: true,
      actorId: 'newActorId12345A',
      name: 'Test Valeros',
      type: 'character',
      actorLink: true,
      prototypeTokenImg: 'icons/portraits/valeros.webp',
      prototypeTokenName: 'Test Valeros',
      folder: null,
    });
  });
});
