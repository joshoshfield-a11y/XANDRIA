/**
 * Breakables (physics wave, item 3): predefined destruction states
 * intact → damaged → collapsed + deterministic debris fragments.
 *
 * Follows the existing debris-field pattern (particle bursts + loot spill on
 * break, see ItemWorld.damageChest): at 'damaged' we emit crack FX; at
 * 'collapsed' we spawn deterministic fragment bodies (seeded scatter) that
 * settle, sleep, and are released after `debrisLife` seconds.
 *
 * Chests wire in through `wireChest(itemWorld)`: it sets ItemWorld's additive
 * `onChestDamaged` hook — damageChest itself keeps its existing behavior, we
 * only layer state transitions + FX on top.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { GROUP } from '../core/Physics';
import type { Chest, ItemWorld } from '../game/items/ItemWorld';
import { Rng } from '../core/Rng';

export type BreakableState = 'intact' | 'damaged' | 'collapsed';

export interface BreakableDef {
  /** fragment bodies spawned on collapse */
  fragments: number;
  /** fragment box size range [min, max] */
  fragmentSize: [number, number];
  /** particle colors for damage / collapse bursts */
  colors: [string, string];
  /** seconds before settled fragments are released (default 8) */
  debrisLife?: number;
}

export const DEFAULT_BREAKABLE_DEF: BreakableDef = {
  fragments: 10,
  fragmentSize: [0.12, 0.3],
  colors: ['#9a7b4f', '#4a3520'],
  debrisLife: 8,
};

export interface Breakable {
  id: number;
  state: BreakableState;
  def: BreakableDef;
  center: THREE.Vector3;
  /** fragment bodies (live until debrisLife expires) */
  fragBodies: CANNON.Body[];
  /** fragment meshes, parallel to fragBodies */
  fragMeshes: THREE.Mesh[];
  /** age of the collapse, for debris cleanup */
  age: number;
}

export class Breakables {
  private list: Breakable[] = [];
  private nextId = 1;
  private rng: Rng;
  private fragMat: THREE.Material;
  /** shared unit-box template: per-fragment size rides on mesh.scale */
  private unitBox = new THREE.BoxGeometry(1, 1, 1);

  constructor(private engine: Engine) {
    // forked from the run rng: deterministic scatter, independent of other draws
    this.rng = engine.rng.fork(0x8ea1c);
    this.fragMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05 });
  }

  /** Standalone breakable at `center` (props, barrels, crates). */
  create(center: THREE.Vector3, def: Partial<BreakableDef> = {}): Breakable {
    const b: Breakable = {
      id: this.nextId++,
      state: 'intact',
      def: { ...DEFAULT_BREAKABLE_DEF, ...def },
      center: center.clone(),
      fragBodies: [],
      fragMeshes: [],
      age: 0,
    };
    this.list.push(b);
    return b;
  }

  /**
   * Damage a breakable by n. Returns the new state. Deterministic: fragment
   * velocities come from the forked rng, so the same seed → same scatter.
   */
  damage(b: Breakable, n: number): BreakableState {
    if (b.state === 'collapsed') return b.state;
    // transition: any hit cracks it (damaged); a second hit collapses it.
    // n is kept for API symmetry with damageChest — bigger hits skip straight
    // to collapsed when they would "overkill" (n >= 99 is the smash-all convention).
    if (b.state === 'intact' && n < 99) {
      b.state = 'damaged';
      this.engine.particles.burst(b.center, {
        count: 10, color: b.def.colors[0], color2: b.def.colors[1],
        speed: 2.6, life: 0.6, size: 1.7, gravity: 4, up: 2, blending: 'normal',
      });
      return b.state;
    }
    b.state = 'collapsed';
    this.collapse(b);
    return b.state;
  }

  private collapse(b: Breakable) {
    const { engine } = this;
    engine.particles.burst(b.center, {
      count: 34, color: b.def.colors[0], color2: b.def.colors[1],
      speed: 5, life: 1.1, size: 2.3, gravity: 4, up: 3.5, blending: 'normal', grow: 1.25,
    });
    for (let i = 0; i < b.def.fragments; i++) {
      const s = this.rng.range(b.def.fragmentSize[0], b.def.fragmentSize[1]);
      const mesh = new THREE.Mesh(this.unitBox, this.fragMat);
      mesh.scale.setScalar(s);
      mesh.castShadow = true;
      const px = b.center.x + this.rng.range(-0.4, 0.4);
      const py = b.center.y + this.rng.range(0, 0.6);
      const pz = b.center.z + this.rng.range(-0.4, 0.4);
      mesh.position.set(px, py, pz);
      engine.scene.add(mesh);
      const body = engine.physics.box(
        new THREE.Vector3(s, s, s), new THREE.Vector3(px, py, pz),
        { mass: 0.4, group: GROUP.PICKUP, mask: GROUP.WORLD | GROUP.PLAYER | GROUP.PICKUP },
      );
      body.allowSleep = true;
      body.sleepSpeedLimit = 0.4;
      body.sleepTimeLimit = 0.4;
      body.velocity.set(this.rng.range(-3.5, 3.5), this.rng.range(2, 6), this.rng.range(-3.5, 3.5));
      body.angularVelocity.set(this.rng.range(-6, 6), this.rng.range(-6, 6), this.rng.range(-6, 6));
      b.fragBodies.push(body);
      b.fragMeshes.push(mesh);
    }
  }

  /**
   * Wire into ItemWorld's chest path: sets the additive onChestDamaged hook.
   * Chest hp drives the state — full hp = intact, partial = damaged (crack
   * FX), 0 = collapsed (the existing damageChest smash already runs; we add
   * fragment bodies + the collapse burst on top).
   */
  wireChest(itemWorld: ItemWorld, maxHp = 3, def: Partial<BreakableDef> = {}): void {
    const fullDef = { ...DEFAULT_BREAKABLE_DEF, ...def };
    itemWorld.onChestDamaged = (chest: Chest, hpBefore: number) => {
      if (chest.hp >= maxHp || chest.hp >= hpBefore) return; // no real damage
      if (chest.hp > 0) {
        this.engine.particles.burst(chest.center, {
          count: 8, color: fullDef.colors[0], color2: fullDef.colors[1],
          speed: 2.2, life: 0.5, size: 1.5, gravity: 4, up: 2, blending: 'normal',
        });
      } else {
        // collapsed: fragment bodies on top of the existing smash FX
        const b = this.create(chest.center, fullDef);
        b.state = 'collapsed';
        this.collapse(b);
      }
    };
  }

  /** per-frame: sync fragment meshes, release settled debris after debrisLife. */
  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      if (b.state !== 'collapsed') continue;
      b.age += dt;
      const phys = this.engine.physics;
      for (let f = 0; f < b.fragBodies.length; f++) {
        phys.syncMeshInterpolated(b.fragMeshes[f], b.fragBodies[f]);
      }
      const life = b.def.debrisLife ?? DEFAULT_BREAKABLE_DEF.debrisLife!;
      if (b.age > life) {
        for (const body of b.fragBodies) phys.remove(body);
        for (const m of b.fragMeshes) { this.engine.scene.remove(m); }
        b.fragBodies.length = 0;
        b.fragMeshes.length = 0;
        this.list.splice(i, 1);
      }
    }
  }

  get live(): readonly Breakable[] { return this.list; }

  dispose() {
    for (const b of this.list) {
      for (const body of b.fragBodies) this.engine.physics.remove(body);
      for (const m of b.fragMeshes) this.engine.scene.remove(m);
      b.fragBodies.length = 0;
      b.fragMeshes.length = 0;
    }
    this.list.length = 0;
    this.unitBox.dispose();
    this.fragMat.dispose();
  }
}
