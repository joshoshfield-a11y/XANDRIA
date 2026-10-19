/**
 * Crafting wave (workstream C): shared voxel construction kit for the
 * crafting layer (gathering nodes + crafting stations).
 *
 * Two extractions from workstream B's gathering.ts, unchanged in behavior:
 *
 * 1. `voxelBoxCacheFor(engine)` — the per-engine quantized BoxGeometry
 *    cache (was NodeGeoCache, module-private in gathering.ts). Nodes and
 *    stations draw from the SAME cache: identical dims return the
 *    identical BufferGeometry object, so identically-sized parts collapse
 *    into the SAME instancer bucket (NpcInstancer keys buckets by
 *    geometry.uuid). Separate caches would silently double the bucket
 *    count for parts that look identical.
 * 2. `paletteFor(env)` — the per-biome palette table, so stations use the
 *    same wood/stone/metal colors as the nodes around them.
 * 3. `voxelPart(...)` — the deterministic voxel-part builder (was part()
 *    in gathering.ts): shared flat materials via engine.mats, the
 *    existing amber-clasp emissive role for glow accents (NO new emissive
 *    roles — the enemies-wave-C rule), deterministic position/rotation
 *    jitter from the caller's seeded rng (instance matrices carry the
 *    variety, never unique geometry).
 *
 * Determinism: no Math.random / Date.now anywhere; the caller supplies
 * the seeded Rng.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Environment } from '@spec';
import type { Rng } from '../core/Rng';
import { amberGlowMaterial } from '../gfx/AmberGlow';

// ---------------------------------------------------------------------------
// Geometry cache: quantized dims shared per engine (bucket collapse)
// ---------------------------------------------------------------------------

/** Per-engine cache of shared BoxGeometries keyed by quantized dims. */
export class VoxelGeoCache {
  private static readonly perEngine = new WeakMap<Engine, VoxelGeoCache>();

  static for(engine: Engine): VoxelGeoCache {
    let c = VoxelGeoCache.perEngine.get(engine);
    if (!c) {
      c = new VoxelGeoCache();
      VoxelGeoCache.perEngine.set(engine, c);
    }
    return c;
  }

  private readonly boxes = new Map<string, THREE.BoxGeometry>();

  /** Shared box — identical dims return the identical geometry (one instancer bucket). */
  box(w: number, h: number, d: number): THREE.BoxGeometry {
    const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
    let g = this.boxes.get(key);
    if (!g) {
      g = new THREE.BoxGeometry(w, h, d);
      this.boxes.set(key, g);
    }
    return g;
  }
}

/** Convenience accessor (mirrors the old NodeGeoCache.for call sites). */
export function voxelBoxCacheFor(engine: Engine): VoxelGeoCache {
  return VoxelGeoCache.for(engine);
}

// ---------------------------------------------------------------------------
// Per-biome palettes (moved verbatim from gathering.ts)
// ---------------------------------------------------------------------------

export interface VoxelPalette {
  rock: string;
  rockDark: string;
  stem: string;
  leaf: string;
  wood: string;
  woodDark: string;
  metal: string;
}

export function paletteFor(env: Environment): VoxelPalette {
  switch (env) {
    case 'desert':
    case 'wasteland':
      return { rock: '#b59a6b', rockDark: '#8a734f', stem: '#a3905c', leaf: '#c7ab63', wood: '#8a6d48', woodDark: '#6b5336', metal: '#9a8f7d' };
    case 'arctic':
      return { rock: '#aeb9c6', rockDark: '#7e8a99', stem: '#7c8ea3', leaf: '#d3e2ec', wood: '#6e7d8d', woodDark: '#55606e', metal: '#a9b4c0' };
    case 'volcanic':
      return { rock: '#3d3632', rockDark: '#2a2421', stem: '#5e2f1c', leaf: '#8a441f', wood: '#4c423a', woodDark: '#38312b', metal: '#6e625a' };
    case 'city':
    case 'neon-city':
      return { rock: '#5c6068', rockDark: '#41444a', stem: '#3c4a3c', leaf: '#4e6b4a', wood: '#4e5860', woodDark: '#3a4249', metal: '#a2aab4' };
    case 'ruins':
      return { rock: '#7c766a', rockDark: '#57524a', stem: '#4c7040', leaf: '#6b9a58', wood: '#6e5c46', woodDark: '#534636', metal: '#8d867a' };
    case 'dreamscape':
      return { rock: '#6e5c8e', rockDark: '#4e4066', stem: '#7e5eaa', leaf: '#a07ed4', wood: '#5c4a6e', woodDark: '#463a54', metal: '#9a8ab4' };
    case 'islands':
      return { rock: '#c6b69c', rockDark: '#96876e', stem: '#4c8a5c', leaf: '#6db47e', wood: '#8a7a5c', woodDark: '#6b5e46', metal: '#a39a86' };
    case 'arena':
      return { rock: '#6e6e6e', rockDark: '#4c4c4c', stem: '#5c6e3c', leaf: '#7a8e4e', wood: '#7a5c3a', woodDark: '#5c4630', metal: '#8e8e8e' };
    case 'space-station':
      return { rock: '#4e525a', rockDark: '#363a40', stem: '#3c4a52', leaf: '#4e6b78', wood: '#5c6670', woodDark: '#464e56', metal: '#b0b8c2' };
    case 'forest':
    case 'jungle':
    default:
      return { rock: '#6e7268', rockDark: '#4a4d44', stem: '#3e7a34', leaf: '#5da34a', wood: '#7d5f3d', woodDark: '#5f4630', metal: '#8b9096' };
  }
}

// ---------------------------------------------------------------------------
// Voxel part builder (moved verbatim from gathering.ts's part())
// ---------------------------------------------------------------------------

export interface VoxelPartOpts {
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  shadow?: boolean;
  /**
   * Use the EXISTING amber-clasp emissive role (#ffb545 @ 2.0) for the
   * signature glow accent — shared bucket, no new emissive role
   * (enemies wave C: new roles only for genuinely new colors).
   */
  amber?: boolean;
}

export interface VoxelBuildCtx {
  engine: Engine;
  geo: VoxelGeoCache;
  rng: Rng;
}

export function voxelPart(
  ctx: VoxelBuildCtx,
  g: THREE.Group,
  w: number,
  h: number,
  d: number,
  hex: string,
  roughness: number,
  x: number,
  y: number,
  z: number,
  opts: VoxelPartOpts = {},
): THREE.Mesh {
  const mat = opts.amber
    ? amberGlowMaterial(ctx.engine.mats, 2.0)
    : ctx.engine.mats.flat(hex, { roughness });
  const m = new THREE.Mesh(ctx.geo.box(w, h, d), mat);
  // deterministic jitter: per-instance variety rides on instance matrices,
  // never on unique geometry (bucket collapse preserved)
  const j = () => (ctx.rng.next() - 0.5);
  m.position.set(x + j() * 0.06, y + j() * 0.04, z + j() * 0.06);
  m.rotation.set((opts.rotX ?? 0) + j() * 0.14, (opts.rotY ?? 0) + j() * 0.5, (opts.rotZ ?? 0) + j() * 0.14);
  m.castShadow = opts.shadow ?? !opts.amber;
  m.receiveShadow = true;
  g.add(m);
  return m;
}
