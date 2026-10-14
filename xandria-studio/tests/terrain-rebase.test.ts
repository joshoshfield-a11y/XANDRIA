/**
 * Open World Stage 1b — workstream B: camera-relative terrain rendering.
 *
 * float32 vertex math in the shader loses precision with distance from the
 * world origin (measured ~1px static projection error at ~75km camera
 * distance, ~12km for close-range geometry — see qa/openworld/workers-max/B.md
 * and scripts/measure-jitter.mjs). The fix, per the brief's option (a):
 * chunk position attributes are stored CHUNK-LOCAL (magnitudes ~chunkSize,
 * so every float32 magnitude near the camera stays small) with the mesh
 * positioned at the chunk origin. three.js composes modelViewMatrix in
 * float64, so the composed matrices stay small too — measured 0.003px flat
 * to 64km.
 *
 * Generated content must not change: heights, vertex COLORS and NORMALS are
 * bit-identical to the pre-rebase build (digests below were captured from
 * the pre-rebase code). Only the position attribute layout changes, i.e.
 * how it's rendered, not what.
 *
 * (A scene-level render-origin shift was prototyped and PROVEN a no-op:
 * V'·T(-O) is f64-identical to V, so the composed modelViewMatrix uploaded
 * to the GPU is bit-identical with and without it. The vertex rebase alone
 * carries the full measured win — hence no Engine/render-loop changes.)
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain } from '../src/engine/world/Terrain';
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

function buildWorld(size: number, type: string, seed: number) {
  const spec = generateSpec('a heroic knight adventure', { seed });
  spec.world.terrain.type = type as any;
  spec.world.terrain.size = size;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  // Stage-1b A: meshes build lazily — build every chunk explicitly here so
  // the assertions below see the full grid.
  const cps = Math.round(size / terrain.chunkSize);
  for (let cj = 0; cj < cps; cj++) for (let ci = 0; ci < cps; ci++) terrain.ensureChunkMesh(ci, cj);
  return { spec, physics, scene, terrain };
}

/** FNV-1a 32-bit over float32 bytes — bit-exact content digest. */
function digestF32(arrays: ArrayLike<number>[]): string {
  let h = 0x811c9dc5;
  const dv = new DataView(new ArrayBuffer(4));
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      dv.setFloat32(0, a[i], true);
      for (let b = 0; b < 4; b++) {
        h ^= dv.getUint8(b);
        h = Math.imul(h, 0x01000193);
      }
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function contentDigest(terrain: Terrain): string {
  const arrs: ArrayLike<number>[] = [];
  // canonical cz-major grid order (not chunkMeshes build order, which is
  // lazy/stream-ordered since stage-1b A) — matches the eager build order
  // the reference digests were captured with.
  const cps = Math.round(Math.sqrt(terrain.getChunkStats().chunkCount));
  for (let cj = 0; cj < cps; cj++)
    for (let ci = 0; ci < cps; ci++) {
      const m = terrain.getChunkMesh(ci, cj)!;
      arrs.push((m.geometry.attributes.normal as THREE.BufferAttribute).array);
      arrs.push((m.geometry.attributes.color as THREE.BufferAttribute).array);
    }
  return digestF32(arrs);
}

describe('Terrain chunk vertex rebase (camera-relative rendering)', () => {
  it('normals+colors are bit-identical to the pre-rebase build (220m hills)', () => {
    const { physics, scene, terrain } = buildWorld(220, 'hills', 7);
    try {
      // digest captured from the pre-rebase code — see workers-max/B.md
      expect(contentDigest(terrain)).toBe('d72f028d');
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 30000);

  it('normals+colors are bit-identical to the pre-rebase build (1000m mountains, multi-chunk)', () => {
    const { physics, scene, terrain } = buildWorld(1000, 'mountains', 7);
    try {
      expect(terrain.getChunkStats().chunkCount).toBe(16);
      // digest captured from the pre-rebase code — see workers-max/B.md
      expect(contentDigest(terrain)).toBe('7cb1da35');
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 120000);

  it('chunk attributes are chunk-local: magnitudes bounded by the chunk size', () => {
    const { physics, scene, terrain } = buildWorld(1000, 'mountains', 7);
    try {
      const { chunkSize } = terrain.getChunkStats();
      for (const m of terrain.chunkMeshes) {
        const pos = m.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          // local x/z within the chunk, y within terrain height range
          expect(Math.abs(pos.getX(i))).toBeLessThanOrEqual(chunkSize + 1);
          expect(Math.abs(pos.getZ(i))).toBeLessThanOrEqual(chunkSize + 1);
        }
        // mesh carries the chunk origin (world frame)
        expect(m.position.y).toBe(0);
      }
      // chunk origins tile the world: first chunk at -half, last ends at +half
      const half = 1000 / 2;
      const xs = terrain.chunkMeshes.map((m) => m.position.x);
      expect(Math.min(...xs)).toBeCloseTo(-half, 6);
      expect(Math.max(...xs)).toBeCloseTo(half - chunkSize, 6);
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 120000);

  it('world position reconstructs: mesh.position + local attr == f32 world coord', () => {
    const { physics, scene, terrain } = buildWorld(1000, 'mountains', 7);
    try {
      const half = 1000 / 2;
      const cell = terrain['cell'] as number;
      const res = terrain.res;
      // chunk (ci=2, cz=1) of 4x4; its verts are grid (gi,gj) = (2*cpc+lx, 1*cpc+ly)
      const cps = 4;
      const cpc = (res - 1) / cps;
      const ci = 2, cz = 1;
      const m = terrain.getChunkMesh(ci, cz)!;
      const pos = m.geometry.attributes.position as THREE.BufferAttribute;
      const vps = cpc + 1;
      const f32eps = (x: number) => Math.abs(x) * Math.pow(2, -23);
      for (const [lx, ly] of [[0, 0], [cpc, 0], [0, cpc], [cpc, cpc], [7, 13]] as Array<[number, number]>) {
        const gi = ci * cpc + lx, gj = cz * cpc + ly;
        const wx = -half + gi * cell, wz = -half + gj * cell;
        const vi = ly * vps + lx;
        const rx = m.position.x + pos.getX(vi);
        const rz = m.position.z + pos.getZ(vi);
        expect(Math.abs(rx - Math.fround(wx))).toBeLessThanOrEqual(2 * f32eps(wx) + 1e-9);
        expect(Math.abs(rz - Math.fround(wz))).toBeLessThanOrEqual(2 * f32eps(wz) + 1e-9);
      }
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 120000);
});
