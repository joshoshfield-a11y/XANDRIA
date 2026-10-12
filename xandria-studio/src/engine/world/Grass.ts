/**
 * Grass tufts — one InstancedMesh of crossed quads with GPU wind sway.
 * Seeded placement (slope/water/exclusion-aware like Vegetation), counts
 * scaled by quality tier, only in environments where grass fits.
 * Zero per-frame CPU: the only per-frame work is one uTime uniform update.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import { resolveBiomeDef } from './Biomes';
import type { Terrain } from './Terrain';

// environments where ground grass reads naturally (fraction of full density)
// Workstream C: superseded by the biome treatment's authored scatter.grass —
// kept as documentation of the old mapping (forest/jungle/dreamscape 1,
// islands 0.9, ruins 0.8, desert/wasteland 0.25, arctic 0.2, else 0).
const QUALITY_COUNT = { high: 4500, standard: 2200, retro: 800 } as const;

export interface GrassOptions {
  quality?: 'retro' | 'standard' | 'high';
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
}

export class Grass {
  private mesh: THREE.InstancedMesh | null = null;
  private uniforms = { uTime: { value: 0 }, uWind: { value: 0.1 } };
  private _count = 0;

  /** live tuft count (test hook + quality-scaler verification) */
  get count(): number { return this._count; }

  constructor(spec: GameSpec, terrain: Terrain, scene: THREE.Scene, opts: GrassOptions = {}) {
    // Workstream C: grass density comes from the resolved biome treatment
    // (volcanic/caves get none; forest/coastline/plains are lush).
    const density = resolveBiomeDef(spec).scatter.grass;
    if (density <= 0) return; // volcanic / caves: no grass
    const quality = opts.quality ?? 'retro';
    const rng = new Rng(spec.meta.seed ^ 0x6a55);
    const target = Math.round(QUALITY_COUNT[quality] * density);
    if (target <= 0) return;
    const maxSlope = opts.maxSlope ?? 0.45;
    const half = terrain.size / 2 - 8;
    const excluded = (x: number, z: number) =>
      (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);

    // crossed-quad tuft: two small planes, origin at ground (kept modest in
    // size so tufts read as grass, not blocks, at gameplay distances)
    const blade = (ry: number) => {
      const g = new THREE.PlaneGeometry(0.55, 0.45);
      g.translate(0, 0.22, 0);
      g.rotateY(ry);
      return g;
    };
    const geo = mergeGeometries([blade(0), blade(Math.PI / 2)]);

    // NOTE: instance colors ride the standard linear pipeline (unlike Terrain's
    // raw vertex colors), so no convertLinearToSRGB here — plain Color(hex) is
    // already in the working color space.
    const base = new THREE.Color(spec.theme.palette.primary);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    // GPU wind: bend by blade height, phase from instance world position
    const u = this.uniforms;
    mat.customProgramCacheKey = () => 'xandria-grass-v1';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uWind = u.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            vec2 iwp = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xz;
            float gphase = iwp.x * 0.35 + iwp.y * 0.41;
            float gsway = sin(uTime * 2.1 + gphase) * uWind * uv.y * uv.y;
            transformed.x += gsway;
            transformed.z += gsway * 0.55;
          #endif
        `);
    };
    // wind strength follows weather like the tree canopy does
    const w = spec.theme.weather;
    this.uniforms.uWind.value = (w === 'storm' ? 2.2 : w === 'rain' ? 1.3 : w === 'snow' ? 1.1 : 0.8) * 0.12;

    const inst = new THREE.InstancedMesh(geo, mat, target);
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let placed = 0;
    for (let i = 0; i < target && placed < target; i++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const x = rng.range(-half, half), z = rng.range(-half, half);
        if (excluded(x, z)) continue;
        if (terrain.slopeAt(x, z) > maxSlope) continue;
        const y = terrain.heightAt(x, z);
        if (spec.world.terrain.water && y < spec.world.terrain.waterLevel + 0.4) continue;
        const s = rng.range(0.7, 1.3);
        q.setFromEuler(eul.set(0, rng.range(0, Math.PI * 2), 0));
        pos.set(x, y - 0.02, z);
        scl.set(s, s * rng.range(0.8, 1.3), s);
        m4.compose(pos, q, scl);
        inst.setMatrixAt(placed, m4);
        // lift the tuft color slightly above the canopy base so blades catch
        // light instead of rendering as dark blocks
        col.copy(base).offsetHSL(rng.range(-0.02, 0.04), rng.range(0, 0.08), rng.range(0.03, 0.12));
        inst.setColorAt(placed, col);
        placed++;
        break;
      }
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
    this.mesh = inst;
    this._count = placed;
  }

  /** Only work: advance the wind clock. */
  update(dt: number) {
    if (!this.mesh) return;
    this.uniforms.uTime.value += dt;
  }

  dispose(scene: THREE.Scene) {
    if (!this.mesh) return;
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.mesh = null;
    this._count = 0;
  }
}
