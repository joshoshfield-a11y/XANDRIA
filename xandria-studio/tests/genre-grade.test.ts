/**
 * Beauty wave (workstream B): per-genre atmosphere grading + hero-prop scatter.
 *
 * - gradeAtmosphere() is pure/deterministic: table values, night locked to
 *   identity (the earlier night-lighting fix must not regress).
 * - createSky() wires the grade into exposure / fog / lights / clouds.
 * - Scatter hero props: seeded determinism, quality-tier count scaling,
 *   heroExclusion respected, footprint clamped.
 * - Terrain patchiness: deterministic vertex colors.
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { gradeAtmosphere, type Genre } from '../src/engine/gfx/GenreGrade';
import { fogDensityScaleForWorldSize } from '../src/engine/gfx/FarField';
import { createSky } from '../src/engine/gfx/Sky';
import { Scatter } from '../src/engine/world/Scatter';
import { Terrain } from '../src/engine/world/Terrain';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Physics } from '../src/engine/core/Physics';
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

const GENRES: Genre[] = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter'];

describe('gradeAtmosphere', () => {
  it('is deterministic', () => {
    for (const g of GENRES) {
      expect(gradeAtmosphere(g, 'day')).toEqual(gradeAtmosphere(g, 'day'));
      expect(gradeAtmosphere(g, 'dusk')).toEqual(gradeAtmosphere(g, 'dusk'));
    }
  });

  it('night grades to identity for every genre (night-lighting fix locked)', () => {
    for (const g of GENRES) {
      const n = gradeAtmosphere(g, 'night');
      expect(n.exposure).toBe(1.05);
      expect(n.fogDensity).toBe(1.0);
      expect(n.fogLuminance).toBe(1.0);
      expect(n.sun).toBe(1.0);
      expect(n.hemi).toBe(1.0);
      expect(n.ambient).toBe(1.0);
      expect(n.clouds).toBe(1.0);
      expect(n.sky).toBe(1.0);
    }
  });

  it('day sky-brightness scale tames the HDR horizon wash', () => {
    // measured on a CPU port of the Preetham shader: the horizon band renders
    // at linear ~2.2-2.8 even away from the sun, so ACES clips it to white.
    // A total (sky x exposure) scale ~0.27 lands the horizon at ~(212,220,222)
    // with the zenith a rich blue; per-genre values below track exposure.
    expect(gradeAtmosphere('racing', 'day').sky).toBe(0.55);
    expect(gradeAtmosphere('third-person-action', 'day').sky).toBe(0.45);
    expect(gradeAtmosphere('platformer', 'day').sky).toBe(0.45);
    for (const g of GENRES) {
      const s = gradeAtmosphere(g, 'day').sky;
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(0.6);
    }
  });

  it('day table values are as authored (fog/exposure anti-blowout)', () => {
    // racing is the brightest biome + needs the longest sightlines
    const r = gradeAtmosphere('racing', 'day');
    expect(r.exposure).toBe(0.52);
    expect(r.fogDensity).toBe(0.55);
    expect(r.fogLuminance).toBe(0.75);
    // top-down readability thins the fog hardest
    expect(gradeAtmosphere('top-down-shooter', 'day').fogDensity).toBe(0.5);
    // platformer keeps a dreamy depth but darkened so it cannot wash white
    const p = gradeAtmosphere('platformer', 'day');
    expect(p.fogDensity).toBe(1.15);
    expect(p.fogLuminance).toBeLessThan(1.0);
    // every day grade darkens the fog (the anti-blowout lever)
    for (const g of GENRES) {
      expect(gradeAtmosphere(g, 'day').fogLuminance).toBeLessThanOrEqual(0.9);
      expect(gradeAtmosphere(g, 'day').exposure).toBeLessThanOrEqual(0.62);
    }
  });

  it('dusk keeps the old 0.72 baseline for most genres', () => {
    expect(gradeAtmosphere('third-person-action', 'dusk').exposure).toBe(0.72);
    expect(gradeAtmosphere('fps-arena', 'dusk').exposure).toBe(0.72);
    expect(gradeAtmosphere('top-down-shooter', 'dusk').exposure).toBe(0.72);
  });
});

describe('createSky grade wiring', () => {
  const INTENTS: Array<[string, Genre]> = [
    ['sword adventure in ancient ruins', 'third-person-action'],
    ['neon fps arena at night', 'fps-arena'],
    ['desert racing grand prix', 'racing'],
    ['dreamy platformer', 'platformer'],
    ['top-down horde shooter', 'top-down-shooter'],
  ];

  it.each(INTENTS)('grades %s (%s)', (intent, genre) => {
    const spec = generateSpec(intent, { seed: 7 });
    expect(spec.meta.genre).toBe(genre);
    const scene = new THREE.Scene();
    const sky = createSky(spec, scene, 'high');
    const grade = gradeAtmosphere(genre, spec.theme.timeOfDay);
    try {
      expect(sky.exposure).toBe(grade.exposure);
      const baseDensity =
        spec.theme.weather === 'fog' ? 0.012
        : spec.theme.weather === 'storm' || spec.theme.weather === 'ash' ? 0.007
        : spec.theme.environment === 'space-station' ? 0.002 : 0.0035;
      expect((scene.fog as THREE.FogExp2).density).toBeCloseTo(
        baseDensity * grade.fogDensity * fogDensityScaleForWorldSize(spec.world.terrain.size), 10);
      const expectedFog = new THREE.Color(spec.theme.palette.fog);
      if (spec.theme.timeOfDay === 'night') expectedFog.multiplyScalar(0.35);
      expectedFog.multiplyScalar(grade.fogLuminance);
      // env-art pass: dusk grades an amber fog tint
      if (grade.fogTint) expectedFog.lerp(new THREE.Color(grade.fogTint), 0.35);
      expect((scene.fog as THREE.FogExp2).color.getHex()).toBe(expectedFog.getHex());
      expect((scene.background as THREE.Color).getHex()).toBe(expectedFog.getHex());
      // day/dusk: the physical sky shader carries the per-genre brightness patch
      if (spec.theme.timeOfDay !== 'night') {
        const dome = sky.group.children[0] as THREE.Mesh;
        const fs = (dome.material as THREE.ShaderMaterial).fragmentShader;
        expect(fs).toContain(`retColor * ${grade.sky.toFixed(3)}`);
      }
    } finally {
      sky.dispose();
    }
  });

  it('night (fps-arena) keeps the locked light levels', () => {
    const spec = generateSpec('neon fps arena at night', { seed: 7 });
    expect(spec.theme.timeOfDay).toBe('night');
    const scene = new THREE.Scene();
    const sky = createSky(spec, scene, 'high');
    try {
      expect(sky.exposure).toBe(1.05);
      expect(sky.sun.intensity).toBe(1.8);
      expect(sky.hemi.intensity).toBe(1.3);
      expect(sky.ambient.intensity).toBe(0.9);
    } finally {
      sky.dispose();
    }
  });
});

function buildWorld(intent: string, seed: number) {
  const spec = generateSpec(intent, { seed });
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, mats, scene, terrain };
}

function matrixFingerprint(s: Scatter): string {
  return s.sets
    .map((set) => {
      const a = set.mesh.instanceMatrix.array as Float32Array;
      let h = 0;
      for (let i = 0; i < a.length; i += 16) h = (h * 31 + Math.round(a[i] * 1e3)) | 0;
      return `${set.positions.length}:${h}`;
    })
    .join('|');
}

describe('Scatter hero props', () => {
  it('is deterministic per seed (racing)', () => {
    const w1 = buildWorld('desert racing grand prix', 42);
    const w2 = buildWorld('desert racing grand prix', 42);
    const s1 = new Scatter(w1.spec, w1.terrain, w1.mats, w1.physics, w1.scene, { quality: 'high' });
    const s2 = new Scatter(w2.spec, w2.terrain, w2.mats, w2.physics, w2.scene, { quality: 'high' });
    expect(s1.sets.length).toBe(s2.sets.length);
    expect(s1.sets.length).toBeGreaterThan(1); // base rocks + hero sets
    expect(matrixFingerprint(s1)).toBe(matrixFingerprint(s2));
  });

  it('hero counts scale with quality tier (retro < standard < high)', () => {
    const alloc = (quality: 'retro' | 'standard' | 'high') => {
      const w = buildWorld('desert racing grand prix', 42);
      const s = new Scatter(w.spec, w.terrain, w.mats, w.physics, w.scene, { quality });
      // genre-hero sets only (base rocks + workstream-C biome sets excluded).
      // Stage 1: the racing world is 400m, so it streams through global pools
      // with fixed capacity — assert on the live placed count, not capacity.
      return s.sets
        .filter((set) => set.tag === 'genre-hero')
        .map((set) => set.mesh.count);
    };
    const retro = alloc('retro');
    const standard = alloc('standard');
    const high = alloc('high');
    expect(retro.length).toBeGreaterThan(0);
    for (let i = 0; i < retro.length; i++) {
      expect(standard[i]).toBeGreaterThanOrEqual(retro[i]);
      expect(high[i]).toBeGreaterThanOrEqual(standard[i]);
      expect(high[i]).toBeGreaterThan(retro[i]);
    }
  });

  it('heroesOnly scatters just the genre heroes (fps-arena)', () => {
    const w = buildWorld('neon fps arena at night', 42);
    const s = new Scatter(w.spec, w.terrain, w.mats, w.physics, w.scene, {
      heroesOnly: true,
      exclusion: [{ x: 0, z: 0, r: 10 }],
      quality: 'high',
    });
    expect(s.sets.length).toBe(2); // pylons + crates, no base sets
    expect(s.vegetation).toBeUndefined();
    for (const set of s.sets) {
      for (const p of set.positions) {
        expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('heroExclusion lets top-down heroes dress the arena interior', () => {
    const w = buildWorld('top-down horde shooter', 42);
    const arenaR = 40;
    const s = new Scatter(w.spec, w.terrain, w.mats, w.physics, w.scene, {
      exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
      heroExclusion: [{ x: 0, z: 0, r: 8 }],
      quality: 'high',
    });
    const heroSets = s.sets.filter((set) => set.tag === 'genre-hero');
    expect(heroSets.length).toBe(2);
    let inside = 0;
    for (const set of heroSets) {
      for (const p of set.positions) {
        expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(8); // spawn clearing kept
        if (Math.hypot(p.x, p.z) < arenaR) inside++;
      }
    }
    expect(inside).toBeGreaterThan(0); // heroes actually land inside the arena
  });

  it('hero instance footprints stay clamped (platformer shards)', () => {
    const w = buildWorld('dreamy platformer', 42);
    const s = new Scatter(w.spec, w.terrain, w.mats, w.physics, w.scene, {
      heroesOnly: true,
      quality: 'high',
    });
    expect(s.sets.length).toBe(2); // shards + wisps
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (const set of s.sets) {
      for (let i = 0; i < set.mesh.count; i++) {
        set.mesh.getMatrixAt(i, m);
        m.decompose(pos, quat, scl);
        // octahedron r=1 scaled (0.6s, 1.4s, 0.6s), s<=1.6 -> footprint <= ~2m; wisps smaller
        expect(Math.max(scl.x, scl.z)).toBeLessThan(4);
        expect(Number.isFinite(pos.y)).toBe(true);
      }
    }
  });
});

describe('Terrain patchiness', () => {
  // Workstream C: the biome treatment blends the spec palette toward the
  // biome's authored palette, and the auto biome rolls per seed/genre — pin
  // the biome so these tests measure the patch mechanism, not the roll.
  function buildPinnedWorld() {
    const w = buildWorld('sword adventure in ancient ruins', 99);
    w.spec.custom = { ...(w.spec.custom ?? {}), biome: { ...(w.spec.custom?.biome ?? {}), biomeId: 'plains' } };
    const physics = new Physics(w.spec.world.gravity);
    const mats = new MaterialLibrary(w.spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(w.spec, physics, mats, scene);
    return terrain;
  }

  it('vertex colors are deterministic per seed', () => {
    const w1 = buildWorld('sword adventure in ancient ruins', 99);
    const w2 = buildWorld('sword adventure in ancient ruins', 99);
    const c1 = w1.terrain.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c2 = w2.terrain.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(c1.array.length).toBe(c2.array.length);
    expect(Array.from(c1.array as Float32Array)).toEqual(Array.from(c2.array as Float32Array));
  });

  it('patchiness adds color variation across the terrain', () => {
    const terrain = buildPinnedWorld();
    const c = terrain.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = c.array as Float32Array;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i += 3) {
      const lum = 0.299 * arr[i] + 0.587 * arr[i + 1] + 0.114 * arr[i + 2];
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    // patch dark (×0.72) and light (+0.28 toward white) bands must both appear
    expect(max - min).toBeGreaterThan(0.15);
  });
});
