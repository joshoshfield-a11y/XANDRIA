/**
 * Stage-1 (open world) workstream B: chunk streaming manager.
 *
 * Pages chunk payloads (physics bodies now; workstream A's chunk meshes hook
 * into the same lifecycle) in/out by distance from the streaming focus, with:
 * - hysteresis (loadRadius < unloadRadius): a chunk loaded near the player is
 *   not released until it is well past loadRadius — no load/unload thrash;
 * - a per-frame build budget (default 2): expensive builds are queued and
 *   drained nearest-first instead of hitching one frame;
 * - teleport handling: when the focus jumps further than unloadRadius in one
 *   update (respawn, resetRun, debug teleport), correctness wins over
 *   smoothness — everything within loadRadius is built synchronously;
 * - single-chunk short-circuit: small worlds keep one resident chunk and the
 *   per-frame update is a no-op (zero streaming overhead, identical behavior
 *   to the old single-body terrain).
 *
 * Instrumentation only (no adaptive quality — still banned): buildMsEMA is
 * the exponential moving average of per-chunk build time, exposed to
 * engine.perf for ?perfoverlay=1.
 */
import * as THREE from 'three';
import {
  type ChunkGrid,
  chunkKey,
  planChunkChanges,
} from './chunkLayout';

export interface ChunkStreamLifecycle {
  /** Build a chunk's payload and page it into the scene/physics world. */
  buildChunk(cx: number, cz: number): void;
  /** Remove a chunk's payload and free its resources. */
  releaseChunk(cx: number, cz: number): void;
}

export interface ChunkStreamOptions {
  grid: ChunkGrid;
  lifecycle: ChunkStreamLifecycle;
  /** page in when chunk rect is within this distance (m). Default: 2.5 chunks. */
  loadRadius?: number;
  /** page out when chunk rect is beyond this distance (m). Default: 4 chunks. */
  unloadRadius?: number;
  /** max chunk builds per update() call. Default 2. */
  maxBuildsPerFrame?: number;
}

export class ChunkStream {
  private readonly grid: ChunkGrid;
  private readonly lifecycle: ChunkStreamLifecycle;
  readonly loadRadius: number;
  readonly unloadRadius: number;
  readonly maxBuildsPerFrame: number;
  private readonly loaded = new Set<string>();
  private queue: Array<{ cx: number; cz: number; dist: number }> = [];
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;
  /** EMA of per-chunk buildChunk() wall time, ms (instrumentation only). */
  buildMsEMA = 0;

  constructor(opts: ChunkStreamOptions) {
    this.grid = opts.grid;
    this.lifecycle = opts.lifecycle;
    const cs = opts.grid.chunkSize;
    this.loadRadius = opts.loadRadius ?? cs * 2.5;
    this.unloadRadius = opts.unloadRadius ?? cs * 4;
    if (this.unloadRadius <= this.loadRadius) {
      throw new Error(`ChunkStream: unloadRadius (${this.unloadRadius}) must exceed loadRadius (${this.loadRadius}) — hysteresis requires a band between them.`);
    }
    this.maxBuildsPerFrame = Math.max(1, opts.maxBuildsPerFrame ?? 2);
  }

  get loadedCount(): number { return this.loaded.size; }
  get queueLength(): number { return this.queue.length; }
  isLoaded(cx: number, cz: number): boolean { return this.loaded.has(chunkKey(cx, cz)); }

  /**
   * Page chunks around the focus point. Call once per frame with the player
   * position (Terrain.update does this; Engine feeds it every step).
   */
  update(focus: THREE.Vector3): void {
    const px = focus.x, pz = focus.z;
    // Single-chunk worlds: one resident chunk, no per-frame work at all.
    if (this.grid.chunksPerSide === 1) {
      if (!this.hasLast) {
        this.buildOne(0, 0);
        this.lastX = px; this.lastZ = pz; this.hasLast = true;
      }
      return;
    }
    const teleported = this.hasLast && Math.hypot(px - this.lastX, pz - this.lastZ) > this.unloadRadius;
    const plan = planChunkChanges(px, pz, this.grid, (cx, cz) => this.isLoaded(cx, cz), this.loadRadius, this.unloadRadius);
    // Unloads are cheap (remove body / dispose geometry) — apply immediately.
    for (const c of plan.toUnload) {
      this.lifecycle.releaseChunk(c.cx, c.cz);
      this.loaded.delete(chunkKey(c.cx, c.cz));
    }
    if (teleported || !this.hasLast) {
      // Correctness first: the focus jumped somewhere new (spawn, respawn,
      // resetRun, first update) — build everything needed NOW. Teleports
      // already hitch elsewhere (world rebuilds), so no budget here.
      for (const c of plan.toLoad) this.buildOne(c.cx, c.cz);
      this.queue = [];
    } else {
      // Rebuild the pending queue from the fresh plan (drops stale entries
      // the focus has moved away from), nearest first, then drain within the
      // per-frame build budget.
      this.queue = plan.toLoad.filter((c) => !this.isLoaded(c.cx, c.cz));
      let n = 0;
      while (n < this.maxBuildsPerFrame && this.queue.length > 0) {
        const c = this.queue.shift()!;
        if (this.isLoaded(c.cx, c.cz)) continue; // stale duplicate guard
        this.buildOne(c.cx, c.cz);
        n++;
      }
    }
    this.lastX = px; this.lastZ = pz; this.hasLast = true;
  }

  /** Release every loaded chunk (used by Terrain.dispose). */
  reset(): void {
    for (const k of this.loaded) {
      const [cx, cz] = k.split(',').map(Number);
      this.lifecycle.releaseChunk(cx, cz);
    }
    this.loaded.clear();
    this.queue = [];
    this.hasLast = false;
    this.buildMsEMA = 0;
  }

  private buildOne(cx: number, cz: number): void {
    const t0 = performance.now();
    this.lifecycle.buildChunk(cx, cz);
    const dt = performance.now() - t0;
    this.buildMsEMA = this.buildMsEMA === 0 ? dt : this.buildMsEMA * 0.8 + dt * 0.2;
    this.loaded.add(chunkKey(cx, cz));
  }
}
