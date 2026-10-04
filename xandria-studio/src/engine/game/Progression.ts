/**
 * Progression — XP/level system + upgrade choices for the campaign layer.
 *
 * Blueprints feed it kills/pickups; on level-up they show the HUD's
 * level-up modal with getUpgradeChoices() and apply the chosen upgrade.
 * Deterministic: upgrade choices draw from engine.rng (seeded).
 * Everything no-ops cleanly when spec.progression.enabled is false.
 */
import type { Engine } from '../Engine';
import type { PlayerAvatar } from '../../blueprints/common';
import type { ProgressionSpec } from '@spec';

export type UpgradeId =
  | 'damage'
  | 'maxhp'
  | 'speed'
  | 'firerate'
  | 'magnet'
  | 'dash';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  desc: string;
}

/** Mirrors the spec-side ProgressionSpec shape verbatim. */
export type ProgressionOpts = ProgressionSpec;

const DEFAULT_OPTS: ProgressionOpts = {
  enabled: false,
  xpPerKill: 20,
  xpPerPickup: 5,
};

const UPGRADE_POOL: UpgradeDef[] = [
  { id: 'damage', name: 'Heavy Rounds', desc: '+25% damage' },
  { id: 'maxhp', name: 'Reinforced Plating', desc: '+15% max integrity, repair to full' },
  { id: 'speed', name: 'Servo Motors', desc: '+12% move speed' },
  { id: 'firerate', name: 'Trigger Discipline', desc: '+20% fire rate' },
  { id: 'magnet', name: 'Tractor Field', desc: '+50% pickup magnet range' },
  { id: 'dash', name: 'Ion Thrusters', desc: '-25% dash cooldown' },
];

export class Progression {
  level = 1;
  xp = 0;
  private counts = new Map<UpgradeId, number>();
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
    };
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  xpForNext(level: number): number {
    return Math.round(100 * Math.pow(level, 1.5));
  }

  /** Add XP; returns true if this caused at least one level-up. */
  addXp(n: number): boolean {
    if (!this.opts.enabled || n <= 0) return false;
    this.xp += n;
    let leveled = false;
    while (this.xp >= this.xpForNext(this.level)) {
      this.xp -= this.xpForNext(this.level);
      this.level++;
      leveled = true;
    }
    return leveled;
  }

  /** Convenience: XP for a kill. Returns true on level-up. */
  onKill(): boolean {
    return this.addXp(this.opts.xpPerKill);
  }

  /** Convenience: XP for a pickup. Returns true on level-up. */
  onPickup(): boolean {
    return this.addXp(this.opts.xpPerPickup);
  }

  /** 3 distinct upgrade choices, drawn deterministically from engine.rng. */
  getUpgradeChoices(): UpgradeDef[] {
    const pool = [...UPGRADE_POOL];
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
  applyUpgrade(id: UpgradeId, avatar: PlayerAvatar): void {
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
    }
  }

  upgradeCount(id: UpgradeId): number {
    return this.counts.get(id) ?? 0;
  }

  /** Multiplicative damage bonus from 'damage' upgrades. */
  damageMult(): number {
    return Math.pow(1.25, this.upgradeCount('damage'));
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
