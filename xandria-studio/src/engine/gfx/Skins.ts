/**
 * Character skins (workstream D) — palette / emissive / texture overrides
 * applied to a procedural CharacterRig's OWNED, role-tagged materials
 * (userData.role = skin|shirt|pants|accent|accentDS, stamped in makeHumanoid).
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
 */
import * as THREE from 'three';
import { TextureLoader } from 'three';
import type { GameSpec, SkinDef, SkinTexturePattern } from '@spec';

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

/** Deterministic 128px canvas patterns for skin.texture.pattern. Returns null when no DOM canvas is available. */
export function makePatternTexture(pattern: SkinTexturePattern): THREE.CanvasTexture | null {
  try {
    const doc = (globalThis as unknown as { document?: Document }).document;
    const canvas = doc?.createElement('canvas');
    if (!canvas) return null;
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // tiny deterministic PRNG so the pattern is stable across sessions
    let s = 0x9e3779b9;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
    const fill = (c: string) => { ctx.fillStyle = c; ctx.fillRect(0, 0, 128, 128); };
    if (pattern === 'stripes') {
      fill('#20242c');
      ctx.fillStyle = '#3a4150';
      for (let i = -128; i < 256; i += 24) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i + 12, 0); ctx.lineTo(i + 12 - 64, 128); ctx.lineTo(i - 64, 128);
        ctx.fill();
      }
    } else if (pattern === 'camo') {
      fill('#3a4432');
      const cols = ['#2c3527', '#55603f', '#1e241b'];
      for (let i = 0; i < 26; i++) {
        ctx.fillStyle = cols[i % 3];
        ctx.beginPath();
        ctx.ellipse(rnd() * 128, rnd() * 128, 8 + rnd() * 18, 6 + rnd() * 14, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (pattern === 'digital') {
      fill('#14161c');
      const cols = ['#1e2530', '#232d3d', '#2c3d55'];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        if (rnd() < 0.45) { ctx.fillStyle = cols[(x * 7 + y * 13) % 3]; ctx.fillRect(x * 8, y * 8, 8, 8); }
      }
    } else {
      // carbon weave
      fill('#101114');
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const horiz = (x + y) % 2 === 0;
        ctx.fillStyle = horiz ? '#1c1e24' : '#26282f';
        ctx.fillRect(x * 8 + (horiz ? 0 : 1), y * 8 + (horiz ? 1 : 0), 8 - (horiz ? 0 : 2), 8 - (horiz ? 2 : 0));
      }
    }
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

/**
 * Apply a skin to a rig. Mutates only owned, role-tagged materials — shared
 * library materials are never touched (verified by unit test). Never throws.
 */
export function applySkin(rig: { group: THREE.Object3D }, skin: SkinDef): void {
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

    // texture → shirt + pants. URL loads async; on any failure the palette stands.
    const applyTex = (tex: THREE.Texture) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      for (const mat of [...(roles.get('shirt') ?? []), ...(roles.get('pants') ?? [])]) {
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
  } catch {
    // skins must never break generation — a bad skin is a no-op
  }
}
