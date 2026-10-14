/**
 * Open World — Stage 1, workstream E (phase 2): the determinism gate.
 *
 * Brief acceptance: "same seed chunked vs legacy single-mesh must produce
 * identical height checksums".
 *
 * Worker A's chunked-terrain.test.ts proves the exported pure function
 * `terrainHeightAt` matches the legacy height loop on point samples. This
 * file closes the gate at FULL-GRID scale with EXACT digest equality
 * (FNV-1a over the float64 height bytes — `toBe` on digests, never
 * approximate):
 *
 *  1. Small worlds (220m / 256m hills): the single-chunk path builds on the
 *     legacy grid — the built Terrain's internal float64 height grid must be
 *     digest-identical to an independent recomputation of the legacy loop on
 *     the legacy grid (res formula taken from the pre-chunk code).
 *  2. Big worlds (1000m mountains, 1500m canyon, 2000m flat): the chunked
 *     path samples the same world coords as the legacy loop — digest the
 *     built Terrain's full height grid and compare against the legacy loop
 *     evaluated at the same coords. EXACT equality, not approximate.
 *  3. Cross-path: at the legacy 128-grid coords (the grid the old single
 *     mesh would have used for big worlds), the legacy loop vs the chunked
 *     path's `terrainHeightAt` must also be digest-identical.
 *  4. `heightAt()` at grid vertices returns the grid values bit-exactly, so
 *     gameplay code sampling at vertex coords sees zero drift.
 *
 * The reference is a verbatim copy of the height loop from Terrain.ts at
 * commit 00474e33 (feature/openworld-stage1 base). Noise2D is immutable after
 * construction, so the per-call `new Noise2D(seed)` in the original is
 * hoisted to one instance per grid here — mathematically identical, and the
 * only way to checksum 641k points in sane time.
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain, terrainHeightAt } from '../src/engine/world/Terrain';
import { Noise2D } from '../src/engine/core/Rng';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import type { GameSpec } from '@spec';

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

interface HeightParams {
  seed: number; size: number; type: string; maxHeight: number; roughness: number;
  freq: number; hscale: number;
  flatCenters: Array<{ x: number; y: number; z: number }>;
  flatRadius: number; boundary: string;
}

/** Mirror of the Terrain constructor's param derivation, from the same spec. */
function paramsFromSpec(spec: GameSpec): HeightParams {
  const t = spec.world.terrain;
  const bio = spec.custom?.biome as { terrainFrequency?: number; heightScale?: number } | undefined;
  return {
    seed: spec.meta.seed, size: t.size, type: t.type, maxHeight: t.maxHeight,
    roughness: t.roughness, freq: bio?.terrainFrequency ?? 1, hscale: bio?.heightScale ?? 1,
    flatCenters: [{ x: 0, y: 0, z: 0 }],
    flatRadius: Math.max(14, t.size * 0.08),
    boundary: spec.world.boundary,
  };
}

function buildWorld(size: number, type: string, seed: number) {
  const spec = generateSpec('a heroic knight adventure', { seed });
  spec.world.terrain.type = type as any;
  spec.world.terrain.size = size;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, scene, terrain };
}

/**
 * VERBATIM copy of the pre-chunk height computation (Terrain.ts constructor
 * loop, commit 00474e33) — the ground truth the chunked path must match.
 * The only change vs the original: the `new Noise2D(p.seed)` constructed
 * per point in the loop is hoisted to a parameter (Noise2D is immutable
 * after construction — same perm table, same values, per point).
 */
function legacyHeightAtP(noise: Noise2D, p: HeightParams, x: number, z: number): number {
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
  // edge falloff: rim rises (or drops) for boundary
  const edge = Math.max(Math.abs(nx), Math.abs(nz)) * 2; // 0..1
  if (p.boundary === 'cliffs') y -= Math.pow(Math.max(0, edge - 0.85) / 0.15, 2) * 40;
  else if (p.boundary === 'walls') y += Math.pow(Math.max(0, edge - 0.9) / 0.1, 2) * p.maxHeight * 0.8;
  // flatten around spawn / arena centers
  const flatR = p.flatRadius;
  for (const c of p.flatCenters) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < flatR * 1.8) { const k = THREE.MathUtils.smoothstep(d, flatR * 0.6, flatR * 1.8); y = THREE.MathUtils.lerp(c.y, y, k); }
  }
  return y;
}

/** Legacy loop evaluated on a res x res world grid — the reference heightfield. */
function legacyHeightsGrid(p: HeightParams, res: number): number[][] {
  const noise = new Noise2D(p.seed);
  const half = p.size / 2;
  const cell = p.size / (res - 1);
  const out: number[][] = [];
  for (let i = 0; i < res; i++) {
    out[i] = [];
    for (let j = 0; j < res; j++) {
      out[i][j] = legacyHeightAtP(noise, p, -half + i * cell, -half + j * cell);
    }
  }
  return out;
}

/** FNV-1a 64-bit over the raw float64 bytes — bit-exact, order-sensitive. */
const _f64 = new DataView(new ArrayBuffer(8));
function digestGrid(heights: number[][]): string {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n;
  const M = 0xffffffffffffffffn;
  for (let i = 0; i < heights.length; i++) {
    const row = heights[i];
    for (let j = 0; j < row.length; j++) {
      _f64.setFloat64(0, row[j], true);
      for (let b = 0; b < 8; b++) {
        h ^= BigInt(_f64.getUint8(b));
        h = (h * P) & M;
      }
    }
  }
  return h.toString(16).padStart(16, '0');
}

/** The legacy single-mesh resolution formula (pre-chunk Terrain.ts). */
const legacyRes = (size: number) => Math.min(128, Math.max(32, Math.round(size / 2.5)));

const seenDigests = new Map<string, Set<string>>();
function recordDigest(caseKey: string, digest: string) {
  let s = seenDigests.get(caseKey);
  if (!s) { s = new Set(); seenDigests.set(caseKey, s); }
  s.add(digest);
}

describe('determinism gate: legacy single-mesh vs chunked heights (exact digests)', () => {
  it('small worlds: single-chunk heights == legacy loop on the legacy grid', () => {
    const cases: Array<[number, string, number[]]> = [
      [220, 'hills', [7, 4242, 999999]],
      [256, 'hills', [7, 4242]],
    ];
    for (const [size, type, seeds] of cases) {
      for (const seed of seeds) {
        const { spec, physics, scene, terrain } = buildWorld(size, type, seed);
        try {
          const p = paramsFromSpec(spec);
          const res = legacyRes(size);
          // the single-chunk path must be built on the legacy grid
          expect(terrain.res, `${size}m res`).toBe(res);
          expect(terrain.getChunkStats().chunkCount, `${size}m chunks`).toBe(1);
          const ref = digestGrid(legacyHeightsGrid(p, res));
          const got = digestGrid((terrain as any).heights as number[][]);
          expect(got, `${size}m ${type} seed=${seed}`).toBe(ref);
          recordDigest(`${size}m-${type}`, got);
        } finally {
          terrain.dispose(scene, physics);
        }
      }
    }
  }, 30000);

  it('big worlds: chunked heights == legacy loop at the same world coords', () => {
    const cases: Array<[number, string, number[], number, number]> = [
      // [size, type, seeds, expectedRes, expectedChunks]
      [1000, 'mountains', [7, 4242, 31337], 401, 16],
      [1500, 'canyon', [7, 4242], 601, 36],
      [2000, 'flat', [7, 4242], 801, 64],
    ];
    for (const [size, type, seeds, expRes, expChunks] of cases) {
      for (const seed of seeds) {
        const { spec, physics, scene, terrain } = buildWorld(size, type, seed);
        try {
          const p = paramsFromSpec(spec);
          expect(terrain.res, `${size}m res`).toBe(expRes);
          expect(terrain.getChunkStats().chunkCount, `${size}m chunks`).toBe(expChunks);
          expect(terrain.getChunkStats().chunkSize, `${size}m chunkSize`).toBe(250);
          // sample the reference at the terrain's own grid coords
          const res = terrain.res;
          const half = size / 2;
          const cell = size / (res - 1);
          const noise = new Noise2D(p.seed);
          const refGrid: number[][] = [];
          for (let i = 0; i < res; i++) {
            refGrid[i] = [];
            for (let j = 0; j < res; j++) {
              refGrid[i][j] = legacyHeightAtP(noise, p, -half + i * cell, -half + j * cell);
            }
          }
          const ref = digestGrid(refGrid);
          const got = digestGrid((terrain as any).heights as number[][]);
          expect(got, `${size}m ${type} seed=${seed}`).toBe(ref);
          recordDigest(`${size}m-${type}`, got);
        } finally {
          terrain.dispose(scene, physics);
        }
      }
    }
  }, 120000);

  it('cross-path: at the legacy 128-grid coords, chunked == legacy for big worlds', () => {
    // The old single mesh capped res at 128 for any size; the chunked path
    // must reproduce the legacy heights bit-identically at those coords.
    const cases: Array<[number, string, number]> = [
      [1000, 'mountains', 7],
      [1500, 'canyon', 4242],
      [2000, 'flat', 31337],
    ];
    for (const [size, type, seed] of cases) {
      const { spec, physics, scene, terrain } = buildWorld(size, type, seed);
      try {
        const p = paramsFromSpec(spec);
        const res = 128;
        const half = size / 2;
        const cell = size / (res - 1);
        const noise = new Noise2D(p.seed);
        const refGrid: number[][] = [];
        const chunkedGrid: number[][] = [];
        for (let i = 0; i < res; i++) {
          refGrid[i] = []; chunkedGrid[i] = [];
          for (let j = 0; j < res; j++) {
            const x = -half + i * cell, z = -half + j * cell;
            refGrid[i][j] = legacyHeightAtP(noise, p, x, z);
            chunkedGrid[i][j] = terrainHeightAt(p as any, x, z);
          }
        }
        expect(digestGrid(chunkedGrid), `${size}m ${type} seed=${seed} cross-path`).toBe(digestGrid(refGrid));
      } finally {
        terrain.dispose(scene, physics);
      }
    }
  }, 60000);

  it('heightAt() at grid vertices returns the grid values bit-exactly', () => {
    for (const [size, type, seed] of [[220, 'hills', 7], [1000, 'mountains', 4242]] as Array<[number, string, number]>) {
      const { physics, scene, terrain } = buildWorld(size, type, seed);
      try {
        const heights = (terrain as any).heights as number[][];
        const res = terrain.res;
        const half = size / 2;
        const cell = size / (res - 1);
        const got: number[][] = [];
        for (let i = 0; i < res; i++) {
          got[i] = [];
          for (let j = 0; j < res; j++) {
            got[i][j] = terrain.heightAt(-half + i * cell, -half + j * cell);
          }
        }
        expect(digestGrid(got), `${size}m heightAt grid`).toBe(digestGrid(heights));
      } finally {
        terrain.dispose(scene, physics);
      }
    }
  }, 60000);

  it('the gate is not vacuous: different seeds give different digests', () => {
    // every (size,type) case above ran 2-3 seeds; each must hash distinctly
    for (const [key, digests] of seenDigests) {
      expect(digests.size, `${key} distinct digests`).toBeGreaterThan(1);
    }
  });
});
