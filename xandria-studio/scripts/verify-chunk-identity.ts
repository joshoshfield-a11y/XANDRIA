/**
 * Bit-identity verifier (workstream A): digest every chunk's geometry and
 * print one FNV-1a digest. Works against BOTH the old whole-world Terrain
 * and the new lazy per-chunk Terrain — run on each and diff.
 * Run: npx tsx scripts/verify-chunk-identity.ts <size> <seed> <type>
 */
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
(globalThis as any).document = {
  createElement: (t: string) => makeEl(t),
  head: makeEl('head'),
};

import * as THREE from 'three';
import { Terrain } from '../src/engine/world/Terrain.js';
import { Physics } from '../src/engine/core/Physics.js';
import { MaterialLibrary } from '../src/engine/gfx/Materials.js';
import { generateSpec } from '../src/generator/generate.js';

const [sizeS, seedS, type] = process.argv.slice(2);
const size = Number(sizeS), seed = Number(seedS);

const spec = generateSpec('a heroic knight adventure', { seed });
spec.world.terrain.type = type as any;
spec.world.terrain.size = size;
const physics = new Physics(spec.world.gravity);
const mats = new MaterialLibrary(spec);
const scene = new THREE.Scene();
const terrain = new Terrain(spec, physics, mats, scene);

const cps = Math.round(size / terrain.chunkSize);
const meshes: THREE.Mesh[] = [];
const anyT = terrain as any;
if (typeof anyT.ensureChunkMesh === 'function') {
  for (let cz = 0; cz < cps; cz++) for (let cx = 0; cx < cps; cx++) meshes.push(anyT.ensureChunkMesh(cx, cz));
} else {
  for (let cz = 0; cz < cps; cz++) for (let cx = 0; cx < cps; cx++) meshes.push(terrain.chunkMeshes[cz * cps + cx]);
}

// FNV-1a 64-bit over raw bytes
let h = 0xcbf29ce484222325n;
const P = 0x100000001b3n, M = 0xffffffffffffffffn;
const feed = (bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length; i++) { h ^= BigInt(bytes[i]); h = (h * P) & M; }
};
const feedF32 = (a: Float32Array) => feed(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
for (const m of meshes) {
  const g = m.geometry;
  for (const name of ['position', 'uv', 'color', 'normal']) {
    feedF32((g.getAttribute(name) as THREE.BufferAttribute).array as Float32Array);
  }
  const idx = g.getIndex()!;
  feed(new Uint8Array(idx.array.buffer, idx.array.byteOffset, idx.array.byteLength));
}
console.log(`size=${size} seed=${seed} type=${type} chunks=${meshes.length} digest=${h.toString(16).padStart(16, '0')}`);
terrain.dispose(scene, physics);
