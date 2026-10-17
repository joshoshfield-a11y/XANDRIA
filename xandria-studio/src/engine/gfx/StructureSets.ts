/**
 * Biome structure sets — graphics wave 2, workstream C.
 *
 * Per-biome architectural set-pieces that give an 8km traverse its variety:
 * desert canyon ruins, forest watchtowers, snow shrines, volcanic obsidian
 * spires, coastline docks + lighthouses, cave crystal formations.
 *
 * Everything is blocky (the voxel build language) and every repeated piece
 * emits into ONE shared Instancer per placement call — the AmberGlow
 * instancer pattern — so an entire map's structures cost a handful of draw
 * calls (one per material bucket) no matter how many structures are placed.
 * Glow bits reuse the shared amber bucket (amberGlowMaterial 2.6); cave
 * crystals get their own teal bucket.
 *
 * Placement is chunk-deterministic: the hero cluster near spawn rolls from
 * the map seed, and every satellite cluster rolls from
 * chunkSeed(mapSeed, STRUCT_SALT, cx, cz) — the same chunk always produces
 * the same structures regardless of load order, which is what lets the
 * chunk-streaming path (workstream E) adopt these placements later.
 * Per-map seeding: the caller passes spec.meta.seed, which the portals wave
 * stamps as deriveMapSeed(worldSeed, mx, my) — every map regenerates
 * identically, including return trips.
 *
 * Deterministic from the passed seeds. Never throws — degenerate input
 * yields fewer (or zero) structures, still a valid result.
 */
import * as THREE from 'three';
import { Rng } from '../core/Rng';
import type { MaterialLibrary } from './Materials';
import { Instancer, amberGlowMaterial } from './AmberGlow';
import type { BiomeDef, BiomeId } from '../world/Biomes';
import { chunkSeed } from '../world/ChunkGrid';
import { chunkWorldRect, chunkKey, worldToChunk, type ChunkGrid } from '../world/chunkLayout';

export type StructureSetKind =
  | 'canyon-ruins'
  | 'watchtower'
  | 'shrine'
  | 'obsidian-spire'
  | 'lighthouse'
  | 'dock'
  | 'crystal-formation';

/** Which set-pieces a biome fields. Coastline fields two (docks need water). */
const BIOME_SETS: Record<BiomeId, StructureSetKind[]> = {
  'plains': ['watchtower'],
  'desert-canyon': ['canyon-ruins'],
  'forest': ['watchtower'],
  'snow': ['shrine'],
  'volcanic': ['obsidian-spire'],
  'coastline': ['lighthouse', 'dock'],
  'caves': ['crystal-formation'],
};

/** Chunk-seed salt for structure placement (distinct from scatter/landmark salts). */
export const STRUCTURE_CHUNK_SALT = 0x57c7;

/** Base per-chunk satellite-cluster probability (quality-scaled). */
const CLUSTER_DENSITY = 0.055;

function qualityScale(q: 'retro' | 'standard' | 'high'): number {
  return q === 'high' ? 1 : q === 'standard' ? 0.6 : 0.35;
}

/** Small material palette for the sets — biome-tinted bodies, shared glow. */
interface SetMats {
  rock: THREE.Material;
  dark: THREE.Material;
  amber: THREE.Material;
  teal: THREE.Material;
}

function setMats(mats: MaterialLibrary, biome: BiomeDef): SetMats {
  return {
    rock: mats.standard('rock', biome.palette.rock, { roughness: 1 }),
    dark: mats.standard('rock', biome.palette.secondary, { roughness: 1 }),
    amber: amberGlowMaterial(mats, 2.6),
    teal: mats.glow('#59d8ff', 2.0),
  };
}

/** Dimensions a builder reports for colliders / exclusion. */
export interface SetDims { r: number; h: number }

/**
 * Emission origin: builders author in a local frame (structure center at
 * x=0,z=0, base at y=0); every emission is offset by (ox, oy, oz) so the
 * shared instancer holds world-space matrices.
 */
interface Origin { ox: number; oy: number; oz: number }
const at = (o: Origin, x: number, y: number, z: number): [number, number, number] =>
  [o.ox + x, o.oy + y, o.oz + z];

// ---------------------------------------------------------------------------
// Builders — local-frame emission, world-space via the origin offset.
// ---------------------------------------------------------------------------

/** Desert canyon ruins: broken sandstone wall fragments + fallen slabs. */
export function emitCanyonRuins(inst: Instancer, rng: Rng, M: SetMats, o: Origin, shadows = true): SetDims {
  const frags = rng.int(3, 5);
  let maxH = 0;
  for (let i = 0; i < frags; i++) {
    const a = (i / frags) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = rng.range(2.5, 5);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const w = rng.range(2, 4.2), h = rng.range(1.2, 3.4), t = rng.range(0.7, 1);
    const mat = rng.chance(0.6) ? M.rock : M.dark;
    const segs = rng.int(1, 3);
    for (let s = 0; s < segs; s++) {
      const sh = h * (1 - s * 0.28);
      const [px, py, pz] = at(o, x, sh / 2 + s * h * 0.72, z);
      inst.box(mat, px, py, pz, w * (1 - s * 0.15), sh, t, rng.range(-0.15, 0.15) + a, true);
    }
    maxH = Math.max(maxH, h * 1.2);
    if (rng.chance(0.6)) {
      const [px, py, pz] = at(o, x + rng.range(1.5, 2.8), 0.3, z + rng.range(-1.5, 1.5));
      inst.box(M.rock, px, py, pz, rng.range(1.2, 2.2), 0.5, rng.range(0.8, 1.4), rng.range(0, 3), true);
    }
  }
  const [ax, ay, az] = at(o, 0, 0.16, 0);
  inst.box(M.amber, ax, ay, az, 1.5, 0.3, 0.55, rng.range(0, Math.PI), false);
  return { r: 6.5, h: Math.max(3, maxH) };
}

/** Forest / plains watchtower: timber legs, platform, railed roof, amber lamp. */
export function emitWatchtower(inst: Instancer, rng: Rng, M: SetMats, o: Origin, shadows = true): SetDims {
  const legH = rng.range(4, 5.2);
  const spread = 1.5;
  const put = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, shadow = shadows) => {
    const [px, py, pz] = at(o, x, y, z);
    inst.box(mat, px, py, pz, sx, sy, sz, ry, shadow);
  };
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    put(M.dark, sx * spread, legH / 2, sz * spread, 0.45, legH, 0.45);
  for (const s of [-1, 1]) {
    put(M.dark, 0, legH * 0.35, s * spread, spread * 2 + 0.4, 0.28, 0.28, 0.5 * s);
    put(M.dark, s * spread, legH * 0.35, 0, 0.28, 0.28, spread * 2 + 0.4, 0.5 * s);
  }
  put(M.rock, 0, legH + 0.25, 0, spread * 2 + 1.2, 0.5, spread * 2 + 1.2);
  const railY = legH + 1.15;
  for (const s of [-1, 1]) {
    put(M.dark, 0, railY, s * (spread + 0.5), spread * 2 + 1.2, 0.28, 0.22);
    put(M.dark, s * (spread + 0.5), railY, 0, 0.22, 0.28, spread * 2 + 1.2);
  }
  for (const s of [-1, 1]) for (const t of [-1, 1])
    put(M.dark, s * spread, railY + 1.1, t * spread, 0.3, 1.6, 0.3);
  put(M.rock, 0, railY + 2.1, 0, spread * 2 + 1.8, 0.5, spread * 2 + 1.8);
  put(M.dark, 0, railY + 2.75, 0, spread * 1.4, 0.5, spread * 1.4, 0.2);
  put(M.amber, 0, legH - 0.5, 0, 0.5, 0.5, 0.5, 0, false); // lamp slung under the platform
  return { r: 3.5, h: railY + 3 };
}

/** Snow shrine: stepped plinth, pillars, lintel, amber brazier. */
export function emitShrine(inst: Instancer, rng: Rng, M: SetMats, o: Origin, shadows = true): SetDims {
  const put = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, shadow = shadows) => {
    const [px, py, pz] = at(o, x, y, z);
    inst.box(mat, px, py, pz, sx, sy, sz, ry, shadow);
  };
  put(M.rock, 0, 0.3, 0, 5.2, 0.6, 5.2);
  put(M.dark, 0, 0.85, 0, 4.2, 0.5, 4.2);
  const pilH = rng.range(2.4, 3);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    put(M.rock, sx * 1.6, 1.1 + pilH / 2, sz * 1.6, 0.6, pilH, 0.6);
    put(M.dark, sx * 1.6, 1.1 + pilH + 0.15, sz * 1.6, 0.9, 0.3, 0.9);
  }
  put(M.rock, 0, 1.1 + pilH + 0.55, 0, 4.6, 0.5, 1.2);
  put(M.rock, 0, 1.1 + pilH + 0.55, 0, 1.2, 0.5, 4.6);
  put(M.dark, 0, 1.35, 0, 1.1, 0.5, 1.1); // brazier bowl
  put(M.amber, 0, 1.85, 0, 0.7, 0.7, 0.7, rng.range(0, Math.PI), false); // fire
  for (const s of [-1, 1])
    put(M.amber, s * 3.4, 1.16, 0, 1.5, 0.26, 0.5, rng.range(-0.2, 0.2), false);
  return { r: 4, h: 1.1 + pilH + 1 };
}

/** Volcanic obsidian spire: jagged stacked slabs with amber veins. */
export function emitObsidianSpire(inst: Instancer, rng: Rng, M: SetMats, o: Origin, shadows = true): SetDims {
  const segs = rng.int(5, 8);
  let x = 0, z = 0, y = 0, w = rng.range(2, 2.6);
  const put = (mat: THREE.Material, px: number, py: number, pz: number, sx: number, sy: number, sz: number, ry = 0, shadow = shadows) => {
    const [wx, wy, wz] = at(o, px, py, pz);
    inst.box(mat, wx, wy, wz, sx, sy, sz, ry, shadow);
  };
  for (let i = 0; i < segs; i++) {
    const h = rng.range(1.6, 2.6);
    const ry = rng.range(0, Math.PI);
    put(M.dark, x, y + h / 2, z, w, h, w * rng.range(0.7, 1), ry);
    if (rng.chance(0.7)) {
      const va = ry + Math.PI / 2;
      put(M.amber, x + Math.cos(va) * (w / 2 + 0.06), y + h / 2, z + Math.sin(va) * (w / 2 + 0.06),
        0.18, h * 0.8, 0.3, va, false);
    }
    y += h * 0.92;
    x += rng.range(-0.7, 0.7);
    z += rng.range(-0.7, 0.7);
    w *= rng.range(0.72, 0.85);
  }
  for (let i = 0; i < 3; i++)
    put(M.dark, rng.range(-2.4, 2.4), 0.35, rng.range(-2.4, 2.4),
      rng.range(0.8, 1.6), 0.7, rng.range(0.8, 1.6), rng.range(0, 3));
  return { r: 3.5, h: y + 1 };
}

/** Coastline lighthouse: banded tapering tower, gallery, amber beacon. */
export function emitLighthouse(inst: Instancer, rng: Rng, M: SetMats, o: Origin, shadows = true): SetDims {
  const put = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, shadow = shadows) => {
    const [px, py, pz] = at(o, x, y, z);
    inst.box(mat, px, py, pz, sx, sy, sz, ry, shadow);
  };
  const tiers = rng.int(3, 4);
  const w0 = rng.range(3.2, 3.8);
  let w = w0, y = 0;
  for (let i = 0; i < tiers; i++) {
    const h = rng.range(2.4, 3);
    put(i % 2 ? M.dark : M.rock, 0, y + h / 2, 0, w, h, w);
    y += h;
    w *= 0.86;
  }
  put(M.dark, 0, y + 0.25, 0, w * 1.9, 0.5, w * 1.9);
  const lampH = 1.6;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    put(M.dark, sx * w * 0.7, y + 0.5 + lampH / 2, sz * w * 0.7, 0.25, lampH, 0.25);
  put(M.amber, 0, y + 0.5 + lampH / 2, 0, 0.9, 1.1, 0.9, 0, false); // beacon
  put(M.dark, 0, y + 0.5 + lampH + 0.25, 0, w * 1.7, 0.4, w * 1.7, 0.15);
  put(M.dark, 0, 1.4, w0 * 0.62, 1.1, 2.6, 0.2, 0, false); // doorway
  put(M.amber, 0, 1.4, w0 * 0.62 + 0.08, 0.7, 1.8, 0.1, 0, false);
  return { r: 4, h: y + lampH + 1 };
}

/**
 * Coastline dock: plank deck reaching toward the water on pilings, amber
 * lamps at the far end. `waterY` is the ABSOLUTE water plane height — the
 * deck rides just above it regardless of the local ground height.
 */
export function emitDock(inst: Instancer, rng: Rng, M: SetMats, o: Origin, waterY: number, shadows = true): SetDims {
  const deckY = waterY + 1.1;
  const len = rng.range(9, 13);
  const put = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, shadow = shadows) => {
    // NOTE: y here is absolute (deckY is world-space); only x/z take the origin.
    inst.box(mat, o.ox + x, y, o.oz + z, sx, sy, sz, ry, shadow);
  };
  const planks = Math.round(len / 1.3);
  for (let i = 0; i < planks; i++) {
    const x = -len / 2 + (i + 0.5) * (len / planks);
    put(M.dark, x, deckY, 0, len / planks + 0.12, 0.25, 2.4);
    if (i % 2 === 0)
      for (const s of [-1, 1])
        put(M.rock, x, deckY - 1.6, s * 1.05, 0.35, 3.4, 0.35); // pilings
  }
  for (const s of [-1, 1]) {
    const ex = len / 2 - 0.4;
    put(M.dark, ex, deckY + 0.8, s * 1.05, 0.28, 1.6, 0.28);
    put(M.amber, ex, deckY + 1.85, s * 1.05, 0.42, 0.42, 0.42, 0, false);
  }
  return { r: len / 2 + 1, h: deckY + 2.2 - o.oy };
}

/** Cave crystal formation: hero-scale teal octahedron cluster. */
export function emitCrystalFormation(inst: Instancer, rng: Rng, M: SetMats, o: Origin, shadows = true): SetDims {
  {
    const [px, py, pz] = at(o, 0, 0.25, 0);
    inst.box(M.dark, px, py, pz, 5.5, 0.7, 5.5, rng.range(0, Math.PI), true); // base mound
  }
  const n = rng.int(5, 9);
  let maxH = 0;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0, 2.2);
    const sxz = rng.range(0.45, 1.1);
    const sy = rng.range(1.6, 4.2);
    const [px, py, pz] = at(o, Math.cos(a) * d, 0.3 + sy * 0.55, Math.sin(a) * d);
    inst.octa(M.teal, px, py, pz, sxz, sy, sxz, rng.range(0, Math.PI), false);
    maxH = Math.max(maxH, 0.3 + sy * 1.1);
  }
  return { r: 4, h: maxH };
}

type Emitter = (inst: Instancer, rng: Rng, M: SetMats, o: Origin, waterY: number, shadows: boolean) => SetDims;
const EMITTERS: Record<StructureSetKind, Emitter> = {
  'canyon-ruins': (inst, rng, M, o, _w, s) => emitCanyonRuins(inst, rng, M, o, s),
  'watchtower': (inst, rng, M, o, _w, s) => emitWatchtower(inst, rng, M, o, s),
  'shrine': (inst, rng, M, o, _w, s) => emitShrine(inst, rng, M, o, s),
  'obsidian-spire': (inst, rng, M, o, _w, s) => emitObsidianSpire(inst, rng, M, o, s),
  'lighthouse': (inst, rng, M, o, _w, s) => emitLighthouse(inst, rng, M, o, s),
  'dock': (inst, rng, M, o, waterY, s) => emitDock(inst, rng, M, o, waterY, s),
  'crystal-formation': (inst, rng, M, o, _w, s) => emitCrystalFormation(inst, rng, M, o, s),
};

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface StructureSetOpts {
  mats: MaterialLibrary;
  biome: BiomeDef;
  /** terrain height sampler */
  heightAt: (x: number, z: number) => number;
  /** the map's derived build seed (spec.meta.seed — per-map via MapGraph) */
  mapSeed: number;
  quality?: 'retro' | 'standard' | 'high';
  /**
   * Graphics wave 2 (E): tier density multiplier. Multiplies the quality-scaled
   * satellite density (s25: retro × 1.0 = C's measured behavior; desktop:
   * high × 1.5 = denser). Does not affect draw calls (bucket count constant).
   */
  densityMul?: number;
  /**
   * Graphics wave 2 (E): whether the rock/dark buckets cast shadows.
   * s25 sets false to save 2 shadow-pass draws (diet for C's +5).
   * Defaults true (C's measured behavior).
   */
  structureShadows?: boolean;
  /** world half-extent for satellite scatter (default 90) */
  half?: number;
  /** chunk grid for satellite placement (default: single chunk) */
  grid?: ChunkGrid;
  /** exclusion zones (spawn, track, …) */
  exclusion?: Array<{ x: number; z: number; r: number }>;
  /** water level — docks reach for it; undefined = no docks */
  waterLevel?: number;
  /** optional static-collider sink (Structures passes a physics.box wrapper) */
  addCollider?: (size: [number, number, number], pos: [number, number, number]) => void;
}

export interface PlacedStructure {
  kind: StructureSetKind;
  pos: THREE.Vector3;
  radius: number;
  chunk: string;
}

export interface StructureSetResult {
  group: THREE.Group;
  placed: PlacedStructure[];
  /** satellite clusters (excludes the hero cluster) */
  clusters: number;
  /** amber instances registered (rune rings, lamps, beacons — one bucket) */
  amberAccents: number;
  /** InstancedMeshes baked into the group (one per material bucket) */
  instancedMeshes: number;
  /**
   * Per-chunk static colliders, keyed by chunkKey(cx, cz). Placement is
   * chunk-deterministic so workstream E (or later) can stream these through
   * the ChunkStream lifecycle; the boot path applies them all as statics
   * (same pattern as the landmark colliders).
   */
  collidersByChunk: Map<string, Array<{ size: [number, number, number]; pos: [number, number, number] }>>;
}

/**
 * Amber rune ring at a cluster heart — the landmark rune-ring language,
 * emitted into the shared set bucket (one draw call for every ring).
 */
function addSetRuneRing(inst: Instancer, rng: Rng, M: SetMats, o: Origin, radius: number): number {
  const n = rng.int(4, 6);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const r = radius + rng.range(0.6, 1.4);
    const [px, py, pz] = at(o, Math.cos(a) * r, 0.16, Math.sin(a) * r);
    inst.box(M.amber, px, py, pz, 1.5, 0.28, 0.5, -a + Math.PI / 2, false);
    count++;
  }
  return count;
}

export function placeStructureSets(scene: THREE.Scene, rng: Rng, opts: StructureSetOpts): StructureSetResult {
  const group = new THREE.Group();
  const placed: PlacedStructure[] = [];
  const collidersByChunk = new Map<string, Array<{ size: [number, number, number]; pos: [number, number, number] }>>();
  const quality = opts.quality ?? 'standard';
  const qMul = qualityScale(quality) * (opts.densityMul ?? 1);
  const half = Math.max(10, opts.half ?? 90);
  const grid: ChunkGrid = opts.grid ?? {
    chunksPerSide: 1, cellsPerChunk: 1, chunkSize: half * 2,
    cell: half * 2, half, res: 2,
  };
  const M = setMats(opts.mats, opts.biome);
  const sets = BIOME_SETS[opts.biome.id] ?? ['watchtower'];
  const waterY = opts.waterLevel;
  const hasWater = Number.isFinite(waterY);
  const inst = new Instancer();
  let amberAccents = 0;
  let clusters = 0;

  const excluded = (x: number, z: number, r: number) =>
    (opts.exclusion ?? []).some((e) => (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + r) ** 2);

  const recordCollider = (chunk: string, x: number, yBase: number, z: number, dims: SetDims) => {
    const col = {
      size: [dims.r * 1.6, dims.h, dims.r * 1.6] as [number, number, number],
      pos: [x, yBase + dims.h / 2, z] as [number, number, number],
    };
    const list = collidersByChunk.get(chunk);
    if (list) list.push(col); else collidersByChunk.set(chunk, [col]);
    opts.addCollider?.(col.size, col.pos);
  };

  /** Emit one structure at world (x, z); groundY anchors the local frame. */
  const emitAt = (kind: StructureSetKind, srng: Rng, x: number, z: number, groundY: number): SetDims | null => {
    // Graphics wave 2 (E): s25 disables structure shadow-casting (diet for C's +5).
    const dims = EMITTERS[kind](inst, srng, M, { ox: x, oy: groundY, oz: z }, hasWater ? waterY! : groundY, opts.structureShadows ?? true);
    const { cx, cz } = worldToChunk(x, z, grid);
    placed.push({ kind, pos: new THREE.Vector3(x, groundY, z), radius: dims.r, chunk: chunkKey(cx, cz) });
    recordCollider(chunkKey(cx, cz), x, groundY, z, dims);
    return dims;
  };

  // --- hero cluster: 3 structures in a triangle 30–55m from spawn — the
  // arrival vignette and the composition anchor on the spawn sightline.
  // Seeded from the map seed; placed on every tier. Up to 8 candidate
  // (angle, dist) rolls so an unlucky seed can't lose the cluster to an
  // exclusion zone.
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const heroA = rng.range(0, Math.PI * 2);
      const heroD = rng.range(30, 55);
      const hx = Math.cos(heroA) * heroD, hz = Math.sin(heroA) * heroD;
      if (excluded(hx, hz, 12)) continue;
      const hy = opts.heightAt(hx, hz);
      if (!Number.isFinite(hy)) continue;
      const heroKinds: StructureSetKind[] = sets.length > 1 && hasWater
        ? [sets[0], 'dock', sets[0]]
        : [sets[0], sets[0], sets[0]];
      let hi = 0, emitted = 0;
      for (const [ox, oz] of [[0, 0], [11, 4], [-6, 10]] as const) {
        const kind = heroKinds[hi++ % heroKinds.length];
        const x = hx + ox, z = hz + oz;
        const r = kind === 'dock' ? 8 : 5;
        if (excluded(x, z, r)) continue;
        const gy = opts.heightAt(x, z);
        if (!Number.isFinite(gy)) continue;
        if (kind === 'dock') {
          // hero dock needs its feet near the water
          let shore = false;
          for (let s = 0; s < 6; s++) {
            const ph = opts.heightAt(x + rng.range(-10, 10), z + rng.range(-10, 10));
            if (Number.isFinite(ph) && ph < waterY! + 1.5) { shore = true; break; }
          }
          if (!shore) continue;
          emitAt(kind, rng, x, z, waterY! - 1.1);
        } else {
          emitAt(kind, rng, x, z, gy);
        }
        emitted++;
      }
      if (emitted > 0) {
        amberAccents += addSetRuneRing(inst, rng, M, { ox: hx, oy: hy, oz: hz }, 9);
        break;
      }
    }
  } catch {
    // a failed hero cluster never takes the world down
  }

  // --- satellite clusters: one chunk-deterministic roll per chunk. Each
  // chunk's structures derive ONLY from chunkSeed(mapSeed, salt, cx, cz), so
  // the placement survives any load order / streaming adoption.
  try {
    const cps = grid.chunksPerSide;
    for (let cx = 0; cx < cps; cx++) {
      for (let cz = 0; cz < cps; cz++) {
        const crng = new Rng(chunkSeed(opts.mapSeed, STRUCTURE_CHUNK_SALT, cx, cz));
        if (!crng.chance(CLUSTER_DENSITY * qMul)) continue;
        const rect = chunkWorldRect(cx, cz, grid);
        const n = crng.int(1, 3);
        let placedHere = 0;
        let ringX = 0, ringZ = 0;
        for (let i = 0; i < n; i++) {
          let kind: StructureSetKind = crng.pick(sets);
          const x = rect.x0 + crng.range(0.2, 0.8) * (rect.x1 - rect.x0);
          const z = rect.z0 + crng.range(0.2, 0.8) * (rect.z1 - rect.z0);
          if (Math.abs(x) > half || Math.abs(z) > half) continue;
          if (kind === 'dock') {
            if (!hasWater) { kind = 'lighthouse'; }
            else {
              let shore = false;
              for (let s = 0; s < 6; s++) {
                const px = x + crng.range(-10, 10), pz = z + crng.range(-10, 10);
                const ph = opts.heightAt(px, pz);
                if (Number.isFinite(ph) && ph < waterY! + 1.5) { shore = true; break; }
              }
              if (!shore) kind = 'lighthouse';
            }
          }
          const r = kind === 'dock' ? 8 : 5;
          if (excluded(x, z, r)) continue;
          const gy = opts.heightAt(x, z);
          if (!Number.isFinite(gy)) continue;
          emitAt(kind, crng, x, z, kind === 'dock' ? waterY! - 1.1 : gy);
          ringX += x; ringZ += z;
          placedHere++;
        }
        if (placedHere > 0) {
          clusters++;
          const ccx = ringX / placedHere, ccz = ringZ / placedHere;
          const cy = opts.heightAt(ccx, ccz);
          if (Number.isFinite(cy)) amberAccents += addSetRuneRing(inst, crng, M, { ox: ccx, oy: cy, oz: ccz }, 7);
        }
      }
    }
  } catch {
    // satellite failures degrade to the hero cluster only
  }

  const baked = inst.bake(group);
  scene.add(group);
  return { group, placed, clusters, amberAccents, instancedMeshes: baked.length, collidersByChunk };
}
