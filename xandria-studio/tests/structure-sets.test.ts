/**
 * Graphics wave 2, workstream C — biome structure sets.
 *
 * - placeStructureSets: deterministic, per-biome sets, hero cluster near
 *   spawn, chunk-deterministic satellite placement (chunkSeed contract),
 *   exclusion-aware, instanced into few buckets, per-chunk collider registry
 * - Structures.structureSets: blueprint-level wiring (biome resolve, grid,
 *   per-map seed)
 * - Instancer.octa: crystal-shard bucket bakes deterministically
 *
 * DOM is stubbed (no jsdom here) — same pattern as landmarks-gfx.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Rng } from '../src/engine/core/Rng';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Instancer } from '../src/engine/gfx/AmberGlow';
import {
  placeStructureSets, STRUCTURE_CHUNK_SALT,
  type StructureSetOpts, type StructureSetKind,
} from '../src/engine/gfx/StructureSets';
import { Structures } from '../src/engine/world/Structures';
import { Terrain } from '../src/engine/world/Terrain';
import { resolveBiomeDef, BIOMES, type BiomeId } from '../src/engine/world/Biomes';
import { chunkSeed } from '../src/engine/world/ChunkGrid';
import { chunkWorldRect, chunkKey, type ChunkGrid } from '../src/engine/world/chunkLayout';
import { deriveMapSeed } from '../src/engine/world/MapGraph';
import { generateSpec } from '../src/generator/generate';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    appendChild(c: any) { el.children.push(c); return c; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new THREE.Vector3() }),
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

const FLAT = () => 0;

function testGrid(cps: number, chunkSize: number): ChunkGrid {
  const half = (cps * chunkSize) / 2;
  const cellsPerChunk = 10;
  return {
    chunksPerSide: cps, cellsPerChunk, chunkSize,
    cell: chunkSize / cellsPerChunk, half, res: cellsPerChunk * cps + 1,
  };
}

function desertOpts(mats: MaterialLibrary, extra: Partial<StructureSetOpts> = {}): StructureSetOpts {
  return {
    mats,
    biome: BIOMES['desert-canyon'],
    heightAt: FLAT,
    mapSeed: 4242,
    quality: 'high',
    half: 128,
    grid: testGrid(4, 64),
    ...extra,
  };
}

function makeMats() {
  const spec = generateSpec('a heroic knight adventure', { seed: 4242, genre: 'third-person-action', environment: 'desert' });
  return { spec, mats: new MaterialLibrary(spec) };
}

function instancedMeshes(root: THREE.Object3D): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o as THREE.InstancedMesh); });
  return out;
}

describe('placeStructureSets determinism', () => {
  it('same seed + opts → same placements AND same baked instance matrices', () => {
    const { mats } = makeMats();
    const run = () => placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats));
    const a = run();
    const b = run();
    expect(a.placed.length).toBeGreaterThan(0);
    expect(a.placed.map((p) => [p.kind, p.pos.x, p.pos.z])).toEqual(
      b.placed.map((p) => [p.kind, p.pos.x, p.pos.z]),
    );
    expect(a.amberAccents).toBe(b.amberAccents);
    expect(a.instancedMeshes).toBe(b.instancedMeshes);
    const ia = instancedMeshes(a.group);
    const ib = instancedMeshes(b.group);
    expect(ia.length).toBe(ib.length);
    for (let i = 0; i < ia.length; i++) {
      expect(ia[i].count).toBe(ib[i].count);
      expect(Array.from(ia[i].instanceMatrix.array)).toEqual(Array.from(ib[i].instanceMatrix.array));
    }
  });

  it('different map seeds diverge', () => {
    const { mats } = makeMats();
    const a = placeStructureSets(new THREE.Scene(), new Rng(1), desertOpts(mats, { mapSeed: 1 }));
    const b = placeStructureSets(new THREE.Scene(), new Rng(1), desertOpts(mats, { mapSeed: 2 }));
    const ka = a.placed.map((p) => [p.pos.x, p.pos.z].join(',')).join(';');
    const kb = b.placed.map((p) => [p.pos.x, p.pos.z].join(',')).join(';');
    expect(ka === kb && a.placed.length > 0).toBe(false);
  });
});

describe('per-map seeding (portals)', () => {
  it('deriveMapSeed maps regenerate identically; neighbors differ', () => {
    const { mats } = makeMats();
    const run = (ws: number, mx: number, my: number) =>
      placeStructureSets(
        new THREE.Scene(), new Rng(9),
        desertOpts(mats, { mapSeed: deriveMapSeed(ws, mx, my) }),
      );
    const a = run(555, 0, 0);
    const b = run(555, 0, 0);
    expect(a.placed.map((p) => [p.kind, p.pos.x, p.pos.z])).toEqual(
      b.placed.map((p) => [p.kind, p.pos.x, p.pos.z]),
    );
    const c = run(555, 1, 0);
    const ka = a.placed.map((p) => p.pos.x.toFixed(3)).join(',');
    const kc = c.placed.map((p) => p.pos.x.toFixed(3)).join(',');
    expect(ka === kc && a.placed.length > 0).toBe(false);
  });
});

describe('chunk-deterministic placement (streaming contract)', () => {
  it('chunk (0,0) placements match a manual chunkSeed re-roll exactly', () => {
    const { mats } = makeMats();
    const mapSeed = 4242;
    const grid = testGrid(4, 64);
    const r = placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats, { mapSeed, grid }));
    // chunk (0,0) is the far corner (x,z < -64) — the hero cluster (≤67m
    // from spawn) can never land there, so every placement in it is a
    // satellite roll. Manual re-roll of the satellite loop for chunk (0,0),
    // mirroring the implementation's rng consumption (desert = single set,
    // flat ground, no exclusion, no water → fully predictable sequence).
    const crng = new Rng(chunkSeed(mapSeed, STRUCTURE_CHUNK_SALT, 0, 0));
    const expected: Array<[StructureSetKind, number, number]> = [];
    if (crng.chance(0.055 * 1)) { // CLUSTER_DENSITY * qMul(high)
      const rect = chunkWorldRect(0, 0, grid);
      const n = crng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const kind = crng.pick(['canyon-ruins'] as StructureSetKind[]); // single-set biome
        const x = rect.x0 + crng.range(0.2, 0.8) * (rect.x1 - rect.x0);
        const z = rect.z0 + crng.range(0.2, 0.8) * (rect.z1 - rect.z0);
        expected.push([kind, x, z]);
      }
    }
    const inChunk = r.placed.filter((p) => p.chunk === chunkKey(0, 0));
    expect(inChunk.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(inChunk[i].kind).toBe(expected[i][0]);
      expect(inChunk[i].pos.x).toBeCloseTo(expected[i][1], 9);
      expect(inChunk[i].pos.z).toBeCloseTo(expected[i][2], 9);
    }
  });

  it('every placed structure is keyed to the chunk that contains it', () => {
    const { mats } = makeMats();
    const grid = testGrid(4, 64);
    const r = placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats, { grid }));
    for (const p of r.placed) {
      const [cx, cz] = p.chunk.split(',').map(Number);
      const rect = chunkWorldRect(cx, cz, grid);
      expect(p.pos.x).toBeGreaterThanOrEqual(rect.x0 - 1e-6);
      expect(p.pos.x).toBeLessThanOrEqual(rect.x1 + 1e-6);
      expect(p.pos.z).toBeGreaterThanOrEqual(rect.z0 - 1e-6);
      expect(p.pos.z).toBeLessThanOrEqual(rect.z1 + 1e-6);
    }
  });

  it('collidersByChunk covers exactly the placed structures', () => {
    const { mats } = makeMats();
    const r = placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats));
    let total = 0;
    for (const [, list] of r.collidersByChunk) {
      total += list.length;
      for (const c of list) {
        expect(c.size.length).toBe(3);
        expect(c.pos.length).toBe(3);
        expect(c.size.every(Number.isFinite)).toBe(true);
      }
    }
    expect(total).toBe(r.placed.length);
    const placedChunks = new Set(r.placed.map((p) => p.chunk));
    expect(new Set(r.collidersByChunk.keys())).toEqual(placedChunks);
  });
});

describe('composition rules', () => {
  it('hero cluster: structures within 60m of spawn on every tier', () => {
    const { mats } = makeMats();
    for (const quality of ['retro', 'standard', 'high'] as const) {
      const r = placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats, { quality }));
      const near = r.placed.filter((p) => Math.hypot(p.pos.x, p.pos.z) < 60);
      expect(near.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('exclusion zones are respected', () => {
    const { mats } = makeMats();
    const r = placeStructureSets(
      new THREE.Scene(), new Rng(777),
      desertOpts(mats, { exclusion: [{ x: 40, z: -30, r: 50 }] }),
    );
    for (const p of r.placed) {
      expect(Math.hypot(p.pos.x - 40, p.pos.z + 30) >= 50 + p.radius).toBe(true);
    }
  });

  it('quality scales satellite density, hero cluster always placed', () => {
    const { mats } = makeMats();
    const counts: Record<string, number> = {};
    for (const quality of ['retro', 'standard', 'high'] as const) {
      const r = placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats, { quality }));
      counts[quality] = r.clusters;
    }
    expect(counts.high).toBeGreaterThanOrEqual(counts.standard);
    expect(counts.standard).toBeGreaterThanOrEqual(counts.retro);
  });
});

describe('biome coverage', () => {
  const EXPECTED: Record<BiomeId, StructureSetKind[]> = {
    'plains': ['watchtower'],
    'desert-canyon': ['canyon-ruins'],
    'forest': ['watchtower'],
    'snow': ['shrine'],
    'volcanic': ['obsidian-spire'],
    'coastline': ['lighthouse', 'dock'],
    'caves': ['crystal-formation'],
  };
  for (const id of Object.keys(EXPECTED) as BiomeId[]) {
    it(`biome ${id} fields only its authored set`, () => {
      const { mats } = makeMats();
      // coastline docks need water; give every biome a water level so the
      // dock path is exercised where applicable
      const r = placeStructureSets(
        new THREE.Scene(), new Rng(4242),
        desertOpts(mats, { biome: BIOMES[id], waterLevel: -1 }),
      );
      expect(r.placed.length).toBeGreaterThan(0);
      for (const p of r.placed) {
        expect(EXPECTED[id]).toContain(p.kind);
      }
    });
  }

  it('coastline places docks only near water', () => {
    const { mats } = makeMats();
    // high flat ground (y=10) with water at y=-1 → no shoreline → docks
    // fall back to lighthouses
    const high = () => 10;
    const r = placeStructureSets(
      new THREE.Scene(), new Rng(4242),
      desertOpts(mats, { biome: BIOMES['coastline'], waterLevel: -1, heightAt: high }),
    );
    for (const p of r.placed) {
      expect(p.kind).toBe('lighthouse');
    }
    // no water at all → lighthouses only
    const r2 = placeStructureSets(
      new THREE.Scene(), new Rng(4242),
      desertOpts(mats, { biome: BIOMES['coastline'] }),
    );
    for (const p of r2.placed) expect(p.kind).toBe('lighthouse');
  });
});

describe('instancing discipline', () => {
  it('whole-map structure bake stays within a handful of buckets', () => {
    const { mats } = makeMats();
    const r = placeStructureSets(
      new THREE.Scene(), new Rng(4242),
      desertOpts(mats, { grid: testGrid(8, 64), half: 256 }),
    );
    expect(r.placed.length).toBeGreaterThan(5);
    // rock + dark + amber (+ teal for caves) — flat vs structure count
    expect(r.instancedMeshes).toBeLessThanOrEqual(5);
    for (const im of instancedMeshes(r.group)) {
      expect(mats.ownsMaterial(im.material as THREE.Material)).toBe(true);
    }
  });

  it('amber accents are registered for rune rings', () => {
    const { mats } = makeMats();
    const r = placeStructureSets(new THREE.Scene(), new Rng(777), desertOpts(mats));
    expect(r.amberAccents).toBeGreaterThan(0);
  });

  it('Instancer.octa bakes deterministically into its own bucket', () => {
    const { mats } = makeMats();
    const amber = mats.glow('#59d8ff', 2.0);
    const seq = (inst: Instancer) => {
      inst.octa(amber, 1, 2, 3, 0.5, 2, 0.5, 0.4, false);
      inst.octa(amber, 4, 2, 1, 0.7, 3, 0.7, 1.1, false);
    };
    const g1 = new THREE.Group(); const i1 = new Instancer(); seq(i1); const m1 = i1.bake(g1);
    const g2 = new THREE.Group(); const i2 = new Instancer(); seq(i2); const m2 = i2.bake(g2);
    expect(m1.length).toBe(1);
    expect(m1[0].count).toBe(2);
    expect(Array.from(m1[0].instanceMatrix.array)).toEqual(Array.from(m2[0].instanceMatrix.array));
  });
});

describe('Structures.structureSets wiring', () => {
  it('resolves the biome and seeds from the map seed', () => {
    const spec = generateSpec('a heroic knight adventure', { seed: 31337, genre: 'third-person-action', environment: 'desert' });
    // pin the biome via the Studio override (the seeded roll can alternate)
    spec.custom = { ...(spec.custom ?? {}), biome: { biomeId: 'desert-canyon' } } as typeof spec.custom;
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const structures = new Structures(physics, mats);
    const result = structures.structureSets(spec, terrain, scene, spec.meta.seed, {
      exclusion: [{ x: 0, z: 0, r: 12 }], quality: 'standard',
    });
    const biome = resolveBiomeDef(spec);
    expect(biome.id).toBe('desert-canyon');
    expect(result.placed.length).toBeGreaterThan(0);
    for (const p of result.placed) expect(p.kind).toBe('canyon-ruins');
    // hero cluster near spawn
    expect(result.placed.some((p) => Math.hypot(p.pos.x, p.pos.z) < 60)).toBe(true);
    // same map seed → same placements
    const scene2 = new THREE.Scene();
    const structures2 = new Structures(physics, mats);
    const r2 = structures2.structureSets(spec, terrain, scene2, spec.meta.seed, {
      exclusion: [{ x: 0, z: 0, r: 12 }], quality: 'standard',
    });
    expect(r2.placed.map((p) => [p.kind, p.pos.x, p.pos.z])).toEqual(
      result.placed.map((p) => [p.kind, p.pos.x, p.pos.z]),
    );
  });
});
