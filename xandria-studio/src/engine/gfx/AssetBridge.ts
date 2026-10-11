/**
 * AssetBridge — the legacy asset-bridge idea, reborn as an *opt-in online* feature.
 *
 * When `spec.custom.assets.enabled` is set, each pack URL (a .glb/.gltf) is fetched
 * with a hard timeout and cloned around the world as hero props. Everything is
 * additive: the procedural world is the floor, and any network failure, bad URL,
 * or offline session silently leaves the procedural fallback in place.
 *
 * Security/robustness notes:
 *  - https URLs only — the spec schema rejects anything else, including
 *    http://localhost (serve local dev packs over https instead)
 *  - per-pack timeout (default 15s), total pack count capped by schema validation
 *  - loaded graphs are sanitized: scale-capped, grounded on terrain, shadows on
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CANNON from 'cannon-es';
import type { GameSpec } from '@spec';
import type { Terrain } from '../world/Terrain';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { GROUP } from '../core/Physics';

export interface AssetBridgeResult {
  loaded: string[];   // pack names that loaded
  failed: string[];   // pack names that fell back to procedural-only
}

const MAX_INSTANCES_PER_PACK = 24;
const MAX_FOOTPRINT = 60; // meters — clamp absurdly large models

export class AssetBridge {
  private roots: THREE.Group[] = [];
  /**
   * Generation token for the restart/dispose race (R2-N3). load() captures
   * ++generation at entry; a fetch that resolves after the generation moved on
   * belongs to a dead run and must not touch scene/roots.
   */
  private generation = 0;

  constructor(
    private spec: GameSpec,
    private scene: THREE.Scene,
    private terrain: Terrain | undefined,
  ) {}

  get enabled(): boolean {
    return !!this.spec.custom?.assets?.enabled && Object.keys(this.spec.custom?.assets?.packs ?? {}).length > 0;
  }

  /** Load all packs, scatter instances, and report. Never throws. */
  async load(): Promise<AssetBridgeResult> {
    const result: AssetBridgeResult = { loaded: [], failed: [] };
    if (!this.enabled) return result;
    const gen = ++this.generation;
    const packs = this.spec.custom!.assets!.packs ?? {};
    const loader = new GLTFLoader();
    const rng = new Rng(this.spec.meta.seed ^ 0xb21d6e);

    await Promise.all(Object.entries(packs).map(async ([name, url]) => {
      try {
        const gltf = await withTimeout(loader.loadAsync(url), 15000);
        // R2-N3: restart()/dispose() happened mid-fetch — this graph belongs
        // to a dead run. Drop it instead of injecting duplicate props into
        // the new run's scene/roots (or repopulating after Engine.dispose()).
        if (gen !== this.generation) return;
        const model = gltf.scene;
        // normalize footprint
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const foot = Math.max(size.x, size.z);
        if (foot > MAX_FOOTPRINT) model.scale.multiplyScalar(MAX_FOOTPRINT / foot);
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        // scatter a handful of instances as hero props
        const n = Math.min(MAX_INSTANCES_PER_PACK, Math.max(3, Math.round((this.spec.world.terrain.size / 100) * 2)));
        const half = this.spec.world.terrain.size / 2 - 20;
        for (let i = 0; i < n; i++) {
          const inst = model.clone(true);
          const x = rng.range(-half, half), z = rng.range(-half, half);
          const y = this.terrain ? this.terrain.heightAt(x, z) : 0;
          if (this.spec.world.terrain.water && y < this.spec.world.terrain.waterLevel + 0.3) continue;
          inst.position.set(x, y, z);
          inst.rotation.y = rng.range(0, Math.PI * 2);
          const s = rng.range(0.8, 1.6);
          inst.scale.multiplyScalar(s);
          this.scene.add(inst);
          this.roots.push(inst);
        }
        result.loaded.push(name);
      } catch (err) {
        console.warn(`[AssetBridge] pack "${name}" failed (${url}):`, err);
        result.failed.push(name);
      }
    }));
    return result;
  }

  dispose() {
    // R2-N3: invalidate in-flight loads FIRST — a fetch that resolves after
    // this point must not repopulate roots/scene (restart race, or a late
    // load landing after Engine.dispose()).
    this.generation++;
    for (const r of this.roots) {
      this.scene.remove(r);
      r.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    }
    this.roots = [];
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

interface DebrisItem {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  homePos: THREE.Vector3;
  homeQuat: THREE.Quaternion;
  /** sim time of the last hit; -1 = resting at home */
  hitAt: number;
}

/**
 * DebrisField — interactive wreck shards for racing (polish wave #3).
 *
 * A small set of light dynamic cannon-es bodies placed trackside. When the car
 * hits one it wakes, takes an impulse from the car's velocity, and tumbles —
 * purely cosmetic. Coordination with the racing-respawn bugfix work:
 *  - every shard self-cleans: 7 s after a hit it is restored to its seeded
 *    home transform and put back to sleep, so nothing can ever become a
 *    permanent track trap;
 *  - they never touch respawn validation (no colliders are registered, the
 *    set is bounded, and home positions are off the ribbon);
 *  - bodies start asleep and sleep on, so idle cost is ~zero.
 */
export class DebrisField {
  private items: DebrisItem[] = [];
  private time = 0;
  private rng: Rng;

  constructor(
    private engine: Engine,
    track: { curve: THREE.Curve<THREE.Vector3>; width: number },
    terrain: Terrain | undefined,
    opts: { count?: number } = {},
  ) {
    this.rng = new Rng(engine.spec.meta.seed ^ 0xde8);
    const quality = engine.effectiveQuality();
    const count = opts.count ?? (quality === 'high' ? 12 : quality === 'standard' ? 8 : 5);
    const mat = engine.mats.standard('metal', '#4a4a52', { roughness: 0.7, metalness: 0.5 });
    const geo = new THREE.BoxGeometry(1.8, 0.5, 1.1);
    const tan = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const p = track.curve.getPointAt(t);
      track.curve.getTangentAt(t, tan);
      const side = i % 2 === 0 ? 1 : -1;
      const off = track.width * this.rng.range(0.7, 1.05) * side;
      const x = p.x - tan.z * off, z = p.z + tan.x * off;
      const y = terrain ? terrain.heightAt(x, z) : p.y;
      const s = this.rng.range(0.7, 1.3);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.scale.setScalar(s);
      const homePos = new THREE.Vector3(x, y + 0.25 * s, z);
      const homeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        this.rng.range(-0.3, 0.3), this.rng.range(0, Math.PI * 2), this.rng.range(-0.3, 0.3)));
      mesh.position.copy(homePos);
      mesh.quaternion.copy(homeQuat);
      engine.scene.add(mesh);
      const body = new CANNON.Body({
        mass: 6,
        shape: new CANNON.Box(new CANNON.Vec3(0.9 * s, 0.25 * s, 0.55 * s)),
        position: new CANNON.Vec3(homePos.x, homePos.y, homePos.z),
        quaternion: new CANNON.Quaternion(homeQuat.x, homeQuat.y, homeQuat.z, homeQuat.w),
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: -1,
        allowSleep: true,
        sleepSpeedLimit: 0.4,
        sleepTimeLimit: 0.6,
      });
      engine.physics.world.addBody(body);
      body.sleep();
      const item: DebrisItem = { mesh, body, homePos, homeQuat, hitAt: -1 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body.addEventListener('collide', (e: any) => this.onCollide(item, e));
      this.items.push(item);
    }
  }

  private onCollide(item: DebrisItem, e: { body?: CANNON.Body; target?: CANNON.Body; contact?: CANNON.ContactEquation }) {
    const other = e.body === item.body ? e.target : e.body;
    if (!other || other.collisionFilterGroup !== GROUP.VEHICLE) return;
    // 0.5 s per-shard cooldown; gentle taps (< 3 m/s) don't scatter anything
    if (this.time - item.hitAt < 0.5) return;
    const vx = other.velocity.x, vz = other.velocity.z;
    const sp = Math.hypot(vx, vz);
    if (sp < 3) return;
    item.hitAt = this.time;
    const body = item.body;
    body.wakeUp();
    // shard picks up ~55% of the car's horizontal speed plus an upward pop
    const kick = sp * 0.55 * body.mass;
    const imp = new CANNON.Vec3((vx / sp) * kick, 2.2 * body.mass, (vz / sp) * kick);
    // apply at the contact point so it tumbles instead of just sliding
    const c = e.contact;
    const wp = new CANNON.Vec3();
    if (c && c.bi) c.bi.position.vadd(c.ri, wp);
    else body.position.vadd(wp, wp); // vadd with zero offset = copy
    const rel = new CANNON.Vec3(wp.x - body.position.x, wp.y - body.position.y, wp.z - body.position.z);
    body.applyImpulse(imp, rel);
    body.angularVelocity.set(this.rng.range(-4, 4), this.rng.range(-4, 4), this.rng.range(-4, 4));
    if (sp > 5) {
      this.engine.particles.dust(
        new THREE.Vector3(body.position.x, body.position.y, body.position.z), 8);
    }
  }

  private resetItem(item: DebrisItem) {
    const b = item.body;
    b.position.set(item.homePos.x, item.homePos.y, item.homePos.z);
    b.quaternion.set(item.homeQuat.x, item.homeQuat.y, item.homeQuat.z, item.homeQuat.w);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.sleep();
    item.hitAt = -1;
    item.mesh.position.copy(item.homePos);
    item.mesh.quaternion.copy(item.homeQuat);
  }

  /** Self-clean: 7 s after a hit each shard returns home and sleeps. */
  update(dt: number) {
    this.time += dt;
    for (const item of this.items) {
      if (item.hitAt < 0) continue;
      const b = item.body;
      const dx = b.position.x - item.homePos.x, dz = b.position.z - item.homePos.z;
      if (this.time - item.hitAt > 7 || dx * dx + dz * dz > 2500) this.resetItem(item);
      else {
        item.mesh.position.set(b.position.x, b.position.y, b.position.z);
        item.mesh.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      }
    }
  }

  dispose() {
    for (const item of this.items) {
      this.engine.physics.world.removeBody(item.body);
      this.engine.scene.remove(item.mesh);
    }
    this.items.length = 0;
  }
}
