/**
 * Open-world stage 1, worker A — chunked terrain mesh generation.
 *
 * 1. The exported pure height function `terrainHeightAt` reproduces the legacy
 *    in-constructor height loop BIT-IDENTICALLY (same noise calls, same order,
 *    same math) across seeds / terrain types / boundaries / freq / hscale /
 *    flatten settings. The reference below is a verbatim copy of the loop
 *    from Terrain.ts at commit 00474e33 (feature/openworld-stage1 base).
 * 2. Adjacent chunk edge vertices are exactly equal (positions, colors,
 *    normals) on a 1000m world — no cracks, no T-junctions, no lighting seams.
 * 3. Small worlds are a single chunk; chunked builds are deterministic.
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain, terrainHeightAt, TERRAIN_CHUNK_TARGET, type TerrainHeightParams } from '../src/engine/world/Terrain';
import { Noise2D, Rng } from '../src/engine/core/Rng';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
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

function buildTerrain(size: number, seed = 4242, type = 'mountains'): Terrain {
  const spec = generateSpec('a heroic knight adventure', { seed });
  spec.world.terrain.type = type as any;
  spec.world.terrain.size = size;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  return new Terrain(spec, physics, mats, scene);
}

/**
 * Verbatim copy of the pre-chunk height computation (Terrain.ts constructor
 * loop, commit 00474e33) — the ground truth the pure function must match.
 */
function legacyHeightAt(
  p: { seed: number; size: number; type: string; maxHeight: number; roughness: number; freq: number; hscale: number; flatCenters: Array<{ x: number; y: number; z: number }>; flatRadius: number; boundary: string },
  x: number, z: number,
): number {
  const noise = new Noise2D(p.seed);
  let y = 0;
  const nx = x / p.size, nz = z / p.size;
  const base = noise.fbm(nx * 3 * p.freq + 10, nz * 3 * p.freq + 10, 5, 2, 0.5);
  switch (p.type) {
    case 'flat': y = base * 0.6; break;
    case 'hills': y = (base + 0.3) * p.maxHeight * (0.4 + p.roughness * 0.6); break;
    case 'mountains': y = Math.pow(Math.abs(base) + 0.15, 1.6) * p.maxHeight * 1.4 * (0.5 + p.roughness); break;
    case 'canyon': { const r = Math.abs(noise.get(nx * 2 * p.freq, nz * 2 * p.freq + 5)); y = (r < 0.18 ? -0.6 : 0.8 + base * 0.5) * p.maxHeight; break; }
    case 'islands': { const d = Math.hypot(nx, nz) * 2; y = (base + 0.35 - d * d * 0.9) * p.maxHeight; break; }
    case 'platforms': y = Math.round((base + 1) * 3) * (p.maxHeight / 6); break;
  }
  y *= p.hscale;
  const edge = Math.max(Math.abs(nx), Math.abs(nz)) * 2; // 0..1
  if (p.boundary === 'cliffs') y -= Math.pow(Math.max(0, edge - 0.85) / 0.15, 2) * 40;
  else if (p.boundary === 'walls') y += Math.pow(Math.max(0, edge - 0.9) / 0.1, 2) * p.maxHeight * 0.8;
  const flatR = p.flatRadius;
  for (const c of p.flatCenters) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < flatR * 1.8) { const k = THREE.MathUtils.smoothstep(d, flatR * 0.6, flatR * 1.8); y = THREE.MathUtils.lerp(c.y, y, k); }
  }
  return y;
}

describe('terrainHeightAt reproduces the legacy height loop bit-identically', () => {
  const types = ['flat', 'hills', 'mountains', 'canyon', 'islands', 'platforms'];
  const boundaries = ['cliffs', 'walls', 'wrap'];
  it.each(types)('type=%s', (type) => {
    const rng = new Rng(1234);
    for (const boundary of boundaries) {
      for (const freq of [0.5, 1, 2]) {
        for (const hscale of [0.75, 1, 1.5]) {
          const p: TerrainHeightParams = {
            seed: 4242, size: 1000, type, maxHeight: 14, roughness: 0.5,
            freq, hscale,
            flatCenters: [{ x: 0, y: 0, z: 0 }],
            flatRadius: Math.max(14, 1000 * 0.08), boundary,
          };
          // 200+ random points across the world, incl. edges and flatten zone
          for (let k = 0; k < 210; k++) {
            const x = rng.range(-500, 500), z = rng.range(-500, 500);
            expect(terrainHeightAt(p, x, z), `${type}/${boundary}/f${freq}/h${hscale} @(${x},${z})`).toBe(legacyHeightAt(p, x, z));
          }
        }
      }
    }
  });

  it('covers custom flatten centers, non-zero spawn height, and other seeds/sizes', () => {
    const rng = new Rng(777);
    for (const seed of [1, 99, 987654321]) {
      for (const size of [220, 400, 1000, 2000]) {
        const p: TerrainHeightParams = {
          seed, size, type: 'mountains', maxHeight: 30, roughness: 0.9,
          freq: 1.25, hscale: 0.8,
          flatCenters: [{ x: 10, y: 2.5, z: -5 }, { x: -300, y: -1, z: 200 }],
          flatRadius: 25, boundary: 'cliffs',
        };
        for (let k = 0; k < 220; k++) {
          const x = rng.range(-size / 2, size / 2), z = rng.range(-size / 2, size / 2);
          expect(terrainHeightAt(p, x, z), `seed=${seed} size=${size} @(${x},${z})`).toBe(legacyHeightAt(p, x, z));
        }
      }
    }
  });
});

describe('chunk seams are exact on a 1000m world', () => {
  it('adjacent chunks share bit-identical edge vertices (position, color, normal)', () => {
    const terrain = buildTerrain(1000, 4242, 'mountains');
    const stats = terrain.getChunkStats();
    expect(stats.chunkCount).toBe(16);
    expect(stats.chunkSize).toBe(250);
    expect(terrain.chunkMeshes).toHaveLength(16);
    // row-major: index = cj * 4 + ci
    const at = (ci: number, cj: number) => terrain.chunkMeshes[cj * 4 + ci];
    const vps = 101; // 250m / 2.5m cells + 1
    const check = (a: THREE.BufferAttribute, b: THREE.BufferAttribute, ia: number, ib: number, label: string) => {
      expect(a.getX(ia), `${label}.x`).toBe(b.getX(ib));
      expect(a.getY(ia), `${label}.y`).toBe(b.getY(ib));
      expect(a.getZ(ia), `${label}.z`).toBe(b.getZ(ib));
    };
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        const m = at(ci, cj);
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
        const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
        const nrm = m.geometry.getAttribute('normal') as THREE.BufferAttribute;
        // east neighbor: my right edge (lx=100) == neighbor's left edge (lx=0)
        if (ci < 3) {
          const e = at(ci + 1, cj);
          const ep = e.geometry.getAttribute('position') as THREE.BufferAttribute;
          const ec = e.geometry.getAttribute('color') as THREE.BufferAttribute;
          const en = e.geometry.getAttribute('normal') as THREE.BufferAttribute;
          for (let ly = 0; ly < vps; ly++) {
            check(pos, ep, ly * vps + (vps - 1), ly * vps, `E-seam(${ci},${cj}) pos ly=${ly}`);
            check(col, ec, ly * vps + (vps - 1), ly * vps, `E-seam(${ci},${cj}) col ly=${ly}`);
            check(nrm, en, ly * vps + (vps - 1), ly * vps, `E-seam(${ci},${cj}) nrm ly=${ly}`);
          }
        }
        // south neighbor: my bottom edge (ly=100) == neighbor's top edge (ly=0)
        if (cj < 3) {
          const s = at(ci, cj + 1);
          const sp = s.geometry.getAttribute('position') as THREE.BufferAttribute;
          const sc = s.geometry.getAttribute('color') as THREE.BufferAttribute;
          const sn = s.geometry.getAttribute('normal') as THREE.BufferAttribute;
          for (let lx = 0; lx < vps; lx++) {
            check(pos, sp, (vps - 1) * vps + lx, lx, `S-seam(${ci},${cj}) pos lx=${lx}`);
            check(col, sc, (vps - 1) * vps + lx, lx, `S-seam(${ci},${cj}) col lx=${lx}`);
            check(nrm, sn, (vps - 1) * vps + lx, lx, `S-seam(${ci},${cj}) nrm lx=${lx}`);
          }
        }
      }
    }
  });

  it('chunk vertex heights match the pure function at world coords', () => {
    const terrain = buildTerrain(1000, 99, 'hills');
    const rng = new Rng(5);
    for (let k = 0; k < 40; k++) {
      const m = terrain.chunkMeshes[Math.floor(rng.next() * 16)];
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const vi = Math.floor(rng.next() * pos.count);
      const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
      // mesh stores float32 heights; the pure function is float64 — float32-close
      expect(y).toBeCloseTo(terrain.heightAt(x, z), 5);
    }
  });

  it('physics heightfield still matches the visual mesh on a big world (B3-style)', () => {
    // Stage-1 B: the whole-world body is gone — one Heightfield per chunk
    // (terrain.body is now the origin chunk's body, kept as a legacy alias).
    // B3-check every chunk body: each sample must collide exactly where
    // heightAt()/the chunk mesh put it.
    const terrain = buildTerrain(1000, 4242, 'hills');
    const half = terrain.size / 2;
    const cell = terrain.size / (terrain.res - 1);
    const n = terrain.res - 1;
    expect(n).toBe(400);
    const cps = Math.ceil(terrain.size / TERRAIN_CHUNK_TARGET);
    const cpc = n / cps;
    expect(cps).toBe(4);
    for (let cx = 0; cx < cps; cx++) {
      for (let cz = 0; cz < cps; cz++) {
        const body = terrain.chunkBodyAt(cx, cz);
        expect(body, `chunk (${cx},${cz}) resident`).toBeDefined();
        const shape = body!.shapes[0] as CANNON.Heightfield;
        const data = shape.data as number[][];
        const i0 = cx * cpc, j1 = (cz + 1) * cpc;
        for (const [li, lj] of [[0, 0], [cpc, 0], [0, cpc], [cpc, cpc], [37, 11], [3, 73]] as Array<[number, number]>) {
          const v = data[li][lj];
          const world = body!.pointToWorldFrame(new CANNON.Vec3(li * cell, lj * cell, v));
          expect(world.x).toBeCloseTo(-half + (i0 + li) * cell, 6);
          expect(world.z).toBeCloseTo(-half + (j1 - lj) * cell, 6);
          expect(terrain.heightAt(world.x, world.z)).toBeCloseTo(v, 4);
        }
      }
    }
  });
});

describe('single-chunk worlds and determinism', () => {
  it('a 220m world is one chunk on the legacy grid', () => {
    const terrain = buildTerrain(220, 99, 'hills');
    const stats = terrain.getChunkStats();
    expect(stats.chunkCount).toBe(1);
    expect(stats.chunkSize).toBe(220);
    expect(terrain.res).toBe(88); // legacy: round(220/2.5)
    expect(terrain.chunkMeshes).toHaveLength(1);
    expect(terrain.mesh).toBe(terrain.chunkMeshes[0]);
    const pos = terrain.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe(88 * 88);
  });

  it('same seed -> identical chunk geometry across instances', () => {
    const a = buildTerrain(1000, 31337, 'canyon');
    const b = buildTerrain(1000, 31337, 'canyon');
    expect(a.chunkMeshes.length).toBe(b.chunkMeshes.length);
    for (let m = 0; m < a.chunkMeshes.length; m++) {
      for (const attr of ['position', 'color', 'normal'] as const) {
        const pa = a.chunkMeshes[m].geometry.getAttribute(attr) as THREE.BufferAttribute;
        const pb = b.chunkMeshes[m].geometry.getAttribute(attr) as THREE.BufferAttribute;
        expect(Array.from(pa.array as Float32Array), `chunk ${m} ${attr}`).toEqual(Array.from(pb.array as Float32Array));
      }
    }
  });

  it('update() is a safe no-op hook and dispose() removes every chunk', () => {
    const spec = generateSpec('a heroic knight adventure', { seed: 7 });
    spec.world.terrain.size = 1000;
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    expect(() => terrain.update(new THREE.Vector3(10, 0, -40))).not.toThrow();
    expect(scene.children.filter((o) => (o as THREE.Mesh).isMesh).length).toBeGreaterThanOrEqual(16);
    terrain.dispose(scene, physics);
    for (const m of terrain.chunkMeshes) expect(scene.children.includes(m)).toBe(false);
    expect(physics.world.bodies.includes(terrain.body)).toBe(false);
  });

  it('chunk size target divides world sizes as documented', () => {
    // 1000 -> 4x250, 2000 -> 8x250, 400 -> 2x200, 260 -> 2x130
    expect(buildTerrain(2000, 1, 'hills').getChunkStats()).toEqual({ chunkCount: 64, chunkSize: 250 });
    expect(buildTerrain(400, 1, 'hills').getChunkStats()).toEqual({ chunkCount: 4, chunkSize: 200 });
    expect(buildTerrain(256, 1, 'hills').getChunkStats()).toEqual({ chunkCount: 1, chunkSize: 256 });
    expect(TERRAIN_CHUNK_TARGET).toBe(256);
  });
});
