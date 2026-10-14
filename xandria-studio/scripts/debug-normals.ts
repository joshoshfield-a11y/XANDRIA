/**
 * Debug: compare new per-chunk normal accumulation vs a direct
 * reimplementation of the OLD global accumulation, for one chunk.
 * Run: npx tsx scripts/debug-normals.ts <size> <seed> <type> <cx> <cz>
 */
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
(globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head') };

import * as THREE from 'three';
import { Terrain, terrainHeightAt } from '../src/engine/world/Terrain.js';
import { Physics } from '../src/engine/core/Physics.js';
import { MaterialLibrary } from '../src/engine/gfx/Materials.js';
import { generateSpec } from '../src/generator/generate.js';
import { Noise2D } from '../src/engine/core/Rng.js';

const [sizeS, seedS, type, cxS, czS] = process.argv.slice(2);
const size = Number(sizeS), seed = Number(seedS), cx = Number(cxS), cz = Number(czS);

const spec = generateSpec('x', { seed });
spec.world.terrain.type = type as any;
spec.world.terrain.size = size;
const physics = new Physics(spec.world.gravity);
const mats = new MaterialLibrary(spec);
const scene = new THREE.Scene();
const terrain = new Terrain(spec, physics, mats, scene);
const anyT = terrain as any;

// new per-chunk normals
const mesh = anyT.ensureChunkMesh(cx, cz);
const newNrm = (mesh.geometry.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;

// old global accumulation, reimplemented directly
const res = terrain.res, cell = size / (res - 1), half = size / 2;
const cps = Math.round(size / terrain.chunkSize);
const cpc = (res - 1) / cps;
const hp = anyT.hp;
const h: number[][] = [];
for (let i = 0; i < res; i++) {
  h[i] = [];
  for (let j = 0; j < res; j++) h[i][j] = terrainHeightAt(hp, -half + i * cell, -half + j * cell);
}
const posOf = (gi: number, gj: number) => [
  Math.fround(-half + gi * cell), Math.fround(h[gi][gj]), Math.fround(-half + gj * cell)];
const nacc = new Float32Array(res * res * 3);
const vps = cpc + 1;
for (let cj2 = 0; cj2 < cps; cj2++) {
  for (let ci2 = 0; ci2 < cps; ci2++) {
    // local posArr for this chunk (float32)
    const posArr = new Float32Array(vps * vps * 3);
    for (let ly = 0; ly < vps; ly++) for (let lx = 0; lx < vps; lx++) {
      const gi = ci2 * cpc + lx, gj = cj2 * cpc + ly;
      const vi = ly * vps + lx, p = posOf(gi, gj);
      posArr[vi * 3] = p[0]; posArr[vi * 3 + 1] = p[1]; posArr[vi * 3 + 2] = p[2];
    }
    for (let ly = 0; ly < cpc; ly++) for (let lx = 0; lx < cpc; lx++) {
      const a = lx + vps * ly, b = lx + vps * (ly + 1);
      const c = (lx + 1) + vps * (ly + 1), d = (lx + 1) + vps * ly;
      for (const [A, B, C] of [[a, b, d], [b, c, d]] as Array<[number, number, number]>) {
        const iA = A * 3, iB = B * 3, iC = C * 3;
        const cbx = posArr[iC] - posArr[iB], cby = posArr[iC + 1] - posArr[iB + 1], cbz = posArr[iC + 2] - posArr[iB + 2];
        const abx = posArr[iA] - posArr[iB], aby = posArr[iA + 1] - posArr[iB + 1], abz = posArr[iA + 2] - posArr[iB + 2];
        const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
        for (const V of [A, B, C]) {
          const gi = ci2 * cpc + (V % vps), gj = cj2 * cpc + Math.floor(V / vps);
          const k3 = (gi * res + gj) * 3;
          nacc[k3] = Math.fround(nacc[k3] + nx);
          nacc[k3 + 1] = Math.fround(nacc[k3 + 1] + ny);
          nacc[k3 + 2] = Math.fround(nacc[k3 + 2] + nz);
        }
      }
    }
  }
}
// extract old normals for chunk (cx,cz), normalized
let diffs = 0;
for (let ly = 0; ly < vps; ly++) for (let lx = 0; lx < vps; lx++) {
  const gi = cx * cpc + lx, gj = cz * cpc + ly;
  const k3 = (gi * res + gj) * 3;
  const l = Math.sqrt(nacc[k3] ** 2 + nacc[k3 + 1] ** 2 + nacc[k3 + 2] ** 2) || 1;
  const vi = (ly * vps + lx) * 3;
  // the real old code rounded to float32 on setXYZ — compare at that precision
  const ox = Math.fround(nacc[k3] / l), oy = Math.fround(nacc[k3 + 1] / l), oz = Math.fround(nacc[k3 + 2] / l);
  const dx = Math.abs(ox - newNrm[vi]);
  const dy = Math.abs(oy - newNrm[vi + 1]);
  const dz = Math.abs(oz - newNrm[vi + 2]);
  if (dx > 0 || dy > 0 || dz > 0) {
    diffs++;
    if (diffs <= 5) console.log(`vert(lx=${lx},ly=${ly}) old=(${ox},${oy},${oz}) new=(${newNrm[vi]},${newNrm[vi + 1]},${newNrm[vi + 2]})`);
  }
}
console.log(`chunk (${cx},${cz}): ${diffs}/${vps * vps} verts differ`);
terrain.dispose(scene, physics);
