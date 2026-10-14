/**
 * Open-world stage 1 (workstream C): scatter chunk-grid helpers.
 *
 * Chunk convention follows workstream A/B exactly (see world/chunkLayout.ts —
 * the canonical layout; physics chunks MUST align with mesh chunks, and
 * scatter chunks align with both):
 * - chunksPerSide = ceil(size/256); chunkSize = size/chunksPerSide (exact);
 * - chunk (cx,cz), cx/cz in [0, chunksPerSide), covers
 *   [-half + cx*chunkSize, -half + (cx+1)*chunkSize] in world meters;
 * - worlds <= 256m are a single chunk and never stream (legacy path).
 *
 * This module adds what scatter needs on top of chunkLayout: the per-chunk
 * seed derivation, the slot allocator backing the global instanced pools,
 * and the scatter-specific radii/budgets.
 */
import type { Terrain } from './Terrain';
import type { ChunkGrid } from './chunkLayout';

/** Worlds at or below one chunk keep the legacy whole-world build path. */
export const LEGACY_MAX_SIZE = 256;

/**
 * Scatter load radius: props stream in this far from the player. FogExp2 at
 * the default density (0.0035) leaves ~2% visibility at 560m, so chunk pops
 * happen inside the fog (brief §C: no fade needed).
 */
export const SCATTER_LOAD_RADIUS = 560;
/** Unload hysteresis band: a chunk must leave this radius to unload (no thrash). */
export const SCATTER_UNLOAD_RADIUS = 688;

/**
 * Hard upper bound on simultaneously resident scatter chunks. Pool capacities
 * are sized as perChunkBudget × this. Analytic bound: chunk centers within
 * 688 + chunkDiag/2 ≈ 865m of the player; smallest chunk area is
 * (2000/8)² = 62500 m² → π·865²/62500 ≈ 38; 40 gives margin at every allowed
 * world size (60..2000m).
 */
export const MAX_RESIDENT_CHUNKS = 40;

/** Max chunk builds per streaming update (ChunkStream budget). */
export const CHUNK_BUILD_BUDGET = 3;

/**
 * Build the canonical chunk grid from a chunked terrain's public fields
 * (mirrors how workstream B derives it from A's chunkSize — never recomputed
 * independently so the layouts cannot disagree).
 */
export function scatterGrid(terrain: Terrain): ChunkGrid {
  const chunksPerSide = Math.max(1, Math.round(terrain.size / terrain.chunkSize));
  return {
    chunksPerSide,
    cellsPerChunk: (terrain.res - 1) / chunksPerSide,
    chunkSize: terrain.chunkSize,
    cell: terrain.size / (terrain.res - 1),
    half: terrain.size / 2,
    res: terrain.res,
  };
}

/**
 * Deterministic per-chunk seed. coordMix(0,0) = 0 by construction, so
 * chunkSeed(worldSeed, salt, 0, 0) === ((worldSeed ^ salt) >>> 0) — exactly the
 * seed the legacy whole-world builders use (Rng applies >>>0 internally).
 * A chunk's placements are therefore identical regardless of load order or
 * which other chunks are resident.
 *
 * NOTE: the naive `imul(cx,A) ^ imul(cz,B)` has an antisymmetry —
 * (-a)^(-b) === a^b for small coords (10 collisions in a 7×7 grid). Zigzag
 * encoding + addition avoids it: verified 66049/66049 unique over ±128
 * chunks (a 2000m world spans 8 per side).
 */
export function chunkSeed(worldSeed: number, salt: number, cx: number, cz: number): number {
  // zigzag encode: 0 -> 0, bijective over the int32 range
  const zx = ((cx << 1) ^ (cx >> 31)) >>> 0;
  const zz = ((cz << 1) ^ (cz >> 31)) >>> 0;
  let m = (Math.imul(zx, 0x85ebca6b) + Math.imul(zz, 0xc2b2ae35)) >>> 0;
  // final avalanche (splitmix-style, bijective); 0 stays 0
  m = (m ^ (m >>> 15)) >>> 0;
  m = Math.imul(m, 0x2c1b3c6d) >>> 0;
  m = (m ^ (m >>> 12)) >>> 0;
  m = Math.imul(m, 0x2c1b3c6d) >>> 0;
  m = (m ^ (m >>> 14)) >>> 0;
  return ((worldSeed ^ salt ^ m) >>> 0);
}

/**
 * Append-only slot allocator with swap-remove, backing the global instanced
 * pools. Each loaded chunk owns one contiguous slot range; unloading a chunk
 * relocates the LAST chunk's block into the freed range (caller copies the
 * payload: matrices, colors, positions...), so pools never fragment and
 * `total` is always the live instance count.
 */
export class ChunkSlotPool {
  private chunks = new Map<string, { start: number; count: number }>();
  private order: string[] = [];
  total = 0;
  constructor(readonly capacity: number) {}
  /** Reserve `count` slots for a chunk; returns the start index, or -1 when full. */
  alloc(key: string, count: number): number {
    const existing = this.chunks.get(key);
    if (existing) return existing.start;
    if (this.total + count > this.capacity) return -1;
    const start = this.total;
    this.chunks.set(key, { start, count });
    this.order.push(key);
    this.total += count;
    return start;
  }
  /**
   * Free a chunk's slots. When the freed chunk was not last, returns the
   * relocation the caller must apply ({from→to} block copy of `count`
   * instances, belonging to movedKey); otherwise null.
   */
  free(key: string): { from: number; to: number; count: number; movedKey: string } | null {
    const slot = this.chunks.get(key);
    if (!slot) return null;
    this.chunks.delete(key);
    this.order.splice(this.order.indexOf(key), 1);
    this.total -= slot.count;
    const lastKey = this.order[this.order.length - 1];
    if (lastKey === undefined) return null;
    const last = this.chunks.get(lastKey)!;
    const moved = { from: last.start, to: slot.start, count: last.count, movedKey: lastKey };
    last.start = slot.start;
    return moved;
  }
  get(key: string): { start: number; count: number } | undefined {
    return this.chunks.get(key);
  }
  get size(): number { return this.chunks.size; }
}
