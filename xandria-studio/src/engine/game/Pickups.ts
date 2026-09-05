/** Floating pickups: coins, health crosses, ammo cells, powerup stars. Magnet + collect. */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';

export type PickupKind = 'coin' | 'health' | 'ammo' | 'powerup';

export interface Pickup {
  kind: PickupKind;
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  taken: boolean;
  baseY: number;
  phase: number;
}

export class Pickups {
  list: Pickup[] = [];
  onCollect: (p: Pickup) => void = () => {};
  private t = 0;

  constructor(private engine: Engine) {}

  private makeMesh(kind: PickupKind): THREE.Object3D {
    const m = this.engine.mats;
    switch (kind) {
      case 'coin': {
        const g = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 16), m.glow('#ffd23f', 1.4));
        g.rotation.x = Math.PI / 2;
        const wrap = new THREE.Group();
        wrap.add(g);
        return wrap;
      }
      case 'health': {
        const mat = m.glow('#4dff6a', 1.2);
        const g = new THREE.Group();
        const a = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.24, 0.24), mat);
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.7, 0.24), mat);
        g.add(a, b);
        return g;
      }
      case 'ammo': {
        return new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.34), m.glow('#ff9a3c', 1.2));
      }
      case 'powerup': {
        const g = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), m.glow('#c97aff', 2.2));
        return g;
      }
    }
  }

  spawn(kind: PickupKind, pos: THREE.Vector3) {
    const mesh = this.makeMesh(kind);
    mesh.position.copy(pos);
    mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.engine.scene.add(mesh);
    this.list.push({ kind, mesh, pos: pos.clone(), taken: false, baseY: pos.y, phase: Math.random() * Math.PI * 2 });
  }

  /** Scatter N pickups of each kind over walkable terrain. */
  scatterTerrain(counts: Record<PickupKind, number>, y: (x: number, z: number) => number, half: number, seed: number, avoid?: { x: number; z: number; r: number }[]) {
    const rng = new Rng(seed ^ 0x91c9);
    const place = (kind: PickupKind, n: number) => {
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 10; tries++) {
          const x = rng.range(-half, half), z = rng.range(-half, half);
          if (avoid?.some((a) => (x - a.x) ** 2 + (z - a.z) ** 2 < a.r * a.r)) continue;
          this.spawn(kind, new THREE.Vector3(x, y(x, z) + 1.1, z));
          break;
        }
      }
    };
    (Object.keys(counts) as PickupKind[]).forEach((k) => place(k, counts[k]));
  }

  remaining(kind?: PickupKind) {
    return this.list.filter((p) => !p.taken && (!kind || p.kind === kind)).length;
  }

  update(dt: number, playerPos: THREE.Vector3, magnetR = 2.6, collectR = 1.1) {
    this.t += dt;
    for (const p of this.list) {
      if (p.taken) continue;
      // bob + spin
      p.mesh.position.y = p.baseY + Math.sin(this.t * 2.4 + p.phase) * 0.22;
      p.mesh.rotation.y = this.t * 2 + p.phase;
      const d = p.mesh.position.distanceTo(playerPos);
      if (d < magnetR) {
        p.mesh.position.lerp(playerPos.clone().add(new THREE.Vector3(0, 0.6, 0)), 1 - Math.pow(0.002, dt));
        p.baseY = p.mesh.position.y;
      }
      if (d < collectR) {
        p.taken = true;
        p.mesh.visible = false;
        this.engine.particles.magic(p.mesh.position, p.kind === 'coin' ? '#ffd23f' : p.kind === 'health' ? '#4dff6a' : p.kind === 'ammo' ? '#ff9a3c' : '#c97aff', 12);
        this.onCollect(p);
      }
    }
  }
}
