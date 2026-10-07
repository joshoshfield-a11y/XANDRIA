/**
 * Assets — named visual asset registry (the reskin layer).
 *
 * Every visual asset in a game registers under a namespaced string id:
 * `player.body`, `enemy.walker`, `pickup.coin`, `world.sky`, ...
 * The full catalog is exported as ASSET_IDS.
 *
 * Public override contract (spec-driven, for users and developers):
 *   spec.custom.assets is Record<string, AssetOverride>
 *   interface AssetOverride {
 *     color?: string;             // CSS hex, e.g. "#ff3344"
 *     emissive?: string;          // CSS hex
 *     emissiveIntensity?: number;
 *     scale?: number;             // 0.05..10 multiplier on the registered base scale
 *     visible?: boolean;
 *   }
 *
 * Blueprints register materials/meshes as they build, then call
 * `registry.applyOverrides(spec)` once construction is done (and again
 * after any dynamic wave spawn). Application is deterministic: override
 * ids are applied in sorted order, sets are idempotent.
 *
 * How overrides reach the pixels:
 * - `materials`: base/owned materials. applyOverrides clones each one before
 *   applying the override and swaps the entry over to the clone — the
 *   registered (possibly MaterialLibrary-cached and shared) instance is
 *   never mutated, so one asset's recolor can't leak into another (M6).
 *   Read the effective material back via currentMaterial(id).
 * - `roots`: live object roots. Each mesh material is swapped for a
 *   per-entry cached clone carrying the override, so shared
 *   MaterialLibrary-cached materials are never mutated (no cross-talk
 *   between asset types) and already-spawned instances update too.
 * - `fog`: scene fog target; only its color is overridden.
 *
 * Overrides are visual-only: they never touch physics bodies, hitboxes,
 * damage, AI, or any simulation state.
 *
 * NOTE on `spec.custom.assets` typing: the spec schema historically types
 * `custom.assets` as AssetPacks (online GLB packs). The override record
 * above is the new reskin contract; applyOverrides() accepts the override
 * shape and silently skips the legacy AssetPacks shape ({ enabled }).
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { EnemyManager } from './EnemyAI';

export interface AssetOverride {
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  scale?: number;
  visible?: boolean;
}

export const ASSET_IDS = [
  // player
  'player.body',
  'player.vehicle',
  // enemies — base kinds
  'enemy.walker',
  'enemy.drone',
  'enemy.brute',
  'enemy.flyer',
  'enemy.turret',
  // enemies — variant layer (blueprints/enemies.ts)
  'enemy.charger',
  'enemy.sniper',
  'enemy.splitter',
  'enemy.caster',
  'enemy.shielded',
  'enemy.skyray',
  'enemy.spikeball',
  'enemy.mini',
  // boss
  'boss.body',
  // pickups — engine pickups
  'pickup.coin',
  'pickup.health',
  'pickup.ammo',
  'pickup.powerup',
  // pickups — timed effect pickups (blueprints/fx.ts)
  'pickup.shield',
  'pickup.rapid',
  'pickup.score',
  'pickup.magnet',
  // weapons
  'weapon.projectile',
  // vehicles
  'vehicle.ai',
  // world
  'world.sky',
  'world.ground',
  'world.fog',
  'world.arena',
  'world.platform',
  'world.track',
  'world.gate',
] as const;
export type AssetId = (typeof ASSET_IDS)[number];
const KNOWN_IDS = new Set<string>(ASSET_IDS as readonly string[]);

export type AssetKind =
  | 'player'
  | 'enemy'
  | 'boss'
  | 'pickup'
  | 'weapon'
  | 'vehicle'
  | 'world'
  | 'prop';

export interface AssetListEntry {
  id: string;
  kind: AssetKind;
  currentColor: string | null;
}

interface RegisterOpts {
  kind: AssetKind;
  /**
   * base/owned materials — cloned before any override is applied (the
   * registered instance is never mutated, so MaterialLibrary-cached shared
   * materials can't leak a recolor into other assets; M6). The override
   * lives on the per-entry clone, which replaces the entry's reference.
   */
  materials?: THREE.Material[];
  /** live roots — materials swapped for per-entry clones (existing instances update) */
  roots?: THREE.Object3D[] | (() => THREE.Object3D[]);
  /** scene fog target — only color is overridden */
  fog?: THREE.Fog | null;
}

interface AssetEntry {
  id: string;
  kind: AssetKind;
  materials: THREE.Material[];
  roots: THREE.Object3D[] | (() => THREE.Object3D[]);
  fog: THREE.Fog | null;
  baseScale: Map<THREE.Object3D, THREE.Vector3>;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function eachMaterial(root: THREE.Object3D, fn: (m: THREE.Material, mesh: THREE.Mesh) => void): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) if (m) fn(m as THREE.Material, mesh);
  });
}

function firstColor(entry: AssetEntry): string | null {
  for (const m of entry.materials) {
    const c = (m as THREE.MeshStandardMaterial).color;
    if (c && typeof c.getHexString === 'function') return '#' + c.getHexString();
  }
  const roots = typeof entry.roots === 'function' ? entry.roots() : entry.roots;
  for (const r of roots) {
    let found: string | null = null;
    eachMaterial(r, (m) => {
      if (found) return;
      const c = (m as THREE.MeshStandardMaterial).color;
      if (c && typeof c.getHexString === 'function') found = '#' + c.getHexString();
    });
    if (found) return found;
  }
  return null;
}

export class AssetRegistry {
  private entries = new Map<string, AssetEntry>();
  /** per-entry override clones: `${id}::${sourceUuid}` -> clone (shared mats stay untouched) */
  private cloneCache = new Map<string, THREE.Material>();
  private warnings: string[] = [];

  /** Register a named asset. One line per asset, right after the blueprint creates it. */
  register(id: string, opts: RegisterOpts): void {
    const roots = opts.roots ?? [];
    const entry: AssetEntry = {
      id,
      kind: opts.kind,
      materials: opts.materials ? [...opts.materials] : [],
      roots,
      fog: opts.fog ?? null,
      baseScale: new Map(),
    };
    // capture base scales now so `scale` overrides stay multiplicative + idempotent
    const resolve = typeof roots === 'function' ? roots() : roots;
    for (const r of resolve) entry.baseScale.set(r, r.scale.clone());
    this.entries.set(id, entry);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * The entry's current effective base material (the override clone when an
   * override was applied, else the registered material). Lets callers wire
   * the overridden material into systems that re-assign materials themselves
   * (e.g. the projectile pool) without ever touching the shared cache.
   */
  currentMaterial(id: string): THREE.Material | undefined {
    return this.entries.get(id)?.materials[0];
  }

  /** Collected warnings (unknown ids, invalid values). Also logged via console.warn. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  clearWarnings(): void {
    this.warnings = [];
  }

  private warn(msg: string): void {
    this.warnings.push(msg);
    console.warn(`[xandria] assets: ${msg}`);
  }

  /**
   * Apply `spec.custom.assets` overrides. Reads the override-record shape;
   * silently skips the legacy AssetPacks shape ({ enabled }). Deterministic:
   * ids are applied in sorted order; every set is idempotent.
   */
  applyOverrides(spec: GameSpec): void {
    const raw = (spec.custom as unknown as { assets?: unknown } | undefined)?.assets;
    if (raw === undefined || raw === null) return;
    if (!isObject(raw)) {
      this.warn('custom.assets must be an object — overrides ignored');
      return;
    }
    // legacy AssetPacks shape ({ enabled: boolean, packs? }) — different feature, not reskins
    if (typeof (raw as Record<string, unknown>).enabled === 'boolean') return;

    for (const id of Object.keys(raw).sort()) {
      const override = (raw as Record<string, unknown>)[id];
      if (!KNOWN_IDS.has(id)) {
        this.warn(`unknown asset id "${id}" — override ignored`);
        continue;
      }
      const entry = this.entries.get(id);
      if (!entry) continue; // known id, not present in this game — nothing to do
      if (!isObject(override)) {
        this.warn(`override for "${id}" must be an object — ignored`);
        continue;
      }
      this.applyOne(entry, override as Record<string, unknown>);
    }
  }

  private applyOne(entry: AssetEntry, o: Record<string, unknown>): void {
    const id = entry.id;
    let color: THREE.Color | null = null;
    let emissive: THREE.Color | null = null;
    let emissiveIntensity: number | null = null;

    if (o.color !== undefined) {
      if (typeof o.color !== 'string' || !HEX_RE.test(o.color)) {
        this.warn(`"${id}".color must be a CSS hex string — ignored`);
      } else {
        color = new THREE.Color(o.color);
      }
    }
    if (o.emissive !== undefined) {
      if (typeof o.emissive !== 'string' || !HEX_RE.test(o.emissive)) {
        this.warn(`"${id}".emissive must be a CSS hex string — ignored`);
      } else {
        emissive = new THREE.Color(o.emissive);
      }
    }
    if (o.emissiveIntensity !== undefined) {
      if (typeof o.emissiveIntensity !== 'number' || !Number.isFinite(o.emissiveIntensity)) {
        this.warn(`"${id}".emissiveIntensity must be a number — ignored`);
      } else {
        emissiveIntensity = o.emissiveIntensity;
      }
    }

    // base materials: CLONE before overriding. The registered instance may be
    // a MaterialLibrary-cached shared material — mutating it would recolor
    // every mesh sharing that cache entry (M6). The override lands on the
    // per-entry clone, which replaces the entry's reference (idempotent:
    // re-applying re-clones and re-applies the same absolute values).
    const needClone = color !== null || emissive !== null || emissiveIntensity !== null;
    if (needClone) {
      entry.materials = entry.materials.map((m) => {
        const clone = m.clone();
        const s = clone as THREE.MeshStandardMaterial;
        if (color && 'color' in s && s.color) s.color.copy(color);
        if (emissive && 'emissive' in s && s.emissive) s.emissive.copy(emissive);
        if (emissiveIntensity !== null && 'emissiveIntensity' in s) s.emissiveIntensity = emissiveIntensity;
        return clone;
      });
    }

    // live roots: swap each mesh material for a per-entry cached clone
    const roots = typeof entry.roots === 'function' ? entry.roots() : entry.roots;
    // keep base scales fresh for roots resolved dynamically
    for (const r of roots) if (!entry.baseScale.has(r)) entry.baseScale.set(r, r.scale.clone());
    for (const root of roots) {
      eachMaterial(root, (m, mesh) => {
        const key = `${id}::${m.uuid}`;
        let clone = this.cloneCache.get(key);
        if (!clone) {
          clone = m.clone();
          this.cloneCache.set(key, clone);
        }
        const s = clone as THREE.MeshStandardMaterial;
        if (color && 'color' in s && s.color) s.color.copy(color);
        if (emissive && 'emissive' in s && s.emissive) s.emissive.copy(emissive);
        if (emissiveIntensity !== null && 'emissiveIntensity' in s) s.emissiveIntensity = emissiveIntensity;
        if (Array.isArray(mesh.material)) {
          mesh.material = (mesh.material as THREE.Material[]).map((mm) => (mm === m ? clone! : mm));
        } else {
          mesh.material = clone;
        }
      });
    }

    // fog: color only
    if (entry.fog && color) entry.fog.color.copy(color);

    // scale: multiplicative on the registered base scale (idempotent)
    if (o.scale !== undefined) {
      if (typeof o.scale !== 'number' || !Number.isFinite(o.scale)) {
        this.warn(`"${id}".scale must be a number — ignored`);
      } else {
        let s = o.scale;
        if (s < MIN_SCALE || s > MAX_SCALE) {
          this.warn(`"${id}".scale clamped to ${MIN_SCALE}..${MAX_SCALE}`);
          s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
        }
        for (const root of roots) {
          const base = entry.baseScale.get(root);
          if (base) root.scale.copy(base).multiplyScalar(s);
        }
      }
    }

    // visible
    if (o.visible !== undefined) {
      if (typeof o.visible !== 'boolean') {
        this.warn(`"${id}".visible must be a boolean — ignored`);
      } else {
        for (const root of roots) root.visible = o.visible;
      }
    }
  }

  /** Catalog for UI consumption: every registered asset + its current color. */
  list(): AssetListEntry[] {
    const out: AssetListEntry[] = [];
    for (const entry of this.entries.values()) {
      out.push({ id: entry.id, kind: entry.kind, currentColor: firstColor(entry) });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/**
 * Live rig groups for one enemy kind — pass as a dynamic `roots` provider so
 * re-applying overrides after a wave spawn reskins the new wave too.
 * Usage: assets.register('enemy.walker', { kind: 'enemy', roots: () => rigsOfKind(enemies, 'walker') });
 */
export function rigsOfKind(manager: EnemyManager, kind: string): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const e of manager.enemies) {
    if (e.alive && e.spec.kind === kind && e.rig) out.push(e.rig.group);
  }
  return out;
}
