/**
 * COMBAT-ABILITIES (upgrade loop): data-driven active combat abilities.
 *
 * Three abilities, one tuning table (ABILITY_DEFS) — no other file carries
 * ability numbers:
 *   - dash-strike:   mobility + damage. Dashes the player forward and hits
 *                   enemies in a frontal arc at cast time.
 *   - shockwave-slam: AoE damage + knockback to every living enemy in radius.
 *   - mend:          heal-over-time on the player for a fixed duration.
 *
 * Contracts honored:
 *   - Enemy/NPC public behavior contracts are untouched. Damage flows only
 *     through the existing Enemy.damage() (additive effect application);
 *     knockback is an extra physics impulse on the enemy's existing body.
 *   - Determinism: damage variance draws from a manager-owned Rng seeded
 *     with (seed ^ ABILITY_SALT) — never engine.rng, never Math.random /
 *     Date.now for gameplay. Same seed + same cast sequence -> identical
 *     damage. Ability logic itself is state-driven (cooldowns, energy).
 *   - Player-scoped: one manager per blueprint build (blueprints are not
 *     rebuilt on portal transitions, so cooldowns/energy survive travel
 *     by construction; portalSnapshot/portalRestore exist for the seam).
 *   - Costs: there was no mana/stamina pool in the player stats — health
 *     is the only pool and spending health on abilities would be a
 *     behavior change, so abilities draw on a NEW additive energy pool
 *     owned by this manager (max 100, regen 8/s). Nothing else reads or
 *     writes it; health/ammo/XP are untouched.
 *   - VFX through existing pooled systems only (engine.particles bursts,
 *     engine.juice damage numbers/shake). This module creates zero meshes
 *     and zero InstancedMesh buckets, so the draw-call delta of casting
 *     is 0 by construction (measured in the e2e perf leg).
 *   - Input: the manager polls the abstract Input actions ability1/2/3
 *     (defaults KeyZ/KeyC/KeyV in core/Input). It never reads key codes,
 *     so remapping via Input.remapKey() needs no manager change.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { EnemyManager } from './EnemyAI';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';

/** Salt for the ability variance stream — off the loot/enemy streams. */
export const ABILITY_SALT = 0xab17;

export type AbilityId = 'dash-strike' | 'shockwave-slam' | 'mend';
export const ABILITY_IDS: readonly AbilityId[] = [
  'dash-strike',
  'shockwave-slam',
  'mend',
];

/** One tuning table — every ability number lives here and nowhere else. */
export interface AbilityDef {
  id: AbilityId;
  name: string;
  /** short effect line, rendered verbatim by the ability bar */
  desc: string;
  /** 'dash-damage' | 'aoe' | 'hot' */
  kind: 'dash-damage' | 'aoe' | 'hot';
  /** cooldown seconds after a successful cast */
  cooldown: number;
  /** energy cost of a successful cast */
  cost: number;
  /** base damage (dash-strike / shockwave) before seeded variance + damageMult */
  damage: number;
  /** dash-strike: frontal arc range (m) */
  range: number;
  /** dash-strike: arc half-angle cosine threshold (dot product) */
  arcCos: number;
  /** dash-strike: dash distance (m) */
  dashDistance: number;
  /** dash-strike: dash duration (s); speed = distance / duration */
  dashTime: number;
  /** shockwave: AoE radius (m) */
  radius: number;
  /** shockwave: knockback impulse magnitude */
  knockback: number;
  /** mend: total heal over duration (before no multiplier — heal is flat) */
  totalHeal: number;
  /** mend: HoT duration (s) */
  duration: number;
  /** VFX colors (pooled particles only) */
  color: string;
  /** default hotkey label, for the bar (Input owns the real binding) */
  keyLabel: string;
}

export const ABILITY_DEFS: readonly AbilityDef[] = [
  {
    id: 'dash-strike',
    name: 'Dash Strike',
    desc: 'Dash forward, striking enemies in front of you.',
    kind: 'dash-damage',
    cooldown: 6,
    cost: 20,
    damage: 40,
    range: 4.5,
    arcCos: 0.5,
    dashDistance: 7,
    dashTime: 0.25,
    radius: 0,
    knockback: 0,
    totalHeal: 0,
    duration: 0,
    color: '#7af7ff',
    keyLabel: 'Z',
  },
  {
    id: 'shockwave-slam',
    name: 'Shockwave Slam',
    desc: 'Slam the ground: damage + knockback to all nearby enemies.',
    kind: 'aoe',
    cooldown: 10,
    cost: 35,
    damage: 30,
    range: 0,
    arcCos: 0,
    dashDistance: 0,
    dashTime: 0,
    radius: 6,
    knockback: 14,
    totalHeal: 0,
    duration: 0,
    color: '#ffb46b',
    keyLabel: 'C',
  },
  {
    id: 'mend',
    name: 'Mend',
    desc: 'Heal over time: restores health gradually.',
    kind: 'hot',
    cooldown: 12,
    cost: 25,
    damage: 0,
    range: 0,
    arcCos: 0,
    dashDistance: 0,
    dashTime: 0,
    radius: 0,
    knockback: 0,
    totalHeal: 45,
    duration: 3,
    color: '#8fe3a8',
    keyLabel: 'V',
  },
];

export function abilityDefOf(id: string): AbilityDef | undefined {
  return ABILITY_DEFS.find((d) => d.id === id);
}

/** Minimal avatar surface the manager needs (PlayerAvatar satisfies it). */
export interface AbilityAvatar {
  health: number;
  maxHealth: number;
  heal(amount: number): void;
  /** controller: live position + physics body for the dash override */
  ctrl?: {
    body?: { velocity: { set(x: number, y: number, z: number): void } };
    position: THREE.Vector3;
  };
}

/** Minimal enemy-manager surface (EnemyManager satisfies it). */
export interface AbilityEnemies {
  enemies: Array<{
    alive: boolean;
    position: THREE.Vector3;
    damage(amount: number, from?: THREE.Vector3): void;
    body?: { applyImpulse(impulse: { x: number; y: number; z: number }): void } | null;
  }>;
}

/** Pooled-VFX surface (wired to engine.particles / engine.juice by the helper). */
export interface AbilityFx {
  burst(pos: THREE.Vector3, color: string): void;
  damageNumber(pos: THREE.Vector3, text: string, color: string): void;
  shake(amount: number): void;
}

export interface CastResult {
  ok: boolean;
  /** fail reason when ok is false: 'disabled' | 'cooldown' | 'energy' | 'unknown' */
  reason?: string;
  /** total damage actually dealt by this cast (variance + damageMult applied) */
  damageDealt: number;
  /** enemies hit by this cast */
  targets: number;
  /** heal actually applied by this cast (mend ticks accumulate via hotHealed) */
  healed: number;
}

export interface AbilityManagerOpts {
  avatar: AbilityAvatar;
  enemies: AbilityEnemies;
  /** seed for the variance stream (default: spec meta seed via helper) */
  seed?: number;
  /** multiplicative damage bonus (Progression.damageMult etc.); default 1 */
  damageMult?: () => number;
  /** pooled VFX; unit tests pass a recorder, live wiring passes engine fx */
  fx?: AbilityFx | null;
  /** spec toggle; default true (see resolveAbilitiesEnabled) */
  enabled?: boolean;
}

export const MAX_ENERGY = 100;
export const ENERGY_REGEN_PER_S = 8;

export class AbilityManager {
  readonly defs: readonly AbilityDef[] = ABILITY_DEFS;
  energy = MAX_ENERGY;
  /** remaining cooldown per ability id (s) */
  private cooldowns = new Map<AbilityId, number>();
  /** active heal-over-time: remaining seconds + heal per second */
  private hotRemaining = 0;
  private hotPerSec = 0;
  /** heal actually delivered by the running HoT (for e2e exactness) */
  hotHealed = 0;
  /** active dash: remaining seconds + unit planar direction */
  private dashRemaining = 0;
  private dashDir = new THREE.Vector3();
  private dashSpeed = 0;
  private readonly rng: Rng;
  private readonly damageMult: () => number;
  private readonly fx: AbilityFx | null;
  private readonly avatar: AbilityAvatar;
  private readonly enemies: AbilityEnemies;
  readonly enabled: boolean;
  /** last cast, for e2e exact assertions (damage incl. variance) */
  lastCast: { id: AbilityId; damageDealt: number; targets: number } | null = null;

  constructor(opts: AbilityManagerOpts) {
    this.avatar = opts.avatar;
    this.enemies = opts.enemies;
    this.rng = new Rng(((opts.seed ?? 0) ^ ABILITY_SALT) >>> 0);
    this.damageMult = opts.damageMult ?? (() => 1);
    this.fx = opts.fx ?? null;
    this.enabled = opts.enabled ?? true;
    for (const d of ABILITY_DEFS) this.cooldowns.set(d.id, 0);
  }

  /** remaining cooldown for an ability (0 = ready) */
  cooldownRemaining(id: AbilityId): number {
    return this.cooldowns.get(id) ?? 0;
  }

  /** true when a cast would succeed right now (ignoring target presence) */
  canCast(id: AbilityId): boolean {
    const def = abilityDefOf(id);
    if (!def || !this.enabled) return false;
    return this.cooldownRemaining(id) <= 0 && this.energy >= def.cost;
  }

  /**
   * Cast an ability. Fails closed (no cost, no cooldown, no effect) when
   * disabled, on cooldown, short on energy, or unknown. Dash-strike and
   * shockwave still spend + trigger when no enemy is in range — the
   * mobility / AoE effect itself is the cast; damageDealt is then 0.
   * Seeded variance: damage = round(base * damageMult * (0.9 + rng*0.2)).
   */
  cast(id: AbilityId, aimDir?: THREE.Vector3): CastResult {
    const def = abilityDefOf(id);
    if (!def) return { ok: false, reason: 'unknown', damageDealt: 0, targets: 0, healed: 0 };
    if (!this.enabled) return { ok: false, reason: 'disabled', damageDealt: 0, targets: 0, healed: 0 };
    if (this.cooldownRemaining(id) > 0) return { ok: false, reason: 'cooldown', damageDealt: 0, targets: 0, healed: 0 };
    if (this.energy < def.cost) return { ok: false, reason: 'energy', damageDealt: 0, targets: 0, healed: 0 };
    this.energy -= def.cost;
    this.cooldowns.set(id, def.cooldown);
    const origin = this.avatar.ctrl?.position.clone() ?? new THREE.Vector3();
    let damageDealt = 0;
    let targets = 0;
    if (def.kind === 'dash-damage') {
      const dir = (aimDir ?? new THREE.Vector3(0, 0, 1)).clone().setY(0);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      for (const e of this.enemies.enemies) {
        if (!e.alive) continue;
        const to = e.position.clone().sub(origin);
        const d = to.length();
        if (d > def.range) continue;
        if (d > 0 && to.normalize().dot(dir) < def.arcCos) continue;
        const dmg = this.rollDamage(def);
        e.damage(dmg, origin);
        this.fx?.damageNumber(e.position, String(Math.round(dmg)), def.color);
        damageDealt += dmg;
        targets++;
      }
      // mobility: dash velocity is applied per-frame by update() (after
      // the controller's own velocity write) for dashTime seconds.
      this.dashDir.copy(dir);
      this.dashSpeed = def.dashDistance / def.dashTime;
      this.dashRemaining = def.dashTime;
      this.avatar.ctrl?.body?.velocity.set(dir.x * this.dashSpeed, 0, dir.z * this.dashSpeed);
      this.fx?.burst(origin.clone().add(new THREE.Vector3(0, 1, 0)), def.color);
      this.fx?.shake(0.12);
    } else if (def.kind === 'aoe') {
      for (const e of this.enemies.enemies) {
        if (!e.alive) continue;
        const to = e.position.clone().sub(origin);
        const d = to.length();
        if (d > def.radius) continue;
        const dmg = this.rollDamage(def);
        e.damage(dmg, origin);
        this.fx?.damageNumber(e.position, String(Math.round(dmg)), def.color);
        if (e.body && d > 0.001) {
          const push = to.normalize().multiplyScalar(def.knockback);
          e.body.applyImpulse({ x: push.x, y: def.knockback * 0.25, z: push.z });
        }
        damageDealt += dmg;
        targets++;
      }
      this.fx?.burst(origin.clone().add(new THREE.Vector3(0, 0.5, 0)), def.color);
      this.fx?.shake(0.3);
    } else {
      // mend: HoT; ticks heal in update() (clamped by avatar.heal).
      this.hotRemaining = def.duration;
      this.hotPerSec = def.totalHeal / def.duration;
      this.hotHealed = 0;
      this.fx?.burst(origin.clone().add(new THREE.Vector3(0, 1.2, 0)), def.color);
    }
    this.lastCast = { id, damageDealt, targets };
    return { ok: true, damageDealt, targets, healed: 0 };
  }

  /** Per-frame tick: cooldowns, energy regen, HoT ticks, dash velocity. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    for (const [id, rem] of this.cooldowns) {
      if (rem > 0) this.cooldowns.set(id, Math.max(0, rem - dt));
    }
    this.energy = Math.min(MAX_ENERGY, this.energy + ENERGY_REGEN_PER_S * dt);
    if (this.hotRemaining > 0) {
      const tick = Math.min(this.hotRemaining, dt);
      const before = this.avatar.health;
      this.avatar.heal(this.hotPerSec * tick);
      this.hotHealed += this.avatar.health - before;
      this.hotRemaining -= tick;
      if (this.hotRemaining <= 0) this.hotPerSec = 0;
    }
    if (this.dashRemaining > 0) {
      this.dashRemaining -= dt;
      const body = this.avatar.ctrl?.body;
      if (body) body.velocity.set(this.dashDir.x * this.dashSpeed, 0, this.dashDir.z * this.dashSpeed);
    }
  }

  /** Snapshot for the portal seam (live objects persist anyway). */
  portalSnapshot(): { energy: number; cooldowns: Record<string, number>; hotRemaining: number } {
    return {
      energy: this.energy,
      cooldowns: Object.fromEntries(this.cooldowns),
      hotRemaining: this.hotRemaining,
    };
  }

  portalRestore(s: { energy: number; cooldowns: Record<string, number>; hotRemaining: number } | null | undefined): void {
    if (!s) return;
    this.energy = Number.isFinite(s.energy) ? Math.max(0, Math.min(MAX_ENERGY, s.energy)) : MAX_ENERGY;
    for (const d of ABILITY_DEFS) {
      const v = s.cooldowns?.[d.id];
      if (Number.isFinite(v) && (v as number) > 0) this.cooldowns.set(d.id, Math.min(d.cooldown, v as number));
    }
    this.hotRemaining = 0;
    this.hotPerSec = 0;
  }

  /** Seeded damage roll: base * damageMult * uniform[0.9, 1.1]. */
  private rollDamage(def: AbilityDef): number {
    return Math.round(def.damage * this.damageMult() * (0.9 + this.rng.next() * 0.2));
  }
}

// ---------------------------------------------------------------------------
// Spec resolvers (mirror the skills pattern)
// ---------------------------------------------------------------------------

export function resolveAbilitiesEnabled(spec: GameSpec): boolean {
  const v = (spec.custom as Record<string, unknown> | undefined)?.abilities;
  if (v && typeof v === 'object' && 'enabled' in v) return (v as { enabled: unknown }).enabled !== false;
  return true;
}

// ---------------------------------------------------------------------------
// HUD ability bar (DOM readout, pointer-events:none — never a control)
// ---------------------------------------------------------------------------

const BAR_CSS = `
.xabilities { position:absolute; left:50%; bottom:64px; transform:translateX(-50%); z-index:8;
  pointer-events:none; display:flex; flex-direction:column; align-items:center; gap:6px;
  font-family:'Segoe UI',system-ui,sans-serif; }
.xabilities .chips { display:flex; gap:8px; }
.xabilities .chip { min-width:64px; padding:5px 8px; border-radius:8px; text-align:center;
  background:rgba(10,16,26,.62); border:1px solid rgba(140,180,220,.35); color:#e8ecf1; }
.xabilities .chip .nm { font-size:11px; font-weight:700; letter-spacing:.06em; }
.xabilities .chip .cd { font-size:11px; color:#ffd23f; font-variant-numeric:tabular-nums; }
.xabilities .chip.ready .cd { color:#8fe3a8; }
.xabilities .energy { width:216px; height:8px; border-radius:4px; background:rgba(10,16,26,.62);
  border:1px solid rgba(140,180,220,.35); overflow:hidden; }
.xabilities .energy > div { height:100%; background:#7af7ff; }
@media (max-width:760px) { .xabilities { bottom:64px; } .xabilities .chip { min-width:60px; } }
`;

/**
 * Ability bar: cooldown + energy readout. Updates DOM only when a displayed
 * bucket changes (cooldown whole seconds, energy 5% buckets) — no per-frame
 * DOM cost. Never a control (pointer-events:none); casting is hotkeys +
 * touch buttons only, so the bar can never collide with a tap target.
 */
export class AbilityBar {
  private root: HTMLDivElement | null = null;
  private chipEls: HTMLDivElement[] = [];
  private energyFill: HTMLDivElement | null = null;
  private lastKey = '';

  constructor(container: HTMLElement) {
    if (typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = BAR_CSS;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.className = 'xabilities';
    root.id = 'xandria-ability-bar';
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const d of ABILITY_DEFS) {
      const chip = document.createElement('div');
      chip.className = 'chip ready';
      chip.dataset.ability = d.id;
      chip.innerHTML = `<div class="nm">${d.name} [${d.keyLabel}]</div><div class="cd">READY</div>`;
      chips.appendChild(chip);
      this.chipEls.push(chip);
    }
    const energy = document.createElement('div');
    energy.className = 'energy';
    const fill = document.createElement('div');
    energy.appendChild(fill);
    this.energyFill = fill;
    root.appendChild(chips);
    root.appendChild(energy);
    container.appendChild(root);
    this.root = root;
  }

  /** Render manager state; no-ops when the bucket key is unchanged. */
  render(manager: AbilityManager): void {
    if (!this.root) return;
    const key = ABILITY_DEFS.map((d) => Math.ceil(manager.cooldownRemaining(d.id))).join('/') +
      `/${Math.floor(manager.energy / 5)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    ABILITY_DEFS.forEach((d, i) => {
      const rem = manager.cooldownRemaining(d.id);
      const chip = this.chipEls[i];
      chip.classList.toggle('ready', rem <= 0);
      (chip.querySelector('.cd') as HTMLElement).textContent =
        rem <= 0 ? 'READY' : `${rem.toFixed(1)}s`;
    });
    if (this.energyFill) this.energyFill.style.width = `${(manager.energy / MAX_ENERGY) * 100}%`;
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
  }
}

// ---------------------------------------------------------------------------
// Blueprint wiring helper (observe-only on contracts)
// ---------------------------------------------------------------------------

export interface WiredAbilities {
  manager: AbilityManager;
  bar: AbilityBar | null;
  /** poll justPressed ability actions and cast (call in onUpdate) */
  poll(aimDir: () => THREE.Vector3): void;
  /** tick manager + bar (call in onUpdate, after avatar.update) */
  update(dt: number): void;
}

/**
 * Build the manager + bar for a humanoid blueprint and return the two
 * per-frame hooks. aimDir is blueprint-supplied (melee convention in
 * tpAction/platformer, camera forward in fpsArena, twin-stick aim in
 * topdown). When abilities are disabled in spec, the manager still exists
 * (seam uniformity) but cast() fails closed and the bar is not built.
 */
export function wireCombatAbilities(
  engine: Engine,
  spec: GameSpec,
  avatar: AbilityAvatar & { ctrl?: AbilityAvatar['ctrl'] },
  enemies: EnemyManager,
  opts: { damageMult?: () => number } = {},
): WiredAbilities {
  const enabled = resolveAbilitiesEnabled(spec);
  const manager = new AbilityManager({
    avatar,
    enemies: enemies as unknown as AbilityEnemies,
    seed: spec.meta.seed,
    damageMult: opts.damageMult,
    enabled,
    fx: {
      burst: (pos, color) => {
        engine.particles.burst(pos, { count: 14, color, color2: '#ffffff', speed: 6, life: 0.5, size: 1.6, gravity: 0 });
      },
      damageNumber: (pos, text, color) => {
        engine.juice.damageNumber(engine.camera, pos, text, color);
      },
      shake: (amount) => engine.juice.shake(amount),
    },
  });
  const bar = enabled ? new AbilityBar(engine.container) : null;
  return {
    manager,
    bar,
    poll(aimDir: () => THREE.Vector3) {
      if (!enabled || engine.state !== 'playing') return;
      const input = engine.input;
      if (input.justPressed('ability1')) manager.cast('dash-strike', aimDir());
      else if (input.justPressed('ability2')) manager.cast('shockwave-slam', aimDir());
      else if (input.justPressed('ability3')) manager.cast('mend', aimDir());
    },
    update(dt: number) {
      manager.update(dt);
      if (bar) bar.render(manager);
    },
  };
}
