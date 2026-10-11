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
  const tryPlace = (r: number): [number, number] | null => {
    for (let a = 0; a < 8; a++) {
      const x = rng.range(-half, half), z = rng.range(-half, half);
      if (!excluded(x, z, r)) return [x, z];
    }
    return null;
  };

  for (let i = 0; i < lampCount; i++) {
    const spot = tryPlace(0.6);
    if (!spot) continue;
    const wantLight = realLights < realBudget;
    const lamp = makeLampPost(rng, opts.mats, { realLight: wantLight });
    if (wantLight) realLights++;
    const [x, z] = spot;
    lamp.position.set(x, groundY(x, z), z);
    group.add(lamp);
    lamps++;
  }
  for (let i = 0; i < lanternCount; i++) {
    const spot = tryPlace(0.5);
    if (!spot) continue;
    const lan = makeGroundLantern(rng, opts.mats);
    const [x, z] = spot;
    lan.position.set(x, groundY(x, z), z);
    group.add(lan);
    lanterns++;
  }
  scene.add(group);
  return { group, lamps, lanterns, realLights };
}
