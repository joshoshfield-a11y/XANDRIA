/**
 * Baked textures — graphics-overhaul Pass 0 spike (branch: gfx-overhaul).
 *
 * AI-generated textures, baked ONCE into the repo as static assets and
 * imported here. Vite inlines them as data URIs (assetsInlineLimit is
 * 100MB in vite.config.ts), so the single-file player/studio bundles stay
 * self-contained and offline-capable. Nothing here generates art at
 * runtime, fetches from a network, or depends on AssetBridge.
 *
 * Masters (full-res PNGs) live next to the spike report, not in src/ —
 * only the WebP bake ships in the bundle. Normal maps are Sobel-derived
 * from the albedo luminance at authoring time (wrap-around gradients,
 * so they tile like the albedo).
 *
 * Fallback contract: unknown ids return null — callers (Skins.applySkin,
 * Materials.biomeGroundDef) fall back to the canvas/palette path and
 * never throw. A baked texture failing to decode leaves the palette
 * standing, exactly like the existing https-URL texture path.
 */
import * as THREE from 'three';
import spikeShirtMap from '../../assets/baked/spike-shirt.webp';
import spikeShirtNormal from '../../assets/baked/spike-shirt-normal.webp';
import spikeGroundMap from '../../assets/baked/spike-ground.webp';
import spikeGroundNormal from '../../assets/baked/spike-ground-normal.webp';
import fabricCarbonMap from '../../assets/baked/fabric-carbon.webp';
import fabricCamoMap from '../../assets/baked/fabric-camo.webp';
import pantsDenimMap from '../../assets/baked/pants-denim.webp';
import skinMatteMap from '../../assets/baked/skin-matte.webp';
import accentRunesMap from '../../assets/baked/accent-runes.webp';
import accentHazardMap from '../../assets/baked/accent-hazard.webp';
import groundGrassMap from '../../assets/baked/ground-grass.webp';
import groundGrassNormal from '../../assets/baked/ground-grass-normal.webp';
import groundCrackedMap from '../../assets/baked/ground-cracked.webp';
import groundCrackedNormal from '../../assets/baked/ground-cracked-normal.webp';
import groundLitterMap from '../../assets/baked/ground-litter.webp';
import groundLitterNormal from '../../assets/baked/ground-litter-normal.webp';
import groundSnowMap from '../../assets/baked/ground-snow.webp';
import groundSnowNormal from '../../assets/baked/ground-snow-normal.webp';
import groundBasaltMap from '../../assets/baked/ground-basalt.webp';
import groundBasaltNormal from '../../assets/baked/ground-basalt-normal.webp';
import groundWetsandMap from '../../assets/baked/ground-wetsand.webp';
import groundWetsandNormal from '../../assets/baked/ground-wetsand-normal.webp';
import groundCaverockMap from '../../assets/baked/ground-caverock.webp';
import groundCaverockNormal from '../../assets/baked/ground-caverock-normal.webp';
import itemBrushedMap from '../../assets/baked/item-brushed.webp';
import itemWoodMap from '../../assets/baked/item-wood.webp';
import itemEnergyMap from '../../assets/baked/item-energy.webp';


export interface BakedTextureDef {
  /** albedo data URI (vite-inlined) or dev-server URL */
  map: string;
  /** tangent-space normal map, same tiling as the albedo */
  normal?: string;
  /** mirrored repeat: atlas-sliced ground tiles are not seamlessly
   *  tileable at their edges, so ground textures mirror at tile
   *  boundaries instead of showing a seam line (Pass A QC finding). */
  mirror?: boolean;
}

/** Spike set + Pass A atlas tiles (see SPIKE-REPORT.md / OVERHAUL-REPORT). */
export const BAKED_TEXTURES: Record<string, BakedTextureDef> = {
  'spike-shirt': { map: spikeShirtMap, normal: spikeShirtNormal },
  'spike-ground': { map: spikeGroundMap, normal: spikeGroundNormal },
  // Pass A (full overhaul): atlas-sliced tiles. Ground tiles carry 128px
  // Sobel normals; character/item tiles are albedo-only (their relief
  // comes from the albedo contrast, and the bundle stays under budget).
  'fabric-carbon': { map: fabricCarbonMap },
  'fabric-camo': { map: fabricCamoMap },
  'pants-denim': { map: pantsDenimMap },
  'skin-matte': { map: skinMatteMap },
  'accent-runes': { map: accentRunesMap },
  'accent-hazard': { map: accentHazardMap },
  'ground-grass': { mirror: true, map: groundGrassMap, normal: groundGrassNormal },
  'ground-cracked': { mirror: true, map: groundCrackedMap, normal: groundCrackedNormal },
  'ground-litter': { mirror: true, map: groundLitterMap, normal: groundLitterNormal },
  'ground-snow': { mirror: true, map: groundSnowMap, normal: groundSnowNormal },
  'ground-basalt': { mirror: true, map: groundBasaltMap, normal: groundBasaltNormal },
  'ground-wetsand': { mirror: true, map: groundWetsandMap, normal: groundWetsandNormal },
  'ground-caverock': { mirror: true, map: groundCaverockMap, normal: groundCaverockNormal },
  'item-brushed': { map: itemBrushedMap },
  'item-wood': { map: itemWoodMap },
  'item-energy': { map: itemEnergyMap },
};

export function hasBakedTexture(id: string): boolean {
  return id in BAKED_TEXTURES;
}

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();

function loadCached(url: string, srgb: boolean, mirror = false): THREE.Texture {
  const key = `${srgb ? 'srgb' : 'lin'}:${mirror ? 'mir' : 'rep'}:${url}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let tex: THREE.Texture;
  try {
    tex = loader.load(url);
  } catch {
    // DOM-less runtimes (node tests without a createElementNS stub):
    // a bare Texture still carries the registry identity, so callers
    // stamp the right object and fall back to palette on decode failure
    // exactly as the URL-texture path does. Never throws.
    tex = new THREE.Texture();
  }
  const wrap = mirror ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  tex.wrapS = tex.wrapT = wrap;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Albedo texture for a baked id, or null when the id is unknown. */
export function bakedTexture(id: string): THREE.Texture | null {
  const def = BAKED_TEXTURES[id];
  if (!def) return null;
  return loadCached(def.map, true, def.mirror ?? false);
}

/** Normal-map twin for a baked id, or null when unknown / absent. */
export function bakedNormalTexture(id: string): THREE.Texture | null {
  const def = BAKED_TEXTURES[id];
  if (!def?.normal) return null;
  return loadCached(def.normal, false, def.mirror ?? false);
}
