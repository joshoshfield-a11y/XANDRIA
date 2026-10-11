/**
 * Landmarks — procedural blocky set-pieces for the environment art-direction pass:
 * BEAM TOWERS (stepped blocky tower + vertical glow beam + amber doorway),
 * RUIN ARCHES (broken colonnades with lintels), and BRIDGES (blocky spans).
 *
 * Everything is built from boxes (the block-style build language), seeded from
 * the passed Rng, and exclusion-aware. `placeLandmarks` picks a per-environment
 * mix (desert→canyon arches, plains→ruin fields, volcanic→beam towers, …) and
 * returns a placement report so blueprints/tests can assert on it.
 *
 * Light budget: beam towers may spend ONE real amber PointLight each, and the
 * whole call is capped by `maxRealLights` (default 1). Everything else glows
 * via emissive materials + the bloom pass.
 */
import * as THREE from 'three';
import type { Rng } from '../core/Rng';
import type { Genre, Environment } from '@spec';
import type { MaterialLibrary } from './Materials';
import { makeDoorwayGlow, makeWindowGlow, AMBER } from './AmberGlow';

export type LandmarkKind = 'beam-tower' | 'ruin-arch' | 'bridge';

export interface LandmarkPalette {
  primary: string;
  secondary: string;
  accent: string;
  rock: string;
  ground: string;
}

export interface LandmarkOpts {
  mats: MaterialLibrary;
  pal: LandmarkPalette;
  /** terrain height sampler (Structures passes terrain.heightAt bound) */
  heightAt: (x: number, z: number) => number;
  genre: Genre;
  env: Environment;
  /** render-quality tier — scales counts (high 1.0 / standard 0.6 / retro 0.35) */
  quality?: 'retro' | 'standard' | 'high';
  /** scatter square half-extent (default 90) */
  half?: number;
  /** exclusion zones (spawn, track, …) */
  exclusion?: Array<{ x: number; z: number; r: number }>;
  /** override the environment density table */
  kinds?: Partial<Record<LandmarkKind, number>>;
  /** water level — bridges try to span water when present (default: causeways) */
  waterLevel?: number;
  /** real-light budget for the whole call (default 1, beam-tower doorways) */
  maxRealLights?: number;
  /** optional static-collider sink (Structures passes a physics.box wrapper) */
  addCollider?: (size: [number, number, number], pos: [number, number, number]) => void;
}

export interface PlacedLandmark {
  kind: LandmarkKind;
  pos: THREE.Vector3;
  /** footprint radius, for exclusion bookkeeping */
  radius: number;
}

export interface LandmarkResult {
  group: THREE.Group;
  placed: PlacedLandmark[];
  /** real point lights actually added (≤ maxRealLights) */
  realLights: number;
}

/** Per-environment landmark mix: [towers, arches, bridges]. */
const ENV_MIX: Record<string, [number, number, number]> = {
  desert: [2, 6, 1],
  wasteland: [3, 3, 0],
  arctic: [2, 2, 1],
  volcanic: [4, 1, 0],
  forest: [1, 3, 1],
  jungle: [1, 3, 1],
  city: [2, 1, 0],
  'neon-city': [2, 0, 0],
  'space-station': [1, 0, 0],
  ruins: [2, 6, 1],
  dreamscape: [3, 2, 0],
  islands: [1, 1, 2],
  arena: [0, 2, 0],
};

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, g: THREE.Group, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/**
 * Stepped beam tower: 4–6 shrinking block tiers, a vertical glow beam, an
 * amber doorway at the base, and a couple of glowing window insets.
 * Reference: the block-style sheet's stepped tower with the amber door slit.
 */
export function buildBeamTower(rng: Rng, mats: MaterialLibrary, pal: LandmarkPalette, opts: { realLight?: boolean } = {}): THREE.Group {
  const g = new THREE.Group();
  const rock = mats.standard('rock', pal.rock, { roughness: 1 });
  const dark = mats.standard('rock', pal.secondary, { roughness: 1 });
  const tiers = rng.int(4, 6);
  let w = rng.range(6.5, 8);
  let y = 0;
  for (let i = 0; i < tiers; i++) {
    const h = rng.range(2.2, 3.2);
    const tier = mesh(new THREE.BoxGeometry(w, h, w), i % 2 ? dark : rock, g);
    tier.position.y = y + h / 2;
    tier.rotation.y = rng.range(-0.04, 0.04);
    y += h;
    w *= rng.range(0.78, 0.86);
  }
  // top platform + corner nubs
  const plat = mesh(new THREE.BoxGeometry(w * 1.7, 0.8, w * 1.7), dark, g);
  plat.position.y = y + 0.4;
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const nub = mesh(new THREE.BoxGeometry(0.7, 1.6, 0.7), rock, g);
    nub.position.set(cx * w * 0.7, y + 1.4, cz * w * 0.7);
  }
  // vertical glow beam — the vista's signature
  const beamH = 70;
  const beam = mesh(new THREE.BoxGeometry(0.9, beamH, 0.9), mats.glow('#bfe6ff', 2.4), g, false);
  beam.position.y = y + beamH / 2;
  const beamCore = mesh(new THREE.BoxGeometry(0.35, beamH, 0.35), mats.glow('#ffffff', 3.0), g, false);
  beamCore.position.y = y + beamH / 2;
  // amber doorway inset on the base tier, facing +z
  const door = makeDoorwayGlow(mats, 1.6, 3.2, true);
  door.position.set(0, 1.8, w * 0.5 + 0.35);
  g.add(door);
  if (opts.realLight) {
    const l = new THREE.PointLight(AMBER, 30, 22, 1.8);
    l.position.set(0, 2.2, w * 0.5 + 1.6);
    g.add(l);
  }
  // glowing window insets up the shaft
  const wins = rng.int(1, 3);
  for (let i = 0; i < wins; i++) {
    const win = makeWindowGlow(mats, rng.range(0.5, 0.8));
    const a = rng.range(0, Math.PI * 2);
    const ww = w * 0.62;
    win.position.set(Math.cos(a) * ww * 0.55, rng.range(y * 0.25, y * 0.7), Math.sin(a) * ww * 0.55);
    win.rotation.y = -a + Math.PI / 2;
    g.add(win);
  }
  return g;
}

/**
 * Ruin arch: a broken colonnade — 2–4 blocky columns of seeded heights with a
 * lintel box when two tall columns survive, plus fallen chunks nearby.
 */
export function buildRuinArch(rng: Rng, mats: MaterialLibrary, pal: LandmarkPalette): THREE.Group {
  const g = new THREE.Group();
  const rock = mats.standard('rock', pal.secondary, { roughness: 1 });
  const n = rng.int(2, 4);
  const gap = rng.range(3.2, 4.2);
  const tops: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * gap;
    const broken = rng.chance(0.4);
    const h = broken ? rng.range(1.2, 2.4) : rng.range(3.4, 5.2);
    const col = mesh(new THREE.BoxGeometry(1.1, h, 1.1), rock, g);
    col.position.set(x, h / 2, rng.range(-0.3, 0.3));
    col.rotation.y = rng.range(-0.1, 0.1);
    const cap = mesh(new THREE.BoxGeometry(1.5, 0.4, 1.5), rock, g);
    cap.position.set(x, h + 0.2, col.position.z);
    tops.push(h);
    if (broken) {
      // fallen chunk beside the stump
      const chunk = mesh(new THREE.BoxGeometry(rng.range(0.8, 1.3), rng.range(0.7, 1.1), rng.range(0.8, 1.3)), rock, g);
      chunk.position.set(x + rng.range(1.2, 2.2), 0.4, rng.range(-1.5, 1.5));
      chunk.rotation.set(rng.range(0, 1), rng.range(0, 3), rng.range(0, 1));
    }
  }
  // lintel across the two tallest surviving columns
  if (n >= 2) {
    const tall = tops.map((h, i) => [h, i] as const).sort((a, b) => b[0] - a[0]);
    if (tall[0][0] > 3 && tall[1][0] > 3) {
      const [x0, x1] = [tall[0][1], tall[1][1]].sort((a, b) => a - b);
      const span = (x1 - x0) * gap + 2.2;
      const lintel = mesh(new THREE.BoxGeometry(span, 0.9, 1.4), rock, g);
      lintel.position.set(((x0 + x1) / 2 - (n - 1) / 2) * gap, Math.min(tall[0][0], tall[1][0]) + 0.85, 0);
      lintel.rotation.y = rng.range(-0.05, 0.05);
    }
  }
  // occasional amber window slit in one column
  if (rng.chance(0.5)) {
    const win = makeWindowGlow(mats, 0.55);
    win.position.set(rng.range(-gap, gap), rng.range(1.5, 3), 0.58);
    g.add(win);
  }
  return g;
}

/**
 * Blocky bridge: deck segments + side rails + support pillars sunk to the
 * sampled ground. `span` is the deck length, `width` the deck width.
 * `heightAt` is LOCAL (pre-placement) — supports sink to the ground under them.
 */
export function buildBridge(rng: Rng, mats: MaterialLibrary, pal: LandmarkPalette, heightAt: (x: number, z: number) => number, span: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const stone = mats.standard('rock', pal.rock, { roughness: 1 });
  const dark = mats.standard('rock', pal.secondary, { roughness: 1 });
  const deckY = 0;
  const segs = Math.max(3, Math.round(span / 3));
  for (let i = 0; i < segs; i++) {
    const x = -span / 2 + (i + 0.5) * (span / segs);
    const slab = mesh(new THREE.BoxGeometry(span / segs + 0.15, 0.7, width), i % 2 ? dark : stone, g);
    slab.position.set(x, deckY - 0.35, 0);
  }
  // rails
  for (const s of [-1, 1]) {
    const rail = mesh(new THREE.BoxGeometry(span, 0.5, 0.35), dark, g);
    rail.position.set(0, deckY + 0.55, s * (width / 2 - 0.17));
    const posts = Math.max(2, Math.round(span / 4));
    for (let i = 0; i <= posts; i++) {
      const x = -span / 2 + (i / posts) * span;
      const post = mesh(new THREE.BoxGeometry(0.35, 1.3, 0.35), stone, g);
      post.position.set(x, deckY + 0.15, s * (width / 2 - 0.17));
    }
  }
  // support pillars down to the ground at quarter points
  for (const fx of [-0.32, 0, 0.32]) {
    const x = fx * span;
    const gy = heightAt(x, 0);
    const top = deckY - 0.7;
    const h = Math.max(1, top - (Number.isFinite(gy) ? gy : top - 4));
    const pillar = mesh(new THREE.BoxGeometry(1.4, h, 1.4), stone, g);
    pillar.position.set(x, top - h / 2, 0);
  }
  // amber lamp nubs on the end posts
  for (const s of [-1, 1]) {
    const lamp = mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), mats.glow(AMBER, 2.2), g, false);
    lamp.position.set(s * span / 2, deckY + 1.0, 0);
  }
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

const KIND_RADIUS: Record<LandmarkKind, number> = {
  'beam-tower': 6,
  'ruin-arch': 5,
  bridge: 9,
};

function qualityScale(q: 'retro' | 'standard' | 'high'): number {
  return q === 'high' ? 1 : q === 'standard' ? 0.6 : 0.35;
}

/**
 * Place a per-environment mix of landmarks. Deterministic from `rng` — the
 * same seed + opts always yields the same placements. Exclusion-aware; never
 * throws (degenerate input → fewer or zero landmarks, still a valid result).
 */
export function placeLandmarks(scene: THREE.Scene, rng: Rng, opts: LandmarkOpts): LandmarkResult {
  const group = new THREE.Group();
  const placed: PlacedLandmark[] = [];
  const quality = opts.quality ?? 'standard';
  const half = Math.max(10, opts.half ?? 90);
  const qMul = qualityScale(quality);
  const mix = ENV_MIX[opts.env] ?? [2, 2, 0];
  const want: Record<LandmarkKind, number> = {
    'beam-tower': Math.min(8, Math.max(0, Math.round((opts.kinds?.['beam-tower'] ?? mix[0]) * qMul))),
    'ruin-arch': Math.min(8, Math.max(0, Math.round((opts.kinds?.['ruin-arch'] ?? mix[1]) * qMul))),
    bridge: Math.min(4, Math.max(0, Math.round((opts.kinds?.bridge ?? mix[2]) * qMul))),
  };
  const budget = Math.max(0, Math.min(4, Math.round(opts.maxRealLights ?? 1)));
  let realLights = 0;
  const excluded = (x: number, z: number, r: number) =>
    (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);
  const tooClose = (x: number, z: number, r: number) =>
    placed.some((p) => (x - p.pos.x) ** 2 + (z - p.pos.z) ** 2 < (r + p.radius + 6) ** 2);
  const findSpot = (r: number): [number, number] | null => {
    for (let a = 0; a < 12; a++) {
      const x = rng.range(-half, half), z = rng.range(-half, half);
      if (excluded(x, z, r) || tooClose(x, z, r)) continue;
      return [x, z];
    }
    return null;
  };

  const placeTower = (): void => {
    const spot = findSpot(KIND_RADIUS['beam-tower']);
    if (!spot) return;
    const [x, z] = spot;
    const gy = opts.heightAt(x, z);
    if (!Number.isFinite(gy)) return;
    const wantLight = realLights < budget;
    const node = buildBeamTower(rng, opts.mats, opts.pal, { realLight: wantLight });
    if (wantLight) realLights++;
    node.position.set(x, gy, z);
    group.add(node);
    placed.push({ kind: 'beam-tower', pos: new THREE.Vector3(x, gy, z), radius: KIND_RADIUS['beam-tower'] });
    opts.addCollider?.([9, 14, 9], [x, gy + 7, z]);
  };

  const placeArch = (): void => {
    const spot = findSpot(KIND_RADIUS['ruin-arch']);
    if (!spot) return;
    const [x, z] = spot;
    const gy = opts.heightAt(x, z);
    if (!Number.isFinite(gy)) return;
    const node = buildRuinArch(rng, opts.mats, opts.pal);
    node.position.set(x, gy, z);
    group.add(node);
    placed.push({ kind: 'ruin-arch', pos: new THREE.Vector3(x, gy, z), radius: KIND_RADIUS['ruin-arch'] });
    opts.addCollider?.([8, 6, 3], [x, gy + 3, z]);
  };

  const placeBridgeAt = (): void => {
    const spot = findSpot(KIND_RADIUS.bridge);
    if (!spot) return;
    let [cx, cz] = spot;
    const span = rng.range(16, 26);
    const width = rng.range(3.5, 5);
    const wl = opts.waterLevel;
    let lift = 0;
    if (wl !== undefined && Number.isFinite(wl)) {
      // hunt for a water crossing near the candidate spot
      for (let a = 0; a < 10; a++) {
        const px = cx + rng.range(-30, 30), pz = cz + rng.range(-30, 30);
        const h = opts.heightAt(px, pz);
        if (Number.isFinite(h) && h < wl) { cx = px; cz = pz; break; }
      }
      lift = Math.max(0, wl + 1.2 - opts.heightAt(cx, cz));
    }
    const gy = opts.heightAt(cx, cz);
    if (!Number.isFinite(gy)) return;
    const localHeight = (lx: number, lz: number) => opts.heightAt(cx + lx, cz + lz) - lift;
    const node = buildBridge(rng, opts.mats, opts.pal, localHeight, span, width);
    node.position.set(cx, gy + lift, cz);
    group.add(node);
    placed.push({ kind: 'bridge', pos: new THREE.Vector3(cx, gy + lift, cz), radius: KIND_RADIUS.bridge });
    opts.addCollider?.([span, 3, width], [cx, gy + lift + 1, cz]);
  };

  try {
    for (let i = 0; i < want['beam-tower']; i++) placeTower();
    for (let i = 0; i < want['ruin-arch']; i++) placeArch();
    for (let i = 0; i < want.bridge; i++) placeBridgeAt();
  } catch {
    // never let a landmark take the world down with it
  }

  scene.add(group);
  return { group, placed, realLights };
}
