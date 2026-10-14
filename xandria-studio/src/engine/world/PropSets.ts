/**
 * Open-world stage 1: scatter prop sets as data.
 *
 * Every instanced prop set Scatter builds (base rocks/crystals/ruins, per-genre
 * heroes, per-biome props) is described here exactly once. The legacy
 * whole-world builder (Scatter, worlds <= 256m) and the chunked streaming
 * builder (ChunkedScatter, bigger worlds) both consume these descriptors, so
 * the two paths can never drift apart.
 *
 * Field-for-field this mirrors the definitions that used to live inline in
 * Scatter's constructor / scatterHeroes / scatterBiomeProps: same geometries,
 * materials, counts, scale/tilt/yOff rng usage, placement samplers and tags.
 * tests/chunk-scatter.test.ts pins the legacy path byte-identical.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';
import type { MaterialLibrary } from '../gfx/Materials';
import { resolveBiomeDef, effectiveScatter, type BiomeDef, type EffectiveScatter } from './Biomes';

export interface PlaceBounds { x0: number; x1: number; z0: number; z1: number; }

export interface PropSetDef {
  key: string;
  tag: 'base' | 'genre-hero' | 'biome';
  makeGeo: () => THREE.BufferGeometry;
  makeMat: (mats: MaterialLibrary) => THREE.Material;
  /** legacy whole-world instance target */
  count: number;
  /** chunked-mode per-chunk target from the chunk's placeable area (m²) */
  chunkCount: (chunkAreaM2: number) => number;
  /** hard per-chunk cap (density budget — resident set stays bounded) */
  budget: number;
  scale: (rng: Rng) => THREE.Vector3;
  collideR: number;
  yOff: number | ((rng: Rng) => number);
  physical: boolean;
  tilt: number;
  place: (rng: Rng, r: number, b: PlaceBounds) => THREE.Vector3 | null;
}

export interface PropSetCtx {
  spec: GameSpec;
  terrain: Terrain;
  density: number;
  quality: 'retro' | 'standard' | 'high';
  /** 0 when heroesOnly (base sets skipped) */
  heroGate: number;
  /** 0 when heroesOnly (biome sets skipped) */
  biomeGate: number;
  perTree: number;
  half: number;
  maxSlope: number;
  biome: BiomeDef;
  eff: EffectiveScatter;
  baseExcluded: (x: number, z: number, r: number) => boolean;
  heroExcluded: (x: number, z: number, r: number) => boolean;
}

/** Shared context derived once per Scatter construction. */
export function propSetCtx(
  spec: GameSpec, terrain: Terrain, mats: MaterialLibrary,
  opts: {
    exclusion?: Array<{ x: number; z: number; r: number }>;
    heroExclusion?: Array<{ x: number; z: number; r: number }>;
    maxSlope?: number;
    quality?: 'retro' | 'standard' | 'high';
    heroesOnly?: boolean;
  },
): PropSetCtx {
  const quality = opts.quality ?? 'retro';
  const heroesOnly = opts.heroesOnly ?? false;
  const maxSlope = opts.maxSlope ?? 0.45;
  const baseExcluded = (x: number, z: number, r = 0) =>
    (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
  const heroExcluded = (x: number, z: number, r = 0) =>
    (opts.heroExclusion ?? opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
  const sc = spec.world.scatter;
  const env = spec.theme.environment;
  const biome = resolveBiomeDef(spec);
  const eff = effectiveScatter(spec, biome);
  const perTree = env === 'forest' || env === 'jungle' ? 90
    : env === 'city' || env === 'neon-city' || env === 'arena' ? 6000 : 650;
  return {
    spec, terrain, density: sc.density, quality,
    heroGate: heroesOnly ? 0 : 1,
    biomeGate: heroesOnly ? 0 : 1,
    perTree, half: terrain.size / 2 - 8, maxSlope, biome, eff,
    baseExcluded, heroExcluded,
  };
}

/** Legacy whole-world tree target (kept here so both paths share it). */
export function legacyTreeCount(ctx: PropSetCtx): number {
  const area = ctx.terrain.size * ctx.terrain.size;
  return ctx.eff.trees
    ? Math.min(2200, Math.round((area / ctx.perTree) * ctx.density)) * ctx.heroGate : 0;
}

/** Chunked-mode per-chunk tree target. */
export function chunkTreeCount(ctx: PropSetCtx, chunkAreaM2: number): number {
  if (!ctx.eff.trees || ctx.heroGate === 0) return 0;
  return Math.min(TREE_CHUNK_BUDGET, Math.round((chunkAreaM2 / ctx.perTree) * ctx.density));
}

/** Per-chunk density budget: max trees in one 256m chunk (forest @ density 1 ≈ 728). */
export const TREE_CHUNK_BUDGET = 740;
/** Per-species per-chunk cap — keeps vegetation tier pools hard-bounded. */
export const TREE_SPECIES_CHUNK_CAP = 500;

/** Reference area the fixed legacy counts were authored against (220m world). */
const REF_AREA = 220 * 220;
const ROCKS_PER_M2 = 70 / REF_AREA;
const CRYSTALS_PER_M2 = 50 / REF_AREA;
const RUINS_PER_M2 = 24 / REF_AREA;
/** Area-scaled chunk target for a set authored as a fixed whole-world count. */
const scaled = (base: number, qMul: number, density: number, chunkAreaM2: number) =>
  Math.max(0, Math.round(base * density * qMul * (chunkAreaM2 / REF_AREA)));

function basePlacer(excluded: (x: number, z: number, r: number) => boolean, ctx: PropSetCtx) {
  const { terrain, maxSlope, spec } = ctx;
  return (rng: Rng, r: number, b: PlaceBounds): THREE.Vector3 | null => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = rng.range(b.x0, b.x1), z = rng.range(b.z0, b.z1);
      if (excluded(x, z, r)) continue;
      if (terrain.slopeAt(x, z) > maxSlope) continue;
      const y = terrain.heightAt(x, z);
      if (spec.world.terrain.water && y < spec.world.terrain.waterLevel + 0.5) continue;
      return new THREE.Vector3(x, y, z);
    }
    return null;
  };
}

/**
 * Ordered exactly like the legacy constructor: base sets, genre heroes,
 * biome props. The legacy builder consumes them in this order with one shared
 * rng — the stream is identical to the pre-refactor code (pinned by test).
 */
export function definePropSets(ctx: PropSetCtx, mats: MaterialLibrary): PropSetDef[] {
  const { spec, density, quality, heroGate, biomeGate, biome } = ctx;
  const pal = spec.theme.palette;
  const qMul = quality === 'high' ? 1 : quality === 'standard' ? 0.6 : 0.35;
  const hCount = (base: number) => Math.max(0, Math.round(base * density * qMul));
  const bCount = (base: number) => Math.max(0, Math.round(base * density * qMul));
  const placeBase = basePlacer(ctx.baseExcluded, ctx);
  const placeHero = basePlacer(ctx.heroExcluded, ctx);
  const defs: PropSetDef[] = [];

  // AssetBridge pattern: clamp absurd footprints before scattering.
  const clampFootprint = (geo: THREE.BufferGeometry, maxFoot: number) => {
    geo.computeBoundingBox();
    const size = geo.boundingBox!.getSize(new THREE.Vector3());
    const foot = Math.max(size.x, size.z);
    if (foot > maxFoot) geo.scale(maxFoot / foot, maxFoot / foot, maxFoot / foot);
  };

  const base = (
    key: string, makeGeo: () => THREE.BufferGeometry, makeMat: (m: MaterialLibrary) => THREE.Material,
    enabled: boolean, fixedCount: number, perM2: number, budget: number,
    scale: (rng: Rng) => THREE.Vector3, collideR: number,
    yOff: number | ((rng: Rng) => number) = 0, physical = false, tilt = 0,
  ) => {
    defs.push({
      key, tag: 'base', makeGeo, makeMat, count: enabled ? fixedCount * heroGate : 0,
      chunkCount: (a) => enabled ? Math.min(budget, Math.round(a * perM2 * density)) * heroGate : 0,
      budget, scale, collideR, yOff, physical, tilt, place: placeBase,
    });
  };

  // rocks
  base('rocks',
    () => new THREE.DodecahedronGeometry(1, 0),
    (m) => m.standard('rock', pal.rock, { roughness: 1 }),
    ctx.eff.rocks, Math.round(70 * density), ROCKS_PER_M2, 128,
    (rng) => { const s = rng.range(0.5, 2.6); return new THREE.Vector3(s, s * rng.range(0.6, 1), s); },
    0.9, 0.2, true);
  // crystals (glowing)
  if (ctx.eff.crystals) {
    base('crystals',
      () => new THREE.OctahedronGeometry(0.9, 0),
      (m) => m.glow(pal.accent, 1.4),
      true, Math.round(50 * density), CRYSTALS_PER_M2, 96,
      (rng) => { const s = rng.range(0.5, 2.0); return new THREE.Vector3(s * 0.6, s, s * 0.6); },
      0.6, 0.5, false);
  }
  // ruins: broken pillars
  if (ctx.eff.ruins) {
    base('ruins',
      () => new THREE.CylinderGeometry(0.55, 0.65, 4, 7),
      (m) => m.standard('rock', '#9a9484', { roughness: 1 }),
      true, Math.round(24 * density), RUINS_PER_M2, 48,
      (rng) => new THREE.Vector3(1, rng.range(0.3, 1.2), 1),
      0.8, 1.4, true);
  }

  // ---- per-genre hero props (never gated by heroesOnly — they ARE the heroesOnly path)
  const hero = (
    key: string, makeGeo: () => THREE.BufferGeometry, makeMat: (m: MaterialLibrary) => THREE.Material,
    baseCount: number,
    scale: (rng: Rng) => THREE.Vector3, collideR: number,
    yOff: number | ((rng: Rng) => number) = 0, physical = false, tilt = 0,
    place: PropSetDef['place'] = placeHero,
  ) => {
    const count = hCount(baseCount);
    defs.push({
      key, tag: 'genre-hero', makeGeo, makeMat, count,
      chunkCount: (a) => Math.min(96, scaled(baseCount, qMul, density, a)),
      budget: 96, scale, collideR, yOff, physical, tilt, place,
    });
  };

  const genre = spec.meta.genre;
  if (genre === 'third-person-action') {
    hero('hero-stones',
      () => { const g = new THREE.BoxGeometry(1.2, 4, 0.8); clampFootprint(g, 8); return g; },
      (m) => m.standard('rock', pal.rock, { roughness: 1 }),
      48,
      (rng) => { const s = rng.range(0.8, 1.2); return new THREE.Vector3(s, rng.range(0.7, 1.4), s); },
      0.7, 1.0, true, 0.14);
  } else if (genre === 'fps-arena') {
    hero('hero-pylons',
      () => { const g = new THREE.CylinderGeometry(0.16, 0.22, 5.2, 8); clampFootprint(g, 8); return g; },
      (m) => m.glow(pal.accent, 2.2),
      26,
      (rng) => new THREE.Vector3(1, rng.range(0.8, 1.2), 1),
      0.4, 2.6, false);
    hero('hero-crates',
      () => { const g = new THREE.BoxGeometry(1.7, 1.7, 1.7); clampFootprint(g, 8); return g; },
      (m) => m.standard('metal', '#5d6672', { roughness: 0.6, metalness: 0.4 }),
      30,
      (rng) => { const s = rng.range(0.8, 1.5); return new THREE.Vector3(s, s, s); },
      1.0, 0.9, true);
  } else if (genre === 'racing') {
    hero('hero-posts',
      () => { const g = new THREE.CylinderGeometry(0.14, 0.14, 1.7, 6); clampFootprint(g, 8); return g; },
      (m) => m.glow(pal.accent, 1.6),
      60,
      () => new THREE.Vector3(1, 1, 1),
      0.3, 0.85, false);
    hero('hero-shards',
      () => { const g = new THREE.BoxGeometry(1.8, 0.5, 1.1); clampFootprint(g, 8); return g; },
      (m) => m.standard('metal', '#4a4a52', { roughness: 0.7, metalness: 0.5 }),
      26,
      (rng) => { const s = rng.range(0.7, 1.6); return new THREE.Vector3(s, s, s); },
      0.9, 0.15, true, 0.35);
  } else if (genre === 'platformer') {
    // floating crystal shards + wisps drift along the course band (course
    // space: the platformer terrain sits far below the course).
    // Chunk-aware: the course band is clipped to the placing chunk's rect so
    // each chunk owns the props physically inside it (legacy bounds = whole
    // world, so the legacy path is unchanged).
    const courseY = Math.max(3, ctx.terrain.heightAt(-ctx.terrain.size / 2 + 14, 0) + 3);
    const half = ctx.half;
    const course = (rng: Rng, _r: number, b: PlaceBounds): THREE.Vector3 | null => {
      const x0 = Math.max(b.x0, -half + 10), x1 = Math.min(b.x1, half - 10);
      const z0 = Math.max(b.z0, -26), z1 = Math.min(b.z1, 26);
      if (x0 >= x1 || z0 >= z1) return null;
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      return new THREE.Vector3(x, courseY + rng.range(-3, 9), z);
    };
    hero('hero-shards',
      () => { const g = new THREE.OctahedronGeometry(1, 0); clampFootprint(g, 8); return g; },
      (m) => m.glow(pal.accent, 1.8),
      48,
      (rng) => { const s = rng.range(0.5, 1.6); return new THREE.Vector3(s * 0.6, s * 1.4, s * 0.6); },
      0, 0, false, 0, course);
    hero('hero-wisps',
      () => { const g = new THREE.SphereGeometry(0.35, 8, 6); clampFootprint(g, 8); return g; },
      (m) => m.glow('#ffffff', 1.2),
      28,
      () => new THREE.Vector3(1, 1, 1),
      0, 0, false, 0, course);
  } else if (genre === 'top-down-shooter') {
    hero('hero-barricades',
      () => { const g = new THREE.BoxGeometry(2.4, 0.95, 0.55); clampFootprint(g, 8); return g; },
      (m) => m.standard('metal', '#6a7078', { roughness: 0.55, metalness: 0.5 }),
      30,
      (rng) => new THREE.Vector3(rng.range(0.9, 1.3), 1, 1),
      0, 0.48, false);
    hero('hero-pylons',
      () => { const g = new THREE.CylinderGeometry(0.2, 0.3, 3.4, 8); clampFootprint(g, 8); return g; },
      (m) => m.glow(pal.accent, 2.0),
      20,
      (rng) => new THREE.Vector3(1, rng.range(0.9, 1.2), 1),
      0.5, 1.7, false);
  }

  // ---- per-biome props (skipped under heroesOnly — a blueprint that dresses
  // the world itself gets genre heroes only, like the base sets)
  const bprop = (
    key: string, makeGeo: () => THREE.BufferGeometry, makeMat: (m: MaterialLibrary) => THREE.Material,
    baseCount: number,
    scale: (rng: Rng) => THREE.Vector3, collideR: number,
    yOff: number | ((rng: Rng) => number) = 0, physical = false, tilt = 0,
  ) => {
    const count = bCount(baseCount) * biomeGate;
    defs.push({
      key, tag: 'biome', makeGeo, makeMat, count,
      chunkCount: (a) => Math.min(96, scaled(baseCount, qMul, density, a)) * biomeGate,
      budget: 96, scale, collideR, yOff, physical, tilt, place: placeHero,
    });
  };
  // Signature motif, every biome: amber lantern posts (post + orb merged —
  // one draw call). Sparse — they mark ruin approaches.
  bprop('biome-lanterns',
    () => {
      const post = new THREE.CylinderGeometry(0.09, 0.12, 2.4, 6);
      post.translate(0, 1.2, 0);
      const orb = new THREE.SphereGeometry(0.22, 8, 6);
      orb.translate(0, 2.55, 0);
      return mergeGeometries([post, orb]);
    },
    (m) => m.glow('#ffb43c', 2.0),
    14,
    (rng) => new THREE.Vector3(1, rng.range(0.9, 1.15), 1),
    0.35, 0, false);

  const id = biome.id;
  if (id === 'desert-canyon') {
    bprop('biome-fins',
      () => new THREE.BoxGeometry(0.7, 5, 2.2),
      (m) => m.standard('rock', '#b06a3c', { roughness: 1 }),
      22,
      (rng) => { const s = rng.range(0.7, 1.5); return new THREE.Vector3(s, s * rng.range(0.8, 1.3), s); },
      0.8, 1.6, true, 0.16);
  } else if (id === 'forest') {
    bprop('biome-logs',
      () => { const g = new THREE.CylinderGeometry(0.32, 0.4, 4.2, 7); g.rotateZ(Math.PI / 2); return g; },
      (m) => m.standard('wood', '#5a4230', { roughness: 1 }),
      14,
      (rng) => { const s = rng.range(0.8, 1.3); return new THREE.Vector3(s, s, s); },
      1.0, 0.35, true);
    bprop('biome-glowcaps',
      () => new THREE.SphereGeometry(0.3, 8, 6),
      (m) => m.glow('#ffb43c', 1.2),
      22,
      (rng) => new THREE.Vector3(rng.range(0.7, 1.6), rng.range(0.6, 1), rng.range(0.7, 1.6)),
      0, 0.1, false);
  } else if (id === 'snow') {
    bprop('biome-iceshards',
      () => new THREE.OctahedronGeometry(0.9, 0),
      (m) => m.flat('#bfe0ff', { roughness: 0.25, metalness: 0.1, emissive: '#9fd0ff', emissiveIntensity: 0.35 }),
      24,
      (rng) => { const s = rng.range(0.6, 1.8); return new THREE.Vector3(s * 0.6, s, s * 0.6); },
      0.5, 0.4, false, 0.2);
  } else if (id === 'volcanic') {
    bprop('biome-columns',
      () => new THREE.CylinderGeometry(0.55, 0.7, 5, 6),
      (m) => m.standard('rock', '#2a2522', { roughness: 1 }),
      24,
      (rng) => { const s = rng.range(0.7, 1.4); return new THREE.Vector3(s, s * rng.range(0.7, 1.2), s); },
      0.8, 1.5, true, 0.08);
    bprop('biome-vents',
      () => new THREE.SphereGeometry(0.4, 8, 6),
      (m) => m.glow('#ff7a2e', 2.2),
      16,
      (rng) => new THREE.Vector3(rng.range(0.8, 1.4), 0.6, rng.range(0.8, 1.4)),
      0, 0.05, false);
  } else if (id === 'coastline') {
    bprop('biome-pilings',
      () => new THREE.CylinderGeometry(0.22, 0.26, 3.2, 7),
      (m) => m.standard('wood', '#6a5a44', { roughness: 1 }),
      18,
      (rng) => new THREE.Vector3(1, rng.range(0.8, 1.2), 1),
      0.5, 1.0, true);
    bprop('biome-driftwood',
      () => { const g = new THREE.CylinderGeometry(0.25, 0.32, 3.6, 7); g.rotateZ(Math.PI / 2); return g; },
      (m) => m.standard('wood', '#8a7a64', { roughness: 1 }),
      12,
      (rng) => { const s = rng.range(0.8, 1.4); return new THREE.Vector3(s, s, s); },
      0.8, 0.3, true, 0.1);
  } else if (id === 'caves') {
    bprop('biome-stalagmites',
      () => new THREE.ConeGeometry(0.7, 3.4, 7),
      (m) => m.standard('rock', '#2a3438', { roughness: 1 }),
      26,
      (rng) => { const s = rng.range(0.7, 1.6); return new THREE.Vector3(s, s, s); },
      0.7, 1.0, true);
    bprop('biome-tealcrystals',
      () => new THREE.OctahedronGeometry(0.55, 0),
      (m) => m.glow('#59d8ff', 1.6),
      22,
      (rng) => { const s = rng.range(0.6, 1.5); return new THREE.Vector3(s * 0.7, s, s * 0.7); },
      0, 0.3, false);
  } else {
    // plains: waystones
    bprop('biome-waystones',
      () => new THREE.BoxGeometry(0.9, 2.2, 0.6),
      (m) => m.standard('rock', '#8a8578', { roughness: 1 }),
      16,
      (rng) => { const s = rng.range(0.8, 1.3); return new THREE.Vector3(s, s, s); },
      0.6, 0.7, true, 0.12);
  }
  return defs;
}
