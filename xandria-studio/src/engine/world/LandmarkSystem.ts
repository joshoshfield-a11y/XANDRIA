/**
 * Portal-backlog wave — map-local landmark lifecycle.
 *
 * The portals wave shipped with a hole: blueprints build the landmark pass
 * (Structures.landmarks + Structures.structureSets) exactly once at boot,
 * but PortalTransition's arrival path (PortalTransition.finish →
 * engine.buildTerrainForPortal) rebuilds ONLY terrain. Consequences:
 *
 *  1. Every map after the first had NO landmarks — the arrival path never
 *     regenerated the full landmark set.
 *  2. The origin map's landmarks LEAKED across transitions: they live in the
 *     blueprint's Structures.group, which nothing ever removes on departure.
 *
 * This class closes both by making landmarks a proper MapLocalEntitySystem
 * (id 'landmarks', see world/MapEntities.ts for the contract):
 * despawnAll() removes the landmark group + its physics colliders + baked
 * geometry; spawnForMap(mapSeed) rebuilds the full set deterministically
 * from the derived map seed. It runs on the arrival path in registration
 * order like every other map-local system, and once at boot for the origin
 * map, so the boot path and the arrival path are the same code.
 *
 * Determinism: Structures.landmarks/structureSets seed their Rng from
 * (seed ^ SALT) alone; the per-map biome comes from resolveBiomeDef(spec),
 * which reads the portalMap stamp the arrival path puts on engine.spec
 * before spawnForMap runs (swapTerrainForPortal precedes
 * portalEntities.spawnForMap in PortalTransition.finish).
 *
 * Wear-point idempotence: Structures.landmarks bakes trampled aprons + worn
 * paths into the terrain's vertex colors via addWearPoints(), which is NOT
 * idempotent. On an LRU cache-hit arrival the SAME Terrain instance comes
 * back, so we apply wear only once per Terrain instance (WeakSet guard).
 * Same seed ⇒ identical placement anyway, so a guard-skip reproduces the
 * exact same paint.
 *
 * Perf: landmarks bake into InstancedMeshes (see gfx/Landmarks); a rebuild
 * is a few dozen draws for a frame, then back to baseline. despawnAll()
 * disposes the baked BufferGeometries (shared MaterialLibrary materials are
 * NOT disposed) and removes every collider body, so transitions keep the
 * heap and body count flat.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Terrain } from './Terrain';
import { Structures } from './Structures';
import type { MapLocalEntitySystem } from './MapEntities';
import type { PlacedLandmark, LandmarkKind } from '../gfx/Landmarks';

export interface LandmarkSystemOpts {
  /** exclusion discs (spawn, tracks, arena center) — blueprint-static */
  exclusion: Array<{ x: number; z: number; r: number }>;
  /**
   * Optional separate exclusion for the structure-sets pass (default:
   * `exclusion`). Platformer keeps the original split: no exclusion on the
   * landmark pass, r=12 spawn exclusion on structure sets.
   */
  exclusionSets?: Array<{ x: number; z: number; r: number }>;
  /** optional per-kind count override (default: the per-map biome's mix) */
  kinds?: Partial<Record<LandmarkKind, number>>;
}

export class LandmarkSystem implements MapLocalEntitySystem {
  readonly id = 'landmarks';

  /** placements of the most recent spawn — blueprints wire heroSpots/POIs from this at boot */
  placed: PlacedLandmark[] = [];
  /** seed of the most recent spawn */
  mapSeed: number | null = null;

  private readonly engine: Engine;
  private readonly opts: LandmarkSystemOpts;
  /** dedicated Structures: holds ONLY the map-local landmark pass */
  private structures: Structures | null = null;
  /** Terrains that already received the wear-point bake (cache-hit guard) */
  private readonly wearApplied = new WeakSet<Terrain>();

  constructor(engine: Engine, opts: LandmarkSystemOpts) {
    this.engine = engine;
    this.opts = opts;
  }

  spawnForMap(mapSeed: number): void {
    const engine = this.engine;
    if (!engine.terrain) {
      console.warn('[portals] landmarks: no terrain at spawn — skipping');
      return;
    }
    // Idempotent rebuild: a fresh Structures each spawn, so the old payload
    // is always fully retired first (never orphaned in the scene).
    this.despawnAll();
    const terrain = engine.terrain;
    // Wear points are NOT idempotent (Terrain.addWearPoints appends): on an
    // LRU cache-hit arrival the SAME Terrain instance comes back with its
    // wear discs already baked in, so skip re-applying. Placement is
    // seed-deterministic, so the paint is bit-identical either way.
    const skipWear = this.wearApplied.has(terrain);
    const structures = new Structures(engine.physics, engine.mats);
    const spec = engine.spec;
    const lm = structures.landmarks(spec, terrain, engine.scene, mapSeed, {
      exclusion: this.opts.exclusion,
      kinds: this.opts.kinds,
      quality: engine.effectiveQuality(),
      maxRealLights: engine.tiers.flags.maxRealLights,
      skipWear,
    });
    structures.structureSets(spec, terrain, engine.scene, mapSeed, {
      exclusion: this.opts.exclusionSets ?? this.opts.exclusion,
      quality: engine.effectiveQuality(),
      densityMul: engine.tiers.flags.densityMul,
      structureShadows: engine.tiers.flags.structureShadows,
    });
    if (!skipWear) this.wearApplied.add(terrain);
    engine.scene.add(structures.group);
    this.structures = structures;
    this.placed = lm.placed;
    this.mapSeed = mapSeed;
  }

  despawnAll(): void {
    const s = this.structures;
    if (!s) return;
    this.engine.scene.remove(s.group);
    for (const b of s.landmarkBodies) this.engine.physics.remove(b);
    // Dispose baked geometry; shared MaterialLibrary materials stay alive.
    s.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const g = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g && typeof g.dispose === 'function') g.dispose();
    });
    this.structures = null;
    this.placed = [];
    this.mapSeed = null;
  }

  /** draw-call census for the live landmark group (0 when despawned) */
  drawCalls(): number {
    let n = 0;
    this.structures?.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    return n;
  }

  /** live landmark collider bodies (0 when despawned) */
  get colliderCount(): number {
    return this.structures?.landmarkBodies.length ?? 0;
  }
}
