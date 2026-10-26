/**
 * UPGRADE LOOP (character-customization): player character cosmetics.
 *
 * Cosmetics ONLY — they never alter stats, hitboxes, damage, speed, or any
 * behavior contract. The whole tuning surface lives in this one file:
 *
 *   - VISOR_COLORS: glow colors for the visor slit / accent emissive.
 *   - OUTFIT_SKIN_IDS: built-in skin ids offered as outfits, in display
 *     order. The special outfit `null` (shown as "Spec default") applies
 *     NO skin, so a player who never touches customization keeps the exact
 *     legacy look (palette-derived colors, no armor) — identity default.
 *   - TRIM_COLORS: pauldron-trim colors (recolor the accent-role materials
 *     — pauldrons, bands, cape cloth all speak accent in this rig).
 *   - Accessories: scarf / hood, rendered through the EXISTING voxel cape
 *     system (mantle drape / hooded cowl), never new geometry of our own.
 *
 * Rendering channels (all pre-existing figure buckets — no new material
 * programs, no new instancing buckets):
 *   outfit -> applySkin (skin palette/emissive/armor, as the skin system
 *     already does for spec skins)
 *   visor  -> emissive override on owned, already-glowing materials
 *     (armor glow slits + accent role). Shared library glow materials are
 *     NEVER touched — a visor change on an armor-free rig tints the accent
 *     emissive only, which is the honest limit of the channel.
 *   trim   -> color override on owned accent/accentDS role materials
 *   scarf  -> voxel cape, variant 'mantle' (short shoulder drape)
 *   hood   -> voxel cape, variant 'hooded' (drape + cowl); hood wins over
 *     scarf because the cape system holds one cape at a time
 *
 * Everything here never throws and is a no-op on untagged/imported rigs
 * (same floor as applySkin). Cosmetic state itself lives in Profile
 * (`cosmetics`, per save slot) — see Profile.ts.
 */

import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { CharacterRig } from '../gfx/Characters';
import { BUILT_IN_SKINS, resolveSkinDef, applySkin, skinOptionsForSpec } from '../gfx/Skins';
import { applyVoxelCape, clearVoxelCape } from '../gfx/VoxelArmor';

/** One visor glow color. `hex` must be #rrggbb; anything else is ignored. */
export interface VisorColorDef {
  id: string;
  name: string;
  hex: string;
}

export const VISOR_COLORS: readonly VisorColorDef[] = [
  { id: 'cyan', name: 'Cyan', hex: '#35e0ff' },
  { id: 'amber', name: 'Amber', hex: '#ffd23f' },
  { id: 'ember', name: 'Ember', hex: '#ff6a2e' },
  { id: 'crimson', name: 'Crimson', hex: '#ff4433' },
  { id: 'venom', name: 'Venom', hex: '#4dff6a' },
  { id: 'magenta', name: 'Magenta', hex: '#ff2fd6' },
  { id: 'violet', name: 'Violet', hex: '#9f7bff' },
  { id: 'ghost', name: 'Ghost', hex: '#e8f4ff' },
];

export const VISOR_IDS = VISOR_COLORS.map((v) => v.id);
export const DEFAULT_VISOR = 'cyan';

/** One trim color (pauldron trim = accent-role recolor). */
export interface TrimColorDef {
  id: string;
  name: string;
  hex: string;
}

export const TRIM_COLORS: readonly TrimColorDef[] = [
  { id: 'gold', name: 'Gold', hex: '#d8a428' },
  { id: 'silver', name: 'Silver', hex: '#9aa0ad' },
  { id: 'ember', name: 'Ember', hex: '#e08a2e' },
  { id: 'crimson', name: 'Crimson', hex: '#c23b2e' },
  { id: 'teal', name: 'Teal', hex: '#2e7f8a' },
  { id: 'violet', name: 'Violet', hex: '#7a5ac8' },
];

export const TRIM_IDS = TRIM_COLORS.map((t) => t.id);

/**
 * Outfits offered in the panel, in display order. Every id must exist in
 * BUILT_IN_SKINS (verified by unit test); unknown ids are dropped by
 * validateCosmetics, never rendered.
 */
export const OUTFIT_SKIN_IDS: readonly string[] = [
  'crimson', 'stealth', 'gold', 'neonstreet', 'rustscrap', 'spectral',
  'royalguard', 'desertnomad', 'abyssal', 'solarpaladin', 'cyberronin',
  'nomad', 'desert-raider', 'emerald-guardian', 'void-scout',
];

/** Display name for an outfit id (built-in skin name, or the id itself). */
export function outfitName(id: string): string {
  return BUILT_IN_SKINS[id]?.name ?? id;
}

/**
 * The player's cosmetic selection. All fields are cosmetic-only.
 * `outfit: null` = spec default (no skin applied — the identity default).
 * `visor: null` = the outfit's own glow (no override).
 * `trim: null` = the outfit's own accent color (no override).
 */
export interface CosmeticSelection {
  /** visor glow color id, or null for the outfit default */
  visor: string | null;
  /** built-in skin id for the outfit, or null for spec default */
  outfit: string | null;
  /** mantle drape on/off */
  scarf: boolean;
  /** hooded cowl on/off (wins over scarf — one cape at a time) */
  hood: boolean;
  /** pauldron-trim color id, or null for the outfit default */
  trim: string | null;
}

/** The identity selection: changes nothing on any rig. */
export function defaultCosmetics(): CosmeticSelection {
  return { visor: null, outfit: null, scarf: false, hood: false, trim: null };
}

/** Validate an unknown value into a CosmeticSelection. Never throws. */
export function validateCosmetics(raw: unknown): CosmeticSelection {
  const base = defaultCosmetics();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const visor = typeof r.visor === 'string' && VISOR_IDS.includes(r.visor) ? r.visor : null;
  const outfit = typeof r.outfit === 'string' && OUTFIT_SKIN_IDS.includes(r.outfit)
    ? r.outfit : null;
  const trim = typeof r.trim === 'string' && TRIM_IDS.includes(r.trim) ? r.trim : null;
  return {
    visor,
    outfit,
    scarf: r.scarf === true,
    hood: r.hood === true,
    trim,
  };
}

const isHex = (s: unknown): s is string =>
  typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

/** Owned, role-tagged materials under a rig root, by role. */
function roleMaterials(root: THREE.Object3D): Map<string, THREE.MeshStandardMaterial[]> {
  const map = new Map<string, THREE.MeshStandardMaterial[]>();
  try {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of mats) {
        const mat = mm as THREE.MeshStandardMaterial | undefined;
        const role = mat?.userData?.role;
        if (mat && mat.userData.owned && typeof role === 'string' && 'color' in mat) {
          const list = map.get(role) ?? [];
          if (!list.includes(mat)) list.push(mat);
          map.set(role, list);
        }
      }
    });
  } catch { /* traversal failure → empty map → no-op below */ }
  return map;
}

/**
 * Apply a cosmetic selection to a rig, on top of whatever skin the rig
 * already wears. Order matters: outfit (full skin) → visor (emissive) →
 * trim (accent color) → cape (scarf/hood). Never throws; no-op on rigs
 * without role tags. Idempotent: re-applying the same selection restores
 * the same look (applySkin strips + re-applies skin-origin armor; the
 * cape application replaces any previous voxel cape).
 *
 * `spec` is only needed to resolve custom skins for the outfit id; outfits
 * are built-in ids, so callers without a spec still get the full effect.
 */
export function applyCosmeticsToRig(
  rig: { group: THREE.Object3D },
  cosmetics: CosmeticSelection,
  spec?: GameSpec,
): void {
  try {
    const c = validateCosmetics(cosmetics);
    const roles = roleMaterials(rig.group);
    if (roles.size === 0) return; // imported rig — procedural-only, like skins
    const cRig = rig as CharacterRig;

    // (1) outfit — a full skin application (palette, emissive, armor).
    if (c.outfit) {
      const def = spec ? resolveSkinDef(spec, c.outfit) : BUILT_IN_SKINS[c.outfit];
      if (def) applySkin(cRig, def, spec ? skinOptionsForSpec(spec) : undefined);
    }

    // Re-read roles after the skin swap (armor application adds materials).
    const after = roleMaterials(rig.group);

    // (2) visor — emissive override on accent roles + any owned material
    // that already glows (armor glow slits). Shared library materials are
    // never owned, so they are never touched here.
    if (c.visor) {
      const v = VISOR_COLORS.find((x) => x.id === c.visor);
      if (v && isHex(v.hex)) {
        const col = new THREE.Color(v.hex);
        for (const mat of [...(after.get('accent') ?? []), ...(after.get('accentDS') ?? [])]) {
          try { mat.emissive.copy(col); mat.emissiveIntensity = 1.2; } catch { /* skip */ }
        }
        // Armor glow slits: owned materials with a non-black emissive.
        try {
          rig.group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mm of mats) {
              const mat = mm as THREE.MeshStandardMaterial;
              // Role-tagged mats were handled above (accent emissive stays
              // 1.2); this pass is only for untagged armor glow slits.
              if (!mat?.userData?.owned || typeof mat.userData.role === 'string') continue;
              if (!('emissive' in mat)) continue;
              if (!mat.emissive || (mat.emissive as THREE.Color).getHex() === 0x000000) continue;
              try { (mat.emissive as THREE.Color).copy(col); mat.emissiveIntensity = 2.2; } catch { /* skip */ }
            }
          });
        } catch { /* decorative */ }
      }
    }

    // (3) trim — accent-role color override (pauldrons, bands, cape cloth
    // all speak accent). Emissive from step (2) is left alone.
    if (c.trim) {
      const t = TRIM_COLORS.find((x) => x.id === c.trim);
      if (t && isHex(t.hex)) {
        for (const mat of [...(after.get('accent') ?? []), ...(after.get('accentDS') ?? [])]) {
          try { mat.color.set(t.hex); } catch { /* skip */ }
        }
      }
    }

    // (4) scarf / hood — the existing voxel cape system, origin 'skin'
    // (same origin the skin system uses, so a re-skin never orphans it).
    if (c.hood) {
      applyVoxelCape(cRig, { variant: 'hooded', origin: 'skin' });
    } else if (c.scarf) {
      applyVoxelCape(cRig, { variant: 'mantle', origin: 'skin' });
    } else {
      clearVoxelCape(cRig, 'skin');
    }
  } catch {
    // cosmetics must never break the game — a bad selection is a no-op
  }
}

/** Mesh count under a rig root (perf honesty: cape/armor mesh deltas). */
export function countRigMeshes(rig: { group: THREE.Object3D }): number {
  let n = 0;
  try {
    rig.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
  } catch { /* count what we can */ }
  return n;
}
