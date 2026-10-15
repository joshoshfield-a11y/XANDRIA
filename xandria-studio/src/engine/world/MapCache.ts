/**
 * Workstream D — visited-map LRU for the Open World Portals wave.
 *
 * A portal transition either revisits a recently-seen map or generates a
 * new one. Regenerating is deterministic (~1s cold via spawn-first lazy),
 * but the *cheap* revisit path is a bounded cache of built map contexts:
 *
 * - capacity N (default 3): the live map + the two most recent neighbors.
 *   Bouncing between 2–3 maps — the overwhelmingly common player pattern —
 *   never rebuilds geometry.
 * - on revisit within the cache: the context is re-attached instantly.
 *   Chunk *geometry* stays cached in the parked Terrain (no rebuild); chunk
 *   *physics bodies* rebuild fast from the pure height function on the first
 *   update() after unpark (bodies are cheap — geometry is the ~1s cost).
 * - on eviction: the context is FULLY disposed — chunk meshes removed from
 *   the scene and geometries disposed, all physics bodies removed from the
 *   world, per-map entity state already despawned by MapEntities. The heap
 *   stays flat across unlimited transitions (the soak test asserts this).
 *
 * Memory bound: one parked context holds its built chunk geometries
 * (spawn-neighborhood + whatever the mesh stream paged in while live —
 * bounded by MESH_STREAM_UNLOAD_RADIUS). With capacity 3 the ceiling is ~3x
 * one map's paged geometry, regardless of how many maps the player visits.
 *
 * The cache is map-implementation agnostic (CachedMap). TerrainMapContext
 * adapts the shipped Terrain class: park() = Terrain.parkPortals (payloads
 * off, geometry cached), unpark() = re-attach + update at the arrival focus,
 * dispose() = Terrain.dispose (payloads off AND geometry disposed).
 */
import type * as THREE from 'three';
import type { Physics } from '../core/Physics';
import type { Terrain } from './Terrain';
import type { MapCoord } from './PortalState';

/** `mx,my` → stable cache key. Matches C's MapGraph addressing. */
export function mapKey(c: MapCoord): string {
  return `${c.mx},${c.my}`;
}

/**
 * One built map, parkable. The cache never touches map internals beyond
 * these four operations.
 */
export interface CachedMap {
  readonly coord: MapCoord;
  /**
   * Detach all live payloads (scene meshes, physics bodies, walls, water)
   * WITHOUT disposing built artifacts (geometry/material caches stay).
   * The map must remain fully valid for a later unpark() or dispose().
   * Idempotent: parking an already-parked map is a no-op.
   */
  park(): void;
  /**
   * Re-attach payloads and make this the live map, paging around `focus`
   * (the player's arrival position). After this returns the map must be
   * walkable: the arrival neighborhood is sync-built, the rest streams in.
   */
  unpark(focus: THREE.Vector3): void;
  /**
   * Full teardown: park() PLUS dispose every built artifact (geometries,
   * water geometry). After this the map must hold no scene/physics/GPU
   * resources at all.
   */
  dispose(): void;
  /** currently live physics bodies owned by this map (leak auditing). */
  liveBodies(): number;
}

/** CachedMap adapter for the shipped Terrain class. */
export class TerrainMapContext implements CachedMap {
  constructor(
    readonly coord: MapCoord,
    readonly terrain: Terrain,
    private readonly scene: THREE.Scene,
    private readonly physics: Physics,
  ) {}

  park(): void {
    this.terrain.parkPortals(this.scene, this.physics);
  }

  unpark(focus: THREE.Vector3): void {
    this.terrain.unparkPortals(this.scene, this.physics);
    // The first update after a park is a teleport (ChunkStream.reset cleared
    // the paging state): the arrival neighborhood sync-builds, the rest of
    // the load radius drains through the per-frame budget. Cached chunk
    // geometry is reused — no rebuild — bodies rebuild from the pure height
    // function (fast). refreshPortalAliases re-points the legacy spawn-chunk
    // aliases at the focus chunk's fresh payloads.
    this.terrain.update(focus);
    this.terrain.refreshPortalAliases(focus);
  }

  dispose(): void {
    this.terrain.dispose(this.scene, this.physics);
  }

  liveBodies(): number {
    return this.terrain.loadedChunkBodies.length;
  }
}

export interface AcquireResult {
  map: CachedMap;
  /** true when the map was already cached (instant revisit, no rebuild) */
  hit: boolean;
  /** the evicted map's coord when the cache was full, else null */
  evicted: MapCoord | null;
}

/**
 * Bounded LRU of built map contexts, keyed by (mx, my).
 *
 * acquire() is the only mutation path: hits refresh recency, misses build
 * through the caller-supplied factory and evict the least-recently-used
 * entry (full dispose) when at capacity. The factory runs OUTSIDE the cache
 * so build failures never corrupt cache state — a throwing factory leaves
 * the cache exactly as it was.
 */
export class PortalMapCache {
  private readonly entries = new Map<string, { map: CachedMap; stamp: number }>();
  private stamp = 0;

  /**
   * @param capacity max resident maps. 3 = live map + two recent neighbors;
   *   the bounce-between-maps pattern never rebuilds. Must be >= 1.
   */
  constructor(readonly capacity: number = 3) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`[portals] PortalMapCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number { return this.entries.size; }
  has(coord: MapCoord): boolean { return this.entries.has(mapKey(coord)); }

  /** resident coords, most-recently-used last (diagnostics). */
  coords(): MapCoord[] {
    return [...this.entries.values()]
      .sort((a, b) => a.stamp - b.stamp)
      .map((e) => e.map.coord);
  }

  acquire(coord: MapCoord, build: (c: MapCoord) => CachedMap): AcquireResult {
    const key = mapKey(coord);
    const existing = this.entries.get(key);
    if (existing) {
      existing.stamp = ++this.stamp;
      return { map: existing.map, hit: true, evicted: null };
    }
    let evicted: MapCoord | null = null;
    if (this.entries.size >= this.capacity) {
      let oldestKey: string | null = null;
      let oldestStamp = Infinity;
      for (const [k, v] of this.entries) {
        if (v.stamp < oldestStamp) { oldestStamp = v.stamp; oldestKey = k; }
      }
      // size >= capacity >= 1 guarantees oldestKey is set
      const victim = this.entries.get(oldestKey!)!;
      try {
        victim.map.dispose();
      } finally {
        // the slot is freed even if dispose throws — a broken context must
        // not wedge the cache (its leak is reported, not retried forever)
        this.entries.delete(oldestKey!);
      }
      evicted = victim.map.coord;
    }
    // build AFTER eviction so a throwing factory can't leave the cache over
    // capacity, and the new entry is the most-recently-used
    const map = build(coord);
    this.entries.set(key, { map, stamp: ++this.stamp });
    return { map, hit: false, evicted };
  }

  /**
   * Park every resident map and drop them all (game end / full restart).
   * The live map must be parked by the transition flow first — clear() is
   * teardown, not a transition step.
   */
  clear(): void {
    for (const { map } of this.entries.values()) {
      try { map.dispose(); } catch (e) { console.warn('[portals] cache clear: dispose threw', e); }
    }
    this.entries.clear();
  }
}
