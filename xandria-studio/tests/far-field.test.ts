/**
 * Workstream D — far-field / fog / camera scaling (Open World stage 1).
 *
 * - FarField.ts pure scaling math: camera far/near planes and fog density
 *   scale as pure functions of world size. Small worlds keep the legacy
 *   values exactly (byte-identical rendering); big worlds get a far plane
 *   past the horizon and thinner fog.
 * - FarTerrain: the low-res far shell builds one draw call under the detail
 *   terrain, sits below it everywhere (bias), carries no shadows, and is
 *   never frustum-culled.
 *
 * DOM is stubbed (no jsdom here) — same pattern as biomes.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  LEGACY_CAMERA_FAR, LEGACY_CAMERA_NEAR, FOG_REFERENCE_SIZE, FAR_TERRAIN_MIN_SIZE,
  cameraFarForWorldSize, cameraNearForWorldSize, fogDensityScaleForWorldSize,
} from '../src/engine/gfx/FarField';
import { FAR_TERRAIN_SEGMENTS, FarTerrain } from '../src/engine/world/FarTerrain';
import { resolveBiomeDef } from '../src/engine/world/Biomes';
import { generateSpec } from '../src/generator/generate';
import { Terrain } from '../src/engine/world/Terrain';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Physics } from '../src/engine/core/Physics';
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

function bigSpec(size: number): GameSpec {
  const spec = generateSpec('a heroic knight adventure through hills at dusk', { seed: 20261012 });
  spec.world.terrain.size = size;
  spec.world.terrain.type = 'hills';
  return spec;
}

describe('camera far/near scaling', () => {
  it('keeps the legacy planes for small worlds (byte-identical rendering)', () => {
    for (const size of [60, 220, 500, 750]) {
      expect(cameraFarForWorldSize(size), `far@${size}`).toBe(LEGACY_CAMERA_FAR);
      expect(cameraNearForWorldSize(size), `near@${size}`).toBe(LEGACY_CAMERA_NEAR);
    }
  });
  it('scales far past the horizon on big maps', () => {
    // 2000m: 2000*1.2+500 = 2900 > corner-to-corner diagonal 2828
    expect(cameraFarForWorldSize(2000)).toBe(2900);
    expect(cameraFarForWorldSize(1000)).toBe(1700);
    expect(cameraFarForWorldSize(2000)).toBeGreaterThan(2000 * Math.SQRT2);
  });
  it('keeps the near:far ratio identical to the baseline at every size', () => {
    for (const size of [220, 800, 1500, 2000]) {
      const ratio = cameraNearForWorldSize(size) / cameraFarForWorldSize(size);
      expect(ratio).toBeCloseTo(LEGACY_CAMERA_NEAR / LEGACY_CAMERA_FAR, 12);
    }
  });
  it('is total on bad input', () => {
    for (const size of [NaN, Infinity, -10, 0]) {
      expect(cameraFarForWorldSize(size)).toBe(LEGACY_CAMERA_FAR);
      expect(cameraNearForWorldSize(size)).toBe(LEGACY_CAMERA_NEAR);
      expect(fogDensityScaleForWorldSize(size)).toBe(1);
    }
  });
});

describe('fog density scaling', () => {
  it('is 1 at/below the reference size (authored fog untouched)', () => {
    expect(fogDensityScaleForWorldSize(FOG_REFERENCE_SIZE)).toBe(1);
    expect(fogDensityScaleForWorldSize(60)).toBe(1);
  });
  it('thins linearly with size above the reference', () => {
    expect(fogDensityScaleForWorldSize(440)).toBeCloseTo(0.5, 12);
    expect(fogDensityScaleForWorldSize(2000)).toBeCloseTo(220 / 2000, 12);
  });
});

describe('FarTerrain shell', () => {
  it('builds one 64x64 mesh under the detail terrain', () => {
    const spec = bigSpec(2000);
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const shell = new FarTerrain(spec, terrain, mats, scene);

    expect(scene.children).toContain(shell.mesh);
    const geo = shell.mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe((FAR_TERRAIN_SEGMENTS + 1) ** 2);
    expect(geo.getIndex()!.count).toBe(FAR_TERRAIN_SEGMENTS * FAR_TERRAIN_SEGMENTS * 6);
    expect(geo.getAttribute('color')).toBeTruthy();
    expect(geo.getAttribute('uv')).toBeTruthy();

    // sits below the detail terrain everywhere (no z-fight by construction)
    expect(shell.bias).toBeCloseTo(-3.5, 12);
    for (const [fx, fz] of [[0.13, 0.29], [0.5, 0.5], [0.87, 0.61], [0.02, 0.98]] as const) {
      const i = Math.round(fx * FAR_TERRAIN_SEGMENTS);
      const j = Math.round(fz * FAR_TERRAIN_SEGMENTS);
      const vi = j * (FAR_TERRAIN_SEGMENTS + 1) + i;
      const x = pos.getX(vi), z = pos.getZ(vi);
      expect(x).toBeCloseTo(-1000 + (i / FAR_TERRAIN_SEGMENTS) * 2000, 6);
      expect(z).toBeCloseTo(-1000 + (j / FAR_TERRAIN_SEGMENTS) * 2000, 6);
      expect(pos.getY(vi)).toBeCloseTo(terrain.heightAt(x, z) + shell.bias, 6);
    }

    // one draw call, no shadows, never culled
    expect(shell.mesh.frustumCulled).toBe(false);
    expect(shell.mesh.castShadow).toBe(false);
    expect(shell.mesh.receiveShadow).toBe(false);
    // shares the cached detail-terrain material (same lighting/texture)
    const biome = resolveBiomeDef(spec);
    expect(shell.mesh.material).toBe(mats.biomeGroundDef(biome.ground, { repeat: 2000 / 8 }));

    // sane normals (no NaN, pointing up)
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let v = 0; v < nrm.count; v += 97) {
      expect(Number.isFinite(nrm.getX(v) + nrm.getY(v) + nrm.getZ(v))).toBe(true);
      expect(nrm.getY(v)).toBeGreaterThan(0);
    }

    const drawCallsBefore = scene.children.length;
    shell.dispose();
    expect(scene.children.length).toBe(drawCallsBefore - 1);
    expect(scene.children).not.toContain(shell.mesh);
  });

  it('is gated to big worlds (constant exported for the Engine)', () => {
    expect(FAR_TERRAIN_MIN_SIZE).toBe(500);
  });
});
