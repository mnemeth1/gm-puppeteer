import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeTokenAtGridBody } from '../../src/evaluators/place-token-at-grid.js';

/**
 * The evaluator body runs in the browser via page.evaluate; here we stub
 * the `game` global per-test. The live-Foundry probes confirmed that the
 * canonical API surface is `scene.grid.getTopLeftPoint({i, j})` and
 * `scene.createEmbeddedDocuments('Token', [data])` — the unit tests
 * verify that our evaluator correctly drives that surface and computes
 * the outOfImageBounds flag.
 */

interface SceneLike {
  id: string;
  width: number;
  height: number;
  padding: number;
  grid: {
    type: number;
    size: number;
    getTopLeftPoint: (offset: { i: number; j: number }) => { x: number | null; y: number | null };
  };
  createEmbeddedDocuments: ReturnType<typeof vi.fn>;
}

interface ActorLike {
  id: string;
  getTokenDocument: ReturnType<typeof vi.fn>;
}

interface CreatedTokenLike {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  actorLink?: boolean;
}

function makeScene(overrides: Partial<SceneLike> = {}): SceneLike {
  return {
    id: 'sceneTavernCellar',
    width: 1190,
    height: 813,
    padding: 0.15,
    grid: {
      type: 1,
      size: 50,
      // Default helper: pure v13-math (matches what live Foundry returns for square grids).
      getTopLeftPoint: ({ i, j }) => ({ x: j * 50, y: i * 50 }),
    },
    createEmbeddedDocuments: vi
      .fn()
      .mockImplementation((_type: string, data: Record<string, unknown>[]) => {
        // Default impl: echo the first payload back as a "created" token.
        const d = data[0] ?? {};
        return Promise.resolve([
          {
            id: 'newTokenId000000',
            name: (d.name as string | undefined) ?? 'Valeros',
            x: d.x as number,
            y: d.y as number,
            width: (d.width as number | undefined) ?? 1,
            height: (d.height as number | undefined) ?? 1,
            actorLink: d.actorLink === true,
          } satisfies CreatedTokenLike,
        ]);
      }),
    ...overrides,
  };
}

function makeActor(overrides: Partial<ActorLike> = {}): ActorLike {
  return {
    id: 'actorValerosId01',
    getTokenDocument: vi.fn().mockImplementation(async (data: Record<string, unknown>) => ({
      toObject: () => ({
        ...data,
        actorId: 'actorValerosId01',
        actorLink: true,
        width: 1,
        height: 1,
        name: (data.name as string | undefined) ?? 'Valeros',
      }),
    })),
    ...overrides,
  };
}

interface InstallOpts {
  actors?: Record<string, ActorLike>;
  scenesById?: Record<string, SceneLike>;
  activeScene?: SceneLike | null;
}

function installFoundryGlobals(opts: InstallOpts = {}): void {
  (globalThis as unknown as { game: unknown }).game = {
    actors: {
      get: (id: string): ActorLike | undefined => opts.actors?.[id],
    },
    scenes: {
      get: (id: string): SceneLike | undefined => opts.scenesById?.[id],
      active: opts.activeScene ?? null,
    },
  };
}

describe('placeTokenAtGridBody', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
  });
  afterEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
  });

  it('places at the canonical {x,y} for the given {i,j} on the active scene', async () => {
    const actor = makeActor();
    const scene = makeScene();
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 17,
      j: 17,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canvasCoords).toEqual({ x: 850, y: 850 });
      expect(result.gridCoords).toEqual({ i: 17, j: 17 });
      expect(result.sceneId).toBe('sceneTavernCellar');
      expect(result.outOfImageBounds).toBe(false);
    }
    expect(actor.getTokenDocument).toHaveBeenCalledWith({ x: 850, y: 850 });
    expect(scene.createEmbeddedDocuments).toHaveBeenCalledWith(
      'Token',
      expect.arrayContaining([expect.objectContaining({ x: 850, y: 850 })]),
    );
  });

  it('passes tokenName through getTokenDocument and into the returned tokenName', async () => {
    const actor = makeActor();
    const scene = makeScene();
    installFoundryGlobals({
      actors: { actorGoblinId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorGoblinId01',
      i: 12,
      j: 13,
      tokenName: 'Goblin Warrior 2',
    });

    expect(actor.getTokenDocument).toHaveBeenCalledWith({
      x: 650,
      y: 600,
      name: 'Goblin Warrior 2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokenName).toBe('Goblin Warrior 2');
    }
  });

  it('omits name from getTokenDocument input when tokenName is not provided', async () => {
    const actor = makeActor();
    const scene = makeScene();
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    await placeTokenAtGridBody({ actorId: 'actorValerosId01', i: 17, j: 17 });

    // Asserts no `name` key in the call.
    expect(actor.getTokenDocument).toHaveBeenCalledWith({ x: 850, y: 850 });
    const args = actor.getTokenDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('name' in args).toBe(false);
  });

  it('resolves the explicit sceneId when provided, ignoring active', async () => {
    const actor = makeActor();
    const active = makeScene({ id: 'shouldNotBeUsed' });
    const targetScene = makeScene({ id: 'sceneTargetId001' });
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      scenesById: { sceneTargetId001: targetScene },
      activeScene: active,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 5,
      j: 5,
      sceneId: 'sceneTargetId001',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sceneId).toBe('sceneTargetId001');
    }
    expect(targetScene.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(active.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it('flags outOfImageBounds when placement lands in the padding region', async () => {
    const actor = makeActor();
    const scene = makeScene(); // padding 0.15 → padX=179, padY=122
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    // {i:0, j:0} → {x:0, y:0} → in the padding strip (top-left corner of canvas)
    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 0,
      j: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canvasCoords).toEqual({ x: 0, y: 0 });
      expect(result.outOfImageBounds).toBe(true);
    }
  });

  it('flags outOfImageBounds when the bounding box extends past the image right edge', async () => {
    const actor = makeActor();
    const scene = makeScene();
    // Image rect is [179, 122, 1369, 935]. A 1×1 token at {x:1350, y:500} covers
    // [1350, 500]..[1400, 550] — right edge 1400 > 1369 ⇒ out of bounds.
    scene.grid.getTopLeftPoint = ({ i, j }): { x: number; y: number } => ({
      x: j === 27 ? 1350 : j * 50,
      y: i === 10 ? 500 : i * 50,
    });
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 10,
      j: 27,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outOfImageBounds).toBe(true);
    }
  });

  it('returns ACTOR_NOT_FOUND when game.actors.get returns undefined', async () => {
    installFoundryGlobals({
      actors: {},
      activeScene: makeScene(),
    });

    const result = await placeTokenAtGridBody({
      actorId: 'doesNotExist0000',
      i: 0,
      j: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ACTOR_NOT_FOUND');
      expect(result.error.message).toContain('doesNotExist0000');
    }
  });

  it('returns SCENE_NOT_FOUND when an explicit sceneId is bogus', async () => {
    const actor = makeActor();
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      scenesById: {},
      activeScene: makeScene(),
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 0,
      j: 0,
      sceneId: 'bogusSceneId0001',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SCENE_NOT_FOUND');
      expect(result.error.message).toContain('bogusSceneId0001');
    }
  });

  it('returns NO_ACTIVE_SCENE when neither sceneId is given nor active scene exists', async () => {
    const actor = makeActor();
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: null,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 0,
      j: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_ACTIVE_SCENE');
    }
  });

  it('returns NON_SQUARE_GRID for hex (grid.type=2)', async () => {
    const actor = makeActor();
    const scene = makeScene({
      grid: {
        type: 2,
        size: 50,
        getTopLeftPoint: () => ({ x: 0, y: 0 }),
      },
    });
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 0,
      j: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NON_SQUARE_GRID');
    }
  });

  it('returns NON_SQUARE_GRID for gridless (grid.type=0)', async () => {
    const actor = makeActor();
    const scene = makeScene({
      grid: {
        type: 0,
        size: 50,
        getTopLeftPoint: () => ({ x: 0, y: 0 }),
      },
    });
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 0,
      j: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NON_SQUARE_GRID');
    }
  });

  it('returns CREATE_FAILED when createEmbeddedDocuments throws', async () => {
    const actor = makeActor();
    const scene = makeScene();
    scene.createEmbeddedDocuments = vi
      .fn()
      .mockRejectedValue(new Error('foundry rejected payload'));
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 17,
      j: 17,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CREATE_FAILED');
      expect(result.error.message).toContain('foundry rejected payload');
    }
  });

  it('returns CREATE_FAILED when getTopLeftPoint returns non-numeric x/y', async () => {
    const actor = makeActor();
    const scene = makeScene({
      grid: {
        type: 1,
        size: 50,
        getTopLeftPoint: () => ({ x: null, y: null }),
      },
    });
    installFoundryGlobals({
      actors: { actorValerosId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorValerosId01',
      i: 17,
      j: 17,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CREATE_FAILED');
    }
  });

  it('returns the actually-stored actorLink and name from the created doc', async () => {
    const actor = makeActor();
    const scene = makeScene({
      createEmbeddedDocuments: vi.fn().mockResolvedValue([
        {
          id: 'newId00000000000',
          name: 'Goblin Warrior 2',
          x: 650,
          y: 600,
          width: 1,
          height: 1,
          actorLink: false, // unlinked NPC
        },
      ]),
    });
    installFoundryGlobals({
      actors: { actorGoblinId01: actor },
      activeScene: scene,
    });

    const result = await placeTokenAtGridBody({
      actorId: 'actorGoblinId01',
      i: 12,
      j: 13,
      tokenName: 'Goblin Warrior 2',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokenId).toBe('newId00000000000');
      expect(result.tokenName).toBe('Goblin Warrior 2');
      expect(result.actorLink).toBe(false);
    }
  });
});
