/**
 * Wave C — jointed procedural characters.
 * - rig exposes the six legacy pivots (positions unchanged)
 * - elbow/knee sub-pivots exist as children of the correct limb pivots
 * - animate() drives sub-pivots phase-coupled to parents (no bones/clips)
 * - archetypes produce distinct, deterministic proportions
 * - an enemy-configured rig builds and animates cleanly (unit-level)
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import { forgeHumanoidPlan, type BodyArchetype } from '../src/engine/gfx/ModelForge';

/* minimal DOM stub (MaterialLibrary builds canvas textures lazily) */
(globalThis as any).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData() {},
    }),
  }),
};

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
const rig = (seed = 11, colors: any = {}) => makeHumanoid(mats(), colors, seed);

describe('CharacterRig legacy contract', () => {
  it('exposes the six legacy pivots at their historical positions', () => {
    const seed = 21;
    const r = rig(seed);
    const plan = forgeHumanoidPlan(seed, {});
    const b = plan.bulk;
    const legL0 = 0.74 * plan.legLen;
    const torsoY = legL0 + 0.38;
    for (const k of ['legL', 'legR', 'armL', 'armR', 'torso', 'head'] as const) {
      expect(r.limbs[k], k).toBeInstanceOf(THREE.Object3D);
    }
    expect(r.limbs.weaponMount).toBe(r.limbs.armR);
    expect(r.limbs.armL.position.x).toBeCloseTo(0.42 * b, 6);
    expect(r.limbs.armR.position.x).toBeCloseTo(-0.42 * b, 6);
    expect(r.limbs.armL.position.y).toBeCloseTo(torsoY + 0.3, 6);
    expect(r.limbs.legL.position.x).toBeCloseTo(0.17 * b, 6);
    expect(r.limbs.legR.position.x).toBeCloseTo(-0.17 * b, 6);
    expect(r.limbs.legL.position.y).toBeCloseTo(legL0, 6);
    r.dispose();
  });

  it('exposes elbow/knee sub-pivots parented to the correct limb pivots', () => {
    const r = rig(33);
    const { limbs } = r;
    expect(limbs.elbowL).toBeInstanceOf(THREE.Object3D);
    expect(limbs.elbowR).toBeInstanceOf(THREE.Object3D);
    expect(limbs.kneeL).toBeInstanceOf(THREE.Object3D);
    expect(limbs.kneeR).toBeInstanceOf(THREE.Object3D);
    expect(limbs.elbowL!.parent).toBe(limbs.armL);
    expect(limbs.elbowR!.parent).toBe(limbs.armR);
    expect(limbs.kneeL!.parent).toBe(limbs.legL);
    expect(limbs.kneeR!.parent).toBe(limbs.legR);
    // joints map mirrors the direct references
    expect(limbs.joints!.elbowL).toBe(limbs.elbowL);
    expect(limbs.joints!.elbowR).toBe(limbs.elbowR);
    expect(limbs.joints!.kneeL).toBe(limbs.kneeL);
    expect(limbs.joints!.kneeR).toBe(limbs.kneeR);
    r.dispose();
  });
});

describe('sub-pivot articulation', () => {
  it('knees bend one way as the leg swings forward, phase-offset from the hip', () => {
    const r = rig(44);
    // stride phase f = 3π/2 → legL at full forward swing
    r.animate((3 * Math.PI) / 2 / 12, 6);
    expect(r.limbs.legL.rotation.x).toBeCloseTo(-0.7, 4); // forward extreme
    expect(r.limbs.kneeL!.rotation.x).toBeCloseTo(0.93, 3); // knee near max bend
    // stride phase f = π/2 → legL at full back swing
    r.animate(Math.PI / 2 / 12, 6);
    expect(r.limbs.legL.rotation.x).toBeCloseTo(0.7, 4); // back extreme
    expect(r.limbs.kneeL!.rotation.x).toBeCloseTo(0.08, 3); // knee near straight
    r.dispose();
  });

  it('elbows counter-swing: bend grows as the arm swings back', () => {
    const r = rig(44);
    // f = 3π/2 → armL swings back (opposite phase to legL)
    r.animate((3 * Math.PI) / 2 / 12, 6);
    expect(r.limbs.armL.rotation.x).toBeCloseTo(0.595, 3);
    expect(r.limbs.elbowL!.rotation.x).toBeCloseTo(-0.62, 3); // deep bend
    // f = π/2 → armL forward, elbow relaxes toward rest
    r.animate(Math.PI / 2 / 12, 6);
    expect(r.limbs.armL.rotation.x).toBeCloseTo(-0.595, 3);
    expect(r.limbs.elbowL!.rotation.x).toBeCloseTo(-0.12, 3);
    r.dispose();
  });

  it('sub-pivots stay quiet at rest and follow the swing through the attack', () => {
    const r = rig(55);
    r.animate(1.0, 0);
    expect(r.limbs.kneeL!.rotation.x).toBeCloseTo(0, 6);
    expect(r.limbs.elbowL!.rotation.x).toBeCloseTo(-0.12, 6); // natural rest bend
    r.swing();
    for (let i = 0; i < 12; i++) r.animate(i * 0.016, 0);
    expect(r.limbs.armR.rotation.x).toBeLessThan(0); // mid overhead slash
    expect(r.limbs.elbowR!.rotation.x).toBeLessThan(-0.5); // elbow bent through the swing
    r.dispose();
  });
});

describe('body archetypes', () => {
  const seedsByArch = (): Record<BodyArchetype, number[]> => {
    const out: Record<BodyArchetype, number[]> = { standard: [], brute: [], scout: [] };
    for (let s = 1; s <= 300; s++) out[forgeHumanoidPlan(s).archetype].push(s);
    return out;
  };

  it('archetype is deterministic per seed and all three appear', () => {
    expect(forgeHumanoidPlan(42).archetype).toBe(forgeHumanoidPlan(42).archetype);
    const by = seedsByArch();
    expect(by.standard.length).toBeGreaterThan(0);
    expect(by.brute.length).toBeGreaterThan(0);
    expect(by.scout.length).toBeGreaterThan(0);
  });

  it('archetypes produce distinct proportions (brute > standard > scout bulk)', () => {
    const by = seedsByArch();
    const mean = (ss: number[]) => ss.reduce((a, s) => a + forgeHumanoidPlan(s).bulk, 0) / ss.length;
    expect(mean(by.brute)).toBeGreaterThan(mean(by.standard));
    expect(mean(by.standard)).toBeGreaterThan(mean(by.scout));
  });

  it('rig geometry reflects the archetype (brute torso wider than scout)', () => {
    const by = seedsByArch();
    // faceted() de-indexes geometry, so measure the torso cylinder's own
    // bounding box rather than constructor parameters
    const torsoWidth = (seed: number) => {
      const r = rig(seed);
      const g = (r.limbs.torso as THREE.Mesh).geometry;
      g.computeBoundingBox();
      const w = g.boundingBox!.max.x - g.boundingBox!.min.x;
      r.dispose();
      return w;
    };
    const mean = (ss: number[]) => ss.slice(0, 8).reduce((a, s) => a + torsoWidth(s), 0) / 8;
    expect(mean(by.brute)).toBeGreaterThan(mean(by.scout) * 1.1);
  });
});

describe('enemy rig (brute config, unit-level)', () => {
  it('builds, animates, and has finite world transforms', () => {
    const r = rig(99, { skin: '#8f8a80', bulk: 1.7, shirt: '#5e2e2e' });
    r.animate(0.5, 3);
    r.animate(1.5, 3, { attacking: 0.4 });
    r.flash();
    r.animate(1.6, 3);
    r.group.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let meshes = 0;
    r.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++;
        o.getWorldPosition(v);
        expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
      }
    });
    expect(meshes).toBeGreaterThan(15); // articulated body + gear
    // feet stay near the ground plane (origin at feet)
    const boot = r.limbs.kneeL!;
    boot.updateWorldMatrix(true, false);
    expect(Math.abs(boot.getWorldPosition(v).y)).toBeLessThan(1.2);
    expect(() => r.dispose()).not.toThrow();
  });
});
