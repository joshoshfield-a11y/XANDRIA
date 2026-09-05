/**
 * Vegetation — seeded, species-driven flora with LOD bucketing and GPU wind sway.
 * Deterministic successor of the legacy OP-08 BLOOM vegetation system: same ideas
 * (species, 3 LOD tiers, wind phase), rebuilt on the engine's Rng + Terrain so
 * placement is reproducible and integrated with exclusion zones and water.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';
import type { MaterialLibrary } from '../gfx/Materials';
import { GROUP, type Physics } from '../core/Physics';

type SpeciesId = 'pine' | 'oak' | 'palm' | 'cactus' | 'deadtree' | 'mushroom' | 'crystalflora';

interface SpeciesDef {
  id: SpeciesId;
  trunkH: number;          // nominal trunk height (m)
  collideR: number;
  buildTrunk: (lod: 0 | 1 | 2) => THREE.BufferGeometry;
  buildFoliage: (lod: 0 | 1 | 2) => THREE.BufferGeometry | null;
  foliageMat: (mats: MaterialLibrary, spec: GameSpec) => THREE.Material;
  minS: number; maxS: number;
}

const cyl = (r1: number, r2: number, h: number, seg: number, y: number) => {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  g.translate(0, y + h / 2, 0);
  return g;
};
const cone = (r: number, h: number, seg: number, y: number) => {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, y + h / 2, 0);
  return g;
};
const ball = (r: number, y: number, x = 0, z = 0, sy = 1) => {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return g;
};
const shard = (r: number, h: number, x: number, z: number, tilt: number, rot: number) => {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(r * 0.6, h, r * 0.6);
  g.rotateZ(tilt); g.rotateY(rot);
  g.translate(x, h * 0.55, z);
  return g;
};
const branch = (len: number, x: number, y: number, z: number, rz: number, ry: number) => {
  const g = new THREE.BoxGeometry(0.12, len, 0.12);
  g.translate(0, len / 2, 0);
  g.rotateZ(rz); g.rotateY(ry);
  g.translate(x, y, z);
  return g;
};

function pineFoliage(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const layers = lod === 0 ? [[1.7, 2.6, 2.2], [1.3, 2.2, 4.0], [0.85, 1.8, 5.6]]
    : lod === 1 ? [[1.6, 3.0, 2.4], [1.0, 2.4, 4.6]]
    : [[1.5, 4.6, 2.2]];
  return mergeGeometries(layers.map(([r, h, y]) => cone(r, h, lod === 0 ? 7 : 5, y)));
}
function oakFoliage(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const clusters = lod === 0
    ? [ball(1.5, 4.6), ball(1.1, 5.4, 1.1, 0.4), ball(1.1, 5.4, -1.0, -0.5), ball(0.9, 6.1, 0.2, -0.2)]
    : lod === 1 ? [ball(1.7, 4.8), ball(1.2, 5.8, 0.4, 0.2)]
    : [ball(2.0, 5.0)];
  return mergeGeometries(clusters);
}
function palmFoliage(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const fronds = lod === 0 ? 6 : lod === 1 ? 4 : 0;
  if (!fronds) return cone(1.4, 2.2, 5, 4.6);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < fronds; i++) {
    const g = new THREE.BoxGeometry(0.28, 0.06, 2.2);
    g.translate(0, 0, 1.0);
    g.rotateX(0.5);
    g.rotateY((i / fronds) * Math.PI * 2);
    g.translate(0, 5.2, 0);
    parts.push(g);
  }
  return mergeGeometries(parts);
}
function cactusArms(lod: 0 | 1 | 2): THREE.BufferGeometry | null {
  if (lod === 2) return null;
  const parts = [branch(1.2, 0.55, 1.6, 0, -0.9, 0), branch(1.0, -0.55, 2.2, 0, 0.9, 0)];
  return mergeGeometries(parts);
}
function deadBranches(lod: 0 | 1 | 2): THREE.BufferGeometry | null {
  if (lod === 2) return null;
  const parts = lod === 0
    ? [branch(1.6, 0.1, 2.6, 0, -0.8, 0.3), branch(1.3, -0.1, 3.2, 0.1, 0.7, 2.1), branch(1.1, 0, 3.8, -0.1, -0.5, 4.0), branch(0.9, 0.05, 4.4, 0.05, 0.6, 5.2)]
    : [branch(1.4, 0.1, 2.8, 0, -0.8, 0.3), branch(1.1, -0.1, 3.4, 0.1, 0.7, 2.1)];
  return mergeGeometries(parts);
}
function mushroomCap(lod: 0 | 1 | 2): THREE.BufferGeometry {
  return ball(lod === 0 ? 1.3 : 1.2, 2.6, 0, 0, 0.55);
}
function crystalCluster(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const shards = lod === 0
    ? [shard(0.7, 2.6, 0, 0, 0.12, 0), shard(0.5, 1.8, 0.5, 0.2, -0.4, 1.2), shard(0.45, 1.5, -0.4, 0.3, 0.35, 2.6), shard(0.35, 1.1, 0.1, -0.5, 0.5, 4.2)]
    : lod === 1 ? [shard(0.7, 2.4, 0, 0, 0.12, 0), shard(0.45, 1.5, 0.4, 0.2, -0.4, 1.2)]
    : [shard(0.8, 2.4, 0, 0, 0, 0)];
  return mergeGeometries(shards);
}

const SPECIES: Record<SpeciesId, SpeciesDef> = {
  pine: {
    id: 'pine', trunkH: 2.2, collideR: 0.55, minS: 0.8, maxS: 1.9,
    buildTrunk: (lod) => cyl(0.22, 0.38, 2.4, lod === 0 ? 6 : 5, 0),
    buildFoliage: pineFoliage,
    foliageMat: (mats, spec) => mats.flat(spec.theme.environment === 'arctic' ? '#dfe9f0' : spec.theme.palette.primary, { roughness: 0.9 }),
  },
  oak: {
    id: 'oak', trunkH: 2.6, collideR: 0.6, minS: 0.8, maxS: 1.7,
    buildTrunk: (lod) => cyl(0.26, 0.42, 3.4, lod === 0 ? 6 : 5, 0),
    buildFoliage: oakFoliage,
    foliageMat: (mats, spec) => mats.flat(spec.theme.palette.primary, { roughness: 0.9 }),
  },
  palm: {
    id: 'palm', trunkH: 4.4, collideR: 0.45, minS: 0.8, maxS: 1.5,
    buildTrunk: (lod) => { const g = cyl(0.16, 0.26, 5.2, lod === 0 ? 6 : 5, 0); g.rotateZ(0.08); return g; },
    buildFoliage: palmFoliage,
    foliageMat: (mats, spec) => mats.flat('#3f8f4f', { roughness: 0.85 }),
  },
  cactus: {
    id: 'cactus', trunkH: 2.6, collideR: 0.5, minS: 0.7, maxS: 1.6,
    buildTrunk: (lod) => cyl(0.3, 0.34, 3.2, lod === 0 ? 7 : 6, 0),
    buildFoliage: cactusArms,
    foliageMat: (mats) => mats.flat('#4d7a3d', { roughness: 0.85 }),
  },
  deadtree: {
    id: 'deadtree', trunkH: 3.4, collideR: 0.5, minS: 0.8, maxS: 1.8,
    buildTrunk: (lod) => cyl(0.2, 0.4, 4.6, lod === 0 ? 6 : 5, 0),
    buildFoliage: deadBranches,
    foliageMat: (mats) => mats.flat('#4c4137', { roughness: 1 }),
  },
  mushroom: {
    id: 'mushroom', trunkH: 1.6, collideR: 0.5, minS: 0.6, maxS: 2.2,
    buildTrunk: (lod) => cyl(0.22, 0.34, 2.4, lod === 0 ? 7 : 5, 0),
    buildFoliage: mushroomCap,
    foliageMat: (mats, spec) => mats.flat(spec.theme.palette.accent, { roughness: 0.7, emissive: spec.theme.palette.accent, emissiveIntensity: 0.25 }),
  },
  crystalflora: {
    id: 'crystalflora', trunkH: 0.01, collideR: 0.6, minS: 0.7, maxS: 1.8,
    buildTrunk: () => new THREE.BoxGeometry(0.01, 0.01, 0.01),
    buildFoliage: crystalCluster,
    foliageMat: (mats, spec) => mats.glow(spec.theme.palette.accent, 1.3),
  },
};

/** environment → species mix */
export function speciesFor(env: string): SpeciesId[] {
  switch (env) {
    case 'forest': return ['pine', 'pine', 'oak'];
    case 'jungle': return ['palm', 'oak', 'palm'];
    case 'arctic': return ['pine'];
    case 'desert': return ['cactus', 'cactus', 'deadtree'];
    case 'volcanic': return ['deadtree', 'crystalflora'];
    case 'dreamscape': return ['mushroom', 'crystalflora', 'mushroom'];
    case 'wasteland': return ['deadtree', 'deadtree', 'cactus'];
    case 'ruins': return ['oak', 'deadtree'];
    case 'islands': return ['palm', 'palm', 'oak'];
    case 'space-station': return ['mushroom', 'crystalflora'];
    case 'city': case 'neon-city': return ['deadtree'];
    default: return ['pine', 'oak'];
  }
}

export interface VegetationOptions {
  exclusion?: Array<{ x: number; z: number; r: number }>;
  maxSlope?: number;
  colliders?: { x: number; z: number; r: number }[];  // shared with Scatter
  physics?: Physics;
  count: number;
}

interface VInstance { x: number; y: number; z: number; rot: number; scale: number; sp: SpeciesId }

const LOD_DIST = [55, 130]; // high < 55m, medium < 130m, else low

export class Vegetation {
  private tiers: { mesh: THREE.InstancedMesh; sp: SpeciesId; lod: 0 | 1 | 2; foliage: boolean }[] = [];
  private instances: VInstance[] = [];
  private time = 0;
  private rebucketTimer = 0;
  private windUniforms: { uTime: { value: number }; uWind: { value: number } } = { uTime: { value: 0 }, uWind: { value: 1 } };
  private windMats: THREE.Material[] = [];

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, scene: THREE.Scene, opts: VegetationOptions) {
    if (opts.count <= 0) return;
    const rng = new Rng(spec.meta.seed ^ 0xbe09);
    const species = speciesFor(spec.theme.environment).filter((s) => {
      // crystalflora doubles as crystal scatter; respect that toggle
      if (s === 'crystalflora') return spec.world.scatter.crystals;
      return true;
    });
    const excluded = (x: number, z: number, r = 0) =>
      (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
    const maxSlope = opts.maxSlope ?? 0.45;
    const half = terrain.size / 2 - 8;

    // placement
    for (let i = 0; i < opts.count; i++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = rng.range(-half, half), z = rng.range(-half, half);
        if (excluded(x, z, 0.8)) continue;
        if (terrain.slopeAt(x, z) > maxSlope) continue;
        const y = terrain.heightAt(x, z);
        if (spec.world.terrain.water && y < spec.world.terrain.waterLevel + 0.5) continue;
        const sp = rng.pick(species);
        const def = SPECIES[sp];
        const scale = rng.range(def.minS, def.maxS);
        this.instances.push({ x, y, z, rot: rng.range(0, Math.PI * 2), scale, sp });
        opts.colliders?.push({ x, z, r: def.collideR * scale });
        if (opts.physics && this.instances.length <= 80) {
          opts.physics.cylinder(0.4 * scale, 0.45 * scale, 2.4 * scale, [x, y + 1.2 * scale, z], { group: GROUP.WORLD });
        }
        break;
      }
    }

    // wind strength from weather
    const wind = spec.theme.weather === 'storm' ? 2.2 : spec.theme.weather === 'rain' ? 1.3 : spec.theme.weather === 'snow' ? 1.1 : 0.8;
    this.windUniforms.uWind.value = wind * 0.12;

    // build tiers: per species × lod × (trunk, foliage)
    const bySpecies = new Map<SpeciesId, number>();
    for (const inst of this.instances) bySpecies.set(inst.sp, (bySpecies.get(inst.sp) ?? 0) + 1);

    for (const [sp, count] of bySpecies) {
      const def = SPECIES[sp];
      const trunkMat = mats.standard('wood', sp === 'cactus' ? '#4d7a3d' : '#5a4230', { roughness: 0.95 });
      const folMat = def.foliageMat(mats, spec);
      if (sp !== 'crystalflora' && sp !== 'cactus') this.addWind(folMat);
      for (const lod of [0, 1, 2] as const) {
        if (def.trunkH > 0.05) {
          const tg = def.buildTrunk(lod);
          const tm = new THREE.InstancedMesh(tg, trunkMat, count);
          tm.castShadow = true; tm.receiveShadow = true;
          tm.frustumCulled = false;
          scene.add(tm);
          this.tiers.push({ mesh: tm, sp, lod, foliage: false });
        }
        const fg = def.buildFoliage(lod);
        if (fg) {
          const fm = new THREE.InstancedMesh(fg, folMat, count);
          fm.castShadow = true;
          fm.frustumCulled = false;
          scene.add(fm);
          this.tiers.push({ mesh: fm, sp, lod, foliage: true });
        }
      }
    }
    this.rebucket(new THREE.Vector3(0, 0, 0));
  }

  /** GPU wind sway: bend foliage by height, phase from instance position. */
  private addWind(mat: THREE.Material) {
    const u = this.windUniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uWind = u.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            vec2 iwp = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xz;
            float phase = iwp.x * 0.13 + iwp.y * 0.17;
            float sway = sin(uTime * 1.7 + phase + position.y * 0.35) * uWind * max(position.y, 0.0);
            transformed.x += sway;
            transformed.z += sway * 0.6;
          #endif
        `);
    };
    this.windMats.push(mat);
  }

  /** Reassign instances to LOD tiers by camera distance (throttled). */
  update(dt: number, cameraPos: THREE.Vector3) {
    this.time += dt;
    this.windUniforms.uTime.value = this.time;
    this.rebucketTimer -= dt;
    if (this.rebucketTimer <= 0) {
      this.rebucketTimer = 0.3;
      this.rebucket(cameraPos);
    }
  }

  private rebucket(cam: THREE.Vector3) {
    const counts = new Map<string, number>();
    const key = (t: { sp: SpeciesId; lod: number; foliage: boolean }) => `${t.sp}:${t.lod}:${t.foliage ? 1 : 0}`;
    const tierByKey = new Map<string, (typeof this.tiers)[number]>();
    for (const t of this.tiers) { tierByKey.set(key(t), t); counts.set(key(t), 0); }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (const inst of this.instances) {
      const dx = inst.x - cam.x, dz = inst.z - cam.z;
      const d2 = dx * dx + dz * dz;
      const lod: 0 | 1 | 2 = d2 < LOD_DIST[0] * LOD_DIST[0] ? 0 : d2 < LOD_DIST[1] * LOD_DIST[1] ? 1 : 2;
      q.setFromEuler(eul.set(0, inst.rot, 0));
      scl.setScalar(inst.scale);
      for (const foliage of [false, true]) {
        const t = tierByKey.get(`${inst.sp}:${lod}:${foliage ? 1 : 0}`);
        if (!t) continue;
        const k = key(t);
        const idx = counts.get(k)!;
        pos.set(inst.x, inst.y, inst.z);
        m4.compose(pos, q, scl);
        t.mesh.setMatrixAt(idx, m4);
        counts.set(k, idx + 1);
      }
    }
    for (const t of this.tiers) {
      t.mesh.count = counts.get(key(t)) ?? 0;
      t.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(scene: THREE.Scene) {
    for (const t of this.tiers) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      (t.mesh.material as THREE.Material).dispose();
      t.mesh.dispose();
    }
    this.tiers = [];
    this.instances = [];
  }
}
