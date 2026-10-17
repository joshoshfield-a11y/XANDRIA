/**
 * Graphics wave 2, workstream B (plants):
 * - biome-distinct undergrowth baked into foliage LOD geometry (vertex colors,
 *   aSway wind weights; LOD0 full / LOD1 reduced / LOD2 none)
 * - hero specimen plants near landmarks (oversized, amber instance-color tint,
 *   own rng stream, per-chunk caps)
 * - draw-call flatness invariant: no new species tiers, no new InstancedMeshes
 * - placement determinism preserved (byte-identical without heroSpots)
 *
 * DOM is stubbed (no jsdom) — same pattern as drawcall-diet.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Terrain } from '../src/engine/world/Terrain';
import { Vegetation, undergrowthFor, type HeroSpot } from '../src/engine/world/Vegetation';
import { Scatter } from '../src/engine/world/Scatter';
import { scatterGrid } from '../src/engine/world/ChunkGrid';
import { chunkWorldRect } from '../src/engine/world/chunkLayout';
import { HERO_CHUNK_CAP } from '../src/engine/world/PropSets';
import { generateSpec } from '../src/generator/generate';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    appendChild(c: any) { el.children.push(c); return c; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
  return el;
}

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
  };
});

const ORIGINAL_SPECIES = ['pine', 'oak', 'palm', 'cactus', 'deadtree', 'mushroom', 'crystalflora'];

function buildSpec(seed: number, biomeId: string, size = 220): any {
  const spec: any = generateSpec('a heroic knight adventure through ancient forest ruins', { seed });
  spec.world.terrain.size = size;
  spec.world.terrain.type = 'hills';
  spec.world.portals = { enabled: false };
  spec.world.scatter.trees = true;
  spec.custom = { ...(spec.custom ?? {}), biome: { biomeId } };
  return spec;
}

function buildVegetation(seed: number, biomeId: string, heroSpots: HeroSpot[] = [], size = 220) {
  const spec = buildSpec(seed, biomeId, size);
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  const colliders: { x: number; z: number; r: number }[] = [];
  // fixed count for stable assertions (bypasses the area formula)
  const veg = new Vegetation(spec, terrain, mats, scene, {
    exclusion: [{ x: 0, z: 0, r: 12 }],
    physics,
    colliders,
    count: 400,
    heroSpots,
  });
  veg.update(0.35, new THREE.Vector3(0, 0, 0)); // force a rebucket
  return { spec, veg: veg as any, scene, colliders };
}

function tiersOf(veg: any) {
  return veg.tiers as { mesh: THREE.InstancedMesh; sp: string; lod: 0 | 1 | 2; foliage: boolean }[];
}

/** count of non-white (undergrowth) vertices in a geometry */
function tintedVerts(geo: THREE.BufferGeometry): number {
  const c = geo.getAttribute('color');
  if (!c) return -1;
  let n = 0;
  for (let i = 0; i < c.count; i++) {
    if (Math.abs(c.getX(i) - 1) > 0.01 || Math.abs(c.getY(i) - 1) > 0.01 || Math.abs(c.getZ(i) - 1) > 0.01) n++;
  }
  return n;
}

describe('undergrowth table', () => {
  it('assigns biome-distinct undergrowth per species', () => {
    expect(undergrowthFor('forest', 'oak')).toContain('flower');
    expect(undergrowthFor('forest', 'oak')).toContain('shrub');
    expect(undergrowthFor('plains', 'pine')).toEqual(['flower', 'shrub']);
    expect(undergrowthFor('desert-canyon', 'cactus')).toEqual(['scrub']);
    expect(undergrowthFor('snow', 'pine')).toEqual(['snowshrub']);
    expect(undergrowthFor('volcanic', 'crystalflora')).toEqual(['ember']);
    expect(undergrowthFor('volcanic', 'deadtree')).toEqual(['ashscrub']);
    expect(undergrowthFor('coastline', 'palm')).toEqual(['flower', 'shrub']);
    expect(undergrowthFor('caves', 'mushroom')).toContain('fungi');
    expect(undergrowthFor('caves', 'crystalflora')).toEqual(['frostshard']);
  });
});

describe('undergrowth geometry', () => {
  it('foliage geometries carry color + aSway attributes; materials use vertex colors', () => {
    const { veg } = buildVegetation(4242, 'forest');
    const tiers = tiersOf(veg).filter((t) => t.foliage);
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      expect(t.mesh.geometry.getAttribute('color'), `${t.sp} LOD${t.lod}`).toBeTruthy();
      expect(t.mesh.geometry.getAttribute('aSway'), `${t.sp} LOD${t.lod}`).toBeTruthy();
      expect((t.mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    }
  });

  it('LOD0 foliage has tinted undergrowth verts; LOD2 has none', () => {
    const { veg } = buildVegetation(4242, 'forest');
    const tiers = tiersOf(veg).filter((t) => t.foliage);
    const lod0 = tiers.filter((t) => t.lod === 0);
    const lod2 = tiers.filter((t) => t.lod === 2);
    expect(lod0.length).toBeGreaterThan(0);
    // every LOD0 foliage tier in forest (flowers+shrubs) carries undergrowth
    for (const t of lod0) expect(tintedVerts(t.mesh.geometry), `${t.sp}`).toBeGreaterThan(0);
    for (const t of lod2) expect(tintedVerts(t.mesh.geometry), `${t.sp} LOD2`).toBe(0);
  });

  it('volcanic ember undergrowth rides the glowing crystalflora material', () => {
    const { veg } = buildVegetation(4242, 'volcanic');
    const tiers = tiersOf(veg).filter((t) => t.foliage && t.lod === 0);
    const crystal = tiers.find((t) => t.sp === 'crystalflora')!;
    expect(crystal).toBeTruthy();
    expect(tintedVerts(crystal.mesh.geometry)).toBeGreaterThan(0);
    const m = crystal.mesh.material as THREE.MeshStandardMaterial;
    expect(m.emissiveIntensity).toBeGreaterThan(1); // glow → ember shards glow
    expect(m.vertexColors).toBe(true);
  });

  it('cave fungi ride the mushroom foliage material', () => {
    const { veg } = buildVegetation(4242, 'caves');
    const tiers = tiersOf(veg).filter((t) => t.foliage && t.lod === 0);
    const mush = tiers.find((t) => t.sp === 'mushroom')!;
    expect(mush).toBeTruthy();
    expect(tintedVerts(mush.mesh.geometry)).toBeGreaterThan(0);
  });
});

describe('wind sway (vertex shader, zero per-frame CPU)', () => {
  it('foliage materials (except crystalflora) carry the v2 wind injection', () => {
    const { veg } = buildVegetation(4242, 'forest');
    const tiers = tiersOf(veg).filter((t) => t.foliage);
    for (const t of tiers) {
      const key = (t.mesh.material as any).customProgramCacheKey?.();
      expect(key, `${t.sp}`).toBe('xandria-wind-v2');
    }
  });

  it('crystalflora stays rigid (no wind injection)', () => {
    const { veg } = buildVegetation(4242, 'volcanic');
    const tiers = tiersOf(veg).filter((t) => t.foliage && t.sp === 'crystalflora');
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      expect((t.mesh.material as any).customProgramCacheKey?.()).not.toBe('xandria-wind-v2');
    }
  });

  it('undergrowth verts have boosted aSway so small plants visibly move', () => {
    const { veg } = buildVegetation(4242, 'forest');
    const tiers = tiersOf(veg).filter((t) => t.foliage && t.lod === 0);
    for (const t of tiers) {
      const g = t.mesh.geometry;
      const sway = g.getAttribute('aSway');
      const color = g.getAttribute('color');
      let boosted = 0;
      for (let i = 0; i < sway.count; i++) {
        const tinted = Math.abs(color.getX(i) - 1) > 0.01 || Math.abs(color.getY(i) - 1) > 0.01;
        if (tinted && sway.getX(i) > 0.2) boosted++;
      }
      expect(boosted, `${t.sp} boosted undergrowth verts`).toBeGreaterThan(0);
    }
  });
});

describe('draw-call flatness (binding perf rule)', () => {
  it('adds no new species tiers: forest = pine+oak × 3 LODs × trunk/foliage', () => {
    const { veg } = buildVegetation(4242, 'forest');
    const tiers = tiersOf(veg);
    for (const t of tiers) expect(ORIGINAL_SPECIES).toContain(t.sp);
    expect(new Set(tiers.map((t) => t.sp))).toEqual(new Set(['pine', 'oak']));
    expect(tiers.length).toBe(2 * 3 * 2);
  });

  it('volcanic = deadtree × 5 + crystalflora × 3 (deadtree LOD2 foliage is null, pre-existing)', () => {
    const { veg } = buildVegetation(4242, 'volcanic');
    const tiers = tiersOf(veg);
    for (const t of tiers) expect(ORIGINAL_SPECIES).toContain(t.sp);
    // deadtree: trunk×3 + foliage×2 (LOD2 null — same as before wave 2B);
    // crystalflora: foliage×3 (no trunk tier)
    expect(tiers.length).toBe(8);
  });

  it('heroes add no tier meshes either (they ride the biome species tier)', () => {
    const noHero = buildVegetation(4242, 'forest', []);
    const withHero = buildVegetation(4242, 'forest', [{ x: 40, z: -30, r: 6 }]);
    expect(tiersOf(withHero.veg).length).toBe(tiersOf(noHero.veg).length);
  });
});

describe('hero specimens', () => {
  it('places one oversized amber-tinted hero of the biome species near the spot', () => {
    const spots = [{ x: 40, z: -30, r: 6 }];
    const { veg, colliders } = buildVegetation(4242, 'forest', spots);
    const heroes = veg.instances.filter((i: any) => i.hero);
    expect(heroes.length).toBe(1);
    const h = heroes[0];
    expect(h.sp).toBe('oak'); // forest hero species
    expect(h.scale).toBeGreaterThanOrEqual(2.6);
    expect(h.scale).toBeLessThanOrEqual(3.4);
    // ringed around the landmark: 11–20m from the spot center
    const d = Math.hypot(h.x - spots[0].x, h.z - spots[0].z);
    expect(d).toBeGreaterThanOrEqual(11);
    expect(d).toBeLessThanOrEqual(20);
    // hero collider registered on the shared array
    expect(colliders.length).toBeGreaterThan(400);
    const hc = colliders[colliders.length - 1];
    expect(hc.x).toBe(h.x);
  });

  it('hero foliage instances get the amber instance-color tint', () => {
    const { veg } = buildVegetation(4242, 'forest', [{ x: 40, z: -30, r: 6 }]);
    const tiers = tiersOf(veg).filter((t) => t.foliage);
    const tinted = tiers.filter((t) => t.mesh.instanceColor);
    expect(tinted.length).toBeGreaterThan(0);
    // at least one non-white instance color exists (the hero)
    let nonWhite = 0;
    const c = new THREE.Color();
    for (const t of tinted) {
      for (let i = 0; i < t.mesh.count; i++) {
        t.mesh.getColorAt(i, c);
        if (Math.abs(c.r - 1) > 0.01 || Math.abs(c.g - 1) > 0.01 || Math.abs(c.b - 1) > 0.01) nonWhite++;
      }
    }
    expect(nonWhite).toBeGreaterThan(0);
  });

  it('is deterministic: same seed + spots → same hero placement', () => {
    const spots = [{ x: 40, z: -30, r: 6 }, { x: -50, z: 25, r: 8 }];
    const a = buildVegetation(777, 'desert-canyon', spots);
    const b = buildVegetation(777, 'desert-canyon', spots);
    const ser = (v: any) => v.instances.map((i: any) =>
      [i.x.toFixed(4), i.y.toFixed(4), i.z.toFixed(4), i.rot.toFixed(4), i.scale.toFixed(4), i.sp, i.hero ? 1 : 0].join(',')).join(';');
    expect(ser(a.veg)).toBe(ser(b.veg));
    // desert-canyon hero species is cactus
    expect(a.veg.instances.filter((i: any) => i.hero).every((i: any) => i.sp === 'cactus')).toBe(true);
  });

  it('skips heroes when the biome hero species is not in the mix', () => {
    const spec = buildSpec(4242, 'forest');
    spec.custom.biome.floraMix = { pine: 10 }; // oak (forest hero) excluded
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const veg = new Vegetation(spec, terrain, mats, scene, {
      physics, count: 200, heroSpots: [{ x: 40, z: -30, r: 6 }],
    }) as any;
    expect(veg.instances.filter((i: any) => i.hero).length).toBe(0);
  });

  it('without heroSpots, placement is byte-identical (existing contract)', () => {
    const ser = (v: any) => v.instances.map((i: any) =>
      [i.x, i.y, i.z, i.rot, i.scale, i.sp].join(',')).join(';');
    const a = buildVegetation(20261012, 'forest', []);
    const b = buildVegetation(20261012, 'forest', []);
    expect(ser(a.veg)).toBe(ser(b.veg));
  });
});

describe('chunked streaming heroes', () => {
  function buildBig(heroSpots: HeroSpot[]) {
    const spec = buildSpec(20261012, 'forest', 1500);
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const scatter = new Scatter(spec, terrain, mats, physics, scene, {
      exclusion: [{ x: 0, z: 0, r: 12 }],
      quality: 'retro',
      heroSpots,
    });
    return { scatter, terrain };
  }

  it('places heroes per chunk with the per-chunk cap; unload removes them', () => {
    // chunk (2,2) of the 1500m/6×250m grid covers x,z ∈ [-250, 0)
    const grid = scatterGrid(buildBig([]).terrain);
    const rect = chunkWorldRect(2, 2, grid);
    expect(rect.x0).toBe(-250);
    const spots: HeroSpot[] = [];
    for (let i = 0; i < 10; i++) spots.push({ x: -240 + i, z: -240 + i * 2, r: 5 });
    const { scatter } = buildBig(spots);
    const c = scatter.chunked!;
    c.loadChunk(2, 2);
    const veg: any = c.vegetation!;
    const heroes = veg.chunkInstances(2, 2).filter((i: any) => i.hero);
    expect(heroes.length).toBeGreaterThan(0);
    expect(heroes.length).toBeLessThanOrEqual(HERO_CHUNK_CAP);
    expect(heroes.every((i: any) => i.sp === 'oak')).toBe(true);
    // chunk (0,0) has no spots → no heroes there
    c.loadChunk(0, 0);
    expect(veg.chunkInstances(0, 0).filter((i: any) => i.hero).length).toBe(0);
    // unload drops the heroes with the chunk; resident total = sum over loaded chunks
    const before = veg.instanceCount;
    const unloaded = veg.chunkInstances(2, 2).length;
    c.unloadChunk(2, 2);
    expect(veg.chunkInstances(2, 2).length).toBe(0);
    expect(veg.instanceCount).toBe(before - unloaded);
    let sum = 0;
    for (const k of c.loadedKeys()) {
      const [cx, cz] = k.split(',').map(Number);
      sum += veg.chunkInstances(cx, cz).length;
    }
    expect(veg.instanceCount).toBe(sum);
  });

  it('chunked hero placement is deterministic across load orders', () => {
    const spots: HeroSpot[] = [{ x: -100, z: -100, r: 6 }];
    const ser = (v: any) => v.chunkInstances(2, 2).map((i: any) =>
      [i.x.toFixed(4), i.z.toFixed(4), i.scale.toFixed(4), i.sp, i.hero ? 1 : 0].join(',')).join(';');
    const a = buildBig(spots).scatter.chunked!;
    a.loadChunk(2, 2); a.loadChunk(0, 0);
    const b = buildBig(spots).scatter.chunked!;
    b.loadChunk(0, 0); b.loadChunk(2, 2);
    expect(ser(a.vegetation)).toBe(ser(b.vegetation));
  });
});
