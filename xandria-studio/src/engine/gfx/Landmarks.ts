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
import { makeDoorwayGlow, makeWindowGlow, amberGlowMaterial, Instancer, AMBER } from './AmberGlow';

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
  /** explicit per-kind counts (absolute, quality-scaled, capped) — bypasses the seeded 1–3 mix */
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
  /** amber accent instances registered on/near landmarks (rune strips + lamp orbs) */
  amberAccents: number;
  /** InstancedMeshes baked into the group (shared draw calls) */
  instancedMeshes: number;
}

/** Per-environment landmark mix weights: [towers, arches, bridges]. */
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

/**
 * Genre bias multipliers over the environment mix: [towers, arches, bridges].
 * Racing wants bridges (track crossings); fps-arena wants towers (sight
 * markers) + arches (cover); platformer wants arches (anchors) + bridges;
 * top-down wants towers (vista anchors).
 */
const GENRE_BIAS: Record<Genre, [number, number, number]> = {
  'third-person-action': [1.2, 1.2, 1.0],
  'fps-arena': [2.0, 1.5, 0.5],
  racing: [1.5, 1.0, 2.5],
  platformer: [0.8, 2.0, 1.5],
  'top-down-shooter': [2.0, 1.0, 0.8],
};

const KIND_ORDER: LandmarkKind[] = ['beam-tower', 'ruin-arch', 'bridge'];

/** Effective per-kind weights for a (genre, env) pair. */
export function kindWeights(genre: Genre, env: Environment): [number, number, number] {
  const mix = ENV_MIX[env] ?? [2, 2, 0];
  const bias = GENRE_BIAS[genre] ?? [1, 1, 1];
  return [mix[0] * bias[0], mix[1] * bias[1], mix[2] * bias[2]];
}

/**
 * Pick `n` landmark kinds: the dominant (env × genre) kind always goes first
 * so the world reads correctly (desert→arches, volcanic→towers, …), the
 * rest are weighted samples. Deterministic from `rng`.
 */
export function pickKinds(rng: Rng, genre: Genre, env: Environment, n: number): LandmarkKind[] {
  const w = kindWeights(genre, env);
  const total = w[0] + w[1] + w[2];
  if (total <= 0) return Array.from({ length: Math.max(0, n) }, () => 'ruin-arch' as LandmarkKind);
  let di = 0;
  for (let i = 1; i < 3; i++) if (w[i] > w[di]) di = i;
  const kinds: LandmarkKind[] = [KIND_ORDER[di]];
  for (let k = 1; k < n; k++) {
    let r = rng.next() * total;
    let idx = 0;
    while (idx < 2 && r >= w[idx]) { r -= w[idx]; idx++; }
    kinds.push(KIND_ORDER[idx]);
  }
  return kinds;
}

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
 *
 * When `inst` is passed, the rock/dark structural boxes (tiers, platform,
 * corner nubs) are emitted as instances into it instead of individual meshes
 * (draw-call diet: ~10 meshes → 2 buckets). The glow pieces (beam, doorway,
 * windows) stay meshes — they use distinct high-intensity emissive materials
 * that the amber-accent accounting treats separately. Without `inst` the
 * classic mesh path is built (same silhouette, same rng sequence).
 */
export function buildBeamTower(rng: Rng, mats: MaterialLibrary, pal: LandmarkPalette, opts: { realLight?: boolean; inst?: Instancer } = {}): THREE.Group {
  const g = new THREE.Group();
  const rock = mats.standard('rock', pal.rock, { roughness: 1 });
  const dark = mats.standard('rock', pal.secondary, { roughness: 1 });
  const inst = opts.inst;
  const putBox = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): void => {
    if (inst) inst.box(mat, x, y, z, w, h, d, ry, true);
    else {
      const m = mesh(new THREE.BoxGeometry(w, h, d), mat, g);
      m.position.set(x, y, z);
      m.rotation.y = ry;
    }
  };
  const tiers = rng.int(4, 6);
  let w = rng.range(6.5, 8);
  let y = 0;
  for (let i = 0; i < tiers; i++) {
    const h = rng.range(2.2, 3.2);
    const tierRy = rng.range(-0.04, 0.04);
    putBox(i % 2 ? dark : rock, w, h, w, 0, y + h / 2, 0, tierRy);
    y += h;
    w *= rng.range(0.78, 0.86);
  }
  // top platform + corner nubs
  putBox(dark, w * 1.7, 0.8, w * 1.7, 0, y + 0.4, 0);
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    putBox(rock, 0.7, 1.6, 0.7, cx * w * 0.7, y + 1.4, cz * w * 0.7);
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
 *
 * When `inst` is passed, column bodies / caps / fallen chunks are emitted as
 * instances into it (baked by the caller) instead of individual meshes —
 * the placement pass uses this so every arch segment shares one draw call.
 * Without `inst` the classic mesh path is built (same silhouette).
 */
export function buildRuinArch(rng: Rng, mats: MaterialLibrary, pal: LandmarkPalette, inst?: Instancer): THREE.Group {
  const g = new THREE.Group();
  const rock = mats.standard('rock', pal.secondary, { roughness: 1 });
  const putBox = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): void => {
    if (inst) inst.box(rock, x, y, z, w, h, d, ry, true);
    else {
      const m = mesh(new THREE.BoxGeometry(w, h, d), rock, g);
      m.position.set(x, y, z);
      m.rotation.y = ry;
    }
  };
  const n = rng.int(2, 4);
  const gap = rng.range(3.2, 4.2);
  const tops: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * gap;
    const broken = rng.chance(0.4);
    const h = broken ? rng.range(1.2, 2.4) : rng.range(3.4, 5.2);
    const colRy = rng.range(-0.1, 0.1);
    const colZ = rng.range(-0.3, 0.3);
    putBox(1.1, h, 1.1, x, h / 2, colZ, colRy);
    putBox(1.5, 0.4, 1.5, x, h + 0.2, colZ, colRy);
    tops.push(h);
    if (broken) {
      // fallen chunk beside the stump
      const cw = rng.range(0.8, 1.3), ch = rng.range(0.7, 1.1), cd = rng.range(0.8, 1.3);
      if (inst) {
        inst.box(rock, x + rng.range(1.2, 2.2), 0.4, rng.range(-1.5, 1.5), cw, ch, cd, rng.range(0, 3), true);
      } else {
        const chunk = mesh(new THREE.BoxGeometry(cw, ch, cd), rock, g);
        chunk.position.set(x + rng.range(1.2, 2.2), 0.4, rng.range(-1.5, 1.5));
        chunk.rotation.set(rng.range(0, 1), rng.range(0, 3), rng.range(0, 1));
      }
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
 *
 * When `inst` is passed, deck slabs / rails / posts / pillars are emitted as
 * instances into it (baked by the caller); the amber lamp nubs stay meshes.
 */
export function buildBridge(rng: Rng, mats: MaterialLibrary, pal: LandmarkPalette, heightAt: (x: number, z: number) => number, span: number, width: number, inst?: Instancer): THREE.Group {
  const g = new THREE.Group();
  const stone = mats.standard('rock', pal.rock, { roughness: 1 });
  const dark = mats.standard('rock', pal.secondary, { roughness: 1 });
  const putBox = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): void => {
    if (inst) inst.box(mat, x, y, z, w, h, d, 0, true);
    else {
      const m = mesh(new THREE.BoxGeometry(w, h, d), mat, g);
      m.position.set(x, y, z);
    }
  };
  const deckY = 0;
  const segs = Math.max(3, Math.round(span / 3));
  for (let i = 0; i < segs; i++) {
    const x = -span / 2 + (i + 0.5) * (span / segs);
    putBox(i % 2 ? dark : stone, span / segs + 0.15, 0.7, width, x, deckY - 0.35, 0);
  }
  // rails
  for (const s of [-1, 1]) {
    putBox(dark, span, 0.5, 0.35, 0, deckY + 0.55, s * (width / 2 - 0.17));
    const posts = Math.max(2, Math.round(span / 4));
    for (let i = 0; i <= posts; i++) {
      const x = -span / 2 + (i / posts) * span;
      putBox(stone, 0.35, 1.3, 0.35, x, deckY + 0.15, s * (width / 2 - 0.17));
    }
  }
  // support pillars down to the ground at quarter points
  for (const fx of [-0.32, 0, 0.32]) {
    const x = fx * span;
    const gy = heightAt(x, 0);
    const top = deckY - 0.7;
    const h = Math.max(1, top - (Number.isFinite(gy) ? gy : top - 4));
    putBox(stone, 1.4, h, 1.4, x, top - h / 2, 0);
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
 * Amber rune-strip ring around a landmark footprint. Every strip is one
 * instance in the shared amber bucket — one draw call for the whole world's
 * rune strips. Returns the number of strips registered.
 */
function addRuneRing(
  inst: Instancer, rng: Rng, mats: MaterialLibrary,
  heightAt: (x: number, z: number) => number,
  cx: number, cy: number, cz: number, radius: number, density: number,
): number {
  const amber = amberGlowMaterial(mats, 2.6);
  const n = Math.max(3, Math.round(rng.int(4, 7) * density));
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const r = radius + rng.range(0.8, 1.8);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const gy = heightAt(x, z);
    if (!Number.isFinite(gy)) continue;
    inst.box(amber, x, gy + 0.16, z, 1.5, 0.3, 0.55, -a + Math.PI / 2, false);
    count++;
  }
  return count;
}

/**
 * 1–2 instanced amber lamp posts near a landmark's "front" (tower doorway,
 * arch face). Post boxes share one instanced draw; orbs share the amber
 * bucket. Returns the number of lamps registered.
 */
function addLandmarkLamps(
  inst: Instancer, rng: Rng, mats: MaterialLibrary,
  heightAt: (x: number, z: number) => number,
  x: number, y: number, z: number, faceAngle: number,
): number {
  const dark = mats.standard('metal', '#3a3f47', { roughness: 0.6, metalness: 0.5 });
  const amber = amberGlowMaterial(mats, 2.6);
  const n = rng.int(1, 2);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = faceAngle + rng.range(-0.7, 0.7) + (i === 1 ? Math.PI : 0);
    const lx = x + Math.cos(a) * 3.4, lz = z + Math.sin(a) * 3.4;
    const gy = heightAt(lx, lz);
    if (!Number.isFinite(gy)) continue;
    inst.box(dark, lx, gy + 0.8, lz, 0.24, 1.6, 0.24, rng.range(0, Math.PI), true);
    inst.sphere(amber, lx, gy + 1.85, lz, 0.3, false);
    count++;
  }
  return count;
}

/**
 * Rune strips flanking a bridge deck, following the deck's yaw. Returns the
 * number of strips registered. `cy` is the deck-top world y.
 */
function addBridgeRunes(
  inst: Instancer, rng: Rng, mats: MaterialLibrary,
  cx: number, cy: number, cz: number, ry: number, span: number, width: number,
): number {
  const amber = amberGlowMaterial(mats, 2.6);
  const cosr = Math.cos(ry), sinr = Math.sin(ry);
  let count = 0;
  for (const s of [-1, 1]) {
    for (let d = -span / 2 + 2; d <= span / 2 - 1.5; d += 4) {
      const lx = d + rng.range(-0.4, 0.4), lz = s * (width / 2 + 0.85);
      inst.box(amber, cx + lx * cosr + lz * sinr, cy + 0.16, cz - lx * sinr + lz * cosr,
        1.4, 0.26, 0.5, ry + rng.range(-0.15, 0.15), false);
      count++;
    }
  }
  return count;
}

/**
 * Place 1–3 landmarks per generated world (the art-direction budget for a
 * hero set-piece count). Kinds come from the environment mix × genre bias —
 * the dominant kind is always placed first so the world reads correctly
 * (desert→arches, volcanic→towers, racing→bridges, …).
 *
 * Deterministic from `rng` — the same seed + opts always yields the same
 * placements. Exclusion-aware; never throws (degenerate input → fewer or
 * zero landmarks, still a valid result).
 *
 * Amber motif: every landmark gets an instanced rune-strip ring and 1–2
 * instanced amber lamp posts at its front; bridges get rune strips along
 * the deck. Repeated geometry (arch segments, bridge planks/posts, rune
 * strips, lamp parts) batches into shared InstancedMeshes; all materials
 * come from the library cache. Real point lights stay budgeted.
 */
export function placeLandmarks(scene: THREE.Scene, rng: Rng, opts: LandmarkOpts): LandmarkResult {
  const group = new THREE.Group();
  const placed: PlacedLandmark[] = [];
  const quality = opts.quality ?? 'standard';
  const half = Math.max(10, opts.half ?? 90);
  const qMul = qualityScale(quality);

  // Count model: 1–3 seeded landmarks per world from the (env × genre) mix,
  // in pick order (dominant kind first). An explicit `kinds` override keeps
  // the old absolute-count behaviour (quality-scaled, capped) for
  // staged/demo callers, placed towers→arches→bridges as before.
  let order: LandmarkKind[];
  if (opts.kinds) {
    order = [];
    const abs = (k: LandmarkKind, cap: number) =>
      Math.min(cap, Math.max(0, Math.round((opts.kinds?.[k] ?? 0) * qMul)));
    for (let i = 0; i < abs('beam-tower', 8); i++) order.push('beam-tower');
    for (let i = 0; i < abs('ruin-arch', 8); i++) order.push('ruin-arch');
    for (let i = 0; i < abs('bridge', 4); i++) order.push('bridge');
  } else {
    order = pickKinds(rng, opts.genre, opts.env, rng.int(1, 3));
  }

  const budget = Math.max(0, Math.min(4, Math.round(opts.maxRealLights ?? 1)));
  let realLights = 0;
  let amberAccents = 0;
  let instancedMeshes = 0;
  const accents = new Instancer(); // placement-level bucket: rune rings + landmark lamps
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
    const nodeInst = new Instancer();
    const node = buildBeamTower(rng, opts.mats, opts.pal, { realLight: wantLight, inst: nodeInst });
    if (wantLight) realLights++;
    instancedMeshes += nodeInst.bake(node).length;
    node.position.set(x, gy, z);
    group.add(node);
    amberAccents += addRuneRing(accents, rng, opts.mats, opts.heightAt, x, gy, z, KIND_RADIUS['beam-tower'], qMul);
    amberAccents += addLandmarkLamps(accents, rng, opts.mats, opts.heightAt, x, gy, z, Math.PI / 2); // doorway faces +z
    placed.push({ kind: 'beam-tower', pos: new THREE.Vector3(x, gy, z), radius: KIND_RADIUS['beam-tower'] });
    opts.addCollider?.([9, 14, 9], [x, gy + 7, z]);
  };

  const placeArch = (): void => {
    const spot = findSpot(KIND_RADIUS['ruin-arch']);
    if (!spot) return;
    const [x, z] = spot;
    const gy = opts.heightAt(x, z);
    if (!Number.isFinite(gy)) return;
    const nodeInst = new Instancer();
    const node = buildRuinArch(rng, opts.mats, opts.pal, nodeInst);
    instancedMeshes += nodeInst.bake(node).length;
    node.position.set(x, gy, z);
    group.add(node);
    amberAccents += addRuneRing(accents, rng, opts.mats, opts.heightAt, x, gy, z, KIND_RADIUS['ruin-arch'], qMul);
    amberAccents += addLandmarkLamps(accents, rng, opts.mats, opts.heightAt, x, gy, z, rng.range(0, Math.PI * 2));
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
    const nodeInst = new Instancer();
    const node = buildBridge(rng, opts.mats, opts.pal, localHeight, span, width, nodeInst);
    instancedMeshes += nodeInst.bake(node).length;
    node.position.set(cx, gy + lift, cz);
    group.add(node);
    amberAccents += addBridgeRunes(accents, rng, opts.mats, cx, gy + lift, cz, node.rotation.y, span, width);
    amberAccents += addLandmarkLamps(accents, rng, opts.mats, opts.heightAt, cx, gy + lift, cz, node.rotation.y + Math.PI / 2);
    placed.push({ kind: 'bridge', pos: new THREE.Vector3(cx, gy + lift, cz), radius: KIND_RADIUS.bridge });
    opts.addCollider?.([span, 3, width], [cx, gy + lift + 1, cz]);
  };

  try {
    for (const k of order) {
      if (k === 'beam-tower') placeTower();
      else if (k === 'ruin-arch') placeArch();
      else placeBridgeAt();
    }
  } catch {
    // never let a landmark take the world down with it
  }

  instancedMeshes += accents.bake(group).length;
  scene.add(group);
  return { group, placed, realLights, amberAccents, instancedMeshes };
}
