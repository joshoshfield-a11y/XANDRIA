/** Thin cannon-es wrapper with collision groups, helpers, and a raycast API. */
import * as CANNON from 'cannon-es';
import * as THREE from 'three';

export const GROUP = {
  WORLD: 1,
  PLAYER: 2,
  ENEMY: 4,
  PROJECTILE: 8,
  PICKUP: 16,
  TRIGGER: 32,
  VEHICLE: 64,
} as const;

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  body: CANNON.Body;
}

export class Physics {
  world: CANNON.World;
  readonly defaultMat = new CANNON.Material('default');
  readonly slipperyMat = new CANNON.Material('slippery');
  readonly bouncyMat = new CANNON.Material('bouncy');
  private accumulator = 0;
  readonly fixedStep = 1 / 60;
  private onStep: Array<(dt: number) => void> = [];

  constructor(gravity: number) {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, gravity, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    (this.world.solver as CANNON.GSSolver).iterations = 8;
    this.world.allowSleep = true;
    this.world.defaultContactMaterial.friction = 0.4;
    this.world.defaultContactMaterial.restitution = 0.05;
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.defaultMat, this.defaultMat, { friction: 0.4, restitution: 0.05 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.defaultMat, this.slipperyMat, { friction: 0.0, restitution: 0.0 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.slipperyMat, this.slipperyMat, { friction: 0.0, restitution: 0.0 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.defaultMat, this.bouncyMat, { friction: 0.3, restitution: 0.8 }));
  }

  /** Register a callback run once per fixed step (for controllers that need stable dt). */
  addStepHandler(fn: (dt: number) => void) { this.onStep.push(fn); return () => { this.onStep = this.onStep.filter((f) => f !== fn); }; }

  step(dt: number) {
    this.accumulator += Math.min(dt, 0.1);
    let n = 0;
    while (this.accumulator >= this.fixedStep && n < 5) {
      for (const f of this.onStep) f(this.fixedStep);
      this.world.step(this.fixedStep);
      this.accumulator -= this.fixedStep;
      n++;
    }
    if (n === 5) this.accumulator = 0;
  }

  box(size: THREE.Vector3 | [number, number, number], pos: THREE.Vector3 | [number, number, number], opts: { mass?: number; group?: number; mask?: number; material?: CANNON.Material; quaternion?: THREE.Quaternion } = {}): CANNON.Body {
    const s = Array.isArray(size) ? size : [size.x, size.y, size.z];
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    const body = new CANNON.Body({ mass: opts.mass ?? 0, material: opts.material ?? this.defaultMat, collisionFilterGroup: opts.group ?? GROUP.WORLD, collisionFilterMask: opts.mask ?? -1 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(s[0] / 2, s[1] / 2, s[2] / 2)));
    body.position.set(p[0], p[1], p[2]);
    if (opts.quaternion) body.quaternion.set(opts.quaternion.x, opts.quaternion.y, opts.quaternion.z, opts.quaternion.w);
    this.world.addBody(body);
    return body;
  }

  sphere(radius: number, pos: THREE.Vector3 | [number, number, number], opts: { mass?: number; group?: number; mask?: number; material?: CANNON.Material } = {}): CANNON.Body {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    const body = new CANNON.Body({ mass: opts.mass ?? 1, material: opts.material ?? this.defaultMat, collisionFilterGroup: opts.group ?? GROUP.WORLD, collisionFilterMask: opts.mask ?? -1 });
    body.addShape(new CANNON.Sphere(radius));
    body.position.set(p[0], p[1], p[2]);
    this.world.addBody(body);
    return body;
  }

  cylinder(radiusTop: number, radiusBottom: number, height: number, pos: THREE.Vector3 | [number, number, number], opts: { mass?: number; group?: number; mask?: number; segments?: number } = {}): CANNON.Body {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    const body = new CANNON.Body({ mass: opts.mass ?? 0, material: this.defaultMat, collisionFilterGroup: opts.group ?? GROUP.WORLD, collisionFilterMask: opts.mask ?? -1 });
    body.addShape(new CANNON.Cylinder(radiusTop, radiusBottom, height, opts.segments ?? 8));
    body.position.set(p[0], p[1], p[2]);
    this.world.addBody(body);
    return body;
  }

  /** Capsule-ish character body: a sphere stack with locked rotation. */
  capsule(radius: number, height: number, pos: THREE.Vector3 | [number, number, number], opts: { mass?: number; group?: number; mask?: number } = {}): CANNON.Body {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    const body = new CANNON.Body({ mass: opts.mass ?? 70, material: this.slipperyMat, collisionFilterGroup: opts.group ?? GROUP.PLAYER, collisionFilterMask: opts.mask ?? -1, fixedRotation: true, linearDamping: 0.0 });
    const half = Math.max(0, height / 2 - radius);
    body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, -half, 0));
    if (half > 0) {
      body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, half, 0));
      body.addShape(new CANNON.Cylinder(radius, radius, half * 2, 8));
    }
    body.position.set(p[0], p[1], p[2]);
    body.allowSleep = false;
    body.updateMassProperties();
    this.world.addBody(body);
    return body;
  }

  remove(body: CANNON.Body) { this.world.removeBody(body); }

  raycast(from: THREE.Vector3, to: THREE.Vector3, mask = -1, skipBody?: CANNON.Body): RayHit | null {
    const result = new CANNON.RaycastResult();
    const ray = new CANNON.Ray(new CANNON.Vec3(from.x, from.y, from.z), new CANNON.Vec3(to.x, to.y, to.z));
    ray.intersectWorld(this.world, { mode: CANNON.Ray.CLOSEST, result, skipBackfaces: true, collisionFilterMask: mask, collisionFilterGroup: -1, checkCollisionResponse: false } as any);
    if (!result.hasHit || (skipBody && result.body === skipBody)) return null;
    return {
      point: new THREE.Vector3(result.hitPointWorld.x, result.hitPointWorld.y, result.hitPointWorld.z),
      normal: new THREE.Vector3(result.hitNormalWorld.x, result.hitNormalWorld.y, result.hitNormalWorld.z),
      distance: result.distance,
      body: result.body!,
    };
  }

  /** Ground probe below a point; returns ground Y or null. */
  groundY(x: number, z: number, fromY = 200, mask = GROUP.WORLD): number | null {
    const hit = this.raycast(new THREE.Vector3(x, fromY, z), new THREE.Vector3(x, -200, z), mask);
    return hit ? hit.point.y : null;
  }

  dispose() {
    for (const b of [...this.world.bodies]) this.world.removeBody(b);
    this.onStep = [];
  }
}

export const toV3 = (v: CANNON.Vec3, out = new THREE.Vector3()) => out.set(v.x, v.y, v.z);
export const toCV3 = (v: THREE.Vector3) => new CANNON.Vec3(v.x, v.y, v.z);
export const syncMesh = (mesh: THREE.Object3D, body: CANNON.Body) => {
  mesh.position.set(body.position.x, body.position.y, body.position.z);
  mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
};
