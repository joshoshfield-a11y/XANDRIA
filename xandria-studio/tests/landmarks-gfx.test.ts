/**
 * Workstream B — graphics full-scale: landmarks + amber motif.
 *
 * - placeLandmarks: 1–3 landmarks per world, seeded determinism of placements
 *   AND of baked instance matrices, genre-appropriate dominant kinds,
 *   amber accent registration (rune strips + lamp orbs), instanced draw calls,
 *   materials shared from the library cache.
 * - Instancer: deterministic bakes, bucket sharing by (geometry, material).
 * - makeRuneStrip: emissive amber slab with dark end caps.
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Rng } from '../src/engine/core/Rng';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import {
  placeLandmarks, buildRuinArch, buildBridge, pickKinds, kindWeights,
  type LandmarkOpts, type LandmarkKind,
} from '../src/engine/gfx/Landmarks';
import { Instancer, makeRuneStrip, amberGlowMaterial, AMBER } from '../src/engine/gfx/AmberGlow';
import { generateSpec } from '../src/generator/generate';
import type { Genre, Environment } from '../src/spec/schema';

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

function makeMats() {
  const spec = generateSpec('a test world', { seed: 4242, genre: 'third-person-action', environment: 'desert' });
  return { spec, mats: new MaterialLibrary(spec) };
}

function testOpts(mats: MaterialLibrary, extra: Partial<LandmarkOpts> = {}): LandmarkOpts {
  const { spec } = makeMats();
  const pal = spec.theme.palette;
  return {
    mats,
    pal: { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, rock: pal.rock, ground: pal.ground },
    heightAt: () => 0,
    genre: 'third-person-action' as Genre,
    env: 'desert' as Environment,
    quality: 'high',
    half: 80,
    ...extra,
  };
}

function instancedMeshes(root: THREE.Object3D): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o as THREE.InstancedMesh); });
  return out;
}

describe('placeLandmarks determinism', () => {
  it('same seed + opts → same placements AND same baked instance matrices', () => {
    const { mats } = makeMats();
    const run = (seed: number) => placeLandmarks(new THREE.Scene(), new Rng(seed), testOpts(mats));
    const a = run(777);
    const b = run(777);
    expect(a.placed.length).toBeGreaterThan(0);
    expect(a.placed.map((p) => [p.kind, p.pos.x, p.pos.z])).toEqual(
      b.placed.map((p) => [p.kind, p.pos.x, p.pos.z]),
    );
    expect(a.amberAccents).toBe(b.amberAccents);
    expect(a.instancedMeshes).toBe(b.instancedMeshes);
    const ia = instancedMeshes(a.group);
    const ib = instancedMeshes(b.group);
    expect(ia.length).toBe(ib.length);
    expect(ia.length).toBeGreaterThan(0);
    for (let i = 0; i < ia.length; i++) {
      expect(ia[i].count).toBe(ib[i].count);
      expect(Array.from(ia[i].instanceMatrix.array)).toEqual(Array.from(ib[i].instanceMatrix.array));
    }
  });

  it('different seeds diverge', () => {
    const { mats } = makeMats();
    const a = placeLandmarks(new THREE.Scene(), new Rng(1), testOpts(mats));
    const b = placeLandmarks(new THREE.Scene(), new Rng(2), testOpts(mats));
    const ka = a.placed.map((p) => p.kind).join(',');
    const kb = b.placed.map((p) => p.kind).join(',');
    // placements or accents differ between seeds (not asserting which)
    expect(ka !== kb || a.amberAccents !== b.amberAccents).toBe(true);
  });
});

describe('landmark count bounds', () => {
  it('places 1–3 landmarks per world across genres × environments × seeds', () => {
    const { mats } = makeMats();
    const genres: Genre[] = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter'];
    const envs: Environment[] = ['desert', 'volcanic', 'islands', 'arena', 'forest', 'city'];
    let worlds = 0;
    for (let seed = 1; seed <= 24; seed++) {
      for (const genre of genres) {
        for (const env of envs) {
          const r = placeLandmarks(new THREE.Scene(), new Rng(seed), testOpts(mats, { genre, env }));
          expect(r.placed.length).toBeGreaterThanOrEqual(1);
          expect(r.placed.length).toBeLessThanOrEqual(3);
          worlds++;
        }
      }
    }
    expect(worlds).toBe(24 * genres.length * envs.length);
  });
});

describe('genre-appropriate kinds', () => {
  it('dominant kind is placed first regardless of seed', () => {
    const { mats } = makeMats();
    const dom = (seed: number, genre: Genre, env: Environment): LandmarkKind =>
      placeLandmarks(new THREE.Scene(), new Rng(seed), testOpts(mats, { genre, env })).placed[0].kind;
    for (const seed of [5, 6, 7]) {
      expect(dom(seed, 'racing', 'islands')).toBe('bridge');
      expect(dom(seed, 'fps-arena', 'volcanic')).toBe('beam-tower');
      expect(dom(seed, 'platformer', 'desert')).toBe('ruin-arch');
      expect(dom(seed, 'top-down-shooter', 'volcanic')).toBe('beam-tower');
      expect(dom(seed, 'third-person-action', 'desert')).toBe('ruin-arch');
    }
  });

  it('kindWeights reflects the genre bias table', () => {
    const [t, , b] = kindWeights('racing', 'islands');
    expect(b).toBeGreaterThan(t); // racing wants bridges
    const [t2, a2] = kindWeights('fps-arena', 'volcanic');
    expect(t2).toBeGreaterThan(a2); // fps-arena wants towers
    expect(pickKinds(new Rng(3), 'racing', 'islands', 3)[0]).toBe('bridge');
  });
});

describe('amber accent registration', () => {
  it('every landmark registers rune strips + lamps; amber instances match the report', () => {
    const { mats } = makeMats();
    const amber = amberGlowMaterial(mats, 2.6);
    const r = placeLandmarks(new THREE.Scene(), new Rng(4242), testOpts(mats));
    expect(r.placed.length).toBeGreaterThan(0);
    expect(r.amberAccents).toBeGreaterThan(0);
    // every registered accent is one amber instance: rune strips + lamp orbs
    let amberInstances = 0;
    for (const im of instancedMeshes(r.group)) {
      if (im.material === amber) amberInstances += im.count;
    }
    expect(amberInstances).toBe(r.amberAccents);
    // each landmark has at least one amber instance near its footprint
    const amberPos: THREE.Vector3[] = [];
    for (const im of instancedMeshes(r.group)) {
      if (im.material !== amber) continue;
      const m = new THREE.Matrix4();
      const v = new THREE.Vector3();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        v.setFromMatrixPosition(m);
        amberPos.push(v.clone());
      }
    }
    for (const p of r.placed) {
      const near = amberPos.some((v) => Math.hypot(v.x - p.pos.x, v.z - p.pos.z) <= p.radius + 4);
      expect(near).toBe(true);
    }
  });
});

describe('instancing + material sharing', () => {
  it('repeated geometry batches into few InstancedMeshes with cached materials', () => {
    const { mats } = makeMats();
    const r = placeLandmarks(new THREE.Scene(), new Rng(4242), testOpts(mats));
    const ims = instancedMeshes(r.group);
    expect(ims.length).toBe(r.instancedMeshes);
    expect(ims.length).toBeGreaterThan(0);
    // every instanced material is library-owned (shared, never disposed)
    for (const im of ims) expect(mats.ownsMaterial(im.material as THREE.Material)).toBe(true);
    // exactly one shared amber material across all accent buckets
    const ambers = new Set(ims.filter((im) => (im.material as THREE.MeshStandardMaterial).emissiveIntensity > 2).map((im) => im.material));
    expect(ambers.size).toBe(1);
    expect(AMBER).toBe('#ffb545');
  });

  it('instanced arch/bridge builds share one rock material across segments', () => {
    const { spec, mats } = makeMats();
    const pal = spec.theme.palette;
    const lp = { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, rock: pal.rock, ground: pal.ground };
    const inst = new Instancer();
    const arch = buildRuinArch(new Rng(12), mats, lp, inst);
    const baked = inst.bake(arch);
    expect(baked.length).toBeGreaterThan(0);
    const rockMats = new Set(baked.map((im) => im.material));
    expect(rockMats.size).toBe(1); // one shared rock material for all segments
    const bridgeInst = new Instancer();
    const bridge = buildBridge(new Rng(13), mats, lp, () => -2, 20, 4, bridgeInst);
    const bb = bridgeInst.bake(bridge);
    expect(new Set(bb.map((im) => im.material)).size).toBeLessThanOrEqual(2); // rock + dark
  });
});

describe('Instancer', () => {
  it('bakes deterministically and buckets by material', () => {
    const { mats } = makeMats();
    const amber = amberGlowMaterial(mats, 2.6);
    const rock = mats.standard('rock', '#7d7568', { roughness: 1 });
    const seq = (inst: Instancer) => {
      inst.box(amber, 1, 0.2, 3, 1.5, 0.3, 0.55, 0.4, false);
      inst.box(rock, 0, 1, 0, 1, 2, 1, 0, true);
      inst.sphere(amber, 5, 1, 5, 0.3, false);
      inst.box(amber, 2, 0.2, 4, 1.5, 0.3, 0.55, 1.1, false);
    };
    const g1 = new THREE.Group(); const i1 = new Instancer(); seq(i1); const m1 = i1.bake(g1);
    const g2 = new THREE.Group(); const i2 = new Instancer(); seq(i2); const m2 = i2.bake(g2);
    // buckets: (box, amber) + (sphere, amber) + (box, rock) = 3 meshes
    expect(m1.length).toBe(3);
    expect(i1.countFor(amber)).toBe(3);
    expect(i1.countFor(rock)).toBe(1);
    expect(i1.instanceCount).toBe(4);
    for (let i = 0; i < m1.length; i++) {
      expect(Array.from(m1[i].instanceMatrix.array)).toEqual(Array.from(m2[i].instanceMatrix.array));
    }
  });
});

describe('makeRuneStrip', () => {
  it('builds an emissive amber slab with dark end caps', () => {
    const { mats } = makeMats();
    const strip = makeRuneStrip(mats);
    expect(strip.children.length).toBe(3); // slab + 2 caps
    const slab = strip.children[0] as THREE.Mesh;
    expect((slab.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(2);
    expect((slab.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe('ffb545');
  });
});
