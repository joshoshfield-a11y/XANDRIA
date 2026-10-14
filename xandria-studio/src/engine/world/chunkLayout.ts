/**
 * Stage-1 (open world) workstream B: chunk grid math for terrain streaming.
 *
 * Pure functions only — no THREE, no cannon — so layout and hysteresis logic
 * unit-test without a renderer or physics world.
 *
 * Chunk convention (worker A's canonical layout, shared with the chunked
 * meshes — physics chunks MUST align with mesh chunks or visuals and
 * collision disagree):
 * - The world tiles into chunksPerSide = ceil(size/256) chunks per side;
 *   chunkSize = size/chunksPerSide (exact — no partial chunks).
 * - Chunk (cx,cz) owns global height-sample indices
 *   i ∈ [cx*cellsPerChunk, (cx+1)*cellsPerChunk] (same for j) on the shared
 *   world-space height grid. Adjacent chunks share edge samples EXACTLY —
 *   1-cell overlap is the same as shared edges here — which is what makes
 *   seams tunnel-proof.
 * - Small worlds (<=256m) are a single chunk on the legacy grid and behave
 *   exactly as the old single-body terrain.
 */

export interface ChunkGrid {
  /** chunks per side (A: ceil(size/256)) */
  chunksPerSide: number;
  /** height cells per chunk side (A: legacy res-1, or ~2.5m cells) */
  cellsPerChunk: number;
  /** world meters per chunk side (size / chunksPerSide, exact) */
  chunkSize: number;
  /** world meters per height cell */
  cell: number;
  /** size / 2 */
  half: number;
  /** height samples per side */
  res: number;
}

export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

/** Chunk containing world point (x,z), clamped to the grid. */
export function worldToChunk(x: number, z: number, grid: ChunkGrid): { cx: number; cz: number } {
  const cps = grid.chunksPerSide;
  const cx = Math.min(cps - 1, Math.max(0, Math.floor((x + grid.half) / grid.chunkSize)));
  const cz = Math.min(cps - 1, Math.max(0, Math.floor((z + grid.half) / grid.chunkSize)));
  return { cx, cz };
}

/**
 * Global height-sample index range covered by chunk (cx,cz), INCLUSIVE on
 * both ends. Adjacent chunks share the edge row/column exactly.
 */
export function chunkCellRange(cx: number, cz: number, grid: ChunkGrid): { i0: number; i1: number; j0: number; j1: number } {
  const n = grid.cellsPerChunk;
  return {
    i0: cx * n,
    i1: Math.min(cx * n + n, grid.res - 1),
    j0: cz * n,
    j1: Math.min(cz * n + n, grid.res - 1),
  };
}

/** World-space rect covered by chunk (cx,cz). */
export function chunkWorldRect(cx: number, cz: number, grid: ChunkGrid): { x0: number; x1: number; z0: number; z1: number } {
  const r = chunkCellRange(cx, cz, grid);
  return {
    x0: -grid.half + r.i0 * grid.cell,
    x1: -grid.half + r.i1 * grid.cell,
    z0: -grid.half + r.j0 * grid.cell,
    z1: -grid.half + r.j1 * grid.cell,
  };
}

/** Distance from (x,z) to the chunk rect; 0 when the point is inside. */
export function chunkRectDistance(cx: number, cz: number, x: number, z: number, grid: ChunkGrid): number {
  const r = chunkWorldRect(cx, cz, grid);
  const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
  const dz = z < r.z0 ? r.z0 - z : z > r.z1 ? z - r.z1 : 0;
  return Math.hypot(dx, dz);
}

export type ChunkVerdict = 'load' | 'unload' | 'none';

/**
 * Hysteresis decision for one chunk (pure — unit-testable):
 * - inside loadRadius and not loaded → 'load'
 * - beyond unloadRadius and loaded → 'unload'
 * - the band between the radii → 'none' (this is what kills thrash: a chunk
 *   loaded near the player stays loaded until it is WELL past loadRadius)
 */
export function classifyChunk(dist: number, loaded: boolean, loadRadius: number, unloadRadius: number): ChunkVerdict {
  if (!loaded && dist <= loadRadius) return 'load';
  if (loaded && dist >= unloadRadius) return 'unload';
  return 'none';
}

export interface PlannedLoad { cx: number; cz: number; dist: number }
export interface PlannedUnload { cx: number; cz: number }

/**
 * Full per-frame streaming plan (pure — unit-testable): scan every chunk,
 * classify by hysteresis, return loads nearest-first and unloads.
 */
export function planChunkChanges(
  px: number, pz: number,
  grid: ChunkGrid,
  isLoaded: (cx: number, cz: number) => boolean,
  loadRadius: number, unloadRadius: number,
): { toLoad: PlannedLoad[]; toUnload: PlannedUnload[] } {
  const toLoad: PlannedLoad[] = [];
  const toUnload: PlannedUnload[] = [];
  for (let cx = 0; cx < grid.chunksPerSide; cx++) {
    for (let cz = 0; cz < grid.chunksPerSide; cz++) {
      const dist = chunkRectDistance(cx, cz, px, pz, grid);
      const v = classifyChunk(dist, isLoaded(cx, cz), loadRadius, unloadRadius);
      if (v === 'load') toLoad.push({ cx, cz, dist });
      else if (v === 'unload') toUnload.push({ cx, cz });
    }
  }
  toLoad.sort((a, b) => a.dist - b.dist);
  return { toLoad, toUnload };
}
