/**
 * Beauty wave, workstream A — skin library upgrade.
 * - 12 built-in skins: all valid (schema-shaped), deterministic
 * - new painters (hazard / fade / runes) + upgraded camo produce CanvasTextures
 * - textureRoles land the map on the right roles (rustscrap → accent only)
 * - applySkin still mutates ONLY owned role materials (shared cache untouched)
 * - never throws on garbage (bad pattern, bad textureRoles, null skin)
 * - schema: accepts new patterns + textureRoles, rejects unknown roles
 * - specOps accent tweak: writes a custom override, reset restores the built-in
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  validateSpec, defaultSpec, SKIN_TEXTURE_PATTERNS, SKIN_TEXTURE_ROLES,
  type GameSpec, type SkinTexturePattern, type SkinDef,
} from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import { forgeHumanoidPlan } from '../src/engine/gfx/ModelForge';
import {
  BUILT_IN_SKINS, resolveSkinDef, applySkin, availableSkinIds, makePatternTexture,
} from '../src/engine/gfx/Skins';
import { bakedTexture } from '../src/engine/gfx/BakedTextures';
import {
  listSkinIds, setCustomSkinAccent, hasCustomSkinOverride,
} from '../src/studio/editor/specOps';

/* DOM stub: document.createElement('canvas') with a recording 2d context
 * (Skins paints patterns; fade uses createLinearGradient, runes uses shadowBlur). */
const ctx2d = () => {
  const calls: string[] = [];
  const gradient = { addColorStop(..._a: unknown[]) { calls.push('addColorStop'); } };
  const ctx = {
    calls,
    set fillStyle(_v: string) {},
    get fillStyle() { return '#000'; },
    set strokeStyle(_v: string) {},
    get strokeStyle() { return '#000'; },
    set lineWidth(_v: number) {},
    get lineWidth() { return 1; },
    set shadowBlur(_v: number) {},
    get shadowBlur() { return 0; },
    set shadowColor(_v: string) {},
    get shadowColor() { return '#000'; },
    fillRect(..._a: unknown[]) { calls.push('fillRect'); },
    beginPath() { calls.push('beginPath'); },
    moveTo(..._a: unknown[]) {},
    lineTo(..._a: unknown[]) { calls.push('lineTo'); },
    ellipse(..._a: unknown[]) { calls.push('ellipse'); },
    fill() { calls.push('fill'); },
    stroke() { calls.push('stroke'); },
    createLinearGradient(..._a: unknown[]) { calls.push('createLinearGradient'); return gradient; },
  };
  return ctx;
};
(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d() }),
};

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
const withChars = (characters: unknown) => {
  const s = defaultSpec(1) as GameSpec;
  (s as unknown as { custom: unknown }).custom = { characters };
  return validateSpec(s);
};
const roleMat = (rig: CharacterRig, role: string): THREE.MeshStandardMaterial => {
  let hit: THREE.MeshStandardMaterial | null = null;
  rig.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || hit) return;
    for (const mm of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[]) {
      if (mm.userData.role === role) { hit = mm as THREE.MeshStandardMaterial; break; }
    }
  });
  if (!hit) throw new Error(`no material with role ${role}`);
  return hit;
};
const isHex = (v: unknown): boolean => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

describe('beauty wave: built-in skin library', () => {
  it('has 16 skins and every def is schema-valid + deterministic', () => {
    const ids = Object.keys(BUILT_IN_SKINS);
    expect(ids).toHaveLength(16);
    for (const id of ids) {
      const def = BUILT_IN_SKINS[id];
      expect(def.name, `${id}.name`).toBeTruthy();
      if (def.palette) for (const [role, hex] of Object.entries(def.palette)) {
        expect(['skin', 'shirt', 'pants', 'accent']).toContain(role);
        expect(isHex(hex), `${id}.palette.${role}`).toBe(true);
      }
      if (def.emissive) {
        expect(isHex(def.emissive.color), `${id}.emissive.color`).toBe(true);
        expect(def.emissive.intensity).toBeGreaterThanOrEqual(0);
        expect(def.emissive.intensity).toBeLessThanOrEqual(5);
      }
      if (def.roughness !== undefined) { expect(def.roughness).toBeGreaterThanOrEqual(0); expect(def.roughness).toBeLessThanOrEqual(1); }
      if (def.metalness !== undefined) { expect(def.metalness).toBeGreaterThanOrEqual(0); expect(def.metalness).toBeLessThanOrEqual(1); }
      if (def.texture && 'pattern' in def.texture)
        expect(SKIN_TEXTURE_PATTERNS).toContain(def.texture.pattern);
      if (def.textureRoles) for (const r of def.textureRoles)
        expect(SKIN_TEXTURE_ROLES).toContain(r);
      // deterministic: two applications to fresh same-seed rigs agree on every channel
      const a = makeHumanoid(mats(), {}, 42);
      const b = makeHumanoid(mats(), {}, 42);
      applySkin(a, def); applySkin(b, def);
      for (const role of ['skin', 'shirt', 'pants', 'accent']) {
        expect(roleMat(a, role).color.getHex(), `${id}.${role}.color`).toBe(roleMat(b, role).color.getHex());
        expect(roleMat(a, role).roughness, `${id}.${role}.roughness`).toBe(roleMat(b, role).roughness);
        expect(roleMat(a, role).metalness, `${id}.${role}.metalness`).toBe(roleMat(b, role).metalness);
        expect(roleMat(a, role).emissive.getHex(), `${id}.${role}.emissive`).toBe(roleMat(b, role).emissive.getHex());
      }
      // accentDS (cape cloth) exists only when the plan rolls a cape — check when present
      const cape = (r: CharacterRig): THREE.MeshStandardMaterial | null => {
        let hit: THREE.MeshStandardMaterial | null = null;
        r.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || hit) return;
          for (const mm of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[])
            if (mm.userData.role === 'accentDS') { hit = mm as THREE.MeshStandardMaterial; break; }
        });
        return hit;
      };
      const ca = cape(a), cb = cape(b);
      if (ca && cb) expect(ca.color.getHex(), `${id}.accentDS.color`).toBe(cb.color.getHex());
      a.dispose(); b.dispose();
    }
  });

  it('genre-flavored ids all resolve', () => {
    for (const id of ['neonstreet', 'rustscrap', 'spectral', 'royalguard', 'desertnomad', 'abyssal', 'solarpaladin', 'cyberronin']) {
      expect(resolveSkinDef(defaultSpec(1) as GameSpec, id)?.name, id).toBeTruthy();
      expect(availableSkinIds(defaultSpec(1) as GameSpec)).toContain(id);
      expect(listSkinIds(defaultSpec(1) as GameSpec)).toContain(id);
    }
  });

  it('every named pattern (incl. new hazard/fade/runes) paints a CanvasTexture', () => {
    const seen: SkinTexturePattern[] = ['camo', 'stripes', 'digital', 'carbon', 'hazard', 'fade', 'runes'];
    expect([...SKIN_TEXTURE_PATTERNS].sort()).toEqual([...seen].sort());
    for (const p of seen) {
      const tex = makePatternTexture(p);
      expect(tex, p).toBeInstanceOf(THREE.CanvasTexture);
    }
  });
});

describe('beauty wave: pattern quality + role targeting', () => {
  it('unknown patterns return null (never throw without a canvas)', () => {
    expect(makePatternTexture('plaid' as never)).toBeNull();
  });

  it('per-role baked maps (Pass A): rustscrap camo body + hazard accent + denim pants', () => {
    const rig = makeHumanoid(mats(), {}, 5);
    applySkin(rig, BUILT_IN_SKINS.rustscrap);
    expect(roleMat(rig, 'shirt').map).toBe(bakedTexture('fabric-camo'));
    expect(roleMat(rig, 'accent').map).toBe(bakedTexture('accent-hazard'));
    expect(roleMat(rig, 'pants').map).toBe(bakedTexture('pants-denim'));
    rig.dispose();
  });

  it('default roles still get shirt+pants (neonstreet + cyberronin now baked carbon)', () => {
    const rig = makeHumanoid(mats(), {}, 6);
    applySkin(rig, BUILT_IN_SKINS.neonstreet);
    expect(roleMat(rig, 'shirt').map).toBe(bakedTexture('fabric-carbon'));
    expect(roleMat(rig, 'pants').map).toBe(bakedTexture('pants-denim'));
    expect(roleMat(rig, 'accent').map).toBeNull();
    // emissive accent applied
    expect(roleMat(rig, 'accent').emissive.getHex()).toBe(0xff2fd6);
    rig.dispose();
  });

  it('spectral runes apply palette + cyan emissive', () => {
    const rig = makeHumanoid(mats(), {}, 7);
    applySkin(rig, BUILT_IN_SKINS.spectral);
    expect(roleMat(rig, 'shirt').color.getHex()).toBe(0x3a5a7a);
    expect(roleMat(rig, 'accent').emissive.getHex()).toBe(0x9ff2ff);
    expect(roleMat(rig, 'shirt').map).toBe(bakedTexture('accent-runes'));
    rig.dispose();
  });
});

describe('beauty wave: owned-materials-only discipline (extended)', () => {
  it('cyberronin (textured) leaves the exact cached library instances untouched', () => {
    const seed = 13;
    const m = mats();
    const plan = forgeHumanoidPlan(seed, {});
    const cachedShirt = m.flat(plan.colors.shirt, { roughness: 0.85 });
    const cachedAccent = m.flat(plan.colors.accent, { roughness: 0.5, metalness: 0.3 });
    const beforeShirt = cachedShirt.color.getHex();
    const beforeAccent = cachedAccent.color.getHex();

    const rig = makeHumanoid(m, {}, seed);
    applySkin(rig, BUILT_IN_SKINS.cyberronin);

    expect(roleMat(rig, 'shirt').color.getHex()).toBe(0x0f0f13);
    expect(roleMat(rig, 'accent').color.getHex()).toBe(0xff2255);
    expect(roleMat(rig, 'shirt').map).toBe(bakedTexture('fabric-carbon'));
    expect(cachedShirt.color.getHex()).toBe(beforeShirt);
    expect(cachedShirt.map).toBeNull();
    expect(cachedAccent.color.getHex()).toBe(beforeAccent);
    rig.dispose();
  });

  it('never throws on garbage: bad pattern, bad textureRoles, null skin', () => {
    const rig = makeHumanoid(mats(), {}, 31);
    expect(() => applySkin(rig, { name: 'x', texture: { pattern: 'plaid' } } as never)).not.toThrow();
    expect(() => applySkin(rig, { name: 'x', textureRoles: ['cape', ''] } as never)).not.toThrow();
    expect(() => applySkin(rig, { name: 'x', texture: { pattern: 'runes' }, textureRoles: [] } as never)).not.toThrow();
    expect(() => applySkin(rig, null as never)).not.toThrow();
    rig.dispose();
  });
});

describe('beauty wave: schema validation', () => {
  it('accepts the new patterns and textureRoles', () => {
    const v = withChars({
      skins: {
        h: { name: 'H', texture: { pattern: 'hazard' }, textureRoles: ['accent'] },
        f: { name: 'F', texture: { pattern: 'fade' } },
        r: { name: 'R', texture: { pattern: 'runes' }, textureRoles: ['shirt', 'pants', 'accentDS'] },
      },
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects unknown textureRoles entries (hard error)', () => {
    const v = withChars({ skins: { s: { name: 'S', textureRoles: ['cape'] } } });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('skins.s.textureRoles'))).toBe(true);
  });

  it('rejects non-array textureRoles and unknown patterns', () => {
    expect(withChars({ skins: { s: { name: 'S', textureRoles: 'shirt' } } }).ok).toBe(false);
    const v = withChars({ skins: { s: { name: 'S', texture: { pattern: 'plaid' } } } });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('skins.s.texture.pattern'))).toBe(true);
  });
});

describe('beauty wave: specOps accent tweak', () => {
  const fresh = () => defaultSpec(1) as GameSpec;

  it('writes a custom override for a built-in; emissive follows the accent', () => {
    const s = fresh();
    setCustomSkinAccent(s, 'crimson', '#123456');
    expect(hasCustomSkinOverride(s, 'crimson')).toBe(true);
    const def = resolveSkinDef(s, 'crimson') as SkinDef;
    expect(def.name).toBe('Crimson Vanguard');
    expect(def.palette?.accent).toBe('#123456');
    expect(def.emissive?.color).toBe('#123456');
    expect(def.emissive?.intensity).toBe(0.35); // other channels preserved
    expect(def.roughness).toBe(0.6);
    // id listed once
    expect(listSkinIds(s).filter((i) => i === 'crimson')).toHaveLength(1);
    // the override is a valid skin def
    const v = withChars((s.custom as { characters: unknown }).characters);
    expect(v.ok).toBe(true);
  });

  it('reset deletes the override and restores the built-in', () => {
    const s = fresh();
    setCustomSkinAccent(s, 'crimson', '#123456');
    setCustomSkinAccent(s, 'crimson', undefined);
    expect(hasCustomSkinOverride(s, 'crimson')).toBe(false);
    expect(resolveSkinDef(s, 'crimson')?.palette?.accent).toBe('#ff4433');
    expect(s.custom?.characters).toBeUndefined(); // empty characters section cleaned up
  });

  it('tweaking a pure custom skin edits it in place; reset is a built-in-only op', () => {
    const s = fresh();
    (s as unknown as { custom: unknown }).custom = {
      characters: { skins: { mine: { name: 'Mine', palette: { shirt: '#111111', accent: '#222222' } } } },
    };
    setCustomSkinAccent(s, 'mine', '#333333');
    expect((resolveSkinDef(s, 'mine') as SkinDef).palette?.accent).toBe('#333333');
    expect((resolveSkinDef(s, 'mine') as SkinDef).palette?.shirt).toBe('#111111');
    expect(hasCustomSkinOverride(s, 'mine')).toBe(false); // not a built-in → no "override"
    setCustomSkinAccent(s, 'mine', undefined);
    expect(resolveSkinDef(s, 'mine')?.name).toBe('Mine'); // untouched
  });

  it('unknown ids are a no-op', () => {
    const s = fresh();
    expect(() => setCustomSkinAccent(s, 'nope', '#123456')).not.toThrow();
    expect(resolveSkinDef(s, 'nope')).toBeUndefined();
  });
});
