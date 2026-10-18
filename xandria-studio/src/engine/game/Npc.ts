/**
 * NPC core — ambient villagers (gameplay wave, workstream A).
 *
 * Mirrors EnemyAI's structure (capsule physics body, seeded Rng, wander
 * steering, dispose()) but with NO combat: the behavior loop is
 * idle <-> wander, steering faces movement, and each NPC exposes an
 * `Interactable` ({ type: 'npc', prompt: 'Talk to <name>' }) that the
 * interaction wave (workstream C) wires into InteractionRegistry.
 *
 * Voxel rig: makeHumanoid + VoxelArmor layered set (pauldrons, chest plate,
 * visor slit) + a chest-mounted amber clasp. Seeded palette variation per
 * NPC. Reads as "XANDRIA villager", not a recolored enemy: warm cloth
 * palette, lighter bulk than enemies, amber visor (nomad family) instead of
 * the enemy accent colors.
 *
 * Determinism law: the constructor seed feeds a private Rng; name, greeting
 * and palette all derive from it. update() also only consumes that Rng, so
 * identical seed + identical dt sequence => identical behavior. No
 * Math.random / Date.now / engine.rng in spawn or behavior paths.
 *
 * Output contract for workstreams B/C (do not change without flagging):
 *   constructor(engine, spec: NpcSpec, spawn: THREE.Vector3, seed: number)
 *   update(dt: number): void
 *   dispose(): void
 *   interactable: Interactable (live position, type 'npc')
 *   spawnNpcsForMap(engine, mapSeed, opts): Npc[]  (B finalizes placement)
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { GROUP, toV3 } from '../core/Physics';
import { makeHumanoid, disposeOwned, type CharacterRig } from '../gfx/Characters';
import { applyVoxelArmorSlot } from '../gfx/VoxelArmor';
import { amberGlowMaterial } from '../gfx/AmberGlow';
import { Rng } from '../core/Rng';
import type { NpcSpec, VoxelArmorSetId } from '@spec';
import type { Interactable } from './Interaction';
import { generateNpcName, generateNpcGreeting } from './npcNames';
import { NpcRigCache, npcLookKey, npcLookSeed, type NpcLookKey, type NpcAdopted } from './npcRigSharing';

/** Salt distinguishing NPC roster streams from every other per-map stream. */
export const NPC_SALT = 0x4e5043;

/** Per-NPC resolved visual identity (seeded; same seed => identical). */
export interface NpcPalette {
  cloth: string;
  pants: string;
  accent: string;
  armorSet: string;
  visor: string;
  bulk: number;
}

/** Warm, earthy cloth tones — deliberately NOT the enemy palette. */
const VILLAGER_CLOTH = [
  '#7a5c3a', '#5e6e4a', '#4a5e6e', '#6e4a5e', '#8a6a3a',
  '#3a5e5e', '#75553f', '#8f7a4a', '#556b3a', '#6b4a3a',
] as const;
const VILLAGER_PANTS = ['#3a342e', '#2e3a34', '#463a2e', '#33302e', '#2e3440'] as const;
/** Armor sets that read "villager", not "raider" — nomad is the default. */
const VILLAGER_ARMOR: readonly VoxelArmorSetId[] = ['nomad', 'nomad', 'raider', 'nomad', 'plate'] as const;
/** Amber-family visor slits — the signature motif. */
const AMBER_VISORS = ['#ffb545', '#ffd27a', '#ffd23f', '#ffab33'] as const;

/** Fixed draw order for rng consumption in the constructor — do not reorder. */
function buildPalette(rng: Rng, spec: NpcSpec): NpcPalette {
  const cloth = spec.palette?.cloth ?? rng.pick(VILLAGER_CLOTH);
  const pants = spec.palette?.pants ?? rng.pick(VILLAGER_PANTS);
  const accent = spec.palette?.accent ?? '#ffb545';
  const armorSet = spec.armorSet ?? rng.pick(VILLAGER_ARMOR);
  const visor = spec.palette?.visor ?? rng.pick(AMBER_VISORS);
  const bulk = 0.85 + rng.next() * 0.15; // 0.85..1.0 — lighter build than enemies
  return { cloth, pants, accent, armorSet, visor, bulk };
}

export interface SpawnNpcsOpts {
  /** exact count (overrides density) */
  count?: number;
  /** 0..1 scales the default count (default 1) */
  density?: number;
  /** roster specs, cycled across spawns */
  specs?: NpcSpec[];
  /** points of interest to spawn near (empty = spawn at origin cluster) */
  pois?: THREE.Vector3[];
  /** wander radius in meters (default 6) */
  wanderRadius?: number;
  /** wander speed m/s (default 1.2) */
  speed?: number;
}

const DEFAULT_NPC_COUNT = 8;

let npcIdCounter = 0;

export class Npc {
  body: CANNON.Body | null = null;
  rig: CharacterRig | null = null;
  readonly name: string;
  readonly greeting: string;
  readonly palette: NpcPalette;
  readonly role: string;
  readonly home: THREE.Vector3;
  readonly interactable: Interactable;
  private rng: Rng;
  private state: 'idle' | 'wander' = 'idle';
  private stateT = 0;
  private wanderTarget = new THREE.Vector3();
  private animT: number;
  private disposed = false;
  private wanderRadius: number;
  private speed: number;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  /**
   * Workstream B: visual-identity bucket for rig sharing. The rig seed
   * derives from (armorSet, quantized bulk) — NOT the per-NPC behavior
   * seed — so same-look NPCs build bit-identical geometry that the
   * NpcRigCache shares; palette COLORS still vary per NPC (they are
   * materials, shared globally by content signature). `adopted` tracks the
   * cache signatures this instance holds — dispose() releases them instead
   * of disposeOwned() (null = dedupe failed → old per-instance path).
   */
  private readonly lookKey: NpcLookKey;
  private adopted: NpcAdopted | null = null;

  constructor(
    private engine: Engine,
    public spec: NpcSpec,
    spawn: THREE.Vector3,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.home = spawn.clone();
    // FIXED draw order: name (4 draws + 1 conditional), greeting (1), palette (5)
    this.name = spec.name ?? generateNpcName(this.rng);
    this.greeting = generateNpcGreeting(this.rng);
    this.palette = buildPalette(this.rng, spec);
    this.role = spec.role ?? 'villager';
    this.wanderRadius = spec.wanderRadius ?? 6;
    this.speed = spec.speed ?? 1.2;
    this.animT = this.rng.range(0, 10);

    const p = this.palette;
    // Workstream B: the rig is built at bulk 1.0 from a seed derived ONLY
    // from the armor set — one canonical body geometry per set for the whole
    // roster (3 variants). Per-NPC identity rides on (a) palette materials,
    // shared globally by content signature in the NpcRigCache, and (b) the
    // continuous bulk applied as a uniform group scale below, which the
    // physics capsule (built with the same continuous bulk) matches exactly.
    // Behavior (name/greeting/wander) still keys off the per-NPC seed;
    // constructor rng draw order unchanged.
    this.lookKey = npcLookKey(p.armorSet);
    const rigSeed = npcLookSeed(this.lookKey);
    this.body = engine.physics.capsule(0.42 * p.bulk, 1.7 * p.bulk,
      [spawn.x, spawn.y + 1.4 * p.bulk, spawn.z], {
        mass: 60 * p.bulk,
        group: GROUP.NPC,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.NPC,
      });
    // NPCs don't knock themselves or each other around: damp aggressively.
    this.body.linearDamping = 0.9;

    this.rig = makeHumanoid(engine.mats, {
      shirt: p.cloth,
      pants: p.pants,
      accent: p.accent,
      skin: '#9a8f7e',
      bulk: 1.0, // workstream B: canonical bulk-1.0 body; per-NPC bulk via group scale below
    }, rigSeed, engine.spec.custom?.forge);
    // Villager-lite armor: only the binding-required slots — head (helm +
    // visor slit), torso (chest plate + belt), accessory (pauldrons). The
    // legs slot (greaves) and vambraces are skipped to keep the per-NPC
    // draw cost down; cloth pants carry the lower body instead.
    const armorOpts = { visorColor: p.visor, origin: 'skin' as const };
    applyVoxelArmorSlot(this.rig, 'head', p.armorSet, armorOpts);
    applyVoxelArmorSlot(this.rig, 'torso', p.armorSet, armorOpts);
    applyVoxelArmorSlot(this.rig, 'accessory', p.armorSet, armorOpts);
    this.addAmberClasp();
    // Workstream B: uniform per-NPC bulk scale on the rig group (the rig was
    // built at bulk 1.0; this restores the NPC's continuous bulk visually).
    // animate()'s squash snapshots group.scale lazily, so landing squash
    // keeps working on top of this scale. Must run before share(): it only
    // touches the Object3D transform, never the geometry.
    this.rig.group.scale.multiplyScalar(p.bulk);
    // Workstream B: share identical body-part geometries/materials with
    // every other NPC via the per-engine NpcRigCache (content-keyed: the
    // amber clasp, armor pieces and body parts hash equal across looks
    // wherever they are truly identical). The cache owns the canonical GPU
    // resources — per-instance dispose() releases adopted signatures
    // instead of disposeOwned(). Null = share() failed → old path.
    this.adopted = NpcRigCache.for(engine).share(this.rig.group);
    engine.scene.add(this.rig.group);

    this.interactable = {
      id: `npc-${(seed >>> 0).toString(16)}-${npcIdCounter++}`,
      type: 'npc',
      position: this.home.clone(),
      radius: 3,
      enabled: true,
      prompt: `Talk to ${this.name}`,
    };
    this.pickWanderTarget();
    this.state = 'idle';
    this.stateT = this.rng.range(1, 4);
    this.syncRigTransform();
  }

  /**
   * Chest-mounted amber clasp: the second amber accent next to the visor
   * slit (binding art direction). Fitted to the torso pivot's own bbox like
   * the VoxelArmor builders, so any seed/bulk places it sanely. +1 mesh.
   */
  private addAmberClasp(): void {
    const rig = this.rig;
    const torso = rig?.limbs.torso;
    if (!rig || !torso) return;
    try {
      rig.group.updateMatrixWorld(true);
      const bb = new THREE.Box3();
      torso.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) bb.expandByObject(m);
      });
      if (bb.isEmpty()) return;
      torso.worldToLocal(bb.min);
      torso.worldToLocal(bb.max);
      const clasp = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.14, 0.1),
        amberGlowMaterial(this.engine.mats, 2.0),
      );
      clasp.position.set(
        (bb.min.x + bb.max.x) / 2,
        (bb.min.y + bb.max.y) / 2 + (bb.max.y - bb.min.y) * 0.15,
        bb.max.z + 0.06,
      );
      clasp.castShadow = false;
      torso.add(clasp);
    } catch { /* decorative — never break the sim */ }
  }

  get position(): THREE.Vector3 {
    return this.body ? toV3(this.body.position) : this.home.clone();
  }

  get alive(): boolean {
    return !this.disposed;
  }

  private pickWanderTarget(): void {
    const r = this.wanderRadius;
    const a = this.rng.range(0, Math.PI * 2);
    const d = Math.sqrt(this.rng.next()) * r;
    this.wanderTarget.set(
      this.home.x + Math.cos(a) * d,
      this.home.y,
      this.home.z + Math.sin(a) * d,
    );
  }

  /** Never steer toward a cliff: retarget if the terrain drops past the point. */
  private targetOnCliff(t: THREE.Vector3): boolean {
    if (!this.engine.terrain) return false;
    const h = this.engine.terrain.heightAt(t.x, t.z);
    return h !== null && h < this.home.y - 2.5;
  }

  private syncRigTransform(): void {
    if (!this.rig || !this.body) return;
    const v = this.engine.physics.interpolatedPosition(this.body, this.tmp);
    const p = this.palette.bulk;
    this.rig.group.position.set(v.x, v.y - 0.85 * p, v.z);
    this.interactable.position.set(v.x, v.y, v.z);
  }

  /**
   * Seeded behavior tick: idle <-> wander, face-movement steering, player
   * repulsion (never walk through the player capsule), cliff retarget.
   * rng consumption is deterministic given the same dt sequence.
   */
  update(dt: number): void {
    if (this.disposed || !this.body || !this.rig) return;
    this.animT += dt;
    const b = this.body;
    const pos = toV3(b.position);

    this.stateT -= dt;
    if (this.stateT <= 0) {
      if (this.state === 'idle') {
        this.state = 'wander';
        this.pickWanderTarget();
        if (this.targetOnCliff(this.wanderTarget)) this.pickWanderTarget();
        this.stateT = this.rng.range(6, 14);
      } else {
        this.state = 'idle';
        this.stateT = this.rng.range(2, 7);
      }
    }

    let speed = 0;
    if (this.state === 'wander') {
      const dir = this.tmp.subVectors(this.wanderTarget, pos);
      dir.y = 0;
      const dist = dir.length();
      if (dist < 0.8) {
        this.state = 'idle';
        this.stateT = this.rng.range(2, 7);
      } else {
        dir.normalize();
        speed = this.speed;
        b.velocity.x = dir.x * speed;
        b.velocity.z = dir.z * speed;
        // face movement
        this.rig.group.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI;
      }
    } else {
      b.velocity.x *= 0.8;
      b.velocity.z *= 0.8;
    }

    // player repulsion: stay out of the player capsule (~1.8m keep-out)
    const pp = this.engine.portalsPlayerAvatar?.ctrl.position;
    if (pp) {
      const away = this.tmp2.subVectors(pos, pp);
      away.y = 0;
      const pd = away.length();
      if (pd < 1.8 && pd > 1e-4) {
        away.normalize().multiplyScalar((1.8 - pd) * 6);
        b.velocity.x += away.x * dt;
        b.velocity.z += away.z * dt;
      }
    }

    this.syncRigTransform();
    this.rig.animate(this.animT, speed, {});
  }

  /**
   * Full lifecycle teardown: physics body out of the world, rig out of the
   * scene. GPU resources: when the rig was cache-shared (the normal path),
   * geometries/materials are cache-owned canonicals — dispose() only
   * releases this instance's adopted signatures (entries self-dispose at
   * zero refs; the manager's despawnAll clears the cache wholesale). When
   * share() failed, falls back to the old per-instance disposeOwned path.
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.body) {
      this.engine.physics.remove(this.body);
      this.body = null;
    }
    if (this.rig) {
      this.engine.scene.remove(this.rig.group);
      if (this.adopted) {
        NpcRigCache.for(this.engine).release(this.adopted);
        this.adopted = null;
      } else {
        disposeOwned(this.rig.group);
      }
      this.rig = null;
    }
  }
}

/**
 * Spawn helper (workstream B finalizes the placement strategy). Spawns a
 * deterministic roster near the given points of interest using ONLY a
 * map-seeded stream (`new Rng(mapSeed ^ NPC_SALT)` — never engine.rng,
 * never Math.random).
 *
 * @returns the spawned NPCs (caller owns them and must dispose())
 */
export function spawnNpcsForMap(engine: Engine, mapSeed: number, opts: SpawnNpcsOpts = {}): Npc[] {
  const rng = new Rng((mapSeed ^ NPC_SALT) >>> 0);
  const count = opts.count ?? Math.max(1, Math.round(DEFAULT_NPC_COUNT * (opts.density ?? 1)));
  const specs = opts.specs?.length ? opts.specs : [{ role: 'villager' } as NpcSpec];
  const pois = opts.pois?.length ? opts.pois : [new THREE.Vector3(0, 0, 0)];
  const out: Npc[] = [];
  for (let i = 0; i < count; i++) {
    const poi = rng.pick(pois);
    const spec = specs[i % specs.length];
    const a = rng.range(0, Math.PI * 2);
    const d = 2 + rng.range(0, 10);
    const y = engine.terrain ? (engine.terrain.heightAt(poi.x, poi.z) ?? poi.y) : poi.y;
    const spawn = new THREE.Vector3(poi.x + Math.cos(a) * d, y, poi.z + Math.sin(a) * d);
    const seed = (mapSeed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    out.push(new Npc(engine, spec, spawn, seed));
  }
  return out;
}
