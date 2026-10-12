/**
 * Character skins (workstream D, beauty wave A) — palette / emissive /
 * texture overrides applied to a procedural CharacterRig's OWNED,
 * role-tagged materials (userData.role = skin|shirt|pants|accent|accentDS,
 * stamped in makeHumanoid).
 *
 * Rules:
 *  - Only owned cloned materials are ever mutated — the MaterialLibrary cache
 *    is never touched, and shared gear materials (horns, glow bits) are left
 *    alone. Rigs without role tags (imported GLB rigs) are a no-op.
 *  - NEVER throws: invalid colors are skipped, texture failures fall back to
 *    the plain palette. The procedural look is the floor.
 *  - Precedence: an explicit skin in `custom.characters.player.skin` (or the
 *    per-enemy slot) WINS over the `colors` param passed to makeHumanoid.
 *    The colors param is palette-derived blueprint defaults; a skin choice is
 *    a deliberate authoring decision and must be visible. No skin set → the
 *    colors-param path is untouched (backward compatible).
 *
 * Pattern system (beauty wave): named patterns are 128px deterministic canvas
 * textures. Most painters are LUMINANCE layers — near-white bases with darker
 * motif overlays — so the skin's palette hue shows through the multiply
 * (map × color); a palette works with any pattern. `hazard` is the exception:
 * it is deliberately chromatic (yellow/black), meant for accent roles.
 * `textureRoles` picks which roles get the map (default: shirt+pants).
 */
import * as THREE from 'three';
import { TextureLoader } from 'three';
import {
  type GameSpec, type SkinDef, type SkinTexturePattern, type SkinTextureRole,
  SKIN_TEXTURE_ROLES,
} from '@spec';
import type { CharacterRig } from './Characters';
import { applyVoxelArmor, clearVoxelArmor, resolveVoxelArmorSet, pickVoxelArmorSetId } from './VoxelArmor';

/** Options for applySkin's opt-in seeded auto-armor (graphics follow-up, worker E). */
export interface ApplySkinOptions {
  /**
   * Opt-in (spec flag `custom.armor.auto`): when true and `seed` is an
   * integer, a skin with no explicit `armor` renders the deterministic set
   * from pickVoxelArmorSetId(seed). Absent/false → legacy path, byte-identical
   * to the pre-flag behavior (legacy skins render armor-free).
   */
  autoArmor?: boolean;
  seed?: number;
}

/**
 * Build the ApplySkinOptions for a spec: reads the opt-in flag
 * (`custom.armor.auto`) and the spec seed. The flag is strict — only the
 * boolean `true` enables auto-armor.
 */
export function skinOptionsForSpec(spec: GameSpec | undefined): ApplySkinOptions {
  return {
    autoArmor: spec?.custom?.armor?.auto === true,
    seed: typeof spec?.meta?.seed === 'number' ? spec.meta.seed : undefined,
  };
}

export const BUILT_IN_SKINS: Record<string, SkinDef> = {
  default: {
    name: 'Default Operative',
    palette: { skin: '#d9a066', shirt: '#3f5a78', pants: '#2e2a26', accent: '#ffd23f' },
  },
  crimson: {
    name: 'Crimson Vanguard',
    palette: { skin: '#c98a5a', shirt: '#8a1f1f', pants: '#241a1a', accent: '#ff4433' },
    emissive: { color: '#ff2211', intensity: 0.35 },
    roughness: 0.6,
    metalness: 0.2,
  },
  stealth: {
    name: 'Night Stealth',
    palette: { skin: '#8a6a4a', shirt: '#1a1d24', pants: '#14161c', accent: '#35e0ff' },
    emissive: { color: '#35e0ff', intensity: 1.2 },
    roughness: 0.9,
    metalness: 0.1,
    texture: { pattern: 'digital' },
  },
  gold: {
    name: 'Gilded Champion',
    palette: { skin: '#d9a066', shirt: '#8a6a1f', pants: '#4a3a14', accent: '#ffd700' },
    emissive: { color: '#ffcc33', intensity: 0.25 },
    roughness: 0.3,
    metalness: 0.9,
    texture: { pattern: 'carbon' },
  },
  neonstreet: {
    name: 'Neon Street',
    palette: { skin: '#b98a5e', shirt: '#241a3f', pants: '#141021', accent: '#ff2fd6' },
    emissive: { color: '#ff2fd6', intensity: 1.4 },
    roughness: 0.6,
    metalness: 0.3,
    texture: { pattern: 'fade' },
  },
  rustscrap: {
    name: 'Rust Scrap',
    palette: { skin: '#a37a52', shirt: '#5f4a30', pants: '#3b2d22', accent: '#e08a2e' },
    roughness: 0.95,
    metalness: 0.35,
    texture: { pattern: 'hazard' },
    textureRoles: ['accent'],
  },
  spectral: {
    name: 'Spectral Warden',
    palette: { skin: '#bcd8e8', shirt: '#3a5a7a', pants: '#24384e', accent: '#9ff2ff' },
    emissive: { color: '#9ff2ff', intensity: 1.6 },
    roughness: 0.4,
    metalness: 0.05,
    texture: { pattern: 'runes' },
  },
  royalguard: {
    name: 'Royal Guard',
    palette: { skin: '#d9a066', shirt: '#1f2a5a', pants: '#151a33', accent: '#ffd700' },
    emissive: { color: '#ffd700', intensity: 0.3 },
    roughness: 0.5,
    metalness: 0.5,
    texture: { pattern: 'stripes' },
  },
  desertnomad: {
    name: 'Desert Nomad',
    palette: { skin: '#c28a5e', shirt: '#a8895a', pants: '#6e5638', accent: '#2e7f8a' },
    roughness: 1.0,
    metalness: 0.0,
    texture: { pattern: 'camo' },
  },
  abyssal: {
    name: 'Abyssal Diver',
    palette: { skin: '#7a9aa8', shirt: '#0e2233', pants: '#081420', accent: '#35e0ff' },
    emissive: { color: '#35e0ff', intensity: 1.0 },
    roughness: 0.35,
    metalness: 0.4,
    texture: { pattern: 'fade' },
    textureRoles: ['shirt', 'pants'],
  },
  solarpaladin: {
    name: 'Solar Paladin',
    palette: { skin: '#d9a066', shirt: '#e8dcc0', pants: '#b8a878', accent: '#ff9d2e' },
    emissive: { color: '#ffcc55', intensity: 0.8 },
    roughness: 0.45,
    metalness: 0.55,
    texture: { pattern: 'runes' },
  },
  cyberronin: {
    name: 'Cyber Ronin',
    palette: { skin: '#c9995c', shirt: '#0f0f13', pants: '#0a0a0d', accent: '#ff2255' },
    emissive: { color: '#ff2255', intensity: 1.8 },
    roughness: 0.4,
    metalness: 0.6,
    texture: { pattern: 'digital' },
  },
  // ---- art-direction pass: voxel armor skins (each = armor set + palette + visor color) ----
  nomad: {
    name: 'Nomad',
    palette: { skin: '#2a2d36', shirt: '#14161c', pants: '#101216', accent: '#d8a428' },
    armor: 'nomad',
    visor: { color: '#ffd23f', intensity: 2.2 },
    roughness: 0.55,
    metalness: 0.45,
  },
  'desert-raider': {
    name: 'Desert Raider',
    palette: { skin: '#8a5a3a', shirt: '#7a3320', pants: '#4a2418', accent: '#e08a2e' },
    armor: 'raider',
    visor: { color: '#ff9d2e', intensity: 2.4 },
    roughness: 0.9,
    metalness: 0.1,
  },
  'emerald-guardian': {
    name: 'Emerald Guardian',
    palette: { skin: '#2a4a38', shirt: '#16301f', pants: '#12281c', accent: '#d8a428' },
    armor: 'guardian',
    visor: { color: '#4dff6a', intensity: 2.2 },
    roughness: 0.5,
    metalness: 0.5,
  },
  'void-scout': {
    name: 'Void Scout',
    palette: { skin: '#4a5a7a', shirt: '#232c40', pants: '#1c2330', accent: '#9fb2cc' },
    armor: 'scout',
    visor: { color: '#35e0ff', intensity: 2.2 },
    roughness: 0.6,
    metalness: 0.3,
  },
};

/** All skin ids the engine will honor: built-ins, with custom spec skins overriding on collision. */
export function availableSkinIds(spec: GameSpec): string[] {
  const ids = new Set<string>(Object.keys(BUILT_IN_SKINS));
  const custom = spec.custom?.characters?.skins;
  if (custom) for (const id of Object.keys(custom)) ids.add(id);
  return [...ids];
}

/** Resolve a skin id → SkinDef. Custom spec skins win over built-ins. Unknown ids → undefined (caller keeps the default look). */
export function resolveSkinDef(spec: GameSpec, id: string | undefined): SkinDef | undefined {
  if (!id) return undefined;
  return spec.custom?.characters?.skins?.[id] ?? BUILT_IN_SKINS[id];
}

/** role → owned, role-tagged materials under the rig root */
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

// ---------------------------------------------------------------------------
// deterministic canvas painters (beauty wave: upgraded camo + 3 new patterns)
// ---------------------------------------------------------------------------

/** FNV-1a string hash → per-pattern PRNG seed (stable across sessions). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Deterministic LCG — no Math.random anywhere in the painters. */
function seededRnd(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Painter = (ctx: CanvasRenderingContext2D, rnd: () => number) => void;

/** diagonal pinstripes over a near-white base (luminance layer — palette shows through) */
const paintStripes: Painter = (ctx, _rnd) => {
  ctx.fillStyle = '#f4f6fa'; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#c3c9d4';
  for (let i = -128; i < 256; i += 28) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i + 13, 0); ctx.lineTo(i + 13 - 64, 128); ctx.lineTo(i - 64, 128);
    ctx.fill();
  }
  ctx.fillStyle = '#9aa2b2';
  for (let i = -128 + 20; i < 256; i += 28) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i + 3, 0); ctx.lineTo(i + 3 - 64, 128); ctx.lineTo(i - 64, 128);
    ctx.fill();
  }
};

/** camo blotches: layered ellipses + speckle, over a near-white base (upgraded: more blobs, varied shapes) */
const paintCamo: Painter = (ctx, rnd) => {
  ctx.fillStyle = '#f2f4f7'; ctx.fillRect(0, 0, 128, 128);
  const cols = ['#c7ccd5', '#a9b1bd', '#8d96a4'];
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = cols[i % 3];
    ctx.beginPath();
    ctx.ellipse(rnd() * 128, rnd() * 128, 6 + rnd() * 20, 5 + rnd() * 16, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(125,135,150,0.35)';
  for (let i = 0; i < 500; i++) ctx.fillRect(rnd() * 128, rnd() * 128, 1.5, 1.5);
};

/** digital static: sparse darker blocks over a near-white base */
const paintDigital: Painter = (ctx, rnd) => {
  ctx.fillStyle = '#eef1f6'; ctx.fillRect(0, 0, 128, 128);
  const cols = ['#c9cfda', '#aeb6c4', '#8f97a8'];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const r = rnd();
    if (r < 0.42) {
      ctx.fillStyle = cols[(x * 7 + y * 13) % 3];
      ctx.fillRect(x * 8, y * 8, 8, 8);
    } else if (r > 0.965) {
      ctx.fillStyle = '#6d7583';
      ctx.fillRect(x * 8, y * 8, 8, 8);
    }
  }
};

/** carbon 2x2 twill weave in grays */
const paintCarbon: Painter = (ctx, _rnd) => {
  ctx.fillStyle = '#dfe3ea'; ctx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const horiz = (x + y) % 2 === 0;
    ctx.fillStyle = horiz ? '#c3c9d4' : '#a9b1bd';
    ctx.fillRect(x * 8 + (horiz ? 0 : 1), y * 8 + (horiz ? 1 : 0), 8 - (horiz ? 0 : 2), 8 - (horiz ? 2 : 0));
  }
};

/** hazard stripes: deliberately chromatic yellow/black 45° chevrons — best on the accent role */
const paintHazard: Painter = (ctx, _rnd) => {
  ctx.fillStyle = '#232227'; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#f2c230';
  for (let i = -128; i < 256; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i + 20, 0); ctx.lineTo(i + 20 - 64, 128); ctx.lineTo(i - 64, 128);
    ctx.fill();
  }
};

/** gradient fade: white → mid-gray, top to bottom (palette fades darker toward the feet) */
const paintFade: Painter = (ctx, _rnd) => {
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#5a6270');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
};

/** rune/sigil decals: pseudo-glyphs (seeded segment runs on a 3x3 lattice) with a cold glow */
const paintRunes: Painter = (ctx, rnd) => {
  ctx.fillStyle = '#eef1f6'; ctx.fillRect(0, 0, 128, 128);
  const lattice = (cx: number, cy: number, cell: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++)
      pts.push([cx + gx * (cell / 2), cy + gy * (cell / 2)]);
    return pts;
  };
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
    if (rnd() < 0.35) continue; // some cells stay bare
    const cx = gx * 32 + 4, cy = gy * 32 + 4, cell = 24;
    const pts = lattice(cx, cy, cell);
    let p = Math.floor(rnd() * 9);
    ctx.strokeStyle = '#7d8698';
    ctx.lineWidth = 2.5;
    try { ctx.shadowBlur = 8; ctx.shadowColor = '#9fd8ff'; } catch { /* canvas stubs */ }
    ctx.beginPath();
    ctx.moveTo(pts[p][0], pts[p][1]);
    const segs = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < segs; k++) {
      const nb = [p - 3, p + 3, p - 1, p + 1].filter((q) => q >= 0 && q < 9 && q !== p);
      p = nb[Math.floor(rnd() * nb.length)];
      ctx.lineTo(pts[p][0], pts[p][1]);
    }
    ctx.stroke();
    try { ctx.shadowBlur = 0; } catch { /* canvas stubs */ }
    ctx.fillStyle = '#4d5563';
    ctx.fillRect(pts[p][0] - 1, pts[p][1] - 1, 2, 2);
  }
};

const PAINTERS: Record<SkinTexturePattern, Painter> = {
  stripes: paintStripes,
  camo: paintCamo,
  digital: paintDigital,
  carbon: paintCarbon,
  hazard: paintHazard,
  fade: paintFade,
  runes: paintRunes,
};

/** Deterministic 128px canvas patterns for skin.texture.pattern. Returns null when no DOM canvas is available. */
export function makePatternTexture(pattern: SkinTexturePattern): THREE.CanvasTexture | null {
  const painter = PAINTERS[pattern];
  if (!painter) return null;
  try {
    const doc = (globalThis as unknown as { document?: Document }).document;
    const canvas = doc?.createElement('canvas');
    if (!canvas) return null;
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    painter(ctx, seededRnd(0x9e3779b9 ^ hashStr(pattern)));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  } catch {
    return null;
  }
}

const TEX_URL_RE = /^https:\/\/[^?#]+\.(png|jpe?g|webp)(\?.*)?$/i;
const textureLoader = new TextureLoader();

const VALID_TEX_ROLES: readonly string[] = SKIN_TEXTURE_ROLES;

/**
 * Apply a skin to a rig. Mutates only owned, role-tagged materials — shared
 * library materials are never touched (verified by unit test). Never throws.
 *
 * Voxel armor (art-direction pass): a skin naming an armor set renders the
 * set's boxy shells automatically; the skin's visor overrides the set's
 * default slit color. Skins without `armor` render exactly as before and
 * strip any skin-origin armor (a re-skin is a full look change); item-origin
 * armor from equipped gear is left alone. No-op on rigs without pivots
 * (e.g. imported GLB rigs — the roles.size === 0 early return above).
 *
 * Seeded auto-armor (graphics follow-up, worker E): with `opts.autoArmor`
 * true and a valid `opts.seed`, a skin with NO explicit `armor` picks a set
 * deterministically via pickVoxelArmorSetId(seed) instead of rendering
 * armor-free. An explicit `skin.armor` always wins over auto. With the flag
 * absent/false the legacy path is byte-identical to the pre-flag behavior.
 */
export function applySkin(rig: { group: THREE.Object3D }, skin: SkinDef, opts?: ApplySkinOptions): void {
  try {
    const roles = roleMaterials(rig.group);
    if (roles.size === 0) return; // e.g. an imported GLB rig — skins are procedural-only
    const all = [...roles.values()].flat();

    // palette → per-role colors
    if (skin.palette) {
      for (const [role, hex] of Object.entries(skin.palette)) {
        if (!isHex(hex)) continue;
        for (const mat of roles.get(role) ?? []) {
          try { mat.color.set(hex); } catch { /* skip */ }
        }
      }
      // accentDS (cape cloth) mirrors the accent role when the skin doesn't name it
      if (skin.palette.accent && isHex(skin.palette.accent)) {
        for (const mat of roles.get('accentDS') ?? []) {
          try { mat.color.set(skin.palette.accent); } catch { /* skip */ }
        }
      }
    }
    if (typeof skin.roughness === 'number' && Number.isFinite(skin.roughness))
      for (const mat of all) mat.roughness = THREE.MathUtils.clamp(skin.roughness, 0, 1);
    if (typeof skin.metalness === 'number' && Number.isFinite(skin.metalness))
      for (const mat of all) mat.metalness = THREE.MathUtils.clamp(skin.metalness, 0, 1);
    if (skin.emissive && isHex(skin.emissive.color)) {
      const inten = THREE.MathUtils.clamp(skin.emissive.intensity ?? 0, 0, 5);
      for (const mat of [...(roles.get('accent') ?? []), ...(roles.get('accentDS') ?? [])]) {
        try { mat.emissive.set(skin.emissive!.color); mat.emissiveIntensity = inten; } catch { /* skip */ }
      }
    }

    // texture → textureRoles (default shirt+pants). URL loads async; on any failure the palette stands.
    const texRoles = (skin.textureRoles?.length ? skin.textureRoles : ['shirt', 'pants'])
      .filter((r) => VALID_TEX_ROLES.includes(r));
    const applyTex = (tex: THREE.Texture) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      for (const mat of texRoles.flatMap((r) => roles.get(r) ?? [])) {
        try { mat.map = tex; mat.needsUpdate = true; } catch { /* skip */ }
      }
    };
    const t = skin.texture;
    if (t && 'pattern' in t) {
      const tex = makePatternTexture(t.pattern);
      if (tex) applyTex(tex);
    } else if (t && 'url' in t && typeof t.url === 'string' && TEX_URL_RE.test(t.url)) {
      textureLoader.load(t.url, applyTex, undefined, () => { /* procedural fallback: palette stands */ });
    }

    // Voxel armor (art-direction pass): a skin naming an armor set renders the
    // set's boxy shells automatically; the skin's visor overrides the set's
    // default slit color. Seeded auto-armor (worker E, opt-in via
    // custom.armor.auto): a skin with no explicit `armor` renders the
    // deterministic set from pickVoxelArmorSetId(seed); an explicit
    // `skin.armor` always wins. Skins without `armor` and without auto-armor
    // render exactly as before and strip any skin-origin armor (a re-skin is
    // a full look change); item-origin armor from equipped gear is left
    // alone. No-op on rigs without pivots (e.g. imported GLB rigs — the
    // roles.size === 0 early return above).
    const explicitArmorId = typeof skin.armor === 'string' && skin.armor ? skin.armor : undefined;
    const autoArmorId = !explicitArmorId && opts?.autoArmor === true &&
      typeof opts.seed === 'number' && Number.isInteger(opts.seed)
      ? pickVoxelArmorSetId(opts.seed) : undefined;
    const armorId = explicitArmorId ?? autoArmorId;
    const cRig = rig as CharacterRig;
    if (armorId && resolveVoxelArmorSet(armorId)) {
      const visorColor = skin.visor && isHex(skin.visor.color) ? skin.visor.color : undefined;
      const visorIntensity = skin.visor && typeof skin.visor.intensity === 'number' &&
        Number.isFinite(skin.visor.intensity)
        ? THREE.MathUtils.clamp(skin.visor.intensity, 0, 5) : undefined;
      applyVoxelArmor(cRig, armorId, { visorColor, visorIntensity, origin: 'skin' });
    } else {
      clearVoxelArmor(cRig, undefined, 'skin');
    }
  } catch {
    // skins must never break generation — a bad skin is a no-op
  }
}
