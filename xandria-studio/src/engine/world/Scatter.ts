/**
 * Seeded environment scatter: trees, rocks, crystals, ruins — as InstancedMesh so hundreds of
 * props cost one draw call each. Placement respects slope, water and exclusion zones (spawn, track).
 *
 * Open-world stage 1: worlds up to one 256m chunk keep the legacy whole-world
 * build path verbatim (byte-identical placement, pinned by
 * tests/chunk-scatter.test.ts). Bigger worlds stream per-chunk through
 * ChunkedScatter: deterministic per-chunk seeds, one global InstancedMesh
 * pool per prop set (draw calls flat by construction), per-chunk density
 * budgets so the resident set scales with the load radius, never world size.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';
import type { MaterialLibrary } from '../gfx/Materials';
import { GROUP, type Physics } from '../core/Physics';
import { Vegetation } from './Vegetation';
import { Grass } from './Grass';
import { definePropSets, propSetCtx, legacyTreeCount, type PropSetDef, type PlaceBounds } from './PropSets';
import { LEGACY_MAX_SIZE } from './ChunkGrid';
import { ChunkedScatter } from './ChunkScatter';
import type { Engine } from '../Engine';

export interface ScatterOptions {
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
  /** when provided, vegetation LOD + wind updates register on the engine loop */
  engine?: Engine;
  /** render-quality tier: NEW hero-prop sets scale their counts with it (existing sets untouched) */
  quality?: 'retro' | 'standard' | 'high';
  /** only scatter the per-genre hero props (for blueprints that dress the world themselves) */
  heroesOnly?: boolean;
  /** exclusion zones for hero props specifically (defaults to `exclusion`) */
  heroExclusion?: Array<{ x: number; z: number; r: number }>;
}

export interface InstanceSet { mesh: THREE.InstancedMesh; positions: THREE.Vector3[]; radius: number; tag: 'base' | 'genre-hero' | 'biome' }

const _camTmp = new THREE.Vector3();

export class Scatter {
  sets: InstanceSet[] = [];
  colliders: { x: number; z: number; r: number }[] = [];
  vegetation?: Vegetation;
  grass?: Grass;
  /** chunked streaming backend (worlds > 256m); null on the legacy path */
  chunked: ChunkedScatter | null = null;

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, physics: Physics, scene: THREE.Scene, opts: ScatterOptions = {}) {
    if (terrain.size > LEGACY_MAX_SIZE) {
      // ---- chunked streaming path (stage 1): per-chunk deterministic
      // placement, global instanced pools, density budgets.
      const chunked = new ChunkedScatter(spec, terrain, mats, physics, scene, opts);
      this.chunked = chunked;
      this.sets = chunked.sets;
      this.colliders = chunked.colliders;
      this.vegetation = chunked.vegetation;
      this.grass = chunked.grass;
      if (opts.engine) {
        opts.engine.onUpdate((dt) => {
          const cam = opts.engine!.camera.getWorldPosition(_camTmp);
          chunked.update(cam);
          if (this.vegetation) this.vegetation.update(dt, cam);
          if (this.grass) this.grass.update(dt);
          if (terrain.water) terrain.updateWater(dt);
        });
      }
      return;
    }

    // ---- legacy whole-world path (byte-identical; see tests/chunk-scatter.test.ts)
    // NOTE: vegetation is built BEFORE the prop sets (as in the pre-refactor
    // constructor) so the shared colliders array keeps its exact legacy order
    // (tree colliders first). It uses its own rng — the prop-set rng stream
    // below is unaffected.
    const rng = new Rng(spec.meta.seed ^ 0x5ca7);
    const quality = opts.quality ?? 'retro';
    const maxSlope = opts.maxSlope ?? 0.45;
    const ctx = propSetCtx(spec, terrain, mats, opts);
    const defs = definePropSets(ctx, mats);

    const treeCount = legacyTreeCount(ctx);
    if (treeCount > 0) {
      this.vegetation = new Vegetation(spec, terrain, mats, scene, {
        exclusion: opts.exclusion,
        maxSlope,
        colliders: this.colliders,
        physics,
        count: treeCount,
      });
      opts.engine?.onUpdate((dt) => {
        if (this.vegetation) {
          this.vegetation.update(dt, opts.engine!.camera.getWorldPosition(_camTmp));
        }
      });

      // polish wave: instanced grass tufts (GPU wind) where the biome fits —
      // counts scale with the quality tier; only when base scatter is on
      this.grass = new Grass(spec, terrain, scene, {
        quality,
        exclusion: opts.exclusion,
        maxSlope,
      });
      if (this.grass.count > 0) {
        opts.engine?.onUpdate((dt) => this.grass?.update(dt));
      }
    }

    const legacyBounds: PlaceBounds = { x0: -ctx.half, x1: ctx.half, z0: -ctx.half, z1: ctx.half };
    this.buildLegacySets(rng, defs, legacyBounds, mats, physics, scene);

    // polish wave: animate the water plane's fake specular (one uniform/frame)
    if (terrain.water) {
      opts.engine?.onUpdate((dt) => terrain.updateWater(dt));
    }
  }

  /**
   * Legacy set builder: the pre-refactor addSet loop, driven by prop-set
   * descriptors. Field-for-field identical behavior (pinned by
   * tests/chunk-scatter.test.ts).
   */
  private buildLegacySets(
    rng: Rng, defs: PropSetDef[], bounds: PlaceBounds,
    mats: MaterialLibrary, physics: Physics, scene: THREE.Scene,
  ) {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const def of defs) {
      const count = def.count;
      if (count <= 0) continue;
      const inst = new THREE.InstancedMesh(def.makeGeo(), def.makeMat(mats), count);
      inst.castShadow = true; inst.receiveShadow = true;
      const positions: THREE.Vector3[] = [];
      let placed = 0;
      for (let i = 0; i < count; i++) {
        const p = def.place(rng, def.collideR, bounds);
        if (!p) continue;
        p.y += typeof def.yOff === 'function' ? def.yOff(rng) : def.yOff;
        const s = def.scale(rng);
        if (def.tilt > 0) e.set(rng.range(-def.tilt, def.tilt), rng.range(0, Math.PI * 2), rng.range(-def.tilt, def.tilt));
        else e.set(0, rng.range(0, Math.PI * 2), 0);
        q.setFromEuler(e);
        m4.compose(p, q, s);
        inst.setMatrixAt(placed++, m4);
        positions.push(p);
        if (def.collideR > 0) {
          this.colliders.push({ x: p.x, z: p.z, r: def.collideR * Math.max(s.x, s.z) });
          if (def.physical) physics.cylinder(def.collideR * s.x * 0.8, def.collideR * s.x * 0.9, 6 * s.y, [p.x, p.y + 3 * s.y, p.z], { group: GROUP.WORLD });
        }
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
      this.sets.push({ mesh: inst, positions, radius: def.collideR, tag: def.tag });
    }
  }

  /** Cheap circle-collision resolve for characters (keeps them out of trunks/rocks). */
  resolve(pos: THREE.Vector3, radius: number) {
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d2 = dx * dx + dz * dz;
      const rr = c.r + radius;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (rr - d) / d;
        pos.x += dx * push; pos.z += dz * push;
      }
    }
  }
}
