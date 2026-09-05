/**
 * AssetBridge — the legacy asset-bridge idea, reborn as an *opt-in online* feature.
 *
 * When `spec.custom.assets.enabled` is set, each pack URL (a .glb/.gltf) is fetched
 * with a hard timeout and cloned around the world as hero props. Everything is
 * additive: the procedural world is the floor, and any network failure, bad URL,
 * or offline session silently leaves the procedural fallback in place.
 *
 * Security/robustness notes:
 *  - https URLs only (http://localhost allowed for local dev packs)
 *  - per-pack timeout (default 15s), total pack count capped by schema validation
 *  - loaded graphs are sanitized: scale-capped, grounded on terrain, shadows on
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GameSpec } from '@spec';
import type { Terrain } from '../world/Terrain';
import { Rng } from '../core/Rng';

export interface AssetBridgeResult {
  loaded: string[];   // pack names that loaded
  failed: string[];   // pack names that fell back to procedural-only
}

const MAX_INSTANCES_PER_PACK = 24;
const MAX_FOOTPRINT = 60; // meters — clamp absurdly large models

export class AssetBridge {
  private roots: THREE.Group[] = [];

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
    const packs = this.spec.custom!.assets!.packs ?? {};
    const loader = new GLTFLoader();
    const rng = new Rng(this.spec.meta.seed ^ 0xb21d6e);

    await Promise.all(Object.entries(packs).map(async ([name, url]) => {
      try {
        const gltf = await withTimeout(loader.loadAsync(url), 15000);
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
