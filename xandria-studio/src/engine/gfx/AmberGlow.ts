/**
 * AmberGlow — the XANDRIA environment signature motif: AMBER GLOWING ACCENTS.
 *
 * Lamp posts (blocky post + glowing amber orb in a cage), ground lanterns,
 * and glowing doorway/window insets for structures. Everything glows via the
 * shared emissive pattern (mats.glow / flat with emissive) so it picks up the
 * bloom pass; REAL point lights are opt-in and strictly budgeted (see
 * MAX_REAL_LIGHTS) because the forward renderer pays per light per fragment.
 *
 * Deterministic: every builder consumes the passed Rng. Never throws on bad
 * input — degenerate opts degrade to an empty group.
 */
import * as THREE from 'three';
import type { Rng } from '../core/Rng';
import type { MaterialLibrary } from './Materials';

/** Signature amber. Doorway/window insets use the hotter variant. */
export const AMBER = '#ffb545';
export const AMBER_HOT = '#ffd27a';

/**
 * Forward-renderer light budget for amber accents. Emissive meshes are free;
 * real PointLights are not. Default placement uses ZERO real lights — the
 * emissive + bloom carries the look. Blueprints may pass realLights: 1..2 for
 * a hero landmark; anything above MAX_REAL_LIGHTS is clamped.
 */
export const MAX_REAL_LIGHTS = 2;

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, g: THREE.Group): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** Shared amber glow material (cached in the library — never dispose). */
export function amberGlowMaterial(mats: MaterialLibrary, intensity = 2.2): THREE.MeshStandardMaterial {
  return mats.glow(AMBER, intensity);
}

/**
 * Blocky lamp post: dark post + cap, amber orb glowing inside a 4-bar cage.
 * Reference look: the round glowing lamps scattered through the block-style vista.
 */
export function makeLampPost(rng: Rng, mats: MaterialLibrary, opts: { height?: number; realLight?: boolean } = {}): THREE.Group {
  const g = new THREE.Group();
  const h = Math.max(1.5, opts.height ?? rng.range(2.6, 3.4));
  const dark = mats.standard('metal', '#3a3f47', { roughness: 0.6, metalness: 0.5 });
  const post = mesh(new THREE.BoxGeometry(0.28, h, 0.28), dark, g);
  post.position.y = h / 2;
  const foot = mesh(new THREE.BoxGeometry(0.7, 0.35, 0.7), dark, g);
  foot.position.y = 0.17;
  // orb cage: glowing amber core + 4 thin bars + top cap
  const orbY = h + 0.35;
  const orb = mesh(new THREE.SphereGeometry(0.34, 12, 10), amberGlowMaterial(mats, 2.6), g);
  orb.castShadow = false;
  orb.position.y = orbY;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const bar = mesh(new THREE.BoxGeometry(0.08, 0.95, 0.08), dark, g);
    bar.position.set(Math.cos(a) * 0.42, orbY, Math.sin(a) * 0.42);
  }
  const cap = mesh(new THREE.BoxGeometry(0.75, 0.16, 0.75), dark, g);
  cap.position.y = orbY + 0.55;
  if (opts.realLight) {
    const l = new THREE.PointLight(AMBER, 14, 14, 1.8);
    l.position.y = orbY;
    g.add(l);
  }
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/**
 * Ground lantern: low blocky base with a glowing amber cube inset.
 * Cheap enough to scatter in the dozens — emissive only, never a real light.
 */
export function makeGroundLantern(rng: Rng, mats: MaterialLibrary): THREE.Group {
  const g = new THREE.Group();
  const stone = mats.standard('rock', '#6f6a60', { roughness: 1 });
  const s = rng.range(0.5, 0.75);
  const base = mesh(new THREE.BoxGeometry(s, s * 0.7, s), stone, g);
  base.position.y = s * 0.35;
  const core = mesh(new THREE.BoxGeometry(s * 0.55, s * 0.5, s * 0.55), amberGlowMaterial(mats, 2.4), g);
  core.castShadow = false;
  core.position.y = s * 0.95;
  const lid = mesh(new THREE.BoxGeometry(s * 0.8, s * 0.18, s * 0.8), stone, g);
  lid.position.y = s * 1.28;
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/**
 * Glowing doorway / window inset: a thin emissive slab sized to (w × h).
 * Mount it slightly proud of a wall face; the hot-amber gradient reads as a
 * lit interior. Emissive only — no real light.
 */
export function makeDoorwayGlow(mats: MaterialLibrary, w: number, h: number, hot = false): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.1, w), Math.max(0.1, h), 0.12),
    mats.glow(hot ? AMBER_HOT : AMBER, 2.8),
  );
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

/** Window inset: same as a doorway, square and a touch dimmer. */
export function makeWindowGlow(mats: MaterialLibrary, s: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.1, s), Math.max(0.1, s), 0.1),
    mats.glow(AMBER, 2.0),
  );
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

/**
 * Rune strip: a low amber emissive slab with dark end caps, laid on the
 * ground around landmarks. Standalone (mesh) variant — the placement pass
 * batches these through `Instancer` instead (one draw call for every strip).
 */
export function makeRuneStrip(mats: MaterialLibrary, w = 1.5, h = 0.28): THREE.Group {
  const g = new THREE.Group();
  const dark = mats.standard('metal', '#3a3f47', { roughness: 0.6, metalness: 0.5 });
  const slab = mesh(new THREE.BoxGeometry(Math.max(0.2, w), Math.max(0.1, h), Math.max(0.2, w * 0.38)), amberGlowMaterial(mats, 2.6), g);
  slab.castShadow = false;
  for (const s of [-1, 1]) {
    const cap = mesh(new THREE.BoxGeometry(0.16, h * 1.5, w * 0.44), dark, g);
    cap.position.x = s * (w / 2 + 0.08);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Instancer — batch repeated accent geometry into shared InstancedMeshes.
//
// Buckets are keyed by (geometry kind, material identity, shadow flag), so
// every rune strip / arch segment / bridge plank in a placement call lands
// in a handful of draw calls instead of hundreds of meshes. Materials come
// from the MaterialLibrary cache (never disposed); the unit geometries are
// module-shared and never disposed either. Deterministic: instances bake in
// insertion order, so the same add() sequence → the same instance matrices.
// ---------------------------------------------------------------------------

/** Module-shared unit geometries for the instancer (never disposed). */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_SPHERE = new THREE.SphereGeometry(1, 10, 8);
const UNIT_OCTA = new THREE.OctahedronGeometry(1, 0);

type InstGeoKind = 'box' | 'sphere' | 'octa';

interface InstBucket {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  shadow: boolean;
  matrices: THREE.Matrix4[];
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scl = new THREE.Vector3();

export class Instancer {
  private buckets = new Map<string, InstBucket>();
  private perMaterial = new Map<THREE.Material, number>();

  private push(kind: InstGeoKind, mat: THREE.Material, shadow: boolean, m: THREE.Matrix4): void {
    const key = `${kind}:${shadow ? 1 : 0}:${(mat as THREE.Material).uuid}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        geo: kind === 'box' ? UNIT_BOX : kind === 'sphere' ? UNIT_SPHERE : UNIT_OCTA,
        mat, shadow, matrices: [],
      };
      this.buckets.set(key, b);
    }
    b.matrices.push(m);
    this.perMaterial.set(mat, (this.perMaterial.get(mat) ?? 0) + 1);
  }

  /** Axis-aligned-ish box (yaw only), centered at (x, y, z), scaled to (sx, sy, sz). */
  box(mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, shadow = true): void {
    _pos.set(x, y, z);
    _euler.set(0, ry, 0);
    _quat.setFromEuler(_euler);
    _scl.set(Math.max(1e-4, sx), Math.max(1e-4, sy), Math.max(1e-4, sz));
    this.push('box', mat, shadow, new THREE.Matrix4().compose(_pos, _quat, _scl));
  }

  /** Sphere of radius r centered at (x, y, z). Glow pieces default to no shadow. */
  sphere(mat: THREE.Material, x: number, y: number, z: number, r: number, shadow = false): void {
    _pos.set(x, y, z);
    _quat.identity();
    _scl.set(Math.max(1e-4, r), Math.max(1e-4, r), Math.max(1e-4, r));
    this.push('sphere', mat, shadow, new THREE.Matrix4().compose(_pos, _quat, _scl));
  }

  /**
   * Octahedron "crystal shard" centered at (x, y, z), scaled to (sx, sy, sz).
   * Matches the voxel-crystal language of the biome teal-crystal prop sets
   * (PropSets 'biome-tealcrystals' uses OctahedronGeometry). Glow pieces
   * default to no shadow.
   */
  octa(mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, shadow = false): void {
    _pos.set(x, y, z);
    _euler.set(0, ry, 0);
    _quat.setFromEuler(_euler);
    _scl.set(Math.max(1e-4, sx), Math.max(1e-4, sy), Math.max(1e-4, sz));
    this.push('octa', mat, shadow, new THREE.Matrix4().compose(_pos, _quat, _scl));
  }

  /** Instances registered under a material — used for amber-accent accounting. */
  countFor(mat: THREE.Material): number {
    return this.perMaterial.get(mat) ?? 0;
  }

  /** Total instances across all buckets. */
  get instanceCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) n += b.matrices.length;
    return n;
  }

  /**
   * Bake every bucket into an InstancedMesh under `parent` and return them.
   * The instancer is single-use: bake once, then drop it.
   */
  bake(parent: THREE.Group): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const b of this.buckets.values()) {
      const im = new THREE.InstancedMesh(b.geo, b.mat, b.matrices.length);
      for (let i = 0; i < b.matrices.length; i++) im.setMatrixAt(i, b.matrices[i]);
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = b.shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere(); // instances spread — default sphere would cull wrong
      parent.add(im);
      out.push(im);
    }
    return out;
  }
}

export interface AmberScatterOpts {
  mats: MaterialLibrary;
  /** lamp post count before the quality scaler (default 10) */
  lamps?: number;
  /** ground lantern count before the quality scaler (default 18) */
  lanterns?: number;
  /** render-quality tier — scales counts (high 1.0 / standard 0.6 / retro 0.35) */
  quality?: 'retro' | 'standard' | 'high';
  /** ground height sampler (default: y = 0) */
  groundY?: (x: number, z: number) => number;
  /** scatter square half-extent (default 60) */
  half?: number;
  /** exclusion zones */
  exclusion?: Array<{ x: number; z: number; r: number }>;
  /**
   * Real point lights to spend on the brightest lamp posts (default 0 —
   * emissive + bloom carries the look). Clamped to MAX_REAL_LIGHTS.
   */
  realLights?: number;
}

export interface AmberScatterResult {
  group: THREE.Group;
  lamps: number;
  lanterns: number;
  /** real point lights actually added (≤ MAX_REAL_LIGHTS) */
  realLights: number;
}

function qualityScale(q: 'retro' | 'standard' | 'high'): number {
  return q === 'high' ? 1 : q === 'standard' ? 0.6 : 0.35;
}

/**
 * Scatter amber accents across the ground. Deterministic from `rng`.
 * Real lights go to the first `realLights` lamp posts (clamped to the budget).
 *
 * Draw-call diet (graphics follow-up, worker D): every lamp post and lantern
 * is emitted as instances into ONE shared Instancer (4 buckets: dark boxes,
 * amber orbs, stone boxes, amber cores → 4 draw calls) instead of one Group
 * of ~8 meshes per lamp. The rng consumption sequence and world transforms
 * are identical to the old mesh path, so placement is pixel-identical.
 */
export function scatterAmberGlow(scene: THREE.Scene, rng: Rng, opts: AmberScatterOpts): AmberScatterResult {
  const group = new THREE.Group();
  const quality = opts.quality ?? 'standard';
  const half = Math.max(1, opts.half ?? 60);
  const groundY = opts.groundY ?? (() => 0);
  const excluded = (x: number, z: number, r: number) =>
    (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
  const qMul = qualityScale(quality);
  const lampCount = Math.max(0, Math.round((opts.lamps ?? 10) * qMul));
  const lanternCount = Math.max(0, Math.round((opts.lanterns ?? 18) * qMul));
  const realBudget = Math.max(0, Math.min(MAX_REAL_LIGHTS, Math.round(opts.realLights ?? 0)));

  let lamps = 0, lanterns = 0, realLights = 0;
  const inst = new Instancer();
  const tryPlace = (r: number): [number, number] | null => {
    for (let a = 0; a < 8; a++) {
      const x = rng.range(-half, half), z = rng.range(-half, half);
      if (!excluded(x, z, r)) return [x, z];
    }
    return null;
  };

  // Instanced emission mirrors makeLampPost / makeGroundLantern part for
  // part (same materials, same shadow flags, same rng sequence) — the only
  // difference is boxes/spheres land in shared InstancedMesh buckets.
  const dark = opts.mats.standard('metal', '#3a3f47', { roughness: 0.6, metalness: 0.5 });
  const stone = opts.mats.standard('rock', '#6f6a60', { roughness: 1 });
  const orbAmber = amberGlowMaterial(opts.mats, 2.6);
  const coreAmber = amberGlowMaterial(opts.mats, 2.4);
  const emitLamp = (x: number, gy: number, z: number): number => {
    // rng sequence identical to makeLampPost(rng, mats, { realLight });
    // returns the orb's world y (for the optional real point light)
    const h = Math.max(1.5, rng.range(2.6, 3.4));
    const ry = rng.range(0, Math.PI * 2);
    const orbY = h + 0.35;
    inst.box(dark, x, gy + h / 2, z, 0.28, h, 0.28, ry, true);       // post
    inst.box(dark, x, gy + 0.17, z, 0.7, 0.35, 0.7, ry, true);        // foot
    inst.sphere(orbAmber, x, gy + orbY, z, 0.34, false);              // orb
    for (let i = 0; i < 4; i++) {
      // cage bars: group-space angle a, world angle (a - ry) under yaw ry
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4 - ry;
      inst.box(dark, x + Math.cos(a) * 0.42, gy + orbY, z + Math.sin(a) * 0.42,
        0.08, 0.95, 0.08, ry, true);
    }
    inst.box(dark, x, gy + orbY + 0.55, z, 0.75, 0.16, 0.75, ry, true); // cap
    return gy + orbY;
  };
  const emitLantern = (x: number, gy: number, z: number): void => {
    // rng sequence identical to makeGroundLantern(rng, mats)
    const s = rng.range(0.5, 0.75);
    const ry = rng.range(0, Math.PI * 2);
    inst.box(stone, x, gy + s * 0.35, z, s, s * 0.7, s, ry, true);            // base
    inst.box(coreAmber, x, gy + s * 0.95, z, s * 0.55, s * 0.5, s * 0.55, ry, false); // core
    inst.box(stone, x, gy + s * 1.28, z, s * 0.8, s * 0.18, s * 0.8, ry, true); // lid
  };

  for (let i = 0; i < lampCount; i++) {
    const spot = tryPlace(0.6);
    if (!spot) continue;
    const wantLight = realLights < realBudget;
    const [x, z] = spot;
    const gy = groundY(x, z);
    const orbWorldY = emitLamp(x, gy, z);
    if (wantLight) {
      // real point lights stay individual meshes — rare (≤ MAX_REAL_LIGHTS)
      const l = new THREE.PointLight(AMBER, 14, 14, 1.8);
      l.position.set(x, orbWorldY, z);
      group.add(l);
      realLights++;
    }
    lamps++;
  }
  for (let i = 0; i < lanternCount; i++) {
    const spot = tryPlace(0.5);
    if (!spot) continue;
    const [x, z] = spot;
    emitLantern(x, groundY(x, z), z);
    lanterns++;
  }
  inst.bake(group);
  scene.add(group);
  return { group, lamps, lanterns, realLights };
}
