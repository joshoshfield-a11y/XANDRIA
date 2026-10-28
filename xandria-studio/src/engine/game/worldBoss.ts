/**
 * Wandering world-boss wave: a roaming world-boss event built on the
 * boss-fights + dynamic-events systems.
 *
 * CONTENT
 * - planWorldBoss(mapSeed, spec): PURE scheduler — Rng(mapSeed ^
 *   WORLDBOSS_SALT) picks the boss def (from the existing BOSS_DEFS, or
 *   the spec's bossId override), the spawn position (ringed 55-95m from
 *   the origin), the patrol waypoint loop, and the despawn lifetime.
 *   Same (mapSeed, spec) -> identical plan. Never engine.rng /
 *   Math.random / Date.now for gameplay; the despawn timer itself runs
 *   on dt, the same standing as the dynamic-events patrol timer.
 * - WorldBossEvent: MapLocalEntitySystem (id 'worldboss'). Lifecycle
 *   reuses the dynamic-events pattern: toast + world-space beacon marker
 *   (EventBeacon) on spawn, a completion condition (kill or timer), and
 *   rewards through the EXISTING boss loot path, unchanged — the boss is
 *   a real isBoss brute in the EnemyManager roster, so its die() path
 *   rolls rollLoot(rng, 'brute', isBoss=true) and the kill/XP/loot seams
 *   fire exactly as for an arena boss.
 * - Combat reuses the boss-fights encounter: the event owns a
 *   BossEncounter in open-field mode (spawnOpenField) — same def table,
 *   same telegraphed attacks, same boss bar. Arena rules do NOT apply:
 *   no arena visuals, no tether, the boss roams the seeded patrol loop.
 * - One active world boss per map max: the event spawns exactly one
 *   brute and binds exactly one encounter. When the world-boss flag is
 *   on, BossEncounter.spawnForMap stands down (see bosses.ts), so the
 *   arena system can never double-bind the same brute.
 *
 * DETERMINISM: plan, position, waypoints, def pick, and lifetime are
 * pure functions of (mapSeed, spec). The brute's stats additionally flow
 * through EnemyManager.spawnOne (scaling/difficulty/NG+ bands, the same
 * as every enemy — band 0 / normal / cycle 0 are identity).
 *
 * CONTRACTS (owned by this wave):
 * - WORLDBOSS_SALT is distinct from every other system salt (pinned by
 *   unit test).
 * - Boss defs and behavior contracts are untouched: the event only adds
 *   wiring (spawn + isBoss flag + open-field encounter + beacon/timer).
 *   The isBoss flag is set explicitly on the spawned brute — the
 *   Enemy.isBoss doc sanctions blueprint-side explicit setting.
 * - despawnAll() (portal departure) drops refs only: the brute is
 *   roster-owned, so EnemyManager.despawnAll sweeps it (the same standing
 *   as event-spawned combatants in dynamicEvents.ts). The timer-retreat
 *   path is the ONLY place that removes a live brute, and it does so
 *   without kill/loot/XP — dispose() emits no death events.
 * - The event is explicit opt-in (spec.custom.worldBoss.enabled); absent
 *   means no world boss and no behavior change on any existing map.
 */
import * as THREE from 'three';
import type { GameSpec, EnemySpec } from '@spec';
import type { Engine } from '../Engine';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import { Rng } from '../core/Rng';
import {
  BOSS_DEFS,
  DEFAULT_BOSS_ID,
  BossEncounter,
  type BossDef,
} from './bosses';
import type { Enemy, EnemyManager } from './EnemyAI';
import { NpcInstancer } from './npcInstancing';
import { EventBeacon } from './dynamicEvents';
import type { BossBar } from '../ui/BossBar';

/** Salt for the world-boss stream — distinct from every other system salt. */
export const WORLDBOSS_SALT = 0x9b05;

/** Base brute stats the def's healthMult scales (the boss-fights fixture base). */
export const WORLDBOSS_BASE_HEALTH = 120;
export const WORLDBOSS_BASE_SPEED = 3.2;
export const WORLDBOSS_BASE_DAMAGE = 12;

/** Spawn ring around the map origin (m). */
export const WORLDBOSS_RING_MIN = 55;
export const WORLDBOSS_RING_MAX = 95;
/** Patrol loop waypoints. */
export const WORLDBOSS_WAYPOINT_COUNT = 5;
/** Seeded lifetime band (s) when the spec does not override it. */
export const WORLDBOSS_LIFETIME_MIN = 240;
export const WORLDBOSS_LIFETIME_MAX = 420;
/** Beacon marker color (amber-orange, the boss accent). */
export const WORLDBOSS_BEACON_COLOR = '#ff7a2a';

/** True only on explicit opt-in — absent/false means no world boss. */
export function resolveWorldBossEnabled(spec: GameSpec): boolean {
  return spec.custom?.worldBoss?.enabled === true;
}

/** The boss def for a spec: a valid explicit bossId wins; otherwise the seeded plan pick. */
export function resolveWorldBossDef(spec: GameSpec, mapSeed: number): BossDef {
  const id = spec.custom?.worldBoss?.bossId;
  if (id && BOSS_DEFS[id]) return BOSS_DEFS[id];
  return BOSS_DEFS[planWorldBoss(mapSeed, spec).bossId] ?? BOSS_DEFS[DEFAULT_BOSS_ID];
}

/** Lifetime override clamped to 30..900s (0/negative/non-finite = no override). */
export function resolveWorldBossLifetimeOverride(spec: GameSpec): number | null {
  const raw = spec.custom?.worldBoss?.lifetimeSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(900, Math.max(30, Math.floor(raw)));
}

/** Patrol radius override clamped to 8..60m (absent/invalid = 28). */
export function resolveWorldBossPatrolRadius(spec: GameSpec): number {
  const raw = spec.custom?.worldBoss?.patrolRadius;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 28;
  return Math.min(60, Math.max(8, raw));
}

export interface WorldBossPlan {
  bossId: string;
  /** spawn position (x/z; y is grounded by the caller via terrain). */
  x: number;
  z: number;
  /** patrol loop around the spawn point. */
  waypoints: { x: number; z: number }[];
  /** despawn timer in seconds. */
  lifetimeSeconds: number;
  /** per-boss spawn seed (decorrelates the brute from the plan stream). */
  seed: number;
}

/**
 * PURE: the world-boss plan for a map. Draw order on the single stream is
 * fixed — angle, distance, lifetime (only when no override), then one
 * angle/radius jitter pair per waypoint — so the same (mapSeed, spec)
 * always yields the identical plan.
 */
export function planWorldBoss(mapSeed: number, spec: GameSpec): WorldBossPlan {
  const rng = new Rng((mapSeed ^ WORLDBOSS_SALT) >>> 0);
  const ids = Object.keys(BOSS_DEFS).sort();
  const bossId = spec.custom?.worldBoss?.bossId && BOSS_DEFS[spec.custom.worldBoss.bossId]
    ? spec.custom.worldBoss.bossId
    : rng.pick(ids);
  const ang = rng.range(0, Math.PI * 2);
  const dist = rng.range(WORLDBOSS_RING_MIN, WORLDBOSS_RING_MAX);
  const x = Math.cos(ang) * dist;
  const z = Math.sin(ang) * dist;
  const lifetimeSeconds = resolveWorldBossLifetimeOverride(spec)
    ?? Math.round(rng.range(WORLDBOSS_LIFETIME_MIN, WORLDBOSS_LIFETIME_MAX));
  const radius = resolveWorldBossPatrolRadius(spec);
  const waypoints: { x: number; z: number }[] = [];
  for (let i = 0; i < WORLDBOSS_WAYPOINT_COUNT; i++) {
    const a = (i / WORLDBOSS_WAYPOINT_COUNT) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const d = radius * rng.range(0.7, 1.15);
    waypoints.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d });
  }
  return {
    bossId,
    x,
    z,
    waypoints,
    lifetimeSeconds,
    seed: ((mapSeed ^ WORLDBOSS_SALT ^ 0x9e37) >>> 0),
  };
}

export type WorldBossStatus = 'inactive' | 'active' | 'done';

export interface WorldBossEventOpts {
  manager: EnemyManager;
  terrain: { heightAt(x: number, z: number): number };
  onPlayerHit: (damage: number, from: THREE.Vector3) => void;
  /** boss bar UI (blueprint-owned); null = headless (unit tests). */
  bar?: BossBar | null;
  toast: (msg: string) => void;
}

/**
 * Map-local world-boss event (id 'worldboss'). Owns one BossEncounter in
 * open-field mode, one spawned brute, one beacon, one timer.
 */
export class WorldBossEvent implements MapLocalEntitySystem {
  readonly id = 'worldboss';
  private readonly encounter: BossEncounter;
  private plan: WorldBossPlan | null = null;
  private boss: Enemy | null = null;
  private beacon: EventBeacon | null = null;
  private status: WorldBossStatus = 'inactive';
  private elapsed = 0;
  private disposed = false;
  private untapKill: (() => void) | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly opts: WorldBossEventOpts,
  ) {
    this.encounter = new BossEncounter(engine, {
      manager: opts.manager,
      terrain: opts.terrain,
      onPlayerHit: opts.onPlayerHit,
      bar: opts.bar ?? null,
    });
    // Kill credit flows through the existing seams untouched: the
    // encounter's own onKill tap hides the bar, and this tap retires the
    // event (beacon + timer) when the boss dies for real.
    this.untapKill = engine.hooks.tap('onKill', ({ enemy }) => {
      if (this.boss && enemy === this.boss) this.complete(false);
    });
  }

  /** The live plan (null when the event is off or before spawnForMap). */
  get livePlan(): WorldBossPlan | null { return this.plan; }
  /** The spawned boss brute (null when none / after kill or retreat). */
  get liveBoss(): Enemy | null { return this.boss; }
  get liveStatus(): WorldBossStatus { return this.status; }
  /** Seconds left on the despawn timer (0 when inactive/done). */
  get remainingSeconds(): number {
    if (!this.plan || this.status !== 'active') return 0;
    return Math.max(0, this.plan.lifetimeSeconds - this.elapsed);
  }
  /** The owned open-field encounter (test seam). */
  get liveEncounter(): BossEncounter { return this.encounter; }
  /** The live beacon marker (null when none). */
  get liveBeacon(): EventBeacon | null { return this.beacon; }

  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    if (!resolveWorldBossEnabled(this.engine.spec)) return;
    const plan = planWorldBoss(mapSeed, this.engine.spec);
    const def = BOSS_DEFS[plan.bossId] ?? BOSS_DEFS[DEFAULT_BOSS_ID];
    const y = this.opts.terrain.heightAt(plan.x, plan.z) + 1;
    const spec: EnemySpec = {
      kind: 'brute',
      count: 1,
      health: WORLDBOSS_BASE_HEALTH,
      speed: WORLDBOSS_BASE_SPEED,
      damage: WORLDBOSS_BASE_DAMAGE,
      weapon: 'melee',
    };
    const boss = this.opts.manager.spawnOne(spec, new THREE.Vector3(plan.x, y, plan.z), plan.seed);
    // Explicit isBoss: the Enemy doc sanctions blueprint-side setting, and
    // the die() loot path reads the flag at death time — so the existing
    // boss loot roll (incl. the legendary-grade table) runs unchanged.
    boss.isBoss = true;
    try { NpcInstancer.for(this.engine).registerEnemy(boss); } catch { /* instancing is render-only */ }
    this.boss = boss;
    this.plan = plan;
    this.elapsed = 0;
    this.status = 'active';
    this.encounter.spawnOpenField(
      mapSeed,
      def,
      plan.waypoints.map((w) => new THREE.Vector3(w.x, this.opts.terrain.heightAt(w.x, w.z) + 1, w.z)),
    );
    const beacon = new EventBeacon(WORLDBOSS_BEACON_COLOR);
    beacon.setPosition(boss.position.clone());
    this.engine.scene.add(beacon.group);
    this.beacon = beacon;
    this.opts.toast(`WORLD BOSS: ${def.name} ROAMS NEARBY`);
  }

  despawnAll(): void {
    this.encounter.despawnAll();
    if (this.beacon) {
      try { this.beacon.dispose(this.engine.scene); } catch { /* never strand */ }
      this.beacon = null;
    }
    // Portal semantics: the brute is roster-owned — EnemyManager.despawnAll
    // sweeps it. Dropping the ref here must NOT dispose it (double-dispose
    // with the roster sweep) and must NOT fire kill/loot paths.
    this.boss = null;
    this.plan = null;
    this.status = 'inactive';
    this.elapsed = 0;
  }

  /** Blueprint tick — call after enemies.update(), beside bosses.update(). */
  update(dt: number, playerPos: THREE.Vector3): void {
    if (this.disposed || this.status !== 'active' || !this.boss) return;
    if (!this.boss.alive) { this.complete(false); return; }
    this.encounter.update(dt, playerPos);
    if (this.beacon) this.beacon.setPosition(this.boss.position.clone());
    this.beacon?.update(dt);
    this.elapsed += dt;
    if (this.plan && this.elapsed >= this.plan.lifetimeSeconds) this.retreat();
  }

  dispose(): void {
    this.disposed = true;
    this.untapKill?.();
    this.untapKill = null;
    this.despawnAll();
    this.encounter.dispose();
  }

  // ------------------------------------------------------------ internals

  /** Kill completion: the bar/beacon retire; loot + XP already fired on the die() path. */
  private complete(retreated: boolean): void {
    if (this.status !== 'active') return;
    const def = this.plan ? (BOSS_DEFS[this.plan.bossId] ?? BOSS_DEFS[DEFAULT_BOSS_ID]) : null;
    this.status = 'done';
    this.encounter.despawnAll();
    if (this.beacon) {
      try { this.beacon.dispose(this.engine.scene); } catch { /* never strand */ }
      this.beacon = null;
    }
    if (def) {
      this.opts.toast(retreated
        ? `${def.name} retreats into the wild.`
        : `${def.name} felled — the wild is quiet.`);
    }
    this.boss = null;
  }

  /**
   * Timer expiry: remove the live brute WITHOUT the kill path — no loot,
   * no XP, no onKill emission. Mirrors EnemyManager.despawnAll for one
   * enemy (unregister + dispose + roster splice), all failure-tolerant.
   */
  private retreat(): void {
    const boss = this.boss;
    if (!boss) { this.complete(true); return; }
    // Clear the encounter first so no windup/bar logic touches the brute
    // after it leaves the roster.
    this.encounter.despawnAll();
    try { NpcInstancer.for(this.engine).unregister(boss); } catch { /* never strand */ }
    try { boss.dispose(); } catch { /* never strand */ }
    const roster = this.opts.manager.enemies;
    const i = roster.indexOf(boss);
    if (i >= 0) roster.splice(i, 1);
    this.boss = null;
    this.complete(true);
  }
}
