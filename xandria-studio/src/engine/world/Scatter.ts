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
import type { Engine } from '../Engine';

export interface ScatterOptions {
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
  /** when provided, vegetation LOD + wind updates register on the engine loop */
  engine?: Engine;
}

interface InstanceSet { mesh: THREE.InstancedMesh; positions: THREE.Vector3[]; radius: number }

const _camTmp = new THREE.Vector3();

export class Scatter {
  sets: InstanceSet[] = [];
  colliders: { x: number; z: number; r: number }[] = [];
  vegetation?: Vegetation;

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, physics: Physics, scene: THREE.Scene, opts: ScatterOptions = {}) {
    const rng = new Rng(spec.meta.seed ^ 0x5ca7);
    const sc = spec.world.scatter;
    const env = spec.theme.environment;
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

    const addSet = (
      geo: THREE.BufferGeometry, mat: THREE.Material, count: number,
      scaleFn: () => THREE.Vector3, collideR: number, yOff = 0, physical = false,
    ) => {
      if (count <= 0) return;
      const inst = new THREE.InstancedMesh(geo, mat, count);
      inst.castShadow = true; inst.receiveShadow = true;
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const positions: THREE.Vector3[] = [];
      let placed = 0;
      for (let i = 0; i < count; i++) {
        const p = tryPlace(collideR);
        if (!p) continue;
        p.y += yOff;
        const s = scaleFn();
        q.setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), 0));
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
    const area = terrain.size * terrain.size;
    const perTree = env === 'forest' || env === 'jungle' ? 90
      : env === 'city' || env === 'neon-city' || env === 'arena' ? 6000 : 650;
    const treeCount = sc.trees ? Math.min(2200, Math.round((area / perTree) * density)) : 0;
    const rockCount = sc.rocks ? Math.round(70 * density) : 0;
    const crysCount = sc.crystals ? Math.round(50 * density) : 0;
    const ruinCount = sc.ruins ? Math.round(24 * density) : 0;

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
