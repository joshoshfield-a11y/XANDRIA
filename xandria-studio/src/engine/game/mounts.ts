/**
 * UPGRADE LOOP (mounts): rideable mounts.
 *
 * Player-scoped, state-driven, zero RNG in behavior (the visual build uses
 * one fixed-seed Rng only for the voxelPart jitter, so the mesh is
 * identical every build). Mounts change movement through ONE speed
 * scalar on the CharacterController — no movement-physics contract
 * change, no NPC/enemy behavior change.
 *
 * - Mount defs: id, name, speed multiplier, stamina pool, drain/regen
 *   rates. Three seeded mounts: swift strider, armored beetle, gliding
 *   drake-lite (ground speed only — it never flies; the wings are folded
 *   dressing, and no glide/jump physics is touched).
 * - Summon/dismiss: MountManager.summon/dismiss (+ the MountPanel UI and
 *   the N hotkey in the tpAction blueprint). The manager is player-scoped
 *   (NOT a MapLocalEntitySystem): the avatar object persists across
 *   portal transitions, so a mounted player stays mounted through travel.
 *   Save/reload persistence rides on ProfileData.mounts (active mount +
 *   per-mount stamina), written on summon/dismiss and throttled during
 *   play (every >=5 stamina delta) so a reload never resurrects a stale
 *   mount or a full-stamina lie.
 * - Stamina: a mount-owned pool (the player stats never had a stamina
 *   pool — combatAbilities documents this — so this pool is additive, not
 *   a replacement). Drains only while mounted AND moving; regens whenever
 *   not draining. At 0 the mount is exhausted: speed benefit drops to
 *   1.0 until stamina recovers to >=30% of the pool (hysteresis, so the
 *   benefit does not flicker at the boundary).
 * - Combat: mounts do NOT auto-dismount on combat entry (disclosed
 *   choice — the brief made it optional). Melee/gun keep working while
 *   mounted; the speed scalar is the only movement effect.
 * - Rendering: the mount visual is a voxel quadruped built from the
 *   shared voxelGeo cache and submitted through the shared per-engine
 *   NpcInstancer via the owner-agnostic registerEnemy({ renderRoot })
 *   path (the gathering-node precedent). No new meshes per frame, no
 *   new emissive role (amber eyes reuse the existing amber-clasp role).
 *   Draw delta is measured, not modeled — see the e2e perf leg.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { NpcInstancer } from './npcInstancing';
import { voxelBoxCacheFor, paletteFor, voxelPart, type VoxelBuildCtx } from './voxelGeo';

export interface MountDef {
  id: string;
  name: string;
  /** multiplicative speed scalar applied on top of base/sprint/boost */
  speedMult: number;
  /** stamina pool size */
  staminaMax: number;
  /** stamina drained per second while mounted and moving */
  drainPerSec: number;
  /** stamina regenerated per second while not draining */
  regenPerSec: number;
  /** voxel body tint (palette-adjacent; new tints share instancer buckets by geometry+role, not by hex) */
  bodyHex: string;
  /** short flavor line for the panel */
  blurb: string;
}

export const MOUNT_DEFS: readonly MountDef[] = [
  {
    id: 'swift-strider', name: 'Swift Strider', speedMult: 1.5,
    staminaMax: 100, drainPerSec: 8, regenPerSec: 15,
    bodyHex: '#7a8e4e', blurb: 'Long-legged plains runner. Fast, thirsty.',
  },
  {
    id: 'armored-beetle', name: 'Armored Beetle', speedMult: 1.25,
    staminaMax: 140, drainPerSec: 5, regenPerSec: 10,
    bodyHex: '#4a4d44', blurb: 'Plated and patient. Sips stamina, never hurries.',
  },
  {
    id: 'drake-lite', name: 'Gliding Drake-Lite', speedMult: 1.75,
    staminaMax: 80, drainPerSec: 12, regenPerSec: 12,
    bodyHex: '#6e5c8e', blurb: 'Folded wings, ground-bound. The fastest feet in the valley.',
  },
];

export function mountDefOf(id: string): MountDef | null {
  return MOUNT_DEFS.find((d) => d.id === id) ?? null;
}

/** Persisted mount state (mirrors ProfileData.mounts). */
export interface MountPersist {
  active: string | null;
  stamina: Record<string, number>;
}

/**
 * Pure mount state: summon/dismiss, stamina drain/regen, exhaustion
 * hysteresis, effective speed multiplier. No THREE, no engine — unit
 * tested in isolation.
 */
export class MountState {
  activeId: string | null = null;
  /** current stamina per mount id (missing = full) */
  stamina: Record<string, number> = {};
  /** exhausted flag for the active mount (hysteresis latch) */
  exhausted = false;

  constructor(persist?: MountPersist | null) {
    if (persist) {
      this.activeId = mountDefOf(persist.active ?? '') ? persist.active : null;
      this.stamina = { ...persist.stamina };
      if (this.activeId) {
        this.stamina[this.activeId] = clampStamina(this.activeId, this.stamina[this.activeId]);
      }
    }
  }

  get active(): MountDef | null {
    return this.activeId ? mountDefOf(this.activeId) : null;
  }

  get mounted(): boolean { return this.activeId !== null; }

  staminaOf(id: string): number {
    const def = mountDefOf(id);
    if (!def) return 0;
    const v = this.stamina[id];
    return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(def.staminaMax, v)) : def.staminaMax;
  }

  /** Summon a mount (dismisses any current mount first). Returns false for unknown ids. */
  summon(id: string): boolean {
    const def = mountDefOf(id);
    if (!def) return false;
    this.activeId = id;
    if (this.stamina[id] === undefined) this.stamina[id] = def.staminaMax;
    this.exhausted = this.staminaOf(id) <= 0;
    return true;
  }

  dismiss(): void {
    this.activeId = null;
    this.exhausted = false;
  }

  /**
   * Advance stamina by dt seconds. Drains only while mounted and moving;
   * otherwise regens the active mount (and keeps dismounted mounts full —
   * they rest in the stable). Exhaustion latches at 0 and releases at
   * >=30% of the pool.
   */
  update(dt: number, moving: boolean): void {
    const def = this.active;
    if (!def || dt <= 0) return;
    if (moving && !this.exhausted) {
      this.stamina[def.id] = Math.max(0, this.staminaOf(def.id) - def.drainPerSec * dt);
      if (this.staminaOf(def.id) <= 0) this.exhausted = true;
    } else {
      const next = Math.min(def.staminaMax, this.staminaOf(def.id) + def.regenPerSec * dt);
      this.stamina[def.id] = next;
      if (this.exhausted && next >= def.staminaMax * 0.3) this.exhausted = false;
    }
  }

  /** Effective speed multiplier: 1 when dismounted or exhausted. */
  speedMultiplier(): number {
    const def = this.active;
    if (!def || this.exhausted) return 1;
    return def.speedMult;
  }

  toPersist(): MountPersist {
    return { active: this.activeId, stamina: { ...this.stamina } };
  }
}

function clampStamina(id: string, v: unknown): number {
  const def = mountDefOf(id);
  if (!def) return 0;
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(def.staminaMax, v)) : def.staminaMax;
}

// ---------------------------------------------------------------------------
// Mount visual — voxel quadruped on the shared instancer
// ---------------------------------------------------------------------------

/** Fixed build seed: the voxelPart jitter must be identical every build. */
const MOUNT_VISUAL_SEED = 0x5eed;

/** Build a voxel quadruped group for a mount def (faces +z, feet at y=0). */
export function buildMountVisual(engine: Engine, def: MountDef): THREE.Group {
  const g = new THREE.Group();
  const pal = paletteFor(engine.spec.theme.environment);
  const ctx: VoxelBuildCtx = {
    engine,
    geo: voxelBoxCacheFor(engine),
    rng: new Rng(MOUNT_VISUAL_SEED),
  };
  const body = def.bodyHex;
  const dark = pal.woodDark;
  // torso
  voxelPart(ctx, g, 1.5, 0.7, 0.85, body, 0.9, 0, 0.95, 0);
  // neck + head (front = +z)
  voxelPart(ctx, g, 0.45, 0.65, 0.45, body, 0.9, 0, 1.45, 0.55, { rotX: 0.15 });
  voxelPart(ctx, g, 0.5, 0.35, 0.55, body, 0.9, 0, 1.75, 0.85);
  // saddle (accent)
  voxelPart(ctx, g, 0.75, 0.16, 0.7, pal.metal, 0.6, 0, 1.35, -0.05);
  // legs
  for (const [lx, lz] of [[-0.55, 0.45], [0.55, 0.45], [-0.55, -0.45], [0.55, -0.45]] as const) {
    voxelPart(ctx, g, 0.22, 0.6, 0.22, dark, 0.9, lx, 0.3, lz);
  }
  // tail
  voxelPart(ctx, g, 0.2, 0.5, 0.2, dark, 0.9, 0, 1.05, -0.55, { rotX: -0.5 });
  // drake-lite: folded wings (ground dressing only — never animated, never flown)
  if (def.id === 'drake-lite') {
    voxelPart(ctx, g, 0.9, 0.08, 0.5, body, 0.9, -0.75, 1.25, -0.1, { rotZ: 0.35 });
    voxelPart(ctx, g, 0.9, 0.08, 0.5, body, 0.9, 0.75, 1.25, -0.1, { rotZ: -0.35 });
  }
  // beetle: shell plate
  if (def.id === 'armored-beetle') {
    voxelPart(ctx, g, 1.55, 0.14, 0.9, pal.metal, 0.5, 0, 1.35, 0);
  }
  // amber eyes — the existing amber-clasp emissive role, no new role
  voxelPart(ctx, g, 0.09, 0.09, 0.09, '', 0.3, -0.2, 1.78, 1.12, { amber: true });
  voxelPart(ctx, g, 0.09, 0.09, 0.09, '', 0.3, 0.2, 1.78, 1.12, { amber: true });
  return g;
}

// ---------------------------------------------------------------------------
// MountManager — state + visual + profile persistence, blueprint-owned
// ---------------------------------------------------------------------------

export interface MountManagerDeps {
  engine: Engine;
  /** player position/yaw source (the avatar controller) */
  playerPos: () => THREE.Vector3;
  playerYaw: () => number;
  /** read/write the profile mounts record (default: save-slot profile) */
  loadPersist?: () => MountPersist;
  savePersist?: (p: MountPersist) => void;
  toast?: (msg: string) => void;
}

/**
 * Blueprint-owned, player-scoped (NOT map-local): survives portal travel
 * because it is never registered with engine.portalEntities and the
 * avatar persists across transitions. Save/reload restores via the
 * profile record.
 */
export class MountManager {
  readonly state: MountState;
  private visual: THREE.Group | null = null;
  private visualDefId: string | null = null;
  /** the exact owner object passed to registerEnemy — unregister needs the same identity */
  private visualOwner: { renderRoot: THREE.Group | null } | null = null;
  private registered = false;
  private lastSavedStamina = -1;
  private wasExhausted = false;

  constructor(private readonly deps: MountManagerDeps, persist?: MountPersist | null) {
    this.state = new MountState(persist ?? deps.loadPersist?.() ?? null);
    if (this.state.mounted) this.ensureVisual();
  }

  get mounted(): boolean { return this.state.mounted; }
  get activeId(): string | null { return this.state.activeId; }
  speedMultiplier(): number { return this.state.speedMultiplier(); }
  staminaOf(id: string): number { return this.state.staminaOf(id); }

  summon(id: string): boolean {
    if (!this.state.summon(id)) return false;
    this.ensureVisual();
    this.persist(true);
    this.deps.toast?.(`${mountDefOf(id)!.name} summoned — press N to dismiss`);
    return true;
  }

  dismiss(): void {
    if (!this.state.mounted) return;
    const name = this.state.active?.name ?? '';
    this.state.dismiss();
    this.retireVisual();
    this.persist(true);
    this.deps.toast?.(`${name} dismissed`);
  }

  /** Per-frame: stamina tick + visual follow + exhaustion toast edge. */
  update(dt: number, moving: boolean): void {
    this.state.update(dt, moving);
    if (this.state.mounted) {
      this.ensureVisual();
      this.followPlayer();
      if (this.state.exhausted && !this.wasExhausted) {
        this.deps.toast?.(`${this.state.active!.name} exhausted — rest to recover stamina`);
      }
      // throttled persistence: a reload mid-ride restores near-current stamina
      const cur = this.state.staminaOf(this.state.activeId!);
      if (this.lastSavedStamina < 0 || Math.abs(cur - this.lastSavedStamina) >= 5) {
        this.persist(false);
      }
    }
    this.wasExhausted = this.state.exhausted;
  }

  /** Submit the visual into the blueprint-driven instancer frame. */
  submitFrame(): void {
    if (this.visualOwner && this.registered) {
      NpcInstancer.for(this.deps.engine).submit(this.visualOwner);
    }
  }

  private ensureVisual(): void {
    const def = this.state.active;
    if (!def) return;
    if (this.visual && this.visualDefId === def.id) return;
    this.retireVisual();
    this.visual = buildMountVisual(this.deps.engine, def);
    this.visualDefId = def.id;
    this.visualOwner = { renderRoot: this.visual };
    NpcInstancer.for(this.deps.engine).registerEnemy(this.visualOwner);
    this.registered = true;
  }

  private retireVisual(): void {
    if (this.visualOwner && this.registered) {
      NpcInstancer.for(this.deps.engine).unregister(this.visualOwner);
    }
    this.visual = null;
    this.visualDefId = null;
    this.visualOwner = null;
    this.registered = false;
  }

  private followPlayer(): void {
    if (!this.visual) return;
    const p = this.deps.playerPos();
    const terr = this.deps.engine.terrain as { heightAt?: (x: number, z: number) => number } | undefined;
    const ground = terr?.heightAt ? terr.heightAt(p.x, p.z) : p.y - 1.2;
    this.visual.position.set(p.x, ground, p.z);
    this.visual.rotation.y = this.deps.playerYaw() + Math.PI;
  }

  private persist(force: boolean): void {
    const save = this.deps.savePersist;
    if (!save) return;
    const p = this.state.toPersist();
    save(p);
    if (this.state.activeId) this.lastSavedStamina = this.state.staminaOf(this.state.activeId);
    void force;
  }
}
