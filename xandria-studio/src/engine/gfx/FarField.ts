/**
 * Far-field scaling (Open World stage 1, workstream D; stage 1b workstream C
 * adds the shell resolution tiers + type-aware bias for multi-km worlds).
 *
 * Static config, NOT adaptive: every value below is a pure function of the
 * spec's world size, computed once at boot. The authored look stays the
 * source of truth — Biomes.ts BiomeDef fog densities are scaled, never
 * replaced, and the legacy 1400/0.1 camera planes are kept for every world
 * at/below the far-field knee so small worlds render byte-identical.
 *
 * Pure and deterministic — safe to unit test exhaustively.
 */

/** legacy camera far plane (Engine.ts) — kept for worlds at/below the knee */
export const LEGACY_CAMERA_FAR = 1400;
/** legacy camera near plane */
export const LEGACY_CAMERA_NEAR = 0.1;
/**
 * World size the authored fog densities were calibrated against (the
 * generator's default world size). Fog thins linearly with size above this.
 */
export const FOG_REFERENCE_SIZE = 220;
/**
 * The low-res far shell only pays off on big worlds — below this the detail
 * terrain already covers the frame out to the far plane.
 */
export const FAR_TERRAIN_MIN_SIZE = 500;

/**
 * Far-shell resolution tier (segments per side) as a pure function of world
 * size. Open World stage 1b (workstream C): the 64x64 shell was built for
 * 2km; on multi-km maps the tiers below keep the absolute cell size <= ~64m
 * so the shell stays faithful near the chunk-stream boundary (which sits
 * ~625m from the camera, nearly unfogged). The shell is static — it never
 * swaps or follows the camera — so there are no LOD transitions to pop;
 * every tier is exactly one draw call.
 */
export function farShellSegmentsForWorldSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 64;
  if (size <= 2000) return 64; // stage-1 sizes: byte-identical shell
  if (size <= 4000) return 96; // 41.7m cells at 4km
  return 128;                  // 62.5m cells at 8km (~33k tris, 1 draw call)
}

/**
 * Downward bias (negative meters) for the far shell, as a pure function of
 * the world spec. The shell must sit below the detail mesh everywhere it
 * overlaps, or it pokes through near steep features.
 *
 * Measured max |detail - shellBilinear| on the deterministic scene (seed
 * 20261012, 64-seg shell; scale-invariant — identical at 2/4/8km because the
 * height field is parameterized in normalized coords):
 *   hills/flat 1.81m, mountains 5.29m, canyon 19.81m (the canyon cliff step
 *   is 1.4*maxHeight by construction).
 * Stage-1's linear formula -(1.5 + size*0.001) covered hills but under-covered
 * mountains and canyons (the shell could float above canyon floors near
 * cliffs). The k factors below track the measurements with >=1.35x margin
 * and scale with maxHeight*heightScale, which is how the true error scales.
 * At 2km hills this yields -3.46m vs stage-1's -3.5m (4cm — invisible).
 */
export function farShellBias(terrainType: string, maxHeight: number, heightScale = 1): number {
  const k = terrainType === 'canyon' ? 1.4 : terrainType === 'mountains' ? 0.18 : 0.13;
  const mh = Number.isFinite(maxHeight) ? Math.max(1, maxHeight) : 14;
  const hs = Number.isFinite(heightScale) ? Math.max(0.01, heightScale) : 1;
  return -(1.0 + 1.35 * k * mh * hs);
}

/**
 * Camera far plane for a world of `size` meters. The margin covers the
 * corner-to-corner diagonal (size*sqrt(2)) from the worst-case viewpoint so
 * the horizon is never GPU-clipped on big maps.
 */
export function cameraFarForWorldSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return LEGACY_CAMERA_FAR;
  return Math.max(LEGACY_CAMERA_FAR, size * 1.2 + 500);
}

/**
 * Camera near plane, scaled with the far plane so the near:far ratio — and
 * therefore depth-buffer precision at every relative distance — is identical
 * to the 1400/0.1 baseline.
 */
export function cameraNearForWorldSize(size: number): number {
  return LEGACY_CAMERA_NEAR * (cameraFarForWorldSize(size) / LEGACY_CAMERA_FAR);
}

/**
 * FogExp2 density scale for a world of `size` meters. Thins fog linearly
 * above the reference size so distant terrain fades naturally into the
 * horizon instead of white-outing the mid-field or popping at the far plane.
 * Capped at 1 (never thickens) so worlds at/below the reference size keep
 * their authored fog exactly.
 */
export function fogDensityScaleForWorldSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.min(1, FOG_REFERENCE_SIZE / size);
}
