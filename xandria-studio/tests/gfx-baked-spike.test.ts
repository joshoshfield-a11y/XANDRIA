/**
 * Graphics-overhaul Pass 0 spike — baked texture registry + wiring.
 * - Registry: known ids resolve, unknown ids are null (fallback contract).
 * - Skins: { baked } stamps map + normalMap on shirt/pants roles only via
 *   owned materials; palette still applies; unknown baked id → palette
 *   stands, no throw, map stays null.
 * - Materials: biomeGroundDef with a known baked id uses the baked pair;
 *   an unknown baked id falls back to the canvas texture path.
 * - Schema: { baked } validates; empty baked id rejects.
 *
 * DOM stub: three's ImageLoader needs document.createElementNS('img')
 * with addEventListener; Materials' canvas painters need a 2d context
 * with createImageData/putImageData. Neither stub ever fires a load —
 * the Texture objects are asserted, not their pixels (pixels are
 * proven by the spike demo screenshots in Chromium).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { validateSpec, defaultSpec, type GameSpec, type SkinDef } from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid } from '../src/engine/gfx/Characters';
import { BUILT_IN_SKINS, applySkin } from '../src/engine/gfx/Skins';
import { BUILT_IN_ITEM_SKINS, applyItemSkin } from '../src/engine/gfx/ItemSkins';
import { BIOMES } from '../src/engine/world/Biomes';
import {
  BAKED_TEXTURES, hasBakedTexture, bakedTexture, bakedNormalTexture,
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

function roleMats(rig: any, role: string): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  rig.group.traverse((o: any) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m?.userData?.owned && m.userData.role === role) out.push(m);
  });
  return out;
}

describe('baked texture registry', () => {
  it('lists the spike set and resolves known ids', () => {
    expect(Object.keys(BAKED_TEXTURES).sort()).toEqual([
      'accent-hazard', 'accent-runes', 'fabric-camo', 'fabric-carbon',
      'ground-basalt', 'ground-caverock', 'ground-cracked', 'ground-grass',
      'ground-litter', 'ground-snow', 'ground-wetsand', 'item-brushed',
      'item-energy', 'item-wood', 'pants-denim', 'skin-matte',
      'spike-ground', 'spike-shirt',
    ]);
    expect(hasBakedTexture('spike-shirt')).toBe(true);
    expect(hasBakedTexture('nope')).toBe(false);
    expect(bakedTexture('nope')).toBeNull();
    expect(bakedNormalTexture('nope')).toBeNull();
  });

  it('returns cached, correctly-flagged textures', () => {
    const a = bakedTexture('spike-shirt')!;
    const b = bakedTexture('spike-shirt')!;
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(THREE.Texture);
    expect(a.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(a.wrapS).toBe(THREE.RepeatWrapping);
    const n = bakedNormalTexture('spike-shirt')!;
    expect(n.colorSpace).not.toBe(THREE.SRGBColorSpace); // normals stay linear
  });
});

/** Spike skin as a literal def (not a built-in): the shipped roster is untouched. */
const SPIKE_SKIN: SkinDef = {
  name: 'Spike Baked (Pass 0)',
  palette: { skin: '#8a6a52', shirt: '#3d7a8c', pants: '#2a3540', accent: '#ffb43c' },
  texture: { baked: 'spike-shirt' },
  roughness: 0.85,
  metalness: 0.05,
};

describe('skins baked path', () => {
  it('spike-baked skin stamps map + normal on shirt/pants and tints via palette', () => {
    const rig = makeHumanoid(new MaterialLibrary(testSpec), {}, 42);
    applySkin(rig, SPIKE_SKIN);
    const shirts = roleMats(rig, 'shirt');
    expect(shirts.length).toBeGreaterThan(0);
    for (const m of shirts) {
      expect(m.map).toBe(bakedTexture('spike-shirt'));
      expect(m.normalMap).toBe(bakedNormalTexture('spike-shirt'));
      expect('#' + m.color.getHexString()).toBe('#3d7a8c');
    }
    // skin role gets the palette color but no texture map
    for (const m of roleMats(rig, 'skin')) expect(m.map).toBeNull();
  });

  it('unknown baked id falls back to palette, never throws', () => {
    const rig = makeHumanoid(new MaterialLibrary(testSpec), {}, 43);
    const skin: SkinDef = {
      name: 'Bad Baked',
      palette: { skin: '#d9a066', shirt: '#112233', pants: '#222222', accent: '#ffffff' },
      texture: { baked: 'nope' },
    };
    expect(() => applySkin(rig, skin)).not.toThrow();
    for (const m of roleMats(rig, 'shirt')) {
      expect(m.map).toBeNull();
      expect('#' + m.color.getHexString()).toBe('#112233');
    }
  });
});

describe('materials baked ground path', () => {
  it('known baked id uses the baked pair', () => {
    const mats = new MaterialLibrary(testSpec);
    const m = mats.biomeGroundDef(
      { kind: 'ground', base: '#ffffff', alt: '#ffffff', roughness: 0.95, baked: 'spike-ground' },
      { repeat: 3 },
    );
    expect(m.map).toBe(bakedTexture('spike-ground'));
    expect(m.normalMap).toBe(bakedNormalTexture('spike-ground'));
    expect(m.roughness).toBe(0.95);
  });

  it('unknown baked id falls back to the canvas texture', () => {
    const mats = new MaterialLibrary(testSpec);
    const m = mats.biomeGroundDef(
      { kind: 'ground', base: '#ffffff', alt: '#ffffff', roughness: 0.95, baked: 'nope' },
      { repeat: 1 },
    );
    expect(m.map).not.toBeNull();
    expect(m.map).not.toBe(bakedTexture('spike-ground'));
    expect(m.map).toBeInstanceOf(THREE.CanvasTexture);
  });
});

describe('schema baked texture form', () => {
  it('accepts { baked } and rejects an empty id', () => {
    const spec = defaultSpec();
    (spec as any).custom = {
      characters: {
        skins: {
          'test-baked': {
            name: 'T', palette: { skin: '#ffffff', shirt: '#ffffff', pants: '#ffffff', accent: '#ffffff' },
            texture: { baked: 'spike-shirt' },
          },
        },
      },
    };
    expect(validateSpec(spec).errors).toHaveLength(0);
    (spec as any).custom.characters.skins['test-baked'].texture = { baked: '' };
    expect(validateSpec(spec).errors.length).toBeGreaterThan(0);
  });
});

describe('Pass A: full-overhaul baked wiring', () => {
  it('every built-in skin has a known baked main texture + skin/pants per-role textures', () => {
    const ids = Object.keys(BUILT_IN_SKINS);
    expect(ids).toHaveLength(16);
    for (const id of ids) {
      const def = BUILT_IN_SKINS[id];
      expect(def.texture && 'baked' in def.texture && hasBakedTexture((def.texture as { baked: string }).baked)).toBe(true);
      expect(def.textures?.skin?.baked).toBe('skin-matte');
      expect(def.textures?.pants?.baked).toBe('pants-denim');
    }
    expect(BUILT_IN_SKINS.rustscrap.textures?.accent?.baked).toBe('accent-hazard');
  });

  it('built-in skin application stamps main + per-role maps on the right roles', () => {
    const rig = makeHumanoid(new MaterialLibrary(testSpec), {}, 42);
    applySkin(rig, BUILT_IN_SKINS.stealth);
    expect(roleMats(rig, 'shirt')[0].map).toBe(bakedTexture('fabric-carbon'));
    expect(roleMats(rig, 'pants')[0].map).toBe(bakedTexture('pants-denim'));
    expect(roleMats(rig, 'skin')[0].map).toBe(bakedTexture('skin-matte'));
    rig.dispose();
  });

  it('unknown per-role baked id is skipped, never throws, main texture still lands', () => {
    const rig = makeHumanoid(new MaterialLibrary(testSpec), {}, 42);
    const def: SkinDef = {
      name: 'X', texture: { baked: 'spike-shirt' },
      textures: { shirt: { baked: 'nope' } },
    };
    expect(() => applySkin(rig, def)).not.toThrow();
    expect(roleMats(rig, 'shirt')[0].map).toBe(bakedTexture('spike-shirt'));
    rig.dispose();
  });

  it('item skins: steel gets brushed metal, storm glow gets the energy strip', () => {
    const mesh = new THREE.Group();
    for (const role of ['primary', 'secondary', 'glow']) {
      const m = new THREE.MeshStandardMaterial();
      m.userData.owned = true; m.userData.role = role;
      const meshObj = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m);
      mesh.add(meshObj);
    }
    applyItemSkin(mesh, BUILT_IN_ITEM_SKINS.steel);
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    mesh.traverse((o: any) => { if (o.isMesh) mats.set(o.material.userData.role, o.material); });
    expect(mats.get('primary')!.map).toBe(bakedTexture('item-brushed'));
    applyItemSkin(mesh, BUILT_IN_ITEM_SKINS.storm);
    expect(mats.get('glow')!.map).toBe(bakedTexture('item-energy'));
  });

  it('every shipped biome ground uses a known baked texture through the real Materials path', () => {
    const mats = new MaterialLibrary(testSpec);
    for (const biome of Object.values(BIOMES)) {
      expect(biome.ground.baked, biome.id).toBeTruthy();
      expect(hasBakedTexture(biome.ground.baked!)).toBe(true);
      const mat = mats.biomeGroundDef(biome.ground, { repeat: 2 });
      expect(mat.map).toBe(bakedTexture(biome.ground.baked!));
    }
  });

  it('armor shells (nomad skin) carry the brushed metal map', () => {
    const rig = makeHumanoid(new MaterialLibrary(testSpec), {}, 42);
    applySkin(rig, BUILT_IN_SKINS.nomad);
    const armorMats: THREE.MeshStandardMaterial[] = [];
    rig.group.traverse((o: any) => {
      if (o.isMesh && o.userData?.armorPiece) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) armorMats.push(m);
      }
    });
    expect(armorMats.length).toBeGreaterThan(0);
    expect(armorMats.some((m) => m.map === bakedTexture('item-brushed'))).toBe(true);
    rig.dispose();
  });

  it('schema accepts per-role textures on skins and items, rejects bad roles', () => {
    const spec = defaultSpec();
    (spec as any).custom = {
      characters: { skins: { t1: {
        name: 'T', texture: { baked: 'spike-shirt' },
        textures: { shirt: { baked: 'fabric-carbon' } } } } },
      items: { skins: { t2: {
        name: 'I', texture: { baked: 'item-brushed' },
        textures: { glow: { baked: 'item-energy' } } } } },
    };
    expect(validateSpec(spec).errors).toHaveLength(0);
    (spec as any).custom.characters.skins.t1.textures = { cape: { baked: 'x' } };
    expect(validateSpec(spec).errors.length).toBeGreaterThan(0);
  });
});
