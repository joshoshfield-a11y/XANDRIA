/**
 * Graphics follow-up, worker D — draw-call diet.
 *
 * - scatterAmberGlow batches lamps/lanterns through one Instancer (4 buckets)
 *   instead of a Group of ~8 meshes per lamp: same rng sequence, same world
 *   transforms, library-owned materials only.
 * - buildBeamTower takes an optional Instancer for its rock/dark structural
 *   boxes (tiers/platform/nubs → 2 buckets); glow pieces stay meshes.
 * - Sky clouds are one InstancedMesh of a unit circle (10–26 draws → 1),
 *   vertex-identical to the old per-mesh path.
 * - Vegetation hides LOD tiers that hold zero instances (no pixels → no draw).
 *
 * DOM is stubbed (no jsdom here) — same pattern as env-art.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Rng } from '../src/engine/core/Rng';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Terrain } from '../src/engine/world/Terrain';
import { Vegetation } from '../src/engine/world/Vegetation';
import { scatterAmberGlow } from '../src/engine/gfx/AmberGlow';
import { Instancer } from '../src/engine/gfx/AmberGlow';
import { buildBeamTower } from '../src/engine/gfx/Landmarks';
import { createSky } from '../src/engine/gfx/Sky';
import { generateSpec } from '../src/generator/generate';

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

function buildWorld(seed = 4242) {
  const spec = generateSpec('a heroic knight adventure', { seed, genre: 'third-person-action', environment: 'desert' });
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, mats, scene, terrain };
}

function instancedMeshes(root: THREE.Object3D): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o as THREE.InstancedMesh); });
  return out;
}

/** Digest of every baked instance matrix — determinism probe. */
function matrixDigest(ims: THREE.InstancedMesh[]): string {
  const m = new THREE.Matrix4();
  const parts: string[] = [];
  for (const im of ims) {
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      parts.push(m.elements.map((v) => v.toFixed(4)).join(','));
    }
  }
  return parts.join('|');
}

describe('scatterAmberGlow instancing', () => {
  it('batches lamps/lanterns into InstancedMesh buckets, no per-lamp groups', () => {
    const { mats, terrain } = buildWorld();
    const r = scatterAmberGlow(new THREE.Scene(), new Rng(555), {
      mats, groundY: (x, z) => terrain.heightAt(x, z), half: 60, quality: 'high',
    });
    expect(r.lamps).toBeGreaterThan(0);
    expect(r.lanterns).toBeGreaterThan(0);
    // every child is an InstancedMesh (point lights only when realLights > 0)
    for (const c of r.group.children) {
      expect((c as THREE.InstancedMesh).isInstancedMesh || (c as THREE.PointLight).isPointLight).toBe(true);
    }
    const ims = instancedMeshes(r.group);
    expect(ims.length).toBeGreaterThan(0);
    expect(ims.length).toBeLessThanOrEqual(4); // dark boxes, amber orbs, stone boxes, amber cores
    // lamp = 8 instances (post, foot, orb, 4 bars, cap); lantern = 3
    const total = ims.reduce((n, im) => n + im.count, 0);
    expect(total).toBe(r.lamps * 8 + r.lanterns * 3);
    // all instanced materials come from the library cache (shared, never disposed)
    for (const im of ims) expect(mats.ownsMaterial(im.material as THREE.Material)).toBe(true);
  });

  it('is deterministic: same seed → same baked instance matrices', () => {
    const mk = () => {
      const { mats, terrain } = buildWorld();
      const scene = new THREE.Scene();
      scatterAmberGlow(scene, new Rng(777), {
        mats, groundY: (x, z) => terrain.heightAt(x, z), half: 60, quality: 'standard',
      });
      return matrixDigest(instancedMeshes(scene));
    };
    expect(mk()).toBe(mk());
  });

  it('clamps real lights and keeps counts identical to the old contract', () => {
    const { mats, terrain } = buildWorld();
    const r = scatterAmberGlow(new THREE.Scene(), new Rng(555), {
      mats, groundY: (x, z) => terrain.heightAt(x, z), half: 60, quality: 'high', realLights: 99,
    });
    expect(r.realLights).toBeLessThanOrEqual(2);
    expect(r.lamps).toBe(10);
    expect(r.lanterns).toBe(18);
  });
});

describe('buildBeamTower instancing', () => {
  const pal = () => {
    const { spec } = buildWorld();
    const p = spec.theme.palette;
    return { primary: p.primary, secondary: p.secondary, accent: p.accent, rock: p.rock, ground: p.ground };
  };

  it('structural boxes batch into 2 buckets; glow pieces stay meshes', () => {
    const { mats } = buildWorld();
    const inst = new Instancer();
    const g = buildBeamTower(new Rng(11), mats, pal(), { inst });
    const ims = inst.bake(g);
    // rock boxes + dark boxes = 2 buckets
    expect(ims.length).toBe(2);
    // glow pieces (beams, doorway, windows) remain individual meshes
    const meshes = g.children.filter((c) => (c as THREE.Mesh).isMesh && !(c as THREE.InstancedMesh).isInstancedMesh);
    expect(meshes.length).toBeGreaterThan(2);
    for (const im of ims) expect(mats.ownsMaterial(im.material as THREE.Material)).toBe(true);
  });

  it('instanced path is deterministic', () => {
    const mk = () => {
      const { mats } = buildWorld();
      const inst = new Instancer();
      const g = buildBeamTower(new Rng(31), mats, pal(), { inst });
      return matrixDigest(inst.bake(g));
    };
    expect(mk()).toBe(mk());
  });

  it('mesh path unchanged without inst (existing contract)', () => {
    const { mats } = buildWorld();
    const tower = buildBeamTower(new Rng(11), mats, pal());
    expect(tower.children.length).toBeGreaterThan(8);
    expect(instancedMeshes(tower).length).toBe(0);
  });
});

describe('sky clouds instancing', () => {
  it('clouds are one InstancedMesh; no per-cloud meshes', () => {
    const { spec } = buildWorld();
    const scene = new THREE.Scene();
    const sky = createSky(spec, scene, 'retro');
    const ims = instancedMeshes(sky.group).filter((im) => im.geometry.type === 'CircleGeometry');
    expect(ims.length).toBe(1);
    const expected = spec.theme.weather === 'clear' ? 10 : 26;
    expect(ims[0].count).toBe(expected);
    // no leftover individual cloud meshes
    let singles = 0;
    sky.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.Mesh).geometry?.type === 'CircleGeometry') singles++;
    });
    expect(singles).toBe(0);
    sky.dispose();
  });

  it('cloud instances are deterministic per spec seed', () => {
    const mk = () => {
      const { spec } = buildWorld(999);
      const scene = new THREE.Scene();
      const sky = createSky(spec, scene, 'retro');
      const d = matrixDigest(instancedMeshes(sky.group));
      sky.dispose();
      return d;
    };
    expect(mk()).toBe(mk());
  });
});

describe('vegetation empty-tier hiding', () => {
  it('tiers with zero instances are hidden; populated tiers stay visible', () => {
    const { spec, mats, scene, terrain } = buildWorld();
    const physics = new Physics(spec.world.gravity);
    const veg = new Vegetation(spec, terrain, mats, scene, { count: 60, physics });
    // camera far away → every instance lands in LOD 2 → LOD 0/1 tiers empty
    veg.update(0.5, new THREE.Vector3(1e6, 0, 1e6));
    const tiers = (veg as unknown as { tiers: { mesh: THREE.InstancedMesh }[] }).tiers;
    expect(tiers.length).toBeGreaterThan(0);
    let hidden = 0, shown = 0;
    for (const t of tiers) {
      if (t.mesh.count === 0) { expect(t.mesh.visible).toBe(false); hidden++; }
      else { expect(t.mesh.visible).toBe(true); shown++; }
    }
    expect(hidden).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(0);
    veg.dispose(scene);
  });
});
