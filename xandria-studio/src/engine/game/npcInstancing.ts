/**
 * NPC instanced rendering (gameplay wave, instancing pass).
 *
 * Problem: each NPC renders ~46 individual meshes (x2 with the shadow
 * pass ≈ 90-95 draw calls). Geometry/material sharing (npcRigSharing)
 * cut GPU memory 5.6x but left draw calls untouched — limbs animate
 * independently, so every mesh stayed its own draw.
 *
 * Fix: one THREE.InstancedMesh per (geometry, material-role, castShadow)
 * bucket across ALL live NPCs. Per frame the manager submits each NPC:
 * the rig's Object3D tree still animates exactly as before (behavior,
 * animate(), syncRigTransform untouched), then each mesh's fresh
 * matrixWorld is copied into its bucket's instance buffer. The original
 * meshes are hidden (visible=false) — they never draw, they only carry
 * transforms.
 *
 * Material roles: the census found 13 distinct shader-param combos
 * (roughness/metalness/emissive/side). Each role gets ONE canonical
 * MeshStandardMaterial per engine (WeakMap — no Engine.ts change):
 *  - non-emissive roles: white diffuse + per-instance color (the NPC's
 *    actual palette color rides instanceColor — pixel-identical output).
 *  - emissive roles (visor slits, amber clasp, eye glow): color+emissive
 *    baked per role (instanceColor can't tint emissive); one bucket per
 *    emissive color — 3-4 visor variants, still tiny.
 * Shared materials are never mutated per-instance (no damage-flash on
 * NPCs — that invariant from npcRigSharing still holds).
 *
 * What this does NOT change: Npc's public contract, behavior determinism
 * (rendering never feeds the sim), portal despawn/respawn, interaction
 * registry, dialogue, Studio density, S25 scaling. Standalone NPCs (unit
 * tests, spawnNpcsForMap without a manager) keep the old direct-render
 * path — instancing only engages for registered NPCs.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Npc } from './Npc';

const BLACK = new THREE.Color(0x000000);
const WHITE = new THREE.Color(0xffffff);

interface PartRef {
  mesh: THREE.Mesh;
  bucket: Bucket;
  /** diffuse tint for non-emissive roles; null for emissive roles */
  color: THREE.Color | null;
}

interface Bucket {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
  mesh: THREE.InstancedMesh | null;
  parts: PartRef[];
  count: number;
}

/**
 * Canonical material role: every shader param the builders vary, minus
 * the diffuse color (which rides per-instance). Emissive color+intensity
 * stay in the key because instanceColor can't tint emissive.
 */
function roleOf(m: THREE.Material): { key: string; emissive: boolean } {
  const s = m as THREE.MeshStandardMaterial;
  const hasEm = !!s.emissive && s.emissiveIntensity > 0 && !s.emissive.equals(BLACK);
  const emPart = hasEm ? `e${s.emissive.getHexString()}:${s.emissiveIntensity}` : 'e-';
  const key =
    `${m.type}|${emPart}|r${s.roughness}|m${s.metalness}|` +
    `s${m.side}|t${s.transparent ? 1 : 0}|o${s.opacity}`;
  return { key, emissive: hasEm };
}

/** One canonical material per role: white diffuse for tinting, or the baked emissive. */
function makeCanonical(src: THREE.Material, emissive: boolean): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  const c = new THREE.MeshStandardMaterial({
    color: emissive ? s.color.clone() : WHITE.clone(),
    roughness: s.roughness,
    metalness: s.metalness,
    side: s.side,
    transparent: s.transparent,
    opacity: s.opacity,
  });
  if (emissive) {
    c.emissive = s.emissive.clone();
    c.emissiveIntensity = s.emissiveIntensity;
  }
  c.userData.npcInstancingCanonical = true;
  return c;
}

export class NpcInstancer {
  private static readonly perEngine = new WeakMap<Engine, NpcInstancer>();

  /** Per-engine singleton — no Engine.ts change needed. */
  static for(engine: Engine): NpcInstancer {
    let inst = NpcInstancer.perEngine.get(engine);
    if (!inst) {
      inst = new NpcInstancer(engine);
      NpcInstancer.perEngine.set(engine, inst);
    }
    return inst;
  }

  private readonly buckets = new Map<string, Bucket>();
  private readonly npcParts = new Map<Npc, PartRef[]>();
  private readonly canonicalMats = new Map<string, THREE.Material>();

  private constructor(private readonly engine: Engine) {}

  /** Live bucket count (diagnostics: ≈ draw calls for the NPC layer). */
  get bucketCount(): number {
    return this.buckets.size;
  }

  get registeredNpcCount(): number {
    return this.npcParts.size;
  }

  /**
   * Register an NPC's rig for instanced rendering. Hides the source
   * meshes (they keep animating as transform carriers) and assigns each
   * to its bucket. Idempotent per NPC.
   */
  register(npc: Npc): void {
    if (this.npcParts.has(npc) || !npc.rig) return;
    const parts: PartRef[] = [];
    npc.rig.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const src = mesh.material as THREE.Material;
      const { key: rkey, emissive } = roleOf(src);
      const bkey =
        `${(mesh.geometry as THREE.BufferGeometry).uuid}|${rkey}|${mesh.castShadow ? 1 : 0}`;
      let bucket = this.buckets.get(bkey);
      if (!bucket) {
        let canonical = this.canonicalMats.get(rkey);
        if (!canonical) {
          canonical = makeCanonical(src, emissive);
          this.canonicalMats.set(rkey, canonical);
        }
        bucket = {
          geometry: mesh.geometry as THREE.BufferGeometry,
          material: canonical,
          castShadow: mesh.castShadow,
          mesh: null,
          parts: [],
          count: 0,
        };
        this.buckets.set(bkey, bucket);
      }
      const color = emissive ? null : (src as THREE.MeshStandardMaterial).color.clone();
      const part: PartRef = { mesh, bucket, color };
      bucket.parts.push(part);
      parts.push(part);
      mesh.visible = false;
    });
    this.npcParts.set(npc, parts);
    for (const bucket of this.buckets.values()) this.ensureCapacity(bucket);
  }

  /** Zero per-frame instance counts (call before submitting the frame's NPCs). */
  beginFrame(): void {
    for (const b of this.buckets.values()) b.count = 0;
  }

  /**
   * Write one NPC's current pose into the instance buffers. The rig must
   * already be posed (Npc.update does behavior + animate + syncRigTransform);
   * this refreshes matrixWorld and copies each mesh's world matrix (+ tint).
   * Static NPCs (never ticked) need exactly one submit — instances persist.
   */
  submit(npc: Npc): void {
    const parts = this.npcParts.get(npc);
    if (!parts || !npc.rig) return;
    npc.rig.group.updateMatrixWorld(true);
    for (const p of parts) {
      const b = p.bucket;
      const mesh = b.mesh;
      if (!mesh) continue;
      const i = b.count++;
      // Capacity is guaranteed at register time; guard anyway (never grow
      // mid-frame — a missed instance beats a corrupt buffer).
      if (i >= mesh.instanceMatrix.count) { b.count--; continue; }
      mesh.setMatrixAt(i, p.mesh.matrixWorld);
      if (p.color) mesh.setColorAt(i, p.color);
    }
  }

  /** Publish per-frame counts to the GPU (call after submitting the frame's NPCs). */
  endFrame(): void {
    for (const b of this.buckets.values()) {
      const mesh = b.mesh;
      if (!mesh) continue;
      mesh.count = b.count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Drop every bucket (InstancedMeshes out of the scene, source meshes
   * re-shown). Geometries/materials are cache-owned (npcRigSharing) and
   * untouched — the manager clears that cache separately. Canonical
   * materials persist per-engine (roles are stable across spawn cycles).
   */
  reset(): void {
    for (const b of this.buckets.values()) {
      if (b.mesh) {
        this.engine.scene.remove(b.mesh);
        b.mesh.dispose();
        b.mesh = null;
      }
      for (const p of b.parts) p.mesh.visible = true;
    }
    this.buckets.clear();
    this.npcParts.clear();
  }

  /** Diagnostics: per-bucket instance totals (== instances submitted last frame). */
  stats(): { buckets: number; instances: number; perBucket: number[] } {
    const perBucket: number[] = [];
    let instances = 0;
    for (const b of this.buckets.values()) {
      perBucket.push(b.count);
      instances += b.count;
    }
    perBucket.sort((a, b) => a - b);
    return { buckets: this.buckets.size, instances, perBucket };
  }

  private ensureCapacity(bucket: Bucket): void {
    const need = bucket.parts.length;
    const cap = bucket.mesh ? bucket.mesh.instanceMatrix.count : 0;
    if (need <= cap) return;
    const next = Math.max(need, cap > 0 ? cap * 2 : 8);
    if (bucket.mesh) {
      this.engine.scene.remove(bucket.mesh);
      bucket.mesh.dispose();
    }
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, next);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = bucket.castShadow;
    mesh.frustumCulled = false; // one bounds can't cover a roaming roster
    this.engine.scene.add(mesh);
    bucket.mesh = mesh;
  }
}
