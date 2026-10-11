/**
 * Polish wave (LOOK crew): color grade + lighting life.
 *
 * - GenreGrade.grade: per-genre filmic params present; night grade is identity
 *   (the night visibility floor must not regress — grade adds no brightness
 *   change at night, only a mild vignette).
 * - GradeShader: uniforms + GLSL wiring; setGradeUniforms pushes genre values.
 * - LightLife: deterministic flicker/pulse (no Math.random), 3-slot flash
 *   pool with decay, retro quality disables everything (retro keeps its look).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { gradeAtmosphere, type Genre, type ColorGrade } from '../src/engine/gfx/GenreGrade';
import { GradeShader, setGradeUniforms } from '../src/engine/gfx/GradeShader';
import { LightLife } from '../src/engine/gfx/LightLife';

const GENRES: Genre[] = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter'];

function isIdentityGrade(g: ColorGrade): boolean {
  return (
    g.lift.every((v) => v === 0) &&
    g.gamma.every((v) => v === 1) &&
    g.gain.every((v) => v === 1) &&
    g.saturation === 1
  );
}

describe('GenreGrade.grade (color grade params)', () => {
  it('every genre has sane day/dusk grade params', () => {
    for (const genre of GENRES) {
      for (const tod of ['day', 'dusk'] as const) {
        const g = gradeAtmosphere(genre, tod).grade;
        expect(g.lift).toHaveLength(3);
        expect(g.gamma).toHaveLength(3);
        expect(g.gain).toHaveLength(3);
        for (const v of g.lift) expect(Math.abs(v)).toBeLessThanOrEqual(0.05);
        for (const v of [...g.gamma, ...g.gain]) expect(Math.abs(v - 1)).toBeLessThanOrEqual(0.1);
        expect(g.saturation).toBeGreaterThan(0.9);
        expect(g.saturation).toBeLessThanOrEqual(1.25);
        expect(g.vignette).toBeGreaterThanOrEqual(0);
        expect(g.vignette).toBeLessThanOrEqual(0.7);
      }
    }
  });

  it('night grade is identity (no brightness change; night floor locked)', () => {
    for (const genre of GENRES) {
      const g = gradeAtmosphere(genre, 'night').grade;
      expect(isIdentityGrade(g)).toBe(true);
    }
  });

  it('genres actually differ from each other (per-genre grading, not a constant)', () => {
    const sig = (genre: Genre) => JSON.stringify(gradeAtmosphere(genre, 'day').grade);
    const sigs = new Set(GENRES.map(sig));
    expect(sigs.size).toBe(GENRES.length);
  });
});

describe('GradeShader', () => {
  it('exposes all grade uniforms', () => {
    for (const k of ['tDiffuse', 'lift', 'gamma', 'gain', 'saturation', 'vignette']) {
      expect(GradeShader.uniforms).toHaveProperty(k);
    }
    expect((GradeShader.uniforms.gamma.value as THREE.Vector3).toArray()).toEqual([1, 1, 1]);
  });

  it('fragment shader consumes every uniform', () => {
    const fs = GradeShader.fragmentShader;
    for (const k of ['tDiffuse', 'lift', 'gamma', 'gain', 'saturation', 'vignette']) {
      expect(fs).toContain(k);
    }
  });

  it('setGradeUniforms pushes genre values into a pass', () => {
    const uniforms: Record<string, { value: unknown }> = {
      lift: { value: new THREE.Vector3() },
      gamma: { value: new THREE.Vector3(1, 1, 1) },
      gain: { value: new THREE.Vector3(1, 1, 1) },
      saturation: { value: 1 },
      vignette: { value: 0 },
    };
    const g = gradeAtmosphere('racing', 'day').grade;
    setGradeUniforms({ uniforms }, g);
    expect((uniforms.lift.value as THREE.Vector3).toArray()).toEqual(g.lift);
    expect((uniforms.gamma.value as THREE.Vector3).toArray()).toEqual(g.gamma);
    expect((uniforms.gain.value as THREE.Vector3).toArray()).toEqual(g.gain);
    expect(uniforms.saturation.value).toBe(g.saturation);
    expect(uniforms.vignette.value).toBe(g.vignette);
  });
});

describe('LightLife', () => {
  it('builds a 3-slot invisible flash pool', () => {
    const scene = new THREE.Scene();
    const ll = new LightLife(scene, 'high');
    expect(ll.poolSize).toBe(3);
    const poolLights = scene.children.filter((c) => c instanceof THREE.PointLight);
    expect(poolLights).toHaveLength(3);
    for (const l of poolLights) {
      expect((l as THREE.PointLight).visible).toBe(false);
      expect((l as THREE.PointLight).intensity).toBe(0);
    }
  });

  it('flicker modulates intensity around the base, deterministically', () => {
    const mk = () => {
      const scene = new THREE.Scene();
      const ll = new LightLife(scene, 'high');
      const light = new THREE.PointLight('#ffffff', 2, 30);
      scene.add(light);
      ll.flicker(light, 0.3, 2.5);
      return { ll, light };
    };
    const a = mk(), b = mk();
    const seqA: number[] = [], seqB: number[] = [];
    for (let i = 0; i < 60; i++) {
      a.ll.update(1 / 60); b.ll.update(1 / 60);
      seqA.push(a.light.intensity); seqB.push(b.light.intensity);
    }
    // deterministic: identical sequences (no Math.random in the noise)
    expect(seqA).toEqual(seqB);
    // actually modulates: not constant, stays within ±amp of base
    expect(new Set(seqA.map((v) => v.toFixed(6))).size).toBeGreaterThan(10);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(2 * 0.7 - 1e-9);
      expect(v).toBeLessThanOrEqual(2 * 1.3 + 1e-9);
    }
  });

  it('pulse modulates emissiveIntensity around the registered base', () => {
    const scene = new THREE.Scene();
    const ll = new LightLife(scene, 'standard');
    const mat = new THREE.MeshStandardMaterial({ emissive: '#ff00ff', emissiveIntensity: 2.2 });
    ll.pulse(mat, 0.15, 2);
    const vals: number[] = [];
    for (let i = 0; i < 60; i++) { ll.update(1 / 60); vals.push(mat.emissiveIntensity); }
    expect(new Set(vals.map((v) => v.toFixed(6))).size).toBeGreaterThan(5);
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(2.2 * 0.85 - 1e-9);
      expect(v).toBeLessThanOrEqual(2.2 * 1.15 + 1e-9);
    }
  });

  it('flash fires a pooled light that decays back to invisible', () => {
    const scene = new THREE.Scene();
    const ll = new LightLife(scene, 'high');
    const pos = new THREE.Vector3(1, 2, 3);
    ll.flash('#ff8800', pos, 10, 16, 0.2);
    const lit = scene.children.filter(
      (c) => c instanceof THREE.PointLight && (c as THREE.PointLight).visible,
    ) as THREE.PointLight[];
    expect(lit).toHaveLength(1);
    expect(lit[0].intensity).toBe(10);
    expect(lit[0].position.toArray()).toEqual([1, 2, 3]);
    // decay over the duration, then hidden
    ll.update(0.1);
    expect(lit[0].visible).toBe(true);
    expect(lit[0].intensity).toBeLessThan(10);
    ll.update(0.2);
    expect(lit[0].visible).toBe(false);
    expect(lit[0].intensity).toBe(0);
  });

  it('flash round-robins across the 3 slots', () => {
    const scene = new THREE.Scene();
    const ll = new LightLife(scene, 'high');
    const p = new THREE.Vector3();
    for (let i = 0; i < 4; i++) ll.flash('#ffffff', p, 5, 16, 1.0);
    const lit = scene.children.filter(
      (c) => c instanceof THREE.PointLight && (c as THREE.PointLight).visible,
    );
    // 4 flashes into 3 slots: the 4th reuses slot 0, still only 3 visible
    expect(lit).toHaveLength(3);
  });

  it('retro quality disables everything (retro keeps its own look)', () => {
    const scene = new THREE.Scene();
    const ll = new LightLife(scene, 'retro');
    const light = new THREE.PointLight('#ffffff', 2, 30);
    const mat = new THREE.MeshStandardMaterial({ emissive: '#ff00ff', emissiveIntensity: 2.2 });
    ll.flicker(light, 0.3, 2.5);
    ll.pulse(mat, 0.15, 2);
    ll.flash('#ffffff', new THREE.Vector3(), 10, 16, 0.2);
    ll.update(1);
    expect(light.intensity).toBe(2);
    expect(mat.emissiveIntensity).toBe(2.2);
    const lit = scene.children.filter(
      (c) => c instanceof THREE.PointLight && (c as THREE.PointLight).visible,
    );
    expect(lit).toHaveLength(0);
  });
});
