/**
 * UPGRADE LOOP (world-atlas phase): the world atlas data model.
 *
 * Pure, observe-only: the atlas never writes gameplay state. It reads
 * three existing discovery sources and presents them as one list:
 *
 *  - the fast-travel registry (FastTravelRegistry.list()): every map the
 *    player has ARRIVED on, with discovery-time biome/tier labels. A map
 *    with no registry entry is undiscovered and NEVER appears here — the
 *    model is built only from list(), so no spoiler can leak through it.
 *  - the minimap fog grids (Minimap.coverageFor): fog-reveal percentage
 *    per map. Fog is session-only state (Minimap.resetRun() clears it),
 *    so a map not yet walked this session reads 0% — that is the honest
 *    session value, not a gameplay fact; the panel labels it as such.
 *  - the camp profile (ProfileData.campBuilt, keyed by map seed): which
 *    camp structures are built on each map. The key is
 *    deriveMapSeed(worldSeed, mx, my) — the same seed CampManager's
 *    spawnForMap receives, so the lookup agrees with the live manager
 *    by construction.
 *
 * The map graph is unbounded (no total map count exists), so the only
 * honest "undiscovered" number is the count of uncharted 4-neighbors of
 * discovered maps: a count, with no coordinates, biomes, or tiers
 * attached. Undiscovered maps stay hidden beyond that count.
 *
 * Determinism: everything here is a pure function of existing seeded
 * state. No Math.random / Date.now anywhere in this module.
 */
import { BIOMES, type BiomeId } from './Biomes';
import type { DiscoveredPortal } from './FastTravel';
import type { MapCoord } from './MapGraph';

/** One atlas row: a discovered map, enriched with fog + camp state. */
export interface AtlasEntry {
  mx: number;
  my: number;
  biome: BiomeId;
  /** display name for the biome (BIOMES table, id fallback) */
  biomeName: string;
  tier: number;
  /** discovery order (0 = origin); stable across reloads */
  order: number;
  /** fog-reveal fraction for this map, clamped to [0, 1] */
  fogCoverage: number;
  /** fogCoverage rounded to an integer percent, 0..100 */
  fogPercent: number;
  /** camp structure ids built on this map (persisted per map seed) */
  campStructures: readonly string[];
  /** true when this is the map the player is currently on */
  isCurrent: boolean;
}

/** The read-only discovery sources the atlas observes. */
export interface AtlasSource {
  /** discovered maps, in discovery order (FastTravelRegistry.list()) */
  discovered: () => DiscoveredPortal[];
  /** the map the player is currently on */
  current: () => MapCoord;
  /** session fog-reveal fraction for a map, 0 when never walked */
  fogCoverage: (coord: MapCoord) => number;
  /** persisted built camp structures for a map */
  campStructures: (coord: MapCoord) => readonly string[];
}

export interface AtlasModel {
  entries: AtlasEntry[];
  current: MapCoord;
  /** number of discovered maps (== registry size) */
  discoveredCount: number;
  /** uncharted 4-neighbors of discovered maps (count only, no spoilers) */
  unchartedCount: number;
}

/** Clamp a fog fraction to [0, 1]; non-finite input reads as 0. */
export function clampFogCoverage(coverage: number): number {
  if (!Number.isFinite(coverage)) return 0;
  return Math.min(1, Math.max(0, coverage));
}

/** Rounded integer fog percent for display (0..100). */
export function fogPercentOf(coverage: number): number {
  return Math.round(clampFogCoverage(coverage) * 100);
}

/**
 * Count the distinct 4-neighbor coords of `discovered` that are not
 * themselves discovered. The map graph is unbounded, so this neighbor
 * count is the only spoiler-free "still uncharted" number that exists.
 */
export function unchartedNeighborCount(discovered: readonly MapCoord[]): number {
  const known = new Set(discovered.map((c) => `${c.mx},${c.my}`));
  const uncharted = new Set<string>();
  for (const c of discovered) {
    for (const [mx, my] of [
      [c.mx + 1, c.my],
      [c.mx - 1, c.my],
      [c.mx, c.my + 1],
      [c.mx, c.my - 1],
    ] as const) {
      const key = `${mx},${my}`;
      if (!known.has(key)) uncharted.add(key);
    }
  }
  return uncharted.size;
}

/**
 * Build the atlas model from the live discovery sources. Reads are
 * taken fresh on every call (the panel calls this on every open), so a
 * discovery made while the panel is closed shows up on the next open.
 * Undiscovered maps cannot appear: entries come only from discovered().
 */
export function buildAtlasModel(source: AtlasSource): AtlasModel {
  const discovered = source.discovered();
  const current = source.current();
  const entries: AtlasEntry[] = discovered.map((p) => {
    const fogCoverage = clampFogCoverage(source.fogCoverage({ mx: p.mx, my: p.my }));
    const campStructures = [...source.campStructures({ mx: p.mx, my: p.my })];
    return {
      mx: p.mx,
      my: p.my,
      biome: p.biome,
      biomeName: BIOMES[p.biome]?.name ?? p.biome,
      tier: p.tier,
      order: p.order,
      fogCoverage,
      fogPercent: Math.round(fogCoverage * 100),
      campStructures,
      isCurrent: p.mx === current.mx && p.my === current.my,
    };
  });
  return {
    entries,
    current: { ...current },
    discoveredCount: entries.length,
    unchartedCount: unchartedNeighborCount(discovered),
  };
}
