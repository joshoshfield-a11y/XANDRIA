/**
 * Workstream C — biome treatments.
 *
 * - All 7 biomes defined with valid content (palette hexes, sane fog values,
 *   water tints, ground kinds, flora/landmark references) and pairwise
 *   distinct looks.
 * - selectBiome() deterministic per seed/genre/environment; varies across
 *   seeds where variety is intended; stable where it isn't.
 * - resolveBiomeDef(): the Studio override (custom.biome.biomeId) wins, and
 *   the function never throws.
 * - validateSpec accepts/rejects custom.biome.biomeId.
 * - Terrain integration: override drives water tint + shared cached ground
 *   material; vertex colors stay deterministic and shift per biome.
 * - Scatter integration: per-biome prop sets are instanced, placed, and
 *   deterministic.
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  BIOME_IDS, BIOMES, BIOME_PALETTE_BLEND,
  availableBiomeIds, effectiveScatter, resolveBiomeDef, selectBiome,
  type BiomeDef, type BiomeId,
} from '../src/engine/world/Biomes';
import { BIOME_FOR_ENVIRONMENT } from '../src/engine/world/Biomes';
import { FLORA_IDS, ENVIRONMENTS, validateSpec, type BiomeId as SchemaBiomeId, type GameSpec } from '../src/spec/schema';
import { generateSpec } from '../src/generator/generate';
import { Terrain } from '../src/engine/world/Terrain';
import { Scatter } from '../src/engine/world/Scatter';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Physics } from '../src/engine/core/Physics';

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

const HEX = /^#[0-9a-fA-F]{6}$/;
const TEX_KINDS = ['ground', 'rock', 'metal', 'brick', 'wood', 'grid', 'sand', 'snow', 'lava', 'asphalt', 'concrete', 'crystal', 'panel', 'cracked', 'snowdrift', 'emberrock', 'wetsand'];
const LANDMARK_KINDS = ['beam-tower', 'ruin-arch', 'bridge'];

function specWithBiome(biomeId: string): GameSpec {
  const spec = generateSpec('a heroic knight adventure', { seed: 99 });
  spec.custom = {
    ...(spec.custom ?? {}),
    biome: { ...(spec.custom?.biome ?? {}), biomeId: biomeId as SchemaBiomeId },
  };
  return spec;
}

function buildTerrain(biomeId: BiomeId) {
  const spec = specWithBiome(biomeId);
  spec.world.terrain.water = true;
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
      return `${set.mesh.count}:${h}`;
    })
    .join('|');
}

describe('biome definitions', () => {
  it('defines all 7 biomes', () => {
    expect(BIOME_IDS).toHaveLength(7);
    expect(availableBiomeIds()).toEqual([...BIOME_IDS]);
    for (const id of BIOME_IDS) {
      const def: BiomeDef = BIOMES[id];
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
    }
  });

  it('every palette entry is a valid hex', () => {
    for (const id of BIOME_IDS) {
      for (const [k, v] of Object.entries(BIOMES[id].palette)) {
        expect(v, `${id}.palette.${k}`).toMatch(HEX);
      }
    }
  });

  it('fog values are blowout-safe (sane density, darkened, valid color)', () => {
    for (const id of BIOME_IDS) {
      const f = BIOMES[id].fog;
      expect(f.color, `${id}.fog.color`).toMatch(HEX);
      // absolute FogExp2 density: Sky.ts weather bases run 0.002..0.012 —
      // nothing here may exceed the heavy-fog base
      expect(f.density, `${id}.fog.density`).toBeGreaterThan(0);
      expect(f.density, `${id}.fog.density`).toBeLessThanOrEqual(0.008);
      // anti-blowout guard: luminance always pulls the fog off white
      expect(f.luminance, `${id}.fog.luminance`).toBeGreaterThan(0);
      expect(f.luminance, `${id}.fog.luminance`).toBeLessThanOrEqual(0.9);
    }
  });

  it('water tints are valid, opacity in range', () => {
    for (const id of BIOME_IDS) {
      const w = BIOMES[id].water;
      expect(w.tint, `${id}.water.tint`).toMatch(HEX);
      expect(w.glint, `${id}.water.glint`).toMatch(HEX);
      expect(w.opacity).toBeGreaterThan(0);
      expect(w.opacity).toBeLessThanOrEqual(1);
    }
  });

  it('ground params reference real texture kinds', () => {
    for (const id of BIOME_IDS) {
      const g = BIOMES[id].ground;
      expect(TEX_KINDS, `${id}.ground.kind`).toContain(g.kind);
      expect(g.base).toMatch(HEX);
      expect(g.alt).toMatch(HEX);
      expect(g.roughness).toBeGreaterThanOrEqual(0);
      expect(g.roughness).toBeLessThanOrEqual(1);
    }
  });

  it('flora references valid species, landmarks valid kinds', () => {
    for (const id of BIOME_IDS) {
      for (const sp of Object.keys(BIOMES[id].flora)) {
        expect(FLORA_IDS as readonly string[], `${id}.flora`).toContain(sp);
      }
      for (const k of Object.keys(BIOMES[id].landmarks)) {
        expect(LANDMARK_KINDS, `${id}.landmarks`).toContain(k);
      }
      expect(BIOMES[id].scatter.grass).toBeGreaterThanOrEqual(0);
      expect(BIOMES[id].scatter.grass).toBeLessThanOrEqual(1);
    }
  });

  it('each biome is visually distinct', () => {
    const sig = (d: BiomeDef) =>
      `${d.ground.kind}|${d.palette.ground}|${d.water.tint}|${d.fog.color}|${d.palette.accent}`;
    const sigs = BIOME_IDS.map((id) => sig(BIOMES[id]));
    expect(new Set(sigs).size).toBe(BIOME_IDS.length);
  });

  it('palette blend factor is sane', () => {
    expect(BIOME_PALETTE_BLEND).toBeGreaterThan(0);
    expect(BIOME_PALETTE_BLEND).toBeLessThan(1);
  });
});

describe('selectBiome', () => {
  it('is deterministic per seed/genre/environment', () => {
    for (const env of ENVIRONMENTS) {
      const a = selectBiome(1234, 'third-person-action', env);
      const b = selectBiome(1234, 'third-person-action', env);
      expect(a).toBe(b);
      expect(BIOME_IDS).toContain(a);
    }
  });

  it('varies across seeds for exploration genres', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) seen.add(selectBiome(seed, 'third-person-action', 'forest'));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('stays canonical for racing and fps-arena (no silent swaps)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      expect(selectBiome(seed, 'racing', 'wasteland')).toBe('desert-canyon');
      expect(selectBiome(seed, 'fps-arena', 'arena')).toBe('plains');
      expect(selectBiome(seed, 'top-down-shooter', 'volcanic')).toBe('volcanic');
    }
  });

  it('every environment maps to a real biome', () => {
    for (const env of ENVIRONMENTS) expect(BIOME_IDS).toContain(BIOME_FOR_ENVIRONMENT[env]);
  });
});

describe('resolveBiomeDef', () => {
  it('the Studio override wins over the seeded pick', () => {
    const spec = specWithBiome('caves');
    // sanity: the seeded auto pick for this spec is not caves
    const auto = BIOMES[selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment)];
    expect(auto.id).not.toBe('caves');
    expect(resolveBiomeDef(spec).id).toBe('caves');
  });

  it('auto mode matches selectBiome', () => {
    const spec = generateSpec('a heroic knight adventure', { seed: 99 });
    const expected = selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment);
    expect(resolveBiomeDef(spec).id).toBe(expected);
  });

  it('an invalid override falls back to auto and never throws', () => {
    const spec = specWithBiome('moon' as BiomeId);
    const expected = selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment);
    expect(resolveBiomeDef(spec).id).toBe(expected);
    expect(() => resolveBiomeDef({} as GameSpec)).not.toThrow();
    expect(resolveBiomeDef({} as GameSpec).id).toBe('plains');
  });
});

describe('custom.biome.biomeId validation', () => {
  it('accepts a valid biome id', () => {
    expect(validateSpec(specWithBiome('volcanic')).ok).toBe(true);
  });

  it('rejects an unknown biome id', () => {
    const spec = specWithBiome('moon');
    const res = validateSpec(spec);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('custom.biome.biomeId');
  });
});

describe('effectiveScatter', () => {
  it('a biome can ADD prop sets but never removes the generator ones', () => {
    const spec = generateSpec('a heroic knight adventure', { seed: 99 });
    spec.world.scatter.trees = false;
    // desert-canyon wants trees (cacti) and ruins
    const eff = effectiveScatter(spec, BIOMES['desert-canyon']);
    expect(eff.trees).toBe(true);
    expect(eff.ruins).toBe(true);
    // generator's rocks=true survives a biome that also wants rocks
    spec.world.scatter.rocks = true;
    expect(effectiveScatter(spec, BIOMES.caves).rocks).toBe(true);
  });
});

describe('Terrain biome integration', () => {
  it('volcanic override → lava water + shared cached emberrock ground', () => {
    const { terrain, mats } = buildTerrain('volcanic');
    expect(terrain.water).toBeDefined();
    const wm = terrain.water!.material as THREE.MeshStandardMaterial;
    expect(wm.color.getHexString()).toBe('ff5a1f');
    expect(wm.emissive.getHexString()).toBe('ff3300');
    // the ground material is the shared cached biome treatment, not a one-off
    expect(terrain.mesh.material).toBe(
      mats.biomeGroundDef(BIOMES.volcanic.ground, { repeat: terrain.size / 8 }),
    );
  });

  it('caves override → dark teal water', () => {
    const { terrain } = buildTerrain('caves');
    const wm = terrain.water!.material as THREE.MeshStandardMaterial;
    expect(wm.color.getHexString()).toBe('1e5a6a');
  });

  it('vertex colors stay deterministic and shift per biome', () => {
    const w1 = buildTerrain('snow');
    const w2 = buildTerrain('snow');
    const c1 = w1.terrain.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c2 = w2.terrain.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(Array.from(c1.array as Float32Array)).toEqual(Array.from(c2.array as Float32Array));

    const avgLum = (t: Terrain) => {
      const c = t.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const a = c.array as Float32Array;
      let s = 0;
      for (let i = 0; i < a.length; i += 3) s += 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
      return s / (a.length / 3);
    };
    // snow reads bright, volcanic reads near-black: the blend is doing work
    expect(avgLum(w1.terrain)).toBeGreaterThan(avgLum(buildTerrain('volcanic').terrain) + 0.2);
  });
});

describe('Scatter biome props integration', () => {
  function buildScatter(biomeId: BiomeId) {
    const spec = specWithBiome(biomeId);
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const scatter = new Scatter(spec, terrain, mats, physics, scene, { quality: 'high' });
    return scatter;
  }

  it('per-biome prop sets are placed and deterministic', () => {
    const s1 = buildScatter('caves');
    const s2 = buildScatter('caves');
    expect(matrixFingerprint(s1)).toBe(matrixFingerprint(s2));
    // last 3 sets = lanterns + stalagmites + glow crystals, all placed
    const biomeSets = s1.sets.slice(-3);
    expect(biomeSets).toHaveLength(3);
    for (const set of biomeSets) expect(set.mesh.count).toBeGreaterThan(0);
  });

  it('different biomes scatter different prop sets', () => {
    const caves = buildScatter('caves');
    const plains = buildScatter('plains');
    expect(matrixFingerprint(caves)).not.toBe(matrixFingerprint(plains));
  });
});
