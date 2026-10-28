/**
 * UPGRADE LOOP (world-atlas phase): pure unit tests for the atlas model
 * (no Engine, no DOM — the panel's DOM path is covered by e2e, like the
 * fast-travel panel) plus the Minimap.coverageFor read seam.
 *
 * - buildAtlasModel: entries come ONLY from the registry list (an
 *   undiscovered map has no entry and cannot appear); biome/tier/order
 *   are the registry's discovery-time labels, untouched; fog is clamped
 *   and rounded; camp structures pass through; isCurrent marks exactly
 *   the current map.
 * - unchartedNeighborCount: 4 for a lone map, shared neighbors deduped,
 *   discovered neighbors excluded; a count only, no coords returned.
 * - fogPercentOf / clampFogCoverage: NaN/negative/>1 inputs are safe.
 * - Minimap.coverageFor: 0 for a map with no fog state, the live grid
 *   fraction for a walked map, never outside [0, 1].
 */
import { describe, it, expect } from 'vitest';
import {
  buildAtlasModel, unchartedNeighborCount, fogPercentOf, clampFogCoverage,
  type AtlasSource,
} from '../src/engine/world/WorldAtlas';
import { FogOfWar, Minimap } from '../src/engine/ui/Minimap';
import type { DiscoveredPortal } from '../src/engine/world/FastTravel';

function source(over: Partial<AtlasSource> = {}): AtlasSource {
  return {
    discovered: () => [],
    current: () => ({ mx: 0, my: 0 }),
    fogCoverage: () => 0,
    campStructures: () => [],
    ...over,
  };
}

const REG: DiscoveredPortal[] = [
  { mx: 0, my: 0, biome: 'plains', tier: 1, order: 0 },
  { mx: 0, my: 1, biome: 'forest', tier: 2, order: 1 },
  { mx: 1, my: 0, biome: 'desert-canyon', tier: 2, order: 2 },
];

describe('buildAtlasModel', () => {
  it('lists exactly the discovered maps, in discovery order, labels untouched', () => {
    const model = buildAtlasModel(source({ discovered: () => [...REG] }));
    expect(model.entries.map((e) => [e.mx, e.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect(model.entries.map((e) => e.order)).toEqual([0, 1, 2]);
    expect(model.entries[1]).toMatchObject({ biome: 'forest', biomeName: 'Forest', tier: 2 });
    expect(model.entries[2]).toMatchObject({ biome: 'desert-canyon', biomeName: 'Desert Canyons', tier: 2 });
    expect(model.discoveredCount).toBe(3);
  });

  it('an undiscovered map has no entry and no data anywhere in the model', () => {
    const model = buildAtlasModel(source({
      discovered: () => [REG[0]],
      current: () => ({ mx: 0, my: 0 }),
    }));
    const dumped = JSON.stringify(model);
    expect(model.entries).toHaveLength(1);
    expect(dumped).not.toContain('0,1');
    expect(dumped).not.toContain('"mx":1');
    expect(model.unchartedCount).toBe(4);
  });

  it('marks exactly the current map, and only it', () => {
    const model = buildAtlasModel(source({
      discovered: () => [...REG],
      current: () => ({ mx: 1, my: 0 }),
    }));
    expect(model.entries.map((e) => e.isCurrent)).toEqual([false, false, true]);
    expect(model.current).toEqual({ mx: 1, my: 0 });
  });

  it('fog coverage is clamped, rounded, and read fresh per map', () => {
    const fog = new Map<string, number>([['0,0', 0.269], ['0,1', 2.5], ['1,0', -0.4]]);
    const model = buildAtlasModel(source({
      discovered: () => [...REG],
      fogCoverage: (c) => fog.get(`${c.mx},${c.my}`) ?? 0,
    }));
    expect(model.entries.map((e) => [e.fogCoverage, e.fogPercent])).toEqual([
      [0.269, 27], [1, 100], [0, 0],
    ]);
  });

  it('camp structures pass through per map (built vs site-only)', () => {
    const camps = new Map<string, string[]>([['0,0', ['chest']]]);
    const model = buildAtlasModel(source({
      discovered: () => [...REG],
      campStructures: (c) => camps.get(`${c.mx},${c.my}`) ?? [],
    }));
    expect(model.entries[0].campStructures).toEqual(['chest']);
    expect(model.entries[1].campStructures).toEqual([]);
    expect(model.entries[2].campStructures).toEqual([]);
  });

  it('unknown biome ids fall back to the id string, never throw', () => {
    const model = buildAtlasModel(source({
      discovered: () => [{ mx: 0, my: 0, biome: 'not-a-biome' as never, tier: 1, order: 0 }],
    }));
    expect(model.entries[0].biomeName).toBe('not-a-biome');
  });

  it('reads the sources fresh on every call (discovery while closed shows up)', () => {
    let list: DiscoveredPortal[] = [REG[0]];
    const src = source({ discovered: () => [...list] });
    expect(buildAtlasModel(src).entries).toHaveLength(1);
    list = [...REG];
    expect(buildAtlasModel(src).entries).toHaveLength(3);
  });
});

describe('unchartedNeighborCount', () => {
  it('a lone map has 4 uncharted neighbors', () => {
    expect(unchartedNeighborCount([{ mx: 0, my: 0 }])).toBe(4);
  });

  it('shared neighbors are counted once, discovered neighbors excluded', () => {
    // (0,0),(0,1),(1,0): uncharted neighbors are (-1,0),(0,-1),(1,1),
    // (-1,1),(0,2),(2,0),(1,-1) = 7 ((1,1) is shared by (0,1) and (1,0)).
    expect(unchartedNeighborCount([
      { mx: 0, my: 0 }, { mx: 0, my: 1 }, { mx: 1, my: 0 },
    ])).toBe(7);
  });

  it('empty discovery has no neighbors', () => {
    expect(unchartedNeighborCount([])).toBe(0);
  });

  it('duplicate coords do not inflate the count', () => {
    expect(unchartedNeighborCount([{ mx: 0, my: 0 }, { mx: 0, my: 0 }])).toBe(4);
  });
});

describe('fogPercentOf / clampFogCoverage', () => {
  it('rounds half-up via Math.round and clamps', () => {
    expect(fogPercentOf(0)).toBe(0);
    expect(fogPercentOf(0.005)).toBe(1);
    expect(fogPercentOf(0.994)).toBe(99);
    expect(fogPercentOf(1)).toBe(100);
    expect(fogPercentOf(1.5)).toBe(100);
    expect(fogPercentOf(-0.2)).toBe(0);
    expect(fogPercentOf(NaN)).toBe(0);
    // Non-finite input is corrupt state and reads as 0, never 100.
    expect(fogPercentOf(Infinity)).toBe(0);
  });

  it('clampFogCoverage is a safe [0,1] clamp', () => {
    expect(clampFogCoverage(NaN)).toBe(0);
    expect(clampFogCoverage(-1)).toBe(0);
    expect(clampFogCoverage(0.5)).toBe(0.5);
    expect(clampFogCoverage(9)).toBe(1);
  });
});

describe('Minimap.coverageFor', () => {
  it('returns 0 for maps with no fog state and the grid fraction for walked maps', () => {
    const fakeEngine = {
      hooks: { tap: () => () => { /* noop */ } },
      portalManager: undefined,
      terrain: undefined,
      portalsPlayerAvatar: undefined,
      state: 'playing',
    } as never;
    const minimap = new Minimap({} as HTMLElement, fakeEngine);
    expect(minimap.coverageFor(3, 3)).toBe(0);
    // Seed one map's fog grid directly (white-box: the grid is private,
    // the seam under test is the read path, not the tick that fills it).
    const fog = new FogOfWar(8000);
    fog.reveal(0, 0, 150);
    const grids = (minimap as unknown as {
      fogByKey: Map<string, { fog: FogOfWar; discovered: Set<string>; baked: boolean; seq: number }>;
    }).fogByKey;
    grids.set('0,1', { fog, discovered: new Set(), baked: true, seq: 0 });
    const got = minimap.coverageFor(0, 1);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThanOrEqual(1);
    expect(got).toBe(fog.coverage);
    expect(minimap.coverageFor(0, 0)).toBe(0);
    minimap.dispose();
  });
});
