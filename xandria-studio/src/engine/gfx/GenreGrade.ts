/**
 * GenreGrade — per-genre atmosphere grading (beauty wave, workstream B).
 *
 * Beauty captures showed day/dusk biomes blowing out to white near the
 * horizon: the Preetham sky is HDR-bright, the palette fog colors are light,
 * and the white cloud discs add to the wash. This module is the single source
 * of truth for per-genre atmosphere: tone-mapping exposure, FogExp2 density,
 * fog luminance (darkening the fog color so the horizon holds color instead of
 * washing white), light multipliers, and cloud dimming/tint.
 *
 * NIGHT IS LOCKED: the night visibility floor (sun 1.8 / hemi 1.3 / ambient
 * 0.9 / exposure 1.05, fixed in the earlier lighting wave) must not regress,
 * so at night every genre grades to identity. Do not add per-genre night
 * tweaks here without re-running the night visibility checks.
 *
 * Pure and deterministic — safe to unit test exhaustively.
 */
import type { GameSpec } from '@spec';

export type Genre = GameSpec['meta']['genre'];
export type TimeOfDay = GameSpec['theme']['timeOfDay'];

export interface GenreGrade {
  /** absolute ACESFilmic tone-mapping exposure */
  exposure: number;
  /** multiplier on the weather-derived FogExp2 density */
  fogDensity: number;
  /** multiplier on the palette fog color; < 1 darkens it so backgrounds hold detail */
  fogLuminance: number;
  /** light intensity multipliers (directional / hemisphere / ambient) */
  sun: number;
  hemi: number;
  ambient: number;
  /** multiplier on cloud-disc opacity */
  clouds: number;
  /** cloud-disc tint (day/dusk only) */
  cloudColor: string;
  /**
   * brightness scale for the physical (Preetham) sky shader, day/dusk only.
   * The shader's horizon band renders near-white at the authored turbidity —
   * this compile-time scale tames the HDR wash without touching the lights.
   * Night uses the gradient dome (unaffected); night grade is 1.0.
   */
  sky: number;
}

/** Day/dusk grade table. exposure is absolute (old baselines: day 0.6, dusk 0.72). */
const DAY_TABLE: Record<Genre, Omit<GenreGrade, 'exposure'>> = {
  // Exploration vistas: thin the fog so distant ruins read, darken it so the
  // horizon keeps its warm tone; dim the white cloud discs a touch.
  'third-person-action': {
    fogDensity: 0.75, fogLuminance: 0.85,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.8, cloudColor: '#ffffff', sky: 0.45,
  },
  // Walled arena: sightlines are short, keep close to baseline.
  'fps-arena': {
    fogDensity: 0.9, fogLuminance: 0.9,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.9, cloudColor: '#f0f4ff', sky: 0.5,
  },
  // Brightest biome + long sightlines down the track: pull exposure down,
  // thin the fog hard, darken the sand fog so dunes keep their bands.
  racing: {
    fogDensity: 0.55, fogLuminance: 0.75,
    sun: 0.95, hemi: 0.95, ambient: 1.0,
    clouds: 0.7, cloudColor: '#fff8ec', sky: 0.55,
  },
  // Dreamy depth: keep a little more fog but darken the purple so it glows
  // instead of washing white; lift the hemisphere fill slightly.
  platformer: {
    fogDensity: 1.15, fogLuminance: 0.8,
    sun: 1.0, hemi: 1.05, ambient: 1.0,
    clouds: 1.0, cloudColor: '#e8dcff', sky: 0.45,
  },
  // Top-down readability: enemies at range must stay crisp — thin fog hard.
  'top-down-shooter': {
    fogDensity: 0.5, fogLuminance: 0.85,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.7, cloudColor: '#f4f6fa', sky: 0.5,
  },
};

const DAY_EXPOSURE: Record<Genre, number> = {
  'third-person-action': 0.62,
  'fps-arena': 0.6,
  racing: 0.52,
  platformer: 0.62,
  'top-down-shooter': 0.6,
};

const DUSK_EXPOSURE: Record<Genre, number> = {
  'third-person-action': 0.72,
  'fps-arena': 0.72,
  racing: 0.62,
  platformer: 0.7,
  'top-down-shooter': 0.72,
};

/** Night grade: identity — the earlier night-lighting fix owns these values. */
const NIGHT_GRADE: GenreGrade = {
  exposure: 1.05,
  fogDensity: 1.0, fogLuminance: 1.0,
  sun: 1.0, hemi: 1.0, ambient: 1.0,
  clouds: 1.0, cloudColor: '#3a4460', sky: 1.0,
};

export function gradeAtmosphere(genre: Genre, timeOfDay: TimeOfDay): GenreGrade {
  if (timeOfDay === 'night') return { ...NIGHT_GRADE };
  const base = DAY_TABLE[genre];
  const dusk = timeOfDay === 'dusk' || timeOfDay === 'dawn';
  return {
    ...base,
    exposure: dusk ? DUSK_EXPOSURE[genre] : DAY_EXPOSURE[genre],
  };
}
