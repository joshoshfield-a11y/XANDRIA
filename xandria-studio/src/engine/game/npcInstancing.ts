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
 *
 * Enemies wave C: enemies register through the same pipeline
 * (EnemyManager owns the same per-engine instancer; see registerEnemy).
 * Damage-flash is solved without mutating shared materials: flash(entity)
 * writes a 0.25s white-hot tint pulse via instanceColor on non-emissive
 * roles only — the old rig.flash() 20Hz blink pattern, per-instance.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Npc } from './Npc';

const BLACK = new THREE.Color(0x000000);
const WHITE = new THREE.Color(0xffffff);

/**
 * Damage-flash pulse length (seconds) — matches the rig.flash() contract
 * (0.25s) so instanced and direct-rendered hit feedback read identically.
 */
const FLASH_DURATION = 0.25;
/** White-hot tint target for the per-instance flash pulse. */
const FLASH_TINT = new THREE.Color(0xffffff);
const _flashColor = new THREE.Color();

interface PartRef {
  mesh: THREE.Mesh;
  bucket: Bucket;
  /** diffuse tint for non-emissive roles; null for emissive roles */
  color: THREE.Color | null;
}

interface Bucket {
  key: string;
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
  /**
   * Registered entities: NPCs (NpcManager) and enemies (EnemyManager).
   * The owner key is the Npc/Enemy object itself; roots carry the group
   * (rig group for humanoids/drones, turret assembly for turrets).
   */
  private readonly entityParts = new Map<object, PartRef[]>();
  private readonly entityRoots = new Map<object, THREE.Group>();
  /** per-entity damage-flash pulse, seconds remaining (enemies wave C) */
  private readonly flashT = new Map<object, number>();
  private readonly canonicalMats = new Map<string, THREE.Material>();
  /**
   * Enemies wave C: frame-open flag. Two managers (NpcManager +
   * EnemyManager) share this per-engine singleton and both drive the
   * instancer frame in their update(). Without the guard, the second
   * manager's beginFrame would zero the first manager's submitted counts
   * and its entities would never draw. Only the first beginFrame per
   * frame zeroes counts / decays flash pulses; endFrame closes the frame.
   */
  private frameOpen = false;

  private constructor(private readonly engine: Engine) {}

  /** Live bucket count (diagnostics: ≈ draw calls for the NPC/enemy layer). */
  get bucketCount(): number {
    return this.buckets.size;
  }

  get registeredNpcCount(): number {
    return this.entityParts.size;
  }

  /** True when the entity is currently registered (drives re-registration decisions). */
  isRegistered(entity: object): boolean {
    return this.entityParts.has(entity);
  }

  /**
   * Register an NPC's rig for instanced rendering. Hides the source
   * meshes (they keep animating as transform carriers) and assigns each
   * to its bucket. Idempotent per NPC.
   */
  register(npc: Npc): void {
    this.registerRoot(npc, npc.rig?.group ?? null);
  }

  /**
   * Enemies wave C: register an enemy for instanced rendering — the same
   * buckets NPCs use (shared wherever geometry+role match). Works for
   * rig enemies (walker/brute/drone/flyer → rig.group) and turrets
   * (turret assembly group). Idempotent per enemy.
   */
  registerEnemy(enemy: { renderRoot: THREE.Group | null }): void {
    this.registerRoot(enemy, enemy.renderRoot);
  }

  /**
   * Shared registration primitive: hide the source meshes under `root`
   * (they keep animating as transform carriers) and assign each mesh to
   * its (geometry, material-role, castShadow) bucket. Idempotent per owner.
   */
  private registerRoot(owner: object, root: THREE.Group | null): void {
    if (this.entityParts.has(owner) || !root) return;
    const parts: PartRef[] = [];
    root.traverse((o) => {
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
          key: bkey,
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
    this.entityParts.set(owner, parts);
    this.entityRoots.set(owner, root);
    for (const bucket of this.buckets.values()) this.ensureCapacity(bucket);
  }

  /**
   * Enemies wave C: drop one entity's registration (corpse sweep — the
   * source group is already disposed by the owner). Empty buckets are
   * removed from the scene. Returns true when the entity was registered.
   */
  unregister(entity: object): boolean {
    const parts = this.entityParts.get(entity);
    if (!parts) return false;
    for (const p of parts) {
      const b = p.bucket;
      const idx = b.parts.indexOf(p);
      if (idx >= 0) b.parts.splice(idx, 1);
      if (b.parts.length === 0) {
        if (b.mesh) {
          this.engine.scene.remove(b.mesh);
          b.mesh.dispose();
          b.mesh = null;
        }
        this.buckets.delete(b.key);
      }
    }
    this.entityParts.delete(entity);
    this.entityRoots.delete(entity);
    this.flashT.delete(entity);
    return true;
  }

  /**
   * Enemies wave C: start the per-instance damage-flash pulse for a
   * registered entity. The pulse is a 0.25s white-hot tint blink written
   * through instanceColor on non-emissive roles — shared canonical
   * materials are never touched. No-op for unregistered entities (the
   * direct-render path keeps its own rig.flash()).
   */
  flash(entity: object): void {
    if (this.entityParts.has(entity)) this.flashT.set(entity, FLASH_DURATION);
  }

  /**
   * Zero per-frame instance counts (call before submitting the frame's
   * entities). Also decays active damage-flash pulses by dt.
   *
   * Enemies wave C: idempotent per frame (see frameOpen). The first
   * manager to begin the frame zeroes and decays; the second manager's
   * beginFrame is a no-op so its submits accumulate into the same frame.
   */
  beginFrame(dt = 0): void {
    if (this.frameOpen) return;
    this.frameOpen = true;
    for (const b of this.buckets.values()) b.count = 0;
    if (dt > 0 && this.flashT.size) {
      for (const [e, t] of this.flashT) {
        const nt = t - dt;
        if (nt <= 0) this.flashT.delete(e);
        else this.flashT.set(e, nt);
      }
    }
  }

  /**
   * Write one entity's current pose into the instance buffers. The rig must
   * already be posed (Npc.update / Enemy.update do behavior + animate);
   * this refreshes matrixWorld and copies each mesh's world matrix (+ tint).
   * Static entities (never ticked) need exactly one submit — instances persist.
   *
   * Enemies wave C: when a damage-flash pulse is active for the entity, its
   * non-emissive instances blink white-hot (the old rig.flash() 20Hz blink
   * pattern) via per-instance tint — no shared material is mutated.
   */
  submit(entity: Npc | { renderRoot: THREE.Group | null }): void {
    const parts = this.entityParts.get(entity);
    const root = this.entityRoots.get(entity);
    if (!parts || !root) return;
    root.updateMatrixWorld(true);
    const ft = this.flashT.get(entity) ?? 0;
    // old rig.flash() blink: 20Hz, on when floor(t*20) is even
    const flashing = ft > 0 && Math.floor(ft * 20) % 2 === 0;
    for (const p of parts) {
      const b = p.bucket;
      const mesh = b.mesh;
      if (!mesh) continue;
      const i = b.count++;
      // Capacity is guaranteed at register time; guard anyway (never grow
      // mid-frame — a missed instance beats a corrupt buffer).
      if (i >= mesh.instanceMatrix.count) { b.count--; continue; }
      mesh.setMatrixAt(i, p.mesh.matrixWorld);
      if (p.color) {
        if (flashing) {
          _flashColor.copy(p.color).lerp(FLASH_TINT, 0.85);
          mesh.setColorAt(i, _flashColor);
        } else {
          mesh.setColorAt(i, p.color);
        }
      }
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
    this.frameOpen = false;
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
    this.entityParts.clear();
    this.entityRoots.clear();
    this.flashT.clear();
    this.frameOpen = false;
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
