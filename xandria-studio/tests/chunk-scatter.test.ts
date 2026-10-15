/**
 * Workstream C (open-world stage 1) — scatter / vegetation / grass streaming.
 *
 * C1 — byte-identical legacy worlds: worlds <= 256m keep the whole-world
 * build path verbatim. The expected hashes below were captured from the
 * pre-refactor code (tests/zz-baseline.test.ts, since removed); any change in
 * placement, rng streams, collider order, or set contents fails loudly.
 *
 * C2 — chunked streaming (worlds > 256m): per-chunk seed determinism (same
 * chunk → same placements across runs and load orders), per-chunk density
 * budgets, load/unload streaming with hysteresis, draw-call parity (global
 * pools, not per-chunk meshes).
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Scatter } from '../src/engine/world/Scatter';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import {
  chunkSeed, scatterGrid,
  SCATTER_LOAD_RADIUS, SCATTER_UNLOAD_RADIUS, MAX_RESIDENT_CHUNKS,
} from '../src/engine/world/ChunkGrid';
import { chunkKey, chunkWorldRect, chunkRectDistance } from '../src/engine/world/chunkLayout';
import { GRASS_CHUNK_BUDGET } from '../src/engine/world/Grass';
import { TREE_SPECIES_CHUNK_CAP } from '../src/engine/world/PropSets';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag, children: [] as any[], style: {} as Record<string, string>,
    appendChild(c: any) { el.children.push(c); return c; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
  return el;
}
beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head') };
});

function fnv(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function fhash(arr: ArrayLike<number>, n: number): string {
  let h = 2166136261;
  const dv = new DataView(new Float32Array(1).buffer);
  for (let i = 0; i < n; i++) {
    dv.setFloat32(0, arr[i], true);
    h ^= dv.getUint32(0, true); h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface Built {
  scatter: Scatter;
  spec: any;
  physics: any;
  scene: THREE.Scene;
  mats: MaterialLibrary;
  terrain: Terrain;
}

function build(intent: string, seed: number, size: number, type: string, opts: any, quality: any, forceTrees = false): Built {
  const spec: any = generateSpec(intent, { seed });
  spec.world.terrain.size = size;
  spec.world.terrain.type = type;
  // legacy-path test: the pre-refactor reference predates the portals wave
  spec.world.portals = { enabled: false };
  if (forceTrees) spec.world.scatter.trees = true;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  const scatter = new Scatter(spec, terrain, mats, physics, scene, { ...opts, quality });
  return { scatter, spec, physics, scene, mats, terrain };
}

function checksum(scatter: Scatter): string {
  const parts: string[] = [];
  for (const s of scatter.sets) {
    const m = s.mesh;
    parts.push(`${s.tag}:${m.count}:${fhash(m.instanceMatrix.array, m.count * 16)}`);
  }
  parts.push(`colliders:${scatter.colliders.length}:${fhash(scatter.colliders.flatMap(c => [c.x, c.z, c.r]), scatter.colliders.length * 3)}`);
  if (scatter.vegetation) {
    const v: any = scatter.vegetation;
    parts.push(`veg:${v.instances.length}:${fhash(v.instances.flatMap((i: any) => [i.x, i.y, i.z, i.rot, i.scale]), v.instances.length * 5)}`);
    parts.push(`vegtiers:${v.tiers.length}:${v.tiers.map((t: any) => t.mesh.count).join(',')}`);
  } else parts.push('veg:none');
  if (scatter.grass) {
    const g: any = scatter.grass;
    parts.push(`grass:${g.count}:${g.mesh ? fhash(g.mesh.instanceMatrix.array, g.count * 16) : 'x'}`);
  } else parts.push('grass:none');
  return fnv(parts.join('|'));
}

describe('C1 — small worlds generate byte-identical scatter', () => {
  const cases = [
    { name: 'tp-220', intent: 'a heroic knight adventure through ancient forest ruins', seed: 20261012, size: 220, type: 'hills', opts: { exclusion: [{ x: 0, z: 0, r: 12 }] }, quality: 'retro', forceTrees: true, hash: '00533ae0' },
    { name: 'fps-220', intent: 'neon arena shooter showdown', seed: 777, size: 220, type: 'flat', opts: { heroesOnly: true, exclusion: [{ x: 0, z: 0, r: 10 }] }, quality: 'high', forceTrees: false, hash: '9062ec16' },
    { name: 'plat-220', intent: 'floating sky platforms precision jumper', seed: 4242, size: 220, type: 'platforms', opts: { heroesOnly: true }, quality: 'standard', forceTrees: false, hash: '1ff320bc' },
    { name: 'td-220', intent: 'top down alien horde survival', seed: 31337, size: 220, type: 'hills', opts: { exclusion: [{ x: 0, z: 0, r: 20 }], heroExclusion: [{ x: 0, z: 0, r: 8 }] }, quality: 'retro', forceTrees: true, hash: '78005714' },
  ];
  for (const c of cases) {
    it(`${c.name}: placement identical to pre-refactor`, () => {
      const { scatter } = build(c.intent, c.seed, c.size, c.type, c.opts, c.quality, c.forceTrees);
      expect(scatter.chunked).toBeNull(); // legacy path taken
      expect(checksum(scatter)).toBe(c.hash);
    });
  }
  it('256m boundary still takes the legacy path', () => {
    const { scatter } = build('a heroic knight adventure', 42, 256, 'hills', {}, 'retro', true);
    expect(scatter.chunked).toBeNull();
  });
});

function buildBig() {
  return build('a heroic knight adventure through ancient forest ruins', 20261012, 1500, 'hills',
    { exclusion: [{ x: 0, z: 0, r: 12 }] }, 'retro', true);
}

describe('C2 — chunked streaming', () => {
  it('chunkSeed(…,0,0) reproduces the legacy subsystem seeds', () => {
    const s = 20261012;
    expect(chunkSeed(s, 0x5ca7, 0, 0)).toBe((s ^ 0x5ca7) >>> 0); // scatter
    expect(chunkSeed(s, 0xbe09, 0, 0)).toBe((s ^ 0xbe09) >>> 0); // vegetation
    expect(chunkSeed(s, 0x6a55, 0, 0)).toBe((s ^ 0x6a55) >>> 0); // grass
    // distinct chunks → distinct seeds (no cross-chunk correlation)
    const seeds = new Set<string>();
    for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) seeds.add(String(chunkSeed(s, 0x5ca7, cx, cz)));
    expect(seeds.size).toBe(49);
  });

  it('big worlds take the chunked path with global pools', () => {
    const { scatter } = buildBig();
    expect(scatter.chunked).not.toBeNull();
    expect(scatter.chunked!.loadedChunkCount).toBeGreaterThan(1);
    expect(scatter.chunked!.loadedChunkCount).toBeLessThanOrEqual(MAX_RESIDENT_CHUNKS);
  });

  it('same chunk → same placements across load orders and runs', () => {
    const serVeg = (v: any) => v.chunkInstances(2, 2).map((i: any) =>
      [i.x, i.y, i.z, i.rot, i.scale, i.sp].join(',')).join(';');
    const a = buildBig().scatter.chunked!;
    a.loadChunk(2, 2);
    a.loadChunk(0, 0);
    const rocksA = a.chunkMatrices('rocks', 2, 2);
    const vegA = serVeg(a.vegetation);
    const grassA = a.grass!.chunkMatrices(2, 2);

    const b = buildBig().scatter.chunked!;
    b.loadChunk(0, 0); // reversed order
    b.loadChunk(2, 2);
    const rocksB = b.chunkMatrices('rocks', 2, 2);
    const vegB = serVeg(b.vegetation);
    const grassB = b.grass!.chunkMatrices(2, 2);

    expect(rocksA).not.toBeNull();
    expect([...rocksA!]).toEqual([...rocksB!]);
    expect(vegA).toBe(vegB);
    expect(grassA).not.toBeNull();
    expect([...grassA!]).toEqual([...grassB!]);
  });

  it('unload then reload reproduces the chunk exactly (swap-remove is sound)', () => {
    const c = buildBig().scatter.chunked!;
    c.loadChunk(2, 2);
    const before = [...c.chunkMatrices('rocks', 2, 2)!];
    const vegBefore = (c.vegetation as any).chunkInstances(2, 2).map((i: any) => [i.x, i.z].join(',')).join(';');
    c.unloadChunk(2, 2);
    expect(c.chunkMatrices('rocks', 2, 2)).toBeNull();
    c.loadChunk(2, 2);
    expect([...c.chunkMatrices('rocks', 2, 2)!]).toEqual(before);
    expect((c.vegetation as any).chunkInstances(2, 2).map((i: any) => [i.x, i.z].join(',')).join(';')).toBe(vegBefore);
  });

  it('per-chunk density budgets are respected', () => {
    const c = buildBig().scatter.chunked!;
    c.loadChunk(2, 2);
    c.loadChunk(0, 0);
    const budgets = c.setBudgets();
    for (const key of c.loadedKeys()) {
      const [cx, cz] = key.split(',').map(Number);
      for (const [setKey, n] of Object.entries(c.chunkCounts(cx, cz))) {
        expect(n, `${setKey} in chunk ${key}`).toBeLessThanOrEqual(budgets[setKey]);
      }
      expect(c.grass!.chunkCount(cx, cz), `grass in chunk ${key}`).toBeLessThanOrEqual(GRASS_CHUNK_BUDGET);
      // per-species tree cap
      const perSpecies = new Map<string, number>();
      for (const i of (c.vegetation as any).chunkInstances(cx, cz)) {
        perSpecies.set(i.sp, (perSpecies.get(i.sp) ?? 0) + 1);
      }
      for (const [sp, n] of perSpecies) {
        expect(n, `species ${sp} in chunk ${key}`).toBeLessThanOrEqual(TREE_SPECIES_CHUNK_CAP);
      }
    }
  });

  it('streaming unloads distant chunks and keeps hysteresis', () => {
    const h = buildBig();
    const grid = scatterGrid(h.terrain);
    const c = h.scatter.chunked!;
    const n0 = c.loadedChunkCount;
    expect(n0).toBeGreaterThan(0);
    const res0 = c.residentInstances;
    // teleport within the world: every resident chunk rect must sit inside the
    // unload radius of the new focus (canonical rect distance)
    c.update(new THREE.Vector3(700, 0, 0));
    const keys = c.loadedKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(MAX_RESIDENT_CHUNKS);
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number);
      expect(chunkRectDistance(cx, cz, 700, 0, grid)).toBeLessThanOrEqual(SCATTER_UNLOAD_RADIUS);
    }
    // resident set is bounded: far fewer instances than a whole 1500m world would hold
    expect(c.residentInstances).toBeLessThan(res0 * 1.5);

    // hysteresis: 600m move keeps chunk (2,3) (600m < 688) but unloads
    // chunk (1,2) (850m > 688)
    const c2 = buildBig().scatter.chunked!;
    c2.update(new THREE.Vector3(600, 0, 0));
    expect(c2.loadedKeys()).toContain('2,3');
    expect(c2.loadedKeys()).not.toContain('1,2');
  });

  it('draw calls are flat: same instanced-mesh count as the legacy path', () => {
    const big = buildBig().scatter;
    const small = build('a heroic knight adventure through ancient forest ruins', 20261012, 220, 'hills',
      { exclusion: [{ x: 0, z: 0, r: 12 }] }, 'retro', true).scatter;
    // one global pool per set — identical mesh count to the legacy sets
    expect(big.sets.length).toBe(small.sets.length);
    expect(big.sets.map(s => s.tag).sort()).toEqual(small.sets.map(s => s.tag).sort());
    // vegetation tiers: same species coverage → same mesh count
    expect(big.vegetation!['tiers'].length).toBe(small.vegetation!['tiers'].length);
    // grass stays a single mesh
    expect(big.grass).not.toBeNull();
  });

  it('chunk grid follows the canonical A/B layout (1500m -> 6x6 x 250m)', () => {
    const h = buildBig();
    const grid = scatterGrid(h.terrain);
    expect(grid.chunksPerSide).toBe(6);
    expect(grid.chunkSize).toBe(250);
    // chunk (0,0) is the world corner [-750,-500)^2 (world-relative convention)
    const r0 = chunkWorldRect(0, 0, grid);
    expect(r0.x0).toBe(-750);
    expect(r0.x1).toBe(-500);
    const rLast = chunkWorldRect(5, 5, grid);
    expect(rLast.x1).toBe(750);
    expect(rLast.z1).toBe(750);
    // initial fill around the spawn: every loaded chunk within load radius
    const c = h.scatter.chunked!;
    const keys = c.loadedKeys();
    expect(keys.length).toBeGreaterThan(4);
    expect(keys.length).toBeLessThanOrEqual(MAX_RESIDENT_CHUNKS);
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number);
      expect(chunkRectDistance(cx, cz, 0, 0, grid)).toBeLessThanOrEqual(SCATTER_LOAD_RADIUS);
    }
  });
});
