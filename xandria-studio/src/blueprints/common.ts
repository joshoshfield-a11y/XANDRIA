/**
 * Shared player logic for humanoid blueprints: health/lives/respawn, melee + gun weapons.
 */
import * as THREE from 'three';
import type { Engine } from '../engine/Engine';
import { CharacterController } from '../engine/game/CharacterController';
import { EnemyManager } from '../engine/game/EnemyAI';
import type { Projectiles } from '../engine/game/Projectiles';
import type { GameSpec } from '@spec';
import { CRIT_MELEE_SALT, CritRoller, applyCrit, BASE_CRIT_CTX, type CritCtx } from '../engine/game/crit';

export interface PlayerAvatarEvents {
  onDeath?: () => void;
}

export class PlayerAvatar {
  ctrl: CharacterController;
  health: number;
  maxHealth: number;
  lives: number;
  ammo = Infinity;
  private iframes = 0;
  private fireCd = 0;
  spawn: THREE.Vector3;
  private events: PlayerAvatarEvents;
  /**
   * CRIT-SYSTEM: the avatar's own melee crit stream, seeded from the map
   * seed — one draw per enemy hit, never engine.rng / Math.random. The
   * avatar persists across portal transitions (blueprints are not rebuilt
   * on travel), so the stream continues across maps by construction.
   */
  private readonly meleeCrit: CritRoller;

  constructor(
    protected engine: Engine,
    protected spec: GameSpec,
    spawn: THREE.Vector3,
    protected enemies: EnemyManager | null,
    protected projectiles: Projectiles | null,
    events: PlayerAvatarEvents = {},
  ) {
    this.events = events;
    this.spawn = spawn.clone();
    this.meleeCrit = new CritRoller(((spec.meta.seed ?? 0) ^ CRIT_MELEE_SALT) >>> 0);
    this.maxHealth = spec.player.health;
    this.health = this.maxHealth;
    this.lives = spec.rules.lives;
    if (spec.player.weapon === 'blaster' || spec.player.weapon === 'rifle' || spec.player.weapon === 'shotgun') {
      this.ammo = spec.player.weapon === 'rifle' ? 120 : spec.player.weapon === 'shotgun' ? 40 : 80;
    }
    this.ctrl = new CharacterController(engine, spec.player, spawn, {
      shirt: spec.theme.palette.secondary,
      pants: '#2e2a26',
      accent: spec.theme.palette.accent,
    }, {
      onJump: () => engine.audio.play('jump'),
      onLand: (impact) => {
        if (impact > 6) engine.audio.play('land');
        // T1-2: landing dust + shake scaled by impact velocity.
        // (The onLand event existed but nothing subscribed to it.)
        if (impact > 4) {
          // polish wave: bigger landing dust (alpha-blended, grows + fades)
          engine.particles.dust(this.ctrl.position, Math.min(26, Math.round(impact * 1.4)));
          engine.juice.shake(Math.min(0.35, impact * 0.02));
        }
      },
      onDash: () => { engine.audio.play('dash'); engine.particles.dust(this.ctrl.position, 8); },
      onStep: () => engine.audio.play('step', { vol: 0.5 }),
    });
    engine.hud.setLives(this.lives);
    engine.hud.showBoostBar(false);
    // R5-M1: the avatar snapshots loadout-dependent values at construction,
    // but the loadout can change in the title shop after boot(). Register
    // with the engine so beginPlay() can re-sync after applyLoadout().
    engine.setPlayerAvatar(this);
  }

  /**
   * R5-M1: re-copy the construction-time loadout values from the spec.
   * Called by Engine.beginPlay() after applyLoadout(), so a fresh run always
   * starts with the currently equipped modifiers — even when they were
   * bought/equipped in the title shop after boot() built this avatar.
   * Only maxHealth/health/lives are construction-time copies; per-frame
   * values (swift/power) already read the live spec.
   */
  resyncLoadout(): void {
    this.maxHealth = this.spec.player.health;
    this.health = this.maxHealth;
    this.lives = this.spec.rules.lives;
    this.engine.hud.setHealth(1);
    this.engine.hud.setLives(this.lives);
  }

  damage(amount: number, from?: THREE.Vector3) {
    if (this.iframes > 0 || this.engine.state !== 'playing') return;
    this.health -= amount;
    this.iframes = 0.8;
    // daily-challenge scoring: report actual damage taken on the hook bus.
    // Additive — no behavior change; zero taps in the normal flow.
    this.engine.hooks.emit('onPlayerDamage', { amount });
    this.engine.hud.damageFlash();
    this.engine.hud.setHealth(this.health / this.maxHealth);
    this.engine.audio.play('hurt');
    this.ctrl.rig.flash();
    // polish wave: getting hit reads — sparks + shake on top of the HUD flash
    this.engine.juice.combatHit(this.ctrl.position.clone().add(new THREE.Vector3(0, 1.2, 0)), 1.1);
    // DAMAGE-NUMBERS: observe-only — damage taken reads as a themed number
    // above the player (enemyDamage: '−' prefix + danger role).
    this.engine.juice.spawnText(this.engine.camera, this.ctrl.position.clone().add(new THREE.Vector3(0, 1.6, 0)), 'enemyDamage', amount);
    if (this.health <= 0) this.die();
  }

  heal(amount: number) {
    // DAMAGE-NUMBERS: observe-only — show only the health actually
    // restored (0 at full health shows nothing). Per-frame HoT ticks
    // round to 0 and are suppressed, so mend never floods the pool.
    const actual = Math.min(this.maxHealth, this.health + amount) - this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    this.engine.hud.setHealth(this.health / this.maxHealth);
    if (Math.round(actual) >= 1) {
      this.engine.juice.spawnText(this.engine.camera, this.ctrl.position.clone().add(new THREE.Vector3(0, 1.6, 0)), 'heal', actual);
    }
  }

  addAmmo(n: number) { if (this.ammo !== Infinity) this.ammo = Math.min(999, this.ammo + n); }

  private die() {
    // UPGRADE LOOP (hardcore-ironman): one life. An ironman death never
    // touches the lives/respawn path below — the run ends here, the
    // run-completion path marks the slot dead, and there is no respawn.
    // The onPlayerDeath emit still fires first, so the run journal
    // counts the death exactly like a normal death.
    if (this.engine.isIronmanRun()) {
      this.engine.hooks.emit('onPlayerDeath', {});
      this.engine.hud.setLives(0);
      this.engine.audio.play('die');
      this.engine.particles.explosion(this.ctrl.position, 1.2);
      this.events.onDeath?.();
      this.engine.noteIronmanDeath();
      this.engine.lose('Ironman run ended — the slot is dead.');
      return;
    }
    this.lives--;
    // run-journal wave: report player deaths on the hook bus. Additive —
    // no behavior change; zero taps in the normal flow (the onPlayerDamage
    // emit in damage() is the precedent).
    this.engine.hooks.emit('onPlayerDeath', {});
    this.engine.hud.setLives(this.lives);
    this.engine.audio.play('die');
    this.engine.particles.explosion(this.ctrl.position, 1.2);
    this.events.onDeath?.();
    if (this.lives <= 0) {
      this.engine.lose('All lives lost.');
    } else {
      this.health = this.maxHealth;
      this.engine.hud.setHealth(1);
      this.ctrl.teleport(this.spawn.clone().add(new THREE.Vector3(0, 2, 0)));
      this.iframes = 2;
      this.engine.hud.toast(`${this.lives} ${this.lives === 1 ? 'LIFE' : 'LIVES'} LEFT`);
    }
  }

  /**
   * melee arc attack; returns true if swing started.
   * CRIT-SYSTEM: each enemy hit consumes one draw from the avatar's
   * seeded melee crit stream. A crit multiplies the passed damage per
   * the CRIT_TABLE (and renders with crit styling); a non-crit deals
   * the passed damage exactly, as before.
   */
  melee(aimYaw: number, range = 2.6, arc = 1.3, damage = 25, critCtx: CritCtx = BASE_CRIT_CTX): boolean {
    if (!this.enemies) return false;
    this.ctrl.swing();
    // Tutorial wave: observe-only attack seam (no taps = no-op).
    this.engine.hooks.emit('onAttack', { kind: 'melee' });
    this.engine.audio.play('swing');
    const origin = this.ctrl.position;
    const fwd = new THREE.Vector3(Math.sin(aimYaw + Math.PI), 0, Math.cos(aimYaw + Math.PI));
    let hitAny = false;
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      const to = e.position.clone().sub(origin);
      const d = to.length();
      if (d > range) continue;
      to.normalize();
      if (to.dot(fwd) < Math.cos(arc)) continue;
      const roll = this.meleeCrit.roll(critCtx);
      const finalDamage = applyCrit(damage, roll);
      e.damage(finalDamage, origin);
      // DAMAGE-NUMBERS: melee hit feedback — themed floating number per
      // enemy hit (kind, not a caller hex; see floatingText.ts).
      // CRIT-SYSTEM: the kind is now a real crit, not a display highlight.
      this.engine.juice.spawnText(this.engine.camera, e.position, roll.crit ? 'crit' : 'playerDamage', finalDamage);
      hitAny = true;
    }
    if (hitAny) {
      this.engine.audio.play('hit');
      // T1-2: hit-stop on melee connect (60–90ms freeze sells the impact).
      this.engine.juice.hitStop(75);
    }
    return true;
  }

  /** fire current gun toward a world-space direction */
  shoot(dir: THREE.Vector3, muzzle?: THREE.Vector3): boolean {
    if (!this.projectiles || this.fireCd > 0 || this.ammo <= 0) return false;
    const w = this.spec.player.weapon;
    const wm = this.spec.custom?.weaponMods;
    const spd = wm?.projectileSpeed ?? 0;
    const spdMult = spd > 0 ? spd / 42 : 1; // normalized against base blaster-ish speed
    const rof = wm?.rateOfFire ?? 1;
    const extraSpread = wm?.spread ?? 0;
    const beam = wm?.beamColor ? { color: wm.beamColor } : {};
    const from = muzzle ?? this.ctrl.position.clone().add(new THREE.Vector3(0, 1.3, 0));
    if (w === 'shotgun') {
      this.fireCd = 0.7 / rof;
      const pellets = wm?.pellets ?? 5;
      for (let i = 0; i < pellets; i++) {
        const spread = dir.clone();
        const amt = 0.12 + extraSpread;
        spread.x += (this.engine.rng.next() - 0.5) * amt;
        spread.y += (this.engine.rng.next() - 0.5) * amt;
        spread.z += (this.engine.rng.next() - 0.5) * amt;
        this.projectiles.fire(from, spread.normalize(), { speed: 42 * spdMult, damage: 9, friendly: true, life: 0.8, ...beam });
      }
    } else if (w === 'rifle') {
      this.fireCd = 0.12 / rof;
      this.projectiles.fire(from, dir, { speed: 55 * spdMult, damage: 8, friendly: true, ...beam });
    } else {
      this.fireCd = 0.34 / rof;
      this.projectiles.fire(from, dir, { speed: 38 * spdMult, damage: 16, friendly: true, ...beam });
    }
    if (this.ammo !== Infinity) this.ammo--;
    // Tutorial wave: observe-only attack seam (no taps = no-op).
    this.engine.hooks.emit('onAttack', { kind: 'ranged' });
    this.engine.audio.play(w === 'blaster' ? 'laser' : 'shoot');
    // polish wave: muzzle flash + a wisp of real (alpha-blended) gun smoke.
    this.engine.juice.muzzle(from);
    this.engine.juice.shake(0.06);
    return true;
  }

  update(dt: number, t: number) {
    this.iframes -= dt;
    this.fireCd -= dt;
    this.ctrl.update(dt, t);
  }

  get firing() { return this.fireCd > 0; }
  get ammoDisplay() { return this.ammo === Infinity ? '∞' : String(this.ammo); }
}
