/**
 * Procedural textures + materials. No external assets: every texture is painted onto a canvas at boot
 * from the spec palette + seed. Sized for the PS2-era look (256px, nearest-ish filtering optional).
 */
import * as THREE from 'three';
import type { GameSpec, Palette, Environment } from '@spec';
import { Noise2D, Rng } from '../core/Rng';
import { bakedTexture, bakedNormalTexture } from './BakedTextures';

export type TexKind = 'ground' | 'rock' | 'metal' | 'brick' | 'wood' | 'grid' | 'sand' | 'snow' | 'lava' | 'asphalt' | 'concrete' | 'crystal' | 'panel'
  /** env-art pass: cracked desert earth, glittering snow, ember-cracked basalt, darkened wet sand */
  | 'cracked' | 'snowdrift' | 'emberrock' | 'wetsand';

/**
 * Graphics wave 2, workstream A — shared uniforms for the ground detail
 * normal layer (see applyGroundDetail below). ONE object for every ground
 * material: the quality tier sets .value live (no recompile, no second code
 * path) from Engine.applySettings / boot. Feature-flagged fidelity, not two
 * materials.
 */
export const groundDetailUniforms = {
  /** 0 = off (retro), ~0.55 (standard/S25), 1 = full (high/desktop) */
  uDetailStrength: { value: 0.55 },
  /** world-space distance the detail layer fades out by (m) */
  uDetailFade: { value: 45 },
};

/** Quality-tier -> detail layer tuning. Called on boot and on pause-menu quality changes. */
export function applyGroundDetailForQuality(q: 'retro' | 'standard' | 'high'): void {
  groundDetailUniforms.uDetailStrength.value = q === 'high' ? 1 : q === 'standard' ? 0.55 : 0;
  groundDetailUniforms.uDetailFade.value = q === 'high' ? 70 : 45;
}

/**
 * Micro-detail normal layer for ground materials: re-samples the material's
 * OWN biome normal map at high frequency (~0.85m tiles) from world-space
 * coords, so it survives close-up where the 8m macro tile goes soft. One
 * extra texture sample + ~15 ALU per ground fragment inside the fade
 * distance, on the one shared material — zero new draw calls, zero new
 * textures, no per-frame CPU. Fades out with view distance (no moiré at
 * range); the S25/standard tier gets a shorter fade + softer strength via
 * the shared uniforms above.
 */
function applyGroundDetail(m: THREE.MeshStandardMaterial): void {
  if ((m.userData as { groundDetail?: boolean }).groundDetail) return;
  (m.userData as { groundDetail?: boolean }).groundDetail = true;
  m.customProgramCacheKey = () => 'xandria-ground-detail-v1';
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.uDetailStrength = groundDetailUniforms.uDetailStrength;
    shader.uniforms.uDetailFade = groundDetailUniforms.uDetailFade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uDetailStrength;\nuniform float uDetailFade;\nvarying vec3 vGroundWPos;',
      )
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        // detail bump from the biome normal map at ~0.85m tiling, sampled in
        // world space so chunk-local UVs don't matter; faded by view distance
        float dFade = 1.0 - smoothstep(uDetailFade * 0.55, uDetailFade, length(vViewPosition));
        float dAmt = uDetailStrength * dFade;
        if (dAmt > 0.003) {
          // normalMap is the biome normal map (declared by three when
          // USE_NORMALMAP) — tangent-space; the terrain is XZ-planar so its
          // xy maps straight onto world xz as a bump perturbation.
          vec3 dT = texture2D(normalMap, vGroundWPos.xz * ${(1 / 0.85).toFixed(4)}).xyz * 2.0 - 1.0;
          vec3 bumpW = normalize(vec3(dT.x * 0.55, 1.0, -dT.y * 0.55));
          vec3 bumpV = normalize((viewMatrix * vec4(bumpW, 0.0)).xyz);
          normal = normalize(mix(normal, bumpV, dAmt * 0.85));
          // whisper of albedo variation so the detail reads in flat light too
          diffuseColor.rgb *= 1.0 + (dT.z - 0.72) * 0.14 * dAmt;
        }
      }`);
  };
}

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
    // T1-3: keep the fbm mix factor as a height field — the Sobel pass below
    // turns it into a tangent-space normal map (deterministic, same seed).
    const heights = new Float32Array(size * size);
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
          case 'cracked': {
            // desert cracked earth: dark crack veins on a sand base
            const r = Math.abs(n.fbm(u * 7, v * 7, 4));
            const crack = r < 0.09 ? 1 : 0;
            const f = n.fbm(u * 8, v * 8, 4);
            t = (f + 1) / 2;
            extra = n.get(u * 60, v * 60) * 0.06 - crack * 0.35;
            break;
          }
          case 'snowdrift': {
            // snow with deterministic sparkle glints
            const f = n.fbm(u * 8, v * 8, 4);
            t = (f + 1) / 2;
            extra = n.get(u * 60, v * 60) * 0.06 + 0.15
              + (n.get(u * 230 + 7.3, v * 230 + 3.1) > 0.82 ? 0.55 : 0);
            break;
          }
          case 'emberrock': {
            // volcanic basalt: dark plates, crack veins painted bright (the
            // emissiveMap twin carries the actual glow — see emissiveMap())
            const r = Math.abs(n.fbm(u * 6, v * 6, 4));
            const crack = r < 0.11 ? 1 : 0;
            const f = n.fbm(u * 6, v * 6, 5, 2.2, 0.55);
            t = Math.pow((f + 1) / 2, 1.3);
            extra = -0.25 + n.get(u * 90, v * 90) * 0.06 + crack * 0.45;
            break;
          }
          case 'wetsand': {
            // coast wet sand: sand darkened and smoothed
            const f = n.fbm(u * 6, v * 6, 3);
            t = (f + 1) / 2;
            extra = n.get(u * 60, v * 60) * 0.04 - 0.14;
            break;
          }
        }
        tmp.copy(base).lerp(alt, t).offsetHSL(0, 0, extra);
        heights[y * size + x] = t;
        // Canvas ImageData is sRGB: convert out of the linear working space.
        // (Writing linear values here double-darkened every texture ~10x once
        // the renderer re-converted the sRGB-marked texture — structures
        // rendered near-black even at noon.)
        tmp.convertLinearToSRGB();
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

    // T1-3: tangent-space normal map from the height field via a Sobel
    // filter with wraparound sampling (textures tile). Canvas row 0 uploads
    // to v=1 (flipY), so the canvas-space Y gradient is negated to land in
    // GL tangent space. Normal maps stay linear — never sRGB.
    const nrmKey = `nrm:${key}`;
    if (!this.cache.has(nrmKey)) {
      const nc = document.createElement('canvas');
      nc.width = size; nc.height = size;
      const nctx = nc.getContext('2d')!;
      const nimg = nctx.createImageData(size, size);
      const nd = nimg.data;
      const hgt = (x: number, y: number) => heights[((y + size) % size) * size + ((x + size) % size)];
      const STRENGTH = 2.0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = (hgt(x - 1, y) - hgt(x + 1, y)) * STRENGTH;
          const dy = (hgt(x, y - 1) - hgt(x, y + 1)) * STRENGTH;
          const inv = 1 / Math.hypot(dx, dy, 1);
          const i = (y * size + x) * 4;
          nd[i] = (dx * inv * 0.5 + 0.5) * 255;
          nd[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
          nd[i + 2] = (inv * 0.5 + 0.5) * 255;
          nd[i + 3] = 255;
        }
      }
      nctx.putImageData(nimg, 0, 0);
      const nrm = new THREE.CanvasTexture(nc);
      nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
      nrm.anisotropy = 4;
      if (this.pixelated) { nrm.magFilter = THREE.NearestFilter; nrm.minFilter = THREE.NearestMipMapNearestFilter; }
      if (opts.repeat) nrm.repeat.set(opts.repeat, opts.repeat);
      this.cache.set(nrmKey, nrm);
    }
    return tex;
  }

  /**
   * Tangent-space normal map generated alongside texture() from the same
   * seeded fbm height field. Linear space, cached the same way.
   */
  normalMap(kind: TexKind, baseHex: string, opts: { size?: number; alt?: string; repeat?: number } = {}): THREE.Texture {
    const key = `nrm:${kind}:${baseHex}:${opts.alt ?? ''}:${opts.size ?? 256}`;
    this.texture(kind, baseHex, opts); // ensures the normal twin is built
    return this.cache.get(key)!;
  }

  /**
   * Emissive twin for ember-style textures: black everywhere except the
   * crack veins, which glow. Currently only 'emberrock' has veins; other
   * kinds return a plain black texture. Deterministic, cached.
   */
  emissiveMap(kind: TexKind, opts: { size?: number; repeat?: number; glowHex?: string } = {}): THREE.Texture {
    const size = opts.size ?? 256;
    const key = `em:${kind}:${opts.glowHex ?? '#ff7a1a'}:${size}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const n = this.noise;
    const glow = new THREE.Color(opts.glowHex ?? '#ff7a1a');
    const gr = Math.round(glow.r * 255), gg = Math.round(glow.g * 255), gb = Math.round(glow.b * 255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        let e = 0;
        if (kind === 'emberrock') {
          const r = Math.abs(n.fbm(u * 6, v * 6, 4));
          if (r < 0.11) e = 1 - r / 0.11; // hot core, cooler edges
        }
        const i = (y * size + x) * 4;
        d[i] = gr * e; d[i + 1] = gg * e; d[i + 2] = gb * e; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // emissive maps stay linear — never sRGB
    tex.anisotropy = 4;
    if (this.pixelated) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipMapNearestFilter; }
    if (opts.repeat) tex.repeat.set(opts.repeat, opts.repeat);
    this.cache.set(key, tex);
    return tex;
  }

  /**
   * Environment art-direction pass: richer per-biome ground treatments.
   * Desert/wasteland → cracked earth; arctic → glittering snow;
   * volcanic → ember-cracked basalt (emissive veins); islands → darkened wet
   * sand. Everything else falls back to the existing groundKind mapping.
   * Cached like standard() — callers must not dispose the result.
   */
  biomeGround(env: Environment, opts: { repeat?: number; roughness?: number } = {}): THREE.MeshStandardMaterial {
    const key = `biome:${env}:${opts.repeat ?? 0}:${opts.roughness ?? 0}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const rep = { repeat: opts.repeat };
    let m: THREE.MeshStandardMaterial;
    if (env === 'desert' || env === 'wasteland') {
      m = new THREE.MeshStandardMaterial({
        map: this.texture('cracked', '#ffffff', { alt: shade('#ffffff', -0.1), ...rep }),
        normalMap: this.normalMap('cracked', '#ffffff', { alt: shade('#ffffff', -0.1), ...rep }),
        roughness: opts.roughness ?? 0.95,
      });
    } else if (env === 'arctic') {
      m = new THREE.MeshStandardMaterial({
        map: this.texture('snowdrift', '#ffffff', { alt: shade('#ffffff', -0.06), ...rep }),
        normalMap: this.normalMap('snowdrift', '#ffffff', { alt: shade('#ffffff', -0.06), ...rep }),
        roughness: opts.roughness ?? 0.7,
      });
    } else if (env === 'volcanic') {
      m = new THREE.MeshStandardMaterial({
        map: this.texture('emberrock', '#ffffff', { alt: shade('#ffffff', -0.1), ...rep }),
        normalMap: this.normalMap('emberrock', '#ffffff', { alt: shade('#ffffff', -0.1), ...rep }),
        emissiveMap: this.emissiveMap('emberrock', { ...rep }),
        emissive: new THREE.Color('#ff5a1a'),
        emissiveIntensity: 1.1,
        roughness: opts.roughness ?? 0.95,
      });
    } else if (env === 'islands') {
      m = new THREE.MeshStandardMaterial({
        map: this.texture('wetsand', '#ffffff', { alt: shade('#ffffff', -0.08), ...rep }),
        normalMap: this.normalMap('wetsand', '#ffffff', { alt: shade('#ffffff', -0.08), ...rep }),
        roughness: opts.roughness ?? 0.85,
      });
    } else {
      const kind = MaterialLibrary.groundKind(env);
      m = new THREE.MeshStandardMaterial({
        map: this.texture(kind, '#ffffff', { alt: shade('#ffffff', -0.1), ...rep }),
        normalMap: this.normalMap(kind, '#ffffff', { alt: shade('#ffffff', -0.1), ...rep }),
        roughness: opts.roughness ?? 0.95,
      });
    }
    this.matCache.set(key, m);
    return m;
  }

  /**
   * Biome-treatment ground (workstream C): BiomeDef-driven sibling of
   * biomeGround(). Same caching contract — callers must not dispose the
   * result. Structural param (not the BiomeDef type) so gfx/ never imports
   * world/. `emissive` paints glowing crack veins (volcanic emberrock).
   */
  biomeGroundDef(g: { kind: TexKind; base: string; alt: string; roughness: number; emissive?: string; emissiveIntensity?: number; baked?: string }, opts: { repeat?: number } = {}): THREE.MeshStandardMaterial {
    const key = `biomedef:${g.kind}:${g.base}:${g.alt}:${g.roughness}:${g.emissive ?? ''}:${g.emissiveIntensity ?? 0}:${opts.repeat ?? 0}:${g.baked ?? ''}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const rep = { repeat: opts.repeat };
    // Graphics-overhaul Pass 0 spike: a baked ground id replaces the canvas
    // texture + normal twin with the baked pair. Unknown id → canvas path
    // below (the fallback is the branch, not a throw).
    if (g.baked) {
      const bmap = bakedTexture(g.baked);
      if (bmap) {
        if (opts.repeat) { bmap.repeat.set(opts.repeat, opts.repeat); }
        const bnrm = bakedNormalTexture(g.baked);
        if (bnrm && opts.repeat) { bnrm.repeat.set(opts.repeat, opts.repeat); }
        const bm = new THREE.MeshStandardMaterial({
          map: bmap, normalMap: bnrm ?? undefined, roughness: g.roughness,
        });
        if (g.emissive) {
          bm.emissive = new THREE.Color(g.emissive);
          bm.emissiveIntensity = g.emissiveIntensity ?? 1;
        }
        applyGroundDetail(bm);
        this.matCache.set(key, bm);
        return bm;
      }
    }
    const m = new THREE.MeshStandardMaterial({
      map: this.texture(g.kind, g.base, { alt: g.alt, ...rep }),
      normalMap: this.normalMap(g.kind, g.base, { alt: g.alt, ...rep }),
      roughness: g.roughness,
    });
    if (g.emissive) {
      m.emissiveMap = this.emissiveMap(g.kind, { ...rep, glowHex: g.emissive });
      m.emissive = new THREE.Color(g.emissive);
      m.emissiveIntensity = g.emissiveIntensity ?? 1;
    }
    // Graphics wave 2, workstream A: close-up micro-detail normal layer on
    // the shared material (zero new draw calls — see applyGroundDetail).
    applyGroundDetail(m);
    this.matCache.set(key, m);
    return m;
  }

  standard(kind: TexKind, hex: string, opts: { alt?: string; repeat?: number; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number } = {}): THREE.MeshStandardMaterial {
    const key = `std:${kind}:${hex}:${JSON.stringify(opts)}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({
      map: this.texture(kind, hex, { alt: opts.alt, repeat: opts.repeat }),
      normalMap: this.normalMap(kind, hex, { alt: opts.alt, repeat: opts.repeat }),
      roughness: opts.roughness ?? (kind === 'metal' || kind === 'panel' ? 0.45 : 0.9),
      metalness: opts.metalness ?? (kind === 'metal' || kind === 'panel' ? 0.5 : 0),
    });
    if (opts.emissive) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity ?? 1; }
    this.matCache.set(key, m);
    return m;
  }

  flat(hex: string, opts: { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number; transparent?: boolean; opacity?: number; vertexColors?: boolean } = {}): THREE.MeshStandardMaterial {
    const key = `flat:${hex}:${JSON.stringify(opts)}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    // NB: never pass undefined transparent/opacity — three warns
    // "THREE.Material: parameter 'transparent'/'opacity' has value of undefined" (N2).
    const params: THREE.MeshStandardMaterialParameters = {
      color: hex,
      roughness: opts.roughness ?? 0.7,
      metalness: opts.metalness ?? 0.1,
    };
    if (opts.transparent !== undefined) params.transparent = opts.transparent;
    if (opts.opacity !== undefined) params.opacity = opts.opacity;
    // Graphics wave 2 (workstream B): vegetation foliage carries per-vertex
    // colors (canopy white × undergrowth tints). The flag is part of the
    // cache key, so non-vegetation users of the same hex are unaffected.
    if (opts.vertexColors) params.vertexColors = true;
    const m = new THREE.MeshStandardMaterial(params);
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

  /** True when this material came from the library cache (shared — callers must not dispose it). */
  ownsMaterial(m: THREE.Material): boolean {
    for (const cached of this.matCache.values()) if (cached === m) return true;
    return false;
  }

  /** True when this texture came from the library cache (shared — callers must not dispose it). */
  ownsTexture(t: THREE.Texture): boolean {
    for (const cached of this.cache.values()) if (cached === t) return true;
    return false;
  }

  dispose() {
    for (const t of this.cache.values()) t.dispose();
    for (const m of this.matCache.values()) m.dispose();
  }
}

export function shade(hex: string, dl: number): string {
  return '#' + new THREE.Color(hex).offsetHSL(0, 0, dl).getHexString();
}
