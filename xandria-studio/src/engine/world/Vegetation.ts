/**
 * Vegetation — seeded, species-driven flora with LOD bucketing and GPU wind sway.
 * Deterministic successor of the legacy OP-08 BLOOM vegetation system: same ideas
 * (species, 3 LOD tiers, wind phase), rebuilt on the engine's Rng + Terrain so
 * placement is reproducible and integrated with exclusion zones and water.
 *
 * Graphics wave 2, workstream B (plants):
 * - Biome-distinct UNDERGROWTH (flowers, shrubs, dry scrub, snow shrubs, ash
 *   scrub, cave fungi, volcanic ember-plants, frost shards) is baked into each
 *   species' foliage LOD geometry as vertex-colored base clusters — LOD0 full,
 *   LOD1 reduced, LOD2 none. No new species tiers, no new InstancedMeshes, so
 *   the draw-call count is unchanged vs base by construction (the binding perf
 *   rule of this wave).
 * - HERO SPECIMEN plants: one oversized (2.6–3.4×), amber-tinted instance of
 *   the biome's signature species ringed around each landmark. They ride the
 *   existing species LOD tiers (instanceColor tint, zero new meshes) with
 *   per-chunk / per-world caps and their own rng stream, so existing placement
 *   stays byte-identical.
 * - Wind sway is vertex-shader only (zero per-frame CPU): per-vertex `aSway`
 *   weights (canopy ∝ height, undergrowth boosted so small plants visibly move),
 *   phase seeded from instance position. Cactus arms now sway too.
 */
import * as THREE from 'three';
import type * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';
import type { MaterialLibrary } from '../gfx/Materials';
import { resolveBiomeDef, effectiveScatter, type BiomeId } from './Biomes';
import { GROUP, type Physics } from '../core/Physics';
import { chunkSeed, MAX_RESIDENT_CHUNKS } from './ChunkGrid';
import { chunkKey, chunkWorldRect, type ChunkGrid } from './chunkLayout';
import { TREE_SPECIES_CHUNK_CAP, HERO_CHUNK_CAP, type PlaceBounds } from './PropSets';
import { scaleBudget } from '../core/PerformanceManager';

type SpeciesId = 'pine' | 'oak' | 'palm' | 'cactus' | 'deadtree' | 'mushroom' | 'crystalflora';

/** Landmark ring positions hero specimens are placed around. */
export interface HeroSpot { x: number; z: number; r: number; }

interface SpeciesDef {
  id: SpeciesId;
  trunkH: number;          // nominal trunk height (m)
  collideR: number;
  buildTrunk: (lod: 0 | 1 | 2) => THREE.BufferGeometry;
  buildFoliage: (lod: 0 | 1 | 2, ug: UndergrowthCtx) => THREE.BufferGeometry | null;
  foliageMat: (mats: MaterialLibrary, spec: GameSpec) => THREE.Material;
  minS: number; maxS: number;
}

const cyl = (r1: number, r2: number, h: number, seg: number, y: number) => {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  g.translate(0, y + h / 2, 0);
  return g;
};
const cone = (r: number, h: number, seg: number, y: number) => {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, y + h / 2, 0);
  return g;
};
const ball = (r: number, y: number, x = 0, z = 0, sy = 1) => {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return g;
};
const shard = (r: number, h: number, x: number, z: number, tilt: number, rot: number) => {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(r * 0.6, h, r * 0.6);
  g.rotateZ(tilt); g.rotateY(rot);
  g.translate(x, h * 0.55, z);
  return g;
};
const branch = (len: number, x: number, y: number, z: number, rz: number, ry: number) => {
  const g = new THREE.BoxGeometry(0.12, len, 0.12);
  g.translate(0, len / 2, 0);
  g.rotateZ(rz); g.rotateY(ry);
  g.translate(x, y, z);
  return g;
};

/**
 * Tag a geometry part for the foliage shader: per-vertex `color` (multiplies
 * the foliage material — white keeps the canopy color, tints paint the
 * undergrowth) and `aSway` (wind weight: 'height' reproduces the legacy
 * ∝ position.y canopy sway exactly; a number boosts small undergrowth so it
 * visibly moves). Every foliage part must be tagged — mergeGeometries needs
 * consistent attributes.
 */
function tag(g: THREE.BufferGeometry, color: string, sway: number | 'height'): THREE.BufferGeometry {
  // mergeGeometries needs consistent attributes AND consistent indexing:
  // Icosahedron/Octahedron parts are non-indexed while Box/Cone/Cylinder are
  // indexed — normalize everything to non-indexed (cheap at these poly counts).
  const ng = g.index ? g.toNonIndexed() : g;
  const n = ng.attributes.position.count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(n * 3);
  const sways = new Float32Array(n);
  const pos = ng.attributes.position;
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    sways[i] = sway === 'height' ? Math.max(pos.getY(i), 0) : sway;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  ng.setAttribute('aSway', new THREE.BufferAttribute(sways, 1));
  return ng;
}

// ---------- undergrowth (wave 2B): biome-distinct base clusters ----------

type UndergrowthKind =
  | 'flower' | 'shrub' | 'scrub' | 'snowshrub' | 'ashscrub' | 'fungi' | 'ember' | 'frostshard';

export interface UndergrowthCtx { kinds: UndergrowthKind[]; rng: Rng; }

/** Which undergrowth clusters grow at the base of a species in a biome. */
export function undergrowthFor(biomeId: BiomeId, sp: SpeciesId): UndergrowthKind[] {
  switch (biomeId) {
    case 'plains': return ['flower', 'shrub'];
    case 'forest': return ['flower', 'flower', 'shrub'];
    case 'desert-canyon': return ['scrub'];
    case 'snow': return ['snowshrub'];
    case 'volcanic': return sp === 'crystalflora' ? ['ember'] : ['ashscrub'];
    case 'coastline': return ['flower', 'shrub'];
    case 'caves': return sp === 'mushroom' ? ['fungi', 'fungi'] : ['frostshard'];
    default: return [];
  }
}

const ringXZ = (rng: Rng, rMin: number, rMax: number): [number, number] => {
  const a = rng.range(0, Math.PI * 2), r = rng.range(rMin, rMax);
  return [Math.cos(a) * r, Math.sin(a) * r];
};

function ugFlower(rng: Rng, lod: 0 | 1 | 2): THREE.BufferGeometry | null {
  const n = lod === 0 ? 5 : lod === 1 ? 3 : 0;
  if (!n) return null;
  const cols = ['#ffb43c', '#ffffff', '#ff7ab0', '#ffd94d'];
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = ringXZ(rng, 0.55, 1.35);
    const stem = new THREE.BoxGeometry(0.05, 0.3, 0.05); stem.translate(x, 0.15, z);
    const bloom = new THREE.BoxGeometry(0.17, 0.1, 0.17); bloom.translate(x, 0.34, z);
    parts.push(tag(stem, '#3f7a3d', 0.5), tag(bloom, rng.pick(cols), 0.6));
  }
  return mergeGeometries(parts);
}

function ugShrub(rng: Rng, lod: 0 | 1 | 2, color: string, sMin: number, sMax: number, sway: number): THREE.BufferGeometry | null {
  const n = lod === 0 ? 3 : lod === 1 ? 2 : 0;
  if (!n) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const s = rng.range(sMin, sMax);
    const g = new THREE.IcosahedronGeometry(s, 0);
    g.scale(1, 0.75, 1);
    const [x, z] = ringXZ(rng, 0.6, 1.25);
    g.translate(x, s * 0.55, z);
    parts.push(tag(g, color, sway));
  }
  return mergeGeometries(parts);
}

function ugScrub(rng: Rng, lod: 0 | 1 | 2, color: string, sway: number): THREE.BufferGeometry | null {
  const n = lod === 0 ? 3 : lod === 1 ? 2 : 0;
  if (!n) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = ringXZ(rng, 0.5, 1.2);
    const len = rng.range(0.4, 0.75);
    parts.push(tag(
      branch(len, x, 0, z, rng.range(-0.6, 0.6), rng.range(0, Math.PI * 2)),
      color, sway,
    ));
  }
  return mergeGeometries(parts);
}

function ugFungi(rng: Rng, lod: 0 | 1 | 2): THREE.BufferGeometry | null {
  const n = lod === 0 ? 4 : lod === 1 ? 2 : 0;
  if (!n) return null;
  const caps = ['#59d8ff', '#7ab8ff', '#a0f0ff'];
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = ringXZ(rng, 0.5, 1.3);
    const stem = cyl(0.05, 0.08, 0.26, 5, 0); stem.translate(x, 0, z);
    const cap = ball(rng.range(0.1, 0.16), 0.3, x, z, 0.6);
    parts.push(tag(stem, '#bfe8ff', 0.5), tag(cap, rng.pick(caps), 0.55));
  }
  return mergeGeometries(parts);
}

function ugShardCluster(rng: Rng, lod: 0 | 1 | 2, colors: string[]): THREE.BufferGeometry | null {
  const n = lod === 0 ? 4 : lod === 1 ? 2 : 0;
  if (!n) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = ringXZ(rng, 0.5, 1.2);
    parts.push(tag(
      shard(rng.range(0.1, 0.18), rng.range(0.3, 0.6), x, z, rng.range(-0.3, 0.3), rng.range(0, Math.PI * 2)),
      rng.pick(colors), 0,
    ));
  }
  return mergeGeometries(parts);
}

function buildUndergrowth(ug: UndergrowthCtx, lod: 0 | 1 | 2): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const k of ug.kinds) {
    const g =
      k === 'flower' ? ugFlower(ug.rng, lod)
      : k === 'shrub' ? ugShrub(ug.rng, lod, '#2e5a2e', 0.28, 0.5, 0.3)
      : k === 'scrub' ? ugScrub(ug.rng, lod, '#a88a5a', 0.35)
      : k === 'snowshrub' ? ugShrub(ug.rng, lod, '#dfe9f5', 0.25, 0.45, 0.25)
      : k === 'ashscrub' ? ugScrub(ug.rng, lod, '#3a3430', 0.3)
      : k === 'fungi' ? ugFungi(ug.rng, lod)
      : k === 'ember' ? ugShardCluster(ug.rng, lod, ['#ff5a1a', '#ffb43c', '#ff7a2e'])
      : ugShardCluster(ug.rng, lod, ['#9fd8ff', '#cfeaff']);
    if (g) parts.push(g);
  }
  return parts.length ? mergeGeometries(parts) : null;
}

function pineFoliage(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry {
  const layers = lod === 0 ? [[1.7, 2.6, 2.2], [1.3, 2.2, 4.0], [0.85, 1.8, 5.6]]
    : lod === 1 ? [[1.6, 3.0, 2.4], [1.0, 2.4, 4.6]]
    : [[1.5, 4.6, 2.2]];
  const parts = layers.map(([r, h, y]) => tag(cone(r, h, lod === 0 ? 7 : 5, y), '#ffffff', 'height'));
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return mergeGeometries(parts)!;
}
function oakFoliage(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry {
  const clusters = lod === 0
    ? [ball(1.5, 4.6), ball(1.1, 5.4, 1.1, 0.4), ball(1.1, 5.4, -1.0, -0.5), ball(0.9, 6.1, 0.2, -0.2)]
    : lod === 1 ? [ball(1.7, 4.8), ball(1.2, 5.8, 0.4, 0.2)]
    : [ball(2.0, 5.0)];
  const parts = clusters.map((g) => tag(g, '#ffffff', 'height'));
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return mergeGeometries(parts)!;
}
function palmFoliage(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry {
  const fronds = lod === 0 ? 6 : lod === 1 ? 4 : 0;
  const parts: THREE.BufferGeometry[] = [];
  if (!fronds) parts.push(tag(cone(1.4, 2.2, 5, 4.6), '#ffffff', 'height'));
  else for (let i = 0; i < fronds; i++) {
    const g = new THREE.BoxGeometry(0.28, 0.06, 2.2);
    g.translate(0, 0, 1.0);
    g.rotateX(0.5);
    g.rotateY((i / fronds) * Math.PI * 2);
    g.translate(0, 5.2, 0);
    parts.push(tag(g, '#ffffff', 'height'));
  }
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return mergeGeometries(parts)!;
}
function cactusArms(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  if (lod !== 2) {
    parts.push(
      tag(branch(1.2, 0.55, 1.6, 0, -0.9, 0), '#ffffff', 'height'),
      tag(branch(1.0, -0.55, 2.2, 0, 0.9, 0), '#ffffff', 'height'),
    );
  }
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return parts.length ? mergeGeometries(parts)! : null;
}
function deadBranches(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  const list = lod === 0
    ? [branch(1.6, 0.1, 2.6, 0, -0.8, 0.3), branch(1.3, -0.1, 3.2, 0.1, 0.7, 2.1), branch(1.1, 0, 3.8, -0.1, -0.5, 4.0), branch(0.9, 0.05, 4.4, 0.05, 0.6, 5.2)]
    : lod === 1
      ? [branch(1.4, 0.1, 2.8, 0, -0.8, 0.3), branch(1.1, -0.1, 3.4, 0.1, 0.7, 2.1)]
      : [];
  for (const g of list) parts.push(tag(g, '#ffffff', 'height'));
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return parts.length ? mergeGeometries(parts)! : null;
}
function mushroomCap(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry {
  const parts = [tag(ball(lod === 0 ? 1.3 : 1.2, 2.6, 0, 0, 0.55), '#ffffff', 'height')];
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return mergeGeometries(parts)!;
}
function crystalCluster(lod: 0 | 1 | 2, ug: UndergrowthCtx): THREE.BufferGeometry {
  const shards = lod === 0
    ? [shard(0.7, 2.6, 0, 0, 0.12, 0), shard(0.5, 1.8, 0.5, 0.2, -0.4, 1.2), shard(0.45, 1.5, -0.4, 0.3, 0.35, 2.6), shard(0.35, 1.1, 0.1, -0.5, 0.5, 4.2)]
    : lod === 1 ? [shard(0.7, 2.4, 0, 0, 0.12, 0), shard(0.45, 1.5, 0.4, 0.2, -0.4, 1.2)]
    : [shard(0.8, 2.4, 0, 0, 0, 0)];
  const parts = shards.map((g) => tag(g, '#ffffff', 'height'));
  const u = buildUndergrowth(ug, lod);
  if (u) parts.push(u);
  return mergeGeometries(parts)!;
}

const SPECIES: Record<SpeciesId, SpeciesDef> = {
  pine: {
    id: 'pine', trunkH: 2.2, collideR: 0.55, minS: 0.8, maxS: 1.9,
    buildTrunk: (lod) => cyl(0.22, 0.38, 2.4, lod === 0 ? 6 : 5, 0),
    buildFoliage: pineFoliage,
    foliageMat: (mats, spec) => mats.flat(spec.theme.environment === 'arctic' ? '#dfe9f0' : spec.theme.palette.primary, { roughness: 0.9, vertexColors: true }),
  },
  oak: {
    id: 'oak', trunkH: 2.6, collideR: 0.6, minS: 0.8, maxS: 1.7,
    buildTrunk: (lod) => cyl(0.26, 0.42, 3.4, lod === 0 ? 6 : 5, 0),
    buildFoliage: oakFoliage,
    foliageMat: (mats, spec) => mats.flat(spec.theme.palette.primary, { roughness: 0.9, vertexColors: true }),
  },
  palm: {
    id: 'palm', trunkH: 4.4, collideR: 0.45, minS: 0.8, maxS: 1.5,
    buildTrunk: (lod) => { const g = cyl(0.16, 0.26, 5.2, lod === 0 ? 6 : 5, 0); g.rotateZ(0.08); return g; },
    buildFoliage: palmFoliage,
    foliageMat: (mats) => mats.flat('#3f8f4f', { roughness: 0.85, vertexColors: true }),
  },
  cactus: {
    id: 'cactus', trunkH: 2.6, collideR: 0.5, minS: 0.7, maxS: 1.6,
    buildTrunk: (lod) => cyl(0.3, 0.34, 3.2, lod === 0 ? 7 : 6, 0),
    buildFoliage: cactusArms,
    foliageMat: (mats) => mats.flat('#4d7a3d', { roughness: 0.85, vertexColors: true }),
  },
  deadtree: {
    id: 'deadtree', trunkH: 3.4, collideR: 0.5, minS: 0.8, maxS: 1.8,
    buildTrunk: (lod) => cyl(0.2, 0.4, 4.6, lod === 0 ? 6 : 5, 0),
    buildFoliage: deadBranches,
    foliageMat: (mats) => mats.flat('#4c4137', { roughness: 1, vertexColors: true }),
  },
  mushroom: {
    id: 'mushroom', trunkH: 1.6, collideR: 0.5, minS: 0.6, maxS: 2.2,
    buildTrunk: (lod) => cyl(0.22, 0.34, 2.4, lod === 0 ? 7 : 5, 0),
    buildFoliage: mushroomCap,
    foliageMat: (mats, spec) => mats.flat(spec.theme.palette.accent, { roughness: 0.7, emissive: spec.theme.palette.accent, emissiveIntensity: 0.25, vertexColors: true }),
  },
  crystalflora: {
    id: 'crystalflora', trunkH: 0.01, collideR: 0.6, minS: 0.7, maxS: 1.8,
    buildTrunk: () => new THREE.BoxGeometry(0.01, 0.01, 0.01),
    buildFoliage: crystalCluster,
    foliageMat: (mats, spec) => mats.flat(spec.theme.palette.accent, { emissive: spec.theme.palette.accent, emissiveIntensity: 1.3, roughness: 0.3, vertexColors: true }),
  },
};

// ---------- hero specimens (wave 2B) ----------

/** Biome → signature species used for the oversized hero plant near landmarks. */
const HERO_SPECIES: Record<BiomeId, SpeciesId> = {
  plains: 'oak', forest: 'oak', 'desert-canyon': 'cactus', snow: 'pine',
  volcanic: 'crystalflora', coastline: 'palm', caves: 'mushroom',
};

/** Amber-tinted instance color per hero species (multiplies the foliage). */
const HERO_TINT: Record<SpeciesId, string> = {
  pine: '#ffd9a0', oak: '#ffcf7a', palm: '#ffe2a8', cactus: '#ffc46a',
  deadtree: '#d8a05a', mushroom: '#bfe8ff', crystalflora: '#ffb43c',
};

/** Hero placement scale range (× the species' normal max). */
const HERO_MIN_S = 2.6, HERO_MAX_S = 3.4;

/** environment → species mix */
export function speciesFor(env: string): SpeciesId[] {
  switch (env) {
    case 'forest': return ['pine', 'pine', 'oak'];
    case 'jungle': return ['palm', 'oak', 'palm'];
    case 'arctic': return ['pine'];
    case 'desert': return ['cactus', 'cactus', 'deadtree'];
    case 'volcanic': return ['deadtree', 'crystalflora'];
    case 'dreamscape': return ['mushroom', 'crystalflora', 'mushroom'];
    case 'wasteland': return ['deadtree', 'deadtree', 'cactus'];
    case 'ruins': return ['oak', 'deadtree'];
    case 'islands': return ['palm', 'palm', 'oak'];
    case 'space-station': return ['mushroom', 'crystalflora'];
    case 'city': case 'neon-city': return ['deadtree'];
    default: return ['pine', 'oak'];
  }
}

export interface VegetationOptions {
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
  colliders?: { x: number; z: number; r: number }[];  // shared with Scatter (legacy path)
  /**
   * Graphics wave 2 (E): tier wind-sway intensity multiplier. 1.0 = the
   * authored sway. Pure ALU — never a draw call.
   */
  windMul?: number;
  physics?: Physics;
  count: number;
  /** Landmark ring positions for hero specimen placement (wave 2B). */
  heroSpots?: HeroSpot[];
  /**
   * Open-world stage 1: chunked streaming mode. Placement becomes per-chunk
   * (deterministic seed per chunk); the tier InstancedMeshes become global
   * pools sized perSpeciesCap × MAX_RESIDENT_CHUNKS so draw calls stay flat.
   * ChunkedScatter drives loadChunk/unloadChunk; update() keeps working.
   */
  chunked?: {
    grid: ChunkGrid;
    treeCountFor: (chunkAreaM2: number) => number;
    /**
     * Graphics wave 2 (E): tier density multiplier. Scales the tier-pool
     * capacities AND the per-chunk species cap so pools stay flat-count
     * while holding more trees. 1.0 = the pre-tier path exactly.
     */
    densityMul?: number;
  };
}

interface VInstance { x: number; y: number; z: number; rot: number; scale: number; sp: SpeciesId; hero?: boolean }

const LOD_DIST = [55, 130]; // high < 55m, medium < 130m, else low

/** Build a weighted species list from a custom flora mix (weights 0..10). */
export function speciesFromMix(mix: Partial<Record<SpeciesId, number>>): SpeciesId[] {
  const out: SpeciesId[] = [];
  for (const [sp, w] of Object.entries(mix) as [SpeciesId, number][]) {
    for (let i = 0; i < Math.max(0, Math.round(w)); i++) out.push(sp);
  }
  return out;
}

const WHITE = new THREE.Color(1, 1, 1);

export class Vegetation {
  private tiers: { mesh: THREE.InstancedMesh; sp: SpeciesId; lod: 0 | 1 | 2; foliage: boolean }[] = [];
  private instances: VInstance[] = [];
  private time = 0;
  private rebucketTimer = 0;
  private windUniforms: { uTime: { value: number }; uWind: { value: number } } = { uTime: { value: 0 }, uWind: { value: 1 } };
  private windMats: THREE.Material[] = [];
  private heroTint = new Map<SpeciesId, THREE.Color>();

  /** chunked-mode per-chunk data (streaming) */
  private chunkData = new Map<string, { instances: VInstance[]; bodies: CANNON.Body[]; colliders: { x: number; z: number; r: number }[] }>();
  private chunkedOpts?: { grid: ChunkGrid; treeCountFor: (chunkAreaM2: number) => number; densityMul?: number };
  private grid!: ChunkGrid;
  private worldSeed = 0;
  private worldHalf = 0;
  private species: SpeciesId[] = [];
  private heroSpots: HeroSpot[] = [];
  private placer?: {
    spec: GameSpec; terrain: Terrain; physics?: Physics; maxSlope: number;
    excluded: (x: number, z: number, r: number) => boolean;
  };
  private lastCam = new THREE.Vector3();
  /** max physics bodies per chunk in chunked mode (legacy: first 80 trees world-wide) */
  private static readonly CHUNK_BODY_CAP = 8;

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, scene: THREE.Scene, opts: VegetationOptions) {
    const mix = spec.custom?.biome?.floraMix;
    // Workstream C: explicit floraMix wins; otherwise the resolved biome's
    // authored species mix; otherwise the legacy per-environment table.
    const biome = resolveBiomeDef(spec);
    const override = mix ? speciesFromMix(mix) : [];
    const biomeMix = speciesFromMix(biome.flora);
    const eff = effectiveScatter(spec, biome);
    const species = (override.length > 0 ? override
      : biomeMix.length > 0 ? biomeMix
      : speciesFor(spec.theme.environment)).filter((s) => {
      // crystalflora doubles as crystal scatter; respect the effective toggle
      if (s === 'crystalflora') return eff.crystals;
      return true;
    });
    const excluded = (x: number, z: number, r = 0) =>
      (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
    const maxSlope = opts.maxSlope ?? 0.45;
    const half = terrain.size / 2 - 8;

    // wind strength from weather; the tier scales its intensity
    // (graphics wave 2 E: s25 gets a gentler sway, desktop the full authored one)
    const wind = spec.theme.weather === 'storm' ? 2.2 : spec.theme.weather === 'rain' ? 1.3 : spec.theme.weather === 'snow' ? 1.1 : 0.8;
    this.windUniforms.uWind.value = wind * 0.12 * (opts.windMul ?? 1);

    this.species = species;
    this.worldSeed = spec.meta.seed;
    this.worldHalf = half;
    this.heroSpots = opts.heroSpots ?? [];
    this.placer = { spec, terrain, physics: opts.physics, maxSlope, excluded };

    if (opts.chunked) {
      // ---- chunked streaming mode: global tier pools, no initial placement.
      // Pool capacity per (species, lod, trunk/foliage) mesh is hard-bounded:
      // per-species per-chunk cap (+ hero cap) × max resident chunks.
      // Graphics wave 2 (E integration): the tier scales the cap (budgets ×
      // densityMul), so desktop holds denser forests in the SAME pool count.
      // B's hero specimens ride the same species LOD tiers via instanceColor.
      this.chunkedOpts = opts.chunked;
      this.grid = opts.chunked.grid;
      const dm = opts.chunked.densityMul ?? 1;
      const speciesCap = scaleBudget(TREE_SPECIES_CHUNK_CAP + HERO_CHUNK_CAP, dm);
      const counts = new Map<SpeciesId, number>();
      for (const sp of species) counts.set(sp, speciesCap * MAX_RESIDENT_CHUNKS);
      this.buildTiers(mats, spec, scene, counts);
      for (const t of this.tiers) { t.mesh.count = 0; t.mesh.visible = false; }
      return;
    }

    if (opts.count <= 0) return;
    // ---- legacy whole-world path (byte-identical placement)
    const rng = new Rng(spec.meta.seed ^ 0xbe09);
    const placed = this.generateTrees(rng, { x0: -half, x1: half, z0: -half, z1: half },
      opts.count, species, { maxBodies: 80, speciesCap: Infinity });
    this.instances = placed.instances;
    for (const c of placed.colliders) opts.colliders?.push(c);
    this.legacyBodies = placed.bodies;
    // hero specimens use their own rng stream — regular placement untouched
    for (const c of this.placeHeroesLegacy()) opts.colliders?.push(c);

    // build tiers: per species × lod × (trunk, foliage), exact capacities
    const bySpecies = new Map<SpeciesId, number>();
    for (const inst of this.instances) bySpecies.set(inst.sp, (bySpecies.get(inst.sp) ?? 0) + 1);
    this.buildTiers(mats, spec, scene, bySpecies);
    this.rebucket(new THREE.Vector3(0, 0, 0));
  }

  /** legacy-mode physics bodies (owned for the world's lifetime) */
  private legacyBodies: CANNON.Body[] = [];

  /**
   * Seeded tree placement inside `bounds`. Shared by the legacy whole-world
   * path and per-chunk generation — the rng stream is identical for identical
   * (seed, bounds, count). Bodies are created (not tracked here) and returned
   * so the caller can dispose them on chunk unload.
   */
  private generateTrees(
    rng: Rng, b: PlaceBounds, count: number, species: SpeciesId[],
    opts: { maxBodies: number; speciesCap: number },
  ): { instances: VInstance[]; colliders: { x: number; z: number; r: number }[]; bodies: CANNON.Body[] } {
    const p = this.placer!;
    const instances: VInstance[] = [];
    const colliders: { x: number; z: number; r: number }[] = [];
    const bodies: CANNON.Body[] = [];
    const perSpecies = new Map<SpeciesId, number>();
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = rng.range(b.x0, b.x1), z = rng.range(b.z0, b.z1);
        if (p.excluded(x, z, 0.8)) continue;
        if (p.terrain.slopeAt(x, z) > p.maxSlope) continue;
        const y = p.terrain.heightAt(x, z);
        if (p.spec.world.terrain.water && y < p.spec.world.terrain.waterLevel + 0.5) continue;
        const sp = rng.pick(species);
        const def = SPECIES[sp];
        const scale = rng.range(def.minS, def.maxS);
        const rot = rng.range(0, Math.PI * 2);
        // per-species chunk cap: rng already consumed above, so the stream is
        // unaffected whether or not the cap binds (it only binds in freak cases)
        if ((perSpecies.get(sp) ?? 0) >= opts.speciesCap) break;
        perSpecies.set(sp, (perSpecies.get(sp) ?? 0) + 1);
        instances.push({ x, y, z, rot, scale, sp });
        colliders.push({ x, z, r: def.collideR * scale });
        if (p.physics && bodies.length < opts.maxBodies) {
          bodies.push(p.physics.cylinder(0.4 * scale, 0.45 * scale, 2.4 * scale,
            [x, y + 1.2 * scale, z], { group: GROUP.WORLD }));
        }
        break;
      }
    }
    return { instances, colliders, bodies };
  }

  /** Hero species for this world's biome (undefined when absent from the mix). */
  private heroSpecies(): SpeciesId | undefined {
    const sp = HERO_SPECIES[resolveBiomeDef(this.placer!.spec).id];
    return this.species.includes(sp) ? sp : undefined;
  }

  /**
   * Graphics wave 2 (profiling fix): resolve the species heroes are actually
   * placed as. If the designated hero species has no regular (non-hero)
   * instances in `instances`, heroes fold into the most populous species
   * instead — so they ride an already-drawing tier via instanceColor rather
   * than resurrecting an empty tier (+2 main +2 shadow draws). Deterministic:
   * placement rng is untouched, only the species label changes.
   */
  private effectiveHeroSpecies(instances: VInstance[]): SpeciesId | undefined {
    const heroSp = this.heroSpecies();
    if (!heroSp) return undefined;
    const counts = new Map<SpeciesId, number>();
    for (const inst of instances) {
      if (inst.hero) continue;
      counts.set(inst.sp, (counts.get(inst.sp) ?? 0) + 1);
    }
    if ((counts.get(heroSp) ?? 0) > 0) return heroSp;
    let best: SpeciesId | undefined;
    let bestN = 0;
    for (const [sp, n] of counts) { if (n > bestN) { bestN = n; best = sp; } }
    return best ?? heroSp;
  }

  /**
   * Place one hero specimen on a ring around `spot`. Uses the caller's rng
   * (legacy: world salt; chunked: per-chunk salt) — never the tree stream.
   */
  private tryPlaceHero(
    rng: Rng, spot: HeroSpot, heroSp: SpeciesId,
    into: { instances: VInstance[]; colliders: { x: number; z: number; r: number }[] },
  ): boolean {
    const p = this.placer!;
    const def = SPECIES[heroSp];
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = spot.r + 5 + rng.range(0, 9);
      const x = spot.x + Math.cos(a) * rr, z = spot.z + Math.sin(a) * rr;
      if (Math.abs(x) > this.worldHalf || Math.abs(z) > this.worldHalf) continue;
      if (p.excluded(x, z, 1.2)) continue;
      if (p.terrain.slopeAt(x, z) > p.maxSlope) continue;
      const y = p.terrain.heightAt(x, z);
      if (p.spec.world.terrain.water && y < p.spec.world.terrain.waterLevel + 0.5) continue;
      const scale = rng.range(HERO_MIN_S, HERO_MAX_S);
      into.instances.push({ x, y, z, rot: rng.range(0, Math.PI * 2), scale, sp: heroSp, hero: true });
      into.colliders.push({ x, z, r: def.collideR * scale });
      return true;
    }
    return false;
  }

  /** Legacy path: heroes appended after regular placement (own rng stream).
   *  Returns the hero colliders for the shared Scatter.colliders array. */
  private placeHeroesLegacy(): { x: number; z: number; r: number }[] {
    const colliders: { x: number; z: number; r: number }[] = [];
    if (!this.heroSpots.length) return colliders;
    // Legacy path: keep original heroSpecies (test-pinned byte-identical placement).
    // The effectiveHeroSpecies fold is chunked-mode only.
    const heroSp = this.heroSpecies();
    if (!heroSp) return colliders;
    const rng = new Rng((this.worldSeed ^ 0x4e40) >>> 0);
    const into = { instances: this.instances, colliders };
    for (const s of this.heroSpots) this.tryPlaceHero(rng, s, heroSp, into);
    // NOTE: legacy tiers are built with exact capacities AFTER this runs, so
    // no reserve is needed — heroes are counted in bySpecies like trees.
    return colliders;
  }

  /** Build tier InstancedMeshes; capacities come from the caller's map. */
  private buildTiers(mats: MaterialLibrary, spec: GameSpec, scene: THREE.Scene, capacities: Map<SpeciesId, number>) {
    const biomeId = resolveBiomeDef(spec).id;
    const spIndex = new Map<SpeciesId, number>();
    [...capacities.keys()].forEach((sp, i) => spIndex.set(sp, i));
    for (const [sp, count] of capacities) {
      if (count <= 0) continue;
      const def = SPECIES[sp];
      const trunkMat = mats.standard('wood', sp === 'cactus' ? '#4d7a3d' : '#5a4230', { roughness: 0.95 });
      const folMat = def.foliageMat(mats, spec);
      // crystalflora is rigid crystal — everything else sways (cactus arms included)
      if (sp !== 'crystalflora') this.addWind(folMat);
      for (const lod of [0, 1, 2] as const) {
        // undergrowth rng: seeded per (species, lod) — deterministic, and the
        // tree placement stream is never touched by geometry construction
        const ugRng = new Rng(((spec.meta.seed ^ 0x9e37 ^ ((spIndex.get(sp) ?? 0) * 0x100) ^ lod) >>> 0));
        const ug: UndergrowthCtx = { kinds: undergrowthFor(biomeId, sp), rng: ugRng };
        if (def.trunkH > 0.05) {
          const tg = def.buildTrunk(lod);
          const tm = new THREE.InstancedMesh(tg, trunkMat, count);
          tm.castShadow = true; tm.receiveShadow = true;
          tm.frustumCulled = false;
          scene.add(tm);
          this.tiers.push({ mesh: tm, sp, lod, foliage: false });
        }
        const fg = def.buildFoliage(lod, ug);
        if (fg) {
          const fm = new THREE.InstancedMesh(fg, folMat, count);
          fm.castShadow = true;
          fm.frustumCulled = false;
          scene.add(fm);
          this.tiers.push({ mesh: fm, sp, lod, foliage: true });
        }
      }
    }
  }

  // ---------- chunked streaming API (driven by ChunkedScatter) ----------

  /** Generate + register a chunk's trees (idempotent). */
  loadChunk(cx: number, cz: number): void {
    if (!this.chunkedOpts || this.chunkData.has(chunkKey(cx, cz))) return;
    const rect = chunkWorldRect(cx, cz, this.grid);
    const half = this.worldHalf;
    const b: PlaceBounds = {
      x0: Math.max(rect.x0, -half), x1: Math.min(rect.x1, half),
      z0: Math.max(rect.z0, -half), z1: Math.min(rect.z1, half),
    };
    const area = Math.max(0, b.x1 - b.x0) * Math.max(0, b.z1 - b.z0);
    const count = this.chunkedOpts.treeCountFor(area);
    const rng = new Rng(chunkSeed(this.worldSeed, 0xbe09, cx, cz));
    // Graphics wave 2 (E): the per-chunk species cap scales with the tier so
    // the denser desktop target isn't clipped by the s25 cap. Includes B's
    // hero headroom (HERO_CHUNK_CAP) in the scaled cap.
    const speciesCap = scaleBudget(TREE_SPECIES_CHUNK_CAP + HERO_CHUNK_CAP, this.chunkedOpts.densityMul ?? 1);
    const placed = this.generateTrees(rng, b, count, this.species,
      { maxBodies: Vegetation.CHUNK_BODY_CAP, speciesCap });
    const key = chunkKey(cx, cz);
    this.chunkData.set(key, placed);
    this.addChunkHeroes(cx, cz, rect);
    this.rebuildInstances();
  }

  /** Hero specimens for the landmarks whose spots fall inside this chunk. */
  private addChunkHeroes(cx: number, cz: number, rect: { x0: number; x1: number; z0: number; z1: number }): void {
    if (!this.heroSpots.length) return;
    const data = this.chunkData.get(chunkKey(cx, cz));
    if (!data) return;
    const heroSp = this.effectiveHeroSpecies(data.instances);
    if (!heroSp) return;
    const spots = this.heroSpots.filter((s) => s.x >= rect.x0 && s.x < rect.x1 && s.z >= rect.z0 && s.z < rect.z1);
    if (!spots.length) return;
    const rng = new Rng(chunkSeed(this.worldSeed, 0x4e40, cx, cz));
    let n = 0;
    for (const s of spots) {
      if (n >= HERO_CHUNK_CAP) break;
      if (this.tryPlaceHero(rng, s, heroSp, data)) n++;
    }
  }

  /** Drop a chunk's trees; physics bodies are removed from the world. */
  unloadChunk(cx: number, cz: number): void {
    if (!this.chunkedOpts) return;
    const data = this.chunkData.get(chunkKey(cx, cz));
    if (!data) return;
    const physics = this.placer?.physics;
    if (physics) for (const body of data.bodies) physics.remove(body);
    this.chunkData.delete(chunkKey(cx, cz));
    this.rebuildInstances();
  }

  /** Per-chunk colliders for the shared Scatter.colliders array. */
  chunkColliders(cx: number, cz: number): { x: number; z: number; r: number }[] {
    return this.chunkData.get(chunkKey(cx, cz))?.colliders ?? [];
  }

  /** Per-chunk instances (test hook + determinism verification). */
  chunkInstances(cx: number, cz: number): VInstance[] {
    return this.chunkData.get(chunkKey(cx, cz))?.instances ?? [];
  }

  get loadedChunkCount(): number { return this.chunkData.size; }

  /** total instances across loaded chunks (chunked) or the whole world (legacy) */
  get instanceCount(): number { return this.instances.length; }

  private rebuildInstances() {
    const keys = [...this.chunkData.keys()].sort();
    const all: VInstance[] = [];
    for (const k of keys) all.push(...this.chunkData.get(k)!.instances);
    this.instances = all;
    this.rebucket(this.lastCam);
  }

  /** Remove every chunk + tier mesh (full teardown). */
  disposeAll(scene: THREE.Scene) {
    if (this.chunkedOpts) {
      const physics = this.placer?.physics;
      if (physics) for (const [, data] of this.chunkData) for (const body of data.bodies) physics.remove(body);
      this.chunkData.clear();
      this.instances = [];
    }
    this.dispose(scene);
  }

  /**
   * GPU wind sway: bend foliage by per-vertex weight, phase from instance
   * position (seeded by placement). v2: the weight moved from position.y to
   * the `aSway` attribute so undergrowth (near y=0) can sway visibly while
   * canopy sway stays exactly ∝ height. Zero per-frame CPU — one uTime uniform.
   */
  private addWind(mat: THREE.Material) {
    const u = this.windUniforms;
    // FIX: customProgramCacheKey — without it, three.js could reuse a compiled program
    // from another material that shares the cache key but lacks our injected uniforms.
    mat.customProgramCacheKey = () => 'xandria-wind-v2';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uWind = u.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;\nattribute float aSway;')
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            vec2 iwp = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xz;
            float phase = iwp.x * 0.13 + iwp.y * 0.17;
            float sway = sin(uTime * 1.7 + phase + position.y * 0.35) * uWind * aSway;
            transformed.x += sway;
            transformed.z += sway * 0.6;
          #endif
        `);
    };
    this.windMats.push(mat);
  }

  private tintFor(sp: SpeciesId): THREE.Color {
    let c = this.heroTint.get(sp);
    if (!c) { c = new THREE.Color(HERO_TINT[sp]); this.heroTint.set(sp, c); }
    return c;
  }

  /** Reassign instances to LOD tiers by camera distance (throttled). */
  update(dt: number, cameraPos: THREE.Vector3) {
    this.lastCam.copy(cameraPos);
    this.time += dt;
    this.windUniforms.uTime.value = this.time;
    this.rebucketTimer -= dt;
    if (this.rebucketTimer <= 0) {
      this.rebucketTimer = 0.3;
      this.rebucket(cameraPos);
    }
  }

  private rebucket(cam: THREE.Vector3) {
    const counts = new Map<string, number>();
    const key = (t: { sp: SpeciesId; lod: number; foliage: boolean }) => `${t.sp}:${t.lod}:${t.foliage ? 1 : 0}`;
    const tierByKey = new Map<string, (typeof this.tiers)[number]>();
    for (const t of this.tiers) { tierByKey.set(key(t), t); counts.set(key(t), 0); }

    // Graphics wave 2 (profiling fix): tier-consolidation pass. A (species,
    // lod) tier costs 2 draw calls (trunk+foliage, ×2 with shadows) even for
    // a single instance. Count per (species, lod); species with <4 instances
    // at a lod are redirected to that lod's most populous species. The trees
    // still render — they just ride an already-drawing tier.
    // Chunked mode only: legacy tiers have exact capacities (no headroom for
    // redirected instances); legacy worlds are small and test-pinned.
    const doConsolidate = !!this.chunkedOpts;
    const lodOf = (inst: VInstance): 0 | 1 | 2 => {
      const dx = inst.x - cam.x, dz = inst.z - cam.z;
      const d2 = dx * dx + dz * dz;
      return d2 < LOD_DIST[0] * LOD_DIST[0] ? 0 : d2 < LOD_DIST[1] * LOD_DIST[1] ? 1 : 2;
    };
    const perSpLod = new Map<string, number>(); // `${sp}:${lod}` -> count
    const instLod = new Map<VInstance, 0 | 1 | 2>();
    for (const inst of this.instances) {
      const lod = lodOf(inst);
      instLod.set(inst, lod);
      const k = `${inst.sp}:${lod}`;
      perSpLod.set(k, (perSpLod.get(k) ?? 0) + 1);
    }
    const dominantForLod = new Map<number, SpeciesId>(); // lod -> species
    for (let lod = 0 as 0 | 1 | 2; lod <= 2; lod = (lod + 1) as 0 | 1 | 2) {
      let best: SpeciesId | undefined;
      let bestN = 0;
      for (const [k, n] of perSpLod) {
        const [sp, l] = k.split(':');
        if (Number(l) !== lod) continue;
        if (n > bestN) { bestN = n; best = sp as SpeciesId; }
      }
      if (best) dominantForLod.set(lod, best);
    }
    const redirect = new Map<VInstance, SpeciesId>(); // instance -> effective species
    if (doConsolidate) {
      for (const inst of this.instances) {
        if (inst.hero) continue;
        const lod = instLod.get(inst)!;
        const k = `${inst.sp}:${lod}`;
        if ((perSpLod.get(k) ?? 0) < 4) {
          const dom = dominantForLod.get(lod);
          if (dom && dom !== inst.sp) redirect.set(inst, dom);
        }
      }
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    // only the hero species' foliage tiers can hold tinted instances — other
    // tiers never allocate an instanceColor buffer at all; and when no hero
    // instance exists (the common case) no colors are written anywhere.
    // Profiling fix: heroes may have folded into the dominant species (see
    // effectiveHeroSpecies), so derive the tint tier from the actual hero
    // instances, not the designated species.
    let heroSp: SpeciesId | undefined;
    let anyHero = false;
    for (const inst of this.instances) {
      if (inst.hero) { anyHero = true; heroSp = inst.sp; break; }
    }

    for (const inst of this.instances) {
      const lod = instLod.get(inst)!;
      const effSp = redirect.get(inst) ?? inst.sp;
      q.setFromEuler(eul.set(0, inst.rot, 0));
      scl.setScalar(inst.scale);
      for (const foliage of [false, true]) {
        const t = tierByKey.get(`${effSp}:${lod}:${foliage ? 1 : 0}`);
        if (!t) continue;
        const k = key(t);
        const idx = counts.get(k)!;
        // capacity is exact (legacy) or pool-bounded (chunked) — overflow
        // would silently corrupt the instance buffer, so fail loudly instead
        if (idx >= t.mesh.instanceMatrix.count) {
          throw new Error(`[Vegetation] tier ${k} overflow: capacity ${t.mesh.instanceMatrix.count}`);
        }
        pos.set(inst.x, inst.y, inst.z);
        m4.compose(pos, q, scl);
        t.mesh.setMatrixAt(idx, m4);
        // hero specimens read amber on their foliage tier; every slot is
        // written (white default) so a recycled slot never keeps a stale tint
        if (foliage && anyHero && t.sp === heroSp) {
          t.mesh.setColorAt(idx, inst.hero ? this.tintFor(inst.sp) : WHITE);
        }
        counts.set(k, idx + 1);
      }
    }
    for (const t of this.tiers) {
      const n = counts.get(key(t)) ?? 0;
      t.mesh.count = n;
      // Draw-call diet (graphics follow-up, worker D): tiers holding zero
      // instances draw nothing — hide them so they cost no draw call at all
      // (main or shadow pass). Rebucket runs every 0.3s, so visibility tracks
      // the camera.
      t.mesh.visible = n > 0;
      t.mesh.instanceMatrix.needsUpdate = true;
      if (t.mesh.instanceColor) t.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(scene: THREE.Scene) {
    for (const t of this.tiers) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      // FIX: materials come from the MaterialLibrary cache (shared) — never dispose
      // cache-owned materials here; only the per-tier geometries are uniquely ours.
      t.mesh.dispose();
    }
    this.tiers = [];
    this.instances = [];
  }
}
