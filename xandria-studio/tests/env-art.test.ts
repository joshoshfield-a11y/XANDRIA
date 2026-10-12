/**
 * Env-art pass (inventory wave): blocky landmarks, amber glow accents,
 * biome material treatments, water sun glint, dusk grade preset.
 *
 * - placeLandmarks: deterministic, exclusion-aware, light-budgeted, 1–3 per
 *   world from the (env × genre) mix, instanced repeated geometry, amber
 *   rune strips + lamps registered per landmark
 * - AmberGlow: deterministic scatter, real-light budget clamped
 * - Props: blocktree / lamppost / lantern kinds build and scatter
 * - Materials.biomeGround: cached treatments per biome (cracked earth, snow
 *   sparkle, volcanic ember emissive, wet sand)
 * - Terrain.setWaterSun: glint uniforms set, bad input ignored
 * - GenreGrade dusk preset: amber fog tint + stronger god-rays; night locked
 * - LightShafts: dusk uBase scaled by grade.godRays
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Rng } from '../src/engine/core/Rng';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Terrain } from '../src/engine/world/Terrain';
import { Structures } from '../src/engine/world/Structures';
import { placeLandmarks, buildBeamTower, buildRuinArch, buildBridge, type LandmarkOpts } from '../src/engine/gfx/Landmarks';
import { scatterAmberGlow, makeLampPost, makeGroundLantern, makeDoorwayGlow, AMBER, MAX_REAL_LIGHTS } from '../src/engine/gfx/AmberGlow';
import { scatterProps, makeBlockTree, type PropPalette } from '../src/engine/gfx/Props';
import { gradeAtmosphere } from '../src/engine/gfx/GenreGrade';
import { LightShafts } from '../src/engine/gfx/LightShafts';
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
  spec.world.terrain.water = true;
  spec.world.terrain.waterLevel = 0.5;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, mats, scene, terrain };
}

function landmarkOpts(mats: MaterialLibrary, terrain: Terrain, spec: ReturnType<typeof generateSpec>, extra: Partial<LandmarkOpts> = {}): LandmarkOpts {
  const pal = spec.theme.palette;
  return {
    mats,
    pal: { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, rock: pal.rock, ground: pal.ground },
    heightAt: (x, z) => terrain.heightAt(x, z),
    genre: spec.meta.genre,
    env: spec.theme.environment,
    quality: 'high',
    half: 80,
    ...extra,
  };
}

function countRealLights(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => { if ((o as THREE.PointLight).isPointLight) n++; });
  return n;
}

describe('placeLandmarks', () => {
  it('is deterministic: same seed + opts → same placements', () => {
    const a = buildWorld();
    const b = buildWorld();
    const ra = placeLandmarks(new THREE.Scene(), new Rng(777), landmarkOpts(a.mats, a.terrain, a.spec));
    const rb = placeLandmarks(new THREE.Scene(), new Rng(777), landmarkOpts(b.mats, b.terrain, b.spec));
    expect(ra.placed.length).toBeGreaterThan(0);
    expect(ra.placed.map((p) => [p.kind, p.pos.x, p.pos.z])).toEqual(
      rb.placed.map((p) => [p.kind, p.pos.x, p.pos.z]),
    );
  });

  it('respects exclusion zones', () => {
    const { mats, terrain, spec } = buildWorld();
    const excl = [{ x: 0, z: 0, r: 40 }];
    const r = placeLandmarks(new THREE.Scene(), new Rng(31337), landmarkOpts(mats, terrain, spec, { exclusion: excl }));
    for (const p of r.placed) {
      const d = Math.hypot(p.pos.x, p.pos.z);
      expect(d).toBeGreaterThanOrEqual(40 + p.radius - 1e-6);
    }
  });

  it('stays within the real-light budget', () => {
    const { mats, terrain, spec } = buildWorld();
    const r = placeLandmarks(new THREE.Scene(), new Rng(99), landmarkOpts(mats, terrain, spec, { maxRealLights: 2 }));
    expect(r.realLights).toBeLessThanOrEqual(2);
    expect(countRealLights(r.group)).toBe(r.realLights);
    const r0 = placeLandmarks(new THREE.Scene(), new Rng(99), landmarkOpts(mats, terrain, spec, { maxRealLights: 0 }));
    expect(r0.realLights).toBe(0);
    expect(countRealLights(r0.group)).toBe(0);
  });

  it('picks a genre-appropriate mix: dominant kind first, 1–3 per world', () => {
    const w = buildWorld();
    // desert × third-person-action → arches dominant
    const desert = placeLandmarks(new THREE.Scene(), new Rng(5), landmarkOpts(w.mats, w.terrain, w.spec, { env: 'desert' }));
    expect(desert.placed.length).toBeGreaterThanOrEqual(1);
    expect(desert.placed.length).toBeLessThanOrEqual(3);
    expect(desert.placed[0].kind).toBe('ruin-arch');
    expect(desert.amberAccents).toBeGreaterThan(0);
    expect(desert.instancedMeshes).toBeGreaterThan(0);
    // volcanic → towers dominant
    const volc = placeLandmarks(new THREE.Scene(), new Rng(5), landmarkOpts(w.mats, w.terrain, w.spec, { env: 'volcanic' }));
    expect(volc.placed[0].kind).toBe('beam-tower');
    // racing × islands → bridges dominant (track crossings)
    const racing = placeLandmarks(new THREE.Scene(), new Rng(5), landmarkOpts(w.mats, w.terrain, w.spec, { env: 'islands', genre: 'racing' }));
    expect(racing.placed[0].kind).toBe('bridge');
    // explicit kinds override still forces absolute counts
    const forced = placeLandmarks(new THREE.Scene(), new Rng(5), landmarkOpts(w.mats, w.terrain, w.spec, {
      kinds: { 'beam-tower': 2, 'ruin-arch': 2, bridge: 1 },
    }));
    expect(forced.placed.filter((p) => p.kind === 'beam-tower').length).toBe(2);
    expect(forced.placed.filter((p) => p.kind === 'bridge').length).toBe(1);
  });

  it('never throws on degenerate input', () => {
    const { mats, terrain, spec } = buildWorld();
    const bad: LandmarkOpts = landmarkOpts(mats, terrain, spec, {
      heightAt: () => NaN,
      half: 0.5,
      exclusion: [{ x: 0, z: 0, r: 1e9 }],
    });
    const r = placeLandmarks(new THREE.Scene(), new Rng(1), bad);
    expect(r.placed.length).toBe(0);
    expect(r.realLights).toBe(0);
  });

  it('beam tower carries a glow beam + amber doorway; bridge has deck + rails', () => {
    const { mats, spec } = buildWorld();
    const pal = spec.theme.palette;
    const lp = { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, rock: pal.rock, ground: pal.ground };
    const tower = buildBeamTower(new Rng(11), mats, lp);
    expect(tower.children.length).toBeGreaterThan(8);
    const arch = buildRuinArch(new Rng(12), mats, lp);
    expect(arch.children.length).toBeGreaterThanOrEqual(4);
    const bridge = buildBridge(new Rng(13), mats, lp, () => -2, 20, 4);
    expect(bridge.children.length).toBeGreaterThan(10);
  });
});

describe('AmberGlow', () => {
  it('lamp post and lantern are emissive-only by default', () => {
    const { mats } = buildWorld();
    const lamp = makeLampPost(new Rng(21), mats);
    expect(countRealLights(lamp)).toBe(0);
    expect(lamp.children.length).toBeGreaterThan(5);
    const lan = makeGroundLantern(new Rng(22), mats);
    expect(countRealLights(lan)).toBe(0);
    const door = makeDoorwayGlow(mats, 1.6, 3.2, true);
    expect((door.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(2);
  });

  it('scatter is deterministic and clamps real lights to MAX_REAL_LIGHTS', () => {
    const a = buildWorld();
    const ra = scatterAmberGlow(new THREE.Scene(), new Rng(555), {
      mats: a.mats, groundY: (x, z) => a.terrain.heightAt(x, z), half: 60, quality: 'high', realLights: 99,
    });
    const rb = scatterAmberGlow(new THREE.Scene(), new Rng(555), {
      mats: a.mats, groundY: (x, z) => a.terrain.heightAt(x, z), half: 60, quality: 'high', realLights: 99,
    });
    expect(ra.lamps).toBe(rb.lamps);
    expect(ra.lanterns).toBe(rb.lanterns);
    expect(ra.realLights).toBeLessThanOrEqual(MAX_REAL_LIGHTS);
    expect(ra.lamps + ra.lanterns).toBeGreaterThan(0);
    expect(AMBER).toBe('#ffb545');
  });
});

describe('Props blocky variants', () => {
  it('blocktree / lamppost / lantern scatter through scatterProps', () => {
    const { mats, spec, scene } = buildWorld();
    const pal: PropPalette = {
      primary: spec.theme.palette.primary, secondary: spec.theme.palette.secondary,
      accent: spec.theme.palette.accent, rock: spec.theme.palette.rock, ground: spec.theme.palette.ground,
    };
    const tree = makeBlockTree(new Rng(31), mats, pal);
    expect(tree.children.length).toBeGreaterThanOrEqual(3); // trunk + canopy tiers
    const field = scatterProps(scene, new Rng(32), {
      mats, pal, quality: 'high', count: 12,
      kinds: ['blocktree', 'lamppost', 'lantern'],
    });
    expect(field.props.length).toBeGreaterThan(0);
    for (const p of field.props) {
      expect(['blocktree', 'lamppost', 'lantern']).toContain(p.kind);
      expect(p.node.children.length).toBeGreaterThan(0);
    }
    field.dispose();
  });
});

describe('Materials.biomeGround', () => {
  it('caches treatments per biome and gives volcanic an ember emissive', () => {
    const { mats } = buildWorld();
    expect(mats.biomeGround('volcanic')).toBe(mats.biomeGround('volcanic')); // cached
    expect(mats.biomeGround('desert')).not.toBe(mats.biomeGround('arctic'));
    const volc = mats.biomeGround('volcanic');
    expect(volc.emissiveMap).toBeTruthy();
    expect(volc.emissiveIntensity).toBeGreaterThan(1);
    // new texture kinds are cached and deterministic per library seed
    expect(mats.texture('cracked', '#c9a06a')).toBe(mats.texture('cracked', '#c9a06a'));
    expect(mats.texture('snowdrift', '#eef2f8')).toBe(mats.texture('snowdrift', '#eef2f8'));
  });
});

describe('Terrain water sun glint', () => {
  it('setWaterSun aligns the glint uniforms; bad input is ignored', () => {
    const { terrain } = buildWorld();
    expect(terrain.water).toBeTruthy();
    const dir = new THREE.Vector3(0.3, 0.2, 0.9);
    terrain.setWaterSun(dir, '#cfe8ff');
    const mat = (terrain.water as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect((mat.userData.uSunDirW.value as THREE.Vector3).angleTo(dir.clone().normalize())).toBeCloseTo(0, 6);
    expect((mat.userData.uGlint.value as THREE.Color).getHexString()).toBe('cfe8ff');
    const t0 = (mat.userData.uTime.value as number);
    terrain.updateWater(0.5);
    expect((mat.userData.uTime.value as number)).toBeCloseTo(t0 + 0.5, 9);
    // never throws, leaves state untouched
    terrain.setWaterSun(null, null);
    terrain.setWaterSun(new THREE.Vector3(NaN, 0, 0), 'not-a-color');
    expect((mat.userData.uGlint.value as THREE.Color).getHexString()).toBe('cfe8ff');
  });
});

describe('dusk grade preset', () => {
  it('dusk gets amber fog tint + stronger god-rays; night stays locked', () => {
    const dusk = gradeAtmosphere('third-person-action', 'dusk');
    expect(dusk.fogTint).toBe('#ff9a5c');
    expect(dusk.godRays).toBe(1.7);
    expect(dusk.exposure).toBe(0.72); // old baseline kept
    const day = gradeAtmosphere('third-person-action', 'day');
    expect(day.fogTint).toBeNull();
    expect(day.godRays).toBe(1.0);
    const night = gradeAtmosphere('racing', 'night');
    expect(night.fogTint).toBeNull();
    expect(night.godRays).toBe(1.0);
    expect(night.exposure).toBe(1.05);
  });

  it('LightShafts scales shaft alpha by grade.godRays at dusk', () => {
    const mk = (tod: 'day' | 'dusk') => {
      const spec = generateSpec('a heroic knight adventure', { seed: 8, genre: 'third-person-action' });
      spec.theme.timeOfDay = tod;
      return new LightShafts(new THREE.Scene(), spec, new THREE.Vector3(0.5, 0.3, 0.5).normalize(), 'standard');
    };
    const day = mk('day');
    const dusk = mk('dusk');
    expect(day.count).toBeGreaterThan(0);
    expect(dusk.count).toBe(day.count);
    const uBase = (s: LightShafts) => (s as any).mats.map((m: THREE.ShaderMaterial) => m.uniforms.uBase.value as number);
    const bDay = uBase(day), bDusk = uBase(dusk);
    expect(bDusk.length).toBe(bDay.length);
    for (let i = 0; i < bDay.length; i++) {
      expect(bDusk[i] / bDay[i]).toBeCloseTo(1.7, 6);
    }
    day.dispose(new THREE.Scene());
    dusk.dispose(new THREE.Scene());
  });
});

describe('Structures.landmarks wiring', () => {
  it('places the environment mix with colliders and returns a report', () => {
    const { spec, terrain, scene } = buildWorld();
    const stubPhysics = { box: () => ({}) } as unknown as Physics;
    const mats = new MaterialLibrary(spec);
    const structures = new Structures(stubPhysics, mats);
    const r = structures.landmarks(spec, terrain, scene, spec.meta.seed, { quality: 'high' });
    expect(r.placed.length).toBeGreaterThan(0);
    expect(r.realLights).toBeLessThanOrEqual(1);
    expect(structures.group.children).toContain(r.group);
  });
});
