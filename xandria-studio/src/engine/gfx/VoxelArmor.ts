/**
 * VoxelArmor (art-direction pass) — procedural BOXY armor shells that move the
 * cast toward the voxel character reference: strong silhouettes, glowing visor
 * slits, layered armor (pauldrons, chest plates, belts, hoods/scarves).
 *
 * Every piece parents to an EXISTING rig pivot (head/torso/armL/armR/
 * elbowL/elbowR/kneeL/kneeR), so the wave-C joint animation carries the armor
 * untouched — no pivot, sub-pivot, or animate() changes anywhere.
 *
 * Piece sizes are FIT to the rig's own meshes (pivot-subtree Box3 in
 * pivot-local coords), so any seed/archetype/bulk produces a sane shell.
 * Deterministic: pure functions of rig geometry — no RNG anywhere.
 *
 * Material discipline (matches Skins.ts): every armor material is a
 * per-application owned clone (userData.owned) with NO role tag, so
 * applySkin (owned + role-tagged only) and flash() never touch armor, while
 * disposeOwned() reclaims it. Pieces are flagged userData.armorPiece so
 * clearVoxelArmor can strip them by slot and by origin ('skin' vs 'item').
 *
 * Slot contract for per-slot application (EquipRig):
 *  - head      → helm + visor slit (+ hood when the set has one)
 *  - torso     → chest plate + trim + belt
 *  - legs      → greaves + greave trim
 *  - accessory → pauldrons + vambraces + scarf (when the set has one)
 */
import * as THREE from 'three';
import type { CharacterRig } from './Characters';
import type { EquipSlot } from '@spec';

/** Pivots armor may parent to. 'root' is reserved for future sets. */
export type VoxelArmorPivot =
  | 'root' | 'head' | 'torso'
  | 'armL' | 'armR' | 'elbowL' | 'elbowR' | 'kneeL' | 'kneeR';

/** Equip slots that carry voxel pieces (weapon never does — it renders its own mesh). */
export type VoxelArmorSlot = Extract<EquipSlot, 'head' | 'torso' | 'legs' | 'accessory'>;
const VOXEL_ARMOR_SLOTS: readonly VoxelArmorSlot[] = ['head', 'torso', 'legs', 'accessory'];

export interface VoxelArmorPalette {
  shell: string;  // main plate color
  trim: string;   // edge/gold trim color
  dark: string;   // under-suit / recess color
}
export interface VoxelArmorVisor {
  color: string;    // #rrggbb emissive slit color
  intensity: number; // 0..5
}

export interface VoxelArmorSetDef {
  id: string;
  name: string;
  palette: VoxelArmorPalette;
  /** default visor; SkinDef.visor overrides it at apply time */
  visor: VoxelArmorVisor;
  build: (ctx: VoxelArmorCtx) => void;
}

/** Where a piece came from — skin-applied and item-applied armor clear independently. */
export type VoxelArmorOrigin = 'skin' | 'item';

export interface ApplyVoxelArmorOpts {
  /** override the set's default visor color (SkinDef.visor) */
  visorColor?: string;
  /** override the set's default visor intensity, clamped 0..5 */
  visorIntensity?: number;
  origin?: VoxelArmorOrigin;
}

export interface VoxelArmorCtx {
  rig: CharacterRig;
  shell: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  /** emissive material for the visor slit + glowing accents */
  glow: THREE.MeshStandardMaterial;
  /** slot filter: null = full set; otherwise only pieces for this slot are built */
  slot: VoxelArmorSlot | null;
  /** slot the currently-building piece belongs to (set by forSlot) — used for armorSlot tagging */
  pieceSlot: VoxelArmorSlot | null;
  /** pivot-subtree bbox in pivot-local coords (null when the pivot is missing) */
  measure: (pivot: VoxelArmorPivot, mode: 'self' | 'subtree' | 'shallow') => Box | null;
  /** add a box to a pivot; rx/rz rotate the mesh. Returns null when the pivot is missing. */
  box: (
    pivot: VoxelArmorPivot, w: number, h: number, d: number,
    x: number, y: number, z: number, mat?: THREE.Material,
    rx?: number, rz?: number,
  ) => THREE.Mesh | null;
}

export interface Box { cx: number; cy: number; cz: number; sx: number; sy: number; sz: number }

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const customSets = new Map<string, VoxelArmorSetDef>();

/** All built-in armor sets, keyed by id (must match VOXEL_ARMOR_SET_IDS — asserted by unit test). */
export const VOXEL_ARMOR_SETS: Record<string, VoxelArmorSetDef> = {};

export function voxelArmorSetIds(): string[] {
  return [...Object.keys(VOXEL_ARMOR_SETS), ...customSets.keys()];
}

/** Ids of runtime-registered custom sets (for validateSpec's customArmorSets option). */
export function registeredVoxelArmorSetIds(): string[] {
  return [...customSets.keys()];
}

export function resolveVoxelArmorSet(id: string | undefined): VoxelArmorSetDef | undefined {
  if (!id) return undefined;
  return customSets.get(id) ?? VOXEL_ARMOR_SETS[id];
}

/**
 * Register a runtime armor set (mods / tests). Returns false and never throws
 * on a malformed def; re-registering an id replaces it.
 */
export function registerVoxelArmorSet(def: VoxelArmorSetDef): boolean {
  try {
    if (!def || typeof def.id !== 'string' || !def.id) return false;
    if (typeof def.build !== 'function') return false;
    if (!def.palette || !def.visor) return false;
    customSets.set(def.id, def);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// measurement + construction helpers
// ---------------------------------------------------------------------------

function pivotFor(rig: CharacterRig, p: VoxelArmorPivot): THREE.Object3D | null {
  if (!rig) return null;
  if (p === 'root') return rig.group ?? null;
  const L = rig.limbs as unknown as Record<string, THREE.Object3D | undefined>;
  return L[p] ?? null;
}

const _tmpBox = new THREE.Box3();

function toBox(b: THREE.Box3): Box | null {
  if (b.isEmpty()) return null;
  const s = new THREE.Vector3();
  const c = new THREE.Vector3();
  b.getSize(s); b.getCenter(c);
  if (!(s.x > 0 && s.y > 0 && s.z > 0)) return null;
  return { cx: c.x, cy: c.y, cz: c.z, sx: s.x, sy: s.y, sz: s.z };
}

/**
 * Measure a pivot in its own local frame.
 * - 'self': the pivot mesh's own geometry only (torso cylinder — ignores capes/backpacks)
 * - 'subtree': every non-armor mesh under the pivot (head — swallows headgear)
 * - 'shallow': direct mesh children, skipping sub-pivot subtrees (arms — delt + upper arm, not the forearm)
 */
function measurePivot(rig: CharacterRig, p: VoxelArmorPivot, mode: 'self' | 'subtree' | 'shallow'): Box | null {
  try {
    const pivot = pivotFor(rig, p);
    if (!pivot) return null;
    if (mode === 'self') {
      const m = pivot as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return null;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      return bb ? toBox(bb) : null;
    }
    pivot.updateWorldMatrix(true, false);
    const inv = pivot.matrixWorld.clone().invert();
    const out = new THREE.Box3();
    const L = rig.limbs as unknown as Record<string, THREE.Object3D | undefined>;
    const skipSub = new Set<THREE.Object3D>([
      L.elbowL, L.elbowR, L.kneeL, L.kneeR, ...((L.cape as THREE.Object3D[] | undefined) ?? []),
    ].filter((o): o is THREE.Object3D => !!o));
    const consider = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (o as { userData?: { armorPiece?: boolean } }).userData?.armorPiece) return;
      _tmpBox.setFromObject(m);
      _tmpBox.applyMatrix4(inv);
      out.union(_tmpBox);
    };
    if (mode === 'shallow') {
      for (const child of pivot.children) {
        if (skipSub.has(child)) continue;
        consider(child);
      }
    } else {
      pivot.traverse((o) => {
        // include the pivot itself when it's a mesh (torso/head are meshes);
        // skip bare group pivots (their frame carries no geometry)
        if (o === pivot && !(pivot as THREE.Mesh).isMesh) return;
        consider(o);
      });
    }
    return toBox(out);
  } catch {
    return null;
  }
}

function makeMat(hex: string, roughness: number, metalness: number, emissive?: string, emissiveIntensity?: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness, metalness });
  try { m.color.set(hex); } catch { /* invalid hex → white, never throws */ }
  if (emissive) {
    try { m.emissive.set(emissive); } catch { /* keep black */ }
    m.emissiveIntensity = emissiveIntensity ?? 2;
  }
  m.userData.owned = true; // disposed by disposeOwned; NO role tag → skins/flash never touch it
  return m;
}

function buildCtx(
  rig: CharacterRig, set: VoxelArmorSetDef, opts: ApplyVoxelArmorOpts,
  slot: VoxelArmorSlot | null,
): VoxelArmorCtx {
  const visorColor = opts.visorColor ?? set.visor.color;
  const visorIntensity = THREE.MathUtils.clamp(
    typeof opts.visorIntensity === 'number' && Number.isFinite(opts.visorIntensity)
      ? opts.visorIntensity : set.visor.intensity, 0, 5);
  const shell = makeMat(set.palette.shell, 0.55, 0.45);
  const trim = makeMat(set.palette.trim, 0.38, 0.65);
  const dark = makeMat(set.palette.dark, 0.85, 0.1);
  const glow = makeMat('#111111', 0.3, 0.0, visorColor, visorIntensity);
  const origin = opts.origin ?? 'skin';
  const armorSlotFor = (pivot: VoxelArmorPivot): VoxelArmorSlot => {
    if (pivot === 'head') return 'head';
    if (pivot === 'torso') return 'torso';
    if (pivot === 'kneeL' || pivot === 'kneeR') return 'legs';
    return 'accessory';
  };
  const ctx: VoxelArmorCtx = {
    rig, shell, trim, dark, glow, slot, pieceSlot: null,
    measure: (p, mode) => measurePivot(rig, p, mode),
    box: (pivot, w, h, d, x, y, z, mat = shell, rx = 0, rz = 0) => {
      try {
        const parent = pivotFor(rig, pivot);
        if (!parent || !(w > 0 && h > 0 && d > 0)) return null;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        mesh.position.set(x, y, z);
        if (rx) mesh.rotation.x = rx;
        if (rz) mesh.rotation.z = rz;
        mesh.castShadow = true;
        mesh.userData.armorPiece = true;
        mesh.userData.armorSet = set.id;
        mesh.userData.armorOrigin = origin;
        mesh.userData.armorSlot = ctx.pieceSlot ?? slot ?? armorSlotFor(pivot);
        parent.add(mesh);
        return mesh;
      } catch {
        return null;
      }
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// shared piece builders
// ---------------------------------------------------------------------------

/** Blocky helm + glowing visor slit (the reference's signature read). */
function helm(ctx: VoxelArmorCtx, opts: { ridge?: boolean } = {}) {
  const m = ctx.measure('head', 'subtree');
  if (!m) return;
  const w = Math.max(m.sx, m.sz) * 1.5;
  const h = m.sy * 1.4;
  const d = Math.max(m.sx, m.sz) * 1.5;
  const y = m.cy + m.sy * 0.10;
  ctx.box('head', w, h, d, 0, y, m.cz, ctx.shell);
  if (opts.ridge) ctx.box('head', w * 0.28, h * 0.16, d * 1.04, 0, y + h * 0.52, m.cz, ctx.trim);
  // brow band + the glowing slit
  ctx.box('head', w * 1.02, h * 0.10, d * 1.02, 0, y + h * 0.30, m.cz, ctx.dark);
  ctx.box('head', w * 0.62, 0.055, 0.035, 0, y + h * 0.10, m.cz + d / 2 + 0.008, ctx.glow);
  // chin guard
  ctx.box('head', w * 0.72, h * 0.20, d * 0.72, 0, y - h * 0.40, m.cz + d * 0.06, ctx.dark);
}

/** Open hood: back + top + side boxes, face open, visor slit glowing beneath. */
function hood(ctx: VoxelArmorCtx) {
  const m = ctx.measure('head', 'subtree');
  if (!m) return;
  const w = Math.max(m.sx, m.sz) * 1.5;
  const h = m.sy * 1.4;
  const d = Math.max(m.sx, m.sz) * 1.5;
  const y = m.cy + m.sy * 0.10;
  ctx.box('head', w * 1.08, h * 1.18, d * 0.42, 0, y + h * 0.06, m.cz - d * 0.42, ctx.shell); // back drape
  ctx.box('head', w * 1.06, h * 0.42, d * 1.02, 0, y + h * 0.52, m.cz - d * 0.08, ctx.shell, -0.28); // peaked top
  ctx.box('head', w * 0.30, h * 0.85, d * 0.85, w * 0.44, y - h * 0.02, m.cz, ctx.shell); // cheeks
  ctx.box('head', w * 0.30, h * 0.85, d * 0.85, -w * 0.44, y - h * 0.02, m.cz, ctx.shell);
  // the slit glows out of the dark face opening
  ctx.box('head', w * 0.55, 0.055, 0.035, 0, y + h * 0.06, m.cz + d * 0.30, ctx.glow);
}

/** Chest plate shell + trim band (+ optional diagonal sash / chest emblem). */
function chestPlate(ctx: VoxelArmorCtx, opts: { sash?: boolean; emblem?: boolean } = {}) {
  const m = ctx.measure('torso', 'self');
  if (!m) return;
  const w = m.sx * 1.18, h = m.sy * 0.68, d = m.sz * 1.20;
  const y = m.cy + m.sy * 0.13;
  ctx.box('torso', w, h, d, 0, y, m.cz, ctx.shell);
  ctx.box('torso', w * 1.03, 0.055, d * 1.03, 0, y - h / 2 + 0.028, m.cz, ctx.trim);
  ctx.box('torso', w * 0.5, 0.05, d * 0.5, 0, y + h / 2 - 0.025, m.cz, ctx.dark); // collar recess
  if (opts.sash) ctx.box('torso', 0.13, h * 1.08, d * 1.04, -0.04, y, m.cz, ctx.trim, 0, 0.62);
  if (opts.emblem) ctx.box('torso', 0.11, 0.15, 0.04, 0, y + h * 0.12, m.cz + d / 2 + 0.012, ctx.glow);
}

/** Waist belt + buckle. */
function belt(ctx: VoxelArmorCtx) {
  const m = ctx.measure('torso', 'self');
  if (!m) return;
  const y = m.cy - m.sy * 0.34;
  ctx.box('torso', m.sx * 1.10, 0.11, m.sz * 1.10, 0, y, m.cz, ctx.dark);
  ctx.box('torso', 0.11, 0.085, 0.035, 0, y, m.cz + (m.sz * 1.10) / 2 + 0.012, ctx.trim);
}

/** Layered shoulder boxes. */
function pauldrons(ctx: VoxelArmorCtx, opts: { big?: boolean } = {}) {
  const k = opts.big ? 2.7 : 2.15;
  for (const [pivot, side] of [['armL', 1], ['armR', -1]] as const) {
    const m = ctx.measure(pivot, 'shallow');
    if (!m) continue;
    const w = m.sx * k, d = m.sz * k;
    ctx.box(pivot, w, 0.21, d, side * 0.02, m.cy + 0.07, m.cz, ctx.shell);
    ctx.box(pivot, w * 0.62, 0.07, d * 0.62, side * 0.02, m.cy + 0.20, m.cz, ctx.trim);
  }
}

/** Shin guards + trim band, parented to the knee pivots so they bend with the joint. */
function greaves(ctx: VoxelArmorCtx) {
  for (const pivot of ['kneeL', 'kneeR'] as const) {
    const m = ctx.measure(pivot, 'subtree');
    if (!m) continue;
    const w = m.sx * 1.55, d = m.sz * 1.6;
    ctx.box(pivot, w, m.sy * 0.52, d, 0, m.cy - m.sy * 0.10, m.cz + 0.01, ctx.shell);
    ctx.box(pivot, w * 1.04, 0.05, d * 1.04, 0, m.cy + m.sy * 0.17, m.cz + 0.01, ctx.trim);
  }
}

/** Forearm guards on the elbow pivots. */
function vambraces(ctx: VoxelArmorCtx) {
  for (const pivot of ['elbowL', 'elbowR'] as const) {
    const m = ctx.measure(pivot, 'subtree');
    if (!m) continue;
    ctx.box(pivot, m.sx * 1.7, m.sy * 0.48, m.sz * 1.7, 0, m.cy - m.sy * 0.04, m.cz, ctx.dark);
  }
}

/** Neck wrap + hanging front flap. */
function scarf(ctx: VoxelArmorCtx, opts: { flapSide?: number } = {}) {
  const m = ctx.measure('torso', 'self');
  if (!m) return;
  const topY = m.cy + m.sy / 2;
  ctx.box('torso', m.sx * 0.78, 0.15, m.sz * 0.85, 0, topY - 0.03, m.cz, ctx.shell);
  ctx.box('torso', 0.17, m.sy * 0.42, 0.06, (opts.flapSide ?? 1) * m.sx * 0.20, topY - m.sy * 0.30, m.cz + m.sz * 0.44, ctx.shell);
}

/** Tattered tabard flaps hanging from the belt (raider). */
function tabard(ctx: VoxelArmorCtx) {
  const m = ctx.measure('torso', 'self');
  if (!m) return;
  const y = m.cy - m.sy * 0.34;
  ctx.box('torso', m.sx * 0.42, 0.36, 0.06, 0, y - 0.24, m.cz + m.sz * 0.52, ctx.shell);
  ctx.box('torso', 0.06, 0.30, m.sz * 0.40, m.sx * 0.50, y - 0.20, m.cz, ctx.shell);
  ctx.box('torso', 0.06, 0.30, m.sz * 0.40, -m.sx * 0.50, y - 0.20, m.cz, ctx.shell);
}

/** Slot gate: run fn only when building the full set or the matching slot. */
function forSlot(ctx: VoxelArmorCtx, slot: VoxelArmorSlot, fn: () => void) {
  if (ctx.slot !== null && ctx.slot !== slot) return;
  const prev = ctx.pieceSlot;
  ctx.pieceSlot = slot;
  try { fn(); } finally { ctx.pieceSlot = prev; }
}

// ---------------------------------------------------------------------------
// the five sets
// ---------------------------------------------------------------------------

function defineSets() {
  const S = VOXEL_ARMOR_SETS;
  S.nomad = {
    id: 'nomad', name: 'Nomad Plate',
    palette: { shell: '#1b1e26', trim: '#d8a428', dark: '#0e1014' },
    visor: { color: '#ffd23f', intensity: 2.2 },
    build(ctx) {
      forSlot(ctx, 'head', () => helm(ctx));
      forSlot(ctx, 'torso', () => { chestPlate(ctx, { sash: true }); belt(ctx); });
      forSlot(ctx, 'legs', () => greaves(ctx));
      forSlot(ctx, 'accessory', () => { pauldrons(ctx); vambraces(ctx); });
    },
  };
  S.raider = {
    id: 'raider', name: 'Raider Wraps',
    palette: { shell: '#a33e22', trim: '#e08a2e', dark: '#4a2418' },
    visor: { color: '#ff9d2e', intensity: 2.4 },
    build(ctx) {
      forSlot(ctx, 'head', () => hood(ctx));
      forSlot(ctx, 'torso', () => { chestPlate(ctx); belt(ctx); tabard(ctx); });
      forSlot(ctx, 'legs', () => greaves(ctx));
      forSlot(ctx, 'accessory', () => { pauldrons(ctx); vambraces(ctx); scarf(ctx, { flapSide: -1 }); });
    },
  };
  S.guardian = {
    id: 'guardian', name: 'Guardian Aegis',
    palette: { shell: '#1f4a2e', trim: '#d8a428', dark: '#12281c' },
    visor: { color: '#4dff6a', intensity: 2.2 },
    build(ctx) {
      forSlot(ctx, 'head', () => helm(ctx, { ridge: true }));
      forSlot(ctx, 'torso', () => { chestPlate(ctx, { emblem: true }); belt(ctx); });
      forSlot(ctx, 'legs', () => greaves(ctx));
      forSlot(ctx, 'accessory', () => { pauldrons(ctx, { big: true }); vambraces(ctx); });
    },
  };
  S.scout = {
    id: 'scout', name: 'Scout Weave',
    palette: { shell: '#3a4a63', trim: '#9fb2cc', dark: '#1c2330' },
    visor: { color: '#35e0ff', intensity: 2.2 },
    build(ctx) {
      forSlot(ctx, 'head', () => helm(ctx));
      forSlot(ctx, 'torso', () => { chestPlate(ctx); belt(ctx); });
      forSlot(ctx, 'legs', () => greaves(ctx));
      forSlot(ctx, 'accessory', () => { pauldrons(ctx); vambraces(ctx); scarf(ctx); });
    },
  };
  S.plate = {
    id: 'plate', name: 'Field Plate',
    palette: { shell: '#6a7078', trim: '#b9c0c9', dark: '#2a2d33' },
    visor: { color: '#fff6c8', intensity: 1.8 },
    build(ctx) {
      forSlot(ctx, 'head', () => helm(ctx));
      forSlot(ctx, 'torso', () => { chestPlate(ctx); belt(ctx); });
      forSlot(ctx, 'legs', () => greaves(ctx));
      forSlot(ctx, 'accessory', () => { pauldrons(ctx); vambraces(ctx); });
    },
  };
}
defineSets();

// ---------------------------------------------------------------------------
// apply / clear
// ---------------------------------------------------------------------------

/**
 * Apply a full armor set to a rig (replaces any same-origin armor already on
 * it). Never throws; unknown set ids and missing pivots are silent no-ops.
 */
export function applyVoxelArmor(rig: CharacterRig, setId: string, opts: ApplyVoxelArmorOpts = {}): void {
  try {
    const set = resolveVoxelArmorSet(setId);
    if (!rig || !set) return;
    clearVoxelArmor(rig, undefined, opts.origin ?? 'skin');
    rig.group.updateMatrixWorld(true);
    set.build(buildCtx(rig, set, opts, null));
  } catch { /* armor is decorative — never break the sim */ }
}

/**
 * Apply only one equip slot's pieces (EquipRig integration). Clears that
 * slot's same-origin pieces first, so re-equip replaces cleanly.
 */
export function applyVoxelArmorSlot(
  rig: CharacterRig, slot: VoxelArmorSlot, setId: string, opts: ApplyVoxelArmorOpts = {},
): void {
  try {
    const set = resolveVoxelArmorSet(setId);
    if (!rig || !set) return;
    clearVoxelArmor(rig, slot, opts.origin ?? 'skin');
    rig.group.updateMatrixWorld(true);
    set.build(buildCtx(rig, set, opts, slot));
  } catch { /* armor is decorative — never break the sim */ }
}

/**
 * Strip armor pieces from a rig. Slot and/or origin narrow the removal;
 * both undefined clears everything. Never throws.
 */
export function clearVoxelArmor(rig: CharacterRig, slot?: VoxelArmorSlot, origin?: VoxelArmorOrigin): void {
  try {
    if (!rig?.group) return;
    const hits: THREE.Mesh[] = [];
    rig.group.traverse((o) => {
      const m = o as THREE.Mesh;
      const ud = (o as { userData?: Record<string, unknown> }).userData;
      if (m.isMesh && ud?.armorPiece === true &&
        (slot === undefined || ud.armorSlot === slot) &&
        (origin === undefined || ud.armorOrigin === origin)) {
        hits.push(m);
      }
    });
    const mats = new Set<THREE.Material>();
    for (const m of hits) {
      m.parent?.remove(m);
      m.geometry.dispose();
      const mm = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mm) if (mat) mats.add(mat as THREE.Material);
    }
    for (const mat of mats) mat.dispose();
  } catch { /* clearing armor never throws */ }
}
