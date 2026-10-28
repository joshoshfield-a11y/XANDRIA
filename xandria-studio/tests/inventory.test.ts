/**
 * inventory.test.ts — unit tests for the Inventory data model
 * (src/engine/game/items/Inventory.ts). Pure logic, no DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Inventory, BACKPACK_SIZE, type InventoryLike } from '../src/engine/game/items/Inventory';
import type { ItemDef } from '../src/spec/schema';

const defs: Record<string, ItemDef> = {
  'iron-sword': { name: 'Iron Sword', type: 'weapon', slot: 'weapon', rarity: 'common', stats: { damage: 5 }, stack: 1 },
  'steel-sword': { name: 'Steel Sword', type: 'weapon', slot: 'weapon', rarity: 'rare', stats: { damage: 9, crit: 2 }, stack: 1 },
  'leather-helm': { name: 'Leather Helm', type: 'armor', slot: 'head', stats: { defense: 2, maxHealth: 10 }, stack: 1 },
  'health-potion': { name: 'Health Potion', type: 'consumable', behavior: { effect: 'heal', amount: 25 }, stack: 10 },
  'iron-ore': { name: 'Iron Ore', type: 'material', stack: 99 },
};

let inv: Inventory;
beforeEach(() => {
  inv = new Inventory(defs);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('InventoryLike structural contract', () => {
  it('Inventory satisfies InventoryLike (runtime wireItems shape)', () => {
    const like: InventoryLike = inv;
    expect(like.add('iron-ore', 3)).toBe(0);
    expect(inv.count('iron-ore')).toBe(3);
  });
});

describe('add: stacking and overflow', () => {
  it('fills existing stacks before opening new ones', () => {
    expect(inv.add('health-potion', 5)).toBe(0);
    expect(inv.add('health-potion', 8)).toBe(0); // stack=10 → 10 + 3
    const pack = inv.getBackpack().filter(Boolean);
    expect(pack).toHaveLength(2);
    expect(pack[0]!.count).toBe(10);
    expect(pack[1]!.count).toBe(3);
  });

  it('returns leftover when the backpack is full', () => {
    for (let i = 0; i < BACKPACK_SIZE; i++) {
      expect(inv.add(`iron-sword`, 1)).toBe(0); // stack=1 → one slot each
    }
    expect(inv.freeSlots()).toBe(0);
    expect(inv.add('iron-ore', 7)).toBe(7); // nothing fit
    expect(inv.count('iron-ore')).toBe(0);
  });

  it('non-positive counts are no-ops', () => {
    expect(inv.add('iron-ore', 0)).toBe(0);
    expect(inv.add('iron-ore', -3)).toBe(0);
    expect(inv.count('iron-ore')).toBe(0);
  });
});

describe('remove / count', () => {
  it('removes across stacks and reports the removed count', () => {
    inv.add('health-potion', 15); // 10 + 5
    expect(inv.remove('health-potion', 12)).toBe(12);
    expect(inv.count('health-potion')).toBe(3);
    expect(inv.remove('health-potion', 99)).toBe(3); // only 3 left
    expect(inv.count('health-potion')).toBe(0);
  });

  it('count(undefined) returns 0 instead of throwing on empty slots (gathering-nodes)', () => {
    inv.add('health-potion', 2);
    expect((inv as unknown as { count(id: unknown): number }).count(undefined)).toBe(0);
    expect(inv.count('health-potion')).toBe(2);
  });
});

describe('equip', () => {
  it('moves an equippable to its slot', () => {
    inv.add('iron-sword', 1);
    const r = inv.equip('iron-sword');
    expect(r).toEqual({ displaced: null });
    expect(inv.getEquipped('weapon')).toBe('iron-sword');
    expect(inv.count('iron-sword')).toBe(1); // equipped counts too
  });

  it('returns the displaced item to the backpack', () => {
    inv.add('iron-sword', 1);
    inv.add('steel-sword', 1);
    expect(inv.equip('iron-sword')).toEqual({ displaced: null });
    const r = inv.equip('steel-sword');
    expect(r).toEqual({ displaced: 'iron-sword' });
    expect(inv.getEquipped('weapon')).toBe('steel-sword');
    expect(inv.count('iron-sword')).toBe(1); // back in the backpack
  });

  it('fails cleanly when there is no room for the displaced item', () => {
    inv.add('iron-sword', 1);
    inv.add('steel-sword', 1);
    inv.equip('iron-sword');
    // fill the rest of the backpack with non-stackables
    for (let i = 0; i < BACKPACK_SIZE - 1; i++) inv.add('leather-helm', 1);
    expect(inv.freeSlots()).toBe(0);
    const r = inv.equip('steel-sword');
    expect(r).toBeNull();
    expect(inv.getEquipped('weapon')).toBe('iron-sword'); // unchanged
    expect(inv.count('steel-sword')).toBe(1); // still in backpack
  });

  it('rejects non-equippables and missing items', () => {
    inv.add('health-potion', 1);
    expect(inv.equip('health-potion')).toBeNull();
    expect(inv.equip('iron-sword')).toBeNull(); // not in backpack
  });

  it('unequip returns the item to the backpack', () => {
    inv.add('iron-sword', 1);
    inv.equip('iron-sword');
    expect(inv.unequip('weapon')).toBe(true);
    expect(inv.getEquipped('weapon')).toBeNull();
    expect(inv.count('iron-sword')).toBe(1);
    expect(inv.unequip('weapon')).toBe(false); // empty slot
  });
});

describe('use', () => {
  it('decrements the stack and fires onUseEffect with the def', () => {
    const seen: ItemDef[] = [];
    inv.onUseEffect = (def) => { seen.push(def); };
    inv.add('health-potion', 2);
    expect(inv.use('health-potion')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].behavior?.effect).toBe('heal');
    expect(inv.count('health-potion')).toBe(1);
    expect(inv.use('health-potion')).toBe(true);
    expect(inv.count('health-potion')).toBe(0);
    expect(inv.use('health-potion')).toBe(false); // none left
  });

  it('refuses non-consumables without firing the callback', () => {
    const cb = vi.fn();
    inv.onUseEffect = cb;
    inv.add('iron-sword', 1);
    expect(inv.use('iron-sword')).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(inv.count('iron-sword')).toBe(1);
  });

  it('survives a throwing onUseEffect without corrupting state', () => {
    inv.onUseEffect = () => { throw new Error('boom'); };
    inv.add('health-potion', 2);
    expect(inv.use('health-potion')).toBe(true);
    expect(inv.count('health-potion')).toBe(1);
  });
});

describe('equippedStats', () => {
  it('sums stats of equipped items only', () => {
    inv.add('iron-sword', 1);
    inv.add('steel-sword', 1);
    inv.add('leather-helm', 1);
    inv.equip('iron-sword'); // +5 damage
    inv.equip('leather-helm'); // +2 defense, +10 maxHealth
    expect(inv.equippedStats()).toEqual({ damage: 5, defense: 2, maxHealth: 10 });
    // swapping changes the sum
    inv.equip('steel-sword'); // +9 damage, +2 crit
    expect(inv.equippedStats()).toEqual({ damage: 9, crit: 2, defense: 2, maxHealth: 10 });
  });
});

describe('serialize / deserialize', () => {
  it('round-trips backpack stacks and equipped slots', () => {
    inv.add('health-potion', 13); // 10 + 3
    inv.add('iron-sword', 1);
    inv.equip('iron-sword');
    inv.add('iron-ore', 40);
    const json = inv.serialize();
    const back = Inventory.deserialize(defs, json);
    expect(back.getBackpack().filter(Boolean).map((s) => [s!.itemId, s!.count]))
      .toEqual([['health-potion', 10], ['health-potion', 3], ['iron-ore', 40]]);
    expect(back.getEquipped('weapon')).toBe('iron-sword');
    expect(back.count('health-potion')).toBe(13);
    expect(back.equippedStats()).toEqual({ damage: 5 });
  });

  it('skips unknown ids and malformed data without throwing', () => {
    const json = JSON.stringify({
      version: 1,
      slots: [{ itemId: 'ghost-blade', count: 1 }, { itemId: 'iron-ore', count: 4 }],
      equipped: { weapon: 'ghost-blade', head: 'leather-helm' },
    });
    const back = Inventory.deserialize(defs, json);
    expect(back.count('iron-ore')).toBe(4);
    expect(back.getEquipped('weapon')).toBeNull();
    expect(back.getEquipped('head')).toBe('leather-helm');
    expect(Inventory.deserialize(defs, 'not json').count('iron-ore')).toBe(0);
    expect(Inventory.deserialize(defs, '{"slots":[]}').freeSlots()).toBe(BACKPACK_SIZE);
  });
});

describe('unknown item ids', () => {
  it('never throws: add warns and returns full leftover, others no-op', () => {
    expect(() => inv.add('nope', 5)).not.toThrow();
    expect(inv.add('nope', 5)).toBe(5);
    expect(() => inv.remove('nope')).not.toThrow();
    expect(() => inv.use('nope')).not.toThrow();
    expect(() => inv.equip('nope')).not.toThrow();
    expect(inv.use('nope')).toBe(false);
    expect(inv.equip('nope')).toBeNull();
  });
});
