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
  /**
   * dusk-only amber fog tint (hex). Sky lerps the fog color 35% toward it —
   * the reference vistas are ALL dusk with warm amber haze. null outside dusk.
   */
  fogTint: string | null;
  /**
   * god-ray presence multiplier for dusk (LightShafts scales its shaft alpha
   * by this). Day = 1.0, dusk/dawn = 1.7 — stronger rays at golden hour.
   * Night is 1.0 (shafts are off at night anyway).
   */
  godRays: number;
  /**
   * filmic color grade for the post grade pass (polish wave, LOOK crew).
   * Consumed by PostFX on standard/high tiers only — retro keeps its own
   * shader. Night is identity except a mild vignette (no brightness change,
   * so the night visibility floor is unaffected).
   */
  grade: ColorGrade;
  /**
   * dusk-only biome fog color override (absolute hex). Set only when the
   * caller passes a BiomeDefLike object carrying fogColor (workstream C's
   * BiomeDef); null = palette fog. Applied before fogLuminance/fogTint.
   */
  biomeFog: string | null;
  /**
   * dusk-only biome fog density override (absolute FogExp2 density). Set only
   * from a BiomeDefLike object carrying fogDensity; null = the weather-derived
   * base x grade.fogDensity multiplier.
   */
  biomeFogDensity: number | null;
  /**
   * dusk-only water deep tint for the terrain water material (hex). From the
   * biome table or a BiomeDefLike's waterTint; null = the default steel blue
   * (volcanic lava keeps its own color in Terrain).
   */
  waterTint: string | null;
  /**
   * dusk-only sky-reflection tint for the water fresnel term (hex); null =
   * time-of-day default. Warm at dusk so water mirrors the sunset.
   */
  waterSky: string | null;
}

/**
 * Per-genre filmic color grade (ASC-CDL style lift/gamma/gain + saturation +
 * vignette). Values are subtle by design — cohesion, not an Instagram filter.
 * lift/gamma/gain are per-channel; 0 / 1 / 1 is identity.
 */
export interface ColorGrade {
  /** additive shadow tint per channel, ~±0.03 */
  lift: [number, number, number];
  /** per-channel gamma, 1.0 = identity */
  gamma: [number, number, number];
  /** per-channel gain (highlight tint), 1.0 = identity */
  gain: [number, number, number];
  /** saturation multiplier, 1.0 = identity */
  saturation: number;
  /** vignette strength; 0 = off, ~0.4–0.6 is filmic (corners ~20–30% darker) */
  vignette: number;
}

/** Day/dusk grade table. exposure is absolute (old baselines: day 0.6, dusk 0.72). */
const DAY_TABLE: Record<Genre, Omit<GenreGrade, 'exposure'>> = {
  // Exploration vistas: thin the fog so distant ruins read, darken it so the
  // horizon keeps its warm tone; dim the white cloud discs a touch.
  // Grade: warm shadows/highlights, gentle lift for the ruins.
  'third-person-action': {
    fogDensity: 0.75, fogLuminance: 0.85,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.8, cloudColor: '#ffffff', sky: 0.45, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.015, 0.005, -0.010], gamma: [1.0, 1.0, 1.0], gain: [1.03, 1.0, 0.96],
      saturation: 1.08, vignette: 0.45,
    },
  },
  // Walled arena: sightlines are short, keep close to baseline.
  // Grade: cool neon-noir shadows, punchier saturation for the glow.
  'fps-arena': {
    fogDensity: 0.9, fogLuminance: 0.9,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.9, cloudColor: '#f0f4ff', sky: 0.5, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [-0.005, 0.005, 0.020], gamma: [1.0, 1.0, 1.0], gain: [0.96, 1.0, 1.06],
      saturation: 1.15, vignette: 0.55,
    },
  },
  // Brightest biome + long sightlines down the track: pull exposure down,
  // thin the fog hard, darken the sand fog so dunes keep their bands.
  // Grade: warm desert highlights, restrained saturation so sand doesn't clip.
  racing: {
    fogDensity: 0.55, fogLuminance: 0.75,
    sun: 0.95, hemi: 0.95, ambient: 1.0,
    clouds: 0.7, cloudColor: '#fff8ec', sky: 0.55, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.020, 0.010, 0.000], gamma: [1.0, 1.0, 1.0], gain: [1.05, 1.0, 0.93],
      saturation: 1.10, vignette: 0.40,
    },
  },
  // Dreamy depth: keep a little more fog but darken the purple so it glows
  // instead of washing white; lift the hemisphere fill slightly.
  // Grade: violet-tinted shadows, lifted saturation for the dreamscape.
  platformer: {
    fogDensity: 1.15, fogLuminance: 0.8,
    sun: 1.0, hemi: 1.05, ambient: 1.0,
    clouds: 1.0, cloudColor: '#e8dcff', sky: 0.45, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.010, 0.000, 0.020], gamma: [1.0, 1.0, 1.0], gain: [1.0, 0.97, 1.05],
      saturation: 1.12, vignette: 0.40,
    },
  },
  // Top-down readability: enemies at range must stay crisp — thin fog hard.
  // Grade: near-neutral with a cool touch, stronger vignette to focus the arena.
  'top-down-shooter': {
    fogDensity: 0.5, fogLuminance: 0.85,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.7, cloudColor: '#f4f6fa', sky: 0.5, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.000, 0.000, 0.005], gamma: [1.0, 1.0, 1.0], gain: [0.98, 1.0, 1.03],
      saturation: 1.06, vignette: 0.50,
    },
  },
  // variety wave: survivor reads like the top-down arena it descends from;
  // tower-defense matches the arena look with denser fog for depth;
  // endless-runner keeps the horizon thin so the far gate reads at speed.
  survivor: {
    fogDensity: 0.5, fogLuminance: 0.85,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.7, cloudColor: '#f4f6fa', sky: 0.5, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.000, 0.000, 0.005], gamma: [1.0, 1.0, 1.0], gain: [0.98, 1.0, 1.03],
      saturation: 1.06, vignette: 0.50,
    },
  },
  'tower-defense': {
    fogDensity: 0.65, fogLuminance: 0.85,
    sun: 1.0, hemi: 1.0, ambient: 1.0,
    clouds: 0.7, cloudColor: '#f4f6fa', sky: 0.5, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.000, 0.000, 0.005], gamma: [1.0, 1.0, 1.0], gain: [0.98, 1.0, 1.03],
      saturation: 1.06, vignette: 0.50,
    },
  },
  'endless-runner': {
    fogDensity: 0.55, fogLuminance: 0.85,
    sun: 1.05, hemi: 1.0, ambient: 1.0,
    clouds: 0.7, cloudColor: '#ffffff', sky: 0.45, fogTint: null, godRays: 1.0,
    biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
    grade: {
      lift: [0.015, 0.005, -0.010], gamma: [1.0, 1.0, 1.0], gain: [1.03, 1.0, 0.96],
      saturation: 1.08, vignette: 0.45,
    },
  },
};

const DAY_EXPOSURE: Record<Genre, number> = {
  'third-person-action': 0.62,
  'fps-arena': 0.6,
  racing: 0.52,
  platformer: 0.62,
  'top-down-shooter': 0.6,
  survivor: 0.6,
  'tower-defense': 0.6,
  'endless-runner': 0.58,
};

const DUSK_EXPOSURE: Record<Genre, number> = {
  'third-person-action': 0.72,
  'fps-arena': 0.72,
  racing: 0.62,
  platformer: 0.7,
  'top-down-shooter': 0.72,
  survivor: 0.72,
  'tower-defense': 0.72,
  'endless-runner': 0.68,
};

/**
 * Minimal biome descriptor (graphics workstream D, full-scale wave).
 *
 * SEAM with workstream C: C defines BiomeDef in src/engine/world/Biomes.ts
 * (fog color/density values + water tint). That BiomeDef satisfies this
 * interface structurally, so once it lands the call sites can pass the
 * BiomeDef object directly and its fogColor/fogDensity/waterTint wire through
 * automatically. Until then, callers pass spec.theme.environment (a plain
 * string id) and the BIOME_DUSK table below supplies the per-biome look.
 */
export interface BiomeDefLike {
  /** biome id — matches the Environment union values ('desert', 'arctic', ...) */
  id: string;
  fogColor?: string;
  fogDensity?: number;
  waterTint?: string;
}

/** Per-biome cinematic dusk tweaks, layered over the genre dusk grade. */
interface BiomeDuskTweak {
  /** multiplier on the genre dusk exposure */
  exposure?: number;
  /** fog tint override (default '#ff9a5c' amber haze) */
  fogTint?: string;
  /** water deep tint override */
  waterTint?: string;
  /** water sky-reflection (fresnel) tint override */
  waterSky?: string;
  /** complete dusk lift/gain/saturation for the biome (replaces genre's) */
  lift?: [number, number, number];
  gain?: [number, number, number];
  saturation?: number;
}

/**
 * Cinematic dusk/sunset grading per biome — the reference vistas are ALL
 * dusk: hot amber deserts, ember volcanic glow, cold-blue arctic under a warm
 * horizon, teal coastlines, violet dreamscapes. Dusk/dawn only; day keeps the
 * authored genre table and night is locked. Keyed by spec.theme.environment.
 */
const BIOME_DUSK: Record<string, BiomeDuskTweak> = {
  desert: {
    fogTint: '#ffa25e', waterTint: '#2a7fb5', waterSky: '#f2a768',
    lift: [0.020, 0.008, -0.012], gain: [1.06, 1.00, 0.90], saturation: 1.12,
  },
  wasteland: {
    fogTint: '#ff9a5c', waterTint: '#3a6f8f', waterSky: '#e8a068',
    lift: [0.022, 0.010, -0.008], gain: [1.05, 1.00, 0.92], saturation: 1.05,
  },
  forest: {
    fogTint: '#ff9a5c', waterTint: '#2a6f8f', waterSky: '#e8a868',
    lift: [0.008, 0.015, -0.005], gain: [1.02, 1.03, 0.94], saturation: 1.10,
  },
  jungle: {
    fogTint: '#ff9a5c', waterTint: '#2a7050', waterSky: '#e8a868',
    lift: [0.010, 0.020, 0.000], gain: [1.03, 1.04, 0.92], saturation: 1.12,
  },
  arctic: {
    // cold blue land under a warm horizon — the reference snow vista
    fogTint: '#ffc890', waterTint: '#3a8fc0', waterSky: '#f0b070',
    lift: [-0.010, 0.000, 0.020], gain: [0.98, 1.00, 1.05], saturation: 1.08,
  },
  volcanic: {
    // ember glow: hot red lift, crushed blue gain
    fogTint: '#ff7a3c', waterTint: '#ff5a1f', waterSky: '#ff8a4a',
    lift: [0.030, 0.005, -0.010], gain: [1.08, 0.95, 0.85], saturation: 1.15,
  },
  islands: {
    // teal coastline water, warm dusk sky
    fogTint: '#ffab70', waterTint: '#1f9db5', waterSky: '#f0a868',
    lift: [0.012, 0.010, 0.000], gain: [1.00, 1.03, 1.02], saturation: 1.12,
  },
  ruins: {
    fogTint: '#ffa25e', waterTint: '#2a6f9f', waterSky: '#f0a068',
    lift: [0.015, 0.005, -0.010], gain: [1.04, 1.00, 0.93], saturation: 1.08,
  },
  dreamscape: {
    fogTint: '#c08aff', waterTint: '#3a5fb5', waterSky: '#d89aff',
    lift: [0.010, 0.000, 0.020], gain: [1.02, 0.97, 1.06], saturation: 1.15,
  },
};

/** Night grade: identity — the earlier night-lighting fix owns these values. */
const NIGHT_GRADE: GenreGrade = {
  exposure: 1.05,
  fogDensity: 1.0, fogLuminance: 1.0, fogTint: null, godRays: 1.0,
  sun: 1.0, hemi: 1.0, ambient: 1.0,
  clouds: 1.0, cloudColor: '#3a4460', sky: 1.0,
  biomeFog: null, biomeFogDensity: null, waterTint: null, waterSky: null,
  // color grade at night is identity except a mild vignette (no brightness
  // change, so the night visibility floor is unaffected).
  grade: {
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
    saturation: 1.0, vignette: 0.35,
  },
};

export function gradeAtmosphere(
  genre: Genre,
  timeOfDay: TimeOfDay,
  biome?: string | BiomeDefLike | null,
): GenreGrade {
  if (timeOfDay === 'night') return { ...NIGHT_GRADE };
  const base = DAY_TABLE[genre];
  const dusk = timeOfDay === 'dusk' || timeOfDay === 'dawn';
  // Env-art dusk preset: the reference vistas are ALL dusk — warm amber fog
  // tint, deeper fog luminance so the horizon holds its amber tone, warmer
  // clouds, and stronger god-ray presence. Day keeps the authored table.
  if (!dusk) return { ...base, exposure: DAY_EXPOSURE[genre] };
  // Graphics wave D2: per-biome cinematic dusk grading layered over the genre
  // grade. A plain string id reads the BIOME_DUSK table; a BiomeDefLike object
  // (workstream C's BiomeDef, once it lands) also carries absolute fog/water
  // overrides that win over the table.
  const tweak = typeof biome === 'string' ? BIOME_DUSK[biome] : undefined;
  const like = biome !== null && typeof biome === 'object' ? biome : undefined;
  const t = tweak ?? (like ? BIOME_DUSK[like.id] : undefined);
  const t2: BiomeDuskTweak | undefined = t !== undefined &&
    (t.lift !== undefined || t.gain !== undefined || t.saturation !== undefined) ? t : undefined;
  const grade: ColorGrade = t2 !== undefined
    ? {
        ...base.grade,
        lift: t2.lift ?? base.grade.lift,
        gain: t2.gain ?? base.grade.gain,
        saturation: t2.saturation ?? base.grade.saturation,
      }
    : base.grade;
  return {
    ...base,
    exposure: DUSK_EXPOSURE[genre] * (t?.exposure ?? 1),
    fogLuminance: base.fogLuminance * 0.92,
    fogTint: t?.fogTint ?? '#ff9a5c',
    cloudColor: '#ffd9b0',
    godRays: 1.7,
    biomeFog: like?.fogColor ?? null,
    biomeFogDensity: like?.fogDensity ?? null,
    waterTint: like?.waterTint ?? t?.waterTint ?? null,
    waterSky: t?.waterSky ?? null,
    grade,
  };
}
