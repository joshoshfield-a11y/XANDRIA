/**
 * Graphics wave 2, workstream D (water): shoreline foam + depth grading +
 * rain ripple.
 *
 * - bakeWaterHeightTexture: determinism (same seed -> identical bytes),
 *   texel-center accuracy vs terrainHeightAt (the chunk meshes are built
 *   from the same function, so foam hugs the real shoreline), pack/unpack
 *   round-trip.
 * - Water material: new uniforms present and wired, uRain follows weather,
 *   polygonOffset on (the z-fight seam fix), program cache key bumped.
 * - setWaterWeather: runtime toggle, never throws.
 *
 * DOM is stubbed (no jsdom here) — same pattern as env-art.test.ts.
 * The shader GLSL itself is exercised in the Playwright water-shore spec
 * (tests/e2e/water-shore.spec.ts) with before/after screenshots.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Terrain, bakeWaterHeightTexture, packHeight16, unpackHeight16, waterHeightTexSize } from '../src/engine/world/Terrain';
import { generateSpec } from '../src/generator/generate';
import type { GameSpec } from '../src/spec/schema';

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

function waterSpec(seed: number, weather: GameSpec['theme']['weather']): GameSpec {
  const spec = generateSpec('top-down twin stick shooter on a misty lake', {
    seed, genre: 'top-down-shooter', environment: 'forest',
  });
  spec.world.terrain.water = true;
  spec.world.terrain.waterLevel = 0;
  spec.theme.weather = weather;
  return spec;
}

function buildTerrain(spec: GameSpec) {
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  return new Terrain(spec, physics, mats, scene);
}

describe('packHeight16 / unpackHeight16', () => {
  it('round-trips 0..1 within one 16-bit step', () => {
    for (const h of [0, 0.001, 0.123456, 0.5, 0.99999, 1]) {
      const [r, g] = packHeight16(h);
      expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0); expect(g).toBeLessThanOrEqual(255);
      expect(Math.abs(unpackHeight16(r, g) - h)).toBeLessThanOrEqual(1 / 65535 + 1e-12);
    }
  });
  it('clamps out-of-range input', () => {
    expect(packHeight16(-0.5)).toEqual([0, 0]);
    expect(packHeight16(1.5)).toEqual([255, 255]);
  });
});

describe('waterHeightTexSize', () => {
  it('768 for stage-1 sizes, 1024 above 2000m', () => {
    expect(waterHeightTexSize(220)).toBe(768);
    expect(waterHeightTexSize(2000)).toBe(768);
    expect(waterHeightTexSize(8000)).toBe(1024);
  });
});

describe('bakeWaterHeightTexture', () => {
  // The constructor bakes once per Terrain (waterHeightTex); reuse it so the
  // tests don't pay the one-time bake cost twice.
  function bakedOf(t: Terrain) {
    const tex = (t as any).waterHeightTex as THREE.DataTexture;
    const ud = (t as any).waterMat.userData;
    return { tex, minH: ud.uHeightMin.value as number, maxH: ud.uHeightMax.value as number };
  }
  it('is deterministic for the same height params', () => {
    const mk = () => buildTerrain(waterSpec(4242, 'clear'));
    const b1 = bakedOf(mk());
    const b2 = bakedOf(mk());
    expect(b1.minH).toBe(b2.minH);
    expect(b1.maxH).toBe(b2.maxH);
    expect(b1.tex.image.data).toEqual(b2.tex.image.data);
  });
  it('differs across seeds', () => {
    const b1 = bakedOf(buildTerrain(waterSpec(4242, 'clear')));
    const b2 = bakedOf(buildTerrain(waterSpec(9999, 'clear')));
    expect(b1.tex.image.data).not.toEqual(b2.tex.image.data);
  });
  it('texel centers reproduce terrainHeightAt within 16-bit quantization', () => {
    const terrain = buildTerrain(waterSpec(4242, 'clear'));
    const { tex, minH, maxH } = bakedOf(terrain);
    const N = waterHeightTexSize(220);
    const data: Uint8Array = tex.image.data as Uint8Array;
    const tol = (maxH - minH) / 65535 * 2 + 1e-4;
    for (const [i, j] of [[0, 0], [N - 1, N - 1], [100, 200], [511, 511], [700, 33]] as const) {
      const x = (i / (N - 1)) * 220 - 110;
      const z = (j / (N - 1)) * 220 - 110;
      const o = (j * N + i) * 4;
      const h = minH + unpackHeight16(data[o], data[o + 1]) * (maxH - minH);
      expect(Math.abs(h - terrain.heightAt(x, z))).toBeLessThanOrEqual(tol);
    }
  });
  it('the exported bake matches what the constructor wired', () => {
    const terrain = buildTerrain(waterSpec(4242, 'clear'));
    const direct = bakeWaterHeightTexture((terrain as any).hp, 220);
    const { tex } = bakedOf(terrain);
    expect(tex.image.data).toEqual(direct.texture.image.data);
  });
});

describe('water material (D env2)', () => {
  it('wires foam/depth/rain uniforms on a rain map', () => {
    const terrain = buildTerrain(waterSpec(4242, 'rain'));
    expect(terrain.water).toBeDefined();
    const wm = (terrain as any).waterMat as THREE.MeshStandardMaterial;
    const ud = wm.userData;
    expect(ud.uHeightTex.value).toBeInstanceOf(THREE.DataTexture);
    expect(ud.uHeightTex.value.image.width).toBe(768);
    expect(ud.uHeightMin.value).toBeLessThan(ud.uHeightMax.value);
    expect(ud.uHeightSpan.value).toBe(220);
    expect(ud.uWaterY.value).toBeCloseTo(terrain.water!.position.y, 6);
    expect(ud.uShallowColor.value).toBeInstanceOf(THREE.Color);
    expect(ud.uFoamColor.value).toBeInstanceOf(THREE.Color);
    expect(ud.uFoamWidth.value).toBe(2.2);
    expect(ud.uRain.value).toBe(1);
    // legacy uniforms untouched
    expect(ud.uTime.value).toBe(0);
    expect(ud.uFadeStart.value).toBeDefined();
    // z-fight seam fix + program key bump
    expect(wm.polygonOffset).toBe(true);
    expect(wm.customProgramCacheKey!()).toBe('xandria-water-v5');
  });
  it('uRain is 0 for clear weather, 1 for storm', () => {
    const clear = (buildTerrain(waterSpec(1, 'clear')) as any).waterMat.userData;
    const storm = (buildTerrain(waterSpec(1, 'storm')) as any).waterMat.userData;
    const snow = (buildTerrain(waterSpec(1, 'snow')) as any).waterMat.userData;
    expect(clear.uRain.value).toBe(0);
    expect(storm.uRain.value).toBe(1);
    expect(snow.uRain.value).toBe(0);
  });
  it('setWaterWeather toggles uRain and never throws', () => {
    const terrain = buildTerrain(waterSpec(7, 'clear'));
    const ud = (terrain as any).waterMat.userData;
    expect(ud.uRain.value).toBe(0);
    terrain.setWaterWeather('rain');
    expect(ud.uRain.value).toBe(1);
    terrain.setWaterWeather('storm');
    expect(ud.uRain.value).toBe(1);
    terrain.setWaterWeather('clear');
    expect(ud.uRain.value).toBe(0);
    expect(() => terrain.setWaterWeather(null)).not.toThrow();
    expect(() => terrain.setWaterWeather(undefined)).not.toThrow();
    expect(() => terrain.setWaterWeather('hurricane' as any)).not.toThrow();
  });
  it('no water mesh when the spec has no water', () => {
    const spec = generateSpec('top-down twin stick shooter in a neon city', {
      seed: 5, genre: 'top-down-shooter', environment: 'neon-city',
    });
    spec.world.terrain.water = false;
    const terrain = buildTerrain(spec);
    expect(terrain.water).toBeUndefined();
  });
});
