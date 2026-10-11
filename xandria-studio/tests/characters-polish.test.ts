/**
 * Polish wave — ANIMATION crew (procedural character life).
 * - idle breathing: subtle torso oscillation at speed 0, gone at speed
 * - run-cycle weight: forward lean + bob scaled by speed
 * - attack: windup (anticipation) → strike → follow-through
 * - landing squash: brief y-compression hooked to `land` opts
 * - death feel: momentum-carrying tumble (ragdoll-lite), sim untouched
 * - cloth: segmented cape flutters with speed + noise
 * CharacterRig interface stays backward compatible throughout.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid } from '../src/engine/gfx/Characters';
import { forgeHumanoidPlan } from '../src/engine/gfx/ModelForge';

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

/** first seed (1..200) whose plan includes a cape */
const capeSeed = (() => {
  for (let s = 1; s <= 200; s++) if (forgeHumanoidPlan(s).extras.includes('cape')) return s;
  return -1;
})();

describe('idle breathing + run-cycle weight', () => {
  it('breathes at rest: torso oscillates subtly, and it fades with speed', () => {
    const r = rig(61);
    const y0 = r.limbs.torso.position.y;
    r.animate(1.0, 0);
    const y1 = r.limbs.torso.position.y;
    r.animate(2.0, 0);
    const y2 = r.limbs.torso.position.y;
    expect(y1).not.toBe(y0); // breathing moves the torso
    expect(y2).not.toBe(y1);
    expect(Math.abs(y1 - y0)).toBeLessThan(0.02); // subtle
    // at full run speed the breath is gone (weight takes over)
    r.animate(3.0, 6);
    const yRun = r.limbs.torso.position.y;
    expect(Math.abs(yRun - y0 - Math.abs(Math.sin(3.0 * 12)) * 0.05)).toBeLessThan(0.02);
    r.dispose();
  });

  it('leans forward with speed and stays upright at rest', () => {
    const r = rig(62);
    r.animate(1.0, 0);
    expect(r.group.rotation.x).toBeCloseTo(0, 6);
    r.animate(1.0, 6);
    expect(r.group.rotation.x).toBeGreaterThan(0.05); // forward lean
    r.animate(1.0, 3);
    const half = r.group.rotation.x;
    r.animate(1.0, 6);
    expect(r.group.rotation.x).toBeGreaterThan(half); // scaled by speed
    r.dispose();
  });
});

describe('attack anticipation + follow-through', () => {
  it('winds up before the slash: the arm coils back past its start', () => {
    const r = rig(63);
    r.animate(1.0, 0);
    const rest = r.limbs.armR.rotation.x;
    r.swing();
    r.animate(1.016, 0); // atkP = 0 — still idle
    r.animate(1.032, 0); // atkP = 0.045 — windup
    r.animate(1.048, 0); // atkP = 0.09 — deeper windup
    expect(r.limbs.armR.rotation.x).toBeLessThan(-2.4); // raised past the old linear start
    expect(r.limbs.armR.rotation.x).toBeLessThan(rest);
    r.dispose();
  });

  it('follows through past horizontal and settles back to rest', () => {
    const r = rig(64);
    r.animate(1.0, 0, { attacking: 0.9 }); // deep in follow-through
    expect(r.limbs.armR.rotation.x).toBeGreaterThan(0);
    expect(r.limbs.armR.rotation.x).toBeLessThan(0.7);
    r.animate(2.0, 0); // no attack → back to locomotion pose
    expect(r.limbs.armR.rotation.x).toBeCloseTo(0, 6);
    expect(r.limbs.torso.rotation.y).toBeCloseTo(0, 6);
    r.dispose();
  });
});

describe('landing squash', () => {
  it('compresses y and bulges xz briefly, then restores the base scale', () => {
    const r = rig(65);
    r.animate(1.0, 0);
    const bx = r.group.scale.x, by = r.group.scale.y, bz = r.group.scale.z;
    r.animate(1.05, 0, { land: 0.5 }); // peak of the squash
    expect(r.group.scale.y).toBeLessThan(by);
    expect(r.group.scale.x).toBeGreaterThan(bx);
    expect(r.group.scale.z).toBeGreaterThan(bz);
    expect(by - r.group.scale.y).toBeLessThan(0.25); // brief, not a pancake
    r.animate(1.2, 0); // land expired → exact restore
    expect(r.group.scale.x).toBeCloseTo(bx, 6);
    expect(r.group.scale.y).toBeCloseTo(by, 6);
    expect(r.group.scale.z).toBeCloseTo(bz, 6);
    r.dispose();
  });
});

describe('death feel: momentum tumble', () => {
  it('converts death velocity into a slide + angular tumble that settles above ground', () => {
    const r = rig(66);
    r.group.position.set(0, 1.2, 0);
    r.setDead(true);
    const vel = new THREE.Vector3(4, 0, 1);
    let t = 10;
    const px = r.group.position.x;
    for (let i = 0; i < 90; i++) {
      t += 1 / 60;
      r.group.updateMatrixWorld(true);
      r.animate(t, 0, { dead: true, deadVelocity: vel });
      const p = new THREE.Vector3();
      r.group.getWorldPosition(p);
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(0.2); // never sinks through the floor
    }
    // it slid forward and tumbled (no longer the flat flop pose)
    expect(r.group.position.x).toBeGreaterThan(px);
    expect(Math.abs(r.group.rotation.x) + Math.abs(r.group.rotation.z)).toBeGreaterThan(0.2);
    r.dispose();
  });

  it('a standing-still death still tips over, and revive clears the tumble', () => {
    const r = rig(67);
    r.setDead(true);
    let t = 20;
    for (let i = 0; i < 40; i++) { t += 1 / 60; r.animate(t, 0, { dead: true }); }
    expect(Math.abs(r.group.rotation.x)).toBeGreaterThan(0.3);
    // revive: back to locomotion, lean restored
    r.setDead(false);
    r.animate(t + 1, 6);
    expect(r.group.rotation.x).toBeGreaterThan(0.05); // running lean, not corpse pose
    r.dispose();
  });
});

describe('cloth: segmented cape', () => {
  it('exposes chained cape pivots that flutter with speed', () => {
    expect(capeSeed).toBeGreaterThan(0);
    const r = rig(capeSeed);
    const cape = r.limbs.cape!;
    expect(cape).toBeDefined();
    expect(cape.length).toBe(3);
    // chained: each pivot is the child of the previous (root → torso)
    expect(cape[1].parent).toBe(cape[0]);
    expect(cape[2].parent).toBe(cape[1]);
    expect(cape[0].parent!.parent).toBe(r.limbs.torso);
    // stillness: segments near rest; speed: they trail + flutter
    r.animate(1.0, 0);
    const restAngles = cape.map((c) => c.rotation.x);
    r.animate(1.0, 6);
    const runAngles = cape.map((c) => c.rotation.x);
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(runAngles[i])).toBe(true);
      expect(runAngles[i]).toBeGreaterThan(restAngles[i]); // trails backward with speed
    }
    // noise: consecutive frames differ even at the same speed
    r.animate(1.5, 6);
    const later = cape.map((c) => c.rotation.x);
    expect(later.some((a, i) => Math.abs(a - runAngles[i]) > 1e-6)).toBe(true);
    r.dispose();
  });

  it('rigs without a cape expose no cape pivots (backward compatible)', () => {
    let noCape = -1;
    for (let s = 1; s <= 200 && noCape < 0; s++) {
      if (!forgeHumanoidPlan(s).extras.includes('cape')) noCape = s;
    }
    const r = rig(noCape);
    expect(r.limbs.cape).toBeUndefined();
    expect(() => r.animate(1.0, 6)).not.toThrow();
    r.dispose();
  });
});
