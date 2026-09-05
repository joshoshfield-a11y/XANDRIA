/**
 * CharacterController — capsule + camera-relative movement, jump w/ coyote time, double jump,
 * dash, sprint, glide. Drives a CharacterRig visual. The reference controller all
 * humanoid blueprints build on.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { toV3 } from '../core/Physics';
import { makeHumanoid, type CharacterRig } from '../gfx/Characters';
import type { PlayerSpec } from '@spec';

export interface ControllerEvents {
  onJump?: () => void;
  onLand?: (impact: number) => void;
  onDash?: () => void;
  onStep?: () => void;
}

export class CharacterController {
  body: CANNON.Body;
  rig: CharacterRig;
  yaw = 0;
  grounded = false;
  private coyote = 0;
  private jumps = 0;
  private dashCd = 0;
  private dashT = 0;
  private dashDir = new THREE.Vector3();
  attackT = -1; // 0..1 swing progress, -1 idle
  attacking = false;
  speedBoostT = 0;
  /** set each frame by the blueprint from the active camera rig — movement is camera-relative */
  camYaw = 0;
  private stepAcc = 0;
  private wasGrounded = true;

  constructor(
    private engine: Engine,
    private spec: PlayerSpec,
    spawn: THREE.Vector3,
    colors: { skin?: string; shirt?: string; pants?: string; accent?: string } = {},
    private events: ControllerEvents = {},
  ) {
    this.body = engine.physics.capsule(0.42, 1.7, [spawn.x, spawn.y + 1.2, spawn.z], { mass: 70 });
    this.rig = makeHumanoid(engine.mats, colors, engine.spec.meta.seed);
    engine.scene.add(this.rig.group);
    engine.physics.addStepHandler((dt) => this.fixedUpdate(dt));
  }

  get position(): THREE.Vector3 { return toV3(this.body.position); }
  get velocity(): THREE.Vector3 { return toV3(this.body.velocity); }

  teleport(p: THREE.Vector3) {
    this.body.position.set(p.x, p.y, p.z);
    this.body.velocity.setZero();
  }

  private fixedUpdate(dt: number) {
    const input = this.engine.input;
    const b = this.body;
    const camYaw = this.camYaw;

    // movement intent in camera space
    const ax = input.axes;
    const run = this.spec.abilities.includes('sprint') && input.pressed('sprint');
    const boost = this.speedBoostT > 0 ? 1.5 : 1;
    const targetSpeed = this.spec.speed * (run ? 1.65 : 1) * boost;

    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    const dir = new THREE.Vector3(ax.x * cos - ax.y * sin, 0, -ax.x * sin - ax.y * cos);
    // NOTE: forward (−z at yaw 0) mapped so W walks away from camera
    const moving = dir.lengthSq() > 0.001;

    // ground probe
    const from = new THREE.Vector3(b.position.x, b.position.y + 0.2, b.position.z);
    const hit = this.engine.physics.raycast(from, from.clone().add(new THREE.Vector3(0, -1.45, 0)), -1, b);
    this.grounded = !!hit;
    if (this.grounded) { this.coyote = 0.12; this.jumps = 0; }
    else this.coyote -= dt;

    if (this.grounded && !this.wasGrounded) {
      this.events.onLand?.(Math.abs(b.velocity.y));
    }
    this.wasGrounded = this.grounded;

    // dash
    this.dashCd -= dt;
    if (this.spec.abilities.includes('dash') && input.justPressed('dash') && this.dashCd <= 0) {
      this.dashCd = 1.4;
      this.dashT = 0.22;
      this.dashDir.copy(moving ? dir : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(-1));
      this.events.onDash?.();
    }

    // horizontal velocity
    const cur = new THREE.Vector3(b.velocity.x, 0, b.velocity.z);
    if (this.dashT > 0) {
      this.dashT -= dt;
      const dv = this.dashDir.clone().normalize().multiplyScalar(this.spec.speed * 3.4);
      b.velocity.x = dv.x; b.velocity.z = dv.z;
    } else if (moving) {
      dir.normalize();
      const want = dir.multiplyScalar(targetSpeed);
      const accel = this.grounded ? 40 : 14;
      cur.x = THREE.MathUtils.damp(cur.x, want.x, accel / 8, dt);
      cur.z = THREE.MathUtils.damp(cur.z, want.z, accel / 8, dt);
      b.velocity.x = cur.x; b.velocity.z = cur.z;
      this.yaw = Math.atan2(want.x, want.z);
      // footsteps
      if (this.grounded) {
        this.stepAcc += cur.length() * dt;
        if (this.stepAcc > 2.2) { this.stepAcc = 0; this.events.onStep?.(); }
      }
    } else if (this.grounded) {
      b.velocity.x = THREE.MathUtils.damp(b.velocity.x, 0, 12, dt);
      b.velocity.z = THREE.MathUtils.damp(b.velocity.z, 0, 12, dt);
    }

    // jump
    const maxJumps = this.spec.abilities.includes('doubleJump') ? 2 : 1;
    if (input.justPressed('jump')) {
      if (this.coyote > 0 || this.jumps < maxJumps) {
        if (this.coyote <= 0) this.jumps++;
        else this.jumps = 1;
        b.velocity.y = this.spec.jump;
        this.coyote = 0;
        this.events.onJump?.();
      }
    }
    // glide
    if (this.spec.abilities.includes('glide') && !this.grounded && b.velocity.y < -2 && input.pressed('jump')) {
      b.velocity.y = Math.max(b.velocity.y, -2.2);
    }
    if (this.speedBoostT > 0) this.speedBoostT -= dt;
  }

  /** per-render-frame update: visuals */
  update(dt: number, t: number) {
    const p = this.position;
    this.rig.group.position.set(p.x, p.y - 0.85, p.z);
    // face movement yaw
    const targetRot = this.yaw + Math.PI; // model faces +z
    let d = targetRot - this.rig.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.rig.group.rotation.y += d * Math.min(1, dt * 14);
    const v = this.velocity;
    const planar = Math.hypot(v.x, v.z);
    this.rig.animate(t, planar, { attacking: this.attackT >= 0 ? 1 - this.attackT : 0 });
    if (this.attackT >= 0) {
      this.attackT -= dt * 3.4;
      if (this.attackT < 0) this.attackT = -1;
    }
  }

  swing() { this.attackT = 1; }
}
