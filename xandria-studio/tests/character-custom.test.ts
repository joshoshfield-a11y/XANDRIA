/**
 * Workstreams D+E — character skins + GLB import pipeline (phase 1).
 * - schema: custom.characters validation (skins, slots, model URLs, boneMap)
 * - skins: applySkin on a real makeHumanoid rig mutates owned materials only;
 *   shared MaterialLibrary instances are untouched; never throws; pattern
 *   textures land on shirt/pants
 * - RigAdapter: Mixamo bone-name normalization + pivot resolution against a
 *   mock hierarchy, manual boneMap override, feet-origin normalization on a
 *   synthetic group, animate() drives mapped pivots, loadRigFromURL fails
 *   closed (null, never throws)
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { validateSpec, defaultSpec, type GameSpec } from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import { forgeHumanoidPlan } from '../src/engine/gfx/ModelForge';
import {
  BUILT_IN_SKINS, resolveSkinDef, applySkin, availableSkinIds,
} from '../src/engine/gfx/Skins';
import {
  normalizeBoneName, resolvePivots, fitModelToHeight, makeRigFromGLTF, loadRigFromURL,
} from '../src/engine/gfx/RigAdapter';

/* DOM stub: document.createElement('canvas') with a recording 2d context
 * (MaterialLibrary builds canvas textures lazily; Skins paints patterns). */
const ctx2d = () => {
  const calls: string[] = [];
  return {
    calls,
    set fillStyle(_v: string) {},
    get fillStyle() { return '#000'; },
    fillRect(..._a: unknown[]) { calls.push('fillRect'); },
    beginPath() { calls.push('beginPath'); },
    moveTo(..._a: unknown[]) {},
    lineTo(..._a: unknown[]) {},
    ellipse(..._a: unknown[]) { calls.push('ellipse'); },
    fill() { calls.push('fill'); },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
  };
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

describe('schema: custom.characters', () => {
  it('accepts a fully-populated characters section', () => {
    const v = withChars({
      skins: {
        nightops: {
          name: 'Night Ops',
          palette: { skin: '#c9995c', shirt: '#101318', pants: '#0c0e12', accent: '#33e0ff' },
          emissive: { color: '#33e0ff', intensity: 1.4 },
          roughness: 0.9, metalness: 0.1,
          texture: { pattern: 'digital' },
        },
        urlskin: { name: 'URL', texture: { url: 'https://cdn.example.com/tex/camo.png' } },
      },
      player: { skin: 'crimson', model: 'https://cdn.example.com/hero.glb', boneMap: { armL: 'mixamorig:LeftArm' } },
      enemies: { walker: { skin: 'nightops' }, brute: { model: 'https://cdn.example.com/brute.gltf?dl=1' } },
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects non-https / non-glb model URLs', () => {
    for (const model of [
      'http://example.com/hero.glb',
      'https://example.com/hero.obj',
      'https://example.com/hero.glb.exe',
      'ftp://example.com/hero.glb',
    ]) {
      const v = withChars({ player: { model } });
      expect(v.ok, model).toBe(false);
      expect(v.errors.some((e) => e.includes('custom.characters.player.model')), model).toBe(true);
    }
  });

  it('rejects malformed skin defs', () => {
    const v = withChars({
      skins: {
        bad: {
          name: '',
          palette: { shirt: 'red', hat: '#112233' },
          emissive: { color: '#zzzzzz', intensity: 99 },
          roughness: 2, metalness: -1,
          texture: { pattern: 'plaid' },
        },
      },
    });
    expect(v.ok).toBe(false);
    const joined = v.errors.join('\n');
    for (const frag of [
      'skins.bad.name', 'skins.bad.palette.shirt', 'skins.bad.palette.hat',
      'skins.bad.emissive.color', 'skins.bad.emissive.intensity',
      'skins.bad.roughness', 'skins.bad.metalness', 'skins.bad.texture.pattern',
    ]) expect(joined, frag).toContain(frag);
  });

  it('rejects http texture URLs and unknown boneMap pivots', () => {
    const v1 = withChars({ skins: { s: { name: 'S', texture: { url: 'http://x.com/a.png' } } } });
    expect(v1.ok).toBe(false);
    const v2 = withChars({ player: { boneMap: { tail: 'TailBone' } } });
    expect(v2.ok).toBe(false);
    expect(v2.errors.some((e) => e.includes('boneMap.tail'))).toBe(true);
  });

  it('rejects non-object characters / slots', () => {
    expect(withChars('nope').ok).toBe(false);
    expect(withChars({ player: 42 }).ok).toBe(false);
    expect(withChars({ enemies: { walker: 'nope' } }).ok).toBe(false);
  });
});

describe('skins: applySkin', () => {
  it('mutates the rig owned materials by role and leaves shared library materials untouched', () => {
    const seed = 11;
    const m = mats();
    const plan = forgeHumanoidPlan(seed, {});
    // the exact cached instances makeHumanoid will clone from
    const cachedShirt = m.flat(plan.colors.shirt, { roughness: 0.85 });
    const cachedSkin = m.flat(plan.colors.skin, { roughness: 0.8 });
    const beforeShirt = cachedShirt.color.getHex();
    const beforeSkin = cachedSkin.color.getHex();

    const rig = makeHumanoid(m, {}, seed);
    applySkin(rig, BUILT_IN_SKINS.crimson);

    expect(roleMat(rig, 'shirt').color.getHex()).toBe(0x8a1f1f);
    expect(roleMat(rig, 'pants').color.getHex()).toBe(0x241a1a);
    expect(roleMat(rig, 'skin').color.getHex()).toBe(0xc98a5a);
    expect(roleMat(rig, 'accent').color.getHex()).toBe(0xff4433);
    // cape cloth (accentDS) mirrors accent
    expect(roleMat(rig, 'accentDS').color.getHex()).toBe(0xff4433);
    // emissive accents applied
    expect(roleMat(rig, 'accent').emissive.getHex()).toBe(0xff2211);
    // roughness/metalness applied
    expect(roleMat(rig, 'shirt').roughness).toBeCloseTo(0.6, 6);
    expect(roleMat(rig, 'shirt').metalness).toBeCloseTo(0.2, 6);
    // shared cache untouched
    expect(cachedShirt.color.getHex()).toBe(beforeShirt);
    expect(cachedSkin.color.getHex()).toBe(beforeSkin);
    rig.dispose();
  });

  it('stamps canvas pattern textures onto shirt/pants (stealth → digital)', () => {
    const rig = makeHumanoid(mats(), {}, 21);
    applySkin(rig, BUILT_IN_SKINS.stealth);
    const shirtMap = roleMat(rig, 'shirt').map;
    const pantsMap = roleMat(rig, 'pants').map;
    expect(shirtMap).toBeInstanceOf(THREE.CanvasTexture);
    expect(pantsMap).toBeInstanceOf(THREE.CanvasTexture);
    rig.dispose();
  });

  it('never throws on garbage input and is a no-op on untagged rigs', () => {
    const rig = makeHumanoid(mats(), {}, 31);
    expect(() => applySkin(rig, { name: 'x', palette: { shirt: 'not-a-color' } } as never)).not.toThrow();
    expect(() => applySkin(rig, null as never)).not.toThrow();
    expect(() => applySkin(rig, { name: 'x', texture: { url: 'notaurl' } } as never)).not.toThrow();
    // imported-style rig: no role tags → no-op
    const plain = { group: new THREE.Group() };
    plain.group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    expect(() => applySkin(plain, BUILT_IN_SKINS.gold)).not.toThrow();
    rig.dispose();
  });

  it('resolves built-ins, custom skins (custom wins), and unknown ids', () => {
    const s = defaultSpec(1) as GameSpec;
    expect(resolveSkinDef(s, 'crimson')?.name).toBe('Crimson Vanguard');
    expect(resolveSkinDef(s, 'nope')).toBeUndefined();
    expect(resolveSkinDef(s, undefined)).toBeUndefined();
    (s as unknown as { custom: unknown }).custom = {
      characters: { skins: { crimson: { name: 'Mine', palette: { shirt: '#000000' } } } },
    };
    expect(resolveSkinDef(s, 'crimson')?.name).toBe('Mine');
    expect(availableSkinIds(s)).toContain('crimson');
    expect(availableSkinIds(s)).toContain('stealth');
  });
});

describe('RigAdapter', () => {
  it('normalizes Mixamo bone names (colon, underscore, bare)', () => {
    expect(normalizeBoneName('mixamorig:Hips')).toBe('hips');
    expect(normalizeBoneName('mixamorig_Hips')).toBe('hips');
    expect(normalizeBoneName('mixamorigHips')).toBe('hips');
    expect(normalizeBoneName('mixamorig:LeftForeArm')).toBe('leftforearm');
    expect(normalizeBoneName('Hips')).toBe('hips');
  });

  /** mock Mixamo-style hierarchy: Hips → Spine → {Head, LeftArm/RightArm}, LeftUpLeg/RightUpLeg */
  const mockMixamo = () => {
    const root = new THREE.Group();
    const hips = new THREE.Object3D(); hips.name = 'mixamorig:Hips'; root.add(hips);
    const spine = new THREE.Object3D(); spine.name = 'mixamorig:Spine'; hips.add(spine);
    const head = new THREE.Object3D(); head.name = 'mixamorig:Head'; spine.add(head);
    const armL = new THREE.Object3D(); armL.name = 'mixamorig:LeftArm'; spine.add(armL);
    const armR = new THREE.Object3D(); armR.name = 'mixamorig:RightArm'; spine.add(armR);
    const elbowL = new THREE.Object3D(); elbowL.name = 'mixamorig:LeftForeArm'; armL.add(elbowL);
    const legL = new THREE.Object3D(); legL.name = 'mixamorig:LeftUpLeg'; hips.add(legL);
    const legR = new THREE.Object3D(); legR.name = 'mixamorig:RightUpLeg'; hips.add(legR);
    const kneeL = new THREE.Object3D(); kneeL.name = 'mixamorig:LeftLeg'; legL.add(kneeL);
    return { root, hips, head, armL, armR, elbowL, legL, legR, kneeL };
  };

  it('resolves the six pivots + sub-pivots from a Mixamo-named hierarchy', () => {
    const { root, hips, head, armL, armR, elbowL, legL, legR, kneeL } = mockMixamo();
    const p = resolvePivots(root);
    expect(p.torso).toBe(hips);
    expect(p.head).toBe(head);
    expect(p.armL).toBe(armL);
    expect(p.armR).toBe(armR);
    expect(p.legL).toBe(legL);
    expect(p.legR).toBe(legR);
    expect(p.elbowL).toBe(elbowL);
    expect(p.kneeL).toBe(kneeL);
  });

  it('a manual boneMap entry wins over the convention', () => {
    const { root, armL } = mockMixamo();
    const custom = new THREE.Object3D(); custom.name = 'Custom_L_Arm'; root.add(custom);
    const p = resolvePivots(root, { armL: 'Custom_L_Arm' });
    expect(p.armL).toBe(custom);
    expect(p.armL).not.toBe(armL);
  });

  it('makeRigFromGLTF normalizes feet to origin and height to ~1.8m', () => {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: 0x8899aa }));
    mesh.position.y = 3; // spans y 2..4
    g.add(mesh);
    const rig = makeRigFromGLTF({ scene: g });
    const box = new THREE.Box3().setFromObject(rig.group);
    expect(box.min.y).toBeCloseTo(0, 4);
    expect(box.max.y - box.min.y).toBeCloseTo(1.8, 4);
    // imported materials get the owned clone treatment
    let owned = 0;
    rig.group.traverse((o) => {
      const mm = o as THREE.Mesh;
      if (mm.isMesh && (mm.material as THREE.Material).userData.owned) owned++;
    });
    expect(owned).toBeGreaterThan(0);
    rig.dispose();
  });

  it('makeRigFromGLTF maps pivots and drives the procedural swing on them', () => {
    const { root, armL, armR, legL } = mockMixamo();
    const rig = makeRigFromGLTF({ scene: root });
    expect(rig.limbs.armL).toBe(armL);
    expect(rig.limbs.legL).toBe(legL);
    // weaponMount follows the procedural convention (armR, the character's right arm)
    expect(rig.limbs.weaponMount).toBe(armR);
    expect(rig.limbs.elbowL).toBeInstanceOf(THREE.Object3D);
    rig.animate(1.0, 6, {});
    expect(legL.rotation.x).not.toBe(0);
    expect(armL.rotation.x).not.toBe(0);
    expect(Number.isFinite(legL.rotation.x)).toBe(true);
    rig.swing();
    rig.animate(1.1, 6, {});
    rig.flash();
    rig.animate(1.2, 6, {});
    rig.setDead(true);
    rig.animate(1.3, 0, { dead: true });
    expect(() => rig.dispose()).not.toThrow();
  });

  it('missing pivots stay inert (six-pivot contract holds, no group tumble)', () => {
    const rig = makeRigFromGLTF({ scene: new THREE.Group() });
    for (const k of ['legL', 'legR', 'armL', 'armR', 'torso', 'head'] as const)
      expect(rig.limbs[k], k).toBeInstanceOf(THREE.Object3D);
    rig.animate(1.0, 6, {});
    expect(rig.group.rotation.x).toBe(0); // no mapped torso → no bob/dead motion on the group
    rig.dispose();
  });

  it('fitModelToHeight clamps absurd scales', () => {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshStandardMaterial());
    g.add(mesh);
    const s = fitModelToHeight(g);
    expect(s).toBeLessThanOrEqual(20);
    const box = new THREE.Box3().setFromObject(g);
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(1.8 * 1.001);
  });

  it('loadRigFromURL fails closed: bad URL → null, never throws', async () => {
    await expect(loadRigFromURL('not-a-url')).resolves.toBeNull();
    await expect(loadRigFromURL('ftp://example.com/x.glb')).resolves.toBeNull();
    await expect(loadRigFromURL('')).resolves.toBeNull();
  });
});
