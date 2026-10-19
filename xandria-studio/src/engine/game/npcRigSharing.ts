/**
 * NPC rig geometry/material sharing (gameplay wave, workstream B).
 *
 * Workstream A measured 46-52 meshes per NPC with ZERO sharing: every
 * villager allocated its own copy of every body-part geometry and its own
 * clone of every palette material (~400 draw calls AND ~400 unique
 * geometries + ~70 unique materials for an 8-NPC roster — the GPU resource
 * cost was the unacceptable part; draw calls stay one-per-mesh since there
 * is no instancing here).
 *
 * This module implements the HARD REQUIREMENT: a shared cache keyed by
 * (armorSet, palette variant) so identical body parts share geometries AND
 * materials across NPC instances. It is a cache layer the Npc class uses —
 * A's public API (constructor/update/dispose/interactable/spawnNpcsForMap)
 * is untouched.
 *
 * How it works:
 *  1. The rig seed handed to makeHumanoid derives from a "look key":
 *     (armorSet, quantized bulk) — NOT the per-NPC behavior seed. The
 *     ModelForge body plan, faceted primitives, armor fits and the amber
 *     clasp are all pure functions of that seed, so same-look NPCs build
 *     bit-identical geometry. Palette COLORS still vary per NPC (they are
 *     materials, not geometry). 3 armor sets x 4 bulk buckets = 12 body
 *     variants; color/armor/visor variety carries the per-NPC identity.
 *     The NPC's physics capsule uses the same quantized bulk, so body and
 *     rig agree exactly.
 *  2. After the rig is built, share() walks its meshes: every geometry is
 *     hashed (positions+normals+uv+index — bit-identical across same-look
 *     builds, and content-identical parts like the amber clasp hash equal
 *     across ALL looks) and every per-instance OWNED material is keyed by
 *     (color, roughness, metalness, emissive, side, opacity). The first NPC
 *     to produce a signature becomes canonical; later NPCs adopt the
 *     canonical objects and their duplicates are disposed immediately.
 *     Library-cached (non-owned) materials are already shared and left alone.
 *  3. Ownership: the cache lives per-Engine (WeakMap — no Engine.ts change)
 *     and is manager-disposed on NpcManager.despawnAll(). Entries are
 *     ref-counted per adopted signature: Npc.dispose() releases its
 *     signatures, and an entry whose refcount hits zero disposes its
 *     canonical GPU resource at once — so a standalone Npc (no manager,
 *     e.g. unit tests) still leaves zero GPU payloads behind.
 *
 * Safety notes:
 *  - NPC rigs never call flash() (no combat), so sharing the emissive-
 *    mutable owned materials across instances is safe. If a future wave
 *    gives NPCs damage flashes, this cache must be revisited (per-instance
 *    material clones again, or a flash that swaps to a shared overlay).
 *  - ENEMIES WAVE C: enemies DO flash, so they share geometry only
 *    (share(root, { geometriesOnly: true })) — materials stay per-instance
 *    and the instancer renders the hit pulse as a per-instance tint.
 *    Never pass shared (non-geometriesOnly) enemy materials anywhere
 *    flash() can reach them.
 *  - share() never throws: on any failure it returns null and the caller
 *    falls back to the old per-instance disposeOwned path.
 *  - Per-instance Object3D trees are NOT shared (limb pivots animate
 *    independently) — only the GPU resources underneath them.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';

/**
 * Visual-identity bucket for rig GEOMETRY: the armor set alone. Colors are
 * materials (shared globally by content signature), and bulk is applied as
 * a uniform group scale — so one canonical body geometry per armor set
 * serves the whole roster, while per-NPC identity rides on palette
 * materials + continuous bulk scaling. 3 canonical variants, always.
 */
export interface NpcLookKey {
  armorSet: string;
}

export function npcLookKey(armorSet: string): NpcLookKey {
  return { armorSet };
}

export function npcLookKeyString(k: NpcLookKey): string {
  return k.armorSet;
}

/** FNV-1a 32-bit — deterministic rig seed from the look key. */
export function npcLookSeed(k: NpcLookKey): number {
  const s = npcLookKeyString(k);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Signatures this NPC adopted from the cache (released on dispose). */
export interface NpcAdopted {
  geos: string[];
  mats: string[];
}

function hashFloats(h: number, arr: ArrayLike<number>): number {
  // Quantize to 1e-4: absorbs any -0/epsilon noise while keeping distinct
  // part dimensions distinct (voxel parts differ by >> 1e-4).
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    const q = v === 0 ? 0 : Math.round(v * 1e4);
    h ^= q & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Geometry identity: positions + normals + uv + index + counts. */
function geometrySignature(g: THREE.BufferGeometry): string {
  let h = 0x811c9dc5;
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  h = hashFloats(h, pos ? (pos.array as ArrayLike<number>) : []);
  h = hashFloats(h, nor ? (nor.array as ArrayLike<number>) : []);
  h = hashFloats(h, uv ? (uv.array as ArrayLike<number>) : []);
  const idx = g.getIndex();
  if (idx) h = hashFloats(h, idx.array as ArrayLike<number>);
  h ^= pos?.count ?? 0; h = Math.imul(h, 0x01000193);
  h ^= idx?.count ?? 0; h = Math.imul(h, 0x01000193);
  return `g${(h >>> 0).toString(16)}`;
}

/** Owned-material identity: every param the builders vary. */
function materialSignature(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  const c = s.color ? s.color.getHexString() : '?';
  const e = s.emissive ? s.emissive.getHexString() : '000000';
  return `m${m.type}|${c}|${s.roughness ?? '?'}|${s.metalness ?? '?'}|` +
    `${e}|${s.emissiveIntensity ?? '?'}|${m.side}|${m.transparent ? s.opacity : ''}`;
}

interface CacheEntry<T> { obj: T; refs: number; }

export class NpcRigCache {
  private static readonly perEngine = new WeakMap<Engine, NpcRigCache>();

  /** Per-engine singleton — no Engine.ts change needed. */
  static for(engine: Engine): NpcRigCache {
    let c = NpcRigCache.perEngine.get(engine);
    if (!c) {
      c = new NpcRigCache();
      NpcRigCache.perEngine.set(engine, c);
    }
    return c;
  }

  private readonly geos = new Map<string, CacheEntry<THREE.BufferGeometry>>();
  private readonly mats = new Map<string, CacheEntry<THREE.Material>>();

  /**
   * Share a freshly built rig's GPU resources against the canonical cache.
   *
   * Enemies wave C: `opts.geometriesOnly` shares GEOMETRY only and leaves
   * materials per-instance. Enemies mutate owned materials on damage
   * (rig.flash() on the direct-render path) — sharing those across
   * instances would cross-flash the whole roster, violating the
   * shared-materials-are-never-mutated invariant. Geometry is the expensive
   * part (the 5.6x win); the instancer canonicalizes materials per role
   * anyway, so the instanced path loses nothing.
   *
   * @returns the adopted signatures (pass to release() on dispose), or null
   * on any failure (caller keeps the old per-instance disposeOwned path).
   */
  share(root: THREE.Object3D, opts?: { geometriesOnly?: boolean }): NpcAdopted | null {
    try {
      const geoOnly = opts?.geometriesOnly ?? false;
      const adopted: NpcAdopted = { geos: [], mats: [] };
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // --- geometry: content-keyed, shared across ALL looks
        const gs = geometrySignature(mesh.geometry);
        const gHit = this.geos.get(gs);
        if (gHit && gHit.obj !== mesh.geometry) {
          mesh.geometry.dispose(); // drop this build's duplicate
          mesh.geometry = gHit.obj;
          gHit.refs++;
        } else if (!gHit) {
          this.geos.set(gs, { obj: mesh.geometry, refs: 1 });
        } else {
          gHit.refs++; // same object on two meshes of one rig
        }
        adopted.geos.push(gs);
        if (geoOnly) return; // materials stay per-instance (enemy flash safety)
        // --- materials: only per-instance OWNED clones; library-cached
        // --- shared materials are already shared and stay as-is
        const mlist = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const out = mlist.map((mm) => {
          const mat = mm as THREE.Material | undefined;
          if (!mat || !mat.userData.owned) return mm;
          const ms = materialSignature(mat);
          const mHit = this.mats.get(ms);
          if (mHit && mHit.obj !== mat) {
            mat.dispose(); // drop this build's duplicate wrapper
            mHit.refs++;
            return mHit.obj;
          }
          if (mHit) mHit.refs++; // same object on two meshes of one rig
          else this.mats.set(ms, { obj: mat, refs: 1 });
          return mm;
        });
        for (const mm of out) {
          const mat = mm as THREE.Material | undefined;
          if (mat?.userData.owned) adopted.mats.push(materialSignature(mat));
        }
        if (out.some((m, i) => m !== mlist[i])) {
          mesh.material = Array.isArray(mesh.material) ? (out as THREE.Material[]) : out[0] as THREE.Material;
        }
      });
      return adopted;
    } catch {
      return null;
    }
  }

  /** Release one NPC's adopted signatures; zero-ref entries dispose at once. */
  release(adopted: NpcAdopted): void {
    for (const sig of adopted.geos) {
      const e = this.geos.get(sig);
      if (!e) continue;
      e.refs--;
      if (e.refs <= 0) {
        try { e.obj.dispose(); } catch { /* noop */ }
        this.geos.delete(sig);
      }
    }
    for (const sig of adopted.mats) {
      const e = this.mats.get(sig);
      if (!e) continue;
      e.refs--;
      if (e.refs <= 0) {
        try { e.obj.dispose(); } catch { /* noop */ }
        this.mats.delete(sig);
      }
    }
  }

  /** Manager path: drop every canonical resource (despawnAll zero-leak). */
  clear(): void {
    for (const e of this.geos.values()) { try { e.obj.dispose(); } catch { /* noop */ } }
    for (const e of this.mats.values()) { try { e.obj.dispose(); } catch { /* noop */ } }
    this.geos.clear();
    this.mats.clear();
  }

  /** Diagnostics for the perf report: canonical resource census. */
  stats(): { geometries: number; materials: number; geoRefs: number; matRefs: number } {
    let geoRefs = 0, matRefs = 0;
    for (const e of this.geos.values()) geoRefs += e.refs;
    for (const e of this.mats.values()) matRefs += e.refs;
    return { geometries: this.geos.size, materials: this.mats.size, geoRefs, matRefs };
  }
}
