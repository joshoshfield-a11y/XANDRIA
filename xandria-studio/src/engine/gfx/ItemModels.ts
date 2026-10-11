/**
 * Procedural item meshes (inventory wave) — ItemModelForge.
 *
 * meshFor(def) builds a low-poly item mesh synchronously from the ItemDef,
 * with role-tagged owned materials (userData.role = primary|secondary|glow)
 * so ItemSkins.applyItemSkin can restyle them. All meshes castShadow.
 *
 * Item-kind mapping (documented):
 *  - type 'weapon': name keywords decide the model (first match wins):
 *      axe     ← axe, hatchet, cleaver, tomahawk, halberd
 *      staff   ← staff, rod, wand, scepter/sceptre, totem, baton
 *      bow     ← bow, longbow, recurve, crossbow
 *      dagger  ← dagger, knife, shiv, dirk, kunai
 *      mace    ← mace, hammer, maul, club, flail
 *      sword   ← sword, katana, saber/sabre, longsword, claymore, cutlass,
 *                 blade, scimitar, rapier, spear, pike, lance, greatsword
 *      no keyword → sword (the generic blade)
 *  - type 'armor': def.slot decides — head→helmet, torso→chestplate,
 *      legs→greaves, accessory→shield. Missing slot → chestplate.
 *  - type 'consumable' → flask (bottle + glowing liquid)
 *  - type 'material'   → ingot if the name has ingot|bar|ore|metal, else crystal
 *  - type 'key'        → ornate key
 *  - type 'trinket'    → charm (ring + glow gem)
 *  - anything else     → glowing shard fallback (never throws, never empty)
 *
 * Model space conventions (EquipRig mounts these):
 *  - weapons: grip at origin, business end along +Y
 *  - helmet: centered on the head pivot (head sphere center), faces +Z
 *  - chestplate/shield: torso-pivot local (torso top at +0.36), faces +Z
 *  - greaves: character-local, feet at origin (standard-archetype proportions)
 *  - flask/crystal/ingot/key/charm: feet at origin, ~0.5 m tall
 *
 * Rarity: applyRarityTrim stamps RARITY_GLOW onto glow-role materials
 * (common gets a faint trim, higher rarities a full emissive pop). An
 * explicit item skin applied afterwards wins over the rarity default.
 *
 * GLB override: def.model (https .glb/.gltf) — meshForAsync returns the
 * procedural mesh immediately and swaps in the normalized GLB when (if) it
 * loads, following the RigAdapter fail-closed pattern: any failure keeps the
 * procedural mesh. Never throws.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  isGlbUrl,
  type GameSpec, type ItemDef, type ItemRarity, type ItemSkinRole, type QualityMode,
} from '@spec';
import { Rng, hashString } from '../core/Rng';
import { disposeOwned } from './Characters';
import { applyItemSkin, resolveItemSkinDef, BUILT_IN_ITEM_SKINS } from './ItemSkins';

/** The runtime crew defined this shape; ItemModelForge satisfies it structurally (extra optional params allowed). */
export interface ItemMeshFactory {
  meshFor(def: ItemDef): THREE.Object3D;
}

/** Rarity ladder → glow trim color. Defined identically to the shared contract. */
export const RARITY_GLOW: Record<ItemRarity, string> = {
  common: '#9a9a9a',
  uncommon: '#4dff6a',
  rare: '#4da6ff',
  epic: '#c97aff',
  legendary: '#ffb13d',
};

export type ItemKind =
  | 'sword' | 'axe' | 'staff' | 'bow' | 'dagger' | 'mace'
  | 'helmet' | 'chestplate' | 'greaves' | 'shield'
  | 'flask' | 'crystal' | 'ingot' | 'key' | 'charm' | 'shard';

// ---------------------------------------------------------------- helpers

/** Quality → radial segment count (respects the retro/standard/high tier). */
function detailFor(quality: QualityMode | undefined): number {
  return quality === 'retro' ? 5 : quality === 'high' ? 12 : 8;
}

/** Owned, role-tagged standard material for item meshes. */
function imat(hex: string, role: ItemSkinRole, opts: { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: hex,
    roughness: opts.roughness ?? 0.5,
    metalness: opts.metalness ?? 0.4,
  });
  if (opts.emissive) {
    m.emissive.set(opts.emissive);
    m.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  m.userData.owned = true;
  m.userData.role = role;
  return m;
}

/** Faceted low-poly finish (de-index so flat normals survive — matches the character look). */
function faceted<T extends THREE.BufferGeometry>(g: T): T {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  return ng as T;
}

function imesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(faceted(geo), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

interface Kit {
  primary: THREE.MeshStandardMaterial;
  secondary: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  seg: number;
  rng: Rng;
}

/** Default item look: iron + dark grip + warm glow (skins/rarity override). */
function makeKit(def: ItemDef, quality: QualityMode | undefined): Kit {
  return {
    primary: imat('#8a8d91', 'primary', { roughness: 0.45, metalness: 0.8 }),
    secondary: imat('#5a5d63', 'secondary', { roughness: 0.7, metalness: 0.5 }),
    glow: imat('#d8d8d8', 'glow', { roughness: 0.3, metalness: 0.2, emissive: '#ffd23f', emissiveIntensity: 0.6 }),
    seg: detailFor(quality),
    rng: new Rng(hashString(def.name || 'item')),
  };
}

// ---------------------------------------------------------------- weapons (grip at origin, +Y business end)

function buildSword(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.032, 0.036, 0.24, s), k.secondary, 0, 0.12, 0)); // grip
  g.add(imesh(new THREE.SphereGeometry(0.04, s, 6), k.glow, 0, -0.02, 0)); // pommel gem
  g.add(imesh(new THREE.CylinderGeometry(0.10, 0.10, 0.035, s), k.secondary, 0, 0.255, 0)); // guard
  const blade = imesh(new THREE.CylinderGeometry(0.012, 0.055, 0.95, 4), k.primary, 0, 0.75, 0);
  blade.rotation.y = Math.PI / 4;
  g.add(blade);
  const tip = imesh(new THREE.ConeGeometry(0.055, 0.16, 4), k.primary, 0, 1.30, 0);
  tip.rotation.y = Math.PI / 4;
  g.add(tip);
  const rune = imesh(new THREE.OctahedronGeometry(0.028), k.glow, 0, 0.255, 0.10); // guard gem
  g.add(rune);
  return g;
}

function buildAxe(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.026, 0.03, 0.9, s), k.secondary, 0, 0.45, 0));
  g.add(imesh(new THREE.SphereGeometry(0.035, s, 6), k.glow, 0, 0.02, 0));
  const head = imesh(new THREE.CylinderGeometry(0.15, 0.05, 0.30, 4), k.primary, 0.13, 0.74, 0);
  head.rotation.z = -Math.PI / 2; head.rotation.y = Math.PI / 4; // fan the blade sideways
  g.add(head);
  const spike = imesh(new THREE.ConeGeometry(0.045, 0.16, 6), k.primary, -0.10, 0.74, 0);
  spike.rotation.z = Math.PI / 2;
  g.add(spike);
  g.add(imesh(new THREE.OctahedronGeometry(0.03), k.glow, 0.05, 0.74, 0.0));
  return g;
}

function buildStaff(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.026, 0.032, 1.5, s), k.secondary, 0, 0.75, 0));
  const foot = imesh(new THREE.ConeGeometry(0.05, 0.14, 6), k.primary, 0, 0.05, 0);
  foot.rotation.x = Math.PI;
  g.add(foot);
  g.add(imesh(new THREE.TorusGeometry(0.095, 0.022, 6, s * 2), k.primary, 0, 1.56, 0));
  g.add(imesh(new THREE.SphereGeometry(0.075, s, 8), k.glow, 0, 1.56, 0)); // focus orb
  return g;
}

function buildBow(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  const limb = imesh(new THREE.TorusGeometry(0.52, 0.028, 6, s * 3, 2.35), k.primary, 0, 0.62, 0);
  limb.rotation.z = Math.PI / 2 - 2.35 / 2; // arc opening toward +Z… rotated to vertical
  limb.rotation.y = Math.PI / 2;
  g.add(limb);
  g.add(imesh(new THREE.CylinderGeometry(0.032, 0.032, 0.16, s), k.secondary, 0, 0.62, 0));
  g.add(imesh(new THREE.CylinderGeometry(0.006, 0.006, 0.98, 4), k.secondary, 0, 0.62, 0.0));
  // glow nocks at the limb tips (approximate arc endpoints)
  const tipY = 0.62 + Math.sin(2.35 / 2) * 0.52;
  g.add(imesh(new THREE.SphereGeometry(0.03, s, 6), k.glow, 0, tipY, 0.30));
  g.add(imesh(new THREE.SphereGeometry(0.03, s, 6), k.glow, 0, tipY, -0.30));
  return g;
}

function buildDagger(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.026, 0.03, 0.15, s), k.secondary, 0, 0.075, 0));
  g.add(imesh(new THREE.SphereGeometry(0.032, s, 6), k.glow, 0, -0.015, 0));
  g.add(imesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, s), k.secondary, 0, 0.165, 0));
  const blade = imesh(new THREE.CylinderGeometry(0.008, 0.035, 0.38, 4), k.primary, 0, 0.37, 0);
  blade.rotation.y = Math.PI / 4;
  g.add(blade);
  const tip = imesh(new THREE.ConeGeometry(0.035, 0.09, 4), k.primary, 0, 0.60, 0);
  tip.rotation.y = Math.PI / 4;
  g.add(tip);
  return g;
}

function buildMace(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.028, 0.032, 0.72, s), k.secondary, 0, 0.36, 0));
  g.add(imesh(new THREE.OctahedronGeometry(0.115), k.primary, 0, 0.82, 0)); // flanged head
  for (let i = 0; i < 6; i++) { // head spikes, seeded jitter
    const a = (i / 6) * Math.PI * 2 + k.rng.next() * 0.3;
    const spike = imesh(new THREE.ConeGeometry(0.032, 0.11, 5), k.primary,
      Math.cos(a) * 0.13, 0.82, Math.sin(a) * 0.13);
    spike.rotation.z = -Math.PI / 2 + (a > Math.PI / 2 && a < Math.PI * 1.5 ? Math.PI : 0);
    spike.lookAt(Math.cos(a) * 2, 0.82, Math.sin(a) * 2);
    g.add(spike);
  }
  g.add(imesh(new THREE.SphereGeometry(0.045, s, 6), k.glow, 0, 0.95, 0));
  return g;
}

// ---------------------------------------------------------------- armor

/** Helmet: centered on the head pivot (head sphere center), faces +Z. */
function buildHelmet(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.SphereGeometry(0.215, s * 2, s, 0, Math.PI * 2, 0, Math.PI * 0.62), k.primary, 0, 0.03, 0));
  const brim = imesh(new THREE.TorusGeometry(0.20, 0.028, 6, s * 2), k.secondary, 0, 0.0, 0);
  brim.rotation.x = Math.PI / 2;
  g.add(brim);
  const nose = imesh(new THREE.ConeGeometry(0.035, 0.14, 6), k.secondary, 0, -0.06, 0.195);
  nose.rotation.x = Math.PI;
  g.add(nose);
  const crest = imesh(new THREE.OctahedronGeometry(0.09), k.primary, 0, 0.22, -0.02);
  crest.scale.set(0.35, 0.9, 1.3);
  g.add(crest);
  const slit = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.05), k.glow);
  slit.position.set(0, 0.04, 0.205);
  slit.castShadow = true;
  g.add(slit);
  return g;
}

/** Chestplate: torso-pivot local (torso top at +0.36), faces +Z. */
function buildChestplate(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.335, 0.28, 0.52, s + 2, 1, true, -0.95, 1.9), k.primary, 0, 0.06, 0));
  const rim = imesh(new THREE.TorusGeometry(0.31, 0.03, 6, s * 2), k.secondary, 0, 0.30, 0);
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  const waist = imesh(new THREE.TorusGeometry(0.265, 0.028, 6, s * 2), k.secondary, 0, -0.18, 0);
  waist.rotation.x = Math.PI / 2;
  g.add(waist);
  g.add(imesh(new THREE.OctahedronGeometry(0.07), k.glow, 0, 0.10, 0.30)); // chest emblem
  return g;
}

/** Greaves: character-local, feet at origin (standard-archetype proportions: hips ±0.17, guard y 0.12..0.64). */
function buildGreaves(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  for (const side of [1, -1]) {
    g.add(imesh(new THREE.CylinderGeometry(0.105, 0.075, 0.52, s), k.primary, 0.17 * side, 0.38, 0.01));
    g.add(imesh(new THREE.SphereGeometry(0.09, s, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), k.secondary, 0.17 * side, 0.62, 0.03));
    const band = imesh(new THREE.TorusGeometry(0.082, 0.022, 6, s * 2), k.glow, 0.17 * side, 0.16, 0.01);
    band.rotation.x = Math.PI / 2;
    g.add(band);
  }
  return g;
}

/** Shield: worn on the back (accessory slot), torso-pivot local, faces -Z (rear). */
function buildShield(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  const disc = imesh(new THREE.CylinderGeometry(0.30, 0.30, 0.06, s + 4), k.primary, 0, 0.10, -0.34);
  disc.rotation.x = Math.PI / 2;
  g.add(disc);
  const rim = imesh(new THREE.TorusGeometry(0.30, 0.032, 6, s * 2), k.secondary, 0, 0.10, -0.34);
  g.add(rim);
  g.add(imesh(new THREE.SphereGeometry(0.08, s, 8), k.glow, 0, 0.10, -0.40)); // boss
  return g;
}

// ---------------------------------------------------------------- small goods (feet at origin, ~0.5 m tall)

function buildFlask(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.SphereGeometry(0.14, s * 2, s), k.secondary, 0, 0.17, 0));
  g.add(imesh(new THREE.SphereGeometry(0.105, s * 2, s), k.glow, 0, 0.14, 0)); // liquid
  g.add(imesh(new THREE.CylinderGeometry(0.05, 0.06, 0.13, s), k.secondary, 0, 0.32, 0));
  g.add(imesh(new THREE.CylinderGeometry(0.055, 0.055, 0.05, s), k.primary, 0, 0.40, 0)); // cork
  return g;
}

function buildCrystal(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.09, 0.11, 0.07, s), k.primary, 0, 0.035, 0));
  const collar = imesh(new THREE.TorusGeometry(0.09, 0.025, 6, s * 2), k.secondary, 0, 0.10, 0);
  collar.rotation.x = Math.PI / 2;
  g.add(collar);
  const gem = imesh(new THREE.OctahedronGeometry(0.16), k.glow, 0, 0.28, 0);
  gem.scale.set(1, 1.6, 1);
  gem.rotation.y = k.rng.next() * Math.PI;
  g.add(gem);
  return g;
}

function buildIngot(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  const bar = imesh(new THREE.CylinderGeometry(0.09, 0.13, 0.34, 4), k.primary, 0, 0.11, 0);
  bar.rotation.z = Math.PI / 2; bar.rotation.y = Math.PI / 4;
  g.add(bar);
  g.add(imesh(new THREE.CylinderGeometry(0.10, 0.12, 0.04, s), k.secondary, 0, 0.02, 0)); // pallet
  g.add(imesh(new THREE.OctahedronGeometry(0.045), k.glow, 0, 0.21, 0)); // assay stamp
  return g;
}

function buildKey(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, s), k.primary, 0, 0.30, 0));
  g.add(imesh(new THREE.TorusGeometry(0.09, 0.026, 6, s * 2), k.secondary, 0, 0.62, 0));
  g.add(imesh(new THREE.SphereGeometry(0.036, s, 6), k.glow, 0, 0.62, 0));
  for (const [dy, dx] of [[0.12, 0.05], [0.20, 0.045]] as const) { // teeth
    const t = imesh(new THREE.ConeGeometry(0.02, 0.07, 5), k.primary, dx, dy, 0);
    t.rotation.z = -Math.PI / 2;
    g.add(t);
  }
  return g;
}

function buildCharm(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const s = k.seg;
  g.add(imesh(new THREE.TorusGeometry(0.10, 0.026, 6, s * 2), k.primary, 0, 0.28, 0));
  const gem = imesh(new THREE.OctahedronGeometry(0.07), k.glow, 0, 0.28, 0);
  gem.rotation.y = k.rng.next() * Math.PI;
  g.add(gem);
  g.add(imesh(new THREE.SphereGeometry(0.035, s, 6), k.secondary, 0, 0.12, 0)); // bead
  g.add(imesh(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 4), k.secondary, 0, 0.18, 0));
  return g;
}

function buildShard(k: Kit): THREE.Group {
  const g = new THREE.Group();
  const gem = imesh(new THREE.OctahedronGeometry(0.14), k.glow, 0, 0.22, 0);
  gem.scale.set(1, 1.8, 1);
  g.add(gem);
  const collar = imesh(new THREE.TorusGeometry(0.075, 0.022, 6, k.seg * 2), k.secondary, 0, 0.09, 0);
  collar.rotation.x = Math.PI / 2;
  g.add(collar);
  g.add(imesh(new THREE.CylinderGeometry(0.07, 0.09, 0.06, k.seg), k.primary, 0, 0.03, 0));
  return g;
}

// ---------------------------------------------------------------- kind resolution

/** weapon name-keyword → model. First match wins; no keyword → 'sword'. */
const WEAPON_TABLE: [string[], ItemKind][] = [
  [['axe', 'hatchet', 'cleaver', 'tomahawk', 'halberd'], 'axe'],
  [['staff', 'rod', 'wand', 'scepter', 'sceptre', 'totem', 'baton'], 'staff'],
  [['bow', 'longbow', 'recurve', 'crossbow'], 'bow'],
  [['dagger', 'knife', 'shiv', 'dirk', 'kunai'], 'dagger'],
  [['mace', 'hammer', 'maul', 'club', 'flail'], 'mace'],
  [['sword', 'katana', 'saber', 'sabre', 'longsword', 'claymore', 'cutlass',
    'blade', 'scimitar', 'rapier', 'spear', 'pike', 'lance', 'greatsword'], 'sword'],
];

function weaponKindFor(name: string): ItemKind {
  const n = (name || '').toLowerCase();
  for (const [keys, kind] of WEAPON_TABLE) {
    if (keys.some((kw) => n.includes(kw))) return kind;
  }
  return 'sword';
}

const ARMOR_BY_SLOT: Record<string, ItemKind> = {
  head: 'helmet',
  torso: 'chestplate',
  legs: 'greaves',
  accessory: 'shield',
};

const INGOT_KEYS = ['ingot', 'bar', 'ore', 'metal', 'bullion'];

/** Resolve an ItemDef → ItemKind (the full name-keyword→model mapping lives here). */
export function itemKindFor(def: ItemDef): ItemKind {
  try {
    const type = def?.type;
    if (type === 'weapon') return weaponKindFor(def.name);
    if (type === 'armor') return ARMOR_BY_SLOT[def.slot ?? ''] ?? 'chestplate';
    if (type === 'consumable') return 'flask';
    if (type === 'material') {
      const n = (def.name || '').toLowerCase();
      return INGOT_KEYS.some((kw) => n.includes(kw)) ? 'ingot' : 'crystal';
    }
    if (type === 'key') return 'key';
    if (type === 'trinket') return 'charm';
  } catch { /* fall through to shard */ }
  return 'shard';
}

const BUILDERS: Record<ItemKind, (k: Kit) => THREE.Group> = {
  sword: buildSword, axe: buildAxe, staff: buildStaff, bow: buildBow, dagger: buildDagger, mace: buildMace,
  helmet: buildHelmet, chestplate: buildChestplate, greaves: buildGreaves, shield: buildShield,
  flask: buildFlask, crystal: buildCrystal, ingot: buildIngot, key: buildKey, charm: buildCharm, shard: buildShard,
};

export interface MeshForOpts {
  /** GameSpec — lets meshFor resolve def.skin against custom.items.skins. Absent: built-ins only. */
  spec?: GameSpec;
  /** quality tier → geometry detail (retro halves the radial segments). */
  quality?: QualityMode;
}

/**
 * Stamp RARITY_GLOW onto the glow-role materials of an item mesh.
 * Common gets a faint trim; higher rarities a full emissive pop.
 * An explicit item skin applied afterwards wins over this default.
 */
export function applyRarityTrim(mesh: THREE.Object3D, rarity: ItemRarity | undefined): void {
  try {
    const hex = RARITY_GLOW[rarity ?? 'common'] ?? RARITY_GLOW.common;
    const strong = (rarity ?? 'common') !== 'common';
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of mats) {
        const mat = mm as THREE.MeshStandardMaterial | undefined;
        if (mat && mat.userData.owned && mat.userData.role === 'glow' && 'emissive' in mat) {
          try {
            mat.emissive.set(hex);
            mat.emissiveIntensity = strong ? 1.0 : 0.35;
          } catch { /* skip */ }
        }
      }
    });
  } catch { /* rarity trim must never break the mesh */ }
}

/** fail-closed GLB load for def.model (https .glb/.gltf only). Any failure → null. */
async function loadItemGlb(url: string): Promise<THREE.Object3D | null> {
  try {
    const loader = new GLTFLoader();
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), 20000));
    const loaded = await Promise.race([
      loader.loadAsync(url).catch(() => null),
      timeout,
    ]);
    if (!loaded) return null;
    const obj = (loaded as { scene?: THREE.Object3D }).scene ?? null;
    if (!obj) return null;
    // normalize: fit into a ~1 m box, feet at origin (item scale convention)
    const box3 = new THREE.Box3().setFromObject(obj);
    const size = box3.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0 && Number.isFinite(maxDim)) {
      const s = 1 / maxDim;
      obj.scale.setScalar(s);
      const b2 = new THREE.Box3().setFromObject(obj);
      obj.position.y -= b2.min.y;
    }
    obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return obj;
  } catch {
    return null;
  }
}

/**
 * Build a procedural item mesh for an ItemDef. Synchronous, deterministic
 * (variation derives from hashString(def.name) — no Math.random), never throws.
 * The returned Group has userData.itemKind set and role-tagged owned materials.
 */
export function meshFor(def: ItemDef, opts?: MeshForOpts): THREE.Group {
  try {
    const kind = itemKindFor(def);
    const kit = makeKit(def, opts?.quality);
    const group = BUILDERS[kind](kit);
    group.userData.itemKind = kind;
    // rarity trim first, then the explicit skin wins over it
    applyRarityTrim(group, def.rarity);
    const skinId = def.skin;
    if (skinId) {
      // with a spec: custom item skins override built-ins; without: built-ins only
      const resolved = opts?.spec ? resolveItemSkinDef(opts.spec, skinId) : BUILT_IN_ITEM_SKINS[skinId];
      if (resolved) applyItemSkin(group, resolved);
    }
    return group;
  } catch {
    // absolute floor: a glowing shard rather than nothing
    const kit = makeKit({ name: 'fallback', type: 'trinket' } as ItemDef, opts?.quality);
    const g = buildShard(kit);
    g.userData.itemKind = 'shard';
    return g;
  }
}

/**
 * Async GLB-override variant: returns the procedural mesh immediately and
 * swaps in the normalized GLB when (if) it loads. Fail-closed — any load
 * failure keeps the procedural mesh. Never throws.
 */
export function meshForAsync(def: ItemDef, opts?: MeshForOpts): THREE.Group {
  const group = new THREE.Group();
  const proc = meshFor(def, opts);
  group.add(proc);
  group.userData.itemKind = proc.userData.itemKind;
  const url = def?.model;
  if (typeof url === 'string' && isGlbUrl(url)) {
    void loadItemGlb(url).then((glb) => {
      if (!glb) return; // fail-closed: procedural stands
      try {
        disposeOwned(proc);
        group.remove(proc);
        glb.userData.itemKind = proc.userData.itemKind;
        group.add(glb);
      } catch { /* keep the procedural mesh */ }
    }).catch(() => { /* keep the procedural mesh */ });
  }
  return group;
}

/** The deluxe factory the coordinator swaps in as the runtime's item factory. */
export const ItemModelForge: ItemMeshFactory = {
  meshFor: (def: ItemDef) => meshFor(def),
};
