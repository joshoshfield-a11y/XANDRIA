/**
 * Open World — Stage 1b (maxsize), workstream E: determinism at the ceiling.
 *
 * The brief: "extend the FNV-1a digest tests to the new max sizes
 * (same seed → same world; chunked == legacy where they overlap)".
 *
 * The cap is PROBED from validateSpec at runtime (not hardcoded), so this gate
 * automatically tracks whatever ceiling workstream A ships. If the cap moves,
 * the probe finds the new number and every digest below runs at it.
 *
 * Coverage at the probed cap:
 *  1. Cap sanity: cap >= 2000, integer; schema accepts cap, rejects cap+1.
 *  2. chunked == legacy where they overlap: the exported pure `terrainHeightAt`
 *     vs the verbatim legacy loop, exact FNV-1a digest over a 256×256 world-
 *     spanning grid (2 seeds × 2 terrain types). No Terrain build needed —
 *     this is the overlap that must hold at every size.
 *  3. same seed → same world: two independent generateSpec+Terrain builds from
 *     the same seed digest the built height grid bit-identically (catches any
 *     nondeterminism in the build/streaming path at the ceiling).
 *  4. Non-vacuity: a different seed digests differently at the cap.
 *
 * The shared legacy reference (legacyHeightAtP, digestGrid, …) is imported from
 * chunked-determinism.test.ts — one source of truth, not a second copy.
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Terrain, terrainHeightAt } from '../src/engine/world/Terrain';
import { Noise2D } from '../src/engine/core/Rng';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import { validateSpec } from '../src/spec/schema';
import {
  paramsFromSpec, legacyHeightAtP, digestGrid, stubDom,
} from './determinism-ref';

beforeEach(() => { stubDom(); });

/**
 * Probe the schema for the maximum accepted world.terrain.size.
 * validateSpec is a cheap hand-rolled range check, so exponential probe +
 * binary search costs ~dozens of validations (milliseconds).
 */
export function probeSchemaCap(): number {
  const base = generateSpec('a heroic knight adventure through hills at dusk', { seed: 20261012 });
  const ok = (size: number): boolean => {
    const spec = JSON.parse(JSON.stringify(base));
    spec.world.terrain.size = size;
    return validateSpec(spec).errors.length === 0;
  };
  if (!ok(2000)) throw new Error('schema rejects 2000m — the stage-1 cap is gone?');
  let lo = 2000, hi = 4000;
  while (ok(hi)) { lo = hi; hi *= 2; if (hi > 1_000_000) break; }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

const CAP = probeSchemaCap();

describe('determinism at the ceiling (maxsize)', () => {
  it('cap probe: schema max is sane and enforced', () => {
    expect(Number.isInteger(CAP)).toBe(true);
    expect(CAP).toBeGreaterThanOrEqual(2000);
    console.log(`[maxsize-determinism] probed schema cap = ${CAP}m`);
    const base = generateSpec('a heroic knight adventure through hills at dusk', { seed: 20261012 });
    const atCap = JSON.parse(JSON.stringify(base)); atCap.world.terrain.size = CAP;
    expect(validateSpec(atCap).errors).toEqual([]);
    const over = JSON.parse(JSON.stringify(base)); over.world.terrain.size = CAP + 1;
    expect(validateSpec(over).errors.length).toBeGreaterThan(0);
  });

  it('chunked == legacy at the cap: pure height function, world-spanning 256×256 grid', () => {
    // The overlap that must hold at every size: the exported pure function
    // vs the verbatim legacy loop at the same world coords. Exact digests.
    const cases: Array<[string, number]> = [['hills', 7], ['hills', 4242], ['mountains', 31337], ['canyon', 999]];
    const GRID = 256;
    const seen = new Set<string>();
    for (const [type, seed] of cases) {
      const spec = generateSpec('a heroic knight adventure through hills at dusk', { seed });
      spec.world.terrain.size = CAP;
      spec.world.terrain.type = type as any;
      const p = paramsFromSpec(spec);
      const noise = new Noise2D(p.seed);
      const half = CAP / 2, cell = CAP / (GRID - 1);
      const ref: number[][] = [], got: number[][] = [];
      for (let i = 0; i < GRID; i++) {
        ref[i] = []; got[i] = [];
        for (let j = 0; j < GRID; j++) {
          const x = -half + i * cell, z = -half + j * cell;
          ref[i][j] = legacyHeightAtP(noise, p, x, z);
          got[i][j] = terrainHeightAt(p as any, x, z);
        }
      }
      const dRef = digestGrid(ref), dGot = digestGrid(got);
      expect(dGot, `${CAP}m ${type} seed=${seed} chunked==legacy`).toBe(dRef);
      seen.add(dGot);
    }
    expect(seen.size, 'non-vacuous across seeds/types').toBeGreaterThan(1);
  }, 300000);

  it('same seed → same world at the cap: two independent builds digest identically', () => {
    // Version-agnostic: works on the stage-1 Terrain (full internal grid) and
    // on workstream A's lazy Terrain (no internal grid — heightAt is the pure
    // function on both). Catches any nondeterminism in the build path.
    const GRID = 256;
    const heightDigest = (terrain: Terrain, size: number): string => {
      const half = size / 2, cell = size / (GRID - 1);
      const grid: number[][] = [];
      for (let i = 0; i < GRID; i++) {
        grid[i] = [];
        for (let j = 0; j < GRID; j++) grid[i][j] = terrain.heightAt(-half + i * cell, -half + j * cell);
      }
      return digestGrid(grid);
    };
    const meshDigest = (terrain: any): string => {
      // A's lazy API: ensureChunkMesh(0,0); stage-1: chunkMeshes[0] is chunk (0,0)
      const m = typeof terrain.ensureChunkMesh === 'function'
        ? terrain.ensureChunkMesh(0, 0) : terrain.chunkMeshes[0];
      const pos = m.geometry.getAttribute('position').array as Float32Array;
      let h = 0xcbf29ce484222325n;
      const P = 0x100000001b3n, M = 0xffffffffffffffffn;
      const bytes = new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength);
      for (let b = 0; b < bytes.length; b++) { h ^= BigInt(bytes[b]); h = (h * P) & M; }
      return h.toString(16).padStart(16, '0');
    };
    const build = (seed: number) => {
      const spec = generateSpec('a heroic knight adventure through hills at dusk', { seed });
      spec.world.terrain.size = CAP;
      spec.world.terrain.type = 'hills';
      const physics = new Physics(spec.world.gravity);
      const mats = new MaterialLibrary(spec);
      const scene = new THREE.Scene();
      const terrain = new Terrain(spec, physics, mats, scene);
      return { terrain, physics, scene };
    };
    const digests: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { terrain, physics, scene } = build(20261012);
      try {
        digests.push(heightDigest(terrain, CAP));
        digests.push(meshDigest(terrain));
      } finally {
        terrain.dispose(scene, physics);
      }
    }
    expect(digests[0], 'heightAt grid identical across builds').toBe(digests[2]);
    expect(digests[1], 'chunk mesh positions identical across builds').toBe(digests[3]);
    // and a different seed must NOT collide
    const o = build(777);
    try {
      expect(heightDigest(o.terrain, CAP)).not.toBe(digests[0]);
    } finally {
      o.terrain.dispose(o.scene, o.physics);
    }
  }, 1200000);
});
