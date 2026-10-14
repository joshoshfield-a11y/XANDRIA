/**
 * Open-world stage 1 (workstream C): chunked scatter streaming.
 *
 * Worlds bigger than one 256m chunk build their scatter (rocks, crystals,
 * ruins, genre heroes, biome props, trees, grass) per chunk instead of whole-
 * world at boot:
 *
 * - Placement is deterministic per chunk: seed = chunkSeed(worldSeed, salt,
 *   cx, cz), so a chunk's props are identical regardless of load order or
 *   which other chunks are resident.
 * - Every prop set renders through ONE global InstancedMesh pool (the perf
 *   foundation the legacy path established) sized perChunkBudget ×
 *   MAX_RESIDENT_CHUNKS. Streaming rewrites instance matrices in per-chunk
 *   slot ranges — draw calls are flat vs the legacy path by construction.
 * - Per-chunk density budgets cap every set, so the resident set scales with
 *   the load radius, never with world size.
 * - Streaming runs on workstream B's ChunkStream over the canonical chunk
 *   grid (world/chunkLayout.ts — the same grid A's terrain chunks and B's
 *   physics chunks use, so scatter, mesh and physics chunks align exactly).
 *   Load radius 560m comfortably exceeds fog visibility (~2% at default
 *   FogExp2 density), so chunk pops happen inside the fog; unload hysteresis
 *   at 688m prevents load/unload thrash; 3 chunk builds per frame max.
 *
 * Small worlds (<= 256m) never touch this class — Scatter keeps the legacy
 * whole-world build path verbatim, so existing worlds generate byte-identical.
 */
import * as THREE from 'three';
import type * as CANNON from 'cannon-es';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';
import type { MaterialLibrary } from '../gfx/Materials';
import { GROUP, type Physics } from '../core/Physics';
import { Vegetation } from './Vegetation';
import { Grass } from './Grass';
import {
  SCATTER_LOAD_RADIUS, SCATTER_UNLOAD_RADIUS, MAX_RESIDENT_CHUNKS,
  CHUNK_BUILD_BUDGET, scatterGrid, chunkSeed, ChunkSlotPool,
} from './ChunkGrid';
import { ChunkStream } from './ChunkStream';
import { chunkKey, chunkWorldRect, type ChunkGrid } from './chunkLayout';
import {
  definePropSets, propSetCtx, legacyTreeCount, chunkTreeCount,
  type PropSetDef, type PropSetCtx, type PlaceBounds,
} from './PropSets';
import type { ScatterOptions, InstanceSet } from './Scatter';

interface PoolChunkData {
  start: number;
  count: number;
  positions: THREE.Vector3[];
  colliders: { x: number; z: number; r: number }[];
  bodies: CANNON.Body[];
}

interface Pool {
  def: PropSetDef;
  mesh: THREE.InstancedMesh;
  slots: ChunkSlotPool;
  chunks: Map<string, PoolChunkData>;
}

export class ChunkedScatter {
  sets: InstanceSet[] = [];
  colliders: { x: number; z: number; r: number }[] = [];
  vegetation?: Vegetation;
  grass?: Grass;

  private spec: GameSpec;
  private physics: Physics;
  private scene: THREE.Scene;
  private ctx: PropSetCtx;
  private grid: ChunkGrid;
  private stream: ChunkStream;
  private pools: Pool[] = [];
  /** loaded chunk keys (mirrors the stream's loaded set; test hook reads this) */
  private loadedSet = new Set<string>();

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, physics: Physics, scene: THREE.Scene, opts: ScatterOptions = {}) {
    this.spec = spec;
    this.physics = physics;
    this.scene = scene;
    this.ctx = propSetCtx(spec, terrain, mats, opts);
    // canonical grid from the terrain's own chunk fields (workstream A/B) —
    // scatter chunks align with terrain mesh + physics chunks exactly
    this.grid = scatterGrid(terrain);
    const maxSlope = opts.maxSlope ?? 0.45;
    const quality = opts.quality ?? 'retro';

    // one global pool per prop set; sets with zero legacy count are skipped
    // exactly like the legacy addSet early-return (same mesh set, same count)
    const defs = definePropSets(this.ctx, mats).filter((d) => d.count > 0);
    for (const def of defs) {
      const mesh = new THREE.InstancedMesh(def.makeGeo(), def.makeMat(mats), def.budget * MAX_RESIDENT_CHUNKS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.visible = false;
      scene.add(mesh);
      this.pools.push({ def, mesh, slots: new ChunkSlotPool(def.budget * MAX_RESIDENT_CHUNKS), chunks: new Map() });
      this.sets.push({ mesh, positions: [], radius: def.collideR, tag: def.tag });
    }

    // trees + grass stream through their own chunk-aware implementations,
    // which share the same grid and seed scheme
    if (legacyTreeCount(this.ctx) > 0) {
      this.vegetation = new Vegetation(spec, terrain, mats, scene, {
        exclusion: opts.exclusion,
        maxSlope,
        physics,
        count: 0,
        chunked: { grid: this.grid, treeCountFor: (area) => chunkTreeCount(this.ctx, area) },
      });
      this.grass = new Grass(spec, terrain, scene, {
        quality,
        exclusion: opts.exclusion,
        maxSlope,
        chunked: { grid: this.grid },
      });
    }

    // streaming on B's ChunkStream: hysteresis, per-frame build budget, and
    // synchronous fill on the first update (spawn) / teleports
    this.stream = new ChunkStream({
      grid: this.grid,
      loadRadius: SCATTER_LOAD_RADIUS,
      unloadRadius: SCATTER_UNLOAD_RADIUS,
      maxBuildsPerFrame: CHUNK_BUILD_BUDGET,
      lifecycle: {
        buildChunk: (cx, cz) => this.loadChunkKey(cx, cz),
        releaseChunk: (cx, cz) => this.unloadChunkKey(chunkKey(cx, cz)),
      },
    });
    // initial synchronous fill around the spawn (blueprints spawn near origin)
    this.stream.update(new THREE.Vector3(0, 0, 0));
  }

  // ---------- streaming ----------

  /** Per-frame streaming update. Call with the camera/player position. */
  update(playerPos: THREE.Vector3): void {
    this.stream.update(playerPos);
  }

  /**
   * Direct chunk build (manual drive / tests). Idempotent. The stream
   * converges on the next update() via its own loaded set + the idempotent
   * lifecycle — the placement set here is the source of truth.
   */
  loadChunk(cx: number, cz: number): void {
    const n = this.grid.chunksPerSide;
    cx = Math.min(n - 1, Math.max(0, cx));
    cz = Math.min(n - 1, Math.max(0, cz));
    if (this.loadedSet.has(chunkKey(cx, cz))) return;
    this.loadChunkKey(cx, cz);
  }

  /** Direct chunk release (manual drive / tests). Idempotent. */
  unloadChunk(cx: number, cz: number): void {
    const n = this.grid.chunksPerSide;
    cx = Math.min(n - 1, Math.max(0, cx));
    cz = Math.min(n - 1, Math.max(0, cz));
    this.unloadChunkKey(chunkKey(cx, cz));
  }

  get loadedChunkCount(): number { return this.loadedSet.size; }

  /** EMA of per-chunk build wall time, ms (perf-overlay instrumentation). */
  get buildMsEMA(): number { return this.stream.buildMsEMA; }

  /** Resident prop instance count across all pools + vegetation + grass. */
  get residentInstances(): number {
    let n = 0;
    for (const p of this.pools) n += p.slots.total;
    n += this.vegetation ? this.vegetation.instanceCount : 0;
    n += this.grass ? this.grass.count : 0;
    return n;
  }

  /** Pool slot ranges per chunk (test hook — placement determinism checks). */
  chunkMatrices(setKey: string, cx: number, cz: number): Float32Array | null {
    const pool = this.pools.find((p) => p.def.key === setKey);
    const data = pool?.chunks.get(chunkKey(cx, cz));
    if (!pool || !data) return null;
    return (pool.mesh.instanceMatrix.array as Float32Array).slice(data.start * 16, (data.start + data.count) * 16);
  }

  /** Per-chunk placed count per set (budget-cap test hook). */
  chunkCounts(cx: number, cz: number): Record<string, number> {
    const out: Record<string, number> = {};
    const key = chunkKey(cx, cz);
    for (const pool of this.pools) {
      const data = pool.chunks.get(key);
      if (data) out[pool.def.key] = data.count;
    }
    return out;
  }

  /** Per-set per-chunk budgets (test hook). */
  setBudgets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const pool of this.pools) out[pool.def.key] = pool.def.budget;
    return out;
  }

  /** Loaded chunk keys (test hook). */
  loadedKeys(): string[] { return [...this.loadedSet]; }

  private loadChunkKey(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (this.loadedSet.has(key)) return;
    // canonical chunk rect, clipped to the legacy placement margin
    const rect = chunkWorldRect(cx, cz, this.grid);
    const half = this.ctx.half;
    const b: PlaceBounds = {
      x0: Math.max(rect.x0, -half), x1: Math.min(rect.x1, half),
      z0: Math.max(rect.z0, -half), z1: Math.min(rect.z1, half),
    };
    const area = Math.max(0, b.x1 - b.x0) * Math.max(0, b.z1 - b.z0);
    // one rng per chunk, consumed sequentially across sets in descriptor
    // order — identical placements no matter when or in what order the chunk loads
    const rng = new Rng(chunkSeed(this.spec.meta.seed, 0x5ca7, cx, cz));
    for (const pool of this.pools) {
      const n = pool.def.chunkCount(area);
      if (n <= 0) continue;
      const gen = this.generateSet(pool.def, rng, b, n);
      if (gen.count <= 0) continue;
      const start = pool.slots.alloc(key, gen.count);
      if (start < 0) continue; // pool full — unreachable while resident chunks stay bounded
      (pool.mesh.instanceMatrix.array as Float32Array).set(gen.matrices, start * 16);
      pool.chunks.set(key, {
        start, count: gen.count, positions: gen.positions, colliders: gen.colliders, bodies: gen.bodies,
      });
    }
    this.vegetation?.loadChunk(cx, cz);
    this.grass?.loadChunk(cx, cz);
    this.loadedSet.add(key);
    this.refreshDerived();
  }

  private unloadChunkKey(key: string): void {
    if (!this.loadedSet.has(key)) return;
    for (const pool of this.pools) {
      const data = pool.chunks.get(key);
      if (!data) continue;
      for (const body of data.bodies) this.physics.remove(body);
      const moved = pool.slots.free(key);
      if (moved) {
        const arr = pool.mesh.instanceMatrix.array as Float32Array;
        arr.copyWithin(moved.to * 16, moved.from * 16, (moved.from + moved.count) * 16);
        const movedData = pool.chunks.get(moved.movedKey)!;
        pool.chunks.delete(moved.movedKey);
        pool.chunks.set(moved.movedKey, { ...movedData, start: moved.to });
      }
      pool.chunks.delete(key);
    }
    const [cx, cz] = key.split(',').map(Number);
    this.vegetation?.unloadChunk(cx, cz);
    this.grass?.unloadChunk(cx, cz);
    this.loadedSet.delete(key);
    this.refreshDerived();
  }

  /**
   * Placement for one set in one chunk — the legacy addSet loop writing into
   * arrays instead of an InstancedMesh. Same attempt/scale/tilt/yOff/collider
   * logic, so per-chunk results match the legacy path's per-region behavior.
   */
  private generateSet(def: PropSetDef, rng: Rng, b: PlaceBounds, n: number): {
    matrices: Float32Array; positions: THREE.Vector3[];
    colliders: { x: number; z: number; r: number }[]; bodies: CANNON.Body[]; count: number;
  } {
    const matrices = new Float32Array(n * 16);
    const positions: THREE.Vector3[] = [];
    const colliders: { x: number; z: number; r: number }[] = [];
    const bodies: CANNON.Body[] = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const p = def.place(rng, def.collideR, b);
      if (!p) continue;
      p.y += typeof def.yOff === 'function' ? def.yOff(rng) : def.yOff;
      const s = def.scale(rng);
      if (def.tilt > 0) e.set(rng.range(-def.tilt, def.tilt), rng.range(0, Math.PI * 2), rng.range(-def.tilt, def.tilt));
      else e.set(0, rng.range(0, Math.PI * 2), 0);
      q.setFromEuler(e);
      m4.compose(p, q, s);
      m4.toArray(matrices, placed * 16);
      placed++;
      positions.push(p);
      if (def.collideR > 0) {
        colliders.push({ x: p.x, z: p.z, r: def.collideR * Math.max(s.x, s.z) });
        if (def.physical) {
          bodies.push(this.physics.cylinder(def.collideR * s.x * 0.8, def.collideR * s.x * 0.9, 6 * s.y,
            [p.x, p.y + 3 * s.y, p.z], { group: GROUP.WORLD }));
        }
      }
    }
    return { matrices: matrices.subarray(0, placed * 16), positions, colliders, bodies, count: placed };
  }

  /**
   * Rebuild everything derived from the loaded set: pool counts, bounding
   * spheres (frustum culling stays correct as instances move), the public
   * `sets[].positions`, and the flat collider array.
   */
  private refreshDerived(): void {
    this.colliders.length = 0;
    for (const pool of this.pools) {
      pool.mesh.count = pool.slots.total;
      pool.mesh.visible = pool.slots.total > 0;
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.slots.total > 0) pool.mesh.computeBoundingSphere();
      const set = this.sets.find((s) => s.mesh === pool.mesh)!;
      set.positions.length = 0;
      for (const [, data] of pool.chunks) {
        for (const p of data.positions) set.positions.push(p);
        for (const c of data.colliders) this.colliders.push(c);
      }
    }
    if (this.vegetation) {
      for (const key of this.loadedSet) {
        const [cx, cz] = key.split(',').map(Number);
        for (const c of this.vegetation.chunkColliders(cx, cz)) this.colliders.push(c);
      }
    }
  }

  /** Full teardown (restart paths). */
  dispose(): void {
    this.stream.reset();
    for (const pool of this.pools) {
      this.scene.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      pool.mesh.dispose();
    }
    this.pools = [];
    this.sets = [];
    this.vegetation?.disposeAll(this.scene);
    this.vegetation = undefined;
    this.grass?.dispose(this.scene);
    this.grass = undefined;
    this.loadedSet.clear();
    this.colliders.length = 0;
  }
}
