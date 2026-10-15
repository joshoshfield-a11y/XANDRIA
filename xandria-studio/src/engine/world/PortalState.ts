/**
 * Workstream D — player-state snapshot/restore across portal transitions,
 * plus the reference transition flow workstream B drives.
 *
 * ## What is player state (survives) vs map state (does not)
 *
 * SURVIVES the transition (captured in PlayerStateSnapshot):
 * - avatar: health, maxHealth, ammo, lives
 * - controller: yaw, speedBoostT, velocity (arrival momentum; B places the
 *   player at the opposite edge facing inward, then restores momentum)
 * - inventory: full backpack + equipped slots (Inventory.serialize round-trip)
 * - progression: level, xp, upgrade counts (+ the firerate multiplier that
 *   'firerate' upgrades fold into spec.custom.weaponMods)
 * - timed buffs (blueprint itemKit): buffUntil is engine-time based and
 *   engine.time is NOT reset by a transition, so until/mult restore verbatim
 *
 * DOES NOT survive (map-local, handled elsewhere):
 * - position: the player arrives at the opposite edge of the new map (B)
 * - enemies/pickups/loot/chests: despawned on departure, deterministically
 *   respawned on arrival (see world/MapEntities.ts)
 * - engine.score / engine.elapsed: run-level, untouched by transitions
 *
 * ## The workstream B seam
 *
 * B owns the trigger volumes, the loading screen, and player placement. It
 * drives the transition through `PortalTransition` (reference implementation
 * below) or equivalently through the three primitives:
 *
 *     const snap = capturePlayerState(engine, parts);   // before the loader
 *     engine.parkWorldForPortal();                       // payloads off
 *     engine.portalEntities.despawnAll();
 *     ... B builds/shows the target map ...
 *     applyPlayerState(engine, parts, snap);            // after placement
 *     engine.portalEntities.spawnForMap(mapSeed);
 *
 * `parts` is the blueprint-owned player bundle (avatar, inventory,
 * progression, buff accessors) — D never reaches into blueprints directly.
 * If B prefers its own onBeforeTransition/onAfterTransition hook pair, those
 * hooks should call capturePlayerState/applyPlayerState (or
 * PortalTransition.begin/finish) — the snapshot FORMAT is the contract that
 * must not change shape without updating both sides.
 *
 * MAP CONTRACT (workstream C owns src/engine/world/MapGraph.ts — NOT created
 * here): `interface MapCoord { mx: number; my: number }`,
 * `deriveMapSeed(worldSeed, mx, my, ...)`, `neighborOf`, `oppositeEdge`,
 * `ORIGIN`. This module defines MapCoord with the identical shape so the
 * merge is mechanical (PortalState re-exports from MapGraph).
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { PlayerAvatar } from '@blueprints/common';
import type { Inventory } from '../game/items/Inventory';
import type { Progression } from '../game/Progression';
import type { Terrain } from './Terrain';
import { TerrainMapContext, type CachedMap } from './MapCache';

/** Map identity: integer grid coordinate. Canonical type lives in C's MapGraph (frozen contract); re-exported here so D's modules keep a single import surface. */
import type { MapCoord } from './MapGraph';
export type { MapCoord };

/** Timed damage buff (blueprint itemKit): engine-time based, restores verbatim. */
export interface PortalBuffState {
  until: number;
  mult: number;
}

/** Progression slice of the snapshot (Progression.portalSnapshot shape). */
export interface PortalProgressionSnapshot {
  level: number;
  xp: number;
  counts: Record<string, number>;
}

/**
 * Everything the player earned, frozen at the moment of crossing. Plain
 * JSON-serializable data (versioned) — no object references, no functions.
 */
export interface PlayerStateSnapshot {
  version: 1;
  health: number;
  maxHealth: number;
  ammo: number;
  lives: number;
  yaw: number;
  speedBoostT: number;
  velocity: [number, number, number];
  /** Inventory.serialize() JSON — full backpack + equipped slots. */
  inventory: string;
  progression: PortalProgressionSnapshot | null;
  /** spec.custom.weaponMods.rateOfFire after 'firerate' upgrades; null = untouched. */
  weaponRateOfFire: number | null;
  buff: PortalBuffState | null;
}

/**
 * The blueprint-owned player bundle D reads/writes. B assembles this from
 * the live blueprint objects; D never imports blueprint modules at runtime
 * (type-only imports above keep the layering clean).
 */
export interface PortalParts {
  avatar: PlayerAvatar | null;
  inventory: Inventory | null;
  progression: Progression | null;
  /** current timed buff, or null when the blueprint has none / none active */
  getBuff(): PortalBuffState | null;
  /** install a restored buff, or clear when null */
  setBuff(b: PortalBuffState | null): void;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Freeze player state before a portal transition. Pure data copy — safe to
 * call at any time, never mutates the live game.
 */
export function capturePlayerState(engine: Engine, parts: PortalParts): PlayerStateSnapshot {
  const a = parts.avatar;
  const vel: [number, number, number] = a
    ? [a.ctrl.body.velocity.x, a.ctrl.body.velocity.y, a.ctrl.body.velocity.z]
    : [0, 0, 0];
  const buff = parts.getBuff();
  return {
    version: 1,
    health: isFiniteNum(a?.health) ? a!.health : 0,
    maxHealth: isFiniteNum(a?.maxHealth) ? a!.maxHealth : 1,
    ammo: isFiniteNum(a?.ammo) ? a!.ammo : Infinity,
    lives: isFiniteNum(a?.lives) ? Math.max(0, Math.floor(a!.lives)) : 0,
    yaw: isFiniteNum(a?.ctrl.yaw) ? a!.ctrl.yaw : 0,
    speedBoostT: isFiniteNum(a?.ctrl.speedBoostT) ? Math.max(0, a!.ctrl.speedBoostT) : 0,
    velocity: vel,
    inventory: parts.inventory ? parts.inventory.serialize() : new InventoryShim().serialize(),
    progression: parts.progression ? parts.progression.portalSnapshot() : null,
    weaponRateOfFire: readWeaponRateOfFire(engine),
    buff: buff ? { until: buff.until, mult: buff.mult } : null,
  };
}

/**
 * Restore a snapshot after the player has been placed on the new map.
 * Writes every captured field back onto the live objects and re-syncs the
 * HUD. Position is NOT restored — B placed the player at the arrival edge.
 */
export function applyPlayerState(engine: Engine, parts: PortalParts, snap: PlayerStateSnapshot): void {
  if (!snap || snap.version !== 1) {
    console.warn('[portals] applyPlayerState: bad snapshot — player state not restored');
    return;
  }
  const a = parts.avatar;
  if (a) {
    a.health = snap.health;
    a.maxHealth = snap.maxHealth;
    a.ammo = snap.ammo;
    a.lives = snap.lives;
    a.ctrl.yaw = snap.yaw;
    a.ctrl.speedBoostT = snap.speedBoostT;
    a.ctrl.body.velocity.set(snap.velocity[0], snap.velocity[1], snap.velocity[2]);
    // a parked-then-restored body may be asleep; make sure it simulates
    if (typeof a.ctrl.body.wakeUp === 'function') a.ctrl.body.wakeUp();
    engine.hud.setHealth(snap.maxHealth > 0 ? snap.health / snap.maxHealth : 1);
    engine.hud.setLives(snap.lives);
  }
  if (parts.inventory) parts.inventory.restore(snap.inventory);
  if (parts.progression && snap.progression) parts.progression.portalRestore(snap.progression);
  writeWeaponRateOfFire(engine, snap.weaponRateOfFire);
  parts.setBuff(snap.buff ? { until: snap.buff.until, mult: snap.buff.mult } : null);
}

function readWeaponRateOfFire(engine: Engine): number | null {
  const r = (engine.spec as unknown as { custom?: { weaponMods?: { rateOfFire?: unknown } } })
    .custom?.weaponMods?.rateOfFire;
  return isFiniteNum(r) ? r : null;
}

function writeWeaponRateOfFire(engine: Engine, r: number | null): void {
  if (r === null) return;
  const spec = engine.spec as unknown as { custom?: { weaponMods?: { rateOfFire?: number } } };
  const custom = spec.custom ?? (spec.custom = {});
  const wm = custom.weaponMods ?? (custom.weaponMods = {});
  wm.rateOfFire = r;
}

/**
 * Minimal serialize() stand-in for the no-inventory case (arena genres that
 * never built an Inventory). Keeps the snapshot shape uniform.
 */
class InventoryShim {
  serialize(): string {
    return JSON.stringify({ version: 1, slots: [], equipped: {} });
  }
}

export function sameMapCoord(a: MapCoord, b: MapCoord): boolean {
  return a.mx === b.mx && a.my === b.my;
}

/**
 * Reference transition flow for workstream B. B owns triggers, the loading
 * screen, and player placement; it calls begin() when the player crosses the
 * energy field and finish() once the target map is ready and the player is
 * placed at the arrival edge.
 *
 * begin()  = capture player state + park live map payloads + despawn entities
 * finish() = acquire (LRU hit or build) target map → swap live terrain →
 *            unpark at the arrival focus → restore player state → spawn
 *            this map's entities deterministically
 *
 * `buildTerrain(coord, mapSeed)` constructs the new map's Terrain (the
 * caller sets spec.meta.seed = mapSeed first — seed derivation is C's
 * domain; D takes the derived seed as a parameter). `arrivalFocus` is the
 * player's post-placement position (the stream pages around it).
 */
export class PortalTransition {
  constructor(private readonly engine: Engine) {}

  begin(parts: PortalParts): PlayerStateSnapshot {
    const snap = capturePlayerState(this.engine, parts);
    this.engine.parkWorldForPortal();
    this.engine.portalEntities.despawnAll();
    return snap;
  }

  finish(
    parts: PortalParts,
    snap: PlayerStateSnapshot,
    coord: MapCoord,
    mapSeed: number,
    arrivalFocus: THREE.Vector3,
    buildTerrain: (coord: MapCoord, mapSeed: number) => Terrain,
  ): { hit: boolean; evicted: MapCoord | null } {
    const cache = this.engine.portalCache;
    if (!cache) {
      throw new Error('[portals] engine.portalCache is not wired — portal transitions need the visited-map LRU (see world/MapCache.ts)');
    }
    const { map, hit, evicted } = cache.acquire(coord, (c) =>
      this.makeContext(c, buildTerrain(c, mapSeed)),
    );
    // Every entry in this cache was built by makeContext(), so the cached
    // map is always a TerrainMapContext (narrowed here for .terrain access).
    const tmc = map as TerrainMapContext;
    this.engine.swapTerrainForPortal(tmc.terrain, coord, mapSeed);
    map.unpark(arrivalFocus);
    applyPlayerState(this.engine, parts, snap);
    this.engine.portalEntities.spawnForMap(mapSeed);
    return { hit, evicted };
  }

  /** Wrap a raw Terrain in the cache's context adapter (overridable). */
  protected makeContext(coord: MapCoord, terrain: Terrain): TerrainMapContext {
    return new TerrainMapContext(coord, terrain, this.engine.scene, this.engine.physics);
  }
}
