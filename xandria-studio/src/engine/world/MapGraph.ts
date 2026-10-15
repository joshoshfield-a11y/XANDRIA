/**
 * Open-world portals, workstream C: the map graph.
 *
 * The world is an infinite grid of maps. A map is identified by integer
 * coordinates (mx, my); the game starts at ORIGIN (0,0). Crossing the north
 * edge of (mx,my) arrives at the south edge of (mx,my+1), and so on.
 *
 * Every map derives its build seed deterministically from the world seed:
 * mapSeed = deriveMapSeed(worldSeed, mx, my). The same (worldSeed, mx, my)
 * regenerates the identical map, so back-and-forth travel is just a rebuild
 * (or an LRU hit — workstream D).
 *
 * FROZEN CONTRACT (wave brief): workers B and D import these names. Keep
 * them exactly — do not rename, re-signature, or move this module.
 */

/** Integer map-grid coordinate. */
export interface MapCoord { mx: number; my: number }

/**
 * Map edge identifier. Added at wave-merge time (workstream B's PortalTrigger/
 * PortalManager alias it as PortalEdge); the four edge literals match the
 * frozen contract's neighborOf/oppositeEdge signatures.
 */
export type MapEdge = 'N' | 'S' | 'E' | 'W';

/**
 * Derive a map's build seed from (worldSeed, mx, my).
 *
 * Algorithm (documented, bit-exact across JS engines):
 *   1. Mix worldSeed with the golden-ratio constant (separates nearby seeds).
 *   2. Fold mx, then my, each with Math.imul against murmur3's fmix32
 *      constants (0x85ebca6b, 0xc2b2ae35) — xor the coordinate in, multiply.
 *   3. fmix32 finalizer: xor-shift → multiply → xor-shift → multiply →
 *      xor-shift. Any single input bit flips ~50% of output bits (avalanche),
 *      so adjacent maps (and adjacent world seeds) get uncorrelated build
 *      seeds; there is no visible tiling across the grid.
 *
 * Inputs are coerced to int32 (`| 0`); the result is a uint32 (`>>> 0`), safe
 * to feed straight into Rng/Noise2D. Negative coordinates work (grid is
 * infinite in all four directions).
 */
export function deriveMapSeed(worldSeed: number, mx: number, my: number): number {
  let h = (worldSeed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (mx | 0), 0x85ebca6b);
  h = Math.imul(h ^ (my | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The map on the other side of an edge. N=(mx,my+1), S=(mx,my-1),
 * E=(mx+1,my), W=(mx-1,my) — crossing the north edge of c enters the south
 * edge of neighborOf(c, 'N').
 */
export function neighborOf(c: MapCoord, edge: 'N' | 'S' | 'E' | 'W'): MapCoord {
  switch (edge) {
    case 'N': return { mx: c.mx, my: c.my + 1 };
    case 'S': return { mx: c.mx, my: c.my - 1 };
    case 'E': return { mx: c.mx + 1, my: c.my };
    case 'W': return { mx: c.mx - 1, my: c.my };
  }
}

/** The edge you arrive at: cross N, arrive at the S edge of the neighbor. */
export function oppositeEdge(e: 'N' | 'S' | 'E' | 'W'): 'N' | 'S' | 'E' | 'W' {
  switch (e) {
    case 'N': return 'S';
    case 'S': return 'N';
    case 'E': return 'W';
    case 'W': return 'E';
  }
}

/** The map every portal session starts on. */
export const ORIGIN: MapCoord = { mx: 0, my: 0 };

/**
 * Stamp the origin map's identity onto a spec BEFORE its terrain builds.
 * Merge integration (workstreams B/C/D): C's session contract requires the
 * origin map to use deriveMapSeed(worldSeed, 0, 0) like every other map, so
 * the boot build and the return trip land on the same map. `worldSeed` is the
 * spec's original seed (the run's world seed); afterwards
 * spec.meta.seed is the ORIGIN map's build seed and spec.custom.portalMap
 * carries {mx:0, my:0, worldSeed} so the per-map biome stays a pure function
 * of (worldSeed, mx, my). Unconditional: callers that must preserve an
 * existing portalMap (boot with a pre-stamped spec) check absence first.
 */
export function stampOriginMap(spec: { meta: { seed: number }; custom?: { portalMap?: { mx: number; my: number; worldSeed: number } } }, worldSeed: number): void {
  spec.custom = spec.custom ?? {};
  spec.custom.portalMap = { mx: 0, my: 0, worldSeed };
  spec.meta.seed = deriveMapSeed(worldSeed, 0, 0);
}
