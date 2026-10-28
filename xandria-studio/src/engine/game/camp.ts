/**
 * UPGRADE LOOP (player-camp): the player camp/base — one camp site per
 * map, data-driven structures, player-scoped storage chest, rest point,
 * workbench buff, minimap marker.
 *
 * Built on the deployables + save-slots waves:
 * - Site placement follows the deployables/gathering pattern: a seeded
 *   position from Rng(mapSeed ^ CAMP_SALT), grounded via terrain.heightAt,
 *   in-bounds checked with retries. "Discovered on arrival": the site
 *   marker + tent prop appear with spawnForMap, no scouting required.
 * - Structures are data-driven (CAMP_STRUCTURE_DEFS) and paid for with
 *   the existing tier-1 materials (mat_ore/mat_fiber/mat_scrap) through
 *   the inventory's remove() primitive — additive to the craft system,
 *   no contract changes, no new item types.
 * - The storage chest is PLAYER-SCOPED (one chest inventory for the
 *   player, not per camp): it lives in the save-slot profile
 *   (ProfileData.campChest) so it survives portal travel and save/reload
 *   exactly like merit/achievements. Built structures are per-map
 *   (ProfileData.campBuilt, keyed by map seed) so revisiting a map
 *   restores its camp.
 * - The workbench buff is a player-scoped timed effect (game time):
 *   activating a built workbench grants +10% melee damage for 600s.
 *   It survives portal travel (the manager is blueprint-owned; only its
 *   meshes are map-local) and is NOT persisted across reloads (a buff is
 *   run state, like a campfire aura — documented).
 * - Rendering rides the shared NpcInstancer via the owner-agnostic
 *   registerEnemy({ renderRoot }) path (deployables/stations pattern):
 *   site tent + one voxel prop per built structure, amber accent role
 *   only, zero new materials.
 * - The minimap reads the site observe-only (see Minimap.camp()) — the
 *   camp manager never writes minimap state.
 *
 * PORTAL LIFECYCLE: CampManager implements MapLocalEntitySystem
 * (id 'camp'). Departure despawns meshes + the site interactable;
 * arrival recomputes the identical site from the map seed and rebuilds
 * the persisted structures. The chest contents never despawn (profile).
 *
 * TIER VISUALS (camp-tier-visuals): each structure's prop is built at
 * its persisted upgrade tier (CAMP_TIER_VISUAL_EXTRAS, presentation-only:
 * the tier table still owns every capability). Upgrading rebuilds that
 * structure's prop in place at the new tier — no reload, no portal
 * trip — and arrival rebuilds props at the persisted tiers, so visuals
 * survive portal travel and save/reload exactly as tiers do.
 *
 * DETERMINISM: site position, structure offsets and prop jitter derive
 * from (mapSeed) alone via Rng — never engine.rng, never Math.random,
 * never Date.now for gameplay (saveProfile's updatedAt is UI metadata,
 * the pre-existing profile precedent).
 *
 * NPC/ENEMY CONTRACT: untouched. The only combat touch is the player's
 * own melee multiplier (blueprint multiplies by workbenchDamageMult(),
 * 1.0 when no buff is active — byte-identical behavior otherwise).
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { NpcInstancer } from './npcInstancing';
import {
  voxelBoxCacheFor,
  paletteFor,
  voxelPart,
  type VoxelPalette,
  type VoxelGeoCache,
  type VoxelBuildCtx,
} from './voxelGeo';
import { loadProfile, saveProfile } from './Profile';
import { deriveMapSeed, type MapCoord } from '../world/MapGraph';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import { InteractionPrompt } from '../ui/InteractionPrompt';
import { CampPanel, type CampPanelSource } from '../ui/CampPanel';

/** Salt for the camp-site stream — off the GATHER/DEPLOY/ENEMY streams. */
export const CAMP_SALT = 0xca7d5;

/** Workbench buff: melee damage multiplier while active. */
export const WORKBENCH_DAMAGE_MULT = 1.1;
/** Workbench buff duration in seconds of game time. */
export const WORKBENCH_BUFF_DURATION_S = 600;
/** Camp site interaction radius in meters. */
export const CAMP_PROMPT_RADIUS = 6;

export interface CampStructureCost {
  itemId: string;
  count: number;
}

export interface CampStructureDef {
  id: string;
  name: string;
  cost: CampStructureCost[];
  desc: string;
}

/**
 * Data-driven camp structures. ALL tuning lives here — the manager, the
 * panel and the tests read this table, never magic numbers.
 */
export const CAMP_STRUCTURE_DEFS: readonly CampStructureDef[] = [
  {
    id: 'chest',
    name: 'Storage Chest',
    cost: [
      { itemId: 'mat_scrap', count: 4 },
      { itemId: 'mat_fiber', count: 2 },
    ],
    desc: 'Player-scoped storage — deposit and withdraw items. Survives portal travel and reload.',
  },
  {
    id: 'workbench',
    name: 'Workbench',
    cost: [
      { itemId: 'mat_ore', count: 4 },
      { itemId: 'mat_scrap', count: 4 },
    ],
    desc: 'Sharpen tools: +10% melee damage for 10 minutes (game time) when activated.',
  },
  {
    id: 'rest',
    name: 'Rest Point',
    cost: [
      { itemId: 'mat_fiber', count: 4 },
      { itemId: 'mat_scrap', count: 2 },
    ],
    desc: 'Rest to restore HP to full, exactly.',
  },
];

export function campStructureDefOf(id: string): CampStructureDef | undefined {
  return CAMP_STRUCTURE_DEFS.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// UPGRADE LOOP (camp-upgrades): structure upgrade tiers — data-driven,
// same pattern as the base defs. Tier 0 is the base build (the defs
// above); this table holds upgrade tiers 1..N only. ALL tuning lives
// here — the manager, the panel and the tests read this table, never
// magic numbers. Costs use the existing tier-1 materials only.
// ---------------------------------------------------------------------------

export interface CampStructureTier {
  tier: number;
  cost: CampStructureCost[];
  /** chest: total units the chest can hold at this tier */
  capacity?: number;
  /** workbench: melee multiplier at this tier */
  damageMult?: number;
  /** workbench: buff duration in game seconds at this tier */
  buffDurationS?: number;
  /** rest: rested melee bonus multiplier at this tier */
  restDamageMult?: number;
  /** rest: rested bonus duration in game seconds at this tier */
  restBuffDurationS?: number;
}

/** Base (tier 0) chest capacity in total stored units. */
export const CAMP_CHEST_BASE_CAPACITY = 100;

export const CAMP_STRUCTURE_TIERS: Record<string, readonly CampStructureTier[]> = {
  chest: [
    { tier: 1, cost: [{ itemId: 'mat_scrap', count: 6 }, { itemId: 'mat_fiber', count: 4 }], capacity: 300 },
    { tier: 2, cost: [{ itemId: 'mat_scrap', count: 10 }, { itemId: 'mat_fiber', count: 6 }, { itemId: 'mat_ore', count: 4 }], capacity: 800 },
  ],
  workbench: [
    { tier: 1, cost: [{ itemId: 'mat_ore', count: 6 }, { itemId: 'mat_scrap', count: 6 }], damageMult: 1.2, buffDurationS: 900 },
    { tier: 2, cost: [{ itemId: 'mat_ore', count: 10 }, { itemId: 'mat_scrap', count: 8 }], damageMult: 1.35, buffDurationS: 1200 },
  ],
  rest: [
    { tier: 1, cost: [{ itemId: 'mat_fiber', count: 6 }, { itemId: 'mat_scrap', count: 4 }], restDamageMult: 1.05, restBuffDurationS: 300 },
    { tier: 2, cost: [{ itemId: 'mat_fiber', count: 10 }, { itemId: 'mat_scrap', count: 6 }, { itemId: 'mat_ore', count: 2 }], restDamageMult: 1.1, restBuffDurationS: 600 },
  ],
};

/** The upgrade tier record for a structure id (tier 0 = base build). */
export function campStructureTierOf(id: string, tier: number): CampStructureTier | undefined {
  if (tier <= 0) return undefined;
  return (CAMP_STRUCTURE_TIERS[id] ?? []).find((t) => t.tier === tier);
}

/** Highest upgrade tier a structure supports (0 when it has no upgrades). */
export function campStructureMaxTier(id: string): number {
  const tiers = CAMP_STRUCTURE_TIERS[id] ?? [];
  return tiers.reduce((m, t) => Math.max(m, t.tier), 0);
}

/** Chest capacity in total stored units at a tier (0 = base). */
export function campChestCapacity(tier: number): number {
  return campStructureTierOf('chest', tier)?.capacity ?? CAMP_CHEST_BASE_CAPACITY;
}

/** Workbench multiplier + buff duration at a tier (0 = the base constants). */
export function campWorkbenchTier(tier: number): { damageMult: number; buffDurationS: number } {
  const t = campStructureTierOf('workbench', tier);
  return {
    damageMult: t?.damageMult ?? WORKBENCH_DAMAGE_MULT,
    buffDurationS: t?.buffDurationS ?? WORKBENCH_BUFF_DURATION_S,
  };
}

/** Rest-point rested bonus at a tier (0 = HP only, no bonus). */
export function campRestTier(tier: number): { damageMult: number; buffDurationS: number } {
  const t = campStructureTierOf('rest', tier);
  return {
    damageMult: t?.restDamageMult ?? 1,
    buffDurationS: t?.restBuffDurationS ?? 0,
  };
}

/**
 * Camp-anchor derivation (camp-upgrades, pure function): a discovered
 * portal map is a camp anchor when that map has at least one built camp
 * structure in the save-slot profile. The map seed for a discovered coord
 * is deriveMapSeed(worldSeed, mx, my) — the same derivation the portal
 * system uses for every map, origin included — so no new storage is
 * needed: anchors survive reload exactly as long as campBuilt does, and
 * a new world seed re-derives different seeds, so stale camps never
 * anchor. The world-map panel reads this list; travel itself is the
 * unchanged fastTravelTo pipeline, so a camp arrival's map state is
 * identical to a walked arrival by construction.
 */
export function campAnchorCoords(
  discovered: readonly MapCoord[],
  campBuilt: Record<string, string[] | undefined> | undefined | null,
  worldSeed: number,
): MapCoord[] {
  if (!campBuilt) return [];
  const out: MapCoord[] = [];
  for (const c of discovered) {
    const built = campBuilt[String(deriveMapSeed(worldSeed, c.mx, c.my))];
    if (Array.isArray(built) && built.length > 0) out.push({ mx: c.mx, my: c.my });
  }
  return out;
}

/** Minimal terrain surface the site placement needs (engine.terrain satisfies it). */
export interface CampTerrainLike {
  size: number;
  inBounds(x: number, z: number): boolean;
  heightAt(x: number, z: number): number | null;
}

/**
 * Pure camp-site position for a map seed: seeded angle + ring radius,
 * grounded via terrain.heightAt, in-bounds checked with retries. Same
 * (mapSeed, terrain) -> identical site. Exported pure so unit tests can
 * assert determinism without an engine.
 */
export function campSitePosition(
  mapSeed: number,
  terrain: CampTerrainLike | null | undefined,
): THREE.Vector3 {
  const rng = new Rng((mapSeed ^ CAMP_SALT) >>> 0);
  const half = terrain ? terrain.size / 2 : 256;
  const minR = 30;
  const maxR = Math.max(60, half * 0.45);
  if (terrain) {
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(minR, maxR);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (!terrain.inBounds(x, z)) continue;
      const y = terrain.heightAt(x, z) ?? 0;
      return new THREE.Vector3(x, y, z);
    }
  }
  // No terrain (headless unit tests) or no in-bounds slot found: fall back
  // to a deterministic ring point, still grounded when terrain exists.
  const a = rng.range(0, Math.PI * 2);
  const d = rng.range(minR, maxR);
  const x = Math.cos(a) * d;
  const z = Math.sin(a) * d;
  const y = terrain ? (terrain.heightAt(x, z) ?? 0) : 0;
  return new THREE.Vector3(x, y, z);
}

/** Seeded structure offsets around the site (deterministic per map seed). */
function structureOffset(id: string, mapSeed: number): [number, number] {
  const base: Record<string, [number, number]> = {
    chest: [2.6, 1.8],
    workbench: [-2.8, 1.2],
    rest: [0.2, -3.2],
  };
  const b = base[id] ?? [0, 0];
  const rng = new Rng((mapSeed ^ CAMP_SALT ^ 0x51e) >>> 0);
  return [b[0] + rng.range(-0.3, 0.3), b[1] + rng.range(-0.3, 0.3)];
}

// ---------------------------------------------------------------------------
// Voxel builders — blocky props, deterministic jitter from the site rng
// ---------------------------------------------------------------------------

interface BuildCtx extends VoxelBuildCtx {
  pal: VoxelPalette;
  rng: Rng;
}

function buildSiteTent(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  // stone fire ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    voxelPart(ctx, g, 0.34, 0.3, 0.34, p.rockDark, 0.9, Math.cos(a) * 0.85, 0.15, Math.sin(a) * 0.85, { rotY: a });
  }
  // crossed tent poles + canvas slabs
  voxelPart(ctx, g, 0.18, 2.2, 0.18, p.woodDark, 0.9, -0.9, 1.1, 0, { rotZ: 0.5 });
  voxelPart(ctx, g, 0.18, 2.2, 0.18, p.woodDark, 0.9, 0.9, 1.1, 0, { rotZ: -0.5 });
  voxelPart(ctx, g, 2.2, 0.12, 1.6, p.wood, 0.9, 0, 1.9, 0, { rotY: 0.2 });
  // amber fire glint — the shared accent role, zero new materials
  voxelPart(ctx, g, 0.28, 0.5, 0.28, '', 0.3, 0, 0.6, 0, { amber: true, shadow: false });
}

function buildChestProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.4, 0.7, 0.9, p.woodDark, 0.9, 0, 0.35, 0);
  voxelPart(ctx, g, 1.4, 0.3, 0.9, p.wood, 0.9, 0, 0.85, 0);
  voxelPart(ctx, g, 0.2, 0.15, 0.2, p.metal, 0.6, 0, 0.95, 0.46);
  voxelPart(ctx, g, 1.44, 0.1, 0.94, p.metal, 0.6, 0, 0.12, 0);
}

function buildWorkbenchProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.8, 0.18, 0.9, p.wood, 0.9, 0, 0.95, 0);
  for (const [lx, lz] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]] as const) {
    voxelPart(ctx, g, 0.16, 0.95, 0.16, p.woodDark, 0.9, lx, 0.48, lz);
  }
  voxelPart(ctx, g, 1.2, 0.1, 0.5, p.metal, 0.6, 0, 1.08, 0);
  voxelPart(ctx, g, 0.3, 0.3, 0.3, '', 0.3, 0.6, 1.2, 0.2, { amber: true, shadow: false });
}

function buildRestProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.9, 0.18, 0.9, p.woodDark, 0.9, 0, 0.1, 0);
  voxelPart(ctx, g, 1.8, 0.22, 0.8, p.leaf, 0.95, 0, 0.28, 0);
  voxelPart(ctx, g, 0.5, 0.3, 0.7, p.rock, 0.85, -0.6, 0.4, 0, { rotY: 0.3 });
}

// ---------------------------------------------------------------------------
// Tier visuals (camp-tier-visuals) — presentation ONLY. The tier table in
// CAMP_STRUCTURE_TIERS still owns every capability (capacity, buffs, rest
// math); this table owns only what a tier LOOKS like. Each tier's extras
// are appended AFTER the base prop, so base-part jitter is identical at
// every tier, and every extra reuses an exact (dimensions, palette role,
// roughness) pair already present in a camp prop — same shared geometry
// cache key, same instancer bucket — so a tier change adds instances,
// never buckets. Chest: a taller stack (capacity made visible). Workbench:
// more plates, shelves and amber glow (detail made visible). Rest: a
// thicker bed, ground lanterns, then a canopy (comfort made visible).
// ---------------------------------------------------------------------------

/** Palette roles a tier-visual extra can use ('amber' = the shared glow role). */
type CampTierVisualRole = 'wood' | 'woodDark' | 'metal' | 'leaf' | 'rock' | 'amber';

interface CampTierVisualPartSpec {
  w: number; h: number; d: number;
  role: CampTierVisualRole;
  roughness: number;
  x: number; y: number; z: number;
  rotY?: number;
  rotZ?: number;
}

/**
 * Tier extras per structure: index 0 = the parts tier 1 adds over the
 * base prop, index 1 = the parts tier 2 adds over tier 1. Cumulative.
 * Kept as data so the pure descriptor below and the builders can never
 * drift apart — the unit tests assert CampProp geometry against this
 * table exactly.
 */
const CAMP_TIER_VISUAL_EXTRAS: Record<string, readonly (readonly CampTierVisualPartSpec[])[]> = {
  chest: [
    // Tier 1: a second chest stacked on the first.
    [
      { w: 1.4, h: 0.7, d: 0.9, role: 'woodDark', roughness: 0.9, x: 0, y: 1.35, z: 0 },
      { w: 1.4, h: 0.3, d: 0.9, role: 'wood', roughness: 0.9, x: 0, y: 1.85, z: 0 },
      { w: 1.44, h: 0.1, d: 0.94, role: 'metal', roughness: 0.6, x: 0, y: 1.12, z: 0 },
      { w: 0.2, h: 0.15, d: 0.2, role: 'metal', roughness: 0.6, x: 0, y: 1.95, z: 0.46 },
    ],
    // Tier 2: a third chest on the stack + a side crate.
    [
      { w: 1.4, h: 0.7, d: 0.9, role: 'woodDark', roughness: 0.9, x: 0, y: 2.35, z: 0 },
      { w: 1.4, h: 0.3, d: 0.9, role: 'wood', roughness: 0.9, x: 0, y: 2.85, z: 0 },
      { w: 1.44, h: 0.1, d: 0.94, role: 'metal', roughness: 0.6, x: 0, y: 2.12, z: 0 },
      { w: 0.2, h: 0.15, d: 0.2, role: 'metal', roughness: 0.6, x: 0, y: 2.95, z: 0.46 },
      { w: 1.4, h: 0.7, d: 0.9, role: 'woodDark', roughness: 0.9, x: 1.15, y: 0.35, z: 0.6, rotY: 0.4 },
    ],
  ],
  workbench: [
    // Tier 1: a riser plate + a higher amber glow, a lower shelf, an anvil stone.
    [
      { w: 1.2, h: 0.1, d: 0.5, role: 'metal', roughness: 0.6, x: -0.3, y: 1.3, z: 0 },
      { w: 0.3, h: 0.3, d: 0.3, role: 'amber', roughness: 0.3, x: -0.6, y: 1.5, z: -0.2 },
      { w: 1.8, h: 0.18, d: 0.9, role: 'wood', roughness: 0.9, x: 0, y: 0.35, z: 0 },
      { w: 0.5, h: 0.3, d: 0.7, role: 'rock', roughness: 0.85, x: 0.55, y: 1.2, z: 0.15, rotY: 0.2 },
    ],
    // Tier 2: an upper shelf on posts, a still-higher amber glow, a top plate.
    [
      { w: 1.8, h: 0.18, d: 0.9, role: 'wood', roughness: 0.9, x: 0, y: 1.85, z: 0 },
      { w: 0.16, h: 0.95, d: 0.16, role: 'woodDark', roughness: 0.9, x: -0.8, y: 1.4, z: -0.35 },
      { w: 0.16, h: 0.95, d: 0.16, role: 'woodDark', roughness: 0.9, x: 0.8, y: 1.4, z: 0.35 },
      { w: 0.3, h: 0.3, d: 0.3, role: 'amber', roughness: 0.3, x: 0.6, y: 2.05, z: -0.2 },
      { w: 1.2, h: 0.1, d: 0.5, role: 'metal', roughness: 0.6, x: -0.3, y: 2.02, z: 0 },
    ],
  ],
  rest: [
    // Tier 1: a thicker bed, a pillow, a ground lantern glow.
    [
      { w: 1.8, h: 0.22, d: 0.8, role: 'leaf', roughness: 0.95, x: 0, y: 0.5, z: 0 },
      { w: 0.5, h: 0.3, d: 0.7, role: 'rock', roughness: 0.85, x: 0.6, y: 0.62, z: 0, rotY: -0.3 },
      { w: 0.28, h: 0.5, d: 0.28, role: 'amber', roughness: 0.3, x: -0.85, y: 0.25, z: 0.55 },
    ],
    // Tier 2: a third bed layer, a second lantern, canopy poles + canvas.
    [
      { w: 1.8, h: 0.22, d: 0.8, role: 'leaf', roughness: 0.95, x: 0, y: 0.72, z: 0 },
      { w: 0.28, h: 0.5, d: 0.28, role: 'amber', roughness: 0.3, x: 0.75, y: 0.25, z: -0.55 },
      { w: 0.18, h: 2.2, d: 0.18, role: 'woodDark', roughness: 0.9, x: -0.9, y: 1.1, z: 0, rotZ: 0.5 },
      { w: 0.18, h: 2.2, d: 0.18, role: 'woodDark', roughness: 0.9, x: 0.9, y: 1.1, z: 0, rotZ: -0.5 },
      { w: 2.2, h: 0.12, d: 1.6, role: 'wood', roughness: 0.9, x: 0, y: 2.0, z: 0, rotY: 0.2 },
    ],
  ],
};

/** Voxel-part counts of the tier-0 (base) prop per kind, including the site tent. */
const CAMP_BASE_VISUAL_PARTS: Record<string, number> = { site: 10, chest: 4, workbench: 7, rest: 3 };
/** Amber-glow parts in the tier-0 prop (workbench has one; the tent's fire glint is its own). */
const CAMP_BASE_VISUAL_AMBER: Record<string, number> = { site: 1, chest: 0, workbench: 1, rest: 0 };

export interface CampTierVisualCounts {
  /** Total voxel parts in the prop at this tier (base + tier extras). */
  parts: number;
  /** Amber-glow parts in the prop at this tier. */
  amberParts: number;
}

/**
 * Pure visual counts for (kind, tier) — the table the e2e asserts the
 * rendered prop against. Tier is clamped to [0, maxTier]; unknown kinds
 * report the base prop with no extras (the builder falls through to the
 * rest prop, which is the pre-existing CampProp behavior).
 */
export function campTierVisualParts(kind: string, tier: number): CampTierVisualCounts {
  const clamped = Math.max(0, Math.min(Math.floor(tier) || 0, campStructureMaxTier(kind)));
  const lists = CAMP_TIER_VISUAL_EXTRAS[kind] ?? [];
  let parts = CAMP_BASE_VISUAL_PARTS[kind] ?? CAMP_BASE_VISUAL_PARTS.rest;
  let amberParts = CAMP_BASE_VISUAL_AMBER[kind] ?? 0;
  for (let i = 0; i < clamped && i < lists.length; i++) {
    parts += lists[i].length;
    for (const s of lists[i]) if (s.role === 'amber') amberParts++;
  }
  return { parts, amberParts };
}

function buildTierVisuals(ctx: BuildCtx, g: THREE.Group, kind: string, tier: number): void {
  const lists = CAMP_TIER_VISUAL_EXTRAS[kind];
  if (!lists) return;
  const p = ctx.pal;
  const clamped = Math.max(0, Math.min(Math.floor(tier) || 0, lists.length));
  for (let i = 0; i < clamped; i++) {
    for (const s of lists[i]) {
      voxelPart(ctx, g, s.w, s.h, s.d, s.role === 'amber' ? '' : p[s.role], s.roughness, s.x, s.y, s.z, {
        amber: s.role === 'amber',
        rotY: s.rotY,
        rotZ: s.rotZ,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CampProp — one rendered camp piece (site tent or built structure)
// ---------------------------------------------------------------------------

export interface CampVisualDescriptor {
  kind: string;
  /** The visual tier the prop was built at (0 = base build). */
  tier: number;
  /** Voxel-part (mesh) count in the prop. */
  parts: number;
  /** Amber-glow parts in the prop. */
  amberParts: number;
  /** Prop height in meters (world-space bounding-box height). */
  height: number;
}

export class CampProp {
  readonly root = new THREE.Group();
  /** The instancible render root — the owner-agnostic registerEnemy path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }
  /** Structure kind this prop renders ('site' for the camp tent). */
  readonly kind: string;
  /** Visual tier this prop was built at (clamped to the kind's max tier). */
  readonly visualTier: number;
  /** Voxel-part (mesh) count in the prop. */
  readonly partCount: number;
  /** Amber-glow parts in the prop. */
  readonly amberPartCount: number;
  /** Prop height in meters, measured once at construction. */
  readonly visualHeight: number;

  /** The rendered visual descriptor — what the e2e asserts per tier. */
  visualDescriptor(): CampVisualDescriptor {
    return {
      kind: this.kind,
      tier: this.visualTier,
      parts: this.partCount,
      amberParts: this.amberPartCount,
      height: this.visualHeight,
    };
  }

  constructor(
    engine: Engine,
    kind: 'site' | string,
    position: THREE.Vector3,
    mapSeed: number,
    tier = 0,
  ) {
    this.kind = kind;
    this.visualTier = Math.max(0, Math.min(Math.floor(tier) || 0, campStructureMaxTier(kind)));
    const rng = new Rng((mapSeed ^ CAMP_SALT ^ 0x9e3779b1) >>> 0);
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: rng.fork(0xc4a9),
    };
    if (kind === 'site') buildSiteTent(ctx, this.root);
    else if (kind === 'chest') buildChestProp(ctx, this.root);
    else if (kind === 'workbench') buildWorkbenchProp(ctx, this.root);
    else buildRestProp(ctx, this.root);
    // Tier visuals are appended AFTER the base prop, so the base parts'
    // seeded jitter is identical at every tier; only extras are added.
    buildTierVisuals(ctx, this.root, kind, this.visualTier);
    this.root.rotation.y = rng.range(0, Math.PI * 2);
    this.root.position.copy(position);
    let meshes = 0;
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    this.partCount = meshes;
    const counts = campTierVisualParts(kind, this.visualTier);
    this.amberPartCount = counts.amberParts;
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    this.visualHeight = box.max.y - box.min.y;
  }
}

// ---------------------------------------------------------------------------
// CampManager — map-local lifecycle + player-scoped persistence
// ---------------------------------------------------------------------------

export interface CampManagerOpts {
  /** inventory to charge build costs / move chest items (null = camp inert) */
  inventory: () => { count(id: string): number; add(id: string, n?: number): number; remove(id: string, n?: number): number } | null;
  /** restore the player to full HP (blueprint passes avatar.heal(maxHealth)) */
  restoreHealth: () => void;
  /**
   * STATUS-EFFECTS: clear the player's statuses on rest (blueprint
   * passes avatar.clearStatuses). Optional — a camp without a status
   * system still rests exactly as before.
   */
  clearStatuses?: () => void;
  /** player feedback (blueprint passes engine.hud.toast) */
  toast: (m: string) => void;
  /** profile persistence hooks (default: the save-slot profile functions) */
  loadProfileFn?: typeof loadProfile;
  saveProfileFn?: typeof saveProfile;
}

export interface CampActionResult {
  ok: boolean;
  reason?: string;
}

export class CampManager implements MapLocalEntitySystem {
  readonly id = 'camp';
  private readonly opts: CampManagerOpts;
  private readonly instancer: NpcInstancer;
  private props: CampProp[] = [];
  private mapSeed = 0;
  private site_: THREE.Vector3 | null = null;
  private discovered_ = false;
  private built_: string[] = [];
  private chest_: Record<string, number> = {};
  /** UPGRADE LOOP (camp-upgrades): upgrade tier per structure on this map. */
  private tiers_: Record<string, number> = {};
  /** workbench buff expiry in game time (0 = inactive). Player-scoped: NOT cleared by despawnAll. */
  private buffUntil = 0;
  /** workbench multiplier snapshotted at activation (the tier's value then). */
  private buffMult = WORKBENCH_DAMAGE_MULT;
  /** rested bonus expiry in game time (0 = inactive). Player-scoped like the buff. */
  private restedUntil = 0;
  /** rested bonus multiplier snapshotted at rest time (the tier's value then). */
  private restedMult = 1;

  constructor(private readonly engine: Engine, opts: CampManagerOpts) {
    this.opts = opts;
    this.instancer = NpcInstancer.for(engine);
  }

  /** Current map's camp site (null when no map is live). */
  get site(): THREE.Vector3 | null {
    return this.site_;
  }

  /** True once the current map's site has been placed (arrival discovery). */
  get discovered(): boolean {
    return this.discovered_;
  }

  /** Structure ids built on the current map (persisted per map seed). */
  get built(): readonly string[] {
    return this.built_;
  }

  /** Live view of the player-scoped chest contents (itemId -> count). */
  get chestContents(): Record<string, number> {
    return { ...this.chest_ };
  }

  /** Current map seed (the campBuilt persistence key). */
  get currentMapSeed(): number {
    return this.mapSeed;
  }

  // --- profile persistence (player-scoped chest + per-map built list) ---

  private mapKey(): string {
    return String(this.mapSeed);
  }

  private refreshFromProfile(): void {
    try {
      const load = this.opts.loadProfileFn ?? loadProfile;
      const p = load();
      this.chest_ = { ...(p.campChest ?? {}) };
      const built = (p.campBuilt ?? {})[this.mapKey()];
      this.built_ = Array.isArray(built) ? [...built] : [];
      // camp-upgrades: restore tiers, sanitized — unknown ids dropped,
      // non-integers dropped, values clamped to the structure's max tier.
      const rawTiers = (p.campTiers ?? {})[this.mapKey()];
      this.tiers_ = {};
      if (rawTiers && typeof rawTiers === 'object') {
        for (const [id, t] of Object.entries(rawTiers)) {
          if (!this.built_.includes(id)) continue;
          if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) continue;
          this.tiers_[id] = Math.min(t, campStructureMaxTier(id));
        }
      }
    } catch {
      this.chest_ = {};
      this.built_ = [];
      this.tiers_ = {};
    }
  }

  private persist(): void {
    try {
      const load = this.opts.loadProfileFn ?? loadProfile;
      const save = this.opts.saveProfileFn ?? saveProfile;
      const p = load();
      p.campChest = { ...this.chest_ };
      p.campBuilt = { ...(p.campBuilt ?? {}), [this.mapKey()]: [...this.built_] };
      p.campTiers = { ...(p.campTiers ?? {}), [this.mapKey()]: { ...this.tiers_ } };
      save(p);
    } catch {
      /* profile persistence is best-effort; the live session state still applies */
    }
  }

  // --- structures ---

  /** Build a structure at the current camp, charging its material cost. */
  buildStructure(id: string): CampActionResult {
    const def = campStructureDefOf(id);
    if (!def) return { ok: false, reason: `Unknown camp structure ${id}.` };
    if (!this.site_) return { ok: false, reason: 'No camp site on this map.' };
    if (this.built_.includes(id)) return { ok: false, reason: `${def.name} is already built.` };
    const inv = this.opts.inventory();
    if (!inv) return { ok: false, reason: 'No inventory — cannot build.' };
    const missing = def.cost.filter((c) => inv.count(c.itemId) < c.count);
    if (missing.length) {
      const detail = missing.map((m) => `${m.itemId}: need ${m.count}, have ${inv.count(m.itemId)}`).join('; ');
      return { ok: false, reason: `Missing materials — ${detail}.` };
    }
    // consume (defensive rollback: a counted remove cannot fail, but never
    // leave a partial consume behind if it ever does).
    const consumed: CampStructureCost[] = [];
    for (const c of def.cost) {
      const removed = inv.remove(c.itemId, c.count);
      consumed.push({ itemId: c.itemId, count: removed });
      if (removed < c.count) {
        for (const r of consumed) inv.add(r.itemId, r.count);
        return { ok: false, reason: 'Materials changed mid-build; nothing consumed.' };
      }
    }
    this.built_.push(id);
    this.persist();
    this.addStructureProp(id);
    this.opts.toast(`${def.name} built at camp`);
    this.engine.audio?.play('click');
    return { ok: true };
  }

  // --- structure upgrade tiers (camp-upgrades) ---

  /** Current upgrade tier of a structure on this map (0 = base build). */
  tierOf(id: string): number {
    return this.tiers_[id] ?? 0;
  }

  /** Highest upgrade tier a structure supports. */
  maxTier(id: string): number {
    return campStructureMaxTier(id);
  }

  /** Total units the storage chest can hold at its current tier. */
  chestCapacity(): number {
    return campChestCapacity(this.tierOf('chest'));
  }

  /** Total units currently stored in the chest. */
  chestUsed(): number {
    return Object.values(this.chest_).reduce((a, b) => a + b, 0);
  }

  /**
   * Upgrade a built structure one tier, charging that tier's material
   * cost. Atomic exactly like buildStructure: unknown structure, unbuilt
   * structure, max tier, missing materials, or a mid-upgrade consume
   * shortfall all fail with nothing consumed. On success the rendered
   * prop is rebuilt at the new tier IN PLACE (no reload, no portal
   * round-trip): the old prop is unregistered/removed exactly like a
   * despawn, and a new prop at the same seeded offset is registered.
   * The tier table still owns every capability; only the visuals change.
   */
  upgradeStructure(id: string): CampActionResult {
    const def = campStructureDefOf(id);
    if (!def) return { ok: false, reason: `Unknown camp structure ${id}.` };
    if (!this.site_) return { ok: false, reason: 'No camp site on this map.' };
    if (!this.built_.includes(id)) return { ok: false, reason: `Build ${def.name} first.` };
    const next = this.tierOf(id) + 1;
    const tier = campStructureTierOf(id, next);
    if (!tier) return { ok: false, reason: `${def.name} is already at its max tier.` };
    const inv = this.opts.inventory();
    if (!inv) return { ok: false, reason: 'No inventory — cannot upgrade.' };
    const missing = tier.cost.filter((c) => inv.count(c.itemId) < c.count);
    if (missing.length) {
      const detail = missing.map((m) => `${m.itemId}: need ${m.count}, have ${inv.count(m.itemId)}`).join('; ');
      return { ok: false, reason: `Missing materials — ${detail}.` };
    }
    const consumed: CampStructureCost[] = [];
    for (const c of tier.cost) {
      const removed = inv.remove(c.itemId, c.count);
      consumed.push({ itemId: c.itemId, count: removed });
      if (removed < c.count) {
        for (const r of consumed) inv.add(r.itemId, r.count);
        return { ok: false, reason: 'Materials changed mid-upgrade; nothing consumed.' };
      }
    }
    this.tiers_[id] = next;
    this.persist();
    this.rebuildStructureProp(id);
    this.opts.toast(`${def.name} upgraded to tier ${next}`);
    this.engine.audio?.play('click');
    return { ok: true };
  }

  /** Rendered visual descriptors for the live built-structure props. */
  propVisuals(): CampVisualDescriptor[] {
    return this.props
      .filter((p) => p.kind !== 'site')
      .map((p) => p.visualDescriptor());
  }

  // --- storage chest (player-scoped) ---

  /**
   * Deposit n units from the backpack into the chest. Returns units moved.
   * Camp-upgrades capacity: a deposit never exceeds the chest's current
   * tier capacity — it moves only what fits (a full chest moves 0).
   * Existing small deposits are unaffected (base capacity is 100 units).
   */
  deposit(itemId: string, count: number): number {
    if (!this.built_.includes('chest')) return 0;
    const inv = this.opts.inventory();
    if (!inv) return 0;
    const room = this.chestCapacity() - this.chestUsed();
    if (room <= 0) return 0;
    const removed = inv.remove(itemId, Math.min(Math.max(0, count), room));
    if (removed <= 0) return 0;
    this.chest_[itemId] = (this.chest_[itemId] ?? 0) + removed;
    this.persist();
    return removed;
  }

  /**
   * Withdraw n units from the chest into the backpack. Backpack overflow
   * (add() leftover) is refunded to the chest, so a withdraw never loses
   * items. Returns units actually moved into the backpack.
   */
  withdraw(itemId: string, count: number): number {
    if (!this.built_.includes('chest')) return 0;
    const inv = this.opts.inventory();
    if (!inv) return 0;
    const have = this.chest_[itemId] ?? 0;
    const take = Math.min(Math.max(0, count), have);
    if (take <= 0) return 0;
    const leftover = inv.add(itemId, take);
    const moved = take - leftover;
    if (moved <= 0) return 0;
    this.chest_[itemId] = have - moved;
    if (this.chest_[itemId] <= 0) delete this.chest_[itemId];
    this.persist();
    return moved;
  }

  // --- rest + workbench buff ---

  /**
   * Rest at the camp's rest point: HP to full, exactly. Camp-upgrades:
   * at rest tier 1+ the rest also grants a timed rested melee bonus
   * (snapshotted from the tier, like the workbench buff).
   */
  rest(): CampActionResult {
    if (!this.built_.includes('rest')) return { ok: false, reason: 'Build the rest point first.' };
    this.opts.restoreHealth();
    // STATUS-EFFECTS: resting cleanses — additive wiring into the
    // existing rest path; the heal itself is unchanged.
    try { this.opts.clearStatuses?.(); } catch { /* cleanse must never break a rest */ }
    const bonus = campRestTier(this.tierOf('rest'));
    if (bonus.buffDurationS > 0 && bonus.damageMult !== 1) {
      this.restedMult = bonus.damageMult;
      this.restedUntil = this.engine.time + bonus.buffDurationS;
      this.opts.toast(`Rested — HP fully restored, +${Math.round((bonus.damageMult - 1) * 100)}% melee damage while rested`);
    } else {
      this.opts.toast('Rested — HP fully restored');
    }    return { ok: true };
  }

  /** True while the rested bonus is live (game time). */
  restedBuffActive(): boolean {
    return this.engine.time < this.restedUntil;
  }

  /** Seconds of rested bonus remaining (0 when inactive). */
  restedBuffRemaining(): number {
    return Math.max(0, this.restedUntil - this.engine.time);
  }

  /** Melee damage multiplier from the rested bonus (1.0 when inactive). */
  restedDamageMult(): number {
    return this.restedBuffActive() ? this.restedMult : 1;
  }

  /** Activate a built workbench's buff (tier duration, tier multiplier). */
  activateWorkbench(): CampActionResult {
    if (!this.built_.includes('workbench')) return { ok: false, reason: 'Build the workbench first.' };
    const tier = campWorkbenchTier(this.tierOf('workbench'));
    this.buffMult = tier.damageMult;
    this.buffUntil = this.engine.time + tier.buffDurationS;
    this.opts.toast(`Workbench: tools sharpened (+${Math.round((tier.damageMult - 1) * 100)}% melee damage, ${Math.round(tier.buffDurationS / 60)} min)`);
    return { ok: true };
  }

  /** True while the workbench buff is live (game time). */
  workbenchBuffActive(): boolean {
    return this.engine.time < this.buffUntil;
  }

  /** Seconds of workbench buff remaining (0 when inactive). */
  workbenchBuffRemaining(): number {
    return Math.max(0, this.buffUntil - this.engine.time);
  }

  /** Melee damage multiplier from the workbench buff (1.0 when inactive). */
  workbenchDamageMult(): number {
    return this.workbenchBuffActive() ? this.buffMult : 1;
  }

  // --- map-local lifecycle ---

  private addStructureProp(id: string): void {
    if (!this.site_) return;
    const [ox, oz] = structureOffset(id, this.mapSeed);
    const pos = this.site_.clone().add(new THREE.Vector3(ox, 0, oz));
    const terrain = this.engine.terrain as unknown as CampTerrainLike | null;
    if (terrain) pos.y = terrain.heightAt(pos.x, pos.z) ?? this.site_.y;
    const prop = new CampProp(this.engine, id, pos, this.mapSeed, this.tierOf(id));
    this.engine.scene.add(prop.root);
    this.props.push(prop);
    this.instancer.registerEnemy(prop);
  }

  /**
   * Rebuild one structure's prop at its current tier, at the same seeded
   * offset. The old prop is removed with the despawnAll pattern
   * (instancer unregister + scene removal); the next instancer frame
   * submits the new prop (CampManager.update runs every blueprint frame).
   * No-op when the structure has no live prop (e.g. upgraded while no
   * map is live — spawnForMap rebuilds at the persisted tier anyway).
   */
  private rebuildStructureProp(id: string): void {
    const idx = this.props.findIndex((p) => p.kind === id);
    if (idx < 0) return;
    const [old] = this.props.splice(idx, 1);
    try { this.instancer.unregister(old); } catch { /* never strand the rebuild */ }
    try { this.engine.scene.remove(old.root); } catch { /* never strand the rebuild */ }
    this.addStructureProp(id);
  }

  /**
   * MapLocalEntitySystem arrival path: despawn any stale payload, place
   * the deterministic site, restore the persisted structures for this
   * map seed, register the site interactable. Idempotent.
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    this.mapSeed = mapSeed;
    this.refreshFromProfile();
    const terrain = this.engine.terrain as unknown as CampTerrainLike | null;
    this.site_ = campSitePosition(mapSeed, terrain);
    this.discovered_ = true;
    const siteProp = new CampProp(this.engine, 'site', this.site_, mapSeed);
    this.engine.scene.add(siteProp.root);
    this.props.push(siteProp);
    this.instancer.registerEnemy(siteProp);
    for (const id of [...this.built_]) this.addStructureProp(id);
    this.engine.npcInteractions.register({
      id: `camp-${mapSeed}`,
      type: 'camp',
      position: this.site_.clone(),
      radius: CAMP_PROMPT_RADIUS,
      enabled: true,
      prompt: 'Visit camp',
    });
  }

  /**
   * MapLocalEntitySystem departure path: remove every live prop (instancer
   * unregister + scene removal) and the site interactable. Idempotent.
   * The workbench buff is player-scoped and intentionally NOT cleared.
   */
  despawnAll(): void {
    for (const p of this.props) {
      try { this.instancer.unregister(p); } catch { /* never strand the rest */ }
      try { this.engine.scene.remove(p.root); } catch { /* never strand the rest */ }
    }
    this.props = [];
    if (this.site_) {
      this.engine.npcInteractions.unregister(`camp-${this.mapSeed}`);
    }
    this.site_ = null;
    this.discovered_ = false;
  }

  /** Submit live props to the shared instancer (blueprint instancer frame). */
  update(): void {
    for (const p of this.props) this.instancer.submit(p);
  }
}

// ---------------------------------------------------------------------------
// CampInteractionSession — the [E] Visit camp prompt + the camp panel
// ---------------------------------------------------------------------------

export interface CampSessionOpts {
  container?: HTMLElement;
  doc?: Document;
  /** false = headless: register the prompt only, no panel (unit tests) */
  enableUi?: boolean;
  /** live player inventory (for the panel's have/need counts) */
  inventory: () => { count(id: string): number } | null;
  /** distinct backpack item ids for the panel's deposit list */
  backpackItems: () => string[];
  /** item display name (falls back to the id) */
  defName: (itemId: string) => string;
  /** true while another modal owns input (station/talk/shop chains) */
  isModalOpen?: () => boolean;
  /** live player position (default: portalsPlayerAvatar) */
  getPlayerPos?: () => THREE.Vector3;
}

const liveCampSessions = new WeakMap<Engine, CampInteractionSession>();

export class CampInteractionSession {
  private prompt: InteractionPrompt | null = null;
  private panel: CampPanel | null = null;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly camp: CampManager,
    private readonly opts: CampSessionOpts,
  ) {
    liveCampSessions.get(engine)?.dispose();
    liveCampSessions.set(engine, this);
    if (opts.enableUi === false) return;
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container ?? engine.container;
    const source: CampPanelSource = {
      structures: () => CAMP_STRUCTURE_DEFS,
      built: () => new Set(this.camp.built),
      inventoryCount: (id) => this.opts.inventory()?.count(id) ?? 0,
      chestContents: () => this.camp.chestContents,
      backpackItems: () => this.opts.backpackItems(),
      defName: (id) => this.opts.defName(id),
      buffRemaining: () => this.camp.workbenchBuffRemaining(),
      // camp-upgrades: tier indicator + upgrade path + capacity readout
      tierOf: (id) => this.camp.tierOf(id),
      maxTier: (id) => this.camp.maxTier(id),
      tierEffect: (id) => {
        const tier = this.camp.tierOf(id);
        if (id === 'chest') return `Capacity ${campChestCapacity(tier)} units`;
        if (id === 'workbench') {
          const t = campWorkbenchTier(tier);
          return `+${Math.round((t.damageMult - 1) * 100)}% melee, ${Math.round(t.buffDurationS / 60)} min`;
        }
        if (id === 'rest') {
          const t = campRestTier(tier);
          return t.buffDurationS > 0
            ? `HP to full + +${Math.round((t.damageMult - 1) * 100)}% melee while rested`
            : 'HP to full, exactly';
        }
        return '';
      },
      nextTierCost: (id) => {
        const tier = campStructureTierOf(id, this.camp.tierOf(id) + 1);
        if (!tier) return '';
        return tier.cost.map((c) => `${this.opts.defName(c.itemId)} ${this.opts.inventory()?.count(c.itemId) ?? 0}/${c.count}`).join(' · ');
      },
      chestCapacity: () => this.camp.chestCapacity(),
      chestUsed: () => this.camp.chestUsed(),
      restedRemaining: () => this.camp.restedBuffRemaining(),
      onUpgrade: (id) => {
        const r = this.camp.upgradeStructure(id);
        return r.ok ? null : (r.reason ?? 'Upgrade failed.');
      },
      onBuild: (id) => {
        const r = this.camp.buildStructure(id);
        return r.ok ? null : (r.reason ?? 'Build failed.');
      },
      onDeposit: (id, n) => this.camp.deposit(id, n),
      onWithdraw: (id, n) => this.camp.withdraw(id, n),
      onRest: () => {
        const r = this.camp.rest();
        return r.ok ? null : (r.reason ?? 'Rest failed.');
      },
      onActivateBuff: () => {
        const r = this.camp.activateWorkbench();
        return r.ok ? null : (r.reason ?? 'Workbench failed.');
      },
    };
    this.panel = new CampPanel(container, source, doc);
    this.prompt = new InteractionPrompt(container, engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      onActivate: (target) => this.openFor(target.id),
      isModalOpen: () => (this.panel?.isOpen ?? false) || (this.opts.isModalOpen?.() ?? false),
    }, doc);
  }

  private playerPos(): THREE.Vector3 {
    return this.opts.getPlayerPos?.()
      ?? this.engine.portalsPlayerAvatar?.ctrl.position
      ?? new THREE.Vector3();
  }

  /** True while the camp panel owns input (blueprints chain this into other prompts). */
  get isPanelOpen(): boolean {
    return this.panel?.isOpen ?? false;
  }

  /** The camp prompt's current target (null = none) — e2e introspection. */
  get promptedCamp(): boolean {
    return this.prompt?.currentTarget?.type === 'camp';
  }

  /** Open the panel for the current camp (the [E] activation path). */
  openFor(interactableId: string): boolean {
    if (!this.panel || !this.camp.site) return false;
    if (!interactableId.startsWith('camp-')) return false;
    this.panel.open();
    return true;
  }

  /** Open the panel directly (e2e / programmatic path). */
  open(): boolean {
    if (!this.panel || !this.camp.site) return false;
    this.panel.open();
    return true;
  }

  /** Per-frame: refresh the [E] prompt. */
  update(): void {
    if (this.disposed) return;
    this.prompt?.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prompt?.dispose();
    this.prompt = null;
    this.panel?.dispose();
    this.panel = null;
    if (liveCampSessions.get(this.engine) === this) liveCampSessions.delete(this.engine);
  }
}
