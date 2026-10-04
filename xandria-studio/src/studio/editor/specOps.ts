/**
 * specOps — pure, DOM-free helpers for the Studio editor panel.
 *
 * Everything here mutates a working GameSpec copy and re-validates with the
 * existing validator. The panel (editorPanel.ts) owns the DOM; these are the
 * operations it calls, and they are unit-tested in tests/editor.test.ts.
 *
 * Design notes:
 * - The engine has no `engine/game/Assets` module and no per-asset color /
 *   scale / visible override surface (enemy colors are hardcoded in EnemyAI,
 *   fog density is derived from theme.weather, player damage comes from the
 *   weapon table). The ASSET_GROUPS registry below therefore maps every
 *   control to a REAL engine-honored spec path (custom.forge, custom.enemyMods,
 *   custom.biome, custom.assets, world.scatter, ...). Nothing here writes a
 *   key the validator rejects or the engine silently drops.
 */
import {
  validateSpec,
  type GameSpec,
  type ObjectiveStage,
  type ObjectiveType,
  type EnemyKind,
  type EnemySpec,
  type Palette,
  type Environment,
  type Weather,
  ENVIRONMENTS,
  OBJECTIVES,
  ENEMY_KINDS,
} from '@spec';
import { ASSET_IDS, type AssetOverride } from '../../engine/game/Assets';

// ---------------------------------------------------------------------------
// generic path helpers
// ---------------------------------------------------------------------------

export type Path = (string | number)[];

export function cloneSpec(spec: GameSpec): GameSpec {
  return JSON.parse(JSON.stringify(spec)) as GameSpec;
}

/** Read a nested value; undefined when any hop is missing. */
export function getAtPath(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Write a nested value, creating intermediate objects/arrays as needed. */
export function setAtPath(obj: Record<string, unknown>, path: Path, value: unknown): void {
  let cur: Record<string | number, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const next = cur[k];
    if (next === null || typeof next !== 'object') {
      cur[k] = typeof path[i + 1] === 'number' ? [] : {};
    }
    cur = cur[k] as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Ensure spec.custom exists and return it. */
export function ensureCustom(spec: GameSpec): NonNullable<GameSpec['custom']> {
  if (!spec.custom) spec.custom = {};
  return spec.custom;
}

export interface EditValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate a working spec copy; the editor gates Play on `ok`. */
export function validateEditable(spec: GameSpec): EditValidation {
  const r = validateSpec(spec);
  return { ok: r.ok, errors: r.errors, warnings: r.warnings };
}

export function randomSeed(): number {
  return (Math.random() * 0x7fffffff) | 0;
}

// ---------------------------------------------------------------------------
// story: quest stages
// ---------------------------------------------------------------------------

const STAGE_DEFAULTS: Record<string, Partial<ObjectiveStage>> = {
  'fps-arena': { type: 'eliminate', count: 8, timeLimit: 0 },
  'third-person-action': { type: 'collect', count: 6, timeLimit: 0 },
  platformer: { type: 'collect', count: 8, timeLimit: 0 },
  'top-down-shooter': { type: 'survive', count: 0, timeLimit: 45 },
  racing: { type: 'race', count: 2, timeLimit: 0 },
};

export function getStages(spec: GameSpec): ObjectiveStage[] {
  return spec.objective.stages ?? [];
}

export function inStageMode(spec: GameSpec): boolean {
  return Array.isArray(spec.objective.stages) && spec.objective.stages.length > 0;
}

function defaultStageFor(spec: GameSpec): ObjectiveStage {
  const d = STAGE_DEFAULTS[spec.meta.genre] ?? { type: 'eliminate', count: 5, timeLimit: 0 };
  const type = d.type as ObjectiveType;
  return {
    type,
    count: d.count ?? 5,
    timeLimit: d.timeLimit ?? 0,
    description: defaultStageDescription(type),
  };
}

function defaultStageDescription(type: ObjectiveType): string {
  switch (type) {
    case 'eliminate': return 'Defeat the hostiles';
    case 'collect': return 'Gather what you need';
    case 'reach': return 'Reach the objective marker';
    case 'survive': return 'Survive the onslaught';
    case 'boss': return 'Slay the boss';
    case 'race': return 'Win the race';
  }
}

/** Append a stage (converts a legacy single objective into a 1-chapter chain first). */
export function addStage(spec: GameSpec): ObjectiveStage {
  if (!Array.isArray(spec.objective.stages)) {
    // seed the chain from the legacy objective so nothing is lost
    const o = spec.objective;
    spec.objective.stages = [{
      type: o.type, count: o.count, timeLimit: o.timeLimit,
      description: o.description || defaultStageDescription(o.type),
    }];
  }
  const stage = defaultStageFor(spec);
  spec.objective.stages.push(stage);
  return stage;
}

export function removeStage(spec: GameSpec, index: number): void {
  const stages = spec.objective.stages;
  if (!Array.isArray(stages) || index < 0 || index >= stages.length) return;
  stages.splice(index, 1);
  if (stages.length === 0) spec.objective.stages = undefined; // back to legacy mode
}

export function moveStage(spec: GameSpec, index: number, dir: -1 | 1): void {
  const stages = spec.objective.stages;
  if (!Array.isArray(stages)) return;
  const j = index + dir;
  if (index < 0 || index >= stages.length || j < 0 || j >= stages.length) return;
  [stages[index], stages[j]] = [stages[j], stages[index]];
}

export function setStageField(
  spec: GameSpec, index: number,
  field: 'type' | 'count' | 'timeLimit' | 'description', value: string | number,
): void {
  const s = spec.objective.stages?.[index];
  if (!s) return;
  if (field === 'type' && typeof value === 'string' && (OBJECTIVES as readonly string[]).includes(value)) {
    s.type = value as ObjectiveType;
  } else if (field === 'count' && typeof value === 'number') {
    s.count = Math.max(0, Math.round(value));
  } else if (field === 'timeLimit' && typeof value === 'number') {
    s.timeLimit = Math.max(0, Math.round(value));
  } else if (field === 'description' && typeof value === 'string') {
    s.description = value;
  }
}

// ---------------------------------------------------------------------------
// enemies
// ---------------------------------------------------------------------------

export const ENEMY_DEFAULTS: Record<EnemyKind, Omit<EnemySpec, 'kind'>> = {
  walker: { count: 8, health: 30, speed: 4, damage: 10, weapon: 'melee' },
  drone: { count: 6, health: 20, speed: 6, damage: 8, weapon: 'blaster' },
  turret: { count: 3, health: 50, speed: 0, damage: 12, weapon: 'blaster' },
  brute: { count: 1, health: 300, speed: 3, damage: 25, weapon: 'melee' },
  flyer: { count: 5, health: 25, speed: 7, damage: 8, weapon: 'blaster' },
  racer: { count: 4, health: 40, speed: 9, damage: 5, weapon: 'none' },
};

export function enemyKindEnabled(spec: GameSpec, kind: EnemyKind): boolean {
  return spec.enemies.some((e) => e.kind === kind);
}

/** Toggle an enemy kind: add with defaults, or remove all entries of that kind. */
export function setEnemyKindEnabled(spec: GameSpec, kind: EnemyKind, enabled: boolean): void {
  const has = enemyKindEnabled(spec, kind);
  if (enabled && !has) {
    spec.enemies.push({ kind, ...ENEMY_DEFAULTS[kind] });
  } else if (!enabled && has) {
    spec.enemies = spec.enemies.filter((e) => e.kind !== kind);
  }
}

export interface EnemyMultipliers {
  count: number;
  hp: number;
  speed: number;
}

/**
 * Apply multipliers against a base snapshot (taken when the spec was loaded).
 * Pure: does not compound on repeated calls with the same base.
 */
export function applyEnemyMultipliers(spec: GameSpec, base: EnemySpec[], mult: EnemyMultipliers): void {
  const byKind = new Map(base.map((e) => [e.kind, e]));
  for (const e of spec.enemies) {
    const b = byKind.get(e.kind);
    if (!b) continue;
    e.count = Math.max(0, Math.round(b.count * mult.count));
    e.health = Math.max(1, Math.round(b.health * mult.hp));
    e.speed = Math.max(0, Math.round(b.speed * mult.speed * 10) / 10);
  }
}

export function snapshotEnemies(spec: GameSpec): EnemySpec[] {
  return JSON.parse(JSON.stringify(spec.enemies)) as EnemySpec[];
}

// ---------------------------------------------------------------------------
// pickups + progression
// ---------------------------------------------------------------------------

export type PickupKey = 'coins' | 'health' | 'ammo' | 'powerups';

export const PICKUP_DEFAULTS: Record<PickupKey, number> = {
  coins: 12, health: 3, ammo: 4, powerups: 2,
};

export const PICKUP_KEYS: PickupKey[] = ['coins', 'health', 'ammo', 'powerups'];

export function setPickupEnabled(spec: GameSpec, key: PickupKey, enabled: boolean): void {
  spec.pickups[key] = enabled ? PICKUP_DEFAULTS[key] : 0;
}

export function ensureProgression(spec: GameSpec): NonNullable<GameSpec['progression']> {
  if (!spec.progression) spec.progression = { enabled: true, xpPerKill: 20, xpPerPickup: 5 };
  return spec.progression;
}

// ---------------------------------------------------------------------------
// world: palettes, fog, mood
// ---------------------------------------------------------------------------

/** The generator's environment palette table (src/generator/generate.ts ENV_PALETTE),
 *  duplicated here as data so the editor can offer "apply environment look" swatches
 *  without importing generator internals. */
export const PALETTE_SWATCHES: Record<Environment, Palette> = {
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

export function applyPaletteSwatch(spec: GameSpec, env: Environment): void {
  spec.theme.palette = { ...PALETTE_SWATCHES[env] };
}

/**
 * Fog density is engine-derived from theme.weather (Sky.ts):
 * fog → 0.012, storm/ash → 0.007, otherwise 0.0035. The editor slider maps
 * onto those real tiers so the control always does what Play shows.
 */
export const FOG_TIERS: { max: number; weather: Weather; label: string }[] = [
  { max: 33, weather: 'clear', label: 'light' },
  { max: 66, weather: 'storm', label: 'medium' },
  { max: 100, weather: 'fog', label: 'heavy' },
];

export function fogSliderToWeather(v: number): Weather {
  return FOG_TIERS.find((t) => v <= t.max)?.weather ?? 'fog';
}

export function weatherToFogSlider(w: Weather): number {
  if (w === 'fog') return 100;
  if (w === 'storm' || w === 'ash') return 55;
  return 15;
}

export function fogTierLabel(w: Weather): string {
  return FOG_TIERS.find((t) => t.weather === w)?.label ?? (w === 'ash' ? 'medium' : 'light');
}

// ---------------------------------------------------------------------------
// assets: studio-side registry of engine-honored customization points
// ---------------------------------------------------------------------------

export type AssetControlKind = 'color' | 'slider' | 'select' | 'toggle';

export interface AssetControl {
  kind: AssetControlKind;
  label: string;
  /** spec path, e.g. ['custom','forge','bulk'] */
  path: Path;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
}

export interface AssetDef {
  id: string;
  label: string;
  hint?: string;
  controls: AssetControl[];
}

export interface AssetGroup {
  namespace: string;
  label: string;
  assets: AssetDef[];
}

/**
 * The studio-side equivalent of an asset registry: every control maps to a
 * spec path the engine actually honors (see file header for why this is
 * studio-local rather than imported from src/engine).
 */
export const ASSET_GROUPS: AssetGroup[] = [
  {
    namespace: 'player',
    label: 'Player',
    assets: [
      {
        id: 'player.avatar', label: 'Avatar body', hint: 'Procedural character forge',
        controls: [
          { kind: 'select', label: 'Head style', path: ['custom', 'forge', 'headStyle'], options: ['visor', 'horned', 'helmet', 'mohawk', 'hood', 'antenna', 'crest'] },
          { kind: 'select', label: 'Armor', path: ['custom', 'forge', 'armor'], options: ['none', 'pads', 'plate', 'bandolier'] },
          { kind: 'slider', label: 'Bulk', path: ['custom', 'forge', 'bulk'], min: 0.7, max: 1.9, step: 0.05 },
          { kind: 'slider', label: 'Height', path: ['custom', 'forge', 'height'], min: 0.85, max: 1.3, step: 0.05 },
        ],
      },
      {
        id: 'player.weapon-fx', label: 'Weapon FX',
        controls: [
          { kind: 'color', label: 'Beam / projectile color', path: ['custom', 'weaponMods', 'beamColor'] },
          { kind: 'slider', label: 'Projectile speed', path: ['custom', 'weaponMods', 'projectileSpeed'], min: 5, max: 200, step: 1 },
          { kind: 'slider', label: 'Spread', path: ['custom', 'weaponMods', 'spread'], min: 0, max: 0.5, step: 0.01 },
        ],
      },
    ],
  },
  {
    namespace: 'enemy',
    label: 'Enemies',
    assets: [
      {
        id: 'enemy.swarm', label: 'All enemies', hint: 'Global modifiers',
        controls: [
          { kind: 'slider', label: 'Size scale', path: ['custom', 'enemyMods', 'size'], min: 0.5, max: 2.5, step: 0.1 },
          { kind: 'color', label: 'Glow color', path: ['custom', 'enemyMods', 'glow'] },
          { kind: 'slider', label: 'Speed', path: ['custom', 'enemyMods', 'speed'], min: 0.3, max: 3, step: 0.1 },
          { kind: 'slider', label: 'Aggression', path: ['custom', 'enemyMods', 'aggression'], min: 0, max: 3, step: 0.1 },
        ],
      },
    ],
  },
  {
    namespace: 'world',
    label: 'World',
    assets: [
      {
        id: 'world.terrain', label: 'Terrain', hint: 'Biome overrides',
        controls: [
          { kind: 'slider', label: 'Noise frequency', path: ['custom', 'biome', 'terrainFrequency'], min: 0.3, max: 3, step: 0.1 },
          { kind: 'slider', label: 'Height scale', path: ['custom', 'biome', 'heightScale'], min: 0, max: 2.5, step: 0.1 },
          { kind: 'slider', label: 'Water level', path: ['custom', 'biome', 'waterBias'], min: -5, max: 8, step: 0.5 },
        ],
      },
      {
        id: 'world.scatter', label: 'Scatter', hint: 'Props & vegetation',
        controls: [
          { kind: 'toggle', label: 'Trees', path: ['world', 'scatter', 'trees'] },
          { kind: 'toggle', label: 'Rocks', path: ['world', 'scatter', 'rocks'] },
          { kind: 'toggle', label: 'Crystals', path: ['world', 'scatter', 'crystals'] },
          { kind: 'toggle', label: 'Ruins', path: ['world', 'scatter', 'ruins'] },
          { kind: 'slider', label: 'Buildings', path: ['world', 'scatter', 'buildings'], min: 0, max: 400, step: 10 },
          { kind: 'slider', label: 'Density', path: ['world', 'scatter', 'density'], min: 0, max: 1, step: 0.05 },
        ],
      },
    ],
  },
  {
    namespace: 'packs',
    label: 'Asset packs',
    assets: [
      {
        id: 'packs.glb', label: 'GLB / GLTF packs', hint: 'Online-only hero props; procedural fallback always',
        controls: [
          { kind: 'toggle', label: 'Enabled', path: ['custom', 'assets', 'enabled'] },
        ],
      },
    ],
  },
];

/** Apply one asset-registry control value to the spec. */
export function applyAssetControl(spec: GameSpec, control: AssetControl, value: unknown): void {
  if (control.path[0] === 'custom') ensureCustom(spec);
  setAtPath(spec as unknown as Record<string, unknown>, control.path, value);
}

// ---------------------------------------------------------------------------
// reskins: the engine's named asset registry (src/engine/game/Assets.ts).
// Override contract: spec.custom.assets is Record<assetId, AssetOverride>.
// ---------------------------------------------------------------------------

export { ASSET_IDS };
export type { AssetOverride };

const NAMESPACE_LABELS: Record<string, string> = {
  player: 'Player', enemy: 'Enemies', boss: 'Boss', pickup: 'Pickups',
  weapon: 'Weapons', vehicle: 'Vehicles', world: 'World',
};

export interface ReskinNamespace {
  namespace: string;
  label: string;
  ids: string[];
}

/** ASSET_IDS grouped by namespace, in catalog order. */
export function reskinNamespaces(): ReskinNamespace[] {
  const map = new Map<string, string[]>();
  for (const id of ASSET_IDS) {
    const ns = id.split('.')[0];
    if (!map.has(ns)) map.set(ns, []);
    map.get(ns)!.push(id);
  }
  return [...map.entries()].map(([namespace, ids]) => ({
    namespace,
    label: NAMESPACE_LABELS[namespace] ?? namespace,
    ids,
  }));
}

export type CustomAssetsShape = 'absent' | 'reskin' | 'packs';

/**
 * Which shape spec.custom.assets is in:
 * - absent: nothing there
 * - reskin: override record (no boolean `enabled`) — the Assets.ts contract
 * - packs: legacy AssetPacks shape ({ enabled: boolean }) — online GLB packs
 *
 * NOTE (integration): the spec validator still requires `custom.assets.enabled`
 * to be boolean, so a reskin record does NOT validate yet even though the
 * engine's AssetRegistry.applyOverrides() honors it. The editor surfaces this
 * honestly and gates Play until the schema catches up.
 */
export function customAssetsShape(spec: GameSpec): CustomAssetsShape {
  const raw = (spec.custom as unknown as { assets?: unknown } | undefined)?.assets;
  if (raw === undefined || raw === null) return 'absent';
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'absent';
  return typeof (raw as Record<string, unknown>).enabled === 'boolean' ? 'packs' : 'reskin';
}

/** True when reskin overrides are present (and therefore the current schema blocks Play). */
export function reskinOverridesPresent(spec: GameSpec): boolean {
  if (customAssetsShape(spec) !== 'reskin') return false;
  const raw = (spec.custom as unknown as { assets?: Record<string, unknown> }).assets!;
  return Object.keys(raw).length > 0;
}

function reskinRecord(spec: GameSpec): Record<string, unknown> {
  const custom = ensureCustom(spec);
  let raw = (custom as unknown as { assets?: unknown }).assets;
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    raw = {};
    (custom as unknown as { assets?: unknown }).assets = raw;
  }
  return raw as Record<string, unknown>;
}

export function getReskinOverride(spec: GameSpec, id: string): AssetOverride | undefined {
  if (customAssetsShape(spec) !== 'reskin') return undefined;
  const o = (spec.custom as unknown as { assets?: Record<string, unknown> }).assets![id];
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as AssetOverride) : undefined;
}

/** Set (or clear, with undefined) a per-asset reskin override. Never touches the packs shape. */
export function setReskinOverride(spec: GameSpec, id: string, override: AssetOverride | undefined): void {
  if (customAssetsShape(spec) === 'packs') return; // packs active: reskins are engine-ignored; leave packs alone
  const record = reskinRecord(spec);
  if (override === undefined) delete record[id];
  else record[id] = override;
  if (Object.keys(record).length === 0) {
    delete (ensureCustom(spec) as unknown as Record<string, unknown>).assets;
  }
}

/** Remove the whole custom.assets value (used to drop packs or clear reskins). */
export function clearCustomAssets(spec: GameSpec): void {
  if (spec.custom) delete (spec.custom as unknown as Record<string, unknown>).assets;
}

/** A reskin override with every channel at its default (nothing to write). */
export function isDefaultReskin(o: AssetOverride): boolean {
  return (o.color ?? '') === '' && (o.scale ?? 1) === 1 && (o.visible ?? true) === true;
}

/**
 * Mirror of the engine's applyOverrides() acceptance rules, for editor-side
 * feedback. Returns human-readable problems (empty = the engine would apply it).
 */
export function checkReskinContract(spec: GameSpec): string[] {
  const problems: string[] = [];
  if (customAssetsShape(spec) !== 'reskin') return problems;
  const raw = (spec.custom as unknown as { assets?: Record<string, unknown> }).assets!;
  const known = new Set<string>(ASSET_IDS as readonly string[]);
  for (const [id, o] of Object.entries(raw)) {
    if (!known.has(id)) { problems.push(`"${id}": unknown asset id`); continue; }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) { problems.push(`"${id}": override must be an object`); continue; }
    const ov = o as Record<string, unknown>;
    if (ov.color !== undefined && (typeof ov.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(ov.color))) problems.push(`"${id}".color: must be #rrggbb`);
    if (ov.scale !== undefined && (typeof ov.scale !== 'number' || !Number.isFinite(ov.scale) || ov.scale < 0.05 || ov.scale > 10)) problems.push(`"${id}".scale: must be 0.05..10`);
    if (ov.visible !== undefined && typeof ov.visible !== 'boolean') problems.push(`"${id}".visible: must be boolean`);
  }
  return problems;
}

/** Parse the packs textarea (name=url per line) into a packs record. */
export function parsePacks(text: string): { packs: Record<string, string>; bad: string[] } {
  const packs: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^([\w-]+)\s*=\s*(https?:\/\/\S+)$/i);
    if (m) packs[m[1]] = m[2];
    else bad.push(t);
  }
  return { packs, bad };
}

export function packsToText(packs: Record<string, string> | undefined): string {
  return Object.entries(packs ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

// ---------------------------------------------------------------------------
// project save / load (.xandria.json)
// ---------------------------------------------------------------------------

export interface XandriaProject {
  version: 1;
  savedAt: string;
  app: 'xandria-studio';
  spec: GameSpec;
}

export function projectToJson(spec: GameSpec): string {
  const project: XandriaProject = {
    version: 1,
    savedAt: new Date().toISOString(),
    app: 'xandria-studio',
    spec: cloneSpec(spec),
  };
  return JSON.stringify(project, null, 2);
}

/** Parse + validate a .xandria.json file. Throws with a human message on failure. */
export function projectFromJson(json: string): GameSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('not valid JSON');
  }
  const obj = parsed as Record<string, unknown>;
  const spec = (obj?.spec ?? obj) as GameSpec; // tolerate a bare spec too
  // The reskin override record (Assets.ts contract) is pending schema support:
  // validate everything else strictly, and contract-check the reskins instead.
  const custom = (spec as unknown as { custom?: Record<string, unknown> }).custom;
  const assetsRaw = custom?.assets;
  const isReskinRecord = custom !== undefined && assetsRaw !== null && typeof assetsRaw === 'object'
    && !Array.isArray(assetsRaw) && typeof (assetsRaw as Record<string, unknown>).enabled !== 'boolean';
  if (isReskinRecord) delete custom!.assets;
  const v = validateSpec(spec);
  if (!v.ok) throw new Error('invalid spec:\n' + v.errors.slice(0, 8).join('\n'));
  if (isReskinRecord) {
    const withReskins = cloneSpec(spec);
    (withReskins as unknown as { custom: Record<string, unknown> }).custom.assets = assetsRaw;
    const problems = checkReskinContract(withReskins);
    if (problems.length) throw new Error('invalid reskin overrides:\n' + problems.slice(0, 8).join('\n'));
    custom!.assets = assetsRaw;
  }
  return spec as GameSpec;
}
