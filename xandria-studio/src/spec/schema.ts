/**
 * GameSpec — the central contract of XANDRIA Studio.
 *
 * Every game the engine produces is fully described by one validated GameSpec.
 * Generators (deterministic or LLM) emit specs; blueprints consume them.
 * A spec that passes `validateSpec` is *guaranteed* to build into a playable game.
 */
import { scoreSpecFulfillment } from '../generator/intent';

// ---------------- unions ----------------
export const GENRES = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter', 'survivor', 'tower-defense', 'endless-runner'] as const;
export type Genre = (typeof GENRES)[number];

export const ENVIRONMENTS = [
  'forest', 'jungle', 'desert', 'wasteland', 'arctic', 'volcanic', 'city',
  'neon-city', 'space-station', 'ruins', 'dreamscape', 'islands', 'arena',
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Biome treatments (workstream C): the 7 authored biome looks. World gen
 * resolves one per seed/genre (see engine/world/Biomes.ts); the Studio can
 * force one via custom.biome.biomeId. Distinct from Environment (the
 * generator's broader setting) — several environments share a biome.
 */
export const BIOME_IDS = [
  'plains', 'desert-canyon', 'forest', 'snow', 'volcanic', 'coastline', 'caves',
] as const;
export type BiomeId = (typeof BIOME_IDS)[number];

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

/**
 * Portals wave (workstream C): multi-map travel config. Optional — absent =
 * legacy behavior (single map, authored boundary walls). When present and
 * `enabled`, the engine replaces the boundary walls with the energy field and
 * crossing a map edge loads the neighboring map (map identity = (mx,my) on
 * the map grid; map seed = deriveMapSeed(worldSeed, mx, my)).
 *
 * Designed for the 8000m open-world ceiling; accepted at any valid
 * world.terrain.size (60..8000) — on small maps the transitions just come
 * more often. Arena genres leave it absent (walls stay).
 */
export interface PortalSpec {
  enabled: boolean;
}

export interface WorldSpec {
  terrain: TerrainSpec;
  boundary: Boundary;
  gravity: number;     // m/s^2 (negative y)
  scatter: ScatterSpec;
  portals?: PortalSpec;
}

/** True only when the spec explicitly opts into multi-map portals. Absent or
 *  { enabled: false } = legacy single-map behavior (byte-identical worlds). */
export function portalsEnabled(spec: GameSpec): boolean {
  return spec.world.portals?.enabled === true;
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

/**
 * Ambient NPC (villager) roster entry. Mirrors EnemySpec's minimal style:
 * when `name` is absent the seeded generator in engine/game/npcNames.ts
 * fills it from the spawn seed, so same seed → same name/palette.
 */
export interface NpcSpec {
  /** explicit display name; omit to generate from the spawn seed */
  name?: string;
  /** flavor role (display only): 'villager' | 'merchant' | 'guard' | 'elder' */
  role?: string;
  /** seeded palette variation (cloth/armor/visor); omit to derive from seed */
  palette?: NpcPaletteSpec;
  /** wander radius (m) around the spawn point; default 6 */
  wanderRadius?: number;
  /** wander speed (m/s); default 1.2 */
  speed?: number;
  /** armor set id override (see VOXEL_ARMOR_SET_IDS); omit to pick per seed */
  armorSet?: string;
  /** roster size when spawned by a manager; default 1 */
  count?: number;
}

/** Explicit (non-generated) NPC palette. */
export interface NpcPaletteSpec {
  cloth?: string;
  pants?: string;
  accent?: string;
  visor?: string;
}

export interface ObjectiveSpec {
  type: ObjectiveType;
  count: number;       // collect N / eliminate N / laps / seconds survived
  timeLimit: number;   // seconds, 0 = none
  description: string;
  /** Quest chain: ordered chapters the stage sequencer plays through.
   *  Absent = legacy single-objective game. */
  stages?: ObjectiveStage[];
}

export interface ObjectiveStage {
  /** Unique within the chain. Optional for backward compatibility —
   *  normalizeSpec assigns `stage-{index}` when absent. Required on every
   *  stage when any stage in the chain uses `next`/`choices` refs. */
  id?: string;
  type: ObjectiveType;  // 'collect'|'eliminate'|'reach'|'survive'|'race'|'boss'
  count: number;        // target number (laps for race, seconds for survive via timeLimit)
  timeLimit: number;    // 0 = none
  description: string;  // e.g. "Chapter II — Defeat the wardens"
  /**
   * Explicit successors, by stage id. Default: the next stage in array order.
   * When several ids are given without `choices`, the first wins (warning).
   * An explicit empty array (or absent `next` on the last stage) ends the
   * campaign in victory.
   */
  next?: string[];
  /**
   * Player-facing branch: when non-empty, completing this stage pauses the
   * game and asks the player to pick a path; each choice's `next` names the
   * stage id to continue at. Takes precedence over `next` when both exist.
   */
  choices?: StageChoice[];
  /** Victory text when the campaign ends on this stage. Falls back to narrative.winText. */
  winText?: string;
}

/** One player-facing branch option on a stage. */
export interface StageChoice {
  /** Button label shown to the player, e.g. "Spare the warden". */
  label: string;
  /** Id of the stage this choice leads to. */
  next: string;
}

export interface NarrativeSpec {
  premise: string;  // 1-2 sentences for the intro card, derived from the intent
  winText: string;
  loseText: string;
}

export interface ProgressionSpec {
  enabled: boolean; xpPerKill: number; xpPerPickup: number;
  /** player-level XP per completed craft; progression-curve, default 15 */
  xpPerCraft?: number;
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

/** Graphics wave 2 (E): the two perf tiers — one build, two flag sets. */
export const PERF_TIER_IDS = ['desktop', 's25'] as const;
export type PerfTier = (typeof PERF_TIER_IDS)[number];

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
  /**
   * Studio biome override (workstream C): force one of the 7 authored biome
   * treatments. Unset = auto, resolved per seed/genre in engine/world/Biomes.
   */
  biomeId?: BiomeId;
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

/** https URL ending in .glb/.gltf (character models + asset packs share this rule) */
export const GLB_URL_RE = /^https:\/\/[^?#]+\.(glb|gltf)(\?.*)?$/i;
export const isGlbUrl = (u: unknown): u is string => typeof u === 'string' && GLB_URL_RE.test(u);

/** Named canvas-procedural texture patterns a skin can stamp onto body roles. */
export const SKIN_TEXTURE_PATTERNS = ['camo', 'stripes', 'digital', 'carbon', 'hazard', 'fade', 'runes'] as const;
export type SkinTexturePattern = (typeof SKIN_TEXTURE_PATTERNS)[number];

/** Body roles a skin pattern texture may be stamped onto (default: shirt+pants). */
export const SKIN_TEXTURE_ROLES = ['skin', 'shirt', 'pants', 'accent', 'accentDS'] as const;
export type SkinTextureRole = (typeof SKIN_TEXTURE_ROLES)[number];

/** CharacterRig pivots addressable by skins/imports (the six legacy limb pivots + C-wave sub-pivots). */
export const CHARACTER_PIVOTS = [
  'legL', 'legR', 'armL', 'armR', 'torso', 'head',
  'elbowL', 'elbowR', 'kneeL', 'kneeR',
] as const;
export type CharacterPivot = (typeof CHARACTER_PIVOTS)[number];

/** Palette roles — match the userData.role tags makeHumanoid stamps on its owned materials. */
export interface SkinPalette {
  skin?: string;
  shirt?: string;
  pants?: string;
  accent?: string;
}
export interface SkinEmissive {
  color: string;      // #rrggbb
  intensity: number;  // 0..5
}
/**
 * Built-in voxel armor set ids (art-direction pass). The shells are procedural
 * boxy geometry parented to the rig pivots — see engine/gfx/VoxelArmor.ts.
 * Custom sets can be registered at runtime via registerVoxelArmorSet();
 * validateSpec accepts those through ValidateSpecOptions.customArmorSets
 * (same pattern as customEnemyKinds).
 */
export const VOXEL_ARMOR_SET_IDS = ['nomad', 'raider', 'guardian', 'scout', 'plate'] as const;
export type VoxelArmorSetId = (typeof VOXEL_ARMOR_SET_IDS)[number];
/** Emissive visor slit on an armor helm (SkinDef.visor). */
export interface SkinVisor {
  color: string;       // #rrggbb
  intensity?: number;  // 0..5, default comes from the armor set
}
export interface SkinDef {
  /** display name */
  name: string;
  /** per-role color overrides (applied to the rig's owned cloned materials) */
  palette?: SkinPalette;
  /** emissive accent glow (applied to accent-role materials) */
  emissive?: SkinEmissive;
  roughness?: number;  // 0..1
  metalness?: number;  // 0..1
  /** shirt/pants texture: a URL image (https, png/jpg/webp) or a named canvas pattern.
   *  Texture failures never throw — the plain palette stands as fallback. */
  texture?: { url: string } | { pattern: SkinTexturePattern };
  /** which body roles get the texture map (default: shirt+pants). */
  textureRoles?: SkinTextureRole[];
  /** voxel armor set id rendered on the rig when the skin is applied
   *  (a built-in VOXEL_ARMOR_SET_IDS id, or a custom id registered at runtime
   *  and passed to validateSpec via ValidateSpecOptions.customArmorSets).
   *  Absent → the rig renders exactly as before (fully backward compatible). */
  armor?: string;
  /** emissive visor slit on the armor helm. Only rendered when `armor` is
   *  present; overrides the armor set's default visor color/intensity. */
  visor?: SkinVisor;
}
/**
 * One character's import/customization slot. `skin` references a skin id
 * (built-in or a custom id in `skins`); `model` is a GLB/GLTF URL that
 * replaces the procedural rig (online-only; procedural fallback always).
 * `boneMap` overrides the default Mixamo-convention pivot mapping
 * (pivot → node name in the model).
 */
export interface CharacterSlot {
  skin?: string;
  model?: string;
  boneMap?: Partial<Record<CharacterPivot, string>>;
}
/**
 * Seeded auto-armor opt-in (graphics follow-up, worker E). Lives in
 * `custom.armor`; `auto: true` is the only way to turn it on — absent or
 * false keeps the legacy armor-free path byte-identical.
 */
export interface ArmorCustom {
  /** opt-in: pick each skin's armor set deterministically from the spec seed */
  auto?: boolean;
}
export interface CharactersCustom {
  /** custom skin id → definition (merged over the built-ins at read time) */
  skins?: Record<string, SkinDef>;
  player?: CharacterSlot;
  /** enemy kind (or registered custom kind id) → slot */
  enemies?: Record<string, CharacterSlot>;
}

/** Item kinds. weapon/armor are equippable; consumable is used from inventory;
 *  material stacks for crafting hooks; key/trinket are quest/flag items. */
export const ITEM_TYPES = ['weapon', 'armor', 'consumable', 'material', 'key', 'trinket'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Equip slots on the character rig. */
export const EQUIP_SLOTS = ['weapon', 'head', 'torso', 'legs', 'accessory'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/** Rarity ladder — drives glow color + particle shimmer on world items. */
export const ITEM_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type ItemRarity = (typeof ITEM_RARITIES)[number];

/** Stat keys an item may grant while equipped (all additive, finite numbers). */
export const ITEM_STAT_KEYS = ['damage', 'defense', 'speed', 'maxHealth', 'crit', 'attackSpeed', 'luck'] as const;
export type ItemStatKey = (typeof ITEM_STAT_KEYS)[number];
export type ItemStats = Partial<Record<ItemStatKey, number>>;

/** Consumable use-behavior. */
export interface ItemBehavior {
  effect: 'heal' | 'restore' | 'buff';
  amount?: number;    // heal/restore amount, or buff magnitude
  duration?: number;  // buff seconds (0 = instant)
}
/**
 * One item definition. JSON-serializable; lives in `custom.items.defs`.
 * `slot` is required for weapon/armor (which slot it equips to).
 * `skin` references an item-skin id (built-in or `custom.items.skins`);
 * `model` is a GLB/GLTF URL mesh override (online-only, procedural fallback).
 * `stats` apply while equipped; `behavior` defines consumable use.
 */
export interface ItemDef {
  name: string;
  type: ItemType;
  slot?: EquipSlot;
  rarity?: ItemRarity;          // default 'common'
  stats?: ItemStats;
  behavior?: ItemBehavior;
  skin?: string;
  model?: string;
  stack?: number;               // max stack size 1..999, default 1
  value?: number;               // coin/vendor value, >= 0
  description?: string;         // <= 280 chars
}
/**
 * Item skin definition — the SkinDef concept extended to items.
 * `roles` maps onto an item mesh's userData.role-tagged materials
 * ('primary' | 'secondary' | 'glow'); unmapped roles keep the mesh default.
 */
export const ITEM_SKIN_ROLES = ['primary', 'secondary', 'glow'] as const;
export type ItemSkinRole = (typeof ITEM_SKIN_ROLES)[number];
export interface ItemSkinDef {
  name: string;
  palette?: Partial<Record<ItemSkinRole, string>>;  // #rrggbb each
  emissive?: SkinEmissive;
  roughness?: number;  // 0..1
  metalness?: number;  // 0..1
  /** item-mesh texture: URL image or named canvas pattern (same pattern set as character skins) */
  texture?: { url: string } | { pattern: SkinTexturePattern };
  textureRoles?: ItemSkinRole[];
  /** voxel armor set id rendered when an armor-slot item carrying this skin is
   *  equipped (see engine/gfx/VoxelArmor.ts). Same id rules as SkinDef.armor. */
  armor?: string;
}
/** A fixed loot placement: item id + world position (+ optional count). */
export interface ItemLootSpot {
  item: string;
  pos: [number, number, number];
  count?: number;
}
/** A breakable/lootable container placed in the world. */
export interface ItemChestDef {
  pos: [number, number, number];
  loot: string[];          // item ids
  locked?: boolean;
  skin?: string;           // chest skin id (item skins)
}
/**
 * Item tables for a generated game. All visual/behavioral — the generator
 * may emit these; the runtime resolves ids against `defs` (unknown ids are
 * hard errors at validation time, so typos never ship silently).
 */
export interface ItemsCustom {
  /** item id → definition */
  defs?: Record<string, ItemDef>;
  /** custom item-skin id → definition (merged over built-ins at read time) */
  skins?: Record<string, ItemSkinDef>;
  /** fixed world loot placements */
  loot?: ItemLootSpot[];
  /** containers placed in the world */
  chests?: ItemChestDef[];
  /** item ids the player starts with */
  starting?: string[];
}
/**
 * Per-asset visual override (the reskin contract).
 * `custom.assets` accepts either the legacy AssetPacks shape (when an
 * `enabled` key is present) or a record of these overrides keyed by asset id
 * (e.g. "player.body", "enemy.walker", "world.sky"). Visual only — never
 * affects gameplay. Unknown ids warn at runtime; invalid values are skipped.
 */
export interface AssetOverride {
  color?: string;              // CSS hex, e.g. "#ff0044"
  emissive?: string;           // CSS hex
  emissiveIntensity?: number;
  scale?: number;              // multiplicative, clamped 0.05..10 at runtime
  visible?: boolean;
}
export interface CustomSpec {
  biome?: BiomeCustom;
  forge?: ForgeCustom;
  enemyMods?: EnemyMods;
  weaponMods?: WeaponMods;
  quality?: QualityMode;
  /**
   * Graphics wave 2 (E): perf-tier preview override for the Studio
   * ('desktop' | 's25'). Absent = auto-detect. Player setting and ?tier=
   * still win at runtime — this is the authoring preview surface.
   */
  tier?: PerfTier;
  assets?: AssetPacks | Record<string, AssetOverride>;
  /**
   * Character customization (workstream D+E): skins + GLB import slots for the
   * player and per enemy kind. Visual only — never touches gameplay. Every
   * field optional; invalid values are rejected by validateSpec. Online-only
   * model URLs always fall back to the procedural rig on any failure.
   */
  characters?: CharactersCustom;
  /**
   * Item tables (inventory wave): item definitions, item skins, world loot
   * placement, chests, and starting inventory. Gameplay + visual; ids in
   * loot/chests/starting must exist in `defs`. Invalid values are rejected
   * by validateSpec.
   */
  items?: ItemsCustom;
  /**
   * Opt-in seeded auto-armor (graphics follow-up, worker E): when true, skins
   * with no explicit `armor` render a deterministic armor set picked from the
   * spec seed via pickVoxelArmorSetId. Default / absent / false → the legacy
   * path: legacy skins render armor-free (their tested contract). Visual
   * only — never touches gameplay.
   */
  armor?: ArmorCustom;
  /** legacy operator ids (1..72) matched from the prompt vocabulary bridge. Informational only. */
  legacyOperators?: number[];
  /**
   * Cross-run progression: damage multiplier from the equipped profile
   * loadout ('power' modifier). Set by Profile.applyLoadout(), read by
   * Progression.damageMult(). Config-only — never touches the seed.
   */
  profileDamageMult?: number;
  /**
   * Portals wave (workstream C): the map-grid coordinate of THIS map build,
   * stamped by the portal transition flow (workstream B). Absent = a legacy
   * single-map build.
   *
   * Session contract (workers B/D): spec.meta.seed is ALWAYS this map's
   * build seed — the origin map uses deriveMapSeed(worldSeed, 0, 0) too, so
   * every map goes through the same path. worldSeed is carried here so the
   * per-map biome stays a pure function of (worldSeed, mx, my) via
   * deriveMapBiome. Not user-editable in the Studio.
   */
  portalMap?: { mx: number; my: number; worldSeed: number };
  /**
   * NPCs wave (workstream C): authoring controls for ambient NPCs.
   * Master density scales the default roster (8 at 1.0); lowTierScale
   * multiplies the count on reduced-fidelity tiers (s25). Config-only —
   * never touches the seed. Read by resolveNpcCount (engine/game/npcTuning).
   */
  npcs?: NpcTuningCustom;
  /**
   * Enemies wave (workstream C): authoring controls for enemy counts.
   * Master density scales every spec count on the portal-arrival path
   * (round(count * density)); lowTierScale multiplies the density on
   * reduced-fidelity tiers (s25). Config-only — never touches the seed.
   * Read by resolveEnemyDensity (engine/game/enemyTuning), wired into
   * EnemyManagerOpts.density by every blueprint that builds an
   * EnemyManager.
   */
  enemies?: EnemyTuningCustom;
  /**
   * Crafting wave (workstream A): authoring controls for the crafting
   * system. Master toggle, gathering-node density (0..100), and the seeded
   * recipe-pool config. Config-only — never touches the seed. Read by
   * resolveCraftingEnabled / resolveGatheringDensity / buildRecipePool
   * (engine/game/crafting); the Studio CRAFTING toggle + GATHERING DENSITY
   * slider write these fields (workstream C owns editorPanel.ts).
   */
  crafting?: CraftingCustom;
  /**
   * Quest wave: authoring controls for the main-story quest line. Master
   * toggle + an exact quest-count override (1..8); absent = the seeded
   * 3..5-quest pool from the spec seed. Config-only — never touches the
   * seed. Read by resolveQuestsEnabled / buildQuestPool (engine/game/quests).
   */
  quests?: QuestsCustom;
  /**
   * Boss-fights wave: generator flag marking boss maps. When `enabled` is
   * true (default: true whenever the spec has a boss objective stage), the
   * boss-fight system activates on this map: a seeded boss arena is placed
   * (Rng(mapSeed ^ BOSS_SALT)), the boss brute is tethered to it, and the
   * data-driven boss def (`bossId`) drives telegraphed attacks. Set
   * `enabled: false` to keep a boss objective's legacy melee-only behavior.
   * Config-only — never touches the seed. Read by
   * bossEnabled/resolveBossDef (engine/game/bosses).
   */
  boss?: BossCustom;
  /**
   * Skills wave: Studio-authored skill tuning. Master toggle + XP gain
   * multiplier. Config-only — never touches the seed. Read by
   * resolveSkillsEnabled / resolveSkillsXpMultiplier (engine/game/skills);
   * the Studio SKILLS section writes these fields.
   */
  skills?: SkillsTuningCustom;
}

/**
 * Boss-fights wave: the generator flag marking boss maps. All fields
 * optional; absent = defaults (enabled when a boss stage exists,
 * bossId 'the-warden', arenaRadius from the boss def).
 */
export interface BossCustom {
  /**
   * master boss-fight toggle. Default: true when the spec has any boss
   * objective stage (legacy `type: 'boss'` or a staged boss), false
   * otherwise. Explicit false disables the arena + telegraphed attacks
   * even on boss stages (legacy brute behavior is preserved).
   */
  enabled?: boolean;
  /** boss def id from BOSS_DEFS (default 'the-warden'); unknown ids fall back. */
  bossId?: string;
  /** arena radius override in meters (default = the boss def's arenaRadius). */
  arenaRadius?: number;
}

/**
 * NPCs wave (workstream C): Studio-authored NPC tuning. Both fields are
 * 0..1 multipliers; absent = 1.0 defaults.
 */
export interface NpcTuningCustom {
  /** master NPC density multiplier (default 1 = the standard 8-NPC roster) */
  density?: number;
  /**
   * count multiplier on reduced-fidelity tiers (default 0.5): the S25 tier
   * spawns half the desktop roster so NPC draw cost stays proportional to
   * the tier's other tuned-down budgets.
   */
  lowTierScale?: number;
}

/**
 * Enemies wave (workstream C): Studio-authored enemy tuning. Both fields
 * are 0..1 multipliers; absent = defaults (1.0 density, 0.5 low-tier
 * scale). Applied per spec count in EnemyManager.spawnForMap.
 */
export interface EnemyTuningCustom {
  /** master enemy density multiplier (default 1 = the authored spec counts) */
  density?: number;
  /**
   * density multiplier on reduced-fidelity tiers (default 0.5): the S25
   * tier spawns half the desktop roster so enemy draw cost stays
   * proportional to the tier's other tuned-down budgets.
   */
  lowTierScale?: number;
}

/**
 * Crafting wave (workstream A): Studio-authored crafting controls. All
 * fields optional; absent = defaults (enabled, density 100, poolSize 8).
 */
export interface CraftingCustom {
  /**
   * master crafting toggle (default true). When false, the crafting system
   * is disabled: workstream B skips gathering-node spawn, workstream C
   * skips station placement + recipe UI, and craft() fails closed with
   * `crafting-disabled`. Read by resolveCraftingEnabled (engine/game/crafting).
   */
  enabled?: boolean;
  /**
   * gathering-node controls (workstream B). The Studio GATHERING DENSITY
   * slider (0..100%) writes `density`; B resolves it per map/tier via
   * resolveGatheringDensity (engine/game/crafting), which returns a 0..1
   * fraction. Same as NPC/enemy density: applies on the portal-arrival
   * (`spawnForMap`) path only — never touches the seed.
   */
  gathering?: GatheringTuningCustom;
  /**
   * seeded recipe-pool configuration. The pool itself is a pure function
   * of (spec.meta.seed, poolSize) — buildRecipePool (engine/game/crafting)
   * shuffles the fixed recipe catalog with Rng(seed ^ CRAFT_SALT) and
   * takes the first poolSize entries. Same spec → identical pool.
   */
  recipes?: CraftingPoolCustom;
}

/** Crafting wave (workstream A): gathering-node density config. */
export interface GatheringTuningCustom {
  /**
   * node spawn density 0..100 (default 100): the Studio GATHERING DENSITY
   * slider writes this directly. 0 = no nodes, 100 = the full seeded roster.
   */
  density?: number;
}

/** Crafting wave (workstream A): seeded recipe-pool size config. */
export interface CraftingPoolCustom {
  /**
   * how many recipes the seeded pool holds (default 8, clamped to
   * 1..catalog length). Only the count is authored — which recipes appear
   * is seeded, so a Studio author can regenerate variety by changing the
   * spec seed, never by hand-picking.
   */
  poolSize?: number;
}

/**
 * Studio-authored override for one quest's curated reward
 * (curated-quest-rewards wave). Keyed by quest template slug; see
 * engine/game/questRewards for the curated tables.
 */
export interface QuestRewardOverride {
  /** override XP (undefined = keep the curated xp) */
  xp?: number;
  /** override item lines (undefined = keep the curated items) */
  items?: { id: string; count: number }[];
}

/**
 * Quest wave: Studio-authored quest-line controls. All fields optional;
 * absent = defaults (enabled, seeded 3..5 quests).
 */
export interface QuestsCustom {
  /**
   * master quest toggle (default true). When false, the quest system is
   * disabled: blueprints skip the QuestManager, the quest tracker and the
   * talk session. Read by resolveQuestsEnabled (engine/game/quests).
   */
  enabled?: boolean;
  /**
   * exact quest count 1..8 (default: seeded 3..5 from spec.meta.seed).
   * Only the count is authored — which quests appear is seeded.
   */
  questCount?: number;
  /**
   * Side-quests wave: exact side-quest count 1..12 (default: seeded 6..9
   * from spec.meta.seed ^ SIDE_QUEST_SALT). Only the count is authored —
   * which side quests appear is seeded.
   */
  sideQuestCount?: number;
  /**
   * Curated-quest-rewards wave: per-quest reward overrides, keyed by quest
   * template slug (e.g. 'first_blood', 'spare_parts'). {xp?, items?} merge
   * over the curated tables (engine/game/questRewards); unknown slugs are
   * rejected at validation time. The seeded bonus-material line is NOT
   * overridable — it stays deterministic per (pool seed, slug).
   */
  rewardOverrides?: Record<string, QuestRewardOverride>;
}

/** Skills wave: Studio-authored skill tuning. */
export interface SkillsTuningCustom {
  /**
   * master skills toggle (default true). When false, the SkillSystem
   * no-ops: no XP is granted, ranks stay at 1, and skill-gated recipes
   * keep their gates (rank 1 still passes rank-1 gates).
   */
  enabled?: boolean;
  /**
   * scales all skill XP gains (default 1, clamped 0..10). 2 = twice as
   * fast through the ranks; 0 = frozen ranks.
   */
  xpMultiplier?: number;
}

export interface GameSpec {
  meta: MetaSpec;
  theme: ThemeSpec;
  world: WorldSpec;
  player: PlayerSpec;
  enemies: EnemySpec[];
  /** ambient NPC roster (gameplay wave: NPC core). Optional — absent = no NPCs. */
  npcs?: NpcSpec[];
  objective: ObjectiveSpec;
  pickups: PickupSpec;
  rules: RulesSpec;
  audio: AudioSpec;
  narrative?: NarrativeSpec;
  progression?: ProgressionSpec;
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
  /** Non-fatal notices: unknown keys that were ignored, etc. Never affect `ok`. */
  warnings: string[];
  /**
   * Prompt->spec fidelity (prompt-fidelity wave): how much of the prompt's
   * ask the spec actually honors, scored against meta.description (the
   * compiler stores the prompt there). Additive diagnostics only — never
   * affects `ok`, `errors`, or `warnings`. Undefined when there is no prompt
   * text to score against. Re-exported type lives in generator/intent.ts
   * (import type only there, so no runtime cycle).
   */
  fulfillment?: import('../generator/intent').FidelityScore;
}

interface WinnabilityCtx {
  totalEnemies: number;
  coins: number;
  hasBrute: boolean;
}

/**
 * Shared winnability rules, applied to the legacy objective AND to every
 * quest stage. `path` is the error prefix, e.g. 'objective' or
 * 'objective.stages[2]'.
 */
function checkWinnable(
  o: { type: unknown; count: unknown; timeLimit: unknown },
  path: string,
  ctx: WinnabilityCtx,
  err: (p: string, m: string) => void,
): void {
  if (!inEnum(o.type, OBJECTIVES)) return;
  if (o.type === 'eliminate' && typeof o.count === 'number' && o.count > ctx.totalEnemies)
    err(`${path}.count`, `eliminate count ${o.count} exceeds total spawned enemies ${ctx.totalEnemies}`);
  if (o.type === 'collect' && typeof o.count === 'number' && o.count > ctx.coins)
    err(`${path}.count`, `collect count ${o.count} exceeds pickups.coins ${ctx.coins}`);
  if (o.type === 'race' && typeof o.count === 'number' && o.count < 1)
    err(`${path}.count`, 'race requires at least 1 lap');
  if (o.type === 'survive' && typeof o.timeLimit === 'number' && o.timeLimit <= 0)
    err(`${path}.timeLimit`, 'survive requires timeLimit > 0');
  if (o.type === 'boss' && !ctx.hasBrute)
    err(`${path}.type`, 'boss objective requires at least one brute-class enemy');
}

/**
 * Quest-graph policy. All `next`/`choices[].next` refs must name a known
 * stage id, and every stage must be able to reach a terminal stage
 * (one with no successors) — otherwise the campaign can stall forever
 * in a cycle or dead end. Cycles themselves are allowed: a stage that
 * loops back is fine as long as some path still reaches an ending
 * (e.g. "try again" looping to itself with an "move on" exit choice).
 */
function validateStageGraph(
  stages: unknown[],
  idToIndex: Map<string, number>,
  err: (p: string, m: string) => void,
): void {
  const usesRefs = stages.some(
    (s) => isObj(s) && ((Array.isArray(s.next) && s.next.length > 0) || (Array.isArray(s.choices) && s.choices.length > 0)),
  );
  if (!usesRefs) return; // pure linear chain: array order, always winnable

  const resolve = (id: unknown): number | undefined =>
    typeof id === 'string' && id ? idToIndex.get(id) : undefined;

  // 1) every ref must resolve
  stages.forEach((s, i) => {
    if (!isObj(s)) return;
    const p = `objective.stages[${i}]`;
    if (Array.isArray(s.next))
      for (const n of s.next)
        if (typeof n === 'string' && n && resolve(n) === undefined)
          err(`${p}.next`, `unknown stage id "${n}"`);
    if (Array.isArray(s.choices))
      s.choices.forEach((c: unknown, ci: number) => {
        if (isObj(c) && typeof c.next === 'string' && c.next && resolve(c.next) === undefined)
          err(`${p}.choices[${ci}].next`, `unknown stage id "${c.next}"`);
      });
  });

  // 2) every stage must reach a terminal stage (no successors)
  const succ = (i: number): number[] => {
    const s = stages[i];
    if (!isObj(s)) return [];
    if (Array.isArray(s.choices) && s.choices.length > 0)
      return s.choices
        .map((c: unknown) => (isObj(c) ? resolve(c.next) : undefined))
        .filter((x): x is number => x !== undefined);
    if (Array.isArray(s.next))
      return s.next
        .map((n: unknown) => resolve(n))
        .filter((x): x is number => x !== undefined);
    return i + 1 < stages.length ? [i + 1] : [];
  };
  const reachesEnd = (from: number): boolean => {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const s = succ(i);
      if (s.length === 0) return true;
      stack.push(...s);
    }
    return false;
  };
  stages.forEach((s, i) => {
    if (!isObj(s)) return;
    if (!reachesEnd(i)) {
      const id = typeof s.id === 'string' && s.id ? ` "${s.id}"` : '';
      err(`objective.stages[${i}]`, `stage${id} cannot reach any ending (cycle or dead end)`);
    }
  });
}

// top-level GameSpec keys; anything else is reported as a warning, not an error
const TOP_LEVEL_KEYS = ['meta', 'theme', 'world', 'player', 'enemies', 'objective', 'pickups', 'rules', 'audio', 'narrative', 'progression', 'custom'];
const CUSTOM_KEYS = ['biome', 'forge', 'enemyMods', 'weaponMods', 'quality', 'assets', 'characters', 'items', 'legacyOperators', 'profileDamageMult', 'armor', 'runner', 'towerDefense', 'survivor'];

/** Options for validateSpec. */
export interface ValidateSpecOptions {
  /**
   * Enemy kind ids registered via engine.hooks.registerEnemyKind (pass
   * `engine.hooks.enemyKinds.keys()` at engine call sites). An enemy whose
   * kind is in this set passes the kind check; every other kind must be in
   * ENEMY_KINDS. Lets legitimately registered custom kinds validate (R2-M4)
   * without weakening validation for unregistered kinds — a bogus kind that
   * was never registered still fails.
   */
  customEnemyKinds?: Iterable<string>;
  /**
   * Voxel armor set ids registered at runtime via registerVoxelArmorSet
   * (pass `registeredVoxelArmorSetIds()` at engine call sites). A skin or
   * item-skin armor id in this set passes the armor check; every other id
   * must be in VOXEL_ARMOR_SET_IDS. Same pattern as customEnemyKinds.
   */
  customArmorSets?: Iterable<string>;
}

/** Strict structural validation. Returns every problem found. */
export function validateSpec(spec: unknown, opts?: ValidateSpecOptions): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (p: string, m: string) => errors.push(`${p}: ${m}`);
  // registered custom kinds (R2-M4): accepted at the kind check, nothing else
  const customKinds = new Set<string>(opts?.customEnemyKinds ?? []);
  // registered custom voxel armor sets (art-direction pass): accepted at the armor check
  const customArmorSets = new Set<string>(opts?.customArmorSets ?? []);
  const checkArmorId = (v: unknown, path: string) => {
    if (typeof v !== 'string' || !v) return err(path, 'must be a non-empty armor set id');
    if (!(VOXEL_ARMOR_SET_IDS as readonly string[]).includes(v) && !customArmorSets.has(v))
      err(path, `unknown armor set id (built-in: ${VOXEL_ARMOR_SET_IDS.join('|')}, or pass custom ids via customArmorSets)`);
  };
  const checkVisor = (v: unknown, path: string) => {
    if (!isObj(v)) return err(path, 'must be an object');
    if (!isHex(v.color)) err(`${path}.color`, 'must be #rrggbb');
    if (v.intensity !== undefined && !num(v.intensity, 0, 5)) err(`${path}.intensity`, 'must be 0..5');
  };

  if (!isObj(spec)) return { ok: false, errors: ['spec: not an object'], warnings: [] };

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
      if (!num(t.size, 60, 8000)) err('world.terrain.size', 'must be 60..8000');
      if (!num(t.maxHeight, 0, 200)) err('world.terrain.maxHeight', 'must be 0..200');
      if (!num(t.roughness, 0, 1)) err('world.terrain.roughness', 'must be 0..1');
      if (typeof t.water !== 'boolean') err('world.terrain.water', 'must be boolean');
      if (!num(t.waterLevel, -50, 50)) err('world.terrain.waterLevel', 'must be -50..50');
    }
    if (!inEnum(spec.world.boundary, BOUNDARIES)) err('world.boundary', `must be one of ${BOUNDARIES.join('|')}`);
    if (spec.world.portals !== undefined) {
      if (!isObj(spec.world.portals)) err('world.portals', 'must be an object');
      else if (typeof spec.world.portals.enabled !== 'boolean') err('world.portals.enabled', 'must be boolean');
    }
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
    if (!inEnum(e.kind, ENEMY_KINDS) && !(typeof e.kind === 'string' && customKinds.has(e.kind)))
      err(`${p}.kind`, `must be one of ${ENEMY_KINDS.join('|')}` + (customKinds.size ? ` or a registered custom kind (${[...customKinds].sort().join('|')})` : ''));
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

  // winnability — every objective must be completable with what's in the spec.
  // The same rules apply to the legacy objective and to each quest stage.
  const wctx: WinnabilityCtx = {
    totalEnemies: Array.isArray(spec.enemies)
      ? spec.enemies.reduce((n: number, e: unknown) => n + (isObj(e) && typeof e.count === 'number' ? e.count : 0), 0)
      : 0,
    coins: isObj(spec.pickups) && typeof spec.pickups.coins === 'number' ? spec.pickups.coins : 0,
    hasBrute: Array.isArray(spec.enemies) && spec.enemies.some((e: unknown) => isObj(e) && e.kind === 'brute'),
  };
  if (isObj(spec.objective) && inEnum(spec.objective.type, OBJECTIVES)) {
    checkWinnable(spec.objective as unknown as ObjectiveSpec, 'objective', wctx, err);
  }
  if (isObj(spec.objective) && spec.objective.stages !== undefined) {
    const stages = spec.objective.stages;
    if (!Array.isArray(stages) || stages.length === 0) {
      err('objective.stages', 'must be a non-empty array when present');
    } else {
      const idToIndex = new Map<string, number>();
      stages.forEach((s, i) => {
        const p = `objective.stages[${i}]`;
        if (!isObj(s)) return err(p, 'must be an object');
        if (!inEnum(s.type, OBJECTIVES)) err(`${p}.type`, `must be one of ${OBJECTIVES.join('|')}`);
        if (!num(s.count, 0, 10000)) err(`${p}.count`, 'must be 0..10000');
        if (!num(s.timeLimit, 0, 86400)) err(`${p}.timeLimit`, 'must be 0..86400');
        if (typeof s.description !== 'string') err(`${p}.description`, 'must be a string');
        if (s.id !== undefined) {
          if (typeof s.id !== 'string' || !s.id) err(`${p}.id`, 'must be a non-empty string');
          else if (idToIndex.has(s.id)) err(`${p}.id`, `duplicate stage id "${s.id}"`);
          else idToIndex.set(s.id, i);
        }
        if (s.next !== undefined) {
          if (!Array.isArray(s.next) || s.next.some((n) => typeof n !== 'string' || !n))
            err(`${p}.next`, 'must be an array of stage ids');
          else if (s.next.length > 1 && !(Array.isArray(s.choices) && s.choices.length > 0))
            warnings.push(`${p}.next: multiple successors without choices — the first wins`);
        }
        if (s.choices !== undefined) {
          if (!Array.isArray(s.choices) || s.choices.length === 0)
            err(`${p}.choices`, 'must be a non-empty array when present');
          else s.choices.forEach((c, ci) => {
            const cp = `${p}.choices[${ci}]`;
            if (!isObj(c)) return err(cp, 'must be an object');
            if (typeof c.label !== 'string' || !c.label) err(`${cp}.label`, 'must be a non-empty string');
            if (typeof c.next !== 'string' || !c.next) err(`${cp}.next`, 'must be a stage id');
          });
        }
        if (s.winText !== undefined && typeof s.winText !== 'string')
          err(`${p}.winText`, 'must be a string');
        checkWinnable(s as unknown as ObjectiveStage, p, wctx, err);
      });
      validateStageGraph(stages, idToIndex, err);
    }
  }
  if (isObj(spec.meta) && spec.meta.genre === 'platformer' && isObj(spec.player) && typeof spec.player.jump === 'number' && spec.player.jump <= 0)
    err('player.jump', 'platformer requires player.jump > 0');

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

  // narrative (optional; intro card + win/lose text for the campaign layer)
  const nar = (spec as Record<string, unknown>).narrative;
  if (nar !== undefined) {
    if (!isObj(nar)) err('narrative', 'must be an object');
    else for (const k of ['premise', 'winText', 'loseText'] as const) {
      if (typeof nar[k] !== 'string' || !nar[k].trim()) err(`narrative.${k}`, 'must be a non-empty string');
    }
  }

  // progression (optional; XP/level config for the campaign layer)
  const prg = (spec as Record<string, unknown>).progression;
  if (prg !== undefined) {
    if (!isObj(prg)) err('progression', 'must be an object');
    else {
      if (typeof prg.enabled !== 'boolean') err('progression.enabled', 'must be boolean');
      const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
      if (!pos(prg.xpPerKill)) err('progression.xpPerKill', 'must be a positive number');
      if (!pos(prg.xpPerPickup)) err('progression.xpPerPickup', 'must be a positive number');
      if (prg.xpPerCraft !== undefined && !pos(prg.xpPerCraft))
        err('progression.xpPerCraft', 'must be a positive number');
    }
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
          if (b.biomeId !== undefined && !inEnum(b.biomeId, BIOME_IDS)) err('custom.biome.biomeId', `must be one of ${BIOME_IDS.join('|')}`);
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
      if (c.tier !== undefined && !inEnum(c.tier, PERF_TIER_IDS)) err('custom.tier', `must be one of ${PERF_TIER_IDS.join('|')}`);
      if (c.profileDamageMult !== undefined && !(typeof c.profileDamageMult === 'number' && isFinite(c.profileDamageMult) && c.profileDamageMult > 0))
        err('custom.profileDamageMult', 'must be a positive number');
      if (c.legacyOperators !== undefined) {
        if (!Array.isArray(c.legacyOperators) || !c.legacyOperators.every((id) => Number.isInteger(id) && (id as number) >= 1 && (id as number) <= 72))
          err('custom.legacyOperators', 'must be an array of operator ids 1..72');
      }
      const as = c.assets;
      if (as !== undefined) {
        if (!isObj(as)) err('custom.assets', 'must be an object');
        else if ('enabled' in as) {
          // legacy AssetPacks shape
          if (typeof as.enabled !== 'boolean') err('custom.assets.enabled', 'must be boolean');
          if (as.packs !== undefined) {
            if (!isObj(as.packs)) err('custom.assets.packs', 'must be an object');
            else for (const [k, u] of Object.entries(as.packs)) {
              if (!isGlbUrl(u))
                err(`custom.assets.packs.${k}`, 'must be an https URL ending in .glb/.gltf');
            }
          }
        } else {
          // reskin override-record shape: asset id → AssetOverride
          const isHex = (s: unknown): s is string =>
            typeof s === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
          for (const [id, o] of Object.entries(as)) {
            const p = `custom.assets.${id}`;
            if (!isObj(o)) { err(p, 'must be an override object'); continue; }
            if (o.color !== undefined && !isHex(o.color)) err(`${p}.color`, 'must be a CSS hex color');
            if (o.emissive !== undefined && !isHex(o.emissive)) err(`${p}.emissive`, 'must be a CSS hex color');
            if (o.emissiveIntensity !== undefined && typeof o.emissiveIntensity !== 'number')
              err(`${p}.emissiveIntensity`, 'must be a number');
            if (o.scale !== undefined && typeof o.scale !== 'number') err(`${p}.scale`, 'must be a number');
            if (o.visible !== undefined && typeof o.visible !== 'boolean') err(`${p}.visible`, 'must be boolean');
          }
        }
      }
      // armor — opt-in seeded auto-armor (worker E). Visual only.
      const ar = c.armor;
      if (ar !== undefined) {
        if (!isObj(ar)) err('custom.armor', 'must be an object');
        else if (ar.auto !== undefined && typeof ar.auto !== 'boolean')
          err('custom.armor.auto', 'must be boolean');
      }
      // characters — skins + GLB import slots (workstream D+E). Visual only.
      const ch = c.characters;
      if (ch !== undefined) {
        if (!isObj(ch)) err('custom.characters', 'must be an object');
        else {
          const validateSlot = (s: unknown, path: string) => {
            if (!isObj(s)) return err(path, 'must be an object');
            if (s.skin !== undefined && (typeof s.skin !== 'string' || !s.skin))
              err(`${path}.skin`, 'must be a non-empty skin id');
            if (s.model !== undefined && !isGlbUrl(s.model))
              err(`${path}.model`, 'must be an https URL ending in .glb/.gltf');
            if (s.boneMap !== undefined) {
              if (!isObj(s.boneMap)) err(`${path}.boneMap`, 'must be an object');
              else for (const [k, v] of Object.entries(s.boneMap)) {
                if (!(CHARACTER_PIVOTS as readonly string[]).includes(k))
                  err(`${path}.boneMap.${k}`, `unknown pivot (${CHARACTER_PIVOTS.join('|')})`);
                else if (typeof v !== 'string' || !v)
                  err(`${path}.boneMap.${k}`, 'must be a non-empty node name');
              }
            }
          };
          if (ch.skins !== undefined) {
            if (!isObj(ch.skins)) err('custom.characters.skins', 'must be an object');
            else for (const [id, sd] of Object.entries(ch.skins)) {
              const p = `custom.characters.skins.${id}`;
              if (!isObj(sd)) { err(p, 'must be an object'); continue; }
              if (typeof sd.name !== 'string' || !sd.name) err(`${p}.name`, 'must be a non-empty string');
              if (sd.palette !== undefined) {
                if (!isObj(sd.palette)) err(`${p}.palette`, 'must be an object');
                else for (const [k, v] of Object.entries(sd.palette)) {
                  if (!['skin', 'shirt', 'pants', 'accent'].includes(k))
                    err(`${p}.palette.${k}`, 'unknown role (skin|shirt|pants|accent)');
                  else if (!isHex(v)) err(`${p}.palette.${k}`, 'must be #rrggbb');
                }
              }
              if (sd.emissive !== undefined) {
                if (!isObj(sd.emissive)) err(`${p}.emissive`, 'must be an object');
                else {
                  if (!isHex(sd.emissive.color)) err(`${p}.emissive.color`, 'must be #rrggbb');
                  if (!num(sd.emissive.intensity, 0, 5)) err(`${p}.emissive.intensity`, 'must be 0..5');
                }
              }
              if (sd.roughness !== undefined && !num(sd.roughness, 0, 1)) err(`${p}.roughness`, 'must be 0..1');
              if (sd.metalness !== undefined && !num(sd.metalness, 0, 1)) err(`${p}.metalness`, 'must be 0..1');
              if (sd.texture !== undefined) {
                if (!isObj(sd.texture)) err(`${p}.texture`, 'must be an object');
                else if ('url' in sd.texture) {
                  const u = (sd.texture as Record<string, unknown>).url;
                  if (typeof u !== 'string' || !/^https:\/\/[^?#]+\.(png|jpe?g|webp)(\?.*)?$/i.test(u))
                    err(`${p}.texture.url`, 'must be an https URL ending in .png/.jpg/.jpeg/.webp');
                } else if ('pattern' in sd.texture) {
                  if (!inEnum((sd.texture as Record<string, unknown>).pattern, SKIN_TEXTURE_PATTERNS))
                    err(`${p}.texture.pattern`, `must be one of ${SKIN_TEXTURE_PATTERNS.join('|')}`);
                } else err(`${p}.texture`, 'must be { url } or { pattern }');
              }
              if (sd.textureRoles !== undefined) {
                const okRoles = Array.isArray(sd.textureRoles) &&
                  sd.textureRoles.every((r) => inEnum(r, SKIN_TEXTURE_ROLES));
                if (!okRoles) err(`${p}.textureRoles`, `must be an array of ${SKIN_TEXTURE_ROLES.join('|')}`);
              }
              if (sd.armor !== undefined) checkArmorId(sd.armor, `${p}.armor`);
              if (sd.visor !== undefined) checkVisor(sd.visor, `${p}.visor`);
            }
          }
          if (ch.player !== undefined) validateSlot(ch.player, 'custom.characters.player');
          if (ch.enemies !== undefined) {
            if (!isObj(ch.enemies)) err('custom.characters.enemies', 'must be an object');
            else for (const [k, s] of Object.entries(ch.enemies)) validateSlot(s, `custom.characters.enemies.${k}`);
          }
        }
      }
      // items — item tables, item skins, loot/chest placement (inventory wave)
      const it = c.items;
      if (it !== undefined) {
        if (!isObj(it)) err('custom.items', 'must be an object');
        else {
          const defIds = new Set<string>();
          const validateItemDef = (d: unknown, path: string) => {
            if (!isObj(d)) return err(path, 'must be an object');
            if (typeof d.name !== 'string' || !d.name) err(`${path}.name`, 'must be a non-empty string');
            else if (d.name.length > 48) err(`${path}.name`, 'must be <= 48 chars');
            if (!inEnum(d.type, ITEM_TYPES)) err(`${path}.type`, `must be one of ${ITEM_TYPES.join('|')}`);
            if (d.slot !== undefined && !inEnum(d.slot, EQUIP_SLOTS))
              err(`${path}.slot`, `must be one of ${EQUIP_SLOTS.join('|')}`);
            if ((d.type === 'weapon' || d.type === 'armor') && d.slot === undefined)
              err(`${path}.slot`, 'required for weapon/armor items');
            if (d.rarity !== undefined && !inEnum(d.rarity, ITEM_RARITIES))
              err(`${path}.rarity`, `must be one of ${ITEM_RARITIES.join('|')}`);
            if (d.stats !== undefined) {
              if (!isObj(d.stats)) err(`${path}.stats`, 'must be an object');
              else for (const [k, v] of Object.entries(d.stats)) {
                if (!(ITEM_STAT_KEYS as readonly string[]).includes(k))
                  err(`${path}.stats.${k}`, `unknown stat (${ITEM_STAT_KEYS.join('|')})`);
                else if (!num(v, -1000, 10000)) err(`${path}.stats.${k}`, 'must be a finite number -1000..10000');
              }
            }
            if (d.behavior !== undefined) {
              if (!isObj(d.behavior)) err(`${path}.behavior`, 'must be an object');
              else {
                if (!['heal', 'restore', 'buff'].includes(d.behavior.effect as string))
                  err(`${path}.behavior.effect`, 'must be heal|restore|buff');
                if (d.behavior.amount !== undefined && !num(d.behavior.amount, 0, 100000))
                  err(`${path}.behavior.amount`, 'must be a number 0..100000');
                if (d.behavior.duration !== undefined && !num(d.behavior.duration, 0, 3600))
                  err(`${path}.behavior.duration`, 'must be a number 0..3600');
              }
            }
            if (d.skin !== undefined && (typeof d.skin !== 'string' || !d.skin))
              err(`${path}.skin`, 'must be a non-empty item-skin id');
            if (d.model !== undefined && !isGlbUrl(d.model))
              err(`${path}.model`, 'must be an https URL ending in .glb/.gltf');
            if (d.stack !== undefined && !(Number.isInteger(d.stack) && (d.stack as number) >= 1 && (d.stack as number) <= 999))
              err(`${path}.stack`, 'must be an integer 1..999');
            if (d.value !== undefined && !num(d.value, 0, 1000000000))
              err(`${path}.value`, 'must be a number >= 0');
            if (d.description !== undefined) {
              if (typeof d.description !== 'string') err(`${path}.description`, 'must be a string');
              else if (d.description.length > 280) err(`${path}.description`, 'must be <= 280 chars');
            }
          };
          if (it.defs !== undefined) {
            if (!isObj(it.defs)) err('custom.items.defs', 'must be an object');
            else for (const [id, d] of Object.entries(it.defs)) {
              defIds.add(id);
              validateItemDef(d, `custom.items.defs.${id}`);
            }
          }
          const knownItem = (id: unknown, path: string) => {
            if (typeof id !== 'string' || !id) err(path, 'must be a non-empty item id');
            else if (!defIds.has(id)) err(path, `unknown item id "${id}" (not in custom.items.defs)`);
          };
          const isPos3 = (v: unknown): v is [number, number, number] =>
            Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
          if (it.skins !== undefined) {
            if (!isObj(it.skins)) err('custom.items.skins', 'must be an object');
            else for (const [id, sd] of Object.entries(it.skins)) {
              const p = `custom.items.skins.${id}`;
              if (!isObj(sd)) { err(p, 'must be an object'); continue; }
              if (typeof sd.name !== 'string' || !sd.name) err(`${p}.name`, 'must be a non-empty string');
              if (sd.palette !== undefined) {
                if (!isObj(sd.palette)) err(`${p}.palette`, 'must be an object');
                else for (const [k, v] of Object.entries(sd.palette)) {
                  if (!(ITEM_SKIN_ROLES as readonly string[]).includes(k))
                    err(`${p}.palette.${k}`, `unknown role (${ITEM_SKIN_ROLES.join('|')})`);
                  else if (!isHex(v)) err(`${p}.palette.${k}`, 'must be #rrggbb');
                }
              }
              if (sd.emissive !== undefined) {
                if (!isObj(sd.emissive)) err(`${p}.emissive`, 'must be an object');
                else {
                  if (!isHex(sd.emissive.color)) err(`${p}.emissive.color`, 'must be #rrggbb');
                  if (!num(sd.emissive.intensity, 0, 5)) err(`${p}.emissive.intensity`, 'must be 0..5');
                }
              }
              if (sd.roughness !== undefined && !num(sd.roughness, 0, 1)) err(`${p}.roughness`, 'must be 0..1');
              if (sd.metalness !== undefined && !num(sd.metalness, 0, 1)) err(`${p}.metalness`, 'must be 0..1');
              if (sd.texture !== undefined) {
                if (!isObj(sd.texture)) err(`${p}.texture`, 'must be an object');
                else if ('url' in sd.texture) {
                  const u = (sd.texture as Record<string, unknown>).url;
                  if (typeof u !== 'string' || !/^https:\/\/[^?#]+\.(png|jpe?g|webp)(\?.*)?$/i.test(u))
                    err(`${p}.texture.url`, 'must be an https URL ending in .png/.jpg/.jpeg/.webp');
                } else if ('pattern' in sd.texture) {
                  if (!inEnum((sd.texture as Record<string, unknown>).pattern, SKIN_TEXTURE_PATTERNS))
                    err(`${p}.texture.pattern`, `must be one of ${SKIN_TEXTURE_PATTERNS.join('|')}`);
                } else err(`${p}.texture`, 'must be { url } or { pattern }');
              }
              if (sd.textureRoles !== undefined) {
                const ok = Array.isArray(sd.textureRoles) &&
                  sd.textureRoles.every((r) => inEnum(r, ITEM_SKIN_ROLES));
                if (!ok) err(`${p}.textureRoles`, `must be an array of ${ITEM_SKIN_ROLES.join('|')}`);
              }
              if (sd.armor !== undefined) checkArmorId(sd.armor, `${p}.armor`);
            }
          }
          if (it.loot !== undefined) {
            if (!Array.isArray(it.loot)) err('custom.items.loot', 'must be an array');
            else it.loot.forEach((s: unknown, i: number) => {
              const p = `custom.items.loot[${i}]`;
              if (!isObj(s)) return err(p, 'must be an object');
              knownItem(s.item, `${p}.item`);
              if (!isPos3(s.pos)) err(`${p}.pos`, 'must be [x, y, z] numbers');
              if (s.count !== undefined && !(Number.isInteger(s.count) && (s.count as number) >= 1))
                err(`${p}.count`, 'must be an integer >= 1');
            });
          }
          if (it.chests !== undefined) {
            if (!Array.isArray(it.chests)) err('custom.items.chests', 'must be an array');
            else it.chests.forEach((s: unknown, i: number) => {
              const p = `custom.items.chests[${i}]`;
              if (!isObj(s)) return err(p, 'must be an object');
              if (!isPos3(s.pos)) err(`${p}.pos`, 'must be [x, y, z] numbers');
              if (!Array.isArray(s.loot) || !s.loot.length) err(`${p}.loot`, 'must be a non-empty array of item ids');
              else s.loot.forEach((id: unknown, j: number) => knownItem(id, `${p}.loot[${j}]`));
              if (s.locked !== undefined && typeof s.locked !== 'boolean') err(`${p}.locked`, 'must be boolean');
              if (s.skin !== undefined && (typeof s.skin !== 'string' || !s.skin))
                err(`${p}.skin`, 'must be a non-empty item-skin id');
            });
          }
          if (it.starting !== undefined) {
            if (!Array.isArray(it.starting)) err('custom.items.starting', 'must be an array');
            else it.starting.forEach((id: unknown, i: number) => knownItem(id, `custom.items.starting[${i}]`));
          }
        }
      }
      // quests — curated-quest-rewards wave: per-quest reward overrides.
      // Slug membership is checked against the curated tables
      // (engine/game/questRewards QUEST_REWARD_SLUGS); structural checks
      // here keep schema.ts free of engine imports.
      const qu = c.quests;
      if (qu !== undefined) {
        if (!isObj(qu)) err('custom.quests', 'must be an object');
        else {
          if (qu.enabled !== undefined && typeof qu.enabled !== 'boolean')
            err('custom.quests.enabled', 'must be boolean');
          if (qu.questCount !== undefined && !(Number.isInteger(qu.questCount) && (qu.questCount as number) >= 1 && (qu.questCount as number) <= 8))
            err('custom.quests.questCount', 'must be an integer 1..8');
          if (qu.sideQuestCount !== undefined && !(Number.isInteger(qu.sideQuestCount) && (qu.sideQuestCount as number) >= 1 && (qu.sideQuestCount as number) <= 12))
            err('custom.quests.sideQuestCount', 'must be an integer 1..12');
          if (qu.rewardOverrides !== undefined) {
            if (!isObj(qu.rewardOverrides)) err('custom.quests.rewardOverrides', 'must be an object');
            else for (const [slug, ov] of Object.entries(qu.rewardOverrides)) {
              const p = `custom.quests.rewardOverrides.${slug}`;
              if (!isObj(ov)) { err(p, 'must be an object'); continue; }
              if (ov.xp !== undefined && !(typeof ov.xp === 'number' && Number.isFinite(ov.xp) && (ov.xp as number) >= 0))
                err(`${p}.xp`, 'must be a non-negative number');
              if (ov.items !== undefined) {
                if (!Array.isArray(ov.items)) err(`${p}.items`, 'must be an array');
                else (ov.items as unknown[]).forEach((it2: unknown, i: number) => {
                  const q2 = `${p}.items[${i}]`;
                  // Structural only (not knownItem): gear/material ids are
                  // merged into custom.items.defs at blueprint boot
                  // (ensureLootItemDefs / ensureCraftingItemDefs), after
                  // validation runs. The pool builder merges only known
                  // slugs; QuestManager skips ids without a def at turn-in.
                  const rid = (it2 as Record<string, unknown>)?.id;
                  if (typeof rid !== 'string' || !rid) err(`${q2}.id`, 'must be a non-empty item id');
                  if (!(Number.isInteger((it2 as Record<string, unknown>)?.count) && ((it2 as Record<string, unknown>).count as number) >= 1))
                    err(`${q2}.count`, 'must be an integer >= 1');
                });
              }
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
    if (spec.meta.genre === 'survivor' && spec.player.camera !== 'top-down')
      err('player.camera', 'survivor requires top-down camera');
    if (spec.meta.genre === 'tower-defense' && spec.player.camera !== 'top-down')
      err('player.camera', 'tower-defense requires top-down camera');
    if (spec.meta.genre === 'endless-runner' && spec.player.camera !== 'chase')
      err('player.camera', 'endless-runner requires chase camera');
    if (spec.meta.genre === 'endless-runner' && spec.player.type !== 'humanoid')
      err('player.type', 'endless-runner requires player.type = humanoid');
  }

  // unknown keys are ignored, never errors — but reported so typos don't vanish silently
  // unknown keys are warnings, not errors
  for (const k of Object.keys(spec)) {
    if (!TOP_LEVEL_KEYS.includes(k)) warnings.push(`unknown top-level key "${k}" ignored`);
  }
  const customLayer: unknown = (spec as Record<string, unknown>).custom;
  if (isObj(customLayer)) {
    for (const k of Object.keys(customLayer)) {
      if (!CUSTOM_KEYS.includes(k)) warnings.push(`unknown custom key "${k}" ignored`);
    }
  }

  // prompt-fidelity wave: score the spec against its own prompt (meta.description).
  // intent.ts imports only TYPES from @spec, so this static import creates no
  // runtime cycle. The scoring is pure and never affects ok/errors/warnings.
  const fulfillment = scoreSpecFulfillment(spec);
  return { ok: errors.length === 0, errors, warnings, ...(fulfillment ? { fulfillment } : {}) };
}

/** Deep-merge `partial` over defaults, then validate. Throws with full error list if invalid. */
export function normalizeSpec(partial: unknown): GameSpec {
  const base = defaultSpec(Number(isObj(partial) && isObj(partial.meta) && Number.isInteger(partial.meta.seed) ? partial.meta.seed : 1));
  // deep-clone so the caller's input is never aliased into (or mutated by) the result
  const clone = (v: any): any => {
    if (Array.isArray(v)) return v.map(clone);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
    return v;
  };
  const merge = (dst: any, src: any): any => {
    if (!isObj(src)) return dst;
    for (const [k, v] of Object.entries(src)) {
      if (isObj(v) && isObj(dst[k])) dst[k] = merge(dst[k], v);
      else if (v !== undefined) dst[k] = clone(v);
    }
    return dst;
  };
  const merged = merge(base, partial) as GameSpec;
  // quest graph: every stage needs a stable id for next/choices refs.
  // Assign deterministic positional ids only where the author left none.
  const stages = (merged as GameSpec).objective?.stages;
  if (Array.isArray(stages)) {
    stages.forEach((s, i) => {
      if (s && typeof (s as ObjectiveStage).id !== 'string') (s as ObjectiveStage).id = `stage-${i}`;
    });
  }
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
