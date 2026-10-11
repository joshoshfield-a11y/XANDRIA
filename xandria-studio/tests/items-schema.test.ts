import { describe, it, expect } from 'vitest';
import { validateSpec, defaultSpec } from '../src/spec/schema';

const withItems = (items: unknown) => {
  const spec = defaultSpec(7) as unknown as Record<string, unknown>;
  spec.custom = { ...(spec.custom as object), items };
  return spec;
};

describe('custom.items schema', () => {
  it('accepts a full item table', () => {
    const r = validateSpec(withItems({
      defs: {
        ironSword: { name: 'Iron Sword', type: 'weapon', slot: 'weapon', rarity: 'common',
          stats: { damage: 12 }, stack: 1, value: 50, description: 'A plain iron sword.' },
        potion: { name: 'Healing Potion', type: 'consumable', behavior: { effect: 'heal', amount: 40 }, stack: 9 },
        helm: { name: 'Guard Helm', type: 'armor', slot: 'head', rarity: 'rare', stats: { defense: 4 } },
      },
      loot: [{ item: 'ironSword', pos: [10, 0, -5] }],
      chests: [{ pos: [0, 0, 0], loot: ['potion', 'helm'] }],
      starting: ['ironSword', 'potion'],
    }));
    expect(r.ok).toBe(true);
  });

  it('rejects bad defs: missing name, bad type, armor without slot', () => {
    const r = validateSpec(withItems({
      defs: {
        a: { type: 'weapon', slot: 'weapon' },                       // no name
        b: { name: 'X', type: 'wand' },                             // bad type
        c: { name: 'Y', type: 'armor', stats: { defense: 1 } },     // armor, no slot
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('custom.items.defs.a.name:'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('custom.items.defs.b.type:'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('custom.items.defs.c.slot:'))).toBe(true);
  });

  it('rejects unknown stat keys and non-finite stats', () => {
    const r = validateSpec(withItems({
      defs: { a: { name: 'A', type: 'trinket', stats: { power: 5, damage: Infinity } } },
    }));
    expect(r.ok).toBe(false);
  });

  it('rejects dangling references in loot/chests/starting', () => {
    const r = validateSpec(withItems({
      defs: { a: { name: 'A', type: 'material' } },
      loot: [{ item: 'ghost', pos: [0, 0, 0] }],
      chests: [{ pos: [1, 1, 1], loot: ['a', 'ghost2'] }],
      starting: ['ghost3'],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('"ghost"'))).toBe(true);
  });

  it('validates item skins: roles, hex, ranges, texture shapes', () => {
    const good = validateSpec(withItems({
      skins: { ember: { name: 'Ember', palette: { primary: '#ff5500', glow: '#ffaa00' },
        emissive: { color: '#ff7700', intensity: 2 }, roughness: 0.4, metalness: 0.8,
        texture: { pattern: 'carbon' }, textureRoles: ['primary'] } },
    }));
    expect(good.ok).toBe(true);
    const bad = validateSpec(withItems({
      skins: { bad: { name: 'Bad', palette: { shirt: '#zzz' }, roughness: 7, texture: { pattern: 'plaid' } } },
    }));
    expect(bad.ok).toBe(false);
  });

  it('rejects bad placement shapes', () => {
    const r = validateSpec(withItems({
      defs: { a: { name: 'A', type: 'key' } },
      loot: [{ item: 'a', pos: [0, 'x', 0] }],
      chests: [{ pos: [0, 0], loot: [] }],
    }));
    expect(r.ok).toBe(false);
  });

  it('unknown custom key "items" no longer warns', () => {
    const r = validateSpec(withItems({ defs: {} }));
    expect(r.warnings.some((w) => w.includes('items'))).toBe(false);
  });
});
