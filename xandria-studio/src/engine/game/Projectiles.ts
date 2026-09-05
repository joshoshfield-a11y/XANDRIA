/** Pooled projectiles: glowing tracers with physics spheres, impact particles + damage callback. */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { GROUP, toV3 } from '../core/Physics';

export interface Projectile {
  active: boolean;
  mesh: THREE.Mesh;
  body: CANNON.Body;
  life: number;
  damage: number;
  friendly: boolean;
}

const POOL = 64;

export class Projectiles {
  pool: Projectile[] = [];
  onHit: (p: Projectile, hitBody: CANNON.Body | null, point: THREE.Vector3) => void = () => {};

  constructor(private engine: Engine, private color = '#7af7ff') {
    const geo = new THREE.SphereGeometry(0.14, 6, 6);
    const mat = engine.mats.glow(color, 2.5);
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      engine.scene.add(mesh);
      const body = engine.physics.sphere(0.14, [0, -500, 0], {
        mass: 0.1,
        group: GROUP.PROJECTILE,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.ENEMY,
      });
      body.allowSleep = false;
      this.pool.push({ active: false, mesh, body, life: 0, damage: 10, friendly: true });
    }
  }

  fire(from: THREE.Vector3, dir: THREE.Vector3, opts: { speed?: number; damage?: number; friendly?: boolean; life?: number } = {}) {
    const p = this.pool.find((x) => !x.active);
    if (!p) return;
    p.active = true;
    p.life = opts.life ?? 2.2;
    p.damage = opts.damage ?? 10;
    p.friendly = opts.friendly ?? true;
    p.body.position.set(from.x, from.y, from.z);
    p.body.velocity.set(dir.x, dir.y, dir.z).scale(opts.speed ?? 34, p.body.velocity);
    p.body.collisionFilterGroup = GROUP.PROJECTILE;
    p.body.collisionFilterMask = GROUP.WORLD | (p.friendly ? GROUP.ENEMY : GROUP.PLAYER);
    p.mesh.visible = true;
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      const pos = toV3(p.body.position);
      if (p.life <= 0 || pos.y < -80) { this.kill(p); continue; }
      // trail
      if (this.engine.frame % 2 === 0) this.engine.particles.trail(pos, this.color);
      p.mesh.position.copy(pos);
    }
    // collision via contact events — cheap scan: raycast along motion each frame
    for (const p of this.pool) {
      if (!p.active) continue;
      const v = toV3(p.body.velocity);
      const speed = v.length();
      if (speed < 0.01) continue;
      const from = toV3(p.body.position);
      const to = from.clone().addScaledVector(v, dt * 2);
      const hit = this.engine.physics.raycast(from, to, p.body.collisionFilterMask, p.body);
      if (hit && hit.distance <= speed * dt * 2 + 0.2) {
        this.onHit(p, hit.body, hit.point);
        this.engine.particles.sparks(hit.point, p.friendly ? '#8df2ff' : '#ff9a5c', 8);
        this.kill(p);
      }
    }
  }

  kill(p: Projectile) {
    p.active = false;
    p.mesh.visible = false;
    p.body.position.set(0, -500, 0);
    p.body.velocity.setZero();
  }

  activeCount() { return this.pool.reduce((n, p) => n + (p.active ? 1 : 0), 0); }
}
