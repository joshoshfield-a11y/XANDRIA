/**
 * Graphics Pass D — shared-repeat fix + structure/prop baked surfaces.
 * - D1: a repeat never mutates a shared texture. Baked grounds get a
 *   per-repeat load; canvas textures get a per-repeat clone. Two
 *   materials with different repeats hold different repeats, and the
 *   shared texture keeps its default repeat.
 * - D2: Materials.standard() maps rock/metal/wood/panel/concrete to the
 *   baked surf tiles (luminance-first, so the hex rides on material
 *   color); unmapped kinds keep the canvas path.
 *
 * DOM stub: same as gfx-baked-spike.test.ts — Texture objects are
 * asserted, not their pixels (pixels are proven by the gate screenshots
 * in Chromium).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import {
  BAKED_TEXTURES, hasBakedTexture, bakedTexture, bakedNormalTexture,
  bakedTextureInstance, bakedNormalTextureInstance,
} from '../src/engine/gfx/BakedTextures';

const fakeImg = () => ({
  addEventListener() {},
  removeEventListener() {},
});
const fakeCtx = (size: number) => ({
  createImageData: (w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
  }),
  putImageData() {},
  getImageData: (x: number, y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
  }),
  fillRect() {},
  drawImage() {},
});
(globalThis as any).document = {
  createElementNS: () => fakeImg(),
  createElement: (tag: string) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => fakeCtx(256) }
    : fakeImg(),
};

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  theme: { environment: 'arena' },
  world: { size: 64 },
};

describe('D1: per-repeat baked instances', () => {
  it('different repeats give different instances; shared texture untouched', () => {
    const a = bakedTextureInstance('ground-grass', 2)!;
    const b = bakedTextureInstance('ground-grass', 4)!;
    expect(a).not.toBe(b);
    expect(a.repeat.x).toBe(2);
    expect(b.repeat.x).toBe(4);
    expect(a).toBe(bakedTextureInstance('ground-grass', 2));
    expect(bakedTexture('ground-grass')!.repeat.x).toBe(1);
    const na = bakedNormalTextureInstance('ground-grass', 2)!;
    expect(na.repeat.x).toBe(2);
    expect(na).not.toBe(bakedNormalTexture('ground-grass'));
  });

  it('repeat 1 or absent returns the shared texture', () => {
    expect(bakedTextureInstance('ground-grass')).toBe(bakedTexture('ground-grass'));
    expect(bakedTextureInstance('ground-grass', 1)).toBe(bakedTexture('ground-grass'));
  });

  it('unknown id stays null', () => {
    expect(bakedTextureInstance('nope', 2)).toBeNull();
    expect(bakedNormalTextureInstance('nope', 2)).toBeNull();
  });

  it('biome grounds with different repeats no longer share a texture', () => {
    const mats = new MaterialLibrary(testSpec);
    const g = { kind: 'ground' as const, base: '#ffffff', alt: '#ffffff', roughness: 0.95, baked: 'ground-grass' };
    const m2 = mats.biomeGroundDef(g, { repeat: 2 });
    const m4 = mats.biomeGroundDef(g, { repeat: 4 });
    expect(m2.map).not.toBe(m4.map);
    expect((m2.map as THREE.Texture).repeat.x).toBe(2);
    expect((m4.map as THREE.Texture).repeat.x).toBe(4);
    expect(bakedTexture('ground-grass')!.repeat.x).toBe(1);
  });
});

describe('D1: per-repeat canvas instances', () => {
  it('canvas texture/normal/emissive repeats are isolated per repeat', () => {
    const mats = new MaterialLibrary(testSpec);
    const t2 = mats.texture('rock', '#808080', { repeat: 2 });
    const t3 = mats.texture('rock', '#808080', { repeat: 3 });
    expect(t2).not.toBe(t3);
    expect(t2.repeat.x).toBe(2);
    expect(t3.repeat.x).toBe(3);
    expect(t2).toBe(mats.texture('rock', '#808080', { repeat: 2 }));
    expect(mats.texture('rock', '#808080').repeat.x).toBe(1);
    const n2 = mats.normalMap('rock', '#808080', { repeat: 2 });
    expect(n2.repeat.x).toBe(2);
    expect(n2).not.toBe(mats.normalMap('rock', '#808080'));
    const e2 = mats.emissiveMap('rock', { repeat: 2 });
    const e3 = mats.emissiveMap('rock', { repeat: 3 });
    expect(e2).not.toBe(e3);
    expect(e2.repeat.x).toBe(2);
  });
});

describe('D2: structure/prop baked surfaces', () => {
  it('registry lists the five surf tiles, mirrored', () => {
    for (const id of ['surf-rock', 'surf-metal', 'surf-wood', 'surf-panel', 'surf-concrete']) {
      expect(hasBakedTexture(id)).toBe(true);
      expect(BAKED_TEXTURES[id].mirror).toBe(true);
      expect(BAKED_TEXTURES[id].normal).toBeTruthy();
    }
  });

  it('standard() maps the five kinds to baked tiles with hex on color', () => {
    const mats = new MaterialLibrary(testSpec);
    const cases: Array<[any, string]> = [
      ['rock', 'surf-rock'], ['metal', 'surf-metal'], ['wood', 'surf-wood'],
      ['panel', 'surf-panel'], ['concrete', 'surf-concrete'],
    ];
    for (const [kind, id] of cases) {
      const m = mats.standard(kind, '#7a756e');
      expect(m.map).toBe(bakedTexture(id));
      expect(m.normalMap).toBe(bakedNormalTexture(id));
      expect('#' + m.color.getHexString()).toBe('#7a756e');
    }
  });

  it('standard() with a repeat uses a per-repeat baked instance', () => {
    const mats = new MaterialLibrary(testSpec);
    const m = mats.standard('rock', '#7a756e', { repeat: 3 });
    expect(m.map).not.toBe(bakedTexture('surf-rock'));
    expect((m.map as THREE.Texture).repeat.x).toBe(3);
    expect(bakedTexture('surf-rock')!.repeat.x).toBe(1);
  });

  it('unmapped kinds keep the canvas path', () => {
    const mats = new MaterialLibrary(testSpec);
    const m = mats.standard('brick', '#7a756e');
    expect(m.map).toBeInstanceOf(THREE.CanvasTexture);
    expect(m.map).not.toBe(bakedTexture('surf-rock'));
  });
});
