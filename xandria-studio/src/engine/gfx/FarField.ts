/**
 * Far-field scaling (Open World stage 1, workstream D).
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
