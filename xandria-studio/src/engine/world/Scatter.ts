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

export interface ScatterOptions {
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
}

interface InstanceSet { mesh: THREE.InstancedMesh; positions: THREE.Vector3[]; radius: number }

export class Scatter {
  sets: InstanceSet[] = [];
  colliders: { x: number; z: number; r: number }[] = [];

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
    const treeCount = sc.trees ? Math.round((env === 'forest' || env === 'jungle' ? 140 : 40) * density) : 0;
    const rockCount = sc.rocks ? Math.round(70 * density) : 0;
    const crysCount = sc.crystals ? Math.round(50 * density) : 0;
    const ruinCount = sc.ruins ? Math.round(24 * density) : 0;

    // trees: trunk + cone foliage merged look via two instanced meshes at same transforms
    if (treeCount > 0) {
      const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 2.4, 5);
      const folGeo = env === 'arctic' || env === 'forest' || env === 'jungle'
        ? new THREE.ConeGeometry(1.6, 4.2, 6)
        : new THREE.ConeGeometry(1.3, 3.2, 5);
      const trunkMat = mats.standard('wood', '#5a4230', { roughness: 0.95 });
      const folMat = mats.flat(
        env === 'arctic' ? '#dfe9f0' : spec.theme.palette.primary,
        { roughness: 0.9 },
      );
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
      const fols = new THREE.InstancedMesh(folGeo, folMat, treeCount);
      trunks.castShadow = fols.castShadow = true;
      const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion();
      let placed = 0;
      for (let i = 0; i < treeCount; i++) {
        const p = tryPlace(0.8);
        if (!p) continue;
        const s = rng.range(0.8, 1.9);
        q.setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), 0));
        m4.compose(new THREE.Vector3(p.x, p.y + 1.2 * s, p.z), q, new THREE.Vector3(s, s, s));
        trunks.setMatrixAt(placed, m4);
        m4.compose(new THREE.Vector3(p.x, p.y + (2.4 + 2.1) * s, p.z), q, new THREE.Vector3(s, s, s));
        fols.setMatrixAt(placed, m4);
        placed++;
        this.colliders.push({ x: p.x, z: p.z, r: 0.55 * s });
        if (placed < 80) physics.cylinder(0.4 * s, 0.45 * s, 2.4 * s, [p.x, p.y + 1.2 * s, p.z], { group: GROUP.WORLD });
      }
      trunks.count = fols.count = placed;
      trunks.instanceMatrix.needsUpdate = fols.instanceMatrix.needsUpdate = true;
      scene.add(trunks, fols);
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
