/**
 * Workstream D — per-map entity lifecycle for the Open World Portals wave.
 *
 * A "map" is one 8km world at grid coordinate (mx, my). Everything that
 * exists *because of the map* — enemies, pickups, loot, chests, ambient
 * props, trigger volumes — is map-local: it must despawn when the player
 * leaves the map and respawn deterministically when the player arrives.
 * Everything the player *earned* — health, inventory, ammo, progression —
 * is player state and survives (see world/PortalState.ts).
 *
 * ## The contract (binds blueprints; enforced by PortalTransition)
 *
 * A map-local entity system registers ONE object with
 * `engine.portalEntities`:
 *
 *     engine.portalEntities.register({
 *       id: 'enemies',
 *       despawnAll() { /* remove every live payload: scene meshes,
 *                         physics bodies, step handlers, timers *\/ },
 *       spawnForMap(mapSeed) { /* spawn this map's entities *\/ },
 *     });
 *
 * Rules:
 * 1. `despawnAll()` must leave ZERO live payloads behind: every mesh removed
 *    from the scene, every body removed from the physics world, every
 *    onUpdate/onStep handler unregistered, every GPU resource it owns
 *    disposed. The soak test asserts physics body count returns to baseline
 *    after every transition.
 * 2. `spawnForMap(mapSeed)` must be DETERMINISTIC in (mapSeed) ALONE: same
 *    seed → same entities at the same positions. Use a locally seeded Rng
 *    (`new Rng(mapSeed ^ SALT)`), NEVER `engine.rng` — engine.rng keeps
 *    advancing across transitions, so consuming it would desync revisit
 *    spawns. Do not use Math.random or Date.now.
 *    Sanctioned exception (upgrade loop, enemy-scaling): enemy STATS may
 *    additionally depend on (playerLevel, mapDist) — same (mapSeed,
 *    playerLevel, map) → identical stats; positions/kinds stay mapSeed-alone.
 *    Sanctioned exception (upgrade loop, world-tiers): the world tier
 *    additionally feeds the scaling level floor and loot rarity weighting —
 *    the tier is itself a pure function of (mapSeed, map depth), so same
 *    (seed, path) → identical tiers and the round-trip contract holds.
 * 3. Systems run in registration order on both paths; a throwing system must
 *    not abort the others (the registry try/catches and reports).
 * 4. Loot/pickup *state* (a chest already opened, an item already taken) is
 *    NOT tracked cross-map in this wave — revisiting a map respawns its
 *    entities fresh. Player inventory is unaffected (it is player state).
 *    Cross-map loot memory is explicitly queued behind this wave.
 *
 * EnemyManager, Pickups, and ItemWorld each own scene/physics payloads and
 * are the natural registrants; their merge-time adapters are small wrappers
 * calling their existing dispose()/spawn entry points. (EnemyManager needs a
 * roster-wide despawn — see the merge notes in workers-portals/D.md.)
 */
export interface MapLocalEntitySystem {
  /** stable id for diagnostics (e.g. 'enemies', 'pickups', 'item-world') */
  readonly id: string;
  /**
   * Remove every live payload of the departed map. Must be idempotent —
   * calling it twice in a row (e.g. a transition that finds nothing to
   * despawn) is a no-op, never an error.
   */
  despawnAll(): void;
  /**
   * Spawn this map's entities for the given derived map seed. Deterministic:
   * identical (mapSeed) → identical spawns.
   */
  spawnForMap(mapSeed: number): void;
}

export class MapEntityRegistry {
  private readonly systems: MapLocalEntitySystem[] = [];

  /**
   * Register a map-local entity system. Returns an unregister function.
   * Ids are unique: registering a second system with an existing id
   * REPLACES the old entry (with a warning). This keeps rebuild paths safe —
   * e.g. Engine.resetRun() tears down payloads and the blueprint rebuild
   * re-registers; the stale entry is replaced, never duplicated.
   */
  register(system: MapLocalEntitySystem): () => void {
    const dup = this.systems.findIndex((s) => s.id === system.id);
    if (dup >= 0) {
      console.warn(`[portals] entity system "${system.id}" re-registered — replacing stale entry`);
      this.systems.splice(dup, 1);
    }
    this.systems.push(system);
    return () => {
      const i = this.systems.indexOf(system);
      if (i >= 0) this.systems.splice(i, 1);
    };
  }

  get count(): number { return this.systems.length; }
  ids(): string[] { return this.systems.map((s) => s.id); }

  /**
   * UPGRADE LOOP (difficulty-modes): look up a registered system by id
   * (e.g. the 'enemies' EnemyManager for the difficulty selector's
   * no-changes-in-combat rule). Returns undefined when not registered.
   */
  byId(id: string): MapLocalEntitySystem | undefined {
    return this.systems.find((s) => s.id === id);
  }

  /** Departure path: despawn every registered system (registration order). */
  despawnAll(): void {
    for (const s of [...this.systems]) {
      try {
        s.despawnAll();
      } catch (e) {
        // A broken system must not strand the others' payloads (leak) or
        // abort the transition. Report and continue.
        console.warn(`[portals] entity system "${s.id}" despawnAll threw`, e);
      }
    }
  }

  /**
   * Arrival path: spawn every registered system from the derived map seed
   * (registration order). Deterministic per system contract.
   */
  spawnForMap(mapSeed: number): void {
    for (const s of [...this.systems]) {
      try {
        s.spawnForMap(mapSeed);
      } catch (e) {
        console.warn(`[portals] entity system "${s.id}" spawnForMap threw`, e);
      }
    }
  }
}
