/**
 * Seeded environment scatter: trees, rocks, crystals, ruins — as InstancedMesh so hundreds of
 * props cost one draw call each. Placement respects slope, water and exclusion zones (spawn, track).
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';
import type { MaterialLibrary } from '../gfx/Materials';
import { GROUP, type Physics } from '../core/Physics';
import { Vegetation } from './Vegetation';
import { Grass } from './Grass';
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

interface InstanceSet { mesh: THREE.InstancedMesh; positions: THREE.Vector3[]; radius: number }

const _camTmp = new THREE.Vector3();

export class Scatter {
  sets: InstanceSet[] = [];
  colliders: { x: number; z: number; r: number }[] = [];
  vegetation?: Vegetation;
  grass?: Grass;

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, physics: Physics, scene: THREE.Scene, opts: ScatterOptions = {}) {
    const rng = new Rng(spec.meta.seed ^ 0x5ca7);
    const sc = spec.world.scatter;
    const env = spec.theme.environment;
    const quality = opts.quality ?? 'retro';
    const heroesOnly = opts.heroesOnly ?? false;
    const maxSlope = opts.maxSlope ?? 0.45;
    const excluded = (x: number, z: number, r = 0) =>
      (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
    const half = terrain.size / 2 - 8;

    const tryPlace = (r: number): THREE.Vector3 | null => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = rng.range(-half, half), z = rng.range(-half, half);
        if (excluded(x, z, r)) continue;
        if (terrain.slopeAt(x, z) > maxSlope) continue;
        const y = terrain.heightAt(x, z);
        if (spec.world.terrain.water && y < spec.world.terrain.waterLevel + 0.5) continue;
        return new THREE.Vector3(x, y, z);
      }
      return null;
    };

    // hero props get their own exclusion list (defaults to the base one) so a
    // blueprint can keep the play field clear of base scatter but still dress it
    const heroExcluded = (x: number, z: number, r = 0) =>
      (opts.heroExclusion ?? opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
    const heroTryPlace = (r: number): THREE.Vector3 | null => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = rng.range(-half, half), z = rng.range(-half, half);
        if (heroExcluded(x, z, r)) continue;
        if (terrain.slopeAt(x, z) > maxSlope) continue;
        const y = terrain.heightAt(x, z);
        if (spec.world.terrain.water && y < spec.world.terrain.waterLevel + 0.5) continue;
        return new THREE.Vector3(x, y, z);
      }
      return null;
    };

    const addSet = (
      geo: THREE.BufferGeometry, mat: THREE.Material, count: number,
      scaleFn: () => THREE.Vector3, collideR: number, yOff: number | (() => number) = 0, physical = false,
      tilt = 0, place?: () => THREE.Vector3 | null,
    ) => {
      if (count <= 0) return;
      const inst = new THREE.InstancedMesh(geo, mat, count);
      inst.castShadow = true; inst.receiveShadow = true;
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const positions: THREE.Vector3[] = [];
      let placed = 0;
      for (let i = 0; i < count; i++) {
        const p = place ? place() : tryPlace(collideR);
        if (!p) continue;
        p.y += typeof yOff === 'function' ? yOff() : yOff;
        const s = scaleFn();
        if (tilt > 0) e.set(rng.range(-tilt, tilt), rng.range(0, Math.PI * 2), rng.range(-tilt, tilt));
        else e.set(0, rng.range(0, Math.PI * 2), 0);
        q.setFromEuler(e);
        m4.compose(p, q, s);
        inst.setMatrixAt(placed++, m4);
        positions.push(p);
        if (collideR > 0) {
          this.colliders.push({ x: p.x, z: p.z, r: collideR * Math.max(s.x, s.z) });
          if (physical) physics.cylinder(collideR * s.x * 0.8, collideR * s.x * 0.9, 6 * s.y, [p.x, p.y + 3 * s.y, p.z], { group: GROUP.WORLD });
        }
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
      this.sets.push({ mesh: inst, positions, radius: collideR });
    };

    const density = sc.density;
    // trees scale with world area: ~1 per 90m² in forests, sparser elsewhere
    // (heroesOnly skips the authored base sets — the blueprint dresses the world itself)
    const heroGate = heroesOnly ? 0 : 1;
    const area = terrain.size * terrain.size;
    const perTree = env === 'forest' || env === 'jungle' ? 90
      : env === 'city' || env === 'neon-city' || env === 'arena' ? 6000 : 650;
    const treeCount = sc.trees ? Math.min(2200, Math.round((area / perTree) * density)) * heroGate : 0;
    const rockCount = sc.rocks ? Math.round(70 * density) * heroGate : 0;
    const crysCount = sc.crystals ? Math.round(50 * density) * heroGate : 0;
    const ruinCount = sc.ruins ? Math.round(24 * density) * heroGate : 0;

    // trees: full vegetation system — species per environment, LOD tiers, GPU wind
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

    // polish wave: animate the water plane's fake specular (one uniform/frame)
    if (terrain.water) {
      opts.engine?.onUpdate((dt) => terrain.updateWater(dt));
    }

    // rocks
    addSet(
      new THREE.DodecahedronGeometry(1, 0),
      mats.standard('rock', spec.theme.palette.rock, { roughness: 1 }),
      rockCount,
      () => { const s = rng.range(0.5, 2.6); return new THREE.Vector3(s, s * rng.range(0.6, 1), s); },
      0.9, 0.2, true,
    );

    // crystals (glowing)
    if (crysCount > 0) {
      addSet(
        new THREE.OctahedronGeometry(0.9, 0),
        mats.glow(spec.theme.palette.accent, 1.4),
        crysCount,
        () => { const s = rng.range(0.5, 2.0); return new THREE.Vector3(s * 0.6, s, s * 0.6); },
        0.6, 0.5, false,
      );
    }

    // ruins: broken pillars
    if (ruinCount > 0) {
      addSet(
        new THREE.CylinderGeometry(0.55, 0.65, 4, 7),
        mats.standard('rock', '#9a9484', { roughness: 1 }),
        ruinCount,
        () => new THREE.Vector3(1, rng.range(0.3, 1.2), 1),
        0.8, 1.4, true,
      );
    }

    this.scatterHeroes(spec, terrain, mats, rng, addSet, heroTryPlace, quality, density, half);
  }

  /**
   * Beauty wave: per-genre hero props. Procedural, following the AssetBridge
   * static-prop patterns — seeded placement, terrain-grounded, footprint-clamped
   * (see clampFootprint), shadows on, and the procedural fallback IS the floor
   * so nothing here can fail to load. Counts live inside the quality scaler
   * (high 1.0 / standard 0.6 / retro 0.35); the authored base sets above are
   * untouched. Baked at build time — no per-frame updates.
   */
  private scatterHeroes(
    spec: GameSpec, terrain: Terrain, mats: MaterialLibrary,
    rng: Rng,
    addSet: (geo: THREE.BufferGeometry, mat: THREE.Material, count: number,
      scaleFn: () => THREE.Vector3, collideR: number, yOff?: number | (() => number),
      physical?: boolean, tilt?: number, place?: () => THREE.Vector3 | null) => void,
    tryPlace: (r: number) => THREE.Vector3 | null,
    quality: 'retro' | 'standard' | 'high', density: number, half: number,
  ) {
    // AssetBridge pattern: clamp absurd footprints before scattering.
    const clampFootprint = (geo: THREE.BufferGeometry, maxFoot: number) => {
      geo.computeBoundingBox();
      const size = geo.boundingBox!.getSize(new THREE.Vector3());
      const foot = Math.max(size.x, size.z);
      if (foot > maxFoot) geo.scale(maxFoot / foot, maxFoot / foot, maxFoot / foot);
    };
    const qMul = quality === 'high' ? 1 : quality === 'standard' ? 0.6 : 0.35;
    const hCount = (base: number) => Math.max(0, Math.round(base * density * qMul));
    const genre = spec.meta.genre;
    const pal = spec.theme.palette;
    // Hero sets place through the hero exclusion list by default (the addSet
    // closure binds the constructor's base tryPlace, so rebind explicitly).
    const hAddSet = (
      geo: THREE.BufferGeometry, mat: THREE.Material, count: number,
      scaleFn: () => THREE.Vector3, collideR: number, yOff: number | (() => number) = 0,
      physical = false, tilt = 0, place?: () => THREE.Vector3 | null,
    ) => addSet(geo, mat, count, scaleFn, collideR, yOff, physical, tilt,
      place ?? (() => tryPlace(collideR)));

    if (genre === 'third-person-action') {
      // weathered standing stones, tilted with age
      const g = new THREE.BoxGeometry(1.2, 4, 0.8);
      clampFootprint(g, 8);
      hAddSet(g, mats.standard('rock', pal.rock, { roughness: 1 }), hCount(48),
        () => { const s = rng.range(0.8, 1.2); return new THREE.Vector3(s, rng.range(0.7, 1.4), s); },
        0.7, 1.0, true, 0.14);
    } else if (genre === 'fps-arena') {
      // neon pylons + spare cover crates inside the walls
      const pg = new THREE.CylinderGeometry(0.16, 0.22, 5.2, 8);
      clampFootprint(pg, 8);
      hAddSet(pg, mats.glow(pal.accent, 2.2), hCount(26),
        () => new THREE.Vector3(1, rng.range(0.8, 1.2), 1), 0.4, 2.6, false);
      const cg = new THREE.BoxGeometry(1.7, 1.7, 1.7);
      clampFootprint(cg, 8);
      hAddSet(cg, mats.standard('metal', '#5d6672', { roughness: 0.6, metalness: 0.4 }), hCount(30),
        () => { const s = rng.range(0.8, 1.5); return new THREE.Vector3(s, s, s); },
        1.0, 0.9, true);
    } else if (genre === 'racing') {
      // trackside chevron posts (glow) + wreck shards
      const post = new THREE.CylinderGeometry(0.14, 0.14, 1.7, 6);
      clampFootprint(post, 8);
      hAddSet(post, mats.glow(pal.accent, 1.6), hCount(60),
        () => new THREE.Vector3(1, 1, 1), 0.3, 0.85, false);
      const shardG = new THREE.BoxGeometry(1.8, 0.5, 1.1);
      clampFootprint(shardG, 8);
      hAddSet(shardG, mats.standard('metal', '#4a4a52', { roughness: 0.7, metalness: 0.5 }), hCount(26),
        () => { const s = rng.range(0.7, 1.6); return new THREE.Vector3(s, s, s); },
        0.9, 0.15, true, 0.35);
    } else if (genre === 'platformer') {
      // floating crystal shards + wisps drifting along the course band
      // (platformer terrain sits far below the course, so place in course space)
      const courseY = Math.max(3, terrain.heightAt(-terrain.size / 2 + 14, 0) + 3);
      const coursePlace = () => {
        for (let a = 0; a < 8; a++) {
          const x = rng.range(-half + 10, half - 10), z = rng.range(-26, 26);
          return new THREE.Vector3(x, courseY + rng.range(-3, 9), z);
        }
        return null;
      };
      const sh = new THREE.OctahedronGeometry(1, 0);
      clampFootprint(sh, 8);
      hAddSet(sh, mats.glow(pal.accent, 1.8), hCount(48),
        () => { const s = rng.range(0.5, 1.6); return new THREE.Vector3(s * 0.6, s * 1.4, s * 0.6); },
        0, 0, false, 0, coursePlace);
      const wisp = new THREE.SphereGeometry(0.35, 8, 6);
      clampFootprint(wisp, 8);
      hAddSet(wisp, mats.glow('#ffffff', 1.2), hCount(28),
        () => new THREE.Vector3(1, 1, 1), 0, 0, false, 0, coursePlace);
    } else if (genre === 'top-down-shooter') {
      // barricades + glow pylons for the horde lanes — decorative (non-physical)
      // so enemy pathing through the arena is unaffected
      const bar = new THREE.BoxGeometry(2.4, 0.95, 0.55);
      clampFootprint(bar, 8);
      hAddSet(bar, mats.standard('metal', '#6a7078', { roughness: 0.55, metalness: 0.5 }), hCount(30),
        () => new THREE.Vector3(rng.range(0.9, 1.3), 1, 1), 0, 0.48, false);
      const py = new THREE.CylinderGeometry(0.2, 0.3, 3.4, 8);
      clampFootprint(py, 8);
      hAddSet(py, mats.glow(pal.accent, 2.0), hCount(20),
        () => new THREE.Vector3(1, rng.range(0.9, 1.2), 1), 0.5, 1.7, false);
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
