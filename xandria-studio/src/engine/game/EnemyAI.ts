/**
 * Enemy AI — kind-based behaviors:
 *  walker: capsule, patrol → chase → melee lunge
 *  brute:  bigger, slower, heavier walker
 *  drone/flyer: hover, strafe, shoot projectiles
 *  turret: static, tracks and fires bursts
 * All take damage, flash, die with particles, and may drop pickups.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { GROUP, toV3 } from '../core/Physics';
import { makeHumanoid, makeDrone, makeTurret, disposeOwned, type CharacterRig } from '../gfx/Characters';
import type { EnemySpec } from '@spec';
import type { Projectiles } from './Projectiles';
import { Rng } from '../core/Rng';

export interface EnemyEvents {
  onPlayerHit?: (damage: number, from: THREE.Vector3) => void;
  onDeath?: (e: Enemy) => void;
  /** boss phase transitions (1 at ≤66% HP, 2 at ≤33% HP) */
  onPhase?: (e: Enemy, phase: number) => void;
}

const ENEMY_COLORS: Record<string, { shirt: string; pants: string; accent: string }> = {
  walker: { shirt: '#7a2e2e', pants: '#2e2a26', accent: '#ff5533' },
  brute: { shirt: '#4a2e5e', pants: '#241f28', accent: '#c97aff' },
};

export class Enemy {
  body: CANNON.Body | null = null;
  rig: CharacterRig | null = null;
  turret: { group: THREE.Group; head: THREE.Group; muzzle: THREE.Object3D } | null = null;
  health: number;
  maxHealth: number;
  alive = true;
  home: THREE.Vector3;
  private state: 'idle' | 'chase' | 'attack' = 'idle';
  private attackCd = 0;
  private wanderTarget: THREE.Vector3 | null = null;
  private hoverPhase: number;
  private rng: Rng;
  private speedMult = 1;
  private aggroMult = 1;
  /**
   * Boss flag — set when this enemy is a brute in a boss objective
   * (objective.type === 'boss', or any quest stage with type 'boss').
   * Blueprints may also set it explicitly. Drives phase transitions.
   */
  isBoss: boolean;
  /** boss phase: 0 = full, 1 = enraged (≤66%), 2 = desperate (≤33%) */
  private phase = 0;

  constructor(
    private engine: Engine,
    public spec: EnemySpec,
    spawn: THREE.Vector3,
    private projectiles: Projectiles | null,
    private events: EnemyEvents,
    seed: number,
  ) {
    const mods = engine.spec.custom?.enemyMods;
    this.speedMult = mods?.speed ?? 1;
    this.aggroMult = mods?.aggression ?? 1;
    const sz = mods?.size ?? 1;
    this.health = this.maxHealth = spec.health;
    this.home = spawn.clone();
    this.rng = new Rng(seed);
    this.hoverPhase = this.rng.range(0, Math.PI * 2);
    this.isBoss = spec.kind === 'brute' && Enemy.isBossObjective(engine);

    if (spec.kind === 'walker' || spec.kind === 'brute') {
      const bulk = (spec.kind === 'brute' ? 1.7 : 1) * sz;
      this.body = engine.physics.capsule(0.42 * bulk, 1.7 * bulk, [spawn.x, spawn.y + 1.4 * bulk, spawn.z], {
        mass: 70 * bulk,
        group: GROUP.ENEMY,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.ENEMY | GROUP.PROJECTILE,
      });
      this.rig = makeHumanoid(engine.mats, { ...ENEMY_COLORS[spec.kind], skin: '#8f8a80', bulk }, seed, engine.spec.custom?.forge);
      if (sz !== 1) this.rig.group.scale.setScalar(sz);
      engine.scene.add(this.rig.group);
    } else if (spec.kind === 'drone' || spec.kind === 'flyer') {
      this.body = engine.physics.sphere(0.5 * sz, [spawn.x, spawn.y + 2.5, spawn.z], {
        mass: 8,
        group: GROUP.ENEMY,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.PROJECTILE,
        material: engine.physics.slipperyMat,
      });
      this.body.linearDamping = 0.85;
      this.rig = makeDrone(engine.mats, spec.kind === 'flyer' ? '#8a4a2e' : '#5e2e2e', mods?.glow ?? '#ff4444', seed);
      if (sz !== 1) this.rig.group.scale.setScalar(sz);
      engine.scene.add(this.rig.group);
    } else if (spec.kind === 'turret') {
      this.body = engine.physics.cylinder(0.65, 0.8, 1.4, [spawn.x, spawn.y + 0.7, spawn.z], {
        group: GROUP.ENEMY,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.PROJECTILE,
      });
      this.turret = makeTurret(engine.mats);
      if (sz !== 1) this.turret.group.scale.setScalar(sz);
      this.turret.group.position.set(spawn.x, spawn.y, spawn.z);
      engine.scene.add(this.turret.group);
    }
    const glowRoot = this.rig?.group ?? this.turret?.group;
    if (mods?.glow && glowRoot) this.applyGlow(mods.glow, glowRoot);
  }

  /** True when the objective (or any quest stage) is a boss fight. */
  private static isBossObjective(engine: Engine): boolean {
    const obj = engine.spec.objective;
    if (obj.type === 'boss') return true;
    return !!obj.stages?.some((s) => s.type === 'boss');
  }

  private applyGlow(color: string, root: THREE.Object3D) {
    // FIX: never mutate shared MaterialLibrary-cached materials — clone per-instance
    // first so the glow tints only this enemy.
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const cur = m.material as THREE.Material | THREE.Material[];
      const list = (Array.isArray(cur) ? cur : [cur]).map((mm) => {
        const mat = mm as THREE.MeshStandardMaterial;
        if (mat && 'emissive' in mat && !mat.userData.owned) {
          const c = mat.clone() as THREE.MeshStandardMaterial;
          c.userData.owned = true;
          return c;
        }
        return mat;
      });
      m.material = (Array.isArray(cur) ? list : list[0]) as THREE.Material | THREE.Material[];
      for (const mm of list) {
        mm.emissive = new THREE.Color(color);
        mm.emissiveIntensity = 0.55;
      }
    });
  }

  get position(): THREE.Vector3 {
    if (this.body) return toV3(this.body.position);
    if (this.turret) return this.turret.group.position.clone();
    // post-mortem: body/turret are disposed — report the death site, not the spawn
    return this.deathPos ? this.deathPos.clone() : this.home.clone();
  }
  private deathPos: THREE.Vector3 | null = null;

  damage(amount: number, from?: THREE.Vector3) {
    if (!this.alive) return;
    this.health -= amount;
    this.rig?.flash();
    if (this.turret) {
      const m = (this.turret.head.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      m.emissive.setHex(0xff2222); m.emissiveIntensity = 0.8;
      setTimeout(() => { m.emissive.setHex(0); }, 90);
    }
    // knockback
    if (this.body && from) {
      const dir = this.position.sub(from).setY(0).normalize();
      this.body.applyImpulse(new CANNON.Vec3(dir.x * amount * 0.6, amount * 0.25, dir.z * amount * 0.6));
    }
    if (this.health <= 0) { this.die(); return; }
    this.checkBossPhase();
  }

  /**
   * Boss phase transitions at ≤66% (phase 1, enraged) and ≤33% HP
   * (phase 2, desperate). Each phase multiplies speed and aggression and
   * fires onPhase so the blueprint can show a banner ("The Warden enrages!").
   * No-op for non-boss enemies. Deterministic — no RNG involved.
   */
  private checkBossPhase() {
    if (!this.isBoss || !this.alive) return;
    const frac = this.health / this.maxHealth;
    const want = frac <= 1 / 3 ? 2 : frac <= 2 / 3 ? 1 : 0;
    if (want > this.phase) {
      this.phase = want;
      this.speedMult *= 1.25;
      this.aggroMult *= 1.3;
      this.events.onPhase?.(this, this.phase);
      // engine-owned juice: shake + roar + music slams to full intensity
      this.engine.juice.shake(0.5);
      this.engine.audio.play('roar');
      this.engine.audio.setIntensity(1);
    }
  }

  /** current boss phase (0 = full strength) */
  get bossPhase(): number {
    return this.phase;
  }

  private die() {
    this.alive = false;
    const p = this.position;
    this.deathPos = p.clone();
    this.engine.particles.explosion(p, this.spec.kind === 'brute' ? 1.8 : 1);
    this.engine.audio.play('explosion', { vol: 0.7 });
    this.dispose();
    this.events.onDeath?.(this);
  }

  /**
   * FIX: full lifecycle — remove the body from physics, detach the rig from the
   * scene, and dispose per-instance GPU resources (geometries + owned materials).
   * Shared MaterialLibrary-cached materials are never disposed. Idempotent.
   */
  dispose() {
    if (this.body) {
      this.engine.physics.remove(this.body);
      this.body = null;
    }
    const root = this.rig?.group ?? this.turret?.group;
    if (root) {
      this.engine.scene.remove(root);
      disposeOwned(root);
    }
    this.rig = null;
    this.turret = null;
  }

  update(dt: number, playerPos: THREE.Vector3, t: number) {
    if (!this.alive) return;
    const pos = this.position;
    const dist = pos.distanceTo(playerPos);
    this.attackCd -= dt;

    const aggroR = (this.spec.kind === 'turret' ? 42 : 30) * this.aggroMult;
    const attackR = this.spec.kind === 'walker' || this.spec.kind === 'brute' ? 2.2 : 26;

    if (dist < attackR && this.attackCd <= 0) this.state = 'attack';
    else if (dist < aggroR) this.state = 'chase';
    else if (this.state !== 'idle' && dist > aggroR * 1.3) this.state = 'idle';

    switch (this.spec.kind) {
      case 'walker': case 'brute': {
        const b = this.body!;
        if (this.state === 'chase' || this.state === 'attack') {
          const dir = playerPos.clone().sub(pos).setY(0).normalize();
          const sp = this.spec.speed * this.speedMult * (this.state === 'attack' ? 0.4 : 1);
          b.velocity.x = dir.x * sp;
          b.velocity.z = dir.z * sp;
          this.rig!.group.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI;
          if (this.state === 'attack' && this.attackCd <= 0) {
            this.attackCd = 1.2;
            this.rig!.swing?.();
            if (dist < 2.6) this.events.onPlayerHit?.(this.spec.damage, pos);
          }
        } else {
          // wander
          if (!this.wanderTarget || pos.distanceTo(this.wanderTarget) < 1.5) {
            this.wanderTarget = this.home.clone().add(new THREE.Vector3(this.rng.range(-8, 8), 0, this.rng.range(-8, 8)));
          }
          const dir = this.wanderTarget.clone().sub(pos).setY(0).normalize();
          b.velocity.x = dir.x * this.spec.speed * this.speedMult * 0.3;
          b.velocity.z = dir.z * this.spec.speed * this.speedMult * 0.3;
        }
        this.rig!.group.position.set(pos.x, pos.y - 0.85 * (this.spec.kind === 'brute' ? 1.7 : 1), pos.z);
        const planar = Math.hypot(b.velocity.x, b.velocity.z);
        this.rig!.animate(t, planar, {});
        break;
      }
      case 'drone': case 'flyer': {
        const b = this.body!;
        const hoverY = (this.engine.terrain ? this.engine.terrain.heightAt(pos.x, pos.z) : 0) + (this.spec.kind === 'flyer' ? 4 : 3) + Math.sin(t * 2 + this.hoverPhase) * 0.4;
        const target = this.state === 'idle' ? this.home : playerPos;
        const dir = target.clone().sub(pos);
        dir.y = 0;
        const d = dir.length();
        if (d > 1) dir.normalize();
        // strafe orbit when in range
        if (this.state !== 'idle' && d < 14) {
          const orbit = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(Math.sin(t * 0.7 + this.hoverPhase) > 0 ? 1 : -1);
          dir.multiplyScalar(d > 10 ? 1 : -0.3).add(orbit.multiplyScalar(0.8)).normalize();
        }
        const sp = this.spec.speed * this.speedMult;
        b.velocity.x = dir.x * sp;
        b.velocity.z = dir.z * sp;
        b.velocity.y = (hoverY - pos.y) * 2.2;
        this.rig!.group.position.copy(pos);
        this.rig!.group.rotation.y = Math.atan2(playerPos.x - pos.x, playerPos.z - pos.z);
        this.rig!.animate(t, sp, {});
        if (this.state === 'attack' && this.attackCd <= 0 && this.projectiles) {
          this.attackCd = this.spec.kind === 'flyer' ? 1.6 : 2.2;
          const aim = playerPos.clone().add(new THREE.Vector3(0, 0.9, 0)).sub(pos).normalize();
          this.projectiles.fire(pos.clone().add(aim.clone().multiplyScalar(0.8)), aim, { speed: 26, damage: this.spec.damage, friendly: false });
          this.engine.audio.play('laser', { pitch: 0.8, vol: 0.5 });
        }
        break;
      }
      case 'turret': {
        if (!this.turret) break;
        if (this.state !== 'idle') {
          const head = this.turret.head;
          const want = Math.atan2(playerPos.x - pos.x, playerPos.z - pos.z);
          let d = want - head.rotation.y;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          head.rotation.y += d * Math.min(1, dt * 3);
          if (this.attackCd <= 0 && Math.abs(d) < 0.25 && this.projectiles) {
            this.attackCd = 0.55;
            const muzzle = new THREE.Vector3();
            this.turret.muzzle.getWorldPosition(muzzle);
            const aim = playerPos.clone().add(new THREE.Vector3(0, 1, 0)).sub(muzzle).normalize();
            this.projectiles.fire(muzzle, aim, { speed: 40, damage: this.spec.damage, friendly: false });
            this.engine.audio.play('shoot', { pitch: 1.3, vol: 0.4 });
          }
        }
        break;
      }
    }
  }
}

/** Spawns and manages the full enemy roster from spec. */
export class EnemyManager {
  enemies: Enemy[] = [];
  killed = 0;

  constructor(
    private engine: Engine,
    private projectiles: Projectiles | null,
    private events: EnemyEvents & { onDeath?: (e: Enemy) => void },
  ) {}

  spawnAll(specs: EnemySpec[], spawnFor: (kind: string, i: number, n: number) => THREE.Vector3) {
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        const pos = spawnFor(spec.kind, i, spec.count);
        const e = new Enemy(this.engine, spec, pos, this.projectiles, {
          onPlayerHit: this.events.onPlayerHit,
          // FIX: splice the dead enemy out of the roster so waves can't accumulate corpses forever
          onDeath: (en) => { this.killed++; this.removeEnemy(en); this.events.onDeath?.(en); },
        }, this.engine.spec.meta.seed ^ (this.enemies.length * 7919));
        this.enemies.push(e);
      }
    }
  }

  /** Remove a dead enemy from the roster (its scene/physics/GPU resources are already disposed by die()). */
  private removeEnemy(e: Enemy) {
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
  }

  aliveCount() { return this.enemies.filter((e) => e.alive).length; }

  /** nearest living enemy within r of p */
  nearest(p: THREE.Vector3, r = Infinity): Enemy | null {
    let best: Enemy | null = null, bd = r;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.position.distanceTo(p);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  update(dt: number, playerPos: THREE.Vector3, t: number) {
    // iterate a copy: die() → onDeath → removeEnemy() splices the array mid-loop
    for (const e of [...this.enemies]) e.update(dt, playerPos, t);
  }
}
