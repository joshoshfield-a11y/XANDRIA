/**
 * Enemy variants — blueprint-layer extensions of the engine's EnemyAI kinds.
 *
 * The engine owns walker/brute/drone/flyer/turret. This module layers new
 * behaviors on top WITHOUT touching src/engine/: each variant is spawned as
 * a base kind, then registered with a VariantDirector that applies silhouette
 * decoration, stat tweaks, and per-frame behavior overrides (charger dashes,
 * sniper keep-away, splitter minis, caster volleys, shielded front armor,
 * skyray patrols, spikeball hazards).
 *
 * Everything is deterministic: variant rolls and behavior state come from
 * engine.rng forks only. Variants integrate with the existing kill -> XP ->
 * level-up flow (deaths still fire EnemyManager.onDeath) and the boss-phase
 * system (only brutes in boss stages ever get isBoss; variants never do).
 */
import * as THREE from 'three';
import type { Engine } from '../engine/Engine';
import type { Enemy, EnemyManager } from '../engine/game/EnemyAI';
import type { Projectiles } from '../engine/game/Projectiles';
import type { GameSpec, EnemyKind, EnemySpec } from '@spec';
import type { Rng } from '../engine/core/Rng';
import type { Objectives } from '../engine/game/Objectives';

export type EnemyVariant =
  | 'charger'   // walker base: telegraphs, then dashes at the player
  | 'sniper'    // drone base: keeps range, slow high-damage shots, aim beam
  | 'splitter'  // walker base: bursts into 2 fast minis on death
  | 'caster'    // drone base: kites at range, hurls 3-bolt volleys
  | 'shielded'  // walker base: front-arc damage reduction + shield visual
  | 'skyray'    // flyer base: sine patrol over an area, strafes and shoots
  | 'spikeball' // walker base: hazardous to touch — even stomps hurt
  | 'mini';     // walker base: fast small splitter offspring

/** Structural view of an Enemy — lets unit tests drive behaviors with fakes. */
export interface VariantEnemy {
  alive: boolean;
  spec: { speed: number; damage: number; health: number };
  body: { velocity: { x: number; y: number; z: number } } | null;
  rig: { group: { rotation: { y: number } }; flash(): void } | null;
  position: THREE.Vector3;
  home: THREE.Vector3;
  damage(amount: number, from?: THREE.Vector3): void;
}

export const VARIANT_DEFS: Record<EnemyVariant, { base: EnemyKind; tint: string; blurb: string }> = {
  charger:   { base: 'walker', tint: '#ff4433', blurb: 'Rushes its prey' },
  sniper:    { base: 'drone',  tint: '#2a3f88', blurb: 'Long-range marksman' },
  splitter:  { base: 'walker', tint: '#7aff4d', blurb: 'Splits when killed' },
  caster:    { base: 'drone',  tint: '#b44dff', blurb: 'Hurls bolt volleys' },
  shielded:  { base: 'walker', tint: '#4d7aff', blurb: 'Armored from the front' },
  skyray:    { base: 'flyer',  tint: '#4de8ff', blurb: 'Patrols the skies' },
  spikeball: { base: 'walker', tint: '#7a2020', blurb: 'Do not touch' },
  mini:      { base: 'walker', tint: '#aaff66', blurb: 'Splitter offspring' },
};

/** Which variants each genre may roll, per base kind. */
export type VariantTable = Partial<Record<EnemyKind, EnemyVariant[]>>;
export const ARENA_VARIANTS: VariantTable = {
  walker: ['charger', 'splitter'],
  drone: ['sniper'],
};
export const ACTION_VARIANTS: VariantTable = {
  walker: ['shielded', 'splitter'],
  drone: ['caster', 'sniper'],
};

/**
 * Difficulty ramp: chapter/stage index scales HP (+15%/chapter, compounded)
 * and speed (+8%/chapter, compounded). Pure — safe to unit test.
 */
export function scaleForStage(spec: EnemySpec, stage: number): EnemySpec {
  if (stage <= 0) return { ...spec };
  return {
    ...spec,
    health: Math.max(1, Math.round(spec.health * Math.pow(1.15, stage))),
    speed: spec.speed * Math.pow(1.08, stage),
  };
}

/**
 * Front-arc test for the shielded variant. Facing convention matches the
 * engine's walker rig: rotation.y = atan2(dir.x, dir.z) + PI when facing the
 * player, i.e. model-forward is -Z at rotation 0.
 */
export function isFrontHit(facingYaw: number, epos: THREE.Vector3, fromPos: THREE.Vector3): boolean {
  const fx = Math.sin(facingYaw + Math.PI), fz = Math.cos(facingYaw + Math.PI);
  const dx = fromPos.x - epos.x, dz = fromPos.z - epos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  const dot = (fx * dx + fz * dz) / len;
  return dot > Math.cos(Math.PI / 3.1); // ~58° half-angle
}

/** Shielded damage after the front-arc reduction. Pure — unit testable. */
export function shieldedDamage(e: VariantEnemy, amount: number, from?: THREE.Vector3): number {
  if (!from) return amount;
  const yaw = e.rig?.group.rotation.y ?? 0;
  if (isFrontHit(yaw, e.position, from)) return amount * 0.3;
  return amount;
}

/** Roll a variant for one spawn. Stage-gated: later chapters field more specialists. */
export function pickVariant(kind: EnemyKind, rng: Rng, stage: number, table: VariantTable): EnemyVariant | null {
  const opts = table[kind];
  if (!opts || opts.length === 0) return null;
  const p = stage <= 0 ? 0.22 : stage === 1 ? 0.4 : 0.55;
  if (!rng.chance(p)) return null;
  return opts[rng.int(0, opts.length - 1)];
}

export interface PlannedSpawn { spec: EnemySpec; variant: EnemyVariant | null; }

/** Expand aggregated EnemySpecs into per-unit spawns with variants + stage scaling. */
export function planSpawns(specs: EnemySpec[], rng: Rng, stage: number, table: VariantTable): PlannedSpawn[] {
  const out: PlannedSpawn[] = [];
  for (const s of specs) {
    for (let i = 0; i < s.count; i++) {
      out.push({ spec: scaleForStage({ ...s, count: 1 }, stage), variant: pickVariant(s.kind, rng, stage, table) });
    }
  }
  return out;
}

/** True when the objectives sequencer is currently sitting on a boss stage. */
export function isBossStageActive(spec: GameSpec, objectives: Pick<Objectives, 'currentStageIndex'>): boolean {
  const s = spec.objective.stages?.[objectives.currentStageIndex];
  return !!s && s.type === 'boss';
}

/* ---------------- charger FSM (pure state machine, unit tested) ---------------- */

export interface ChargerMem { mode: 'stalk' | 'windup' | 'dash' | 'cool'; t: number; cd: number; dir: THREE.Vector3; }
export function createChargerMem(rng: Rng): ChargerMem {
  return { mode: 'stalk', t: 0, cd: rng.range(1, 2.5), dir: new THREE.Vector3() };
}
export function stepCharger(m: ChargerMem, dist: number, dt: number): void {
  switch (m.mode) {
    case 'stalk':
      m.cd -= dt;
      if (dist < 13 && m.cd <= 0) { m.mode = 'windup'; m.t = 0.55; }
      break;
    case 'windup':
      m.t -= dt;
      if (m.t <= 0) { m.mode = 'dash'; m.t = 0.65; m.dir.set(0, 0, 0); }
      break;
    case 'dash':
      m.t -= dt;
      if (m.t <= 0) { m.mode = 'cool'; m.cd = 2.6; }
      break;
    case 'cool':
      m.cd -= dt;
      if (m.cd <= 0) m.mode = 'stalk';
      break;
  }
}

export interface CasterMem { burstT: number; phase: number; }
export interface SkyrayMem { phase: number; }

type EnemyMem = ChargerMem | CasterMem | SkyrayMem;

/**
 * VariantDirector — owns per-variant behavior for a blueprint's EnemyManager.
 * Blueprints: register() every spawned enemy (variant or null), decorate()
 * the variants, call update() after enemies.update(), and route onDeath
 * through onEnemyDeath() (splitter minis + visual cleanup).
 */
export class VariantDirector {
  private variants = new Map<Enemy, EnemyVariant>();
  private mem = new Map<Enemy, EnemyMem>();
  private scaled = new Map<Enemy, number>();
  private beams = new Map<Enemy, THREE.Line>();
  private crystals = new Map<Enemy, THREE.Object3D[]>();
  private bossAnnounced = false;
  private rng: Rng;

  constructor(
    private engine: Engine,
    private manager: EnemyManager,
    private projectiles: Projectiles | null,
    salt = 777,
  ) {
    this.rng = engine.rng.fork(salt);
  }

  /**
   * Track a spawned enemy. Clones its spec so per-enemy stage scaling never
   * mutates the shared spec entry. Installs the shielded damage override.
   */
  register(e: Enemy, variant: EnemyVariant | null): void {
    e.spec = { ...e.spec };
    this.scaled.set(e, 0);
    if (!variant) return;
    this.variants.set(e, variant);
    if (variant === 'charger') this.mem.set(e, createChargerMem(this.rng));
    if (variant === 'caster') this.mem.set(e, { burstT: this.rng.range(1, 2.5), phase: this.rng.range(0, Math.PI * 2) });
    if (variant === 'skyray') this.mem.set(e, { phase: this.rng.range(0, Math.PI * 2) });
    if (variant === 'shielded') {
      const orig = e.damage.bind(e);
      const ve = e as unknown as VariantEnemy;
      e.damage = (amount: number, from?: THREE.Vector3) => {
        orig(shieldedDamage(ve, amount, from), from);
      };
    }
  }

  getVariant(e: Enemy): EnemyVariant | null {
    return this.variants.get(e) ?? null;
  }

  /**
   * Stage scaling for ALL tracked enemies (variant or plain): HP +15%/stage,
   * speed +8%/stage, applied incrementally and only upward. Call with the
   * number of chapters cleared (branch-aware, R4-N1) — NOT the quest-graph
   * array index, which would make branch B systematically harder than
   * branch A on the same chapter.
   */
  applyStageScaling(stage: number): void {
    if (stage <= 0) return;
    for (const e of this.manager.enemies) {
      if (!e.alive) continue;
      const done = this.scaled.get(e) ?? 0;
      if (done >= stage) continue;
      const steps = stage - done;
      const hpK = Math.pow(1.15, steps), spK = Math.pow(1.08, steps);
      e.maxHealth = Math.max(1, Math.round(e.maxHealth * hpK));
      e.health = Math.max(1, Math.round(e.health * hpK));
      e.spec = { ...e.spec, speed: e.spec.speed * spK };
      this.scaled.set(e, stage);
    }
  }

  /** Boss-chapter arena intro banner (once per boss stage). */
  notifyStage(_stage: number, isBossStage: boolean): void {
    if (isBossStage && !this.bossAnnounced) {
      this.bossAnnounced = true;
      this.engine.hud.showCard('⚠ THE WARDEN', 'Something ancient stirs in the arena. End it.');
      this.engine.audio.play('alarm');
    } else if (!isBossStage) {
      this.bossAnnounced = false;
    }
  }

  /** Boss health bar — tracks the toughest living enemy while active. */
  updateBossBar(active: boolean): void {
    if (!active) { this.engine.hud.setBoss(null, 0); return; }
    const boss = this.manager.enemies.filter((e) => e.alive).sort((a, b) => b.maxHealth - a.maxHealth)[0];
    if (boss) this.engine.hud.setBoss(`BOSS — ${boss.spec.kind.toUpperCase()}`, boss.health / boss.maxHealth);
    else this.engine.hud.setBoss(null, 0);
  }

  /** Route every EnemyManager onDeath through here first. */
  onEnemyDeath(e: Enemy): void {
    const beam = this.beams.get(e);
    if (beam) {
      this.engine.scene.remove(beam);
      beam.geometry.dispose();
      (beam.material as THREE.Material).dispose();
      this.beams.delete(e);
    }
    const cr = this.crystals.get(e);
    if (cr) {
      for (const c of cr) { this.engine.scene.remove(c); disposeObj(c); }
      this.crystals.delete(e);
    }
    if (this.variants.get(e) === 'splitter') {
      const pos = e.position.clone();
      pos.y += 0.5;
      for (let i = 0; i < 2; i++) {
        const before = this.manager.enemies.length;
        this.manager.spawnAll([{
          kind: 'walker',
          count: 1,
          health: Math.max(8, Math.round(e.maxHealth * 0.3)),
          speed: e.spec.speed * 1.5,
          damage: 6,
          weapon: 'melee',
        }], () => pos.clone().add(new THREE.Vector3(this.rng.range(-1, 1), 0.6, this.rng.range(-1, 1))));
        const mini = this.manager.enemies[before];
        if (mini) { this.register(mini, 'mini'); this.decorate(mini, 'mini'); }
      }
      this.engine.audio.play('explosion', { vol: 0.5, pitch: 1.4 });
    }
    this.variants.delete(e);
    this.mem.delete(e);
    this.scaled.delete(e);
  }

  /** Per-frame variant behaviors. Call after enemies.update(). */
  update(dt: number, playerPos: THREE.Vector3, t: number): void {
    for (const [e, v] of this.variants) {
      if (!e.alive) continue;
      switch (v) {
        case 'charger': this.updateCharger(e, playerPos, dt); break;
        case 'sniper': this.updateSniper(e, playerPos); break;
        case 'caster': this.updateCaster(e, playerPos, dt, t); break;
        case 'skyray': this.updateSkyray(e, t); break;
        case 'spikeball': {
          const s = e.rig?.group.getObjectByName('spikes');
          if (s) s.rotation.y = t * 4;
          break;
        }
        default: break; // splitter/shielded/mini ride on base AI + overrides
      }
    }
  }

  private updateCharger(e: Enemy, playerPos: THREE.Vector3, dt: number): void {
    const m = this.mem.get(e) as ChargerMem;
    if (!m) return;
    const pos = e.position;
    stepCharger(m, pos.distanceTo(playerPos), dt);
    const b = e.body;
    if (!b) return;
    if (m.mode === 'windup') {
      b.velocity.x = 0; b.velocity.z = 0; // telegraph: planted, flashing
      e.rig?.flash();
    } else if (m.mode === 'dash') {
      if (m.dir.lengthSq() === 0) m.dir.copy(playerPos).sub(pos).setY(0).normalize();
      const sp = e.spec.speed * 3.4;
      b.velocity.x = m.dir.x * sp;
      b.velocity.z = m.dir.z * sp;
      if (this.engine.frame % 6 === 0) this.engine.particles.dust(pos, 3);
    }
  }

  private updateSniper(e: Enemy, playerPos: THREE.Vector3): void {
    const b = e.body;
    if (!b) return;
    const pos = e.position;
    const away = pos.clone().sub(playerPos).setY(0);
    const d = away.length();
    if (d < 13 && d > 0.01) { // keep-away: never let the prey close in
      away.normalize();
      b.velocity.x += away.x * e.spec.speed * 1.4;
      b.velocity.z += away.z * e.spec.speed * 1.4;
    }
    let beam = this.beams.get(e);
    if (!beam) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      beam = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.45 }));
      beam.frustumCulled = false;
      this.engine.scene.add(beam);
      this.beams.set(e, beam);
    }
    beam.visible = d < 32;
    if (beam.visible) {
      const p = beam.geometry.attributes.position as THREE.BufferAttribute;
      p.setXYZ(0, pos.x, pos.y + 1.2, pos.z);
      p.setXYZ(1, playerPos.x, playerPos.y + 1, playerPos.z);
      p.needsUpdate = true;
    }
  }

  private updateCaster(e: Enemy, playerPos: THREE.Vector3, dt: number, t: number): void {
    const m = this.mem.get(e) as CasterMem;
    const b = e.body;
    if (!m || !b) return;
    const pos = e.position;
    const to = playerPos.clone().sub(pos).setY(0);
    const d = to.length();
    if (d > 0.01) to.normalize();
    // kite: hold 24–34 units, strafe inside the band
    let mx = 0, mz = 0;
    if (d < 24) { mx = -to.x; mz = -to.z; }
    else if (d > 34) { mx = to.x * 0.6; mz = to.z * 0.6; }
    else {
      const s = Math.sin(t * 0.8 + m.phase) > 0 ? 1 : -1;
      mx = -to.z * 0.7 * s; mz = to.x * 0.7 * s;
    }
    b.velocity.x = mx * e.spec.speed;
    b.velocity.z = mz * e.spec.speed;
    b.velocity.y = (e.home.y + 2.5 + Math.sin(t * 2 + m.phase) * 0.3 - pos.y) * 2;
    // 3-bolt volley
    m.burstT -= dt;
    if (m.burstT <= 0 && d < 38 && this.projectiles) {
      m.burstT = 3.4;
      const from = pos.clone(); from.y += 1;
      for (let k = -1; k <= 1; k++) {
        const aim = playerPos.clone().add(new THREE.Vector3(0, 1, 0)).sub(from).normalize();
        aim.x += k * 0.09; aim.z += k * 0.06; aim.normalize();
        this.projectiles.fire(from.clone(), aim, { speed: 30, damage: e.spec.damage, friendly: false });
      }
      this.engine.audio.play('laser', { pitch: 0.7, vol: 0.5 });
    }
    const cr = this.crystals.get(e);
    if (cr) {
      for (let i = 0; i < cr.length; i++) {
        const a = t * 2.2 + (i / cr.length) * Math.PI * 2;
        cr[i].position.set(
          pos.x + Math.cos(a) * 1.1,
          pos.y + 1.4 + Math.sin(t * 3 + i) * 0.2,
          pos.z + Math.sin(a) * 1.1,
        );
        cr[i].rotation.y = t * 3;
      }
    }
  }

  private updateSkyray(e: Enemy, t: number): void {
    const m = this.mem.get(e) as SkyrayMem;
    const b = e.body;
    if (!m || !b) return;
    const pos = e.position;
    // sine patrol around the spawn anchor; base flyer AI still strafes/shoots
    const tx = e.home.x + Math.sin(t * 0.5 + m.phase) * 5.5;
    const ty = e.home.y + 2.6 + Math.sin(t * 1.7 + m.phase) * 0.8;
    b.velocity.x = (tx - pos.x) * 2.5;
    b.velocity.z = (e.home.z - pos.z) * 2.5;
    b.velocity.y = (ty - pos.y) * 3;
  }

  /**
   * Distinct silhouettes/colors per variant. Tints only per-instance owned
   * materials (never shared library materials), then adds variant props.
   */
  decorate(e: Enemy, variant: EnemyVariant | null): void {
    if (!variant || !e.rig) return;
    const def = VARIANT_DEFS[variant];
    tintOwned(e.rig.group, def.tint, 0.7);
    const mats = this.engine.mats;
    switch (variant) {
      case 'charger': {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 8), mats.glow('#ff3322', 1.5));
        horn.position.set(0, 1.95, -0.35);
        horn.rotation.x = -Math.PI / 2.4;
        e.rig.group.add(horn);
        break;
      }
      case 'sniper': {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 8), mats.flat('#11141c', { metalness: 0.7, roughness: 0.3 }));
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.1, -0.95);
        e.rig.group.add(barrel);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), mats.glow('#ff2222', 2));
        tip.position.set(0, 0.1, -1.8);
        e.rig.group.add(tip);
        break;
      }
      case 'splitter': {
        e.rig.group.scale.multiplyScalar(1.12);
        break;
      }
      case 'caster': {
        const orbs: THREE.Object3D[] = [];
        for (let i = 0; i < 3; i++) {
          const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), mats.glow('#d88aff', 2.2));
          this.engine.scene.add(c);
          orbs.push(c);
        }
        this.crystals.set(e, orbs);
        break;
      }
      case 'shielded': {
        const shield = new THREE.Mesh(
          new THREE.CircleGeometry(0.78, 24),
          new THREE.MeshStandardMaterial({ color: '#4d7aff', metalness: 0.85, roughness: 0.25, emissive: '#1a3faa', emissiveIntensity: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
        );
        shield.position.set(0, 1.1, -0.95);
        shield.rotation.y = Math.PI;
        e.rig.group.add(shield);
        break;
      }
      case 'skyray': {
        const wingMat = new THREE.MeshBasicMaterial({ color: '#4de8ff', side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
        for (const s of [-1, 1]) {
          const wing = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.55), wingMat);
          wing.position.set(s * 0.95, 0.15, 0);
          wing.rotation.z = s * 0.35;
          e.rig.group.add(wing);
        }
        break;
      }
      case 'spikeball': {
        const spikes = new THREE.Group();
        spikes.name = 'spikes';
        const spikeMat = mats.flat('#1c0e0e', { roughness: 0.6 });
        const tipMat = mats.glow('#ff2222', 1.2);
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.65, 6), i % 3 === 0 ? tipMat : spikeMat);
          const r = 0.55;
          cone.position.set(Math.cos(a) * r, 1.05 + Math.sin(i * 2.3) * 0.45, Math.sin(a) * r);
          cone.lookAt(cone.position.clone().multiplyScalar(2).setY(cone.position.y * 2));
          cone.rotateX(Math.PI / 2);
          spikes.add(cone);
        }
        e.rig.group.add(spikes);
        break;
      }
      case 'mini': {
        e.rig.group.scale.multiplyScalar(0.55);
        break;
      }
    }
  }
}

function tintOwned(root: THREE.Object3D, hex: string, amt: number): void {
  const c = new THREE.Color(hex);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of list) {
      const s = mm as THREE.MeshStandardMaterial;
      if (s && s.userData?.owned && 'color' in s) s.color.lerp(c, amt);
    }
  });
}

function disposeObj(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of list) (mm as THREE.Material).dispose();
  });
}
