/**
 * NPC map-local lifecycle (gameplay wave, workstream B).
 *
 * NpcManager implements MapLocalEntitySystem (engine/world/MapEntities.ts):
 *  - spawnForMap(mapSeed) spawns this map's deterministic villager roster
 *    near points of interest (landmark/structure positions handed in by the
 *    blueprint — the graphics wave exposes them as landmarks.placed), using
 *    ONLY new Rng(mapSeed ^ NPC_SALT): never engine.rng, never Math.random,
 *    never Date.now. Same mapSeed → identical roster (positions, names,
 *    palettes).
 *  - despawnAll() removes every live payload (NPC dispose + shared rig
 *    cache clear) and is idempotent.
 *
 * The manager registers itself with engine.portalEntities (the blueprint
 * does `engine.portalEntities.register(npcManager)`); PortalTransition
 * drives despawnAll/spawnForMap on every map change, and registration
 * replaces stale entries on blueprint rebuilds.
 *
 * Placement: each POI gets a deterministic anchor pushed outside the
 * landmark footprint (radius + 4..8m ring, own salted stream so the roster
 * stream inside spawnNpcsForMap is undisturbed); A's spawnNpcsForMap then
 * rings 2..12m around the anchor with terrain heightAt grounding and the
 * cliff guard in Npc.update.
 *
 * Count: explicit opts.count wins; else the GameSpec npcs roster's summed
 * counts; else round(8 * density).
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import type { NpcSpec } from '@spec';
import { Npc, spawnNpcsForMap, NPC_SALT } from './Npc';
import { NpcRigCache } from './npcRigSharing';
import { NpcInstancer } from './npcInstancing';
import type { MapLocalEntitySystem } from '../world/MapEntities';

/** Point of interest: landmark/structure anchor for villager placement. */
export interface NpcPoi {
  x: number;
  z: number;
  /** footprint radius to stay outside of (default 0) */
  r?: number;
}

export interface NpcManagerOpts {
  /** POIs to settle near (blueprint passes landmarks.placed) */
  pois?: Array<THREE.Vector3 | NpcPoi>;
  /** 0..1+ scales the default roster (default 1) */
  density?: number;
  /** exact roster size (overrides density / spec counts) */
  count?: number;
  /** roster specs, cycled (default: engine.spec.npcs) */
  specs?: NpcSpec[];
  wanderRadius?: number;
  speed?: number;
  /**
   * vendor-economy wave: MapLocalEntitySystem id override (default
   * 'npcs'). A second manager (the vendor roster) registers under its
   * own id so portalEntities keeps both.
   */
  id?: string;
  /**
   * vendor-economy wave: roster stream salt, forwarded to
   * spawnNpcsForMap (default NPC_SALT). The vendor roster uses
   * VENDOR_SALT so its spawns/identities never collide with the
   * villager roster on the same map.
   */
  salt?: number;
}

/** Salt for the POI-anchor stream — keeps it off the roster stream. */
const POI_SALT = 0x901;

function poiXZ(p: THREE.Vector3 | NpcPoi): { x: number; z: number; r: number } {
  return p instanceof THREE.Vector3
    ? { x: p.x, z: p.z, r: 0 }
    : { x: p.x, z: p.z, r: p.r ?? 0 };
}

export class NpcManager implements MapLocalEntitySystem {
  readonly id: string;
  private readonly opts: NpcManagerOpts;
  private readonly cache: NpcRigCache;
  private readonly instancer: NpcInstancer;
  private list: Npc[] = [];

  constructor(private readonly engine: Engine, opts: NpcManagerOpts = {}) {
    this.id = opts.id ?? 'npcs';
    this.opts = opts;
    this.cache = NpcRigCache.for(engine);
    // Instancing pass: one InstancedMesh per (geometry, material-role)
    // bucket across the whole roster — the rigs keep animating as
    // transform carriers, the buckets do the drawing.
    this.instancer = NpcInstancer.for(engine);
  }

  /** Live roster (read-only view). */
  get npcs(): readonly Npc[] { return this.list; }

  /**
   * Spawn this map's roster deterministically from mapSeed alone.
   * Idempotent: despawns any live roster first (portal arrival after an
   * aborted transition can never double-spawn).
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    const specs = this.opts.specs ?? this.engine.spec.npcs;
    let count = this.opts.count;
    if (count === undefined && specs?.length) {
      count = specs.reduce((n, s) => n + (s.count ?? 1), 0);
    }
    const anchors = this.resolveAnchors(mapSeed);
    const roster = spawnNpcsForMap(this.engine, mapSeed, {
      count,
      density: this.opts.density ?? 1,
      specs,
      pois: anchors,
      wanderRadius: this.opts.wanderRadius,
      speed: this.opts.speed,
      // vendor-economy wave: the vendor roster spawns off its own salted
      // stream (VENDOR_SALT) — distinct positions/identities from the
      // villager roster on the same map; undefined keeps the historical
      // NPC_SALT stream byte-identical.
      salt: this.opts.salt,
    });
    this.list = roster;
    for (const n of roster) this.instancer.register(n);
  }

  /** Remove every live payload: NPCs + their shared rig resources. Idempotent. */
  despawnAll(): void {
    // Enemies wave C: unregister per-entity from the SHARED instancer —
    // reset() would wipe the enemy manager's buckets too (both managers
    // own the same per-engine singleton; spawnForMap self-cleans via
    // despawnAll, so a global reset on every spawn would drop the other
    // roster's instancing on every portal arrival).
    for (const n of this.list) {
      try { this.instancer.unregister(n); } catch { /* never strand the rest */ }
      try { n.dispose(); } catch { /* never strand the rest */ }
    }
    this.list = [];
    this.cache.clear();
  }

  /**
   * Tick every live NPC (blueprint wires this into engine.onUpdate).
   * Submits each NPC's posed rig to the shared instancer. The blueprint
   * drives the instancer frame (beginFrame/endFrame) around the manager
   * updates — enemies wave C: with NpcManager + EnemyManager sharing one
   * per-engine instancer, a single begin/end per update keeps both
   * managers' submits accumulating into the same frame instead of the
   * second manager's beginFrame zeroing the first's counts.
   */
  update(dt: number): void {
    for (const n of this.list) {
      n.update(dt);
      this.instancer.submit(n);
    }
  }

  /**
   * Deterministic POI anchors: each landmark gets an anchor point outside
   * its footprint so villagers settle *around* points of interest, not
   * inside their colliders. Pure function of (mapSeed, pois).
   */
  private resolveAnchors(mapSeed: number): THREE.Vector3[] {
    const raw = this.opts.pois;
    if (!raw?.length) return [];
    // vendor-economy wave: salt the anchor stream like the roster stream
    // (undefined = the historical NPC_SALT ^ POI_SALT, byte-identical).
    const rng = new Rng((mapSeed ^ (this.opts.salt ?? NPC_SALT) ^ POI_SALT) >>> 0);
    return raw.map((p) => {
      const { x, z, r } = poiXZ(p);
      const a = rng.range(0, Math.PI * 2);
      const d = r + 4 + rng.range(0, 4);
      return new THREE.Vector3(x + Math.cos(a) * d, 0, z + Math.sin(a) * d);
    });
  }
}
