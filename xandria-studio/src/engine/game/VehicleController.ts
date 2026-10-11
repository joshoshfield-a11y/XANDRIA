/**
 * Arcade vehicle on cannon-es RaycastVehicle: rear-wheel drive, speed-falloff steering,
 * handbrake drift, boost, auto reset. Drives the procedural car mesh + wheel spin/steer.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { makeCar } from '../gfx/Characters';
import { toV3 } from '../core/Physics';

const _down = new CANNON.Vec3();
const _w = new THREE.Vector3();

export class VehicleController {
  vehicle: CANNON.RaycastVehicle;
  chassis: CANNON.Body;
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
  boost = 1;          // 0..1 boost meter
  private boosting = false;
  // Respawn safety: ring of known-good snapshots. A snapshot is recorded only
  // while moving, upright, and with no recent barrier contact — so driving
  // INTO a trap at speed can never poison the respawn point (the old
  // single-point lastSafe did exactly that: R/reset respawned into the trap).
  private history: { x: number; y: number; z: number; heading: number }[] = [];
  private spawnPos = new THREE.Vector3();
  private spawnHeading = 0;
  private lastContactT = -Infinity;
  private lastRecordT = -Infinity;
  private nowT = 0;
  private safeTimer = 0;
  speed = 0;
  /** signed angle (rad) between chassis heading and velocity — exposed for the chase camera */
  driftAngle = 0;
  /** true while handbrake-sliding at speed */
  drifting = false;
  // polish wave (#12): progressive handbrake engagement + drift FX
  private slipCur = 2.6;      // current rear frictionSlip (damped toward target)
  private prevBrake = false;  // handbrake edge detect
  private skidL: SkidStrip;
  private skidR: SkidStrip;
  private readonly quality: 'retro' | 'standard' | 'high';

  constructor(private engine: Engine, spawn: THREE.Vector3, heading = 0, color = '#c23b2e') {
    const physics = engine.physics;
    const chassisShape = new CANNON.Box(new CANNON.Vec3(0.95, 0.35, 1.8));
    this.chassis = new CANNON.Body({ mass: 260, collisionFilterGroup: 64, collisionFilterMask: -1 });
    this.chassis.addShape(chassisShape);
    this.chassis.position.set(spawn.x, spawn.y + 1.4, spawn.z);
    this.chassis.quaternion.setFromEuler(0, heading, 0);
    this.chassis.allowSleep = false;
    physics.world.addBody(this.chassis);

    this.vehicle = new CANNON.RaycastVehicle({ chassisBody: this.chassis, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2 });
    const wheelOpt = {
      radius: 0.38,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 32,
      suspensionRestLength: 0.45,
      frictionSlip: 2.6,
      dampingRelaxation: 2.6,
      dampingCompression: 4.5,
      maxSuspensionForce: 100000,
      rollInfluence: 0.05,
      axleLocal: new CANNON.Vec3(1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(),
      maxSuspensionTravel: 0.4,
      customSlidingRotationalSpeed: -25,
      useCustomSlidingRotationalSpeed: true,
    };
    const anchors = [
      new CANNON.Vec3(0.85, 0, -1.15),  // front right
      new CANNON.Vec3(-0.85, 0, -1.15), // front left
      new CANNON.Vec3(0.85, 0, 1.15),   // rear right
      new CANNON.Vec3(-0.85, 0, 1.15),  // rear left
    ];
    for (const a of anchors) {
      wheelOpt.chassisConnectionPointLocal = a.clone();
      this.vehicle.addWheel({ ...wheelOpt, chassisConnectionPointLocal: a.clone() });
    }
    this.vehicle.addToWorld(physics.world);

    const car = makeCar(engine.mats, color, engine.spec.meta.seed, engine.spec.custom?.forge);
    this.mesh = car.group;
    this.wheels = car.wheels;
    // wheels authored with origin at ground; shift mesh so origin ≈ chassis center
    this.mesh.children.forEach((c) => { c.position.y -= 0.35; });
    engine.scene.add(this.mesh);
    this.spawnPos.copy(spawn);
    this.spawnHeading = heading;
    // any barrier contact invalidates "safe" recording for a short window
    this.chassis.addEventListener('collide', () => { this.lastContactT = this.nowT; });
    this.quality = engine.effectiveQuality();
    const maxSegs = this.quality === 'high' ? 420 : this.quality === 'standard' ? 280 : 140;
    this.skidL = new SkidStrip(engine.scene, maxSegs);
    this.skidR = new SkidStrip(engine.scene, maxSegs);
  }

  get position(): THREE.Vector3 { return toV3(this.chassis.position); }
  get heading(): number {
    const q = this.chassis.quaternion;
    const fwd = new CANNON.Vec3(0, 0, -1);
    const w = q.vmult(fwd);
    return Math.atan2(w.x, w.z);
  }

  update(dt: number, input: { axes: { x: number; y: number }; boost: boolean; brake: boolean; reset: boolean }) {
    this.nowT += dt;
    const v = this.chassis.velocity;
    this.speed = Math.sqrt(v.x * v.x + v.z * v.z);
    const vSign = this.forwardSpeed() >= -0.5 ? 1 : -1;

    // drift state (#12): signed angle between heading and travel direction
    const fwd = this.chassis.quaternion.vmult(new CANNON.Vec3(0, 0, -1));
    this.driftAngle = this.speed > 1
      ? Math.atan2(fwd.x * v.z - fwd.z * v.x, fwd.x * v.x + fwd.z * v.z)
      : 0;
    this.drifting = input.brake && this.speed > 6 && Math.abs(this.driftAngle) > 0.12;

    // #12: speed-sensitive downforce (extra -y ∝ speed²) — keeps the car planted at boost speeds
    _down.set(0, -0.35 * this.speed * this.speed, 0);
    this.chassis.applyForce(_down);

    // steering with speed falloff; a touch wider on handbrake for countersteer
    const maxSteer = (0.55 / (1 + this.speed * 0.045)) * (input.brake ? 1.15 : 1);
    const steer = -input.axes.x * maxSteer;
    this.vehicle.setSteeringValue(steer, 0);
    this.vehicle.setSteeringValue(steer, 1);

    // throttle
    this.boosting = input.boost && this.boost > 0.02;
    if (this.boosting) this.boost = Math.max(0, this.boost - dt * 0.45);
    else this.boost = Math.min(1, this.boost + dt * 0.12);
    const force = 2600 * (this.boosting ? 1.9 : 1);
    const throttle = -input.axes.y; // forward = -z local
    if (Math.abs(throttle) > 0.01) {
      const f = force * throttle;
      this.vehicle.applyEngineForce(-f, 2);
      this.vehicle.applyEngineForce(-f, 3);
    } else {
      this.vehicle.applyEngineForce(0, 2);
      this.vehicle.applyEngineForce(0, 3);
    }

    // brakes / handbrake drift — #12: frictionSlip eases in so slides engage
    // progressively instead of snapping; entry kick starts the slide snappily.
    const brakeF = input.brake ? 9 : 0;
    for (let i = 0; i < 4; i++) this.vehicle.setBrake(brakeF, i);
    const slipTarget = input.brake ? 0.9 : 2.6;
    this.slipCur = THREE.MathUtils.damp(this.slipCur, slipTarget, 9, dt);
    this.vehicle.wheelInfos[2].frictionSlip = this.slipCur;
    this.vehicle.wheelInfos[3].frictionSlip = this.slipCur;
    if (input.brake && !this.prevBrake && this.speed > 12 && Math.abs(input.axes.x) > 0.25) {
      // rear steps out opposite the steering input
      const right = this.chassis.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
      const kick = -Math.sign(input.axes.x) * this.speed * 0.055 * 260;
      this.chassis.applyImpulse(new CANNON.Vec3(right.x * kick, 0, right.z * kick));
    }
    this.prevBrake = input.brake;
    // #12: slightly stronger engine braking on coast
    if (!input.brake && Math.abs(throttle) < 0.01) for (let i = 0; i < 4; i++) this.vehicle.setBrake(1.1, i);

    // reset if flipped/stuck
    const up = new CANNON.Vec3(0, 1, 0);
    const worldUp = this.chassis.quaternion.vmult(up);
    const flipped = worldUp.y < 0.2;
    if (flipped) this.safeTimer += dt; else this.safeTimer = 0;
    if (input.reset || this.safeTimer > 1.6) this.respawn();
    // record a safe snapshot: moving, upright, and no recent contact.
    // throttled to 2 Hz, ring-capped — the respawn point can never be inside
    // a trap the car just drove into.
    if (!flipped && this.speed > 3 && this.nowT - this.lastContactT > 1.5 && this.nowT - this.lastRecordT > 0.5) {
      this.lastRecordT = this.nowT;
      const p = this.chassis.position;
      this.history.push({ x: p.x, y: p.y, z: p.z, heading: this.heading });
      if (this.history.length > 24) this.history.shift();
    }

    // sync visuals
    this.mesh.position.copy(toV3(this.chassis.position));
    this.mesh.quaternion.set(this.chassis.quaternion.x, this.chassis.quaternion.y, this.chassis.quaternion.z, this.chassis.quaternion.w);
    for (let i = 0; i < 4; i++) {
      this.vehicle.updateWheelTransform(i);
      const t = this.vehicle.wheelInfos[i].worldTransform;
      this.wheels[i].position.set(t.position.x, t.position.y, t.position.z).sub(this.mesh.position);
      // rotate wheel mesh by steering (front) — visual only
      if (i < 2) this.wheels[i].rotation.y = -steer * 1.2;
      this.wheels[i].rotation.x += (this.speed / 0.38) * dt * vSign * 0.9;
    }
    // exhaust particles when boosting
    if (this.boosting && this.engine.frame % 3 === 0) {
      const back = new THREE.Vector3(0, 0.3, 1.9).applyQuaternion(this.mesh.quaternion).add(this.mesh.position);
      this.engine.particles.burst(back, { count: 2, color: '#66ccff', color2: '#ffffff', speed: 2, life: 0.3, size: 1.4, gravity: 0 });
    }
    // #9: drift smoke + skid marks behind the rear wheels
    this.skidL.update(dt);
    this.skidR.update(dt);
    if (this.drifting) {
      const strips = [this.skidL, this.skidR];
      const fx = this.chassis.quaternion.vmult(new CANNON.Vec3(0, 0, -1));
      const rx = -fx.z, rz = fx.x; // right = fwd × up (horizontal)
      for (let k = 0; k < 2; k++) {
        const i = 2 + k; // rear wheels
        const wt = this.vehicle.wheelInfos[i].worldTransform;
        const wx = wt.position.x, wz = wt.position.z;
        const wy = this.engine.terrain
          ? this.engine.terrain.heightAt(wx, wz) + 0.03
          : wt.position.y - 0.34;
        strips[k].push(wx + rx * 0.11, wz + rz * 0.11, wx - rx * 0.11, wz - rz * 0.11, wy);
      }
      const cadence = this.quality === 'high' ? 2 : 4;
      if (this.engine.frame % cadence === 0) {
        for (let k = 0; k < 2; k++) {
          const i = 2 + k;
          const wt = this.vehicle.wheelInfos[i].worldTransform;
          _w.set(wt.position.x, wt.position.y - 0.2, wt.position.z);
          this.engine.particles.burst(_w, {
            count: 3, color: '#6e6e6e', color2: '#a8a8a8',
            speed: 1.3, life: 1.15, size: 2.6, gravity: -1.5, up: 1.1,
          });
        }
      }
    } else {
      this.skidL.break();
      this.skidR.break();
    }
  }

  private forwardSpeed(): number {
    const fwd = this.chassis.quaternion.vmult(new CANNON.Vec3(0, 0, -1));
    const v = this.chassis.velocity;
    return fwd.x * v.x + fwd.y * v.y + fwd.z * v.z;
  }

  /**
   * Respawn at the newest known-good snapshot meaningfully away from the
   * current (wedged) position; falls back to the constructor spawn when no
   * snapshot qualifies. The car is re-oriented along its travel direction at
   * the snapshot — never kept on the crash heading. History is truncated at
   * the chosen snapshot so a second reset walks further back, and a respawn
   * can never return the car to the trap it just left.
   */
  respawn() {
    const p = this.chassis.position;
    let pick: { x: number; y: number; z: number; heading: number } | null = null;
    let pickIdx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      const dx = h.x - p.x, dz = h.z - p.z;
      if (dx * dx + dz * dz > 25) { pick = h; pickIdx = i; break; } // >5 m away
    }
    const t = pick ?? { x: this.spawnPos.x, y: this.spawnPos.y, z: this.spawnPos.z, heading: this.spawnHeading };
    this.chassis.position.set(t.x, t.y + 2, t.z);
    this.chassis.velocity.setZero();
    this.chassis.angularVelocity.setZero();
    this.chassis.quaternion.setFromEuler(0, t.heading, 0);
    this.safeTimer = 0;
    if (pickIdx >= 0) this.history.length = pickIdx + 1;
    else this.history.length = 0;
  }
}

interface SkidSeg {
  ax: number; az: number; bx: number; bz: number;  // previous edge pair
  cx: number; cz: number; dx: number; dz: number;  // current edge pair
  ya: number; yb: number; birth: number;
}

/**
 * Fade-out skid-mark ribbon behind one rear wheel (#9). Segments are laid only
 * while drifting; fading is GPU-side (aBirth + uTime), so nothing runs per
 * frame except the two strip updates. All buffers are preallocated once at
 * construction and updated in place — no per-push allocation, no GL leaks.
 * Segment cap follows the quality scaler.
 */
export class SkidStrip {
  private segs: SkidSeg[] = [];
  private time = 0;
  private last: { ax: number; az: number; bx: number; bz: number; y: number } | null = null;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private posAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;

  constructor(scene: THREE.Scene, private maxSegs: number, private fadeSec = 8) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: { uTime: { value: 0 }, uFade: { value: fadeSec } },
      vertexShader: `
        attribute float aBirth;
        varying float vA;
        uniform float uTime;
        uniform float uFade;
        void main() {
          vA = clamp(1.0 - (uTime - aBirth) / uFade, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          gl_FragColor = vec4(0.012, 0.012, 0.014, vA * 0.55);
        }`,
    });
    // preallocated ring: positions + birth times written in place; the index
    // buffer is static (maxSegs quads) and only the draw range moves.
    this.posAttr = new THREE.BufferAttribute(new Float32Array(maxSegs * 12), 3);
    this.birthAttr = new THREE.BufferAttribute(new Float32Array(maxSegs * 4), 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.birthAttr.setUsage(THREE.DynamicDrawUsage);
    const idx = maxSegs * 6 > 65535 ? new Uint32Array(maxSegs * 6) : new Uint16Array(maxSegs * 6);
    for (let i = 0; i < maxSegs; i++) {
      const b = i * 4, q = i * 6;
      idx[q] = b; idx[q + 1] = b + 2; idx[q + 2] = b + 1;
      idx[q + 3] = b + 1; idx[q + 4] = b + 2; idx[q + 5] = b + 3;
    }
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aBirth', this.birthAttr);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /** Break ribbon continuity (call when the drift ends). */
  break() { this.last = null; }

  /** Append a tire-width edge pair; skipped until the wheel moved ~0.3 m. */
  push(ax: number, az: number, bx: number, bz: number, y: number) {
    const L = this.last;
    if (L) {
      const mx = (ax + bx) / 2 - (L.ax + L.bx) / 2;
      const mz = (az + bz) / 2 - (L.az + L.bz) / 2;
      if (mx * mx + mz * mz < 0.09) return;
      if (this.segs.length >= this.maxSegs) {
        this.segs.shift();
        // slide the ring buffers down one segment in place
        (this.posAttr.array as Float32Array).copyWithin(0, 12);
        (this.birthAttr.array as Float32Array).copyWithin(0, 4);
      }
      this.segs.push({
        ax: L.ax, az: L.az, bx: L.bx, bz: L.bz,
        cx: ax, cz: az, dx: bx, dz: bz,
        ya: L.y, yb: y, birth: this.time,
      });
      this.writeSeg(this.segs.length - 1, this.segs[this.segs.length - 1]);
      this.geo.setDrawRange(0, this.segs.length * 6);
      this.mesh.visible = true;
    }
    this.last = { ax, az, bx, bz, y };
  }

  update(dt: number) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    const n = this.segs.length;
    if (n > 0 && this.time - this.segs[n - 1].birth > this.fadeSec) {
      this.segs.length = 0;
      this.geo.setDrawRange(0, 0);
      this.mesh.visible = false;
    }
  }

  private writeSeg(i: number, s: SkidSeg) {
    const pos = this.posAttr.array as Float32Array;
    const birth = this.birthAttr.array as Float32Array;
    const o = i * 12, b = i * 4;
    pos[o] = s.ax;     pos[o + 1] = s.ya; pos[o + 2] = s.az;
    pos[o + 3] = s.bx; pos[o + 4] = s.ya; pos[o + 5] = s.bz;
    pos[o + 6] = s.cx; pos[o + 7] = s.yb; pos[o + 8] = s.cz;
    pos[o + 9] = s.dx; pos[o + 10] = s.yb; pos[o + 11] = s.dz;
    birth[b] = s.birth; birth[b + 1] = s.birth; birth[b + 2] = s.birth; birth[b + 3] = s.birth;
    this.posAttr.needsUpdate = true;
    this.birthAttr.needsUpdate = true;
  }
}
