/**
 * Deterministic intent → GameSpec compiler. Keyword heuristics + seeded variation.
 * Same intent always produces the same game. An LLM adapter can refine (never replace) the output.
 */
import {
  normalizeSpec,
  type GameSpec, type Genre, type Environment, type Mood, type Weather, type TimeOfDay,
  type TerrainType, type Weapon, type EnemyKind, type ObjectiveType, type Palette,
} from '@spec';
import { hashString } from '../engine/core/Rng';

const has = (s: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(s));

const GENRE_KEYS: [Genre, string[]][] = [
  ['racing', ['race', 'racing', 'car', 'cars', 'drive', 'driving', 'drift', 'kart', 'grand prix', 'rally', 'f1']],
  ['fps-arena', ['fps', 'first person', 'first-person', 'deathmatch', 'arena shooter', 'quake', 'doom']],
  ['platformer', ['platformer', 'platform', 'jumping', 'mario', 'side scroll', 'side-scroll', 'sidescroll']],
  ['top-down-shooter', ['top-down', 'topdown', 'top down', 'twin stick', 'twin-stick', 'twinstick', 'asteroids', 'overhead', 'horde']],
  ['third-person-action', ['adventure', 'quest', 'rpg', 'sword', 'knight', 'explore', 'third person', 'third-person', 'action', 'samurai', 'ninja']],
];

const ENV_KEYS: [Environment, string[]][] = [
  ['neon-city', ['neon', 'cyberpunk', 'synthwave', 'cyber city', 'tokyo']],
  ['space-station', ['space station', 'space-station', 'spaceship', 'spacecraft', 'station']],
  ['volcanic', ['volcano', 'volcanic', 'lava', 'magma', 'inferno', 'hell']],
  ['arctic', ['arctic', 'snow', 'snowy', 'ice', 'frozen', 'winter', 'glacier', 'tundra']],
  ['desert', ['desert', 'sand', 'dune', 'dunes', 'sahara', 'oasis']],
  ['wasteland', ['wasteland', 'apocalypse', 'apocalyptic', 'post-apocalyptic', 'fallout', 'ruined world']],
  ['city', ['city', 'urban', 'downtown', 'street', 'streets', 'alley']],
  ['ruins', ['ruins', 'ancient', 'temple', 'aztec', 'mayan', 'lost city', 'archaeology']],
  ['dreamscape', ['dream', 'dreamscape', 'surreal', 'dreamy', 'liminal', 'void']],
  ['islands', ['island', 'islands', 'tropical', 'archipelago', 'beach', 'ocean']],
  ['jungle', ['jungle', 'rainforest', 'amazon']],
  ['forest', ['forest', 'woods', 'woodland', 'grove', 'meadow']],
];

const ENV_TERRAIN: Record<Environment, TerrainType> = {
  forest: 'hills', jungle: 'hills', desert: 'hills', wasteland: 'flat', arctic: 'hills',
  volcanic: 'mountains', city: 'flat', 'neon-city': 'flat', 'space-station': 'flat',
  ruins: 'hills', dreamscape: 'platforms', islands: 'islands', arena: 'flat',
};

const ENV_PALETTE: Record<Environment, Palette> = {
  forest: { primary: '#4f8f4a', secondary: '#7a5c3e', accent: '#ffd23f', sky: '#87b5e0', horizon: '#d8e6ee', ground: '#5d7d43', groundAlt: '#6e8f4f', rock: '#8a8d91', fog: '#c4d4de', water: '#2a6fb0' },
  jungle: { primary: '#2e7d43', secondary: '#6b4f2e', accent: '#ffde59', sky: '#8ec9e8', horizon: '#e2efd9', ground: '#3e6b35', groundAlt: '#4a7a3d', rock: '#7d8178', fog: '#cfe0d8', water: '#2e8fa0' },
  desert: { primary: '#c9a05a', secondary: '#8a6a3e', accent: '#ff8a3c', sky: '#a8c8e8', horizon: '#f0dcc0', ground: '#c9a869', groundAlt: '#d4b578', rock: '#a08a6a', fog: '#e8d9c0', water: '#3c9fc9' },
  wasteland: { primary: '#8a7a52', secondary: '#5a4a3a', accent: '#ff5a2f', sky: '#b8a88a', horizon: '#d8c8a8', ground: '#7a6a4a', groundAlt: '#8a7a55', rock: '#6a6558', fog: '#c9bda5', water: '#4a6a58' },
  arctic: { primary: '#cfe0ea', secondary: '#5a7a9a', accent: '#7af7ff', sky: '#a8c8e0', horizon: '#e8f2fa', ground: '#dfe9f0', groundAlt: '#cdd9e4', rock: '#8a98a5', fog: '#dce8f2', water: '#3a7ab0' },
  volcanic: { primary: '#5a3a35', secondary: '#3a2a28', accent: '#ff5a2f', sky: '#6a4a42', horizon: '#c97a52', ground: '#4a3532', groundAlt: '#5a4038', rock: '#3a3230', fog: '#8a6555', water: '#ff5a1f' },
  city: { primary: '#8a8f98', secondary: '#5a5f68', accent: '#ffd23f', sky: '#9ab8d8', horizon: '#d0dce8', ground: '#6a6f78', groundAlt: '#787d86', rock: '#8a8d91', fog: '#c8d4de', water: '#3a6a9a' },
  'neon-city': { primary: '#2a2f45', secondary: '#3d2a5e', accent: '#ff3fd8', sky: '#1a1a2e', horizon: '#3a2a5e', ground: '#232838', groundAlt: '#2c3247', rock: '#3a4050', fog: '#2a2545', water: '#3fd8ff' },
  'space-station': { primary: '#6a7078', secondary: '#4a5058', accent: '#3fd8ff', sky: '#050510', horizon: '#101020', ground: '#4a5058', groundAlt: '#555c66', rock: '#5a6068', fog: '#0a0a18', water: '#3fd8ff' },
  ruins: { primary: '#9a9484', secondary: '#6a6558', accent: '#ffd76a', sky: '#a8bcd8', horizon: '#e0d9c4', ground: '#7d7868', groundAlt: '#8a8574', rock: '#9a9484', fog: '#d8d2c0', water: '#4a8a9a' },
  dreamscape: { primary: '#8a6ac9', secondary: '#5a3f8e', accent: '#7af7ff', sky: '#4a3a7e', horizon: '#b08ad8', ground: '#6a559e', groundAlt: '#7a65ae', rock: '#8a7ab8', fog: '#a08ad0', water: '#7af7ff' },
  islands: { primary: '#5aa84f', secondary: '#c9a869', accent: '#ffde59', sky: '#7ac4e8', horizon: '#e0f0f8', ground: '#d4c287', groundAlt: '#c9b578', rock: '#8a8574', fog: '#d0e8f0', water: '#2e9fc9' },
  arena: { primary: '#8d949e', secondary: '#5d646e', accent: '#ffd23f', sky: '#8aa8c8', horizon: '#c8d8e8', ground: '#7d838c', groundAlt: '#8a909a', rock: '#9aa0a8', fog: '#b8c8d8', water: '#3a7ab0' },
};

const MOOD_KEYS: [Mood, string[]][] = [
  ['aggressive', ['brutal', 'intense', 'aggressive', 'hardcore', 'rage']],
  ['dark', ['dark', 'horror', 'scary', 'grim', 'gothic', 'evil', 'demon']],
  ['tense', ['tense', 'suspense', 'thriller', 'stealth', 'danger']],
  ['mysterious', ['mysterious', 'mystery', 'enigma', 'strange', 'eerie', 'liminal']],
  ['chill', ['chill', 'relaxing', 'calm', 'peaceful', 'cozy', 'gentle']],
  ['retro', ['retro', 'arcade', 'synthwave', '8-bit', 'pixel']],
  ['heroic', ['heroic', 'hero', 'legend', 'champion', 'save']],
  ['epic', ['epic', 'grand', 'vast', 'massive', 'colossal']],
];

const NAME_ADJ = ['Crimson', 'Hollow', 'Silent', 'Burning', 'Frozen', 'Neon', 'Ancient', 'Forgotten', 'Iron', 'Shadow', 'Golden', 'Broken', 'Emerald', 'Storm', 'Obsidian', 'Radiant'];
const NAME_NOUN = ['Frontier', 'Expanse', 'Citadel', 'Wastes', 'Reach', 'Valley', 'Bastion', 'Realm', 'Gauntlet', 'Sanctum', 'Outskirts', 'Crucible', 'Drift', 'Verge', 'Ascent', 'Hollow'];

export interface GenerateOptions {
  genre?: Genre;
  environment?: Environment;
  difficulty?: 'easy' | 'normal' | 'hard';
  seed?: number;
}

export function generateSpec(intent: string, opts: GenerateOptions = {}): GameSpec {
  const text = intent.trim();
  const seed = opts.seed ?? hashString(text || 'xandria');
  const rng = (() => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();

  // --- genre
  let genre: Genre | undefined = opts.genre;
  if (!genre) for (const [g, words] of GENRE_KEYS) if (has(text, ...words)) { genre = g; break; }
  genre ??= 'third-person-action';

  // --- environment
  let environment: Environment | undefined = opts.environment;
  if (!environment) for (const [e, words] of ENV_KEYS) if (has(text, ...words)) { environment = e; break; }
  environment ??= genre === 'fps-arena' || genre === 'top-down-shooter' ? 'arena' : genre === 'racing' ? 'wasteland' : 'forest';

  // --- mood / time / weather
  let mood: Mood = 'epic';
  for (const [m, words] of MOOD_KEYS) if (has(text, ...words)) { mood = m; break; }
  if (environment === 'neon-city') mood = 'retro';
  if (environment === 'dreamscape') mood = 'mysterious';
  if (environment === 'volcanic') mood = 'aggressive';

  const timeOfDay: TimeOfDay = has(text, 'night', 'midnight', 'moonlit') ? 'night'
    : has(text, 'sunset', 'dusk', 'evening') ? 'dusk'
    : has(text, 'dawn', 'sunrise', 'morning') ? 'dawn'
    : environment === 'neon-city' || environment === 'space-station' ? 'night' : 'day';

  const weather: Weather = has(text, 'storm', 'thunder') ? 'storm'
    : has(text, 'rain', 'rainy', 'drizzle') ? 'rain'
    : has(text, 'fog', 'foggy', 'mist', 'misty') ? 'fog'
    : environment === 'arctic' ? 'snow'
    : environment === 'volcanic' ? 'ash' : 'clear';

  const difficulty = opts.difficulty ?? (has(text, 'nightmare', 'insane', 'brutal', 'very hard') ? 'hard' : has(text, 'easy', 'casual', 'relaxing') ? 'easy' : 'normal');
  const diffK = difficulty === 'easy' ? 0.7 : difficulty === 'hard' ? 1.5 : 1;

  // --- name
  const adj = NAME_ADJ[Math.floor(rng() * NAME_ADJ.length)];
  const noun = NAME_NOUN[Math.floor(rng() * NAME_NOUN.length)];
  const name = `${adj} ${noun}`;

  // --- weapon
  const weapon: Weapon = has(text, 'sword', 'katana', 'blade', 'melee') ? 'sword'
    : has(text, 'shotgun') ? 'shotgun'
    : has(text, 'rifle', 'machine gun', 'smg') ? 'rifle'
    : has(text, 'fists', 'unarmed', 'parkour') ? 'none'
    : genre === 'fps-arena' ? 'rifle'
    : genre === 'top-down-shooter' ? 'blaster'
    : genre === 'platformer' ? 'none'
    : genre === 'racing' ? 'none' : 'sword';

  // --- enemies
  const enemySpecs = [];
  if (genre !== 'racing') {
    const wantsDrones = has(text, 'drone', 'drones', 'robot', 'robots', 'mech');
    const wantsTurrets = has(text, 'turret', 'turrets', 'defense');
    const wantsBoss = has(text, 'boss', 'giant', 'colossus');
    const baseCount = Math.round((genre === 'fps-arena' || genre === 'top-down-shooter' ? 10 : 6) * diffK);
    if (wantsBoss) {
      enemySpecs.push({ kind: 'brute' as EnemyKind, count: 1, health: Math.round(300 * diffK), speed: 3.5, damage: Math.round(22 * diffK), weapon: 'melee' as const });
      enemySpecs.push({ kind: 'walker' as EnemyKind, count: Math.round(4 * diffK), health: 30, speed: 4, damage: 10, weapon: 'melee' as const });
    } else {
      enemySpecs.push({
        kind: (wantsDrones ? 'drone' : 'walker') as EnemyKind,
        count: baseCount,
        health: Math.round((wantsDrones ? 22 : 30) * diffK),
        speed: wantsDrones ? 6 : 4.5,
        damage: Math.round(9 * diffK),
        weapon: wantsDrones ? ('blaster' as const) : ('melee' as const),
      });
      if (genre === 'fps-arena' || wantsDrones) {
        enemySpecs.push({ kind: 'drone' as EnemyKind, count: Math.round(4 * diffK), health: 22, speed: 6, damage: Math.round(8 * diffK), weapon: 'blaster' as const });
      }
      if (wantsTurrets || genre === 'fps-arena') {
        enemySpecs.push({ kind: 'turret' as EnemyKind, count: Math.round(3 * diffK), health: 45, speed: 0, damage: Math.round(7 * diffK), weapon: 'blaster' as const });
      }
    }
  } else {
    enemySpecs.push({ kind: 'racer' as EnemyKind, count: 4, health: 1, speed: 24, damage: 0, weapon: 'none' as const });
  }

  // --- objective
  let objectiveType: ObjectiveType = 'eliminate';
  let objectiveCount = 0;
  let objectiveDesc = '';
  if (genre === 'racing') {
    objectiveType = 'race';
    objectiveCount = has(text, 'long') ? 5 : 3;
    objectiveDesc = `Complete ${objectiveCount} laps`;
  } else if (has(text, 'boss')) {
    objectiveType = 'boss';
    objectiveCount = enemySpecs.reduce((n, e) => n + e.count, 0);
    objectiveDesc = 'Defeat the champion and its guard';
  } else if (has(text, 'collect', 'gather', 'treasure', 'coins')) {
    objectiveType = 'collect';
    objectiveCount = Math.round(14 * diffK) + 6;
    objectiveDesc = `Collect ${objectiveCount} shards`;
  } else if (has(text, 'survive', 'horde', 'waves', 'endless')) {
    objectiveType = 'survive';
    objectiveCount = 0;
    objectiveDesc = 'Survive the onslaught';
  } else if (has(text, 'reach', 'escape', 'get to', 'beacon', 'flag') || genre === 'platformer') {
    objectiveType = 'reach';
    objectiveDesc = genre === 'platformer' ? 'Reach the flag' : 'Reach the beacon';
  } else {
    objectiveCount = enemySpecs.reduce((n, e) => n + e.count, 0);
    if (genre === 'fps-arena' || genre === 'top-down-shooter') objectiveCount = Math.max(objectiveCount, Math.round(18 * diffK));
    objectiveDesc = `Eliminate ${objectiveCount} hostiles`;
  }

  const timeLimit = objectiveType === 'survive'
    ? Math.round(has(text, 'long') ? 300 : 150)
    : has(text, 'timed', 'time limit', 'speedrun') ? 240 : 0;

  // --- world
  const terrain: TerrainType = has(text, 'mountain', 'mountains', 'alpine') ? 'mountains'
    : has(text, 'canyon', 'gorge') ? 'canyon'
    : has(text, 'flat', 'plains') ? 'flat'
    : ENV_TERRAIN[environment];
  const wantsWater = environment === 'islands' || has(text, 'lake', 'ocean', 'sea', 'water', 'river', 'flood');

  // --- assemble (partial → normalize fills the rest + validates)
  const partial: any = {
    meta: { name, seed, genre, description: text.slice(0, 300), version: 1 },
    theme: {
      palette: ENV_PALETTE[environment],
      environment,
      timeOfDay,
      weather,
      retroFilter: true,
      bloom: true,
    },
    world: {
      terrain: {
        type: genre === 'racing' || genre === 'fps-arena' || genre === 'top-down-shooter' ? 'flat' : terrain,
        size: genre === 'racing' ? 400 : genre === 'platformer' ? 260 : 220,
        maxHeight: terrain === 'mountains' ? 30 : 14,
        roughness: 0.5,
        water: wantsWater,
        waterLevel: environment === 'islands' ? -0.5 : -2,
      },
      boundary: genre === 'racing' ? 'none' : 'walls',
      gravity: -22,
      scatter: {
        density: environment === 'city' || environment === 'neon-city' ? 0.5 : 0.65,
        trees: environment === 'forest' || environment === 'jungle' || environment === 'islands',
        rocks: true,
        crystals: environment === 'dreamscape' || environment === 'volcanic',
        buildings: environment === 'city' ? 40 : environment === 'neon-city' ? 60 : 0,
        ruins: environment === 'ruins' || environment === 'wasteland',
      },
    },
    player: {
      type: genre === 'racing' ? 'vehicle' : 'humanoid',
      health: Math.round(100 / diffK),
      speed: 7,
      jump: 9,
      abilities: genre === 'platformer' ? ['doubleJump', 'dash'] : genre === 'racing' ? [] : ['dash', 'sprint'],
      weapon,
      camera: genre === 'fps-arena' ? 'first-person' : genre === 'platformer' ? 'side' : genre === 'top-down-shooter' ? 'top-down' : genre === 'racing' ? 'chase' : 'third-person',
    },
    enemies: enemySpecs,
    objective: { type: objectiveType, count: objectiveCount, timeLimit, description: objectiveDesc },
    pickups: {
      coins: objectiveType === 'collect' ? objectiveCount : genre === 'platformer' ? 60 : 12,
      health: Math.round(4 * (difficulty === 'hard' ? 0.6 : 1)),
      ammo: weapon === 'none' || weapon === 'sword' ? 0 : 8,
      powerups: 2,
    },
    rules: { lives: difficulty === 'hard' ? 2 : 3, difficulty },
    audio: {
      music: true,
      mood,
      tempo: mood === 'chill' ? 84 : mood === 'aggressive' ? 148 : mood === 'tense' ? 128 : 112,
      key: Math.floor(rng() * 12),
      mode: mood === 'dark' ? 'phrygian' : mood === 'mysterious' ? 'dorian' : mood === 'retro' ? 'pentatonic' : 'minor',
      sfxVolume: 0.9,
      musicVolume: 0.7,
    },
  };

  return normalizeSpec(partial);
}
