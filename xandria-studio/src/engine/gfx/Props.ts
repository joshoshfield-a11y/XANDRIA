/**
 * Procedural prop variety: crates, barrels, banners/flags, crystal clusters,
 * rubble piles, pillar variants, glowing runestones, vases.
 *
 * Each builder returns a small THREE.Group with castShadow enabled, and every
 * visible variation is driven by the passed Rng — no Math.random / Date.now
 * anywhere in this file, so the same seed always yields the same props.
 *
 * `scatterProps(scene, rng, opts)` places a quality-tier-aware set of props on
 * the ground and returns a PropField, which tracks fragile props
 * (crystal clusters, vases) so gameplay can call
 * `field.tryShatter(pos, radius, burstFn)` when a projectile passes near or a
 * melee swing lands. The burst callback is supplied by the caller (e.g.
 * `(p, kind) => engine.particles.burst(p, Props.shatterBurst(kind))`) — Props
 * never reaches for the engine itself, so it stays usable in tests and in
 * blueprints that don't own a particle system.
 */
import * as THREE from 'three';
import type { Rng } from '../core/Rng';
import type { MaterialLibrary } from './Materials';
import type { BurstOpts } from './Particles';
import { makeLampPost as amberLampPost, makeGroundLantern as amberLantern } from './AmberGlow';

export type PropKind = 'crate' | 'barrel' | 'banner' | 'crystal' | 'rubble' | 'pillar' | 'runestone' | 'vase'
  | 'blocktree' | 'lamppost' | 'lantern';
export type PropQuality = 'retro' | 'standard' | 'high';

export interface PropPalette {
  primary: string;
  secondary: string;
  accent: string;
  rock: string;
  ground: string;
}

/** Fragile kinds shatter on tryShatter; everything else is indestructible decor. */
export const FRAGILE_KINDS: ReadonlySet<PropKind> = new Set(['crystal', 'vase']);

const ALL_KINDS: PropKind[] = ['crate', 'barrel', 'banner', 'crystal', 'rubble', 'pillar', 'runestone', 'vase',
  'blocktree', 'lamppost', 'lantern'];

/** Quality scaler shared with Scatter's hero props (high 1.0 / standard 0.6 / retro 0.35). */
export function qualityScale(q: PropQuality): number {
  return q === 'high' ? 1 : q === 'standard' ? 0.6 : 0.35;
}

/** Cheap per-builder mesh helper: position + shadow flags, added to the group. */
function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, g: THREE.Group): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** Wood crate with darker edge battens. */
export function makeCrate(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const s = rng.range(0.8, 1.3);
  const wood = mats.standard('wood', pal.ground, { roughness: 0.9 });
  const dark = mats.standard('wood', pal.rock, { roughness: 0.9 });
  const box = mesh(new THREE.BoxGeometry(s, s, s), wood, g);
  box.position.y = s / 2;
  // edge battens on the visible faces
  const b = s * 0.09;
  for (const [w, h, d, x, y, z] of [
    [s, b, b, 0, s / 2 - b / 2, s / 2], [s, b, b, 0, -s / 2 + b / 2, s / 2],
    [b, s, b, s / 2 - b / 2, 0, s / 2], [b, s, b, -s / 2 + b / 2, 0, s / 2],
  ] as const) {
    const bat = mesh(new THREE.BoxGeometry(w, h, d), dark, g);
    bat.position.set(x, s / 2 + y, z);
  }
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** Banded barrel. */
export function makeBarrel(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const r = rng.range(0.45, 0.6), h = rng.range(1.0, 1.35);
  const body = mesh(new THREE.CylinderGeometry(r * 0.92, r, h, 10), mats.standard('wood', pal.ground, { roughness: 0.85 }), g);
  body.position.y = h / 2;
  const band = mats.standard('metal', pal.rock, { roughness: 0.5, metalness: 0.7 });
  for (const fy of [0.18, 0.82]) {
    const t = mesh(new THREE.TorusGeometry(r * (fy < 0.5 ? 1.0 : 0.94), 0.045, 6, 14), band, g);
    t.rotation.x = Math.PI / 2;
    t.position.y = h * fy;
  }
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** War banner: pole + crossbar + cloth flag (unique material per color, owned by the field). */
export function makeBanner(rng: Rng, mats: MaterialLibrary, pal: PropPalette, clothCache: Map<string, THREE.Material>): THREE.Group {
  const g = new THREE.Group();
  const h = rng.range(2.8, 3.6);
  const pole = mesh(new THREE.CylinderGeometry(0.06, 0.09, h, 6), mats.standard('wood', pal.rock, { roughness: 0.8 }), g);
  pole.position.y = h / 2;
  const bar = mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.3, 6), mats.standard('wood', pal.rock, { roughness: 0.8 }), g);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0.6, h - 0.15, 0);
  const color = rng.chance(0.6) ? pal.accent : pal.primary;
  let cloth = clothCache.get(color);
  if (!cloth) {
    cloth = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    clothCache.set(color, cloth);
  }
  const flag = mesh(new THREE.PlaneGeometry(1.15, 0.75, 4, 1), cloth, g);
  // seeded cloth ripple baked into the geometry
  const pos = flag.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin(x * 4 + rng.range(0, 6)) * 0.06 * (x + 0.575));
  }
  pos.needsUpdate = true;
  flag.position.set(0.6, h - 0.55, 0);
  flag.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** Fragile crystal cluster: 3–5 glowing octahedrons. */
export function makeCrystal(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const n = rng.int(3, 5);
  const mat = mats.glow(pal.accent, 1.6);
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.35, 0.9) * (i === 0 ? 1.4 : 1);
    const c = mesh(new THREE.OctahedronGeometry(s, 0), mat, g);
    c.position.set(rng.range(-0.5, 0.5), s * rng.range(0.5, 0.8), rng.range(-0.5, 0.5));
    c.scale.y = rng.range(1.2, 1.9);
    c.rotation.set(rng.range(-0.35, 0.35), rng.range(0, Math.PI * 2), rng.range(-0.35, 0.35));
  }
  return g;
}

/** Rubble pile: squashed dodecahedrons. */
export function makeRubble(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const n = rng.int(3, 6);
  const mat = mats.standard('rock', pal.rock, { roughness: 1 });
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.3, 0.9);
    const r = mesh(new THREE.DodecahedronGeometry(s, 0), mat, g);
    r.position.set(rng.range(-0.8, 0.8), s * 0.35, rng.range(-0.8, 0.8));
    r.scale.y = rng.range(0.45, 0.7);
    r.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
  }
  return g;
}

/** Pillar: intact (shaft + cap) or broken (stump + tilted shard). */
export function makePillar(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const mat = mats.standard('rock', pal.secondary, { roughness: 0.95 });
  const broken = rng.chance(0.45);
  if (!broken) {
    const h = rng.range(3, 4.5);
    const shaft = mesh(new THREE.CylinderGeometry(0.5, 0.62, h, 8), mat, g);
    shaft.position.y = h / 2;
    const cap = mesh(new THREE.BoxGeometry(1.5, 0.35, 1.5), mat, g);
    cap.position.y = h + 0.17;
    const base = mesh(new THREE.BoxGeometry(1.5, 0.35, 1.5), mat, g);
    base.position.y = 0.17;
  } else {
    const h = rng.range(1.0, 2.2);
    const stump = mesh(new THREE.CylinderGeometry(0.5, 0.65, h, 8), mat, g);
    stump.position.y = h / 2;
    stump.rotation.z = rng.range(-0.06, 0.06);
    const shard = mesh(new THREE.CylinderGeometry(0.42, 0.5, rng.range(0.8, 1.4), 8), mat, g);
    shard.position.set(rng.range(0.8, 1.4), 0.4, rng.range(-0.6, 0.6));
    shard.rotation.set(rng.range(0.8, 1.4), rng.range(0, 3), rng.range(0, 1));
  }
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** Glowing runestone slab with an emissive rune face. */
export function makeRunestone(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const h = rng.range(1.6, 2.4);
  const slab = mesh(new THREE.BoxGeometry(1.1, h, 0.45), mats.standard('rock', pal.rock, { roughness: 1 }), g);
  slab.position.y = h / 2;
  slab.rotation.z = rng.range(-0.08, 0.08);
  const rune = mesh(new THREE.PlaneGeometry(0.6, h * 0.55), mats.glow(pal.accent, 2.0), g);
  rune.position.set(0, h * 0.55, 0.24);
  rune.rotation.y = rng.range(-0.3, 0.3);
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** Fragile vase: lathe-turned pot. */
export function makeVase(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  const h = rng.range(0.7, 1.0);
  const profile: [number, number][] = [
    [0.01, 0], [0.32, 0.02], [0.42, 0.25], [0.34, 0.55], [0.2, 0.75], [0.22, 0.9], [0.3, 1.0],
  ];
  for (const [r, y] of profile) pts.push(new THREE.Vector2(r * rng.range(0.9, 1.1), y * h));
  const vase = mesh(new THREE.LatheGeometry(pts, 10), mats.standard('sand', rng.chance(0.5) ? pal.secondary : pal.primary, { roughness: 0.7 }), g);
  vase.position.y = 0;
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** Blocky voxel tree: box trunk + 2–3 stacked cube canopy tiers (block-style vegetation). */
export function makeBlockTree(rng: Rng, mats: MaterialLibrary, pal: PropPalette): THREE.Group {
  const g = new THREE.Group();
  const trunkH = rng.range(1.6, 2.6);
  const trunk = mesh(new THREE.BoxGeometry(0.55, trunkH, 0.55), mats.standard('wood', pal.rock, { roughness: 0.9 }), g);
  trunk.position.y = trunkH / 2;
  const greens = [pal.ground, '#4a7a3f', '#5d8a48'];
  const tiers = rng.int(2, 3);
  let w = rng.range(2.2, 3.0);
  let y = trunkH * 0.75;
  for (let i = 0; i < tiers; i++) {
    const leaf = mesh(
      new THREE.BoxGeometry(w, rng.range(0.9, 1.3), w),
      mats.standard('ground', greens[i % greens.length], { roughness: 0.95 }),
      g,
    );
    leaf.position.set(rng.range(-0.25, 0.25), y, rng.range(-0.25, 0.25));
    leaf.rotation.y = rng.range(0, Math.PI / 2);
    y += rng.range(0.8, 1.1);
    w *= rng.range(0.68, 0.8);
  }
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

/** Amber lamp post (signature motif) — emissive only, no real light in the prop field. */
export function makeLampProp(rng: Rng, mats: MaterialLibrary, _pal: PropPalette): THREE.Group {
  return amberLampPost(rng, mats);
}

/** Amber ground lantern (signature motif). */
export function makeLanternProp(rng: Rng, mats: MaterialLibrary, _pal: PropPalette): THREE.Group {
  return amberLantern(rng, mats);
}

const BUILDERS: Record<PropKind, (rng: Rng, mats: MaterialLibrary, pal: PropPalette, cloth: Map<string, THREE.Material>) => THREE.Group> = {
  crate: makeCrate,
  barrel: makeBarrel,
  banner: makeBanner,
  crystal: makeCrystal,
  rubble: makeRubble,
  pillar: makePillar,
  runestone: makeRunestone,
  vase: makeVase,
  blocktree: makeBlockTree,
  lamppost: makeLampProp,
  lantern: makeLanternProp,
};

/** Approximate footprint radius per kind (used for scatter exclusion + shatter tests). */
const KIND_RADIUS: Record<PropKind, number> = {
  crate: 0.9, barrel: 0.7, banner: 0.5, crystal: 1.0,
  rubble: 1.1, pillar: 1.0, runestone: 0.8, vase: 0.6,
  blocktree: 1.6, lamppost: 0.5, lantern: 0.5,
};

export interface PlacedProp {
  kind: PropKind;
  node: THREE.Group;
  pos: THREE.Vector3;
  radius: number;
  fragile: boolean;
}

export interface ScatterPropsOpts {
  mats: MaterialLibrary;
  pal: PropPalette;
  /** render-quality tier — scales counts (high 1.0 / standard 0.6 / retro 0.35) */
  quality?: PropQuality;
  /** base prop count before the quality scaler (default 26) */
  count?: number;
  /** kind pool (default: all) */
  kinds?: PropKind[];
  /** ground height sampler (default: y = 0) */
  groundY?: (x: number, z: number) => number;
  /** scatter square half-extent (default 60) */
  half?: number;
  /** exclusion zones (spawn, track, …) */
  exclusion?: Array<{ x: number; z: number; r: number }>;
  /** extra y lift applied to every prop */
  yOffset?: number;
}

/**
 * A scattered set of props plus the fragile-prop registry. Owns one THREE.Group
 * added to the scene. `tryShatter` removes fragile props in range and fires
 * the caller's burst callback; `dispose` tears the whole field down.
 */
export class PropField {
  readonly group = new THREE.Group();
  readonly props: PlacedProp[] = [];
  private clothMats = new Map<string, THREE.Material>();
  shattered = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  get clothCache(): Map<string, THREE.Material> { return this.clothMats; }

  add(p: PlacedProp): void {
    this.props.push(p);
    this.group.add(p.node);
  }

  /**
   * Shatter every fragile prop within `radius` of `pos` (radius is padded by
   * each prop's footprint). Calls `burst(p, kind)` for each shattered prop so
   * the caller can emit particles / play a sound. Returns the shatter count.
   *
   * Hook for the coordinator: call this from the projectile update when a
   * projectile passes within range of decor, or from melee hit resolution.
   * Cheap: a linear scan over the (small) fragile list.
   */
  tryShatter(pos: THREE.Vector3, radius: number, burst?: (p: THREE.Vector3, kind: PropKind) => void): number {
    let n = 0;
    for (let i = this.props.length - 1; i >= 0; i--) {
      const p = this.props[i];
      if (!p.fragile) continue;
      const dx = p.pos.x - pos.x, dy = p.pos.y - pos.y, dz = p.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz > (radius + p.radius) * (radius + p.radius)) continue;
      this.group.remove(p.node);
      disposeNode(p.node);
      this.props.splice(i, 1);
      this.shattered++;
      n++;
      burst?.(p.pos, p.kind);
    }
    return n;
  }

  dispose(): void {
    for (const p of this.props) disposeNode(p.node);
    this.props.length = 0;
    for (const m of this.clothMats.values()) m.dispose();
    this.clothMats.clear();
    this.group.parent?.remove(this.group);
  }
}

/** Dispose geometries of a prop node. Shared materials (from MaterialLibrary)
 *  are deliberately NOT disposed — the library owns them. */
function disposeNode(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}

/**
 * Scatter a quality-scaled set of props. Deterministic from `rng`: the same
 * seed + opts always produce the same transforms.
 */
export function scatterProps(scene: THREE.Scene, rng: Rng, opts: ScatterPropsOpts): PropField {
  const field = new PropField(scene);
  const kinds = opts.kinds?.length ? opts.kinds : ALL_KINDS;
  const quality = opts.quality ?? 'standard';
  const count = Math.round((opts.count ?? 26) * qualityScale(quality));
  const half = opts.half ?? 60;
  const groundY = opts.groundY ?? (() => 0);
  const yOffset = opts.yOffset ?? 0;
  const excluded = (x: number, z: number, r: number) =>
    (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);

  for (let i = 0; i < count; i++) {
    const kind = kinds[rng.int(0, kinds.length - 1)];
    const radius = KIND_RADIUS[kind];
    let x = 0, z = 0, ok = false;
    for (let a = 0; a < 8; a++) {
      x = rng.range(-half, half); z = rng.range(-half, half);
      if (!excluded(x, z, radius)) { ok = true; break; }
    }
    if (!ok) continue;
    const node = BUILDERS[kind](rng, opts.mats, opts.pal, field.clothCache);
    const y = groundY(x, z) + yOffset;
    node.position.set(x, y, z);
    node.rotation.y = rng.range(0, Math.PI * 2);
    const s = rng.range(0.85, 1.25);
    node.scale.setScalar(s);
    field.add({ kind, node, pos: new THREE.Vector3(x, y, z), radius: radius * s, fragile: FRAGILE_KINDS.has(kind) });
  }
  return field;
}

/** Particle burst options for a shattered prop kind — wire into Particles.burst. */
export function shatterBurst(kind: PropKind, accent: string): BurstOpts {
  return kind === 'crystal'
    ? { count: 26, color: accent, color2: '#ffffff', speed: 7, life: 0.8, size: 1.4, gravity: -12, up: 3 }
    : { count: 18, color: '#c9a06a', color2: '#7a5c3e', speed: 5, life: 0.6, size: 1.8, gravity: -14, up: 2.5, blending: 'normal' as const };
}
