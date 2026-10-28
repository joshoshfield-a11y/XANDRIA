/**
 * Boss-fights wave: data-driven boss encounters — seeded arena placement,
 * telegraphed attacks (windup flash + ground damage-zone decal), boss
 * phases, and the boss health-bar lifecycle.
 *
 * CONTENT
 * - BOSS_DEFS: one tuning table for every boss (id, name, health
 *   multiplier, phases with hp thresholds + attack sets, telegraphed
 *   attack patterns). All tuning lives here — nothing is hardcoded in
 *   the encounter logic.
 * - planBossArena(mapSeed, radius): PURE arena placement from
 *   Rng(mapSeed ^ BOSS_SALT) — deterministic per world seed (mapSeed
 *   derives from (worldSeed, mx, my) via deriveMapSeed). Ringed 70-110m
 *   from the spawn so the player never starts inside it.
 * - BossEncounter: MapLocalEntitySystem (id 'boss'). On spawnForMap it
 *   places the arena (when the spec's boss flag is enabled); the boss
 *   itself is acquired lazily — the first living isBoss brute is tethered
 *   to the arena, health-scaled by the def, and given the telegraphed
 *   attack scheduler. On boss death the items-expansion boss loot path
 *   (rollLoot(rng, kind, isBoss=true) — legendary-grade, boss-exclusive)
 *   runs untouched on the EnemyManager die() path.
 *
 * DETERMINISM: arena placement is a pure function of mapSeed. The attack
 * scheduler consumes Rng(mapSeed ^ BOSS_SALT ^ bossIndex) ONLY when
 * picking the next attack — timing comes from dt, never from
 * Math.random/Date.now. Same (mapSeed, boss order, attack count) ->
 * identical attack sequence.
 *
 * CONTRACTS (owned by this wave):
 * - BOSS_SALT is distinct from ENEMY_SALT / NPC_SALT / CRAFT_SALT /
 *   STATION_SALT / GATHER_SALT / LOOT_SALT (pinned by unit test).
 * - Enemy/NPC public behavior contracts are untouched: the encounter
 *   never mutates EnemyAI internals beyond the public fields
 *   (isBoss, health, maxHealth, home, body, rig, instancer).
 * - despawnAll() removes every live payload (arena group, telegraphs,
 *   shockwaves) and hides the bar — idempotent, zero-leak.
 *
 * OPEN-FIELD MODE (wandering world-boss wave, additive): spawnOpenField()
 * runs the same encounter with no arena and no tether — the bound boss
 * roams a seeded waypoint loop (steered by re-pointing the public `home`,
 * the dynamic-events patrol pattern) and the telegraphed attack scheduler
 * runs unchanged. When spec.custom.worldBoss.enabled is true,
 * spawnForMap() stands down so the arena encounter never binds the same
 * brute the world-boss event owns. Default behavior is byte-identical:
 * open-field state only exists after an explicit spawnOpenField() call.
 */
import * as THREE from 'three';
import type { GameSpec, ObjectiveStage } from '@spec';
import type { Engine } from '../Engine';
/**
 * ACCESSIBILITY PASS: under a non-none colorblind palette, telegraph
 * ground decals resolve to the danger role and flash/burst colors to
 * dangerBright (see accessibility.ts for the disclosed tradeoff: per-attack
 * hue variety collapses to two roles). Under 'none' the shipped per-attack
 * colors are used verbatim, so the default game is pixel-identical.
 */
import { getCurrentPalette, themeColor } from './accessibility';

function telegraphColorFor(attack: BossAttackDef): string {
  return getCurrentPalette() === 'none' ? attack.telegraphColor : themeColor('danger');
}

function flashColorFor(attack: BossAttackDef): string {
  return getCurrentPalette() === 'none' ? attack.flashColor : themeColor('dangerBright');
}
import type { Enemy, EnemyManager } from './EnemyAI';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import { Rng } from '../core/Rng';
import type { BossBar } from '../ui/BossBar';

/** Salt for the boss stream — distinct from every other system salt. */
export const BOSS_SALT = 0xb055;

/** Telegraphed attack shapes. */
export type BossAttackKind = 'nova' | 'ring' | 'beam';

export interface BossAttackDef {
  id: string;
  name: string;
  kind: BossAttackKind;
  /** seconds between attacks (uniform roll per attack start). */
  cooldownMin: number;
  cooldownMax: number;
  /** telegraph duration (ms) before the damage resolves. */
  windupMs: number;
  /** base damage, multiplied by the phase's damageMult. */
  damage: number;
  /**
   * nova: blast radius around the boss; ring: shockwave max radius;
   * beam: half-width of the beam strip.
   */
  radius: number;
  /** beam: strip length (default 26). */
  range?: number;
  /** windup flash tint on the boss body (carries the attack identity). */
  flashColor: string;
  /** ground-decal color for the damage zone. */
  telegraphColor: string;
}

export interface BossPhaseDef {
  /** phase is active while hpFrac <= atHpFrac; phases sorted descending. */
  atHpFrac: number;
  name: string;
  speedMult: number;
  damageMult: number;
  /** attack ids available in this phase. */
  attacks: string[];
}

export interface BossDef {
  id: string;
  name: string;
  /** × the spawned brute's health, applied once at bind. */
  healthMult: number;
  /** default arena radius (m); spec.custom.boss.arenaRadius overrides. */
  arenaRadius: number;
  /** intro banner body shown when the encounter binds. */
  intro: string;
  /** descending atHpFrac; [0] must be atHpFrac 1. */
  phases: BossPhaseDef[];
}

/**
 * The single tuning table — every boss, every phase, every telegraphed
 * attack. Thresholds mirror EnemyAI's phase transitions (66% / 33%).
 */
export const BOSS_DEFS: Record<string, BossDef> = {
  'the-warden': {
    id: 'the-warden',
    name: 'THE WARDEN',
    healthMult: 1.25,
    arenaRadius: 26,
    intro: 'Something ancient stirs in the arena. End it.',
    phases: [
      {
        atHpFrac: 1, name: 'Dormant Fury', speedMult: 1.0, damageMult: 1.0,
        attacks: ['warden-slam'],
      },
      {
        atHpFrac: 0.66, name: 'Enraged', speedMult: 1.15, damageMult: 1.25,
        attacks: ['warden-slam', 'warden-shockwave'],
      },
      {
        atHpFrac: 0.33, name: 'Desperate', speedMult: 1.3, damageMult: 1.5,
        attacks: ['warden-slam', 'warden-shockwave', 'warden-beam'],
      },
    ],
  },
  'ember-titan': {
    id: 'ember-titan',
    name: 'EMBER TITAN',
    healthMult: 1.6,
    arenaRadius: 32,
    intro: 'The ground cracks with molten fury. Do not stand still.',
    phases: [
      {
        atHpFrac: 1, name: 'Smoldering', speedMult: 0.9, damageMult: 1.1,
        attacks: ['titan-slam'],
      },
      {
        atHpFrac: 0.66, name: 'Erupting', speedMult: 1.0, damageMult: 1.35,
        attacks: ['titan-slam', 'titan-shockwave'],
      },
      {
        atHpFrac: 0.33, name: 'Cataclysm', speedMult: 1.1, damageMult: 1.6,
        attacks: ['titan-slam', 'titan-shockwave', 'titan-inferno'],
      },
    ],
  },
  'void-herald': {
    id: 'void-herald',
    name: 'VOID HERALD',
    healthMult: 0.9,
    arenaRadius: 24,
    intro: 'It speaks in static. The void is watching.',
    phases: [
      {
        atHpFrac: 1, name: 'Coalescing', speedMult: 1.1, damageMult: 0.9,
        attacks: ['herald-beam'],
      },
      {
        atHpFrac: 0.66, name: 'Unraveling', speedMult: 1.2, damageMult: 1.1,
        attacks: ['herald-beam', 'herald-shockwave'],
      },
      {
        atHpFrac: 0.33, name: 'Event Horizon', speedMult: 1.35, damageMult: 1.4,
        attacks: ['herald-beam', 'herald-shockwave', 'herald-collapse'],
      },
    ],
  },
};

/** Attack-pattern catalog — every telegraph's tuning in one place. */
export const BOSS_ATTACKS: Record<string, BossAttackDef> = {
  'warden-slam': {
    id: 'warden-slam', name: 'Seismic Slam', kind: 'nova',
    cooldownMin: 4, cooldownMax: 7, windupMs: 900, damage: 18, radius: 9,
    flashColor: '#ff3b1f', telegraphColor: '#ff5030',
  },
  'warden-shockwave': {
    id: 'warden-shockwave', name: 'Shockwave', kind: 'ring',
    cooldownMin: 6, cooldownMax: 10, windupMs: 1100, damage: 14, radius: 16,
    flashColor: '#ff8a00', telegraphColor: '#ff9a3c',
  },
  'warden-beam': {
    id: 'warden-beam', name: 'Ember Beam', kind: 'beam',
    cooldownMin: 8, cooldownMax: 12, windupMs: 1300, damage: 24, radius: 2.2,
    range: 30, flashColor: '#ff00a8', telegraphColor: '#ff5bd0',
  },
  'titan-slam': {
    id: 'titan-slam', name: 'Magma Slam', kind: 'nova',
    cooldownMin: 3.5, cooldownMax: 6, windupMs: 1000, damage: 22, radius: 11,
    flashColor: '#ff5a00', telegraphColor: '#ff7a2a',
  },
  'titan-shockwave': {
    id: 'titan-shockwave', name: 'Eruption Ring', kind: 'ring',
    cooldownMin: 6, cooldownMax: 9, windupMs: 1200, damage: 18, radius: 20,
    flashColor: '#ffb300', telegraphColor: '#ffcf4d',
  },
  'titan-inferno': {
    id: 'titan-inferno', name: 'Inferno Nova', kind: 'nova',
    cooldownMin: 9, cooldownMax: 13, windupMs: 1400, damage: 30, radius: 14,
    flashColor: '#ff2200', telegraphColor: '#ff4422',
  },
  'herald-beam': {
    id: 'herald-beam', name: 'Void Lance', kind: 'beam',
    cooldownMin: 4, cooldownMax: 7, windupMs: 1100, damage: 20, radius: 1.8,
    range: 34, flashColor: '#a64dff', telegraphColor: '#c07aff',
  },
  'herald-shockwave': {
    id: 'herald-shockwave', name: 'Unraveling', kind: 'ring',
    cooldownMin: 7, cooldownMax: 11, windupMs: 1200, damage: 16, radius: 18,
    flashColor: '#7a2bff', telegraphColor: '#9a5bff',
  },
  'herald-collapse': {
    id: 'herald-collapse', name: 'Collapse', kind: 'nova',
    cooldownMin: 10, cooldownMax: 14, windupMs: 1500, damage: 34, radius: 12,
    flashColor: '#3b00ff', telegraphColor: '#5b2bff',
  },
};

/** Default boss when spec.custom.boss.bossId is absent or unknown. */
export const DEFAULT_BOSS_ID = 'the-warden';

/** True when the spec has any boss objective stage (quest chain or legacy). */
export function specHasBossStage(spec: GameSpec): boolean {
  if (spec.objective.type === 'boss') return true;
  return !!spec.objective.stages?.some((s: ObjectiveStage) => s.type === 'boss');
}

/**
 * The generator flag: boss fights are enabled when spec.custom.boss.enabled
 * is set, else whenever the spec has a boss stage. Explicit false keeps
 * the legacy melee-only brute behavior on boss stages.
 */
export function bossEnabled(spec: GameSpec): boolean {
  return spec.custom?.boss?.enabled ?? specHasBossStage(spec);
}

/** Resolve the boss def for a spec (unknown ids fall back to the default). */
export function resolveBossDef(spec: GameSpec): BossDef {
  const id = spec.custom?.boss?.bossId ?? DEFAULT_BOSS_ID;
  return BOSS_DEFS[id] ?? BOSS_DEFS[DEFAULT_BOSS_ID];
}

/** Arena radius for a spec (author override wins, else the def default). */
export function resolveArenaRadius(spec: GameSpec): number {
  const def = resolveBossDef(spec);
  const r = spec.custom?.boss?.arenaRadius;
  return typeof r === 'number' && r > 0 ? r : def.arenaRadius;
}

export interface BossArena { x: number; z: number; radius: number }

/**
 * PURE: arena placement from the map seed alone — Rng(mapSeed ^ BOSS_SALT).
 * The arena rings 70-110m from the spawn point so the player never starts
 * inside it. Same mapSeed -> identical arena.
 */
export function planBossArena(mapSeed: number, radius: number): BossArena {
  const rng = new Rng((mapSeed ^ BOSS_SALT) >>> 0);
  const ang = rng.range(0, Math.PI * 2);
  const dist = rng.range(70, 110);
  return { x: Math.cos(ang) * dist, z: Math.sin(ang) * dist, radius };
}

/**
 * Deepest phase whose threshold covers the current hp fraction.
 * Phases are sorted descending by atHpFrac; index 0 always matches.
 */
export function phaseIndexFor(def: BossDef, hpFrac: number): number {
  let idx = 0;
  for (let i = 0; i < def.phases.length; i++) {
    if (hpFrac <= def.phases[i].atHpFrac) idx = i;
  }
  return idx;
}

/**
 * PURE: pick the next attack for a phase from the seeded stream. Consumes
 * exactly one rng.int — the encounter's attack sequence is deterministic
 * in (mapSeed, boss order, attack count).
 */
export function pickNextAttack(rng: Rng, def: BossDef, phaseIdx: number): BossAttackDef {
  const phase = def.phases[phaseIdx] ?? def.phases[0];
  const atk = BOSS_ATTACKS[phase.attacks[rng.int(0, phase.attacks.length - 1)]];
  return atk ?? BOSS_ATTACKS[def.phases[0].attacks[0]];
}

/** PURE: roll the cooldown for an attack start (seconds). */
export function rollCooldown(rng: Rng, atk: BossAttackDef): number {
  return rng.range(atk.cooldownMin, atk.cooldownMax);
}

/** PURE: point-in-zone test for a resolved attack (unit-testable). */
export function attackHitsPlayer(
  atk: BossAttackDef,
  origin: { x: number; z: number },
  target: { x: number; z: number } | null,
  player: { x: number; z: number },
): boolean {
  if (atk.kind === 'nova') {
    return Math.hypot(player.x - origin.x, player.z - origin.z) <= atk.radius;
  }
  if (atk.kind === 'beam' && target) {
    const dx = target.x - origin.x, dz = target.z - origin.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6
      ? Math.max(0, Math.min(1, ((player.x - origin.x) * dx + (player.z - origin.z) * dz) / len2))
      : 0;
    const cx = origin.x + dx * t, cz = origin.z + dz * t;
    return Math.hypot(player.x - cx, player.z - cz) <= atk.radius;
  }
  return false; // 'ring' resolves via the expanding-front check in update()
}

export interface BossEncounterOpts {
  manager: EnemyManager;
  terrain: { heightAt(x: number, z: number): number };
  onPlayerHit: (damage: number, from: THREE.Vector3) => void;
  /** boss bar UI (blueprint-owned); null = headless (unit tests). */
  bar?: BossBar | null;
}

interface Windup {
  attack: BossAttackDef;
  elapsed: number; // seconds
  target: THREE.Vector3; // locked player pos for beam; boss pos for nova/ring
  telegraph: THREE.Object3D | null;
  flashT: number;
}

interface Shockwave {
  mesh: THREE.Mesh;
  front: number; // current front distance from the boss
  speed: number;
  radius: number;
  damage: number;
  hit: boolean;
  origin: THREE.Vector3;
}

interface Burst {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  maxR: number;
}

interface BossBind {
  enemy: Enemy;
  def: BossDef;
  rng: Rng;
  baseSpeed: number;
  phaseIdx: number;
  attackCd: number;
  windup: Windup | null;
  teleported: boolean;
  healthScaled: boolean;
}

/**
 * Map-local boss encounter (id 'boss'). Drives the arena, the telegraphed
 * attack scheduler, and the boss bar for the currently-bound boss.
 */
export class BossEncounter implements MapLocalEntitySystem {
  readonly id = 'boss';
  private arena: (BossArena & { y: number }) | null = null;
  private arenaGroup: THREE.Group | null = null;
  private bind: BossBind | null = null;
  private bindsThisMap = 0;
  private shockwaves: Shockwave[] = [];
  private bursts: Burst[] = [];
  private mapSeed = 0;
  private active = false;
  private disposed = false;
  private untapKill: (() => void) | null = null;
  // --- open-field mode (wandering world-boss wave; see header) ---
  private openField = false;
  private fieldDef: BossDef | null = null;
  private waypoints: THREE.Vector3[] = [];
  private wpIndex = 0;

  constructor(
    private engine: Engine,
    private opts: BossEncounterOpts,
  ) {
    // Synchronous death handling: the update() unbind only runs while the
    // engine is 'playing' — a boss kill that ends the run (VICTORY) would
    // otherwise leave the bar on screen over the end panel. onKill fires
    // inside the die() path itself, so the bar hides immediately.
    this.untapKill = engine.hooks.tap('onKill', ({ enemy }) => {
      if (this.bind && enemy === this.bind.enemy) this.unbind();
    });
  }

  /** The live arena (null when the flag is off or before spawnForMap). */
  get liveArena(): BossArena | null { return this.arena; }
  /** True when running in open-field (world-boss) mode — no arena exists. */
  get isOpenField(): boolean { return this.openField; }
  /** The currently-bound boss (null when none). */
  get liveBoss(): Enemy | null { return this.bind?.enemy ?? null; }
  get isActive(): boolean { return this.active; }
  /**
   * Diagnostic counters (test seams + perf honesty): attacks started
   * (telegraph shown) vs resolved (damage applied). Never gameplay.
   */
  readonly stats = { attacksStarted: 0, attacksResolved: 0 };

  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    this.mapSeed = mapSeed;
    this.bindsThisMap = 0;
    const spec = this.engine.spec;
    // WANDERING WORLD-BOSS: when the world-boss event owns this map, the
    // arena encounter stands down entirely — one boss, one owner, no
    // double health-scaling or double telegraphs on the same brute.
    if (spec.custom?.worldBoss?.enabled === true) return;
    if (!bossEnabled(spec)) return;
    const def = resolveBossDef(spec);
    const radius = resolveArenaRadius(spec);
    const a = planBossArena(mapSeed, radius);
    const y = this.opts.terrain.heightAt(a.x, a.z);
    this.arena = { ...a, y };
    this.arenaGroup = this.buildArenaVisual(a, y, def);
    this.engine.scene.add(this.arenaGroup);
    this.active = true;
  }

  /**
   * WANDERING WORLD-BOSS: open-field mode. No arena visuals, no tether —
   * the bound boss roams `waypoints` (steered via the public `home`) and
   * the telegraphed attack scheduler runs unchanged. The def comes from
   * the world-boss plan, not from spec.custom.boss. Idempotent: a prior
   * arena or open-field run is fully despawned first.
   */
  spawnOpenField(mapSeed: number, def: BossDef, waypoints: THREE.Vector3[]): void {
    this.despawnAll();
    this.mapSeed = mapSeed;
    this.bindsThisMap = 0;
    this.openField = true;
    this.fieldDef = def;
    this.waypoints = waypoints.map((w) => w.clone());
    this.wpIndex = 0;
    this.active = true;
  }

  despawnAll(): void {
    if (this.arenaGroup) {
      this.engine.scene.remove(this.arenaGroup);
      disposeGroup(this.arenaGroup);
      this.arenaGroup = null;
    }
    this.clearWindup();
    for (const s of this.shockwaves) { this.engine.scene.remove(s.mesh); disposeMesh(s.mesh); }
    for (const b of this.bursts) { this.engine.scene.remove(b.mesh); disposeMesh(b.mesh); }
    this.shockwaves = [];
    this.bursts = [];
    this.bind = null;
    this.arena = null;
    this.active = false;
    this.openField = false;
    this.fieldDef = null;
    this.waypoints = [];
    this.wpIndex = 0;
    this.opts.bar?.hide();
  }

  /** Blueprint tick — call after enemies.update(). */
  update(dt: number, playerPos: THREE.Vector3): void {
    if (this.disposed || !this.active) return;
    this.lastPlayerPos = playerPos;
    this.tickFx(dt);
    // lazy bind: the first living isBoss brute becomes THE boss
    if (!this.bind) this.tryBind();
    const b = this.bind;
    if (!b) return;
    if (!b.enemy.alive) { this.unbind(); return; }
    if (!b.teleported) this.teleportToArena(b);
    if (!b.healthScaled) this.scaleHealth(b);
    this.updateBar(b);
    if (this.openField) this.steerPatrol(b, playerPos);
    const dist = b.enemy.position.distanceTo(playerPos);
    // attacks only run in combat range — no telegraphs across the map
    if (dist > 60) { this.clearWindup(); return; }
    if (b.windup) { this.tickWindup(b, dt, playerPos); return; }
    b.attackCd -= dt;
    if (b.attackCd <= 0) this.startAttack(b, playerPos);
  }

  dispose(): void {
    this.disposed = true;
    this.untapKill?.();
    this.untapKill = null;
    this.despawnAll();
  }

  // ---------------------------------------------------------- internals

  private tryBind(): void {
    const e = this.opts.manager.enemies.find((x) => x.isBoss && x.alive);
    if (!e) return;
    // open-field mode: the def is the world-boss plan's def, not the
    // spec's arena def (the arena flag may be off entirely).
    const def = this.openField && this.fieldDef ? this.fieldDef : resolveBossDef(this.engine.spec);
    this.bind = {
      enemy: e,
      def,
      rng: new Rng((this.mapSeed ^ BOSS_SALT ^ (this.bindsThisMap * 0x9e37)) >>> 0),
      baseSpeed: e.spec.speed,
      phaseIdx: 0,
      attackCd: 2.0, // opening beat before the first telegraph
      windup: null,
      teleported: false,
      healthScaled: false,
    };
    this.bindsThisMap++;
    this.engine.hud.showCard(def.name, def.intro);
    this.engine.audio.play('alarm');
    this.opts.bar?.show(def.name);
  }

  private unbind(): void {
    this.clearWindup();
    this.opts.bar?.hide();
    this.bind = null;
  }

  private teleportToArena(b: BossBind): void {
    // open-field mode: no tether — the boss stays where the world-boss
    // event spawned it and roams from there (home already = spawn).
    if (this.openField || !this.arena) { b.teleported = true; return; }
    const a = this.arena!;
    const e = b.enemy;
    if (e.body) {
      e.body.position.set(a.x, a.y + 2, a.z);
      e.body.velocity.set(0, 0, 0);
      e.body.angularVelocity.set(0, 0, 0);
    }
    e.home.set(a.x, a.y, a.z);
    b.teleported = true;
  }

  /**
   * WANDERING WORLD-BOSS: patrol steering, the dynamic-events patrol
   * pattern — re-point the public `home` so an idle (non-aggroed) boss
   * wanders the seeded waypoint loop. Only steers while the player is
   * beyond 26m; in combat the boss's own chase/attack AI owns movement.
   * No EnemyAI internals are touched.
   */
  private steerPatrol(b: BossBind, playerPos: THREE.Vector3): void {
    if (this.waypoints.length === 0) return;
    if (b.enemy.position.distanceTo(playerPos) <= 26) return;
    const wp = this.waypoints[this.wpIndex];
    if (b.enemy.position.distanceTo(wp) < 5) {
      this.wpIndex = (this.wpIndex + 1) % this.waypoints.length;
    }
    const target = this.waypoints[this.wpIndex];
    b.enemy.home.set(target.x, this.opts.terrain.heightAt(target.x, target.z) + 1, target.z);
  }

  private scaleHealth(b: BossBind): void {
    const e = b.enemy;
    e.maxHealth = Math.max(1, Math.round(e.maxHealth * b.def.healthMult));
    e.health = e.maxHealth;
    b.healthScaled = true;
  }

  private updateBar(b: BossBind): void {
    const bar = this.opts.bar;
    if (!bar) return;
    const frac = b.enemy.health / Math.max(1, b.enemy.maxHealth);
    const phaseIdx = phaseIndexFor(b.def, frac);
    if (phaseIdx !== b.phaseIdx) {
      b.phaseIdx = phaseIdx;
      // phase speed tuning is real: scale the brute's chase speed
      b.enemy.spec = { ...b.enemy.spec, speed: b.baseSpeed * b.def.phases[phaseIdx].speedMult };
    }
    bar.setHealth(frac);
    bar.setPhase(b.def.phases[phaseIdx].name);
  }

  private startAttack(b: BossBind, playerPos: THREE.Vector3): void {
    const attack = pickNextAttack(b.rng, b.def, b.phaseIdx);
    b.attackCd = rollCooldown(b.rng, attack);
    const origin = b.enemy.position;
    const target = attack.kind === 'beam'
      ? playerPos.clone()
      : new THREE.Vector3(origin.x, origin.y, origin.z);
    const telegraph = this.buildTelegraph(attack, origin, target);
    if (telegraph) this.engine.scene.add(telegraph);
    b.windup = { attack, elapsed: 0, target, telegraph, flashT: 0 };
    this.stats.attacksStarted++;
  }

  private tickWindup(b: BossBind, dt: number, playerPos: THREE.Vector3): void {
    const w = b.windup!;
    w.elapsed += dt;
    // windup flash on the boss — the established hit-flash language,
    // pulsing while the ground decal shows the damage zone
    w.flashT -= dt;
    if (w.flashT <= 0) {
      w.flashT = 0.12;
      b.enemy.rig?.flash();
      b.enemy.instancer?.flash(b.enemy);
    }
    if (w.telegraph) {
      const m = (w.telegraph as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (m && 'opacity' in m) m.opacity = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(w.elapsed * 25));
    }
    if (w.elapsed * 1000 >= w.attack.windupMs) this.resolveAttack(b, playerPos);
  }

  private resolveAttack(b: BossBind, playerPos: THREE.Vector3): void {
    const w = b.windup!;
    b.windup = null;
    this.stats.attacksResolved++;
    if (w.telegraph) { this.engine.scene.remove(w.telegraph); disposeGroup(w.telegraph); }
    const origin = b.enemy.position;
    const dmgMult = b.def.phases[b.phaseIdx].damageMult;
    const damage = Math.round(w.attack.damage * dmgMult);
    const atk = w.attack;
    if (atk.kind === 'nova') {
      this.spawnBurst(origin, atk.radius, flashColorFor(atk));
      if (attackHitsPlayer(atk, { x: origin.x, z: origin.z }, null, { x: playerPos.x, z: playerPos.z })) {
        this.opts.onPlayerHit(damage, origin);
      }
    } else if (atk.kind === 'beam') {
      this.spawnBurst(origin, atk.radius, flashColorFor(atk)); // impact flash at the muzzle
      this.spawnBeamFlash(origin, w.target, atk);
      if (attackHitsPlayer(atk, { x: origin.x, z: origin.z }, { x: w.target.x, z: w.target.z }, { x: playerPos.x, z: playerPos.z })) {
        this.opts.onPlayerHit(damage, origin);
      }
    } else {
      // ring: the damage resolves when the expanding front reaches the player
      this.spawnShockwave(origin, atk, damage);
    }
  }

  private tickFx(dt: number): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.front += s.speed * dt;
      const k = Math.min(1, s.front / s.radius);
      s.mesh.scale.set(Math.max(0.001, k), 1, Math.max(0.001, k));
      // the player takes the hit once, as the front crosses them
      if (!s.hit && this.lastPlayerPos) {
        const d = Math.hypot(
          this.lastPlayerPos.x - s.origin.x,
          this.lastPlayerPos.z - s.origin.z,
        );
        if (Math.abs(d - s.front) < 1.6 && s.front <= s.radius) {
          s.hit = true;
          this.opts.onPlayerHit(s.damage, s.origin);
        }
      }
      if (s.front >= s.radius) {
        this.engine.scene.remove(s.mesh);
        disposeMesh(s.mesh);
        this.shockwaves.splice(i, 1);
      }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.t += dt;
      const k = Math.min(1, b.t / b.dur);
      b.mesh.scale.set(Math.max(0.001, k), 1, Math.max(0.001, k));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
      if (k >= 1) {
        this.engine.scene.remove(b.mesh);
        disposeMesh(b.mesh);
        this.bursts.splice(i, 1);
      }
    }
  }

  /** Player pos cached for the shockwave front check (set by update()). */
  private lastPlayerPos: THREE.Vector3 | null = null;

  private clearWindup(): void {
    const w = this.bind?.windup;
    if (w?.telegraph) { this.engine.scene.remove(w.telegraph); disposeGroup(w.telegraph); }
    if (this.bind) this.bind.windup = null;
  }

  // ---------------------------------------------------------- visuals

  private buildArenaVisual(a: BossArena, y: number, def: BossDef): THREE.Group {
    const g = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(a.radius - 1.2, a.radius + 1.2, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: '#ffb545', transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    ring.position.set(a.x, y + 0.25, a.z);
    g.add(ring);
    // voxel/blocky pylons with amber emissive caps — the art-direction accent
    const pylonGeo = new THREE.BoxGeometry(1.4, 4, 1.4);
    const capGeo = new THREE.BoxGeometry(1.7, 0.6, 1.7);
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const px = a.x + Math.cos(ang) * a.radius;
      const pz = a.z + Math.sin(ang) * a.radius;
      const py = this.opts.terrain.heightAt(px, pz);
      const pylon = new THREE.Mesh(pylonGeo, new THREE.MeshStandardMaterial({
        color: '#2a2f3a', roughness: 0.8, metalness: 0.2,
      }));
      pylon.position.set(px, py + 2, pz);
      const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({
        color: '#ffb545', emissive: '#ffb545', emissiveIntensity: 1.6,
      }));
      cap.position.set(px, py + 4.2, pz);
      g.add(pylon, cap);
    }
    g.userData.bossName = def.name;
    return g;
  }

  private groundY(x: number, z: number): number {
    return this.opts.terrain.heightAt(x, z) + 0.22;
  }

  private buildTelegraph(attack: BossAttackDef, origin: THREE.Vector3, target: THREE.Vector3): THREE.Object3D | null {
    const mat = new THREE.MeshBasicMaterial({
      color: telegraphColorFor(attack), transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false,
    });
    if (attack.kind === 'nova' || attack.kind === 'ring') {
      const geo = new THREE.RingGeometry(attack.radius * 0.8, attack.radius, 48);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(origin.x, this.groundY(origin.x, origin.z), origin.z);
      return m;
    }
    // beam: strip from the boss to the locked target
    const dx = target.x - origin.x, dz = target.z - origin.z;
    const len = Math.min(Math.hypot(dx, dz), attack.range ?? 26);
    if (len < 1) return null;
    const geo = new THREE.PlaneGeometry(attack.radius * 2, len);
    geo.rotateX(-Math.PI / 2); // length now along -Z
    geo.translate(0, 0, -len / 2); // spans origin -> -Z
    const m = new THREE.Mesh(geo, mat);
    m.position.set(origin.x, this.groundY(origin.x, origin.z), origin.z);
    m.rotation.y = Math.atan2(-dx, -dz); // -Z toward the target
    return m;
  }

  private spawnBurst(origin: THREE.Vector3, radius: number, color: string): void {
    const geo = new THREE.RingGeometry(radius * 0.85, radius, 48);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.position.set(origin.x, this.groundY(origin.x, origin.z), origin.z);
    mesh.scale.set(0.001, 1, 0.001);
    this.engine.scene.add(mesh);
    this.bursts.push({ mesh, t: 0, dur: 0.4, maxR: radius });
  }

  private spawnBeamFlash(origin: THREE.Vector3, target: THREE.Vector3, attack: BossAttackDef): void {
    const dx = target.x - origin.x, dz = target.z - origin.z;
    const len = Math.min(Math.hypot(dx, dz), attack.range ?? 26);
    if (len < 1) return;
    const geo = new THREE.PlaneGeometry(attack.radius * 2.6, len);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -len / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: flashColorFor(attack), transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    mesh.position.set(origin.x, this.groundY(origin.x, origin.z) + 0.6, origin.z);
    mesh.rotation.y = Math.atan2(-dx, -dz);
    this.engine.scene.add(mesh);
    this.bursts.push({ mesh, t: 0, dur: 0.45, maxR: len });
  }

  private spawnShockwave(origin: THREE.Vector3, attack: BossAttackDef, damage: number): void {
    const geo = new THREE.RingGeometry(attack.radius * 0.9, attack.radius, 48);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: telegraphColorFor(attack), transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.position.set(origin.x, this.groundY(origin.x, origin.z), origin.z);
    mesh.scale.set(0.001, 1, 0.001);
    this.engine.scene.add(mesh);
    this.shockwaves.push({
      mesh, front: 0, speed: 16, radius: attack.radius, damage,
      hit: false, origin: origin.clone(),
    });
  }
}

function disposeMesh(m: THREE.Mesh): void {
  m.geometry.dispose();
  const mat = m.material as THREE.Material | THREE.Material[];
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat.dispose();
}

function disposeGroup(g: THREE.Group | THREE.Object3D): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) disposeMesh(mesh);
  });
}
