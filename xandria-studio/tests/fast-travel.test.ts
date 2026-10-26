/**
 * UPGRADE LOOP (fast-travel phase): discovered-portal registry + arrival
 * geometry — pure unit tests (no Engine, no DOM).
 *
 * - record/list: origin first, discovery order stable, re-record is a
 *   no-op (labels are discovery-time facts, never overwritten).
 * - undiscovered portals are simply absent from list() — the panel never
 *   renders them, and PortalManager.fastTravelTo refuses them.
 * - serialize/restore: round-trip exact, corrupt input restores empty,
 *   never throws.
 * - storage namespacing: registries for different world seeds do not leak
 *   into each other; rekey loads the new seed's persisted list.
 * - fastTravelArrivalEdge: mirrors walked arrivals (north → S edge,
 *   east → W edge, ...), diagonals take the dominant axis, same-map → null.
 * - labelFor: pure in (worldSeed, coord); origin is always tier 1.
 */
import { describe, it, expect } from 'vitest';
import {
  FastTravelRegistry, fastTravelArrivalEdge, labelFor,
  type FastTravelStorage,
} from '../src/engine/world/FastTravel';
import { deriveWorldTier } from '../src/engine/world/worldTiers';
import { deriveMapSeed } from '../src/engine/world/MapGraph';

function memStorage(): FastTravelStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

const SEED = 20261014;

describe('FastTravelRegistry', () => {
  it('records in discovery order with the origin first', () => {
    const reg = new FastTravelRegistry(SEED, memStorage());
    expect(reg.list()).toEqual([]);
    reg.record({ mx: 0, my: 0 });
    reg.record({ mx: 0, my: 1 });
    reg.record({ mx: 1, my: 0 });
    const list = reg.list();
    expect(list.map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect(list.map((p) => p.order)).toEqual([0, 1, 2]);
    expect(reg.size).toBe(3);
  });

  it('re-recording keeps original order and labels', () => {
    const reg = new FastTravelRegistry(SEED, memStorage());
    reg.record({ mx: 0, my: 1 }, 'plains', 2);
    expect(reg.record({ mx: 0, my: 1 }, 'desert-canyon', 5)).toBe(false);
    const [p] = reg.list();
    expect(p.biome).toBe('plains');
    expect(p.tier).toBe(2);
    expect(p.order).toBe(0);
    expect(reg.size).toBe(1);
  });

  it('undiscovered portals are absent (has/list)', () => {
    const reg = new FastTravelRegistry(SEED, memStorage());
    reg.record({ mx: 0, my: 0 });
    reg.record({ mx: 0, my: 1 });
    expect(reg.has({ mx: 0, my: 1 })).toBe(true);
    expect(reg.has({ mx: 0, my: -1 })).toBe(false);
    expect(reg.has({ mx: 2, my: 0 })).toBe(false);
    expect(reg.list().map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1]]);
  });

  it('explicit labels win; omitted labels derive purely', () => {
    const reg = new FastTravelRegistry(SEED, memStorage());
    reg.record({ mx: 0, my: 1 });
    const [p] = reg.list();
    const label = labelFor(SEED, { mx: 0, my: 1 });
    expect(p.biome).toBe(label.biome);
    expect(p.tier).toBe(label.tier);
    expect(p.tier).toBe(deriveWorldTier(deriveMapSeed(SEED, 0, 1), 1));
  });

  it('serialize/restore round-trips exactly', () => {
    const store = memStorage();
    const reg = new FastTravelRegistry(SEED, store);
    reg.record({ mx: 0, my: 0 });
    reg.record({ mx: 0, my: 1 }, 'volcanic', 3);
    const restored = FastTravelRegistry.restore(SEED, reg.serialize(), store);
    expect(restored.list()).toEqual(reg.list());
    // A fresh registry on the same storage also loads the persisted list.
    expect(new FastTravelRegistry(SEED, store).list()).toEqual(reg.list());
  });

  it('corrupt serialize/restore input restores empty and never throws', () => {
    expect(() => FastTravelRegistry.restore(SEED, 'not json{{', memStorage())).not.toThrow();
    expect(FastTravelRegistry.restore(SEED, 'not json{{', memStorage()).list()).toEqual([]);
    expect(FastTravelRegistry.restore(SEED, '{"version":99,"portals":[]}', memStorage()).list()).toEqual([]);
    expect(FastTravelRegistry.restore(SEED, '{"version":1,"portals":[{"mx":"x"}]}', memStorage()).list()).toEqual([]);
  });

  it('world seeds do not leak into each other; rekey loads the new seed', () => {
    const store = memStorage();
    const a = new FastTravelRegistry(SEED, store);
    a.record({ mx: 0, my: 0 });
    a.record({ mx: 0, my: 1 });
    const b = new FastTravelRegistry(SEED + 1, store);
    expect(b.list()).toEqual([]);
    b.record({ mx: 0, my: 0 });
    a.rekey(SEED + 1);
    expect(a.list().map((p) => [p.mx, p.my])).toEqual([[0, 0]]);
    a.rekey(SEED);
    expect(a.list().map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1]]);
    // Rekey to the same seed is a no-op (no wipe).
    a.rekey(SEED);
    expect(a.size).toBe(2);
  });
});

describe('fastTravelArrivalEdge', () => {
  it('mirrors walked arrivals on all four axes', () => {
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: 0, my: 1 })).toBe('S');
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: 0, my: -1 })).toBe('N');
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: 1, my: 0 })).toBe('W');
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: -1, my: 0 })).toBe('E');
    // Non-adjacent targets use the same rule (direction, not adjacency).
    expect(fastTravelArrivalEdge({ mx: 0, my: 1 }, { mx: 1, my: 0 })).toBe('N');
    expect(fastTravelArrivalEdge({ mx: 2, my: 2 }, { mx: 2, my: -3 })).toBe('N');
  });

  it('diagonals take the dominant axis, ties prefer N/S', () => {
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: 1, my: 2 })).toBe('S');
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: 2, my: 1 })).toBe('W');
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: 1, my: 1 })).toBe('S');
    expect(fastTravelArrivalEdge({ mx: 0, my: 0 }, { mx: -1, my: -1 })).toBe('N');
  });

  it('same-map target returns null', () => {
    expect(fastTravelArrivalEdge({ mx: 1, my: 1 }, { mx: 1, my: 1 })).toBeNull();
  });
});

describe('labelFor', () => {
  it('is pure and origin is always tier 1', () => {
    expect(labelFor(SEED, { mx: 0, my: 0 }).tier).toBe(1);
    expect(labelFor(SEED, { mx: 0, my: 0 })).toEqual(labelFor(SEED, { mx: 0, my: 0 }));
    expect(labelFor(SEED, { mx: 3, my: 4 }).tier)
      .toBe(deriveWorldTier(deriveMapSeed(SEED, 3, 4), 7));
  });
});
