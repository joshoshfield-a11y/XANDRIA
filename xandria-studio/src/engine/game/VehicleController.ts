/**
 * Arcade vehicle on cannon-es RaycastVehicle: rear-wheel drive, speed-falloff steering,
 * handbrake drift, boost, auto reset. Drives the procedural car mesh + wheel spin/steer.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { makeCar } from '../gfx/Characters';
import { toV3 } from '../core/Physics';

export class VehicleController {
  vehicle: CANNON.RaycastVehicle;
  chassis: CANNON.Body;
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
  boost = 1;          // 0..1 boost meter
  private boosting = false;
  private lastSafe = new THREE.Vector3();
  private safeTimer = 0;
  speed = 0;

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

    const car = makeCar(engine.mats, color, engine.spec.meta.seed);
    this.mesh = car.group;
    this.wheels = car.wheels;
    // wheels authored with origin at ground; shift mesh so origin ≈ chassis center
    this.mesh.children.forEach((c) => { c.position.y -= 0.35; });
    engine.scene.add(this.mesh);
    this.lastSafe.copy(spawn);
  }

  get position(): THREE.Vector3 { return toV3(this.chassis.position); }
  get heading(): number {
    const q = this.chassis.quaternion;
    const fwd = new CANNON.Vec3(0, 0, -1);
    const w = q.vmult(fwd);
    return Math.atan2(w.x, w.z);
  }

  update(dt: number, input: { axes: { x: number; y: number }; boost: boolean; brake: boolean; reset: boolean }) {
    const v = this.chassis.velocity;
    this.speed = Math.sqrt(v.x * v.x + v.z * v.z);
    const vSign = this.forwardSpeed() >= -0.5 ? 1 : -1;

    // steering with speed falloff
    const maxSteer = 0.55 / (1 + this.speed * 0.045);
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

    // brakes / handbrake drift
    const brakeF = input.brake ? 9 : 0;
    for (let i = 0; i < 4; i++) this.vehicle.setBrake(brakeF, i);
    this.vehicle.wheelInfos[2].frictionSlip = input.brake ? 0.9 : 2.6;
    this.vehicle.wheelInfos[3].frictionSlip = input.brake ? 0.9 : 2.6;
    if (!input.brake && Math.abs(throttle) < 0.01) for (let i = 0; i < 4; i++) this.vehicle.setBrake(0.6, i);

    // reset if flipped/stuck
    const up = new CANNON.Vec3(0, 1, 0);
    const worldUp = this.chassis.quaternion.vmult(up);
    const flipped = worldUp.y < 0.2;
    if (flipped) this.safeTimer += dt; else this.safeTimer = 0;
    if (input.reset || this.safeTimer > 1.6) this.respawn();
    if (!flipped && this.speed > 3) this.lastSafe.copy(this.chassis.position);

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
  }

  private forwardSpeed(): number {
    const fwd = this.chassis.quaternion.vmult(new CANNON.Vec3(0, 0, -1));
    const v = this.chassis.velocity;
    return fwd.x * v.x + fwd.y * v.y + fwd.z * v.z;
  }

  respawn() {
    this.chassis.position.set(this.lastSafe.x, this.lastSafe.y + 2, this.lastSafe.z);
    this.chassis.velocity.setZero();
    this.chassis.angularVelocity.setZero();
    this.chassis.quaternion.setFromEuler(0, this.heading, 0);
    this.safeTimer = 0;
  }
}
