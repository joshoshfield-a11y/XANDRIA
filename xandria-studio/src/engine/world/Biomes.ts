/**
 * Biome treatments (workstream C) — the 7 authored biome looks for XANDRIA's
 * graphics full-scale upgrade.
 *
 * Art direction: block/voxel terrain, per-biome ground treatments, AMBER glow
 * as the signature motif (doorways, beam towers, lanterns), cinematic dusk
 * grading. Reference: qa/wave-inventory/ref/env-target-*.png
 * (PLAINS & HILLS / DESERT CANYONS / FOREST / SNOW-MOUNTAIN / VOLCANIC /
 *  COASTLINE / CAVES & UNDERGROUND).
 *
 * Conventions mirror the 12-skin material system (gfx/Skins.ts):
 *   BIOMES: Record<BiomeId, BiomeDef>  ~  BUILT_IN_SKINS
 *   resolveBiomeDef(spec)              ~  resolveSkinDef
 *
 * Selection: world gen resolves one biome per seed/genre/environment via
 * selectBiome() (deterministic — same inputs, same biome). The Studio can
 * force a look with custom.biome.biomeId (validated in spec/schema.ts);
 * the override always wins. resolveBiomeDef() never throws.
 *
 * BOUNDARY with workstream D: D owns the fog/grading SHADER and application
 * code. This file owns biome CONTENT — BiomeDef.fog carries VALUES only
 * (color + absolute FogExp2 density + anti-blowout luminance), which D
 * consumes. Do not apply fog here.
 *
 * Perf (Galaxy S25): every material/texture comes from the MaterialLibrary
 * cache (shared, never disposed by callers); repeated props are InstancedMesh
 * (see Scatter.scatterBiomeProps); no per-frame biome work exists.
 */
import * as THREE from 'three';
import {
  BIOME_IDS,
  type BiomeId, type Environment, type FloraId, type GameSpec, type Genre,
} from '@spec';
import type { TexKind } from '../gfx/Materials';
import type { LandmarkKind } from '../gfx/Landmarks';
import { Rng } from '../core/Rng';

export { BIOME_IDS };
export type { BiomeId };

/** Authored palette for one biome (sRGB hex). Terrain vertex colors blend the
 *  spec palette toward these (BIOME_PALETTE_BLEND); props/landmarks read the
 *  accent. */
export interface BiomePalette {
  ground: string; groundAlt: string; rock: string;
  primary: string; secondary: string; accent: string;
  sky: string; horizon: string; fog: string; water: string;
}

/** Ground material parameters — consumed by MaterialLibrary.biomeGroundDef()
 *  (cached). `emissive` paints glowing crack veins (volcanic emberrock). */
export interface BiomeGroundParams {
  kind: TexKind;
  base: string; alt: string;
  roughness: number;
  emissive?: string;
  emissiveIntensity?: number;
}

/** Water treatment — consumed by Terrain's water plane. */
export interface BiomeWater {
  /** water surface color (volcanic → lava) */
  tint: string;
  opacity: number;
  /** fake sun-glint color (Terrain.setWaterSun can still override per sky) */
  glint: string;
  emissive?: string;
  emissiveIntensity?: number;
}

/**
 * Fog VALUES for workstream D (content, not application).
 * - `color`: FogExp2 color recommendation, already darkened — apply as-is.
 * - `density`: ABSOLUTE FogExp2 density recommendation, calibrated against
 *   Sky.ts's weather bases (clear 0.0035, storm/ash 0.007, fog 0.012,
 *   space-station 0.002). When the biome is explicit these may replace the
 *   weather term outright; otherwise blend.
 * - `luminance`: extra darkening multiplier, always <= 0.9 — the anti-blowout
 *   guard. No biome ships near-white fog at full luminance.
 */
export interface BiomeFog {
  color: string;
  density: number;
  luminance: number;
}

/**
 * Prop-set references. Vegetation species weights (custom.biome.floraMix still
 * wins when set), base-scatter toggles (OR'd with the generator's via
 * effectiveScatter — a biome can ADD prop sets, never remove the generator's),
 * grass density 0..1, and landmark kind counts (pre-quality-scaler, consumed
 * by Structures.landmarks as the `kinds` default).
 */
export interface BiomeScatter {
  trees: boolean; rocks: boolean; crystals: boolean; ruins: boolean;
  /** fraction of full grass density (0 = none) */
  grass: number;
}

export interface BiomeDef {
  id: BiomeId;
  name: string;
  blurb: string;
  palette: BiomePalette;
  ground: BiomeGroundParams;
  water: BiomeWater;
  fog: BiomeFog;
  flora: Partial<Record<FloraId, number>>;
  scatter: BiomeScatter;
  landmarks: Partial<Record<LandmarkKind, number>>;
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
  plains: {
    id: 'plains', name: 'Plains & Hills',
    blurb: 'Rolling green-gold hills, ruin fields, amber lanterns.',
    palette: {
      ground: '#6a7f42', groundAlt: '#7f9450', rock: '#6e6a5e',
      primary: '#4d7a3d', secondary: '#8a6a3a', accent: '#ffb43c',
      sky: '#3a5a8c', horizon: '#e8a06a', fog: '#c9a97e', water: '#2a6fb0',
    },
    ground: { kind: 'ground', base: '#ffffff', alt: '#d8d4c8', roughness: 0.95 },
    water: { tint: '#2a6fb0', opacity: 0.75, glint: '#ffb46b' },
    fog: { color: '#c9a97e', density: 0.0028, luminance: 0.85 },
    flora: { pine: 2, oak: 3 },
    scatter: { trees: false, rocks: true, crystals: false, ruins: false, grass: 0.8 },
    landmarks: { 'beam-tower': 2, 'ruin-arch': 2, bridge: 1 },
  },
  'desert-canyon': {
    id: 'desert-canyon', name: 'Desert Canyons',
    blurb: 'Red cracked earth, sandstone fins, canyon arches.',
    palette: {
      ground: '#b06a3c', groundAlt: '#c98a52', rock: '#8a4a2e',
      primary: '#a8562e', secondary: '#7a3a20', accent: '#ffb43c',
      sky: '#4a5a9c', horizon: '#ff9a5a', fog: '#d69a6a', water: '#3a8fa8',
    },
    ground: { kind: 'cracked', base: '#ffffff', alt: '#d8d0c0', roughness: 0.95 },
    water: { tint: '#3a8fa8', opacity: 0.7, glint: '#ffcf8a' },
    fog: { color: '#d69a6a', density: 0.0025, luminance: 0.8 },
    flora: { cactus: 4, deadtree: 2 },
    scatter: { trees: true, rocks: true, crystals: false, ruins: true, grass: 0.25 },
    landmarks: { 'beam-tower': 1, 'ruin-arch': 5, bridge: 2 },
  },
  forest: {
    id: 'forest', name: 'Forest',
    blurb: 'Deep green canopy, fallen logs, amber glowcaps.',
    palette: {
      ground: '#3d5a2e', groundAlt: '#4d6e38', rock: '#5e5a4e',
      primary: '#2e5a2e', secondary: '#6a4a2e', accent: '#ffb43c',
      sky: '#2e4a7c', horizon: '#d88a5a', fog: '#9aa87e', water: '#2a5f8a',
    },
    ground: { kind: 'ground', base: '#ffffff', alt: '#d0d4c4', roughness: 0.95 },
    water: { tint: '#2a5f8a', opacity: 0.75, glint: '#ffb46b' },
    fog: { color: '#9aa87e', density: 0.0035, luminance: 0.85 },
    flora: { pine: 4, oak: 3 },
    scatter: { trees: true, rocks: true, crystals: false, ruins: false, grass: 1 },
    landmarks: { 'beam-tower': 1, 'ruin-arch': 2, bridge: 1 },
  },
  snow: {
    id: 'snow', name: 'Snow & Mountain',
    blurb: 'Glittering snowfields, ice shards, amber lamps in the white.',
    palette: {
      ground: '#dfe6ee', groundAlt: '#c9d4e2', rock: '#7a8290',
      primary: '#dfe9f0', secondary: '#9aa8bc', accent: '#ffb43c',
      sky: '#4a6a9c', horizon: '#e8c09a', fog: '#c9d4e6', water: '#3a7fb0',
    },
    ground: { kind: 'snowdrift', base: '#ffffff', alt: '#e2e8f0', roughness: 0.7 },
    water: { tint: '#3a7fb0', opacity: 0.8, glint: '#cfe8ff' },
    // pale fog, but luminance 0.78 keeps it off pure white (anti-blowout)
    fog: { color: '#c9d4e6', density: 0.003, luminance: 0.78 },
    flora: { pine: 4 },
    scatter: { trees: true, rocks: true, crystals: false, ruins: false, grass: 0.2 },
    landmarks: { 'beam-tower': 3, 'ruin-arch': 1, bridge: 1 },
  },
  volcanic: {
    id: 'volcanic', name: 'Volcanic',
    blurb: 'Ember-cracked basalt, lava water, basalt columns.',
    palette: {
      ground: '#2e2a26', groundAlt: '#3d3430', rock: '#1e1c1a',
      primary: '#4a3530', secondary: '#2e1e1a', accent: '#ff7a2e',
      sky: '#2a2030', horizon: '#ff6a3a', fog: '#5a3a30', water: '#ff5a1f',
    },
    ground: {
      kind: 'emberrock', base: '#ffffff', alt: '#c8bcb0', roughness: 0.95,
      emissive: '#ff5a1a', emissiveIntensity: 1.1,
    },
    water: {
      tint: '#ff5a1f', opacity: 0.85, glint: '#ffcf7a',
      emissive: '#ff3300', emissiveIntensity: 0.8,
    },
    fog: { color: '#5a3a30', density: 0.0045, luminance: 0.75 },
    flora: { deadtree: 3, crystalflora: 2 },
    scatter: { trees: false, rocks: true, crystals: true, ruins: false, grass: 0 },
    landmarks: { 'beam-tower': 4, 'ruin-arch': 1, bridge: 0 },
  },
  coastline: {
    id: 'coastline', name: 'Coastline',
    blurb: 'Wet sand, teal shallows, palms, pier pilings.',
    palette: {
      ground: '#c9a86a', groundAlt: '#d8bc7e', rock: '#8a7a62',
      primary: '#3f8f4f', secondary: '#2e6a7a', accent: '#ffb43c',
      sky: '#3a6a9c', horizon: '#e8b06a', fog: '#bcd4d8', water: '#2a9fb0',
    },
    ground: { kind: 'wetsand', base: '#ffffff', alt: '#dcd2bc', roughness: 0.85 },
    water: { tint: '#2a9fb0', opacity: 0.7, glint: '#ffe0a0' },
    fog: { color: '#bcd4d8', density: 0.0028, luminance: 0.85 },
    flora: { palm: 4, oak: 1 },
    scatter: { trees: true, rocks: true, crystals: false, ruins: false, grass: 0.9 },
    landmarks: { 'beam-tower': 1, 'ruin-arch': 1, bridge: 3 },
  },
  caves: {
    id: 'caves', name: 'Caves & Underground',
    blurb: 'Dark basalt, teal glow crystals, stalagmites, mushroom groves.',
    palette: {
      ground: '#2a3438', groundAlt: '#344048', rock: '#1e2428',
      primary: '#3a5a6a', secondary: '#2a4a5a', accent: '#59d8ff',
      sky: '#101820', horizon: '#2a4a5a', fog: '#1e3a44', water: '#1e5a6a',
    },
    ground: { kind: 'rock', base: '#ffffff', alt: '#b8c0c4', roughness: 1.0 },
    water: { tint: '#1e5a6a', opacity: 0.8, glint: '#7adfff' },
    // dense and dark — caves are enclosed; luminance 0.7, nowhere near white
    fog: { color: '#1e3a44', density: 0.006, luminance: 0.7 },
    flora: { mushroom: 4, crystalflora: 3 },
    scatter: { trees: false, rocks: true, crystals: true, ruins: true, grass: 0 },
    landmarks: { 'beam-tower': 1, 'ruin-arch': 4, bridge: 1 },
  },
};

/** Environment → default biome (several environments share a biome). */
export const BIOME_FOR_ENVIRONMENT: Record<Environment, BiomeId> = {
  forest: 'forest',
  jungle: 'forest',
  desert: 'desert-canyon',
  wasteland: 'desert-canyon',
  arctic: 'snow',
  volcanic: 'volcanic',
  city: 'plains',
  'neon-city': 'plains',
  'space-station': 'caves',
  ruins: 'plains',
  dreamscape: 'forest',
  islands: 'coastline',
  arena: 'plains',
};

/**
 * Genres whose worlds vary the biome per seed (exploration/combat games get
 * variety; racing/fps-arena keep the environment's canonical look for
 * readability and track consistency).
 */
const GENRE_ALTERNATES: Partial<Record<Genre, BiomeId[]>> = {
  'third-person-action': ['plains', 'forest', 'desert-canyon', 'snow', 'coastline', 'caves'],
  'top-down-shooter': ['plains', 'desert-canyon', 'volcanic', 'caves'],
  'platformer': ['plains', 'forest', 'coastline'],
};

/** Only these base biomes ever roll an alternate — volcanic/snow/coastline/
 *  caves stay canonical so e.g. a volcanic world never silently becomes a
 *  meadow (its lava water and ember ground are load-bearing for the look). */
const VARIABLE_BASES: BiomeId[] = ['plains', 'forest', 'desert-canyon'];

/**
 * Deterministic biome selection per seed/genre/environment. Same inputs →
 * same biome, every session. ~45% of eligible (genre, base) combos roll a
 * seeded alternate for variety; everything else follows the environment map.
 */
export function selectBiome(seed: number, genre: Genre, environment: Environment): BiomeId {
  const base = BIOME_FOR_ENVIRONMENT[environment] ?? 'plains';
  const alts = GENRE_ALTERNATES[genre];
  if (!alts || !VARIABLE_BASES.includes(base)) return base;
  const rng = new Rng(((seed >>> 0) ^ 0xb10e5) >>> 0);
  return rng.chance(0.45) ? rng.pick(alts) : base;
}

/**
 * Resolve the biome for a spec: the Studio override (custom.biome.biomeId)
 * wins; otherwise the seeded per-seed/genre selection. Never throws —
 * garbage in falls back to the automatic pick, then to plains.
 */
export function resolveBiomeDef(spec: GameSpec): BiomeDef {
  try {
    const override = spec.custom?.biome?.biomeId;
    if (typeof override === 'string' && (BIOME_IDS as readonly string[]).includes(override)) {
      return BIOMES[override as BiomeId];
    }
    return BIOMES[selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment)];
  } catch {
    return BIOMES.plains;
  }
}

/** All biome ids the engine honors (Studio override dropdown source). */
export function availableBiomeIds(): BiomeId[] {
  return [...BIOME_IDS];
}

/**
 * Effective base-scatter toggles: the generator's gameplay-aware choices OR'd
 * with the biome's prop sets. A biome can ADD sets (desert cacti, arctic
 * pines, cave crystals) but never removes what the generator placed.
 */
export interface EffectiveScatter {
  trees: boolean; rocks: boolean; crystals: boolean; ruins: boolean;
}

export function effectiveScatter(spec: GameSpec, biome: BiomeDef): EffectiveScatter {
  const sc = spec.world.scatter;
  return {
    trees: sc.trees || biome.scatter.trees,
    rocks: sc.rocks || biome.scatter.rocks,
    crystals: sc.crystals || biome.scatter.crystals,
    ruins: sc.ruins || biome.scatter.ruins,
  };
}

/**
 * How far terrain vertex colors shift from the spec palette toward the
 * biome's authored palette. 0 = spec palette untouched, 1 = full biome
 * palette. 0.55 keeps Studio/generator palette edits visibly in control
 * while guaranteeing each biome reads distinctly.
 */
export const BIOME_PALETTE_BLEND = 0.55;

/**
 * Blend one palette hex toward the biome's authored hex for terrain vertex
 * colors. Lerp happens in three's linear working space; convertLinearToSRGB()
 * recovers the raw sRGB components the vertex-color path consumes (same
 * rationale as Terrain's existing comment — the shader eats them raw).
 * Never throws: garbage in → mid gray.
 */
export function biomeTint(specHex: string, biomeHex: string, blend = BIOME_PALETTE_BLEND): THREE.Color {
  try {
    return new THREE.Color(specHex)
      .lerp(new THREE.Color(biomeHex), THREE.MathUtils.clamp(blend, 0, 1))
      .convertLinearToSRGB();
  } catch {
    return new THREE.Color('#808080');
  }
}
