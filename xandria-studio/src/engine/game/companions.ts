/**
 * UPGRADE LOOP (companion-system): data-driven companion followers.
 *
 * Three seeded companions — a melee brawler, a ranged caster, and a
 * healer aura — summoned from a panel, following the player at a
 * seeded-safe offset, fighting beside them, and surviving portal travel
 * and save/reload as player-scoped state.
 *
 * DETERMINISM: damage variance, heal variance and follow jitter all
 * derive from (mapSeed, attack/heal index) via Rng — never engine.rng,
 * never Math.random, never Date.now. Same seed + same action sequence
 * -> identical damage/heal rolls and identical follow offsets.
 *
 * ENEMY CONTRACT: untouched. Companion attacks call the EXISTING
 * Enemy.damage() path (the same method player melee/projectiles use),
 * so a companion kill flows through the existing EnemyManager.onDeath
 * path: loot rolls, currency rolls, quest hooks, standings, and the
 * blueprint's grantKillXp all fire exactly as for a player kill — the
 * companion kill is credited to the player by construction, with no
 * special-casing and no enemy/NPC behavior change. Enemies never target
 * companions (no lureTarget-style hook is added); companion targeting
 * is an ADDITIVE weight on the companion's own side only: the nearest
 * enemy wins, with a small bonus for wounded targets
 * (score = distance - (1 - hpFrac) * WOUND_BONUS).
 *
 * RENDERING: companions ride the shared per-engine NpcInstancer through
 * the owner-agnostic registerEnemy({ renderRoot }) path (the deployables
 * pattern). Voxel bodies use the shared VoxelGeoCache + per-biome
 * palettes + the existing amber emissive accent role — zero new
 * materials, zero new textures.
 *
 * PORTAL LIFECYCLE: CompanionsManager implements MapLocalEntitySystem
 * (id 'companions'). The RENDERED companion is map-local (despawned on
 * departure, respawned on arrival from the player-scoped roster), but
 * the ROSTER itself — def, custom name, hp, active id — is player state
 * and survives: it is never cleared by despawnAll(), and the blueprint
 * persists it into the active save slot's profile on every roster
 * mutation (summon/select/rename/dismiss/heal-at-campfire).
 *
 * CAMPFIRE HOOK: the blueprint wires the deployables campfire heal
 * callback through companions.healActive(), so a live campfire's ticks
 * heal the following companion as well as the player (the companion
 * follows within 5m of the player, inside the campfire's 6m radius by
 * construction). The panel's "Heal at campfire" button is the explicit
 * form of the same hook: it fully heals the active companion only while
 * a campfire deployable is live, and refuses honestly otherwise.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { NpcInstancer } from './npcInstancing';
import {
  voxelBoxCacheFor,
  paletteFor,
  voxelPart,
  type VoxelPalette,
  type VoxelGeoCache,
  type VoxelBuildCtx,
} from './voxelGeo';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import type { Enemy } from './EnemyAI';

/** Salt for the companion stream — off the DEPLOY/GATHER/ENEMY streams. */
export const COMPANION_SALT = 0xc0ff1e;

/** Wounded-target bonus (meters) in the companion target score. */
export const COMPANION_WOUND_BONUS = 2.5;

export type CompanionRole = 'melee' | 'ranged' | 'aura';

/**
 * Data-driven companion def. ALL tuning lives here — the manager, the
 * panel and the e2e/perf harnesses read this table, never magic numbers.
 */
export interface CompanionDef {
  /** stable companion id */
  id: string;
  /** default display name (renameable per roster entry) */
  name: string;
  role: CompanionRole;
  /** follow distance from the player, meters */
  followDist: number;
  /** follow angle around the player, radians (0 = behind, + = left) */
  followAngle: number;
  /** attack range from the companion, meters (0 = non-attacker) */
  attackRange: number;
  /** base damage per hit (0 = non-attacker) */
  damage: number;
  /** seeded +0..variance added to damage per hit */
  damageVariance: number;
  /** seconds between attacks */
  attackInterval: number;
  /** heal radius around the companion, meters (0 = non-healer) */
  healRadius: number;
  /** base heal per tick to the player (0 = non-healer) */
  heal: number;
  /** seeded +0..variance added to heal per tick */
  healVariance: number;
  /** seconds between heal ticks */
  healInterval: number;
  /** companion max HP */
  maxHp: number;
  desc: string;
}

export const COMPANION_DEFS: readonly CompanionDef[] = [
  {
    id: 'brawler',
    name: 'Brak',
    role: 'melee',
    followDist: 2.4,
    followAngle: -2.4,
    attackRange: 3.0,
    damage: 14,
    damageVariance: 4,
    attackInterval: 0.9,
    healRadius: 0,
    heal: 0,
    healVariance: 0,
    healInterval: 0,
    maxHp: 120,
    desc: 'Melee brawler. Stays close and bashes whatever gets near you.',
  },
  {
    id: 'caster',
    name: 'Vex',
    role: 'ranged',
    followDist: 5.0,
    followAngle: 2.6,
    attackRange: 15,
    damage: 10,
    damageVariance: 3,
    attackInterval: 1.3,
    healRadius: 0,
    heal: 0,
    healVariance: 0,
    healInterval: 0,
    maxHp: 70,
    desc: 'Ranged caster. Hangs back and chips enemies from range.',
  },
  {
    id: 'healer',
    name: 'Moth',
    role: 'aura',
    followDist: 3.2,
    followAngle: 0.4,
    attackRange: 0,
    damage: 0,
    damageVariance: 0,
    attackInterval: 0,
    healRadius: 6,
    heal: 4,
    healVariance: 1,
    healInterval: 1.0,
    maxHp: 80,
    desc: 'Healer aura. Mends you every second while you stay close.',
  },
];

export function companionDefOf(id: string): CompanionDef | undefined {
  return COMPANION_DEFS.find((d) => d.id === id);
}

/** One roster entry: player-scoped companion state (persisted). */
export interface CompanionState {
  defId: string;
  /** custom name (defaults to the def name, renameable in the panel) */
  name: string;
  hp: number;
}

/** Persisted companion save shape (rides the profile's companions field). */
export interface CompanionSave {
  activeId: string | null;
  roster: CompanionState[];
}

/** Pure seeded damage roll: base + rng.int(0, variance). */
export function rollCompanionDamage(
  def: CompanionDef,
  seed: number,
  attackIndex: number,
): number {
  const rng = new Rng((seed ^ COMPANION_SALT ^ Math.imul(attackIndex + 1, 0x9e3779b1)) >>> 0);
  return def.damage + rng.int(0, def.damageVariance);
}

/** Pure seeded heal roll: base + rng.int(0, variance). */
export function rollCompanionHeal(
  def: CompanionDef,
  seed: number,
  healIndex: number,
): number {
  const rng = new Rng((seed ^ COMPANION_SALT ^ 0x51ab ^ Math.imul(healIndex + 1, 0x85ebca6b)) >>> 0);
  return def.heal + rng.int(0, def.healVariance);
}

/**
 * Pure seeded follow offset: the def's angle/distance plus a small
 * stored jitter (same summon sequence on the same map -> identical
 * offset). The jitter is drawn ONCE at summon and stored on the
 * entity, so the companion does not wander frame to frame.
 */
export function rollFollowOffset(
  def: CompanionDef,
  seed: number,
): { angle: number; dist: number } {
  const rng = new Rng((seed ^ COMPANION_SALT ^ 0xf011) >>> 0);
  return {
    angle: def.followAngle + rng.range(-0.35, 0.35),
    dist: def.followDist + rng.range(-0.4, 0.4),
  };
}

/** Minimal target shape for the companion's own target selection. */
export interface CompanionTarget {
  position: THREE.Vector3;
  alive: boolean;
  health: number;
  maxHealth: number;
}

/**
 * Companion target pick: nearest alive enemy in range, with the additive
 * wounded-target weight (score = distance - (1 - hpFrac) * bonus).
 * Pure over the candidate list — the e2e/unit harness replays it exactly.
 * Returns null when nothing is in range.
 */
export function pickCompanionTarget(
  candidates: readonly CompanionTarget[],
  from: THREE.Vector3,
  range: number,
): CompanionTarget | null {
  let best: CompanionTarget | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c.alive) continue;
    const dist = c.position.distanceTo(from);
    if (dist > range) continue;
    const hpFrac = c.maxHealth > 0 ? c.health / c.maxHealth : 1;
    const score = dist - (1 - hpFrac) * COMPANION_WOUND_BONUS;
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Voxel builders — one small blocky figure per role, shared palette roles
// ---------------------------------------------------------------------------

interface BuildCtx extends VoxelBuildCtx {
  pal: VoxelPalette;
  rng: Rng;
}

function buildCompanionFigure(ctx: BuildCtx, g: THREE.Group, def: CompanionDef): void {
  const p = ctx.pal;
  // legs
  voxelPart(ctx, g, 0.22, 0.5, 0.22, p.woodDark, 0.9, -0.16, 0.25, 0);
  voxelPart(ctx, g, 0.22, 0.5, 0.22, p.woodDark, 0.9, 0.16, 0.25, 0);
  // torso
  voxelPart(ctx, g, 0.62, 0.7, 0.34, p.rockDark, 0.9, 0, 0.85, 0);
  // head + glowing visor slit (the art-direction signature)
  voxelPart(ctx, g, 0.5, 0.42, 0.42, p.rock, 0.9, 0, 1.42, 0);
  voxelPart(ctx, g, 0.4, 0.08, 0.06, '', 0.3, 0, 1.45, 0.22, { amber: true, shadow: false });
  if (def.role === 'melee') {
    // heavy fists
    voxelPart(ctx, g, 0.3, 0.3, 0.3, p.metal, 0.6, -0.42, 0.85, 0.1);
    voxelPart(ctx, g, 0.3, 0.3, 0.3, p.metal, 0.6, 0.42, 0.85, 0.1);
  } else if (def.role === 'ranged') {
    // staff with amber tip
    voxelPart(ctx, g, 0.1, 1.3, 0.1, p.wood, 0.9, 0.4, 1.0, 0);
    voxelPart(ctx, g, 0.2, 0.2, 0.2, '', 0.3, 0.4, 1.72, 0, { amber: true, shadow: false });
  } else {
    // healer halo disc (small — NOT a full-radius slab; see perf table)
    voxelPart(ctx, g, 1.2, 0.06, 1.2, '', 0.3, 0, 0.06, 0, { amber: true, shadow: false });
  }
}

// ---------------------------------------------------------------------------
// Companion — one live rendered follower
// ---------------------------------------------------------------------------

export class Companion {
  readonly def: CompanionDef;
  readonly root = new THREE.Group();
  readonly seed: number;
  /** stored seeded follow offset (drawn once at summon) */
  readonly follow: { angle: number; dist: number };

  /** The instancible render root — the owner-agnostic registerEnemy path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  constructor(engine: Engine, def: CompanionDef, position: THREE.Vector3, mapSeed: number, summonIndex: number) {
    this.def = def;
    this.seed = ((mapSeed ^ COMPANION_SALT ^ Math.imul(summonIndex + 1, 0x9e3779b1)) >>> 0);
    const rng = new Rng(this.seed);
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: rng.fork(0xc0de),
    };
    buildCompanionFigure(ctx, this.root, def);
    this.follow = rollFollowOffset(def, this.seed);
    this.root.position.copy(position);
  }
}

// ---------------------------------------------------------------------------
// CompanionsManager — roster (player-scoped) + live follower (map-local)
// ---------------------------------------------------------------------------

export interface CompanionsManagerOpts {
  /** live player position source */
  getPlayerPos: () => THREE.Vector3;
  /** live enemy roster (companion attacks read it; never mutated here) */
  getEnemies: () => Enemy[];
  /** heal the player by n HP (blueprint passes avatar.heal) */
  healPlayer: (n: number) => void;
  /** player feedback (blueprint passes engine.hud.toast) */
  toast: (m: string) => void;
  /** true while a campfire deployable is live (heal-at-campfire gate) */
  campfireLive: () => boolean;
  /** called after every roster mutation with the persisted save shape */
  onChange?: (save: CompanionSave) => void;
  /** restored save (profile) or null = fresh roster */
  initial?: CompanionSave | null;
  /** current map seed for the companion stream (updated on spawnForMap) */
  mapSeed?: number;
}

export class CompanionsManager implements MapLocalEntitySystem {
  readonly id = 'companions';
  private readonly opts: CompanionsManagerOpts;
  private readonly instancer: NpcInstancer;
  private mapSeed: number;
  private roster: CompanionState[] = [];
  private activeId: string | null = null;
  private entity: Companion | null = null;
  private summonIndex = 0;
  private attackCd = 0;
  private attackIndex = 0;
  private healTimer = 0;
  private healIndex = 0;
  /** cumulative companion damage dealt (exact, for e2e assertions) */
  totalDamage = 0;
  /** cumulative player healing applied by the healer aura (exact) */
  totalHealed = 0;
  /** cumulative companion damage credited through Enemy.damage() kills — same as totalDamage; kills flow via onDeath */
  kills = 0;

  constructor(private readonly engine: Engine, opts: CompanionsManagerOpts) {
    this.opts = opts;
    this.mapSeed = opts.mapSeed ?? engine.spec.meta.seed;
    this.instancer = NpcInstancer.for(engine);
    if (opts.initial) this.restore(opts.initial);
    else {
      this.roster = COMPANION_DEFS.map((d) => ({ defId: d.id, name: d.name, hp: d.maxHp }));
    }
  }

  /** Player-scoped roster (read-only view). */
  get rosterView(): readonly CompanionState[] {
    return this.roster;
  }

  /** Active companion id, or null when dismissed. */
  get activeCompanionId(): string | null {
    return this.activeId;
  }

  /** Live rendered companion, or null when none summoned / dismissed. */
  get live(): Companion | null {
    return this.entity;
  }

  /** Active roster entry, or null. */
  get activeState(): CompanionState | null {
    return this.roster.find((s) => s.defId === this.activeId) ?? null;
  }

  // -- roster ops (player-scoped; persist on every mutation) -----------

  /** Summon (or switch to) a companion by def id. Spawns it at the player. */
  summon(defId: string): boolean {
    const def = companionDefOf(defId);
    if (!def) { this.opts.toast(`Unknown companion ${defId}.`); return false; }
    let entry = this.roster.find((s) => s.defId === defId);
    if (!entry) {
      entry = { defId, name: def.name, hp: def.maxHp };
      this.roster.push(entry);
    }
    if (this.entity && this.activeId === defId) return true; // already live
    this.despawnEntity();
    this.activeId = defId;
    this.spawnEntity(entry);
    this.opts.toast(`${entry.name} joins you.`);
    this.persist();
    return true;
  }

  /** Select = summon (panel wording); kept as an alias for the seam. */
  select(defId: string): boolean {
    return this.summon(defId);
  }

  /** Dismiss the active companion. Roster entry (name, hp) is kept. */
  dismiss(): boolean {
    if (!this.activeId) return false;
    const name = this.activeState?.name ?? this.activeId;
    this.despawnEntity();
    this.activeId = null;
    this.opts.toast(`${name} stands down.`);
    this.persist();
    return true;
  }

  /** Rename a roster entry (1–40 chars, trimmed; empty ignored). */
  rename(defId: string, name: string): boolean {
    const entry = this.roster.find((s) => s.defId === defId);
    if (!entry) return false;
    const clean = name.trim().slice(0, 40);
    if (!clean) return false;
    entry.name = clean;
    this.persist();
    return true;
  }

  /** Heal the active companion by n (capped at maxHp); revives a downed one. */
  healActive(n: number): number {
    const entry = this.activeState;
    if (!entry) return 0;
    const def = companionDefOf(entry.defId);
    if (!def) return 0;
    const before = entry.hp;
    entry.hp = Math.min(def.maxHp, entry.hp + n);
    if (this.entity && entry.hp > 0) this.entity.root.visible = true;
    return entry.hp - before;
  }

  /** Damage the active companion (test seam + future enemy hooks); 0 HP = downed, not deleted. */
  damageActive(n: number): number {
    const entry = this.activeState;
    if (!entry) return 0;
    const before = entry.hp;
    entry.hp = Math.max(0, entry.hp - n);
    if (this.entity && entry.hp <= 0) this.entity.root.visible = false;
    return before - entry.hp;
  }

  /**
   * Heal-at-campfire: fully heal the active companion, but ONLY while a
   * campfire deployable is live. Returns HP restored, or 0 + honest
   * refusal when no campfire is live / nothing is summoned.
   */
  healAtCampfire(): number {
    const entry = this.activeState;
    if (!entry) { this.opts.toast('No companion summoned.'); return 0; }
    if (!this.opts.campfireLive()) {
      this.opts.toast('No campfire burning — deploy one first.');
      return 0;
    }
    const def = companionDefOf(entry.defId);
    if (!def) return 0;
    const restored = def.maxHp - entry.hp;
    entry.hp = def.maxHp;
    if (this.entity) this.entity.root.visible = true;
    if (restored > 0) this.opts.toast(`${entry.name} rests by the fire (+${restored} HP).`);
    this.persist();
    return restored;
  }

  /** Persisted save shape (roster + active id). */
  serialize(): CompanionSave {
    return {
      activeId: this.activeId,
      roster: this.roster.map((s) => ({ ...s })),
    };
  }

  /** Restore a persisted save (validates def ids, clamps hp, defaults names). */
  restore(save: CompanionSave | null | undefined): void {
    if (!save || !Array.isArray(save.roster)) return;
    const seen = new Set<string>();
    this.roster = [];
    for (const raw of save.roster) {
      const def = raw && companionDefOf(raw.defId);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      this.roster.push({
        defId: def.id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : def.name,
        hp: Math.max(0, Math.min(def.maxHp, Math.floor(typeof raw.hp === 'number' && isFinite(raw.hp) ? raw.hp : def.maxHp))),
      });
    }
    // Roster always covers all three defs (a save from an older shape
    // must never lock a companion out).
    for (const def of COMPANION_DEFS) {
      if (!seen.has(def.id)) this.roster.push({ defId: def.id, name: def.name, hp: def.maxHp });
    }
    this.activeId = save.activeId && companionDefOf(save.activeId) ? save.activeId : null;
  }

  private persist(): void {
    try { this.opts.onChange?.(this.serialize()); } catch { /* persistence must never break play */ }
  }

  // -- live entity plumbing ------------------------------------------------

  private spawnEntity(entry: CompanionState): void {
    const def = companionDefOf(entry.defId);
    if (!def) return;
    const playerPos = this.opts.getPlayerPos();
    const c = new Companion(this.engine, def, playerPos.clone(), this.mapSeed, this.summonIndex++);
    // Spawn exactly at the companion's own stored follow offset.
    c.root.position.set(
      playerPos.x + Math.cos(c.follow.angle) * c.follow.dist,
      playerPos.y,
      playerPos.z + Math.sin(c.follow.angle) * c.follow.dist,
    );
    const terrain = this.engine.terrain;
    if (terrain) c.root.position.y = terrain.heightAt(c.root.position.x, c.root.position.z) ?? c.root.position.y;
    c.root.visible = entry.hp > 0;
    this.engine.scene.add(c.root);
    this.entity = c;
    try { this.instancer.registerEnemy(c); } catch { /* instancing must never break play */ }
    this.attackCd = 0;
    this.healTimer = 0;
  }

  private despawnEntity(): void {
    if (!this.entity) return;
    try { this.instancer.unregister(this.entity); } catch { /* never strand the rest */ }
    try { this.engine.scene.remove(this.entity.root); } catch { /* never strand the rest */ }
    this.entity = null;
  }

  /** MapLocalEntitySystem departure: remove the rendered follower only. Roster survives. */
  despawnAll(): void {
    this.despawnEntity();
  }

  /**
   * MapLocalEntitySystem arrival: respawn the ACTIVE companion (if any)
   * from the player-scoped roster at the player's follow offset, with
   * its stored name and hp. Dismissed (activeId null) spawns nothing.
   * Idempotent: any stale entity is despawned first.
   */
  spawnForMap(mapSeed: number): void {
    this.despawnEntity();
    this.mapSeed = mapSeed;
    if (!this.activeId) return;
    const entry = this.activeState;
    if (entry) this.spawnEntity(entry);
  }

  /**
   * Per-frame: follow the player, attack (melee/ranged via the existing
   * Enemy.damage() path), heal (aura ticks to the player), submit to the
   * shared instancer. MUST run before EnemyManager.update in the
   * blueprint's instancer frame so companion kills land before the
   * enemy roster sweep (same ordering as deployables' lure assignment).
   */
  update(dt: number): void {
    const c = this.entity;
    const entry = this.activeState;
    if (!c || !entry) return;
    const playerPos = this.opts.getPlayerPos();
    // -- follow: lerp toward the seeded offset; teleport if far behind
    const target = new THREE.Vector3(
      playerPos.x + Math.cos(c.follow.angle) * c.follow.dist,
      playerPos.y,
      playerPos.z + Math.sin(c.follow.angle) * c.follow.dist,
    );
    const terrain = this.engine.terrain;
    if (terrain) target.y = terrain.heightAt(target.x, target.z) ?? target.y;
    const dist = c.root.position.distanceTo(target);
    if (dist > 14) {
      c.root.position.copy(target);
    } else if (dist > 0.05) {
      const step = Math.min(dist, 7.5 * dt);
      c.root.position.add(target.clone().sub(c.root.position).normalize().multiplyScalar(step));
    }
    c.root.position.y = target.y;
    // Downed companions do nothing until healed.
    if (entry.hp <= 0) {
      try { this.instancer.submit(c); } catch { /* never break the frame */ }
      return;
    }
    const def = c.def;
    // -- attack via the existing damage path (kill credit: see header)
    if (def.damage > 0 && def.attackRange > 0) {
      this.attackCd -= dt;
      if (this.attackCd <= 0) {
        const targetEnemy = pickCompanionTarget(
          this.opts.getEnemies() as unknown as readonly CompanionTarget[],
          c.root.position,
          def.attackRange,
        );
        if (targetEnemy) {
          const dmg = rollCompanionDamage(def, c.seed, this.attackIndex++);
          try {
            const before = (targetEnemy as unknown as { alive: boolean }).alive;
            (targetEnemy as unknown as Enemy).damage(dmg, c.root.position);
            this.totalDamage += dmg;
            if (before && !(targetEnemy as unknown as { alive: boolean }).alive) this.kills++;
          } catch { /* a companion hit must never break the frame */ }
        }
        this.attackCd = def.attackInterval;
      }
    }
    // -- healer aura ticks to the player
    if (def.heal > 0 && def.healRadius > 0) {
      this.healTimer += dt;
      if (this.healTimer >= def.healInterval) {
        this.healTimer = 0;
        if (c.root.position.distanceTo(playerPos) <= def.healRadius) {
          const mag = rollCompanionHeal(def, c.seed, this.healIndex++);
          this.opts.healPlayer(mag);
          this.totalHealed += mag;
        }
      }
    }
    try { this.instancer.submit(c); } catch { /* never break the frame */ }
  }
}
