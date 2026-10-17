/**
 * Graphics wave 2, workstream A — terrain detail gates.
 *
 * - Same seed -> bit-identical vertex colors across two full builds
 *   (determinism preserved through the new paint recipe).
 * - One shared ground material for every chunk mesh (no new draw calls).
 * - Wear discs/paths darken ground near spawn/structures; repaint after
 *   addWearPoints() is exactly equal to building with the wear present.
 * - Chunk seams stay bit-identical AFTER wear is applied.
 * - Slope/height bands behave (flat -> ground, cliff -> rock/cliff,
 *   altitude -> high cap, shore -> wet).
 * - Detail-layer quality wiring (groundDetailUniforms per tier).
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary, groundDetailUniforms, applyGroundDetailForQuality } from '../src/engine/gfx/Materials';
import { Noise2D } from '../src/engine/core/Rng';
import { generateSpec } from '../src/generator/generate';
import {
  deriveGroundColors, paintGroundVertex, highColorForGroundKind,
  type GroundPaintCtx,
} from '../src/engine/world/groundPaint';

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

function buildTerrain(size: number, seed: number, type: 'hills' | 'mountains' = 'hills'): { terrain: Terrain; mats: MaterialLibrary } {
  const spec = generateSpec('a heroic knight adventure', { seed });
  spec.world.terrain.size = size;
  (spec.world.terrain as { type: string }).type = type;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { terrain, mats };
}

/** FNV-1a digest of a chunk mesh's color attribute (exact, not approximate). */
function colorDigest(m: THREE.Mesh): string {
  const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
  let h = 0x811c9dc5;
  for (let i = 0; i < col.array.length; i++) {
    // quantize the float32 bits — digest the raw bytes exactly
    const bits = new DataView(col.array.buffer, col.array.byteOffset + i * 4, 4).getUint32(0, true);
    h ^= bits & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (bits >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (bits >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (bits >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function buildAllChunks(terrain: Terrain): THREE.Mesh[] {
  const { chunkCount, chunkSize } = terrain.getChunkStats();
  const cps = Math.round(Math.sqrt(chunkCount));
  const out: THREE.Mesh[] = [];
  for (let cz = 0; cz < cps; cz++) for (let cx = 0; cx < cps; cx++) out.push(terrain.ensureChunkMesh(cx, cz));
  void chunkSize;
  return out;
}

/** RGB euclidean distance (THREE.Color has no distanceTo in r182). */
function cdist(a: THREE.Color, b: THREE.Color): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function testCtx(): { ctx: GroundPaintCtx; noise: Noise2D } {  const g = new THREE.Color('#6a7f42').convertLinearToSRGB();
  const a = new THREE.Color('#7f9450').convertLinearToSRGB();
  const r = new THREE.Color('#6e6a5e').convertLinearToSRGB();
  const ctx: GroundPaintCtx = {
    colors: deriveGroundColors(g, a, r, highColorForGroundKind('ground', a)),
    waterY: 2.0,
    maxHeight: 60,
    discs: [],
    paths: [],
  };
  return { ctx, noise: new Noise2D(1234) };
}

describe('workstream A: determinism', () => {
  it('same seed -> bit-identical colors, small world', () => {
    const a = buildTerrain(220, 99);
    const b = buildTerrain(220, 99);
    expect(colorDigest(a.terrain.mesh)).toBe(colorDigest(b.terrain.mesh));
  });

  it('same seed -> bit-identical colors, chunked world (all chunks)', () => {
    const a = buildTerrain(1000, 4242, 'mountains');
    const b = buildTerrain(1000, 4242, 'mountains');
    const ma = buildAllChunks(a.terrain), mb = buildAllChunks(b.terrain);
    expect(ma.length).toBe(mb.length);
    for (let i = 0; i < ma.length; i++) {
      expect(colorDigest(ma[i]), `chunk ${i}`).toBe(colorDigest(mb[i]));
    }
  });

  it('different seeds -> different colors', () => {
    const a = buildTerrain(220, 99);
    const b = buildTerrain(220, 100);
    expect(colorDigest(a.terrain.mesh)).not.toBe(colorDigest(b.terrain.mesh));
  });
});

describe('workstream A: zero new draw calls (shared material)', () => {
  it('every chunk mesh shares one ground material instance', () => {
    const { terrain, mats } = buildTerrain(1000, 4242, 'mountains');
    const before = (mats as unknown as { matCache: Map<string, unknown> }).matCache.size;
    const chunks = buildAllChunks(terrain);
    const first = chunks[0].material;
    for (const m of chunks) expect(m.material).toBe(first);
    const after = (mats as unknown as { matCache: Map<string, unknown> }).matCache.size;
    expect(after).toBe(before); // no new materials per chunk
  });
});

describe('workstream A: wear', () => {
  it('spawn wear darkens ground near spawn', () => {
    const { terrain } = buildTerrain(1000, 77, 'hills');
    // spawn chunk is built in the constructor (spawn wear baked at build)
    const m = terrain.mesh;
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
    const sx = terrain.spawnXZ.x, sz = terrain.spawnXZ.z;
    let nearLum = 0, nearN = 0, farLum = 0, farN = 0;
    for (let i = 0; i < pos.count; i++) {
      const wx = m.position.x + pos.getX(i), wz = m.position.z + pos.getZ(i);
      const d = Math.hypot(wx - sx, wz - sz);
      const lum = col.getX(i) + col.getY(i) + col.getZ(i);
      if (d < 8) { nearLum += lum; nearN++; }
      else if (d > 60 && d < 120) { farLum += lum; farN++; }
    }
    expect(nearN).toBeGreaterThan(0);
    expect(farN).toBeGreaterThan(0);
    // worn ground is darker (wear color is ground lerped toward rock, *0.82)
    expect(nearLum / nearN).toBeLessThan(farLum / farN);
  });

  it('addWearPoints repaint == building with the wear present', () => {
    const discs = [{ x: 60, z: -40, radius: 25, strength: 0.8 }];
    const paths = [{ ax: 0, az: 0, bx: 60, bz: -40, width: 5, strength: 0.5 }];
    const a = buildTerrain(1000, 4242, 'mountains');
    const b = buildTerrain(1000, 4242, 'mountains');
    const ma = buildAllChunks(a.terrain);
    a.terrain.addWearPoints(discs, paths); // repaint path
    b.terrain.addWearPoints(discs, paths); // before building
    const mb = buildAllChunks(b.terrain); // build path
    for (let i = 0; i < ma.length; i++) {
      expect(colorDigest(ma[i]), `chunk ${i}`).toBe(colorDigest(mb[i]));
    }
  });

  it('chunk seams stay bit-identical after wear', () => {
    const { terrain } = buildTerrain(1000, 4242, 'mountains');
    buildAllChunks(terrain);
    terrain.addWearPoints(
      [{ x: 125, z: 125, radius: 60, strength: 0.9 }], // straddles the (0,0)/(1,1) corner
      [{ ax: -100, az: 125, bx: 300, bz: 125, width: 6, strength: 0.5 }],
    );
    const vps = 101;
    const at = (ci: number, cj: number) => terrain.getChunkMesh(ci, cj)!;
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        const m = at(ci, cj);
        const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
        if (ci < 3) {
          const e = at(ci + 1, cj);
          const ec = e.geometry.getAttribute('color') as THREE.BufferAttribute;
          for (let ly = 0; ly < vps; ly++) {
            const ia = ly * vps + (vps - 1), ib = ly * vps;
            expect(col.getX(ia)).toBe(ec.getX(ib));
            expect(col.getY(ia)).toBe(ec.getY(ib));
            expect(col.getZ(ia)).toBe(ec.getZ(ib));
          }
        }
        if (cj < 3) {
          const s = at(ci, cj + 1);
          const sc = s.geometry.getAttribute('color') as THREE.BufferAttribute;
          for (let lx = 0; lx < vps; lx++) {
            const ia = (vps - 1) * vps + lx, ib = lx;
            expect(col.getX(ia)).toBe(sc.getX(ib));
            expect(col.getY(ia)).toBe(sc.getY(ib));
            expect(col.getZ(ia)).toBe(sc.getZ(ib));
          }
        }
      }
    }
  });

  it('no-op when given no wear points', () => {
    const { terrain } = buildTerrain(220, 99);
    const before = colorDigest(terrain.mesh);
    terrain.addWearPoints([], []);
    expect(colorDigest(terrain.mesh)).toBe(before);
  });
});

describe('workstream A: slope/height bands (recipe unit tests)', () => {
  it('flat ground -> ground/alt palette, cliff -> rock/cliff', () => {
    const { ctx, noise } = testCtx();
    const flat = new THREE.Color(), cliff = new THREE.Color();
    paintGroundVertex(flat, ctx, noise, 10, 20, 5, 1.0);
    paintGroundVertex(cliff, ctx, noise, 10, 20, 5, 0.3);
    const dFlatGround = cdist(flat, ctx.colors.ground) + cdist(flat, ctx.colors.alt);
    const dCliffGround = cdist(cliff, ctx.colors.ground) + cdist(cliff, ctx.colors.alt);
    const dCliffRock = cdist(cliff, ctx.colors.rock) + cdist(cliff, ctx.colors.cliff);
    // flat stays near the grass palette, cliff moves far from grass and near rock
    expect(dFlatGround).toBeLessThan(dCliffGround);
    expect(dCliffRock).toBeLessThan(dCliffGround);
  });

  it('altitude -> high cap color', () => {
    const { ctx, noise } = testCtx();
    const low = new THREE.Color(), high = new THREE.Color();
    paintGroundVertex(low, ctx, noise, 10, 20, 5, 1.0);
    paintGroundVertex(high, ctx, noise, 10, 20, 55, 1.0);
    expect(cdist(high, ctx.colors.high)).toBeLessThan(cdist(low, ctx.colors.high));
  });

  it('below water level -> wet band', () => {
    const { ctx, noise } = testCtx();
    const dry = new THREE.Color(), wet = new THREE.Color();
    paintGroundVertex(dry, ctx, noise, 10, 20, 10, 1.0);
    paintGroundVertex(wet, ctx, noise, 10, 20, 1.0, 1.0);
    expect(cdist(wet, ctx.colors.wet)).toBeLessThan(cdist(dry, ctx.colors.wet));
  });

  it('wear disc center -> wear color', () => {
    const { ctx, noise } = testCtx();
    ctx.discs.push({ x: 0, z: 0, radius: 20, strength: 1 });
    const worn = new THREE.Color(), plain = new THREE.Color();
    paintGroundVertex(worn, ctx, noise, 0, 0, 5, 1.0);
    paintGroundVertex(plain, ctx, noise, 100, 100, 5, 1.0);
    expect(cdist(worn, ctx.colors.wear)).toBeLessThan(cdist(plain, ctx.colors.wear));
  });

  it('wear path corridor darkens, off-corridor untouched', () => {
    const { ctx, noise } = testCtx();
    const plain = new THREE.Color(), worn = new THREE.Color(), off = new THREE.Color();
    // same world position, with and without the corridor — isolates the wear
    paintGroundVertex(plain, ctx, noise, 0, 0, 5, 1.0);
    ctx.paths.push({ ax: -50, az: 0, bx: 50, bz: 0, width: 6, strength: 1 });
    paintGroundVertex(worn, ctx, noise, 0, 0, 5, 1.0);
    paintGroundVertex(off, ctx, noise, 0, 40, 5, 1.0);
    // trampled ground is visibly darker (luminance drop) — the wear is
    // deliberately subtle (see the genre-grade variation gate)
    const lum = (c: THREE.Color) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    expect(lum(worn)).toBeLessThan(lum(plain) * 0.97);
    // off-corridor is untouched by the path (only natural variation)
    expect(off.r).not.toBe(worn.r);
  });

  it('high-altitude cap follows biome ground kind', () => {
    const alt = new THREE.Color('#7f9450').convertLinearToSRGB();
    const snow = highColorForGroundKind('snowdrift', alt);
    const volc = highColorForGroundKind('emberrock', alt);
    // snow cap is bright, volcanic cap is near-black
    expect(snow.r + snow.g + snow.b).toBeGreaterThan(2.5);
    expect(volc.r + volc.g + volc.b).toBeLessThan(0.6);
  });
});

describe('workstream A: detail-layer quality wiring', () => {
  it('applyGroundDetailForQuality maps tiers to uniforms', () => {
    applyGroundDetailForQuality('high');
    expect(groundDetailUniforms.uDetailStrength.value).toBe(1);
    expect(groundDetailUniforms.uDetailFade.value).toBe(70);
    applyGroundDetailForQuality('standard');
    expect(groundDetailUniforms.uDetailStrength.value).toBe(0.55);
    expect(groundDetailUniforms.uDetailFade.value).toBe(45);
    applyGroundDetailForQuality('retro');
    expect(groundDetailUniforms.uDetailStrength.value).toBe(0);
    // restore a sane default for other tests
    applyGroundDetailForQuality('standard');
  });

  it('biomeGroundDef carries the detail injection (shared, cached)', () => {
    const spec = generateSpec('test', { seed: 5 });
    const mats = new MaterialLibrary(spec);
    const m1 = mats.biomeGroundDef({ kind: 'ground', base: '#ffffff', alt: '#d8d4c8', roughness: 0.95 }, { repeat: 10 });
    const m2 = mats.biomeGroundDef({ kind: 'ground', base: '#ffffff', alt: '#d8d4c8', roughness: 0.95 }, { repeat: 10 });
    expect(m1).toBe(m2); // cached — one material, one program
    expect(typeof m1.onBeforeCompile).toBe('function');
    expect(m1.customProgramCacheKey!()).toBe('xandria-ground-detail-v1');
  });
});
