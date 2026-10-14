/**
 * Shared determinism reference helpers for the maxsize gate (NOT a test file —
 * the vitest include pattern only matches test.ts files under tests/, so this
 * module is never collected on its own).
 *
 * These helpers MIRROR the inline copies in chunked-determinism.test.ts (the
 * stage-1 gate keeps its own inline copies deliberately, so workstream A's
 * re-expression of that gate merges without conflicts). If the verbatim legacy
 * height loop ever changes, update both places.
 *
 * DOM is stubbed by the importing test file (no jsdom) via stubDom().
 */
import * as THREE from 'three';
import { Noise2D } from '../src/engine/core/Rng';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import type { GameSpec } from '@spec';

export function makeEl(tag = 'div'): any {
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

/** DOM stub (no jsdom) — call from the test file's beforeEach. */
export function stubDom(): void {
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
  };
}

export interface HeightParams {
  seed: number; size: number; type: string; maxHeight: number; roughness: number;
  freq: number; hscale: number;
  flatCenters: Array<{ x: number; y: number; z: number }>;
  flatRadius: number; boundary: string;
}

/** Mirror of the Terrain constructor's param derivation, from the same spec. */
export function paramsFromSpec(spec: GameSpec): HeightParams {
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

export function buildWorld(size: number, type: string, seed: number) {
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
export function legacyHeightAtP(noise: Noise2D, p: HeightParams, x: number, z: number): number {
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
export function legacyHeightsGrid(p: HeightParams, res: number): number[][] {
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
export function digestGrid(heights: number[][]): string {
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
export const legacyRes = (size: number) => Math.min(128, Math.max(32, Math.round(size / 2.5)));
