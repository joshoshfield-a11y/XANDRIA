/**
 * Portals wave, workstream A — energy-field boundary visual.
 *
 * - portal-enabled maps: field meshes present (exactly 1 mesh / 1 draw
 *   call), ZERO wall physics bodies, edge falloff neutralized;
 * - legacy maps: walls present (4 bodies), NO field mesh, behavior
 *   byte-identical;
 * - arena genres keep walls;
 * - portalsEnabled() contract + shader clock unit behavior;
 * - field geometry deterministic across builds at the 8km ceiling size.
 *
 * DOM is stubbed (no jsdom here) — same pattern as chunked-terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  portalsEnabled, buildEnergyField, energyFieldMaterial, updateEnergyField,
  energyFieldTime, disposeEnergyField, ENERGY_FIELD_HEIGHT,
} from '../src/engine/gfx/EnergyField';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import type { GameSpec } from '@spec';

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

function portalSpec(size = 4000, seed = 4242): GameSpec {
  const spec = generateSpec('an open world adventure', { seed });
  spec.world.terrain.type = 'flat';
  spec.world.terrain.size = size;
  spec.world.terrain.water = false;
  // canonical portal flag (workstream C schema)
  spec.world.portals = { enabled: true };
  return spec;
}

function legacySpec(seed = 4242): GameSpec {
  const spec = generateSpec('an open world adventure', { seed });
  spec.world.terrain.type = 'flat';
  spec.world.terrain.size = 4000;
  spec.world.terrain.water = false;
  // the generator enables portals for open-world games — opt out explicitly
  // so this spec exercises the legacy walls path
  spec.world.portals = { enabled: false };
  return spec;
}

function fieldMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).userData?.energyField) out.push(o as THREE.Mesh); });
  return out;
}

describe('portalsEnabled contract (workstream C owns the schema)', () => {
  it('is falsy when the field is absent/false/{enabled:false}', () => {
    const spec = legacySpec();
    delete (spec.world as { portals?: unknown }).portals;
    expect(portalsEnabled(spec)).toBe(false);
    spec.world.portals = { enabled: false };
    expect(portalsEnabled(spec)).toBe(false);
  });
  it('is truthy only for {enabled:true} — a bare boolean does not enable', () => {
    const spec = legacySpec();
    (spec.world as unknown as { portals: unknown }).portals = true;
    expect(portalsEnabled(spec)).toBe(false);
    spec.world.portals = { enabled: true };
    expect(portalsEnabled(spec)).toBe(true);
  });
});

describe('portal map boundary', () => {
  it('builds exactly one field mesh and zero wall bodies', () => {
    const spec = portalSpec();
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    expect(terrain.walls.length).toBe(0);
    expect(terrain.energyField).toBeDefined();
    const fields = fieldMeshes(scene);
    expect(fields.length).toBe(1); // 4 edges merged into ONE mesh = 1 draw call
    const g = fields[0].geometry;
    expect(g.getAttribute('position').count).toBe(16); // 4 quads x 4 verts
    expect(g.getIndex()!.count).toBe(24); // 8 tris
    // the field spans the full map edge
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(spec.world.terrain.size, 1);
    expect(bb.max.y - bb.min.y).toBeCloseTo(ENERGY_FIELD_HEIGHT, 3);
    // shared material, transparent, no depth write, no shadow flags
    const mat = fields[0].material as THREE.ShaderMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(fields[0].castShadow).toBe(false);
    terrain.dispose(scene, physics);
    expect(fieldMeshes(scene).length).toBe(0);
    expect(terrain.energyField).toBeUndefined();
  });

  it('neutralizes the edge falloff so the crossing is walkable', () => {
    const mkTerrain = (portals: boolean, boundary: string) => {
      const spec = portals ? portalSpec() : legacySpec();
      spec.world.boundary = boundary as never;
      if (!portals) delete (spec.world as unknown as { portals?: unknown }).portals;
      const physics = new Physics(spec.world.gravity);
      const mats = new MaterialLibrary(spec);
      const scene = new THREE.Scene();
      const terrain = new Terrain(spec, physics, mats, scene);
      return { terrain, scene, physics };
    };
    const half = 4000 / 2;
    // portal maps: 'walls' and 'none' give identical edge heights (falloff neutralized)
    const w = mkTerrain(true, 'walls');
    const n = mkTerrain(true, 'none');
    expect(w.terrain.heightAt(half - 2, 0)).toBe(n.terrain.heightAt(half - 2, 0));
    // legacy maps: the 'walls' rim really rises at the edge (base behavior kept)
    const legacy = mkTerrain(false, 'walls');
    const legacyEdge = legacy.terrain.heightAt(half - 2, 0);
    expect(legacyEdge - w.terrain.heightAt(half - 2, 0)).toBeGreaterThan(5);
    w.terrain.dispose(w.scene, w.physics);
    n.terrain.dispose(n.scene, n.physics);
    legacy.terrain.dispose(legacy.scene, legacy.physics);
  });

  it('field geometry is deterministic across builds (8km)', () => {
    const mk = () => {
      const spec = portalSpec(8000, 777);
      const physics = new Physics(spec.world.gravity);
      const mats = new MaterialLibrary(spec);
      const scene = new THREE.Scene();
      const terrain = new Terrain(spec, physics, mats, scene);
      const p = (fieldMeshes(scene)[0].geometry.getAttribute('position').array as Float32Array).slice();
      terrain.dispose(scene, physics);
      return p;
    };
    const a = mk(), b = mk();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  }, 60000);

  it('shares one material across builds (never per-map)', () => {
    const a = buildEnergyField(4000);
    const b = buildEnergyField(8000);
    expect(a.material).toBe(b.material);
    expect(a.material).toBe(energyFieldMaterial());
    a.geometry.dispose();
    b.geometry.dispose();
  });
});

describe('legacy (non-portal) boundary unchanged', () => {
  it('keeps 4 wall bodies and builds no field', () => {
    const spec = legacySpec();
    expect(spec.world.boundary).toBe('walls');
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    expect(terrain.walls.length).toBe(4);
    expect(terrain.energyField).toBeUndefined();
    expect(fieldMeshes(scene).length).toBe(0);
    terrain.dispose(scene, physics);
  });

  it('arena genres keep walls (portals off)', () => {
    const spec = generateSpec('fps arena shooter in a neon city', { seed: 99 });
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    expect(portalsEnabled(spec)).toBe(false);
    expect(terrain.energyField).toBeUndefined();
    expect(terrain.walls.length).toBeGreaterThan(0);
    terrain.dispose(scene, physics);
  });
});

describe('energy-field shader clock', () => {
  it('advances only via updateEnergyField (zero per-frame CPU otherwise)', () => {
    const t0 = energyFieldTime();
    updateEnergyField(0.5);
    expect(energyFieldTime()).toBeCloseTo(t0 + 0.5, 6);
    updateEnergyField(1.25);
    expect(energyFieldTime()).toBeCloseTo(t0 + 1.75, 6);
  });

  it('Terrain.updateField is a no-op without a field', () => {
    const spec = legacySpec();
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const t0 = energyFieldTime();
    terrain.updateField(2.0); // must not throw, must not advance the clock
    expect(energyFieldTime()).toBe(t0);
    terrain.dispose(scene, physics);
  });

  it('Terrain.updateField advances the clock on portal maps', () => {
    const spec = portalSpec();
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const t0 = energyFieldTime();
    terrain.updateField(2.0);
    expect(energyFieldTime()).toBeCloseTo(t0 + 2.0, 6);
    terrain.dispose(scene, physics);
  });

  it('disposeEnergyField removes the mesh from the scene', () => {
    const scene = new THREE.Scene();
    const m = buildEnergyField(4000);
    scene.add(m);
    expect(() => disposeEnergyField(scene, m)).not.toThrow();
    expect(scene.children.includes(m)).toBe(false);
  });
});
