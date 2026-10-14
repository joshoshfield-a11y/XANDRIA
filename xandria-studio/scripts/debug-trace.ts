/**
 * Trace per-face normal contributions to one vertex, old-global vs new-local.
 * Run: npx tsx scripts/debug-trace.ts
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

const size = 1000, seed = 4242, type = 'mountains';
const spec = generateSpec('x', { seed });
spec.world.terrain.type = type as any;
spec.world.terrain.size = size;
const physics = new Physics(spec.world.gravity);
const mats = new MaterialLibrary(spec);
const scene = new THREE.Scene();
const terrain = new Terrain(spec, physics, mats, scene);
const anyT = terrain as any;

const res = terrain.res, cell = size / (res - 1), half = size / 2;
const cps = 4, cpc = 100;
const hp = anyT.hp;
const cx = 1, cz = 1, tlx = 3, tly = 0; // target vert: chunk (1,1) local (3,0)
const tgi = cx * cpc + tlx, tgj = cz * cpc + tly;

// ---- OLD global accumulation with sequence logging for the target vert
const h: number[][] = [];
for (let i = 0; i < res; i++) {
  h[i] = [];
  for (let j = 0; j < res; j++) h[i][j] = terrainHeightAt(hp, -half + i * cell, -half + j * cell);
}
const oldSeq: string[] = [];
const nacc = new Float32Array(res * res * 3);
const vps = cpc + 1;
for (let cj2 = 0; cj2 < cps; cj2++) {
  for (let ci2 = 0; ci2 < cps; ci2++) {
    const posArr = new Float32Array(vps * vps * 3);
    for (let ly = 0; ly < vps; ly++) for (let lx = 0; lx < vps; lx++) {
      const gi = ci2 * cpc + lx, gj = cj2 * cpc + ly, vi = ly * vps + lx;
      posArr[vi * 3] = Math.fround(-half + gi * cell);
      posArr[vi * 3 + 1] = Math.fround(h[gi][gj]);
      posArr[vi * 3 + 2] = Math.fround(-half + gj * cell);
    }
    for (let ly = 0; ly < cpc; ly++) for (let lx = 0; lx < cpc; lx++) {
      const a = lx + vps * ly, b = lx + vps * (ly + 1);
      const c = (lx + 1) + vps * (ly + 1), d = (lx + 1) + vps * ly;
      let fi = 0;
      for (const [A, B, C] of [[a, b, d], [b, c, d]] as Array<[number, number, number]>) {
        const iA = A * 3, iB = B * 3, iC = C * 3;
        const cbx = posArr[iC] - posArr[iB], cby = posArr[iC + 1] - posArr[iB + 1], cbz = posArr[iC + 2] - posArr[iB + 2];
        const abx = posArr[iA] - posArr[iB], aby = posArr[iA + 1] - posArr[iB + 1], abz = posArr[iA + 2] - posArr[iB + 2];
        const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
        for (const V of [A, B, C]) {
          const gi = ci2 * cpc + (V % vps), gj = cj2 * cpc + Math.floor(V / vps);
          const k3 = (gi * res + gj) * 3;
          if (gi === tgi && gj === tgj) {
            oldSeq.push(`chunk(${ci2},${cj2}) cell(${ci2 * cpc + lx},${cj2 * cpc + ly}) ${fi === 0 ? 'T1' : 'T2'} n=(${nx},${ny},${nz})`);
          }
          nacc[k3] = Math.fround(nacc[k3] + nx);
          nacc[k3 + 1] = Math.fround(nacc[k3 + 1] + ny);
          nacc[k3 + 2] = Math.fround(nacc[k3 + 2] + nz);
        }
        fi++;
      }
    }
  }
}
console.log('OLD sequence for vert (103,100):');
for (const s of oldSeq) console.log('  ' + s);
const k3 = (tgi * res + tgj) * 3;
console.log(`OLD nacc = (${nacc[k3]}, ${nacc[k3 + 1]}, ${nacc[k3 + 2]})`);

// ---- NEW local accumulation with sequence logging for the target vert
const gi0 = Math.max(0, cx * cpc - 1), gi1 = Math.min(res - 1, cx * cpc + cpc + 1);
const gj0 = Math.max(0, cz * cpc - 1), gj1 = Math.min(res - 1, cz * cpc + cpc + 1);
const ew = gi1 - gi0 + 1;
const eh = new Float64Array(ew * (gj1 - gj0 + 1));
for (let gj = gj0; gj <= gj1; gj++)
  for (let gi = gi0; gi <= gi1; gi++)
    eh[(gj - gj0) * ew + (gi - gi0)] = terrainHeightAt(hp, -half + gi * cell, -half + gj * cell);
const hgt = (gi: number, gj: number) => eh[(gj - gj0) * ew + (gi - gi0)];
const i0 = cx * cpc, j0 = cz * cpc;
const owned = (gi: number, gj: number) => gi >= i0 && gi <= i0 + cpc && gj >= j0 && gj <= j0 + cpc;
const newSeq: string[] = [];
const nacc2 = new Float32Array(vps * vps * 3);
const pa = [0, 0, 0], pb = [0, 0, 0], pc = [0, 0, 0];
const corner = (gi: number, gj: number, out: number[]) => {
  out[0] = Math.fround(-half + gi * cell);
  out[1] = Math.fround(hgt(gi, gj));
  out[2] = Math.fround(-half + gj * cell);
};
const addFace = (agi: number, agj: number, bgi: number, bgj: number, cgi: number, cgj: number, tag: string) => {
  corner(agi, agj, pa); corner(bgi, bgj, pb); corner(cgi, cgj, pc);
  const cbx = pc[0] - pb[0], cby = pc[1] - pb[1], cbz = pc[2] - pb[2];
  const abx = pa[0] - pb[0], aby = pa[1] - pb[1], abz = pa[2] - pb[2];
  const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
  for (const [gi, gj] of [[agi, agj], [bgi, bgj], [cgi, cgj]] as Array<[number, number]>) {
    if (!owned(gi, gj)) continue;
    if (gi === tgi && gj === tgj) newSeq.push(`${tag} n=(${nx},${ny},${nz})`);
    const kk = ((gj - j0) * vps + (gi - i0)) * 3;
    nacc2[kk] = Math.fround(nacc2[kk] + nx);
    nacc2[kk + 1] = Math.fround(nacc2[kk + 1] + ny);
    nacc2[kk + 2] = Math.fround(nacc2[kk + 2] + nz);
  }
};
for (let ly = 0; ly < cpc; ly++) for (let lx = 0; lx < cpc; lx++) {
  const gi = i0 + lx, gj = j0 + ly;
  addFace(gi, gj, gi, gj + 1, gi + 1, gj, `own cell(${gi},${gj}) T1`);
  addFace(gi, gj + 1, gi + 1, gj + 1, gi + 1, gj, `own cell(${gi},${gj}) T2`);
}
for (let phase = 0; phase < 3; phase++) {
  if (phase === 1) continue;
  for (let ly = -1; ly <= cpc; ly++) for (let lx = -1; lx <= cpc; lx++) {
    if (lx >= 0 && lx < cpc && ly >= 0 && ly < cpc) continue;
    const gi = i0 + lx, gj = j0 + ly;
    if (gi < 0 || gj < 0 || gi + 1 > res - 1 || gj + 1 > res - 1) continue;
    const oci = Math.floor(gi / cpc), ocj = Math.floor(gj / cpc);
    const before = ocj < cz || (ocj === cz && oci < cx);
    if (phase === 0 && !before) continue;
    if (phase === 2 && before) continue;
    addFace(gi, gj, gi, gj + 1, gi + 1, gj, `ghost cell(${gi},${gj}) T1`);
    addFace(gi, gj + 1, gi + 1, gj + 1, gi + 1, gj, `ghost cell(${gi},${gj}) T2`);
  }
}
console.log('NEW sequence for vert (103,100):');
for (const s of newSeq) console.log('  ' + s);
const k32 = ((tly) * vps + (tlx)) * 3;
console.log(`NEW nacc = (${nacc2[k32]}, ${nacc2[k32 + 1]}, ${nacc2[k32 + 2]})`);
terrain.dispose(scene, physics);
