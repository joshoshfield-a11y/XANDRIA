/**
 * Progression — XP/level system + upgrade choices for the campaign layer.
 *
 * Blueprints feed it kills/pickups; on level-up they show the HUD's
 * level-up modal with getUpgradeChoices() and apply the chosen upgrade.
 * Deterministic: upgrade choices draw from engine.rng (seeded).
 * Everything no-ops cleanly when spec.progression.enabled is false.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { PlayerAvatar } from '../../blueprints/common';
import type { ProgressionSpec, GameSpec } from '@spec';
import type { Juice } from './Juice';
import {
  LEVEL_CAP,
  levelRow,
  xpForNextLevel,
  type LevelGain,
} from './progressionCurve';

export type UpgradeId =
  | 'damage'
  | 'maxhp'
  | 'speed'
  | 'firerate'
  | 'magnet'
  | 'dash';

export interface UpgradeDef {
  /** built-ins use the UpgradeId union; custom upgrades use their registered id */
  id: string;
  name: string;
  desc: string;
}

/** Mirrors the spec-side ProgressionSpec shape verbatim. */
export type ProgressionOpts = ProgressionSpec;

const DEFAULT_OPTS: ProgressionOpts = {
  enabled: false,
  xpPerKill: 20,
  xpPerPickup: 5,
  xpPerCraft: 15,
};

const UPGRADE_POOL: UpgradeDef[] = [
  { id: 'damage', name: 'Heavy Rounds', desc: '+25% damage' },
  { id: 'maxhp', name: 'Reinforced Plating', desc: '+15% max integrity, repair to full' },
  { id: 'speed', name: 'Servo Motors', desc: '+12% move speed' },
  { id: 'firerate', name: 'Trigger Discipline', desc: '+20% fire rate' },
  { id: 'magnet', name: 'Tractor Field', desc: '+50% pickup magnet range' },
  { id: 'dash', name: 'Ion Thrusters', desc: '-25% dash cooldown' },
];

/**
 * Module-level speed anchors (progression-curve): keyed by the GameSpec
 * object, which persists across portal transitions while Progression
 * instances are rebuilt. applyLevelStatGrowth anchors the speed on first
 * sight; applyLoadout invalidates the anchor after rewriting spec.player.speed
 * so title-shop modifiers (swift) survive as the new anchor.
 */
const speedBaseAnchors = new WeakMap<object, number>();

export function invalidateProgressionSpeedAnchor(spec: GameSpec): void {
  speedBaseAnchors.delete(spec);
}

export class Progression {  level = 1;
  xp = 0;
  private counts = new Map<string, number>();
  private readonly opts: ProgressionOpts;

  /**
   * @param opts explicit overrides; otherwise read from spec.progression.
   */
  constructor(
    private engine: Engine,
    opts?: Partial<ProgressionOpts>,
  ) {
    const fromSpec = engine.spec.progression;
    this.opts = {
      enabled: opts?.enabled ?? fromSpec?.enabled ?? DEFAULT_OPTS.enabled,
      xpPerKill: opts?.xpPerKill ?? fromSpec?.xpPerKill ?? DEFAULT_OPTS.xpPerKill,
      xpPerPickup:
        opts?.xpPerPickup ?? fromSpec?.xpPerPickup ?? DEFAULT_OPTS.xpPerPickup,
      xpPerCraft:
        opts?.xpPerCraft ?? fromSpec?.xpPerCraft ?? DEFAULT_OPTS.xpPerCraft,
    };
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  xpForNext(level: number): number {
    return xpForNextLevel(level);
  }

  /**
   * Add XP; returns the level span gained. THE one XP path — kills, pickups,
   * crafts and quest turn-ins all funnel through here, additive only (XP is
   * never subtracted or reset). Returns {leveled:false, gain:null} when
   * nothing leveled, disabled, or the amount is non-positive.
   */
  addXpEx(n: number): { leveled: boolean; gain: LevelGain | null } {
    if (!this.opts.enabled || !(n > 0)) return { leveled: false, gain: null };
    const from = this.level;
    this.xp += n;
    while (this.level < LEVEL_CAP && this.xp >= this.xpForNext(this.level)) {
      this.xp -= this.xpForNext(this.level);
      this.level++;
    }
    const leveled = this.level > from;
    if (leveled) this.engine.audio?.play('levelup');
    if (leveled) this.engine.hooks.emit('onLevelUp', { level: this.level, progression: this });
    // DAMAGE-NUMBERS: observe-only — every XP gain reads as a themed
    // number above the player. Guarded for partial unit-test engines
    // (no juice/camera/avatar there): display never affects XP math.
    const juice = (this.engine as unknown as { juice?: Juice }).juice;
    const avPos = this.engine.portalsPlayerAvatar?.ctrl?.position;
    if (juice && typeof juice.spawnText === 'function' && avPos && this.engine.camera) {
      juice.spawnText(
        this.engine.camera,
        avPos.clone().add(new THREE.Vector3(0, 2, 0)),
        'xp',
        n,
      );
    }
    return { leveled, gain: leveled ? { from, to: this.level } : null };
  }

  /** Add XP; returns true if this caused at least one level-up. */
  addXp(n: number): boolean {
    return this.addXpEx(n).leveled;
  }

  /**
   * Convenience: XP for a kill. Returns true on level-up.
   * UPGRADE LOOP (enemy-scaling): xpMult is the killed enemy's band XP
   * multiplier (1 = unscaled); additive optional param.
   */
  onKill(xpMult = 1): boolean {
    return this.addXp(this.opts.xpPerKill * xpMult);
  }

  /** Convenience: XP for a pickup. Returns true on level-up. */
  onPickup(): boolean {
    return this.addXp(this.opts.xpPerPickup);
  }

  /** Player-level XP granted per completed craft (spec-driven, additive). */
  xpPerCraft(): number {
    return this.opts.xpPerCraft ?? DEFAULT_OPTS.xpPerCraft!;
  }

  /** XP per kill before the band multiplier (spec-driven). */
  xpPerKill(): number {
    return this.opts.xpPerKill;
  }

  /** XP per pickup (spec-driven). */
  xpPerPickup(): number {
    return this.opts.xpPerPickup;
  }

  /**
   * Per-level stat growth (progression-curve): applied to the live avatar on
   * every level-up AND once on map boot (portal transitions rebuild the
   * avatar, so boot re-applies growth up to the persisted level).
   * Idempotent per avatar/spec: repeated calls never double-apply.
   *
   * - maxHealth scales by the table's hpMult ratio (symmetric with the
   *   enemy-scaling dmgMult ladder); only the GAINED max HP is healed, so
   *   leveling never acts as a free full heal (that's the 'maxhp' upgrade).
   * - spec.player.speed is RECOMPUTED (not multiplied) from an anchored base
   *   speed: level table growth x 'speed'-upgrade stacks. Recompute instead
   *   of multiply keeps portal arrivals idempotent — the spec object
   *   persists across maps. The anchor is the speed on first sight (authored
   *   or loadout-final); applyLoadout invalidates it via
   *   invalidateProgressionSpeedAnchor so title-shop modifiers survive.
   */
  private readonly growthAppliedLevel = new WeakMap<object, number>();
  applyLevelStatGrowth(avatar: PlayerAvatar, spec: GameSpec): void {
    const from = this.growthAppliedLevel.get(avatar) ?? 1;
    const to = Math.min(Math.max(1, Math.floor(this.level)), LEVEL_CAP);
    if (to > from) {
      const ratio = levelRow(to).hpMult / levelRow(from).hpMult;
      if (ratio !== 1) {
        const before = avatar.maxHealth;
        avatar.maxHealth = Math.round(avatar.maxHealth * ratio);
        avatar.heal(avatar.maxHealth - before); // heal the gain only
      }
      this.growthAppliedLevel.set(avatar, to);
    }
    let base = speedBaseAnchors.get(spec);
    if (base === undefined) {
      base = spec.player.speed;
      speedBaseAnchors.set(spec, base);
    }
    spec.player.speed =
      base * levelRow(to).speedMult * Math.pow(1.12, this.upgradeCount('speed'));
  }

  /**
   * 3 distinct upgrade choices, drawn deterministically from engine.rng.
   * Pool = built-ins + upgrades registered via engine.hooks.registerUpgrade.
   */
  getUpgradeChoices(): UpgradeDef[] {
    const pool = [...UPGRADE_POOL, ...this.engine.hooks.customUpgradeDefs()];
    const out: UpgradeDef[] = [];
    for (let i = 0; i < 3 && pool.length > 0; i++) {
      const j = Math.floor(this.engine.rng.next() * pool.length);
      out.push(pool.splice(j, 1)[0]);
    }
    return out;
  }

  /**
   * Apply an upgrade to the avatar. Mutates public PlayerAvatar fields where
   * they exist (health); fire-rate flows through the existing
   * spec.custom.weaponMods hook that shoot() reads per-shot. Damage / speed /
   * magnet / dash have no mutable public field on PlayerAvatar, so they are
   * recorded as counts and exposed via the *Mult() accessors for blueprint
   * wiring (blueprints multiply projectile/melee damage, pickup radius, etc.).
   */
  applyUpgrade(id: string, avatar: PlayerAvatar): void {
    if (!this.opts.enabled) return;
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    switch (id) {
      case 'maxhp':
        avatar.maxHealth = Math.round(avatar.maxHealth * 1.15);
        avatar.heal(avatar.maxHealth);
        break;
      case 'firerate': {
        const spec = this.engine.spec;
        const custom = spec.custom ?? (spec.custom = {});
        const wm = custom.weaponMods ?? (custom.weaponMods = {});
        wm.rateOfFire = (wm.rateOfFire ?? 1) * 1.2;
        break;
      }
      case 'damage':
      case 'speed':
      case 'magnet':
      case 'dash':
        // applied via the multiplier accessors below (blueprint wiring)
        break;
      default:
        // custom upgrade (registered via engine.hooks.registerUpgrade)
        this.engine.hooks.upgrades.get(id)?.apply(this, avatar);
        break;
    }
  }

  upgradeCount(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  /**
   * PORTALS-D: snapshot level/xp/upgrade counts for portal transitions.
   * Plain data — JSON-serializable. The 'firerate' upgrade's live effect
   * (spec.custom.weaponMods.rateOfFire) is captured separately by
   * PortalState.capturePlayerState, since it mutates the spec, not this.
   */
  portalSnapshot(): { level: number; xp: number; counts: Record<string, number> } {
    return { level: this.level, xp: this.xp, counts: Object.fromEntries(this.counts) };
  }

  /**
   * PORTALS-D: restore a portalSnapshot(). Defensive: corrupt values clamp
   * to sane floors rather than throwing mid-transition.
   */
  portalRestore(s: { level: number; xp: number; counts: Record<string, number> }): void {
    this.level = Number.isFinite(s?.level)
      ? Math.max(1, Math.min(LEVEL_CAP, Math.floor(s.level)))
      : 1;
    this.xp = Number.isFinite(s?.xp) ? Math.max(0, s.xp) : 0;
    const counts = s?.counts && typeof s.counts === 'object' ? s.counts : {};
    this.counts = new Map(
      Object.entries(counts).filter(([, v]) => Number.isFinite(v) && (v as number) > 0) as Array<[string, number]>,
    );
  }

  /**
   * Multiplicative damage bonus from 'damage' upgrades, the profile loadout,
   * AND the level table (symmetric with enemy hp growth — folds in so every
   * existing damageMult() call site gets level growth automatically).
   */
  damageMult(): number {
    const profile = this.engine.spec.custom?.profileDamageMult ?? 1;
    return (
      Math.pow(1.25, this.upgradeCount('damage')) *
      profile *
      levelRow(this.level).dmgMult
    );
  }
  /** Cumulative level-table damage multiplier (1.0 at level 1). */
  levelDamageMult(): number {
    return levelRow(this.level).dmgMult;
  }
  /** Cumulative level-table max-HP multiplier (1.0 at level 1). */
  levelHpMult(): number {
    return levelRow(this.level).hpMult;
  }
  /** Cumulative level-table move-speed multiplier (1.0 at level 1). */
  levelSpeedMult(): number {
    return levelRow(this.level).speedMult;
  }
  /** Multiplicative move-speed bonus from 'speed' upgrades. */
  speedMult(): number {
    return Math.pow(1.12, this.upgradeCount('speed'));
  }
  /** Multiplicative pickup-magnet bonus from 'magnet' upgrades. */
  magnetMult(): number {
    return Math.pow(1.5, this.upgradeCount('magnet'));
  }
  /** Multiplicative dash-cooldown factor from 'dash' upgrades. */
  dashCdMult(): number {
    return Math.pow(0.75, this.upgradeCount('dash'));
  }
}
