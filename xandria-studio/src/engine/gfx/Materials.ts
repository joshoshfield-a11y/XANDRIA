/**
 * Procedural textures + materials. No external assets: every texture is painted onto a canvas at boot
 * from the spec palette + seed. Sized for the PS2-era look (256px, nearest-ish filtering optional).
 */
import * as THREE from 'three';
import type { GameSpec, Palette } from '@spec';
import { Noise2D, Rng } from '../core/Rng';

export type TexKind = 'ground' | 'rock' | 'metal' | 'brick' | 'wood' | 'grid' | 'sand' | 'snow' | 'lava' | 'asphalt' | 'concrete' | 'crystal' | 'panel';

export class MaterialLibrary {
  private cache = new Map<string, THREE.Texture>();
  private matCache = new Map<string, THREE.Material>();
  readonly palette: Palette;
  private noise: Noise2D;
  private rng: Rng;
  readonly pixelated: boolean;

  constructor(spec: GameSpec) {
    this.palette = spec.theme.palette;
    this.noise = new Noise2D(spec.meta.seed ^ 0x7e57);
    this.rng = new Rng(spec.meta.seed ^ 0x3a7);
    this.pixelated = spec.theme.retroFilter;
  }

  texture(kind: TexKind, baseHex: string, opts: { size?: number; alt?: string; repeat?: number } = {}): THREE.Texture {
    const key = `${kind}:${baseHex}:${opts.alt ?? ''}:${opts.size ?? 256}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const size = opts.size ?? 256;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const base = new THREE.Color(baseHex);
    const alt = new THREE.Color(opts.alt ?? baseHex).offsetHSL(0, 0, -0.12);
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const n = this.noise;
    const put = (i: number, c: THREE.Color) => { d[i] = c.r * 255; d[i + 1] = c.g * 255; d[i + 2] = c.b * 255; d[i + 3] = 255; };
    const tmp = new THREE.Color();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const u = x / size, v = y / size;
        let t = 0; // mix factor
        let extra = 0; // brightness delta
        switch (kind) {
          case 'ground': case 'sand': case 'snow': {
            const f = n.fbm(u * 8, v * 8, 4);
            t = (f + 1) / 2;
            extra = n.get(u * 60, v * 60) * 0.06;
            if (kind === 'snow') extra += 0.15;
            break;
          }
          case 'rock': case 'concrete': {
            const f = n.fbm(u * 6, v * 6, 5, 2.2, 0.55);
            t = Math.pow((f + 1) / 2, 1.3);
            extra = n.get(u * 90, v * 90) * 0.08 + (kind === 'concrete' ? 0.05 : 0);
            break;
          }
          case 'lava': {
            const f = Math.abs(n.fbm(u * 5, v * 5, 4));
            t = f < 0.15 ? 1 : 0;
            extra = f < 0.15 ? 0.6 : -0.3 + n.get(u * 30, v * 30) * 0.1;
            break;
          }
          case 'metal': case 'panel': {
            const cell = kind === 'panel' ? 4 : 8;
            const gx = Math.floor(u * cell), gy = Math.floor(v * cell);
            const edge = Math.min((u * cell) % 1, 1 - (u * cell) % 1, (v * cell) % 1, 1 - (v * cell) % 1) < 0.04;
            t = ((gx + gy) % 2) * 0.35;
            extra = (edge ? -0.25 : 0) + n.get(u * 40, v * 40) * 0.05 + (kind === 'panel' && (gx * 7 + gy * 3) % 5 === 0 ? 0.08 : 0);
            break;
          }
          case 'brick': {
            const bw = 1 / 6, bh = 1 / 12;
            const row = Math.floor(v / bh);
            const off = row % 2 ? bw / 2 : 0;
            const bx = ((u + off) % bw) / bw, by = (v % bh) / bh;
            const mortar = bx < 0.06 || by < 0.1;
            t = mortar ? 1 : 0;
            extra = mortar ? -0.2 : n.get(u * 50 + row, v * 50) * 0.08;
            break;
          }
          case 'wood': {
            const f = n.fbm(u * 2, v * 30, 3);
            t = (f + 1) / 2;
            extra = n.get(u * 4, v * 200) * 0.05;
            break;
          }
          case 'asphalt': {
            t = 0; extra = n.get(u * 120, v * 120) * 0.07 - 0.05;
            break;
          }
          case 'grid': {
            const g = 8;
            const line = Math.min((u * g) % 1, 1 - (u * g) % 1, (v * g) % 1, 1 - (v * g) % 1) < 0.03;
            t = line ? 1 : 0; extra = line ? 0.7 : -0.35;
            break;
          }
          case 'crystal': {
            const f = n.fbm(u * 10, v * 10, 3);
            t = (f + 1) / 2; extra = Math.abs(n.get(u * 25, v * 25)) * 0.3;
            break;
          }
        }
        tmp.copy(base).lerp(alt, t).offsetHSL(0, 0, extra);
        put(i, tmp);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (this.pixelated) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipMapNearestFilter; }
    if (opts.repeat) tex.repeat.set(opts.repeat, opts.repeat);
    this.cache.set(key, tex);
    return tex;
  }

  standard(kind: TexKind, hex: string, opts: { alt?: string; repeat?: number; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number } = {}): THREE.MeshStandardMaterial {
    const key = `std:${kind}:${hex}:${JSON.stringify(opts)}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({
      map: this.texture(kind, hex, { alt: opts.alt, repeat: opts.repeat }),
      roughness: opts.roughness ?? (kind === 'metal' || kind === 'panel' ? 0.45 : 0.9),
      metalness: opts.metalness ?? (kind === 'metal' || kind === 'panel' ? 0.5 : 0),
    });
    if (opts.emissive) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity ?? 1; }
    this.matCache.set(key, m);
    return m;
  }

  flat(hex: string, opts: { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number; transparent?: boolean; opacity?: number } = {}): THREE.MeshStandardMaterial {
    const key = `flat:${hex}:${JSON.stringify(opts)}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: opts.roughness ?? 0.7, metalness: opts.metalness ?? 0.1, transparent: opts.transparent, opacity: opts.opacity });
    if (opts.emissive) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity ?? 1; }
    this.matCache.set(key, m);
    return m;
  }

  glow(hex: string, intensity = 2): THREE.MeshStandardMaterial {
    return this.flat(hex, { emissive: hex, emissiveIntensity: intensity, roughness: 0.3 });
  }

  /** Ground texture kind by environment */
  static groundKind(env: GameSpec['theme']['environment']): TexKind {
    switch (env) {
      case 'desert': case 'wasteland': return 'sand';
      case 'arctic': return 'snow';
      case 'volcanic': return 'rock';
      case 'city': return 'concrete';
      case 'neon-city': return 'grid';
      case 'space-station': return 'panel';
      case 'ruins': return 'rock';
      case 'dreamscape': return 'crystal';
      default: return 'ground';
    }
  }

  dispose() {
    for (const t of this.cache.values()) t.dispose();
    for (const m of this.matCache.values()) m.dispose();
  }
}

export function shade(hex: string, dl: number): string {
  return '#' + new THREE.Color(hex).offsetHSL(0, 0, dl).getHexString();
}
