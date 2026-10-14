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
  farShellSegmentsForWorldSize, farShellBias,
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

describe('far shell resolution tiers', () => {
  it('keeps 64x64 on stage-1 sizes (byte-identical shell)', () => {
    for (const size of [60, 220, 500, 1000, 2000]) {
      expect(farShellSegmentsForWorldSize(size), `seg@${size}`).toBe(64);
    }
  });
  it('steps up on multi-km maps (still exactly one draw call per tier)', () => {
    expect(farShellSegmentsForWorldSize(2001)).toBe(96);
    expect(farShellSegmentsForWorldSize(4000)).toBe(96);
    expect(farShellSegmentsForWorldSize(4001)).toBe(128);
    expect(farShellSegmentsForWorldSize(8000)).toBe(128);
    expect(farShellSegmentsForWorldSize(16000)).toBe(128);
  });
  it('keeps the absolute cell <= ~64m on multi-km maps', () => {
    for (const size of [3000, 8000]) {
      expect(size / farShellSegmentsForWorldSize(size)).toBeLessThanOrEqual(64);
    }
  });
  it('is total on bad input', () => {
    for (const size of [NaN, Infinity, -10, 0]) {
      expect(farShellSegmentsForWorldSize(size)).toBe(64);
    }
  });
});

describe('far shell bias', () => {
  it('covers the measured max shell-vs-detail error per terrain type', () => {
    // measured (seed 20261012, 64-seg shell; scale-invariant at 2/4/8km):
    // hills 1.81m, mountains 5.29m, canyon 19.81m
    expect(-farShellBias('hills', 14)).toBeGreaterThan(1.81 * 1.35);
    expect(-farShellBias('mountains', 30)).toBeGreaterThan(5.29 * 1.35);
    expect(-farShellBias('canyon', 14)).toBeGreaterThan(19.81 * 1.35);
    expect(-farShellBias('flat', 14)).toBeGreaterThan(1.76 * 1.35);
  });
  it('scales with maxHeight and heightScale the way the true error does', () => {
    const a = -farShellBias('hills', 14, 1);
    const b = -farShellBias('hills', 28, 1);
    expect(b).toBeGreaterThan(a); // error grows with relief amplitude
    expect(-farShellBias('hills', 14, 2)).toBeCloseTo(b, 10);
  });
  it('stays near the stage-1 value for hills at 2km (4cm — invisible)', () => {
    expect(farShellBias('hills', 14)).toBeCloseTo(-3.46, 2);
  });
  it('is total on bad input', () => {
    expect(Number.isFinite(farShellBias('hills', NaN))).toBe(true);
    expect(Number.isFinite(farShellBias('canyon', -5))).toBe(true);
  });
});

describe('fog at multi-km sight lines', () => {
  // FogExp2 transmittance = exp(-(rho*d)^2); the linear density scale keeps
  // the far plane comparably fogged at every size (no white-out, no pop).
  const transmittance = (size: number, d: number) => {
    const rho = 0.0035 * fogDensityScaleForWorldSize(size);
    return Math.exp(-((rho * d) ** 2));
  };
  it('keeps gameplay distances clear at 8km (5km sight line)', () => {
    expect(transmittance(8000, 5000)).toBeGreaterThan(0.7);
  });
  it('fades the horizon without a wall at 8km (10km sight line)', () => {
    const t = transmittance(8000, 10000);
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(0.6);
  });
  it('fogs the far plane comparably at every big size (no pop at the clip)', () => {
    for (const size of [2000, 4000, 8000]) {
      const t = transmittance(size, cameraFarForWorldSize(size));
      expect(t, `far-plane transmittance@${size}`).toBeGreaterThan(0.2);
      expect(t, `far-plane transmittance@${size}`).toBeLessThan(0.5);
    }
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
    expect(shell.segments).toBe(64);
    const geo = shell.mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe((FAR_TERRAIN_SEGMENTS + 1) ** 2);
    expect(geo.getIndex()!.count).toBe(FAR_TERRAIN_SEGMENTS * FAR_TERRAIN_SEGMENTS * 6);
    expect(geo.getAttribute('color')).toBeTruthy();
    expect(geo.getAttribute('uv')).toBeTruthy();

    // sits below the detail terrain everywhere (no z-fight by construction):
    // type-aware bias, ~stage-1 value for hills at 2km
    expect(shell.bias).toBeCloseTo(farShellBias('hills', 14), 12);
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
