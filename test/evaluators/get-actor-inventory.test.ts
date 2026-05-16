import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActorInventoryBody } from '../../src/evaluators/get-actor-inventory.js';

/**
 * The evaluator body runs in the browser via page.evaluate; here we stub
 * the `game` global per-test. The live-Foundry probes
 * (scripts/probe-actor-inventory*.mjs) confirmed the field shapes the
 * mocks below use — these tests verify our projection over them.
 */

interface ItemLike {
  id?: string;
  uuid?: string;
  name?: string;
  type?: string;
  system?: Record<string, unknown>;
}

interface ActorLike {
  id: string;
  name: string;
  items: { contents: ItemLike[] };
  inventory?: { coins?: { pp?: number; gp?: number; sp?: number; cp?: number } };
}

function installFoundryGlobals(actors: Record<string, ActorLike>): void {
  (globalThis as unknown as { game: unknown }).game = {
    actors: {
      get: (id: string): ActorLike | undefined => actors[id],
    },
  };
}

function makeActor(overrides: Partial<ActorLike> = {}): ActorLike {
  return {
    id: 'valeros0000000000',
    name: 'Valeros',
    items: { contents: [] },
    inventory: { coins: { pp: 0, gp: 0, sp: 0, cp: 0 } },
    ...overrides,
  };
}

function makeWeapon(overrides: Partial<ItemLike> = {}): ItemLike {
  return {
    id: 'wpnLongsword0001',
    uuid: 'Actor.X.Item.wpnLongsword0001',
    name: 'Longsword',
    type: 'weapon',
    system: {
      quantity: 1,
      equipped: { carryType: 'worn', invested: null, handsHeld: 0 },
      containerId: null,
      bulk: { value: 1, per: 1, heldOrStowed: 1 },
      traits: { value: ['versatile-p'] },
      level: { value: 0 },
      runes: { potency: 0, striking: 0, property: [], effects: [] },
    },
    ...overrides,
  };
}

describe('getActorInventoryBody', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
  });
  afterEach(() => {
    delete (globalThis as unknown as { game?: unknown }).game;
  });

  it('returns ACTOR_NOT_FOUND for a missing actor id', async () => {
    installFoundryGlobals({});

    const result = await getActorInventoryBody({ actorId: 'doesNotExist' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ACTOR_NOT_FOUND');
      expect(result.error.message).toContain('doesNotExist');
      expect(result.error.details?.actorId).toBe('doesNotExist');
    }
  });

  it('filters non-physical types out of the inventory', async () => {
    const physicalTypes = [
      'weapon',
      'armor',
      'shield',
      'consumable',
      'equipment',
      'treasure',
      'backpack',
      'ammo',
    ];
    const nonPhysicalTypes = [
      'feat',
      'spell',
      'ancestry',
      'background',
      'class',
      'heritage',
      'action',
      'lore',
      'condition',
      'effect',
      'melee', // NPC strike defs
    ];
    const contents: ItemLike[] = [
      ...physicalTypes.map((t, i) => ({
        id: `p${i}`,
        uuid: `Actor.X.Item.p${i}`,
        name: `phys-${t}`,
        type: t,
        system: { quantity: 1, bulk: { value: 0, per: 1 } },
      })),
      ...nonPhysicalTypes.map((t, i) => ({
        id: `n${i}`,
        uuid: `Actor.X.Item.n${i}`,
        name: `non-${t}`,
        type: t,
        system: {},
      })),
    ];
    const actor = makeActor({ items: { contents } });
    installFoundryGlobals({ valeros0000000000: actor });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(physicalTypes.length);
      const returnedTypes = result.items.map((i) => i.type).sort();
      expect(returnedTypes).toEqual([...physicalTypes].sort());
    }
  });

  it('maps backpack → category:container and other types 1:1 (ammo → consumable)', async () => {
    const contents: ItemLike[] = [
      { id: 'b1', name: 'Backpack', type: 'backpack', system: {} },
      { id: 'a1', name: 'Arrows', type: 'ammo', system: { quantity: 20 } },
      { id: 'w1', name: 'Longsword', type: 'weapon', system: { quantity: 1 } },
    ];
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byType = Object.fromEntries(result.items.map((i) => [i.type, i.category]));
      expect(byType).toEqual({
        backpack: 'container',
        ammo: 'consumable',
        weapon: 'weapon',
      });
    }
  });

  it('projects equipped state as-is (carryType / handsHeld / invested / inSlot)', async () => {
    const heldShield: ItemLike = {
      id: 'sh1',
      name: 'Wooden Shield',
      type: 'shield',
      system: {
        equipped: { carryType: 'held', handsHeld: 1, invested: null },
      },
    };
    const wornArmor: ItemLike = {
      id: 'ar1',
      name: 'Breastplate',
      type: 'armor',
      system: {
        equipped: { carryType: 'worn', invested: null, handsHeld: 0, inSlot: true },
      },
    };
    const stowed: ItemLike = {
      id: 'eq1',
      name: 'Rope',
      type: 'equipment',
      system: {
        equipped: { carryType: 'stowed', invested: null, handsHeld: 0 },
      },
    };
    installFoundryGlobals({
      valeros0000000000: makeActor({
        items: { contents: [heldShield, wornArmor, stowed] },
      }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = Object.fromEntries(result.items.map((i) => [i.id, i.equipped]));
      expect(byId.sh1).toEqual({ carryType: 'held', handsHeld: 1, invested: null });
      expect(byId.ar1).toEqual({
        carryType: 'worn',
        invested: null,
        handsHeld: 0,
        inSlot: true,
      });
      expect(byId.eq1).toEqual({ carryType: 'stowed', invested: null, handsHeld: 0 });
    }
  });

  it('projects containerId as string for nested items and null for top-level', async () => {
    const contents: ItemLike[] = [
      {
        id: 'pack01',
        name: 'Backpack',
        type: 'backpack',
        system: { containerId: null },
      },
      {
        id: 'rope01',
        name: 'Rope',
        type: 'equipment',
        system: { containerId: 'pack01' },
      },
    ];
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = Object.fromEntries(result.items.map((i) => [i.id, i.containerId]));
      expect(byId.pack01).toBeNull();
      expect(byId.rope01).toBe('pack01');
    }
  });

  it('projects bulk as {value, per}; drops container-internal fields', async () => {
    const contents: ItemLike[] = [
      {
        id: 'arrows',
        name: 'Arrows',
        type: 'ammo',
        system: { bulk: { value: 0.1, per: 10, heldOrStowed: 0.1 } },
      },
      {
        id: 'copper',
        name: 'Copper Pieces',
        type: 'treasure',
        system: { bulk: { value: 1, per: 1000, heldOrStowed: 1 } },
      },
      {
        id: 'pack',
        name: 'Backpack',
        type: 'backpack',
        system: {
          bulk: { value: 0, per: 1, heldOrStowed: 0.1, capacity: 4, ignored: 2 },
        },
      },
    ];
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = Object.fromEntries(result.items.map((i) => [i.id, i.bulk]));
      expect(byId.arrows).toEqual({ value: 0.1, per: 10 });
      expect(byId.copper).toEqual({ value: 1, per: 1000 });
      expect(byId.pack).toEqual({ value: 0, per: 1 });
    }
  });

  it('includes runes for weapon/armor/shield and omits the field for other types', async () => {
    const contents: ItemLike[] = [
      makeWeapon(),
      {
        id: 'arm1',
        name: 'Breastplate',
        type: 'armor',
        system: { runes: { potency: 0, resilient: 0, property: [] } },
      },
      {
        id: 'shd1',
        name: 'Wooden Shield',
        type: 'shield',
        system: { runes: { reinforcing: 0 } },
      },
      {
        id: 'pot1',
        name: 'Healing Potion (Minor)',
        type: 'consumable',
        system: { quantity: 1, level: { value: 1 } },
      },
      {
        id: 'cop1',
        name: 'Copper Pieces',
        type: 'treasure',
        system: { quantity: 9 },
      },
    ];
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));
      expect(byId.wpnLongsword0001?.runes).toEqual({
        potency: 0,
        striking: 0,
        property: [],
        effects: [],
      });
      expect(byId.arm1?.runes).toEqual({ potency: 0, resilient: 0, property: [] });
      expect(byId.shd1?.runes).toEqual({ reinforcing: 0 });
      expect('runes' in (byId.pot1 ?? {})).toBe(false);
      expect('runes' in (byId.cop1 ?? {})).toBe(false);
    }
  });

  it('preserves magical-rune values on weapons', async () => {
    const magicalSword = makeWeapon({
      id: 'magic01',
      name: 'Longsword',
      system: {
        ...(makeWeapon().system as Record<string, unknown>),
        runes: { potency: 1, striking: 1, property: ['flaming'], effects: [] },
      },
    });
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents: [magicalSword] } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.runes).toEqual({
        potency: 1,
        striking: 1,
        property: ['flaming'],
        effects: [],
      });
    }
  });

  it('projects currency from actor.inventory.coins', async () => {
    installFoundryGlobals({
      valeros0000000000: makeActor({
        inventory: { coins: { pp: 1, gp: 2, sp: 3, cp: 9 } },
      }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.currency).toEqual({ pp: 1, gp: 2, sp: 3, cp: 9 });
    }
  });

  it('returns zero currency when actor.inventory.coins is missing entirely', async () => {
    const actor = makeActor();
    delete actor.inventory;
    installFoundryGlobals({ valeros0000000000: actor });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
    }
  });

  it('returns zero defaults for any missing currency denomination', async () => {
    installFoundryGlobals({
      valeros0000000000: makeActor({ inventory: { coins: { gp: 5 } } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.currency).toEqual({ pp: 0, gp: 5, sp: 0, cp: 0 });
    }
  });

  it('returns empty items + zero currency for an actor with no inventory', async () => {
    const actor = makeActor();
    delete actor.inventory;
    installFoundryGlobals({ valeros0000000000: actor });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toEqual([]);
      expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
    }
  });

  it('defaults quantity to 1 when missing and projects level when present', async () => {
    const contents: ItemLike[] = [
      {
        id: 'mug',
        name: 'Mug',
        type: 'equipment',
        system: { level: { value: 0 } },
      },
      {
        id: 'pot',
        name: 'Potion',
        type: 'consumable',
        system: { quantity: 3, level: { value: 1 } },
      },
    ];
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));
      expect(byId.mug?.quantity).toBe(1);
      expect(byId.mug?.level).toBe(0);
      expect(byId.pot?.quantity).toBe(3);
      expect(byId.pot?.level).toBe(1);
    }
  });

  it('handles malformed/missing fields by returning safe defaults, not throwing', async () => {
    const sparse: ItemLike = {
      id: 'homebrew01',
      name: 'Homebrew Trinket',
      type: 'equipment',
      system: {
        // No equipped, bulk, traits, level, quantity, runes.
      },
    };
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents: [sparse] } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]).toMatchObject({
        id: 'homebrew01',
        name: 'Homebrew Trinket',
        type: 'equipment',
        category: 'equipment',
        quantity: 1,
        equipped: null,
        containerId: null,
        bulk: null,
        traits: [],
        level: null,
      });
      expect('runes' in (result.items[0] ?? {})).toBe(false);
    }
  });

  it('never includes a description field on items', async () => {
    const contents: ItemLike[] = [
      makeWeapon({
        system: {
          ...(makeWeapon().system as Record<string, unknown>),
          description: { value: '<p>This sword has a long history...</p>' },
        },
      }),
    ];
    installFoundryGlobals({
      valeros0000000000: makeActor({ items: { contents } }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const item of result.items) {
        expect('description' in item).toBe(false);
      }
    }
  });

  it('echoes actorId + actorName from the resolved actor', async () => {
    installFoundryGlobals({
      valeros0000000000: makeActor({ id: 'valeros0000000000', name: 'Valeros (Level 1)' }),
    });

    const result = await getActorInventoryBody({ actorId: 'valeros0000000000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actorId).toBe('valeros0000000000');
      expect(result.actorName).toBe('Valeros (Level 1)');
    }
  });
});
