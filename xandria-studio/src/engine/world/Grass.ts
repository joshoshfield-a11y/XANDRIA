/**
 * Grass tufts — one InstancedMesh of crossed quads with GPU wind sway.
 * Seeded placement (slope/water/exclusion-aware like Vegetation), counts
 * scaled by quality tier, only in environments where grass fits.
 * Zero per-frame CPU: the only per-frame work is one uTime uniform update.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import { resolveBiomeDef } from './Biomes';
import type { Terrain } from './Terrain';
import { chunkSeed, ChunkSlotPool, MAX_RESIDENT_CHUNKS } from './ChunkGrid';
import { chunkKey, chunkWorldRect, type ChunkGrid } from './chunkLayout';
import type { PlaceBounds } from './PropSets';

/**
 * Per-chunk grass budget: max tufts in one 256m chunk.
 * Legacy whole-world target at high quality is 4500 tufts over a 220m world
 * (48400 m²); area-scaled to a full 256m chunk (65536 m²) that's ~6093.
 */
export const GRASS_CHUNK_BUDGET = 6400;
/** Reference area the legacy whole-world grass target was authored against. */
export const GRASS_REF_AREA = 220 * 220;

// environments where ground grass reads naturally (fraction of full density)
// Workstream C: superseded by the biome treatment's authored scatter.grass —
// kept as documentation of the old mapping (forest/jungle/dreamscape 1,
// islands 0.9, ruins 0.8, desert/wasteland 0.25, arctic 0.2, else 0).
const QUALITY_COUNT = { high: 4500, standard: 2200, retro: 800 } as const;

export interface GrassOptions {
  quality?: 'retro' | 'standard' | 'high';
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
  /**
   * Open-world stage 1: chunked streaming mode. Placement becomes per-chunk
   * (deterministic seed per chunk); the single InstancedMesh becomes a global
   * pool sized GRASS_CHUNK_BUDGET × MAX_RESIDENT_CHUNKS so draw calls stay flat.
   * ChunkedScatter drives loadChunk/unloadChunk.
   */
  chunked?: { grid: ChunkGrid };
}

export class Grass {
  private mesh: THREE.InstancedMesh | null = null;
  private uniforms = { uTime: { value: 0 }, uWind: { value: 0.1 } };
  private _count = 0;
  private chunkedMode = false;
  private worldSeed = 0;
  private worldHalf = 0;
  private quality: 'retro' | 'standard' | 'high' = 'retro';
  private density = 0;
  private slots = new ChunkSlotPool(GRASS_CHUNK_BUDGET * MAX_RESIDENT_CHUNKS);
  private grid!: ChunkGrid;
  private placer?: {
    spec: GameSpec; terrain: Terrain; maxSlope: number;
    excluded: (x: number, z: number) => boolean;
    base: THREE.Color;
  };

  /** live tuft count (test hook + quality-scaler verification) */
  get count(): number { return this._count; }
  /** chunks currently resident (chunked mode test hook) */
  get loadedChunkCount(): number { return this.slots.size; }
  /** per-chunk tuft count (chunked mode test hook) */
  chunkCount(cx: number, cz: number): number {
    return this.slots.get(chunkKey(cx, cz))?.count ?? 0;
  }
  /** per-chunk tuft matrices (chunked mode test hook — determinism checks) */
  chunkMatrices(cx: number, cz: number): Float32Array | null {
    if (!this.chunkedMode || !this.mesh) return null;
    const slot = this.slots.get(chunkKey(cx, cz));
    if (!slot) return null;
    return (this.mesh.instanceMatrix.array as Float32Array).slice(slot.start * 16, (slot.start + slot.count) * 16);
  }

  constructor(spec: GameSpec, terrain: Terrain, scene: THREE.Scene, opts: GrassOptions = {}) {
    // Workstream C: grass density comes from the resolved biome treatment
    // (volcanic/caves get none; forest/coastline/plains are lush).
    const density = resolveBiomeDef(spec).scatter.grass;
    if (density <= 0) return; // volcanic / caves: no grass
    const quality = opts.quality ?? 'retro';
    const maxSlope = opts.maxSlope ?? 0.45;
    const half = terrain.size / 2 - 8;
    const excluded = (x: number, z: number) =>
      (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);
    // NOTE: instance colors ride the standard linear pipeline (unlike Terrain's
    // raw vertex colors), so no convertLinearToSRGB here — plain Color(hex) is
    // already in the working color space.
    const base = new THREE.Color(spec.theme.palette.primary);

    this.worldSeed = spec.meta.seed;
    this.worldHalf = half;
    this.quality = quality;
    this.density = density;
    this.placer = { spec, terrain, maxSlope, excluded, base };
    const mat = this.buildMaterial();

    if (opts.chunked) {
      // ---- chunked streaming mode: one global pool, no initial placement
      this.chunkedMode = true;
      this.grid = opts.chunked.grid;
      const geo = this.buildGeometry();
      const pool = new THREE.InstancedMesh(geo, mat, GRASS_CHUNK_BUDGET * MAX_RESIDENT_CHUNKS);
      pool.castShadow = false;
      pool.receiveShadow = false;
      pool.frustumCulled = false;
      pool.count = 0;
      // allocate the instanceColor buffer up front so unload swap-removes can
      // copyWithin colors without a null check
      pool.setColorAt(0, new THREE.Color(0xffffff));
      pool.count = 0;
      scene.add(pool);
      this.mesh = pool;
      return;
    }

    // ---- legacy whole-world path (byte-identical placement)
    const target = Math.round(QUALITY_COUNT[quality] * density);
    if (target <= 0) return;
    const rng = new Rng(spec.meta.seed ^ 0x6a55);
    const geo = this.buildGeometry();
    const gen = this.generateChunk(rng, { x0: -half, x1: half, z0: -half, z1: half }, target);
    const inst = new THREE.InstancedMesh(geo, mat, target);
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < gen.count; i++) {
      m4.fromArray(gen.matrices, i * 16);
      inst.setMatrixAt(i, m4);
    }
    // raw buffer copy — exactly what the legacy per-instance setColorAt loop
    // produced (setColorAt is a plain component copy into instanceColor)
    if (gen.count > 0) {
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(target * 3), 3);
      (inst.instanceColor.array as Float32Array).set(gen.colors.subarray(0, gen.count * 3));
    }
    inst.count = gen.count;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
    this.mesh = inst;
    this._count = gen.count;
  }

  /** crossed-quad tuft geometry (shared by both paths) */
  private buildGeometry(): THREE.BufferGeometry {
    // crossed-quad tuft: two small planes, origin at ground (kept modest in
    // size so tufts read as grass, not blocks, at gameplay distances)
    const blade = (ry: number) => {
      const g = new THREE.PlaneGeometry(0.55, 0.45);
      g.translate(0, 0.22, 0);
      g.rotateY(ry);
      return g;
    };
    return mergeGeometries([blade(0), blade(Math.PI / 2)]);
  }

  /** wind-swayed lambert material (shared by both paths) */
  private buildMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    // GPU wind: bend by blade height, phase from instance world position
    const u = this.uniforms;
    mat.customProgramCacheKey = () => 'xandria-grass-v1';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uWind = u.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            vec2 iwp = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xz;
            float gphase = iwp.x * 0.35 + iwp.y * 0.41;
            float gsway = sin(uTime * 2.1 + gphase) * uWind * uv.y * uv.y;
            transformed.x += gsway;
            transformed.z += gsway * 0.55;
          #endif
        `);
    };
    return mat;
  }

  /**
   * Seeded tuft placement inside `bounds`. The rng stream is identical to the
   * legacy loop for identical (seed, bounds, target).
   */
  private generateChunk(rng: Rng, b: PlaceBounds, target: number): {
    matrices: Float32Array; colors: Float32Array; count: number;
  } {
    const p = this.placer!;
    const matrices = new Float32Array(target * 16);
    const colors = new Float32Array(target * 3);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let placed = 0;
    for (let i = 0; i < target && placed < target; i++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const x = rng.range(b.x0, b.x1), z = rng.range(b.z0, b.z1);
        if (p.excluded(x, z)) continue;
        if (p.terrain.slopeAt(x, z) > p.maxSlope) continue;
        const y = p.terrain.heightAt(x, z);
        if (p.spec.world.terrain.water && y < p.spec.world.terrain.waterLevel + 0.4) continue;
        const s = rng.range(0.7, 1.3);
        q.setFromEuler(eul.set(0, rng.range(0, Math.PI * 2), 0));
        pos.set(x, y - 0.02, z);
        scl.set(s, s * rng.range(0.8, 1.3), s);
        m4.compose(pos, q, scl);
        m4.toArray(matrices, placed * 16);
        // lift the tuft color slightly above the canopy base so blades catch
        // light instead of rendering as dark blocks
        col.copy(p.base).offsetHSL(rng.range(-0.02, 0.04), rng.range(0, 0.08), rng.range(0.03, 0.12));
        colors[placed * 3] = col.r; colors[placed * 3 + 1] = col.g; colors[placed * 3 + 2] = col.b;
        placed++;
        break;
      }
    }
    return { matrices, colors, count: placed };
  }

  // ---------- chunked streaming API (driven by ChunkedScatter) ----------

  /** Generate + register a chunk's tufts (idempotent). */
  loadChunk(cx: number, cz: number): void {
    if (!this.chunkedMode || !this.mesh) return;
    const key = chunkKey(cx, cz);
    if (this.slots.get(key)) return;
    const rect = chunkWorldRect(cx, cz, this.grid);
    const half = this.worldHalf;
    const b: PlaceBounds = {
      x0: Math.max(rect.x0, -half), x1: Math.min(rect.x1, half),
      z0: Math.max(rect.z0, -half), z1: Math.min(rect.z1, half),
    };
    const area = Math.max(0, b.x1 - b.x0) * Math.max(0, b.z1 - b.z0);
    const target = Math.min(GRASS_CHUNK_BUDGET,
      Math.round(QUALITY_COUNT[this.quality] * this.density * (area / GRASS_REF_AREA)));
    const rng = new Rng(chunkSeed(this.worldSeed, 0x6a55, cx, cz));
    const gen = this.generateChunk(rng, b, target);
    const start = this.slots.alloc(key, gen.count);
    if (start < 0) return; // pool full — unreachable while resident chunks ≤ MAX_RESIDENT_CHUNKS
    const mArr = this.mesh.instanceMatrix.array as Float32Array;
    mArr.set(gen.matrices.subarray(0, gen.count * 16), start * 16);
    const cArr = this.mesh.instanceColor!.array as Float32Array;
    cArr.set(gen.colors.subarray(0, gen.count * 3), start * 3);
    this.mesh.count = this.slots.total;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this._count = this.slots.total;
  }

  /** Drop a chunk's tufts (swap-remove keeps the pool packed). */
  unloadChunk(cx: number, cz: number): void {
    if (!this.chunkedMode || !this.mesh) return;
    const moved = this.slots.free(chunkKey(cx, cz));
    if (moved) {
      const mArr = this.mesh.instanceMatrix.array as Float32Array;
      mArr.copyWithin(moved.to * 16, moved.from * 16, (moved.from + moved.count) * 16);
      const cArr = this.mesh.instanceColor!.array as Float32Array;
      cArr.copyWithin(moved.to * 3, moved.from * 3, (moved.from + moved.count) * 3);
    }
    this.mesh.count = this.slots.total;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._count = this.slots.total;
  }

  /** Only work: advance the wind clock. */
  update(dt: number) {
    if (!this.mesh) return;
    this.uniforms.uTime.value += dt;
  }

  dispose(scene: THREE.Scene) {
    if (!this.mesh) return;
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.mesh = null;
    this._count = 0;
  }
}
