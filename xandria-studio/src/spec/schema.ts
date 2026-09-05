/**
 * GameSpec — the central contract of XANDRIA Studio.
 *
 * Every game the engine produces is fully described by one validated GameSpec.
 * Generators (deterministic or LLM) emit specs; blueprints consume them.
 * A spec that passes `validateSpec` is *guaranteed* to build into a playable game.
 */

// ---------------- unions ----------------
export const GENRES = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter'] as const;
export type Genre = (typeof GENRES)[number];

export const ENVIRONMENTS = [
  'forest', 'jungle', 'desert', 'wasteland', 'arctic', 'volcanic', 'city',
  'neon-city', 'space-station', 'ruins', 'dreamscape', 'islands', 'arena',
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const TIMES = ['day', 'dusk', 'night', 'dawn'] as const;
export type TimeOfDay = (typeof TIMES)[number];

export const WEATHERS = ['clear', 'fog', 'rain', 'snow', 'storm', 'ash'] as const;
export type Weather = (typeof WEATHERS)[number];

export const TERRAIN_TYPES = ['flat', 'hills', 'mountains', 'canyon', 'islands', 'platforms'] as const;
export type TerrainType = (typeof TERRAIN_TYPES)[number];

export const BOUNDARIES = ['walls', 'cliffs', 'wrap', 'none'] as const;
export type Boundary = (typeof BOUNDARIES)[number];

export const MOODS = ['epic', 'dark', 'chill', 'retro', 'tense', 'mysterious', 'aggressive', 'heroic'] as const;
export type Mood = (typeof MOODS)[number];

export const SCALE_MODES = ['major', 'minor', 'dorian', 'phrygian', 'pentatonic'] as const;
export type ScaleMode = (typeof SCALE_MODES)[number];

export const WEAPONS = ['sword', 'blaster', 'rifle', 'shotgun', 'none'] as const;
export type Weapon = (typeof WEAPONS)[number];

export const ABILITIES = ['dash', 'doubleJump', 'sprint', 'glide'] as const;
export type Ability = (typeof ABILITIES)[number];

export const ENEMY_KINDS = ['walker', 'drone', 'turret', 'brute', 'flyer', 'racer'] as const;
export type EnemyKind = (typeof ENEMY_KINDS)[number];

export const OBJECTIVES = ['collect', 'eliminate', 'reach', 'survive', 'race', 'boss'] as const;
export type ObjectiveType = (typeof OBJECTIVES)[number];

export const CAMERAS = ['third-person', 'first-person', 'top-down', 'side', 'chase'] as const;
export type CameraKind = (typeof CAMERAS)[number];

export const PLAYER_TYPES = ['humanoid', 'vehicle', 'orb'] as const;
export type PlayerType = (typeof PLAYER_TYPES)[number];

export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

// ---------------- structures ----------------
export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  sky: string;
  horizon: string;
  ground: string;
  groundAlt: string;
  rock: string;
  fog: string;
  water: string;
}

export interface MetaSpec {
  name: string;
  seed: number;
  genre: Genre;
  description: string;
  version: 1;
}

export interface ThemeSpec {
  palette: Palette;
  environment: Environment;
  timeOfDay: TimeOfDay;
  weather: Weather;
  /** chunky nearest-filtered textures, half-res render */
  retroFilter: boolean;
  bloom: boolean;
}

export interface TerrainSpec {
  type: TerrainType;
  size: number;        // world edge length (m)
  maxHeight: number;   // peak elevation (m)
  roughness: number;   // 0..1
  water: boolean;
  waterLevel: number;
}

export interface ScatterSpec {
  density: number;     // 0..1 master density
  trees: boolean;
  rocks: boolean;
  crystals: boolean;
  buildings: number;   // 0 = none; else approx. count for city envs
  ruins: boolean;
}

export interface WorldSpec {
  terrain: TerrainSpec;
  boundary: Boundary;
  gravity: number;     // m/s^2 (negative y)
  scatter: ScatterSpec;
}

export interface PlayerSpec {
  type: PlayerType;
  health: number;
  speed: number;       // m/s walk; run = speed*1.65
  jump: number;        // jump velocity
  abilities: Ability[];
  weapon: Weapon;
  camera: CameraKind;
}

export interface EnemySpec {
  kind: EnemyKind;
  count: number;
  health: number;
  speed: number;
  damage: number;
  weapon: Weapon | 'melee' | 'none';
}

export interface ObjectiveSpec {
  type: ObjectiveType;
  count: number;       // collect N / eliminate N / laps / seconds survived
  timeLimit: number;   // seconds, 0 = none
  description: string;
}

export interface PickupSpec {
  coins: number;
  health: number;
  ammo: number;
  powerups: number;
}

export interface RulesSpec {
  lives: number;
  difficulty: Difficulty;
}

export interface AudioSpec {
  music: boolean;
  mood: Mood;
  tempo: number;       // bpm
  key: number;         // semitone offset 0..11 from A
  mode: ScaleMode;
  sfxVolume: number;   // 0..1
  musicVolume: number; // 0..1
}

// ---------------- custom freeform layer ----------------
/** Parametric overrides — the "describe anything" surface. Every field optional,
 *  every value range-checked: infinite variety inside guaranteed-playable bounds. */
export const QUALITY_MODES = ['retro', 'standard', 'high'] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];

export const FLORA_IDS = ['pine', 'oak', 'palm', 'cactus', 'deadtree', 'mushroom', 'crystalflora'] as const;
export type FloraId = (typeof FLORA_IDS)[number];

export const HEAD_STYLES = ['visor', 'horned', 'helmet', 'mohawk', 'hood', 'antenna', 'crest'] as const;
export const ARMOR_STYLES = ['none', 'pads', 'plate', 'bandolier'] as const;
export const SPOILER_STYLES = ['none', 'lip', 'wing', 'ducktail'] as const;

export interface BiomeCustom {
  terrainFrequency?: number;  // 0.3..3 — noise frequency multiplier
  heightScale?: number;       // 0..2.5 — terrain height multiplier
  waterBias?: number;         // -5..8 — water level offset
  floraMix?: Partial<Record<FloraId, number>>; // species → weight 0..10
}
export interface ForgeCustom {
  headStyle?: (typeof HEAD_STYLES)[number];
  armor?: (typeof ARMOR_STYLES)[number];
  bulk?: number;              // 0.7..1.9
  height?: number;            // 0.85..1.3
  vehicleSpoiler?: (typeof SPOILER_STYLES)[number];
}
export interface EnemyMods {
  size?: number;        // 0.5..2.5 scale multiplier
  speed?: number;       // 0.3..3 movement multiplier
  aggression?: number;  // 0..3 fire/chase rate multiplier
  glow?: string;        // #rrggbb — eye/muzzle glow override
}
export interface WeaponMods {
  projectileSpeed?: number; // 5..200 m/s
  rateOfFire?: number;      // 0.5..20 shots/s multiplier base
  spread?: number;          // 0..0.5 radians
  pellets?: number;         // 1..12 (shotgun)
  beamColor?: string;       // #rrggbb
}
export interface AssetPacks {
  enabled: boolean;
  /** name → GLB/GLTF URL (https only). Online-only; procedural fallback always. */
  packs?: Record<string, string>;
}
export interface CustomSpec {
  biome?: BiomeCustom;
  forge?: ForgeCustom;
  enemyMods?: EnemyMods;
  weaponMods?: WeaponMods;
  quality?: QualityMode;
  assets?: AssetPacks;
}

export interface GameSpec {
  meta: MetaSpec;
  theme: ThemeSpec;
  world: WorldSpec;
  player: PlayerSpec;
  enemies: EnemySpec[];
  objective: ObjectiveSpec;
  pickups: PickupSpec;
  rules: RulesSpec;
  audio: AudioSpec;
  custom?: CustomSpec;
}

// ---------------- defaults ----------------
export const DEFAULT_PALETTE: Palette = {
  primary: '#4f8f4a',
  secondary: '#7a5c3e',
  accent: '#ffd23f',
  sky: '#87b5e0',
  horizon: '#d8e6ee',
  ground: '#5d7d43',
  groundAlt: '#6e8f4f',
  rock: '#8a8d91',
  fog: '#c4d4de',
  water: '#2a6fb0',
};

export function defaultSpec(seed = 1): GameSpec {
  return {
    meta: { name: 'Untitled World', seed, genre: 'third-person-action', description: '', version: 1 },
    theme: {
      palette: { ...DEFAULT_PALETTE },
      environment: 'forest',
      timeOfDay: 'day',
      weather: 'clear',
      retroFilter: true,
      bloom: true,
    },
    world: {
      terrain: { type: 'hills', size: 220, maxHeight: 14, roughness: 0.5, water: false, waterLevel: -2 },
      boundary: 'walls',
      gravity: -22,
      scatter: { density: 0.6, trees: true, rocks: true, crystals: false, buildings: 0, ruins: false },
    },
    player: {
      type: 'humanoid',
      health: 100,
      speed: 7,
      jump: 9,
      abilities: ['dash', 'sprint'],
      weapon: 'sword',
      camera: 'third-person',
    },
    enemies: [{ kind: 'walker', count: 6, health: 30, speed: 4, damage: 10, weapon: 'melee' }],
    objective: { type: 'eliminate', count: 6, timeLimit: 0, description: 'Defeat all enemies' },
    pickups: { coins: 12, health: 4, ammo: 0, powerups: 1 },
    rules: { lives: 3, difficulty: 'normal' },
    audio: { music: true, mood: 'epic', tempo: 110, key: 0, mode: 'minor', sfxVolume: 0.9, musicVolume: 0.7 },
  };
}

// ---------------- validation ----------------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const inEnum = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Strict structural validation. Returns every problem found. */
export function validateSpec(spec: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (p: string, m: string) => errors.push(`${p}: ${m}`);

  if (!isObj(spec)) return { ok: false, errors: ['spec: not an object'] };

  // meta
  if (!isObj(spec.meta)) err('meta', 'missing');
  else {
    if (typeof spec.meta.name !== 'string' || !spec.meta.name) err('meta.name', 'must be a non-empty string');
    if (!Number.isInteger(spec.meta.seed)) err('meta.seed', 'must be an integer');
    if (!inEnum(spec.meta.genre, GENRES)) err('meta.genre', `must be one of ${GENRES.join('|')}`);
    if (spec.meta.version !== 1) err('meta.version', 'must be 1');
  }

  // theme
  if (!isObj(spec.theme)) err('theme', 'missing');
  else {
    if (!isObj(spec.theme.palette)) err('theme.palette', 'missing');
    else for (const k of Object.keys(DEFAULT_PALETTE) as (keyof Palette)[]) {
      if (!isHex(spec.theme.palette[k])) err(`theme.palette.${k}`, 'must be #rrggbb');
    }
    if (!inEnum(spec.theme.environment, ENVIRONMENTS)) err('theme.environment', `must be one of ${ENVIRONMENTS.join('|')}`);
    if (!inEnum(spec.theme.timeOfDay, TIMES)) err('theme.timeOfDay', `must be one of ${TIMES.join('|')}`);
    if (!inEnum(spec.theme.weather, WEATHERS)) err('theme.weather', `must be one of ${WEATHERS.join('|')}`);
    if (typeof spec.theme.retroFilter !== 'boolean') err('theme.retroFilter', 'must be boolean');
    if (typeof spec.theme.bloom !== 'boolean') err('theme.bloom', 'must be boolean');
  }

  // world
  if (!isObj(spec.world)) err('world', 'missing');
  else {
    const t = spec.world.terrain;
    if (!isObj(t)) err('world.terrain', 'missing');
    else {
      if (!inEnum(t.type, TERRAIN_TYPES)) err('world.terrain.type', `must be one of ${TERRAIN_TYPES.join('|')}`);
      if (!num(t.size, 60, 2000)) err('world.terrain.size', 'must be 60..2000');
      if (!num(t.maxHeight, 0, 200)) err('world.terrain.maxHeight', 'must be 0..200');
      if (!num(t.roughness, 0, 1)) err('world.terrain.roughness', 'must be 0..1');
      if (typeof t.water !== 'boolean') err('world.terrain.water', 'must be boolean');
      if (!num(t.waterLevel, -50, 50)) err('world.terrain.waterLevel', 'must be -50..50');
    }
    if (!inEnum(spec.world.boundary, BOUNDARIES)) err('world.boundary', `must be one of ${BOUNDARIES.join('|')}`);
    if (!num(spec.world.gravity, -60, 0)) err('world.gravity', 'must be -60..0');
    const s = spec.world.scatter;
    if (!isObj(s)) err('world.scatter', 'missing');
    else {
      if (!num(s.density, 0, 1)) err('world.scatter.density', 'must be 0..1');
      for (const k of ['trees', 'rocks', 'crystals', 'ruins'] as const)
        if (typeof s[k] !== 'boolean') err(`world.scatter.${k}`, 'must be boolean');
      if (!num(s.buildings, 0, 400)) err('world.scatter.buildings', 'must be 0..400');
    }
  }

  // player
  if (!isObj(spec.player)) err('player', 'missing');
  else {
    if (!inEnum(spec.player.type, PLAYER_TYPES)) err('player.type', `must be one of ${PLAYER_TYPES.join('|')}`);
    if (!num(spec.player.health, 1, 10000)) err('player.health', 'must be 1..10000');
    if (!num(spec.player.speed, 1, 60)) err('player.speed', 'must be 1..60');
    if (!num(spec.player.jump, 0, 40)) err('player.jump', 'must be 0..40');
    if (!Array.isArray(spec.player.abilities) || spec.player.abilities.some((a) => !inEnum(a, ABILITIES)))
      err('player.abilities', `must be an array of ${ABILITIES.join('|')}`);
    if (!inEnum(spec.player.weapon, WEAPONS)) err('player.weapon', `must be one of ${WEAPONS.join('|')}`);
    if (!inEnum(spec.player.camera, CAMERAS)) err('player.camera', `must be one of ${CAMERAS.join('|')}`);
  }

  // enemies
  if (!Array.isArray(spec.enemies)) err('enemies', 'must be an array');
  else spec.enemies.forEach((e, i) => {
    const p = `enemies[${i}]`;
    if (!isObj(e)) return err(p, 'must be an object');
    if (!inEnum(e.kind, ENEMY_KINDS)) err(`${p}.kind`, `must be one of ${ENEMY_KINDS.join('|')}`);
    if (!num(e.count, 0, 200)) err(`${p}.count`, 'must be 0..200');
    if (!num(e.health, 1, 100000)) err(`${p}.health`, 'must be 1..100000');
    if (!num(e.speed, 0, 60)) err(`${p}.speed`, 'must be 0..60');
    if (!num(e.damage, 0, 1000)) err(`${p}.damage`, 'must be 0..1000');
    if (e.weapon !== 'melee' && e.weapon !== 'none' && !inEnum(e.weapon, WEAPONS))
      err(`${p}.weapon`, 'must be melee|none|' + WEAPONS.join('|'));
  });

  // objective
  if (!isObj(spec.objective)) err('objective', 'missing');
  else {
    if (!inEnum(spec.objective.type, OBJECTIVES)) err('objective.type', `must be one of ${OBJECTIVES.join('|')}`);
    if (!num(spec.objective.count, 0, 10000)) err('objective.count', 'must be 0..10000');
    if (!num(spec.objective.timeLimit, 0, 86400)) err('objective.timeLimit', 'must be 0..86400');
    if (typeof spec.objective.description !== 'string') err('objective.description', 'must be a string');
  }

  // pickups
  if (!isObj(spec.pickups)) err('pickups', 'missing');
  else for (const k of ['coins', 'health', 'ammo', 'powerups'] as const) {
    if (!num(spec.pickups[k], 0, 1000)) err(`pickups.${k}`, 'must be 0..1000');
  }

  // rules
  if (!isObj(spec.rules)) err('rules', 'missing');
  else {
    if (!num(spec.rules.lives, 1, 99)) err('rules.lives', 'must be 1..99');
    if (!inEnum(spec.rules.difficulty, DIFFICULTIES)) err('rules.difficulty', `must be one of ${DIFFICULTIES.join('|')}`);
  }

  // audio
  if (!isObj(spec.audio)) err('audio', 'missing');
  else {
    if (typeof spec.audio.music !== 'boolean') err('audio.music', 'must be boolean');
    if (!inEnum(spec.audio.mood, MOODS)) err('audio.mood', `must be one of ${MOODS.join('|')}`);
    if (!num(spec.audio.tempo, 40, 240)) err('audio.tempo', 'must be 40..240');
    if (!Number.isInteger(spec.audio.key) || (spec.audio.key as number) < 0 || (spec.audio.key as number) > 11) err('audio.key', 'must be integer 0..11');
    if (!inEnum(spec.audio.mode, SCALE_MODES)) err('audio.mode', `must be one of ${SCALE_MODES.join('|')}`);
    if (!num(spec.audio.sfxVolume, 0, 1)) err('audio.sfxVolume', 'must be 0..1');
    if (!num(spec.audio.musicVolume, 0, 1)) err('audio.musicVolume', 'must be 0..1');
  }

  // custom freeform layer (optional; every present field range-checked)
  const c = (spec as Record<string, unknown>).custom;
  if (c !== undefined) {
    if (!isObj(c)) err('custom', 'must be an object');
    else {
      const b = c.biome;
      if (b !== undefined) {
        if (!isObj(b)) err('custom.biome', 'must be an object');
        else {
          if (b.terrainFrequency !== undefined && !num(b.terrainFrequency, 0.3, 3)) err('custom.biome.terrainFrequency', 'must be 0.3..3');
          if (b.heightScale !== undefined && !num(b.heightScale, 0, 2.5)) err('custom.biome.heightScale', 'must be 0..2.5');
          if (b.waterBias !== undefined && !num(b.waterBias, -5, 8)) err('custom.biome.waterBias', 'must be -5..8');
          if (b.floraMix !== undefined) {
            if (!isObj(b.floraMix)) err('custom.biome.floraMix', 'must be an object');
            else for (const [k, w] of Object.entries(b.floraMix)) {
              if (!inEnum(k, FLORA_IDS)) err(`custom.biome.floraMix.${k}`, `unknown species (${FLORA_IDS.join('|')})`);
              else if (!num(w, 0, 10)) err(`custom.biome.floraMix.${k}`, 'weight must be 0..10');
            }
          }
        }
      }
      const f = c.forge;
      if (f !== undefined) {
        if (!isObj(f)) err('custom.forge', 'must be an object');
        else {
          if (f.headStyle !== undefined && !inEnum(f.headStyle, HEAD_STYLES)) err('custom.forge.headStyle', `must be one of ${HEAD_STYLES.join('|')}`);
          if (f.armor !== undefined && !inEnum(f.armor, ARMOR_STYLES)) err('custom.forge.armor', `must be one of ${ARMOR_STYLES.join('|')}`);
          if (f.bulk !== undefined && !num(f.bulk, 0.7, 1.9)) err('custom.forge.bulk', 'must be 0.7..1.9');
          if (f.height !== undefined && !num(f.height, 0.85, 1.3)) err('custom.forge.height', 'must be 0.85..1.3');
          if (f.vehicleSpoiler !== undefined && !inEnum(f.vehicleSpoiler, SPOILER_STYLES)) err('custom.forge.vehicleSpoiler', `must be one of ${SPOILER_STYLES.join('|')}`);
        }
      }
      const em = c.enemyMods;
      if (em !== undefined) {
        if (!isObj(em)) err('custom.enemyMods', 'must be an object');
        else {
          if (em.size !== undefined && !num(em.size, 0.5, 2.5)) err('custom.enemyMods.size', 'must be 0.5..2.5');
          if (em.speed !== undefined && !num(em.speed, 0.3, 3)) err('custom.enemyMods.speed', 'must be 0.3..3');
          if (em.aggression !== undefined && !num(em.aggression, 0, 3)) err('custom.enemyMods.aggression', 'must be 0..3');
          if (em.glow !== undefined && !isHex(em.glow)) err('custom.enemyMods.glow', 'must be #rrggbb');
        }
      }
      const wm = c.weaponMods;
      if (wm !== undefined) {
        if (!isObj(wm)) err('custom.weaponMods', 'must be an object');
        else {
          if (wm.projectileSpeed !== undefined && !num(wm.projectileSpeed, 5, 200)) err('custom.weaponMods.projectileSpeed', 'must be 5..200');
          if (wm.rateOfFire !== undefined && !num(wm.rateOfFire, 0.5, 20)) err('custom.weaponMods.rateOfFire', 'must be 0.5..20');
          if (wm.spread !== undefined && !num(wm.spread, 0, 0.5)) err('custom.weaponMods.spread', 'must be 0..0.5');
          if (wm.pellets !== undefined && (!Number.isInteger(wm.pellets) || (wm.pellets as number) < 1 || (wm.pellets as number) > 12)) err('custom.weaponMods.pellets', 'must be integer 1..12');
          if (wm.beamColor !== undefined && !isHex(wm.beamColor)) err('custom.weaponMods.beamColor', 'must be #rrggbb');
        }
      }
      if (c.quality !== undefined && !inEnum(c.quality, QUALITY_MODES)) err('custom.quality', `must be one of ${QUALITY_MODES.join('|')}`);
      const as = c.assets;
      if (as !== undefined) {
        if (!isObj(as)) err('custom.assets', 'must be an object');
        else {
          if (typeof as.enabled !== 'boolean') err('custom.assets.enabled', 'must be boolean');
          if (as.packs !== undefined) {
            if (!isObj(as.packs)) err('custom.assets.packs', 'must be an object');
            else for (const [k, u] of Object.entries(as.packs)) {
              if (typeof u !== 'string' || !/^https:\/\/.+\.(glb|gltf)(\?.*)?$/i.test(u))
                err(`custom.assets.packs.${k}`, 'must be an https URL ending in .glb/.gltf');
            }
          }
        }
      }
    }
  }

  // coherence rules (genre sanity)
  if (isObj(spec.meta) && isObj(spec.player)) {
    if (spec.meta.genre === 'racing' && spec.player.type !== 'vehicle')
      err('player.type', 'racing requires player.type = vehicle');
    if (spec.meta.genre === 'fps-arena' && spec.player.camera !== 'first-person')
      err('player.camera', 'fps-arena requires first-person camera');
    if (spec.meta.genre === 'platformer' && spec.player.camera !== 'side')
      err('player.camera', 'platformer requires side camera');
    if (spec.meta.genre === 'top-down-shooter' && spec.player.camera !== 'top-down')
      err('player.camera', 'top-down-shooter requires top-down camera');
  }

  return { ok: errors.length === 0, errors };
}

/** Deep-merge `partial` over defaults, then validate. Throws with full error list if invalid. */
export function normalizeSpec(partial: unknown): GameSpec {
  const base = defaultSpec(Number(isObj(partial) && isObj(partial.meta) && Number.isInteger(partial.meta.seed) ? partial.meta.seed : 1));
  const merge = (dst: any, src: any): any => {
    if (!isObj(src)) return dst;
    for (const [k, v] of Object.entries(src)) {
      if (isObj(v) && isObj(dst[k])) dst[k] = merge(dst[k], v);
      else if (v !== undefined) dst[k] = v;
    }
    return dst;
  };
  const merged = merge(base, partial) as GameSpec;
  const v = validateSpec(merged);
  if (!v.ok) throw new Error('Invalid GameSpec:\n' + v.errors.join('\n'));
  return merged;
}

/** Deterministic JSON (stable key order) — used for hashing/spec identity. */
export function stableStringify(spec: GameSpec): string {
  const sort = (v: any): any =>
    Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(spec));
}
