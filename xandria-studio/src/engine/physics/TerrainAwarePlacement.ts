/**
 * TerrainAwarePlacement (physics wave, item 5): clean interfaces between the
 * world GENERATOR and the physics modules.
 *
 * CONTRACT (the generator side promises this; physics modules promise that):
 *   1. The generator derives placements from the spec seed (deterministic).
 *   2. For each placement it calls `sample(terrain, x, z)` → ground height,
 *      normal, slope, surface id, water level. It never queries physics
 *      internals directly.
 *   3. It REGISTERS collision through the Physics facade (box/sphere/static)
 *      — adding bodies only, never rebuilding the physics world.
 *   4. After registration the physics modules own the bodies (scheduler
 *      activation, buoyancy, breakables). The generator never mutates them.
 *   5. Placement validity (too steep / deep water / out of bounds) is decided
 *      here, in one place, via PlacementConstraints.
 *
 * Adoption: ItemWorld.spawnLootGrounded / spawnChestGrounded use this path
 * (the old spawnLoot/spawnChest keep their exact behavior). Scatter/props
 * crews adopt the same `sample()` + registrar calls for their placements.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { GROUP, type Physics } from '../core/Physics';
import type { SurfaceProvider } from './Surfaces';

/** Minimal terrain surface the placement layer needs (Terrain satisfies this). */
export interface PlacementTerrain extends SurfaceProvider {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number): THREE.Vector3;
  inBounds(x: number, z: number, margin?: number): boolean;
}

export interface PlacementSample {
  x: number;
  z: number;
  groundY: number;
  normal: THREE.Vector3;
  /** 0 = flat … 1 = vertical (1 - normal.y) */
  slope: number;
  surfaceId: string;
  /** water surface Y, or null */
  waterLevel: number | null;
  /** water depth over the ground, 0 when dry */
  waterDepth: number;
}

export interface PlacementConstraints {
  /** reject placements steeper than this (0..1 slope) */
  maxSlope?: number;
  /** reject placements deeper than this water depth (m) */
  maxWaterDepth?: number;
  /** reject placements outside the terrain bounds */
  requireInBounds?: boolean;
}

export type PlacementRejection = 'too-steep' | 'too-deep' | 'out-of-bounds';

export interface PlacementResult {
  ok: boolean;
  sample: PlacementSample | null;
  rejection: PlacementRejection | null;
}

/**
 * Sample the ground at (x, z). Allocation: one sample object + one normal
 * vector per call — placement is a generation-time path, not the hot loop.
 */
export function sample(terrain: PlacementTerrain, x: number, z: number): PlacementSample {
  const groundY = terrain.heightAt(x, z);
  const normal = terrain.normalAt(x, z);
  const slope = 1 - normal.y;
  const surfaceId = terrain.surfaceAt(x, z);
  const waterLevel = terrain.waterLevelAt(x, z);
  const waterDepth = waterLevel !== null ? Math.max(0, waterLevel - groundY) : 0;
  return { x, z, groundY, normal, slope, surfaceId, waterLevel, waterDepth };
}

/** Sample + validate against constraints. */
export function sampleChecked(
  terrain: PlacementTerrain, x: number, z: number, c: PlacementConstraints = {},
): PlacementResult {
  if (c.requireInBounds !== false && !terrain.inBounds(x, z)) {
    return { ok: false, sample: null, rejection: 'out-of-bounds' };
  }
  const s = sample(terrain, x, z);
  if (c.maxSlope !== undefined && s.slope > c.maxSlope) {
    return { ok: false, sample: s, rejection: 'too-steep' };
  }
  if (c.maxWaterDepth !== undefined && s.waterDepth > c.maxWaterDepth) {
    return { ok: false, sample: s, rejection: 'too-deep' };
  }
  return { ok: true, sample: s, rejection: null };
}

/**
 * Collision registration handle handed to the generator. Thin, explicit, and
 * additive-only: the generator adds bodies; it never removes or rebuilds.
 * (Backed by the Physics facade — `physics` IS the registrar.)
 */
export type CollisionRegistrar = Pick<Physics, 'box' | 'sphere' | 'cylinder' | 'capsule'>;

/**
 * Place a static box on the terrain: ground-clamped, constraint-checked,
 * registered with the physics world. Returns the body + sample, or the
 * rejection reason. The generator owns "where"; physics owns the body after.
 */
export function placeStaticBox(
  engine: Engine,
  terrain: PlacementTerrain,
  registrar: CollisionRegistrar,
  x: number,
  z: number,
  size: THREE.Vector3,
  c: PlacementConstraints = {},
  group: number = GROUP.WORLD,
): { body: CANNON.Body; sample: PlacementSample } | { rejection: PlacementRejection } {
  const r = sampleChecked(terrain, x, z, c);
  if (!r.ok || !r.sample) return { rejection: r.rejection ?? 'out-of-bounds' };
  const s = r.sample;
  const body = registrar.box(
    size,
    new THREE.Vector3(s.x, s.groundY + size.y / 2, s.z),
    { mass: 0, group },
  );
  return { body, sample: s };
}
