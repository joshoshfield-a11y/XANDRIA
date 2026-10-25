/**
 * Item skins (inventory wave) — the Skins.ts pattern mirrored for items.
 *
 * An item mesh stamps its materials with userData.role in
 * 'primary' | 'secondary' | 'glow' (ITEM_SKIN_ROLES, see schema.ts ItemDef/
 * ItemSkinDef — the contract committed in 513fa6a, not changed here).
 *
 * Rules (same discipline as character skins):
 *  - Only owned, role-tagged materials are ever mutated — the MaterialLibrary
 *    cache and any shared gear materials are never touched. Meshes without
 *    role tags (imported GLB meshes) are a no-op.
 *  - NEVER throws: invalid colors are skipped, texture failures fall back to
 *    the plain palette. The procedural look is the floor.
 *  - Precedence: an explicit item skin in `custom.items.defs.<id>.skin` WINS
 *    over the mesh's authored defaults. `resolveItemSkinDef` merges
 *    `custom.items.skins` over the built-ins. Unknown ids → undefined
 *    (caller keeps the mesh default).
 *
 * Pattern textures reuse the same deterministic 128px canvas painters as
 * character skins (makePatternTexture from Skins.ts) — the schema shares the
 * SkinTexturePattern set between the two.
 */
import * as THREE from 'three';
import { bakedTexture, bakedNormalTexture } from './BakedTextures';
import { TextureLoader } from 'three';
import {
  type GameSpec, type ItemSkinDef, type ItemSkinRole,
  ITEM_SKIN_ROLES,
} from '@spec';
import { makePatternTexture } from './Skins';

export const BUILT_IN_ITEM_SKINS: Record<string, ItemSkinDef> = {
  iron: {
    name: 'Iron',
    palette: { primary: '#8a8d91', secondary: '#5a5d63', glow: '#d8d8d8' },
    texture: { baked: 'item-brushed' },
    roughness: 0.45,
    metalness: 0.8,
  },
  steel: {
    name: 'Steel',
    palette: { primary: '#b9c0c9', secondary: '#6d7684', glow: '#e8f2ff' },
    roughness: 0.3,
    metalness: 0.9,
    texture: { baked: 'item-brushed' },
  },
  gold: {
    name: 'Gold',
    palette: { primary: '#d4a017', secondary: '#8a6a1f', glow: '#ffd700' },
    texture: { baked: 'item-brushed' },
    emissive: { color: '#ffd700', intensity: 0.3 },
    roughness: 0.35,
    metalness: 0.95,
  },
  ember: {
    name: 'Ember',
    palette: { primary: '#3a2a22', secondary: '#1f1410', glow: '#ff5a1f' },
    emissive: { color: '#ff5a1f', intensity: 1.6 },
    roughness: 0.7,
    metalness: 0.3,
    texture: { baked: 'accent-hazard' },
    textureRoles: ['secondary'],
  },
  frost: {
    name: 'Frost',
    palette: { primary: '#bcd8e8', secondary: '#6a8aa8', glow: '#9ff2ff' },
    emissive: { color: '#9ff2ff', intensity: 1.2 },
    roughness: 0.25,
    metalness: 0.1,
    texture: { baked: 'item-brushed' },
  },
  shadow: {
    name: 'Shadow',
    palette: { primary: '#1a1d24', secondary: '#0e1014', glow: '#8a2fd6' },
    emissive: { color: '#8a2fd6', intensity: 1.0 },
    roughness: 0.6,
    metalness: 0.5,
    texture: { baked: 'item-brushed' },
  },
  verdant: {
    name: 'Verdant',
    palette: { primary: '#3f7a3f', secondary: '#24401f', glow: '#4dff6a' },
    emissive: { color: '#4dff6a', intensity: 0.6 },
    roughness: 0.8,
    metalness: 0.15,
    texture: { baked: 'fabric-camo' },
  },
  storm: {
    name: 'Storm',
    palette: { primary: '#4a5a7a', secondary: '#2e3a52', glow: '#35e0ff' },
    emissive: { color: '#35e0ff', intensity: 1.4 },
    roughness: 0.4,
    metalness: 0.6,
    texture: { baked: 'item-brushed' },
    textures: { glow: { baked: 'item-energy' } },
  },
};

/** All item-skin ids the engine will honor: built-ins, custom spec skins overriding on collision. */
export function availableItemSkinIds(spec: GameSpec): string[] {
  const ids = new Set<string>(Object.keys(BUILT_IN_ITEM_SKINS));
  const custom = spec.custom?.items?.skins;
  if (custom) for (const id of Object.keys(custom)) ids.add(id);
  return [...ids];
}

/** Resolve an item-skin id → ItemSkinDef. Custom spec skins win over built-ins. Unknown ids → undefined. */
export function resolveItemSkinDef(spec: GameSpec, id: string | undefined): ItemSkinDef | undefined {
  if (!id) return undefined;
  return spec.custom?.items?.skins?.[id] ?? BUILT_IN_ITEM_SKINS[id];
}

/** role → owned, role-tagged materials under the mesh root */
function roleMaterials(root: THREE.Object3D): Map<string, THREE.MeshStandardMaterial[]> {
  const map = new Map<string, THREE.MeshStandardMaterial[]>();
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
  return map;
}

const isHex = (s: unknown): s is string =>
  typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

const TEX_URL_RE = /^https:\/\/[^?#]+\.(png|jpe?g|webp)(\?.*)?$/i;
const textureLoader = new TextureLoader();

const VALID_ROLES: readonly string[] = ITEM_SKIN_ROLES;

/**
 * Apply an item skin to an item mesh. Mutates only owned, role-tagged
 * materials — shared library materials are never touched (unit-tested).
 * Unmapped roles keep the mesh defaults. Never throws.
 */
export function applyItemSkin(mesh: THREE.Object3D, skin: ItemSkinDef): void {
  try {
    if (!mesh || !skin) return;
    const roles = roleMaterials(mesh);
    if (roles.size === 0) return; // e.g. an imported GLB mesh — item skins are procedural-only
    const all = [...roles.values()].flat();

    // palette → per-role colors
    if (skin.palette) {
      for (const [role, hex] of Object.entries(skin.palette)) {
        if (!isHex(hex)) continue;
        for (const mat of roles.get(role) ?? []) {
          try { mat.color.set(hex); } catch { /* skip */ }
        }
      }
    }
    if (typeof skin.roughness === 'number' && Number.isFinite(skin.roughness))
      for (const mat of all) mat.roughness = THREE.MathUtils.clamp(skin.roughness, 0, 1);
    if (typeof skin.metalness === 'number' && Number.isFinite(skin.metalness))
      for (const mat of all) mat.metalness = THREE.MathUtils.clamp(skin.metalness, 0, 1);
    // emissive → the glow role (runes, gems, edge trim)
    if (skin.emissive && isHex(skin.emissive.color)) {
      const inten = THREE.MathUtils.clamp(skin.emissive.intensity ?? 0, 0, 5);
      for (const mat of roles.get('glow') ?? []) {
        try { mat.emissive.set(skin.emissive!.color); mat.emissiveIntensity = inten; } catch { /* skip */ }
      }
    }

    // texture → textureRoles (default primary+secondary). URL loads async;
    // on any failure the palette stands.
    const texRoles = (skin.textureRoles?.length ? skin.textureRoles : (['primary', 'secondary'] as ItemSkinRole[]))
      .filter((r) => VALID_ROLES.includes(r));
    const applyTex = (tex: THREE.Texture) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      for (const mat of texRoles.flatMap((r) => roles.get(r) ?? [])) {
        try { mat.map = tex; mat.needsUpdate = true; } catch { /* skip */ }
      }
    };
    const t = skin.texture;
    if (t && 'baked' in t && typeof t.baked === 'string') {
      const tex = bakedTexture(t.baked);
      if (tex) {
        const nrm = bakedNormalTexture(t.baked);
        if (nrm) {
          // applyTex stamps map only; stamp the normal twin on the same roles
          const prev = texRoles.flatMap((r) => roles.get(r) ?? []);
          applyTex(tex);
          for (const mat of prev) { try { mat.normalMap = nrm; mat.needsUpdate = true; } catch { /* skip */ } }
        } else applyTex(tex);
      }
    } else if (t && 'pattern' in t) {
      const tex = makePatternTexture(t.pattern);
      if (tex) applyTex(tex);
    } else if (t && 'url' in t && typeof t.url === 'string' && TEX_URL_RE.test(t.url)) {
      textureLoader.load(t.url, applyTex, undefined, () => { /* procedural fallback: palette stands */ });
    }
    // Per-role baked textures (Pass A): override the main texture on that role only.
    if (skin.textures) {
      for (const [role, rt] of Object.entries(skin.textures)) {
        if (!rt || !('baked' in rt) || typeof rt.baked !== 'string') continue;
        const rtex = bakedTexture(rt.baked);
        if (!rtex) continue;
        const rnorm = bakedNormalTexture(rt.baked);
        for (const mat of roles.get(role) ?? []) {
          try {
            mat.map = rtex;
            if (rnorm) mat.normalMap = rnorm;
            mat.needsUpdate = true;
          } catch { /* skip */ }
        }
      }
    }
  } catch {
    // item skins must never break generation — a bad skin is a no-op
  }
}
