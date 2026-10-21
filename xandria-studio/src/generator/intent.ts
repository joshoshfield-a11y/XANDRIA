/**
 * Structured prompt-intent extraction for the XANDRIA deterministic compiler
 * (prompt-fidelity wave).
 *
 * This module is the single source of truth for the prompt->spec cue
 * vocabulary. `generateSpec` (generate.ts) consumes `extractIntent` so the
 * mapping and the reporting can never disagree about what a prompt asked for.
 *
 * Three public surfaces:
 *  - extractIntent(prompt)          — structured cues: genre/biome/atmosphere
 *                                     picks + scores, mechanic keywords,
 *                                     entity counts, degradation flag.
 *  - diffIntentVsSpec(intent, spec) — what the prompt asked for that the spec
 *                                     did NOT include (Studio reporting).
 *  - scoreSpecFulfillment(spec)     — 0..100 fidelity score surfaced in the
 *                                     validateSpec report (additive; never
 *                                     affects validation ok/errors).
 *
 * Pure, seeded-safe: regex scoring only, no Math.random / Date.now / I/O.
 * Cue-matching semantics are verbatim the compiler's: word-boundary,
 * case-insensitive keyword hits; best-match wins with ties keeping table
 * order (so legacy genres keep their old mapping).
 */
import type {
  Genre, Environment, Mood, TimeOfDay, Weather, Difficulty, Weapon, GameSpec,
} from '@spec';

/* ------------------------------------------------------------------ */
/* keyword machinery (verbatim generate.ts semantics)                  */
/* ------------------------------------------------------------------ */

export const hasKeyword = (s: string, ...words: string[]): boolean =>
  words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(s));

function matchScore(s: string, words: string[]): number {
  let n = 0;
  for (const w of words) if (hasKeyword(s, w)) n++;
  return n;
}

/** Best key by hit count; ties keep table order; undefined when no hits. */
function bestKeywordMatch<T>(s: string, keys: [T, string[]][]): T | undefined {
  let best: T | undefined;
  let bestN = 0;
  for (const [k, words] of keys) {
    const n = matchScore(s, words);
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}

/** Rows with at least one hit, sorted by hits desc (stable on table order). */
function scoredRows<T>(s: string, keys: [T, string[]][]): { key: T; hits: number; matched: string[] }[] {
  return keys
    .map(([key, words]) => ({ key, hits: matchScore(s, words), matched: words.filter((w) => hasKeyword(s, w)) }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

/* ------------------------------------------------------------------ */
/* canonical cue tables (moved verbatim from generate.ts)              */
/* ------------------------------------------------------------------ */

export const GENRE_KEYS: [Genre, string[]][] = [
  ['racing', ['race', 'racing', 'car', 'cars', 'drive', 'driving', 'drift', 'kart', 'grand prix', 'rally', 'f1']],
  ['fps-arena', ['fps', 'first person', 'first-person', 'deathmatch', 'arena shooter', 'quake', 'doom']],
  ['platformer', ['platformer', 'platform', 'jumping', 'mario', 'side scroll', 'side-scroll', 'sidescroll']],
  ['top-down-shooter', ['top-down', 'topdown', 'top down', 'twin stick', 'twin-stick', 'twinstick', 'asteroids', 'overhead', 'horde']],
  ['third-person-action', ['adventure', 'quest', 'rpg', 'sword', 'knight', 'explore', 'third person', 'third-person', 'action', 'samurai', 'ninja']],
  ['survivor', ['survivor', 'survivors', 'bullet heaven', 'bullet-hell', 'vampire survivors', 'auto-shooter', 'auto shooter', 'swarm survivor', 'swarm']],
  ['tower-defense', ['tower defense', 'tower-defense', 'turret defense', 'defend the base', 'base defense', 'defense']],
  ['endless-runner', ['endless runner', 'endless-runner', 'runner', 'temple run', 'subway surfers', 'auto-run', 'auto run', 'lane runner']],
];

export const ENV_KEYS: [Environment, string[]][] = [
  ['neon-city', ['neon', 'cyberpunk', 'cyber', 'synthwave', 'cyber city', 'tokyo']],
  ['space-station', ['space station', 'space-station', 'spaceship', 'spacecraft', 'station', 'orbital', 'derelict ship']],
  ['volcanic', ['volcano', 'volcanic', 'lava', 'magma', 'inferno', 'hell', 'molten', 'ashen']],
  ['arctic', ['arctic', 'snow', 'snowy', 'ice', 'frozen', 'winter', 'glacier', 'tundra', 'polar', 'blizzard']],
  ['desert', ['desert', 'sand', 'dune', 'dunes', 'sahara', 'oasis', 'badlands', 'dust']],
  ['wasteland', ['wasteland', 'apocalypse', 'apocalyptic', 'post-apocalyptic', 'fallout', 'ruined world', 'barren', 'desolate']],
  ['city', ['city', 'urban', 'downtown', 'street', 'streets', 'alley', 'metropolis', 'skyscraper']],
  ['ruins', ['ruins', 'ancient', 'temple', 'aztec', 'mayan', 'lost city', 'archaeology', 'castle', 'fortress', 'catacombs', 'graveyard']],
  ['dreamscape', ['dream', 'dreamscape', 'surreal', 'dreamy', 'liminal', 'void', 'ethereal', 'otherworldly']],
  ['islands', ['island', 'islands', 'tropical', 'archipelago', 'beach', 'ocean', 'lagoon', 'atoll', 'shore', 'coast']],
  ['jungle', ['jungle', 'rainforest', 'amazon', 'swamp', 'mangrove', 'bayou']],
  ['forest', ['forest', 'woods', 'woodland', 'grove', 'meadow', 'pine', 'redwood']],
];

export const MOOD_KEYS: [Mood, string[]][] = [
  ['aggressive', ['brutal', 'intense', 'aggressive', 'hardcore', 'rage', 'savage', 'feral', 'bloodthirsty']],
  ['dark', ['dark', 'horror', 'scary', 'grim', 'gothic', 'evil', 'demon', 'haunted', 'creepy', 'sinister', 'macabre']],
  ['tense', ['tense', 'suspense', 'thriller', 'stealth', 'stealthy', 'danger']],
  ['mysterious', ['mysterious', 'mystery', 'enigma', 'strange', 'eerie', 'liminal', 'uncanny']],
  ['chill', ['chill', 'relaxing', 'calm', 'peaceful', 'cozy', 'gentle', 'serene', 'tranquil']],
  ['retro', ['retro', 'arcade', 'synthwave', '8-bit', 'pixel', 'vaporwave']],
  ['heroic', ['heroic', 'hero', 'legend', 'champion', 'save', 'valiant']],
  ['epic', ['epic', 'grand', 'vast', 'massive', 'colossal', 'mythic', 'legendary']],
];

/** Ordered first-match chains (verbatim generate.ts order). */
const TIME_OF_DAY_CHAIN: [TimeOfDay, string[]][] = [
  ['night', ['night', 'midnight', 'moonlit', 'moonlight', 'starlit', 'darkness']],
  ['dusk', ['sunset', 'dusk', 'evening', 'twilight', 'golden hour']],
  ['dawn', ['dawn', 'sunrise', 'morning', 'daybreak']],
];
const WEATHER_CHAIN: [Weather, string[]][] = [
  ['storm', ['storm', 'thunder', 'lightning', 'tempest', 'sandstorm', 'hail']],
  ['rain', ['rain', 'rainy', 'drizzle', 'downpour', 'monsoon']],
  ['fog', ['fog', 'foggy', 'mist', 'misty', 'haze']],
  ['snow', ['blizzard', 'sleet']],
];
const firstChainMatch = <T>(s: string, chain: [T, string[]][]): T | undefined => {
  for (const [k, words] of chain) if (hasKeyword(s, ...words)) return k;
  return undefined;
};

const WEAPON_CHAIN: [Weapon, string[]][] = [
  ['sword', ['sword', 'katana', 'blade', 'melee', 'knife', 'axe', 'bow', 'crossbow']],
  ['shotgun', ['shotgun', 'grenade', 'rocket', 'bazooka']],
  ['rifle', ['rifle', 'machine gun', 'smg', 'pistol', 'gun', 'revolver', 'handgun']],
  ['blaster', ['laser', 'plasma']],
  ['none', ['fists', 'unarmed', 'parkour']],
];

/* ------------------------------------------------------------------ */
/* mechanic vocabulary: engine-supported vs not-yet                     */
/* ------------------------------------------------------------------ */

export interface MechanicDef {
  id: string;
  label: string;
  words: string[];
  /** The engine/blueprints can express this at all. */
  supported: boolean;
  /** True when the generated spec honors the cue (defensive: never throws). */
  reflected: (spec: GameSpec) => boolean;
  /** Static reason used when supported && !reflected. */
  missingWhy: string;
}

const enemiesOf = (spec: GameSpec) => (Array.isArray((spec as any).enemies) ? (spec as any).enemies as { kind?: string }[] : []);
const stagesOf = (spec: GameSpec) => (Array.isArray((spec as any).objective?.stages) ? (spec as any).objective.stages as { type?: string }[] : []);
const abilitiesOf = (spec: GameSpec) => (Array.isArray((spec as any).player?.abilities) ? (spec as any).player.abilities as string[] : []);
const craftingOn = (spec: GameSpec) => (spec as any).custom?.crafting?.enabled ?? true;

export const MECHANIC_DEFS: MechanicDef[] = [
  { id: 'boss', label: 'boss fight', words: ['boss', 'giant', 'colossus', 'warden'], supported: true,
    reflected: (s) => enemiesOf(s).some((e) => e.kind === 'brute') || (s as any).objective?.type === 'boss' || stagesOf(s).some((st) => st.type === 'boss'),
    missingWhy: 'no brute-class enemy or boss stage was generated for this build' },
  { id: 'crafting', label: 'crafting', words: ['craft', 'crafting', 'recipe', 'recipes', 'workbench', 'anvil', 'forge'], supported: true,
    reflected: (s) => craftingOn(s), missingWhy: 'crafting is disabled in this spec' },
  { id: 'gathering', label: 'gathering', words: ['gather', 'gathering', 'harvest', 'harvesting', 'mine', 'mining', 'forage', 'foraging'], supported: true,
    reflected: (s) => craftingOn(s) && ((s as any).custom?.crafting?.gathering?.density ?? 50) > 0,
    missingWhy: 'gathering density is 0 in this spec' },
  { id: 'quest', label: 'quest line', words: ['quest', 'quests', 'story', 'storyline', 'campaign', 'mission', 'missions', 'chapter', 'chapters'], supported: true,
    reflected: (s) => stagesOf(s).length > 0, missingWhy: 'no quest stages in this spec' },
  { id: 'sidequest', label: 'side quests', words: ['side quest', 'side quests', 'sidequest', 'sidequests', 'side mission', 'side missions'], supported: true,
    reflected: (s) => ((s as any).custom?.quests?.sideQuestCount ?? 6) > 0, missingWhy: 'side quests are disabled in this spec' },
  { id: 'portals', label: 'portals', words: ['portal', 'portals', 'fast travel', 'multi-map', 'multimap'], supported: true,
    reflected: (s) => (s as any).world?.portals?.enabled === true,
    missingWhy: 'multi-map portals are only enabled for open-world-scale builds (third-person-action or an explicit big-world prompt)' },
  { id: 'npc', label: 'NPC villagers', words: ['npc', 'npcs', 'villager', 'villagers', 'dialogue', 'dialog', 'talk to', 'conversation', 'conversations'], supported: true,
    reflected: (s) => (s as any).meta?.genre === 'third-person-action' || (((s as any).custom?.npcs?.length ?? 0) > 0),
    missingWhy: 'villagers only spawn in third-person-action builds' },
  { id: 'skills', label: 'skills / leveling', words: ['skill', 'skills', 'level up', 'levelup', 'xp', 'experience points', 'talent', 'talents'], supported: true,
    reflected: (s) => (s as any).progression?.enabled === true, missingWhy: 'progression is disabled in this spec' },
  { id: 'loot', label: 'loot / collectibles', words: ['loot', 'treasure', 'coins', 'collect', 'pickup', 'pickups', 'shards'], supported: true,
    reflected: (s) => (s as any).objective?.type === 'collect' || ((s as any).pickups?.coins ?? 0) > 0,
    missingWhy: 'no collect objective or coin pickups in this spec' },
  { id: 'survive', label: 'survival mode', words: ['survive', 'horde', 'endless'], supported: true,
    reflected: (s) => (s as any).objective?.type === 'survive' || ((s as any).objective?.timeLimit ?? 0) > 0,
    missingWhy: 'no survival objective or time limit in this spec' },
  { id: 'vehicle', label: 'drivable vehicle', words: ['vehicle', 'vehicles'], supported: true,
    reflected: (s) => (s as any).player?.type === 'vehicle', missingWhy: 'only racing builds have a vehicle player' },
  { id: 'jump', label: 'jumping', words: ['jump', 'jumping', 'double jump', 'doublejump'], supported: true,
    reflected: (s) => abilitiesOf(s).includes('doubleJump'), missingWhy: 'double-jump is only granted to platformer / endless-runner builds' },
  { id: 'dash', label: 'dash', words: ['dash', 'dashing'], supported: true,
    reflected: (s) => abilitiesOf(s).includes('dash'), missingWhy: 'racing builds have no player abilities' },
  { id: 'sprint', label: 'sprint', words: ['sprint', 'sprinting'], supported: true,
    reflected: (s) => abilitiesOf(s).includes('sprint'), missingWhy: 'only action builds grant sprint' },
  { id: 'glide', label: 'gliding', words: ['glide', 'gliding'], supported: true,
    reflected: (s) => abilitiesOf(s).includes('glide'),
    missingWhy: 'the engine supports gliding (CharacterController) but the generator never grants the ability yet' },
  // ---- not expressible by the engine (honest "not supported") ----
  { id: 'multiplayer', label: 'multiplayer', words: ['multiplayer', 'co-op', 'coop', 'co op', 'online', 'pvp', 'mmo', 'lan party'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'dragon', label: 'dragons', words: ['dragon', 'dragons', 'wyvern', 'wyverns', 'drake'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'fly', label: 'flight', words: ['fly', 'flying', 'flight', 'wings', 'jetpack', 'jetpacks'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'swim', label: 'swimming', words: ['swim', 'swimming', 'dive', 'diving', 'underwater'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'stealth', label: 'stealth', words: ['stealth', 'sneak', 'sneaking', 'invisible', 'invisibility'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'build', label: 'base building', words: ['base building', 'build a base', 'fortify', 'fortress'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet (tower-defense has fixed turret slots, not free building)' },
  { id: 'farm', label: 'farming', words: ['farm', 'farming', 'crops', 'harvest moon'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'fish', label: 'fishing', words: ['fish', 'fishing', 'angler'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'pet', label: 'pets / mounts', words: ['pet', 'pets', 'companion', 'companions', 'mount', 'mounts', 'horse', 'ride a horse'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
  { id: 'shop', label: 'shops / trading', words: ['shop', 'shops', 'vendor', 'vendors', 'trade', 'trading', 'merchant', 'merchants', 'buy', 'sell'], supported: false,
    reflected: () => false, missingWhy: 'not supported by the engine yet' },
];

/* ------------------------------------------------------------------ */
/* entity-count asks: "6 waves", "10 laps", ...                        */
/* ------------------------------------------------------------------ */

export interface EntityCountAsk { kind: 'waves' | 'laps' | 'coins' | 'enemies' | 'bosses' | 'shards'; n: number }

const COUNT_RE = /(\d+)\s+(waves?|laps?|coins?|enemies?|bosses?|shards?)/gi;
const COUNT_KIND = (w: string): EntityCountAsk['kind'] => {
  const t = w.toLowerCase();
  if (t.startsWith('wave')) return 'waves';
  if (t.startsWith('lap')) return 'laps';
  if (t.startsWith('coin')) return 'coins';
  if (t.startsWith('enem')) return 'enemies';
  if (t.startsWith('boss')) return 'bosses';
  return 'shards';
};

function extractEntityCounts(text: string): EntityCountAsk[] {
  const out: EntityCountAsk[] = [];
  COUNT_RE.lastIndex = 0;
  for (let m = COUNT_RE.exec(text); m; m = COUNT_RE.exec(text)) {
    out.push({ kind: COUNT_KIND(m[2]), n: parseInt(m[1], 10) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the structured intent record                                        */
/* ------------------------------------------------------------------ */

export interface MechanicCue { def: MechanicDef; matched: string[] }

export interface PromptIntent {
  /** trimmed prompt text */
  raw: string;
  /** true when the prompt has no readable text at all (empty/emoji/punct) */
  degraded: boolean;
  genre: Genre | undefined;
  genreScores: { key: Genre; hits: number; matched: string[] }[];
  environment: Environment | undefined;
  environmentScores: { key: Environment; hits: number; matched: string[] }[];
  /** first-match mood cue (undefined = compiler default) */
  moodCue: Mood | undefined;
  /** first-match time-of-day cue (undefined = compiler default) */
  timeOfDayCue: TimeOfDay | undefined;
  /** first-match weather cue (undefined = compiler default) */
  weatherCue: Weather | undefined;
  difficulty: Difficulty;
  /** weapon keyword cue (undefined = compiler genre default) */
  weaponCue: Weapon | undefined;
  /** objective keyword cue (undefined = compiler default) */
  objectiveCue: 'boss' | 'collect' | 'survive' | 'reach' | undefined;
  longCue: boolean;
  timedCue: boolean;
  wantsWater: boolean;
  wantsDrones: boolean;
  wantsTurrets: boolean;
  wantsBoss: boolean;
  terrainWord: 'mountains' | 'canyon' | 'flat' | undefined;
  /** raw parsed "N waves" (undefined when absent); clamping is the mapping's job */
  towerWavesAsk: number | undefined;
  bigWorldCue: boolean;
  rallyCue: boolean;
  mechanicCues: MechanicCue[];
  entityCounts: EntityCountAsk[];
}

export function extractIntent(prompt: string): PromptIntent {
  const text = prompt.trim();
  const degraded = text.length === 0 || !/[a-z0-9]/i.test(text);

  const genreScores = scoredRows(text, GENRE_KEYS);
  const environmentScores = scoredRows(text, ENV_KEYS);

  let moodCue: Mood | undefined;
  for (const [m, words] of MOOD_KEYS) if (hasKeyword(text, ...words)) { moodCue = m; break; }

  const difficulty: Difficulty =
    hasKeyword(text, 'nightmare', 'insane', 'brutal', 'very hard', 'extreme', 'hardest', 'merciless') ? 'hard'
    : hasKeyword(text, 'easy', 'casual', 'relaxing', 'beginner', 'peaceful') ? 'easy'
    : 'normal';

  const weaponCue = firstChainMatch(text, WEAPON_CHAIN);

  const objectiveCue =
    hasKeyword(text, 'boss') ? 'boss'
    : hasKeyword(text, 'collect', 'gather', 'treasure', 'coins') ? 'collect'
    : hasKeyword(text, 'survive', 'horde', 'waves', 'endless') ? 'survive'
    : hasKeyword(text, 'reach', 'escape', 'get to', 'beacon', 'flag') ? 'reach'
    : undefined;

  const tdWaveMatch = /(\d+)\s+waves?/i.exec(text);

  const mechanicCues: MechanicCue[] = [];
  for (const def of MECHANIC_DEFS) {
    const matched = def.words.filter((w) => hasKeyword(text, w));
    if (matched.length > 0) mechanicCues.push({ def, matched });
  }

  return {
    raw: text,
    degraded,
    genre: bestKeywordMatch(text, GENRE_KEYS),
    genreScores,
    environment: bestKeywordMatch(text, ENV_KEYS),
    environmentScores,
    moodCue,
    timeOfDayCue: firstChainMatch(text, TIME_OF_DAY_CHAIN),
    weatherCue: firstChainMatch(text, WEATHER_CHAIN),
    difficulty,
    weaponCue,
    objectiveCue,
    longCue: hasKeyword(text, 'long'),
    timedCue: hasKeyword(text, 'timed', 'time limit', 'speedrun'),
    wantsWater: hasKeyword(text, 'lake', 'ocean', 'sea', 'water', 'river', 'flood'),
    wantsDrones: hasKeyword(text, 'drone', 'drones', 'robot', 'robots', 'mech'),
    wantsTurrets: hasKeyword(text, 'turret', 'turrets', 'defense'),
    wantsBoss: hasKeyword(text, 'boss', 'giant', 'colossus'),
    terrainWord: hasKeyword(text, 'mountain', 'mountains', 'alpine') ? 'mountains'
      : hasKeyword(text, 'canyon', 'gorge') ? 'canyon'
      : hasKeyword(text, 'flat', 'plains') ? 'flat'
      : undefined,
    towerWavesAsk: tdWaveMatch ? parseInt(tdWaveMatch[1], 10) : undefined,
    bigWorldCue: hasKeyword(text, 'open world', 'open-world', 'vast', 'expansive',
      'sprawling', 'huge world', 'massive world', 'enormous world', 'huge map',
      'massive map', 'big map', 'large map', 'enormous map', 'continent', 'world map'),
    rallyCue: hasKeyword(text, 'rally', 'desert rally', 'open desert',
      'off-road', 'offroad', 'cross-country', 'cross country', 'dakar'),
    mechanicCues,
    entityCounts: extractEntityCounts(text),
  };
}

/* ------------------------------------------------------------------ */
/* unmapped-intent diff: what the prompt asked for that the spec lacks  */
/* ------------------------------------------------------------------ */

export interface UnmappedAsk {
  kind: 'mechanic' | 'entity-count' | 'genre-cue' | 'biome-cue' | 'atmosphere-cue';
  /** short label for UI, e.g. 'dragons', '6 waves', 'racing' */
  ask: string;
  /** human reason, e.g. 'not supported by the engine yet' */
  detail: string;
  /** the engine could express this in principle */
  supported: boolean;
}

export function diffIntentVsSpec(intent: PromptIntent, spec: GameSpec): UnmappedAsk[] {
  const out: UnmappedAsk[] = [];
  if (intent.degraded) return out; // nothing was asked; the Studio reports the fallback separately
  const genre = (spec as any).meta?.genre as Genre | undefined;
  const env = (spec as any).theme?.environment as Environment | undefined;

  // 1. mechanic cues the spec does not honor
  for (const cue of intent.mechanicCues) {
    let reflected = false;
    try { reflected = cue.def.reflected(spec); } catch { reflected = false; }
    if (!reflected) {
      out.push({
        kind: 'mechanic',
        ask: cue.def.label,
        detail: cue.def.supported ? cue.def.missingWhy : cue.def.missingWhy,
        supported: cue.def.supported,
      });
    }
  }

  // 2. entity counts the spec did not honor
  for (const ask of intent.entityCounts) {
    const n = ask.n;
    if (ask.kind === 'waves') {
      const tdWaves = (spec as any).custom?.towerDefense?.waves as number | undefined;
      if (genre === 'tower-defense' && typeof tdWaves === 'number') {
        if (tdWaves !== n) {
          out.push({ kind: 'entity-count', ask: `${n} waves`, detail: `this build runs ${tdWaves} waves (engine range 2-8)`, supported: true });
        }
      } else {
        out.push({ kind: 'entity-count', ask: `${n} waves`, detail: 'wave counts only apply to tower-defense builds', supported: true });
      }
    } else if (ask.kind === 'laps') {
      const laps = (spec as any).objective?.count as number | undefined;
      if (genre === 'racing' && typeof laps === 'number') {
        if (laps !== n) out.push({ kind: 'entity-count', ask: `${n} laps`, detail: `this race runs ${laps} laps`, supported: true });
      } else {
        out.push({ kind: 'entity-count', ask: `${n} laps`, detail: 'lap counts only apply to racing builds', supported: true });
      }
    } else if (ask.kind === 'coins' || ask.kind === 'shards') {
      const obj = (spec as any).objective;
      if (obj?.type === 'collect' && typeof obj.count === 'number') {
        if (obj.count !== n) out.push({ kind: 'entity-count', ask: `${n} ${ask.kind}`, detail: `this build scatters ${obj.count} (seeded count)`, supported: true });
      } else {
        out.push({ kind: 'entity-count', ask: `${n} ${ask.kind}`, detail: 'no collect objective in this build', supported: true });
      }
    } else {
      out.push({ kind: 'entity-count', ask: `${n} ${ask.kind}`, detail: 'enemy rosters are seeded, not exact — counts from prompts are not honored', supported: true });
    }
  }

  // 3. genre / biome cues that lost the vote
  for (const row of intent.genreScores) {
    if (row.key !== genre) {
      out.push({ kind: 'genre-cue', ask: String(row.key), detail: `genre cue (${row.matched.join(', ')}) lost the vote to ${genre ?? 'the default'}`, supported: true });
    }
  }
  for (const row of intent.environmentScores) {
    if (row.key !== env) {
      out.push({ kind: 'biome-cue', ask: String(row.key), detail: `biome cue (${row.matched.join(', ')}) lost the vote to ${env ?? 'the default'}`, supported: true });
    }
  }

  // 4. atmosphere cues the spec overrode
  if (intent.moodCue && (spec as any).audio?.mood !== undefined && (spec as any).audio.mood !== intent.moodCue) {
    out.push({ kind: 'atmosphere-cue', ask: `${intent.moodCue} mood`, detail: `overridden to ${(spec as any).audio.mood} by the biome/genre`, supported: true });
  }
  if (intent.timeOfDayCue && (spec as any).theme?.timeOfDay !== undefined && (spec as any).theme.timeOfDay !== intent.timeOfDayCue) {
    out.push({ kind: 'atmosphere-cue', ask: `${intent.timeOfDayCue} time`, detail: `overridden to ${(spec as any).theme.timeOfDay}`, supported: true });
  }
  if (intent.weatherCue && (spec as any).theme?.weather !== undefined && (spec as any).theme.weather !== intent.weatherCue) {
    out.push({ kind: 'atmosphere-cue', ask: `${intent.weatherCue} weather`, detail: `overridden to ${(spec as any).theme.weather}`, supported: true });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* fulfillment scoring (surfaced in the validateSpec report)            */
/* ------------------------------------------------------------------ */

export interface FidelityScore {
  /** 0..100, rounded. 100 when nothing was asked (degraded/empty prompt). */
  score: number;
  mapped: number;
  total: number;
  unmapped: UnmappedAsk[];
}

/** Number of distinct asks the prompt made (the score denominator). */
function countCues(intent: PromptIntent): number {
  return intent.mechanicCues.length
    + intent.entityCounts.length
    + intent.genreScores.length
    + intent.environmentScores.length
    + (intent.moodCue ? 1 : 0)
    + (intent.timeOfDayCue ? 1 : 0)
    + (intent.weatherCue ? 1 : 0)
    + (intent.weaponCue ? 1 : 0);
}

export function scoreIntentVsSpec(intent: PromptIntent, spec: GameSpec): FidelityScore {
  const unmapped = diffIntentVsSpec(intent, spec);
  const total = countCues(intent);
  const mapped = Math.max(0, total - unmapped.length);
  return {
    score: total === 0 ? 100 : Math.round((mapped / total) * 100),
    mapped, total, unmapped,
  };
}

/**
 * Score a spec against its own meta.description (the compiler stores the
 * prompt there, sliced to 300 chars). Returns undefined when there is no
 * prompt to score against. Never throws; never affects validation.
 */
export function scoreSpecFulfillment(spec: unknown): FidelityScore | undefined {
  try {
    const desc = (spec as any)?.meta?.description;
    if (typeof desc !== 'string' || desc.trim().length === 0) return undefined;
    return scoreIntentVsSpec(extractIntent(desc), spec as GameSpec);
  } catch {
    return undefined;
  }
}
