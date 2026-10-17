/**
 * Graphics wave 2 (workstream E): PerformanceManager — the two quality tiers.
 *
 * One build, two tiers — desktop (the "decent quality" target) and s25
 * (the Galaxy S25 tuned-down profile). The tier is a SET OF FEATURE FLAGS
 * consumed by the renderer and the chunked scatter budgets, not two code
 * paths: every consumer reads `pm.flags` and the world builds identically
 * otherwise (same seeds, same placements, same draw-call structure).
 *
 * Draw-call neutrality by construction:
 * - `densityMul` scales per-chunk PLACEMENT counts only. Pool capacities are
 *   scaled with it (budgets × densityMul × MAX_RESIDENT_CHUNKS), so the pool
 *   SET — and therefore the draw-call count — is identical across tiers.
 *   At densityMul = 1.0 every count is byte-identical to the pre-tier path
 *   (tests pin this).
 * - shadowMapSize / pixelRatioCap / maxRealLights / windMul / bloomBoost change
 *   GPU cost and pixels, never the mesh/instanced-pool census, so they can
 *   never add a draw call.
 *
 * Resolution precedence (first hit wins):
 *   1. player setting `settings.data.tier` (pause-menu override, persisted)
 *   2. `?tier=desktop|s25` URL param (QA harness / Studio preview)
 *   3. `spec.custom.tier` (Studio authoring preview — the World-tab control)
 *   4. auto-detect: coarse pointer + small screen → s25, else desktop
 *
 * Deliberately NOT adaptive: the tier never changes at runtime based on
 * frame rate (that stays banned — see Perf.ts). It is resolved once at
 * Engine construction and held for the run's lifetime.
 */
import type { GameSpec, PerfTier } from '@spec';
import type { Settings } from '../game/Settings';

export const PERF_TIER_SETTINGS = ['auto', 'desktop', 's25'] as const;
export type PerfTierSetting = (typeof PERF_TIER_SETTINGS)[number];

// PERF_TIERS re-exported from the spec layer (single source of truth).
export type { PerfTier };

export interface TierFlags {
  tier: PerfTier;
  /** real-time shadows on the sun light (both tiers keep them; res differs) */
  shadows: boolean;
  /** sun shadow map resolution — GPU cost only, never a draw call */
  shadowMapSize: number;
  /** hard cap applied on top of the quality pixel-ratio formula */
  pixelRatioCap: number;
  /**
   * Multiplier on every per-chunk placement count (prop sets, vegetation,
   * grass). Pool capacities scale with it, so draw calls stay flat while
   * instance density rises on desktop. 1.0 = the pre-tier counts exactly.
   */
  densityMul: number;
  /**
   * Ground micro-detail layer tuning (workstream A). Desktop gets the full
   * layer; s25 stays off like base retro. The Engine takes the max of this
   * and the user's quality setting, so s25+high keeps A's quality behavior.
   */
  detailQuality: 'retro' | 'standard' | 'high';
  /**
   * Whether C's structure buckets (rock/dark) cast shadows. Desktop: true.
   * s25: false — saves 2 shadow-pass draws (the wave's diet for C's +5).
   * The structures still render in the main pass; they just don't occlude
   * the shadow map. Legitimate tuned-down fidelity for the mobile tier.
   */
  structureShadows: boolean;
  /**
   * Wind-sway intensity multiplier on foliage vertex shaders (graphics wave
   * B owns the sway art; the tier gates its intensity). 1.0 = the authored
   * sway. Pure ALU — never a draw call.
   */
  windMul: number;
  /**
   * Cap on simultaneous REAL point lights for landmark/amber-glow accents
   * (Structures.landmarks maxRealLights). Forward-renderer light count
   * changes shader cost, not draw calls.
   */
  maxRealLights: number;
  /**
   * Bloom strength multiplier for the desktop "heavier post" look.
   * 1.0 = the authored strength. Same passes, same draw calls.
   */
  bloomBoost: number;
}

/**
 * Tier flag tables. s25 is the tuned-down profile of the same build:
 * identical pool structure, leaner GPU load. Values were chosen to be
 * draw-call-neutral vs the pre-tier baseline (see class doc) — the perf
 * report in the wave's E.md verifies per tier.
 */
export const TIER_FLAGS: Record<PerfTier, TierFlags> = {
  desktop: {
    tier: 'desktop',
    shadows: true,
    shadowMapSize: 2048,
    pixelRatioCap: 2,
    densityMul: 1.5,
    detailQuality: 'high',
    structureShadows: true,
    windMul: 1.0,
    maxRealLights: 8,
    bloomBoost: 1.25,
  },
  s25: {
    tier: 's25',
    shadows: true,
    shadowMapSize: 1024,
    pixelRatioCap: 1.5,
    densityMul: 1.0,
    detailQuality: 'retro',
    structureShadows: false,
    windMul: 0.5,
    maxRealLights: 1,
    bloomBoost: 1.0,
  },
};

/** Scale a per-chunk budget by the tier multiplier, keeping 1.0 byte-identical. */
export function scaleBudget(budget: number, densityMul: number): number {
  if (densityMul === 1) return budget;
  return Math.max(1, Math.ceil(budget * densityMul));
}

/** Scale a per-chunk placement count, keeping 1.0 byte-identical. */
export function scaleCount(count: number, densityMul: number): number {
  if (densityMul === 1) return count;
  return Math.max(0, Math.round(count * densityMul));
}

export class PerformanceManager {
  /** resolved tier for this run */
  readonly tier: PerfTier;
  /** resolved flag table for this run */
  readonly flags: TierFlags;

  constructor(
    spec: GameSpec,
    settings: Pick<Settings, 'data'>,
    opts: { tierParam?: string | null; autoTier?: PerfTier } = {},
  ) {
    this.tier = PerformanceManager.resolveTier(spec, settings, opts);
    this.flags = TIER_FLAGS[this.tier];
  }

  static resolveTier(
    spec: GameSpec,
    settings: Pick<Settings, 'data'>,
    opts: { tierParam?: string | null; autoTier?: PerfTier } = {},
  ): PerfTier {
    const s = settings.data.tier;
    if (s === 'desktop' || s === 's25') return s;
    const p = opts.tierParam;
    if (p === 'desktop' || p === 's25') return p;
    const c = spec.custom?.tier;
    if (c === 'desktop' || c === 's25') return c;
    return opts.autoTier ?? PerformanceManager.autoDetect();
  }

  /**
   * Device auto-detect. Coarse pointer + small screen ⇒ the S25-class
   * profile; everything else ⇒ desktop. Guarded for headless/test
   * environments (no matchMedia/screen ⇒ desktop, the historical default).
   */
  static autoDetect(): PerfTier {
    try {
      if (typeof matchMedia === 'undefined') return 'desktop';
      const coarse = matchMedia('(pointer: coarse)').matches;
      const small =
        typeof screen !== 'undefined' &&
        Math.min(screen.width, screen.height) < 600;
      return coarse && small ? 's25' : 'desktop';
    } catch {
      return 'desktop';
    }
  }

  /** Read `?tier=` from a query string (the QA harness drives tiers this way). */
  static tierParamFromSearch(search: string): string | null {
    try {
      const p = new URLSearchParams(search).get('tier');
      return p === 'desktop' || p === 's25' ? p : null;
    } catch {
      return null;
    }
  }
}
