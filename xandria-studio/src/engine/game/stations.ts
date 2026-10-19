/**
 * Crafting wave (workstream C): crafting stations — world-placeable
 * workbenches (workbench / anvil / forge / alchemy).
 *
 * StationManager implements MapLocalEntitySystem (id 'stations',
 * engine/world/MapEntities.ts):
 *  - spawnForMap(mapSeed) places exactly one station per contract id
 *    (workstream A's STATION_IDS — the single source of truth, imported
 *    not redefined) ringed outside landmark footprints and grounded via
 *    terrain.heightAt, using ONLY new Rng(mapSeed ^ STATION_SALT): never
 *    engine.rng, never Math.random, never Date.now. Same mapSeed ->
 *    identical roster (kinds, positions, names).
 *  - despawnAll() removes every live payload (per-entity instancer
 *    unregister + scene removal + interaction unregistration) and is
 *    idempotent. Enemies wave C lesson: NEVER instancer.reset() on the
 *    shared singleton — unregister per-entity.
 *
 * The manager registers itself with engine.portalEntities (the blueprint
 * does `engine.portalEntities.register(stations)`); PortalTransition
 * drives despawnAll/spawnForMap on every map change. Like nodes, station
 * state is NOT persisted across portals (stateless arrival, same design).
 *
 * Rendering: voxel/blocky station builds with per-biome palettes and
 * amber-glow accents per the art direction. Stations ride the shared
 * per-engine NpcInstancer through the owner-agnostic
 * registerEnemy({ renderRoot }) path, drawing geometry from the SAME
 * per-engine VoxelGeoCache as the nodes (engine/game/voxelGeo.ts) so
 * identically-sized parts share buckets across the whole crafting layer.
 * NO new emissive roles: the amber accent reuses the existing clasp role.
 * Stations are static — they submit every frame from the manager's update
 * inside the blueprint-driven instancer frame.
 *
 * Interaction: stations register Interactables (type 'station',
 * `[E] Use <name>`) into engine.npcInteractions. CraftingInteractionSession
 * owns the prompt pill + the crafting panel; its onActivate dispatches
 * station ids only and returns false otherwise so E passes through to the
 * node/NPC handlers.
 *
 * ---------------------------------------------------------------- requires /
 * produces — the seam this workstream DEFINES (Interaction.ts reserves the
 * fields; the NPC wave left them undefined on NPC interactables for the
 * quest wave). On station interactables:
 *
 * - `requires`: prerequisite item/flag ids that must hold before the
 *   station's activation does anything. THE CRAFTING WAVE LEAVES IT
 *   UNDEFINED. Rationale: the crafting requirement model is per-RECIPE,
 *   not per-interactable — recipe.stationId / minLevel / ingredients are
 *   resolved inside checkCraft()/craft() against the live map station set
 *   (CraftOptions.stations), which already expresses "this recipe needs a
 *   forge nearby". Putting a second, parallel requirement list on the
 *   Interactable would split the truth. The quest wave owns populating
 *   `requires` (e.g. a quest-gated master forge).
 * - `produces`: ids granted on activation, for quests/world-state. LEFT
 *   UNDEFINED. Crafting grants flow through craft() -> inventory, never
 *   through the Interactable — a quest listening for "player crafted at a
 *   forge" hooks the session's onCrafted callback, not this field.
 *
 * A unit test pins both fields undefined on every station interactable so
 * the quest wave inherits a clean, documented seam.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { GameSpec, ItemDef } from '@spec';
import { Rng } from '../core/Rng';
import { NpcInstancer } from './npcInstancing';
import type { Interactable } from './Interaction';
import { InteractionPrompt } from '../ui/InteractionPrompt';
import { CraftingPanel } from '../ui/CraftingPanel';
import { voxelBoxCacheFor, paletteFor, voxelPart, type VoxelBuildCtx } from './voxelGeo';
import {
  STATION_WORKBENCH,
  STATION_ANVIL,
  STATION_FORGE,
  STATION_ALCHEMY,
  STATION_IDS,
  type CraftingRecipe,
  type CraftingInventory,
} from './crafting';
import type { MapLocalEntitySystem } from '../world/MapEntities';

export { STATION_IDS };

/** Salt for the station roster stream — off the NPC/enemy/recipe/gathering streams. */
export const STATION_SALT = 0x53544154; // 'STAT'
/** Salt for the POI-anchor stream — keeps it off the roster stream. */
const STATION_POI_SALT = 0x910d;

export type StationId = (typeof STATION_IDS)[number];

/** Point of interest: landmark/structure anchor for station placement. */
export interface StationPoi {
  x: number;
  z: number;
  /** footprint radius to stay outside of (default 0) */
  r?: number;
}

export interface StationManagerOpts {
  /** POIs to ring stations around (blueprint passes landmarks.placed) */
  pois?: Array<THREE.Vector3 | StationPoi>;
}

// ---------------------------------------------------------------------------
// Genre-appropriate names, picked deterministically from the seed
// ---------------------------------------------------------------------------

type GenreClass = 'arcane' | 'industrial';

function genreClass(genre: GameSpec['meta']['genre']): GenreClass {
  return genre === 'fps-arena' || genre === 'top-down-shooter' ? 'industrial' : 'arcane';
}

const STATION_NAMES: Record<StationId, Record<GenreClass, [string, string]>> = {
  [STATION_WORKBENCH]: {
    arcane: ["Tinker's Bench", "Carver's Workbench"],
    industrial: ['Fabrication Bench', 'Assembly Bench'],
  },
  [STATION_ANVIL]: {
    arcane: ['Rune Anvil', 'Oath Anvil'],
    industrial: ['Press Anvil', 'Impact Anvil'],
  },
  [STATION_FORGE]: {
    arcane: ['Ember Forge', 'Dragonmaw Forge'],
    industrial: ['Smelter', 'Plasma Forge'],
  },
  [STATION_ALCHEMY]: {
    arcane: ['Alchemy Table', "Witch's Crucible"],
    industrial: ['Chem Station', 'Synthesis Rig'],
  },
};

const STATION_SHORT_LABELS: Record<StationId, string> = {
  [STATION_WORKBENCH]: 'Workbench',
  [STATION_ANVIL]: 'Anvil',
  [STATION_FORGE]: 'Forge',
  [STATION_ALCHEMY]: 'Alchemy Table',
};

/** Short display label for a station id (used by the recipe list UI). */
export function stationShortLabel(id: string): string {
  return (STATION_SHORT_LABELS as Record<string, string>)[id] ?? id;
}

/**
 * Deterministic display name for a station: genre-appropriate variant
 * picked by a per-(mapSeed, index) rng stream. Same mapSeed -> same names.
 */
export function stationDisplayName(stationId: StationId, genre: GameSpec['meta']['genre'], mapSeed: number, index: number): string {
  const rng = new Rng(((mapSeed ^ STATION_SALT ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0));
  return rng.pick(STATION_NAMES[stationId][genreClass(genre)]);
}

// ---------------------------------------------------------------------------
// Voxel station builders
// ---------------------------------------------------------------------------

function buildWorkbench(ctx: VoxelBuildCtx, g: THREE.Group, pal: ReturnType<typeof paletteFor>): void {
  voxelPart(ctx, g, 1.6, 0.18, 0.95, pal.wood, 0.9, 0, 0.98, 0);
  for (const [sx, sz] of [[-0.68, -0.36], [0.68, -0.36], [-0.68, 0.36], [0.68, 0.36]] as const) {
    voxelPart(ctx, g, 0.16, 0.9, 0.16, pal.woodDark, 0.9, sx, 0.45, sz);
  }
  voxelPart(ctx, g, 1.3, 0.1, 0.7, pal.woodDark, 0.9, 0, 0.32, 0);
  // tools on the bench + the signature amber marker
  voxelPart(ctx, g, 0.42, 0.1, 0.14, pal.metal, 0.6, -0.35, 1.12, 0.1, { rotY: 0.5 });
  voxelPart(ctx, g, 0.14, 0.14, 0.14, '', 0.3, 0.45, 1.14, -0.15, { amber: true });
}

function buildAnvil(ctx: VoxelBuildCtx, g: THREE.Group, pal: ReturnType<typeof paletteFor>): void {
  voxelPart(ctx, g, 1.0, 0.5, 0.8, pal.rockDark, 0.9, 0, 0.25, 0);
  voxelPart(ctx, g, 0.8, 0.28, 0.6, pal.rock, 0.9, 0, 0.6, 0);
  voxelPart(ctx, g, 0.7, 0.32, 0.34, pal.metal, 0.6, 0, 0.9, 0);
  voxelPart(ctx, g, 0.4, 0.2, 0.2, pal.metal, 0.6, 0.5, 0.86, 0, { rotY: 0.2 });
  // amber inlay on the base — the signature glow accent
  voxelPart(ctx, g, 0.14, 0.14, 0.14, '', 0.3, -0.3, 0.55, 0.28, { amber: true });
}

function buildForge(ctx: VoxelBuildCtx, g: THREE.Group, pal: ReturnType<typeof paletteFor>): void {
  voxelPart(ctx, g, 0.4, 1.2, 0.7, pal.rock, 0.9, -0.5, 0.6, 0);
  voxelPart(ctx, g, 0.4, 1.2, 0.7, pal.rock, 0.9, 0.5, 0.6, 0);
  voxelPart(ctx, g, 1.4, 0.35, 0.8, pal.rockDark, 0.9, 0, 1.32, 0);
  voxelPart(ctx, g, 1.0, 0.25, 0.75, pal.rockDark, 0.9, 0, 0.12, 0);
  voxelPart(ctx, g, 0.35, 0.6, 0.35, pal.rockDark, 0.9, 0, 1.75, -0.1);
  // the fire mouth — amber core, the signature glow accent
  voxelPart(ctx, g, 0.5, 0.55, 0.3, '', 0.3, 0, 0.55, 0.1, { amber: true });
}

function buildAlchemy(ctx: VoxelBuildCtx, g: THREE.Group, pal: ReturnType<typeof paletteFor>): void {
  voxelPart(ctx, g, 1.1, 0.14, 0.62, pal.wood, 0.9, 0, 0.85, 0);
  for (const [sx, sz] of [[-0.45, -0.22], [0.45, -0.22], [-0.45, 0.22], [0.45, 0.22]] as const) {
    voxelPart(ctx, g, 0.14, 0.8, 0.14, pal.woodDark, 0.9, sx, 0.4, sz);
  }
  voxelPart(ctx, g, 1.1, 0.1, 0.26, pal.woodDark, 0.9, 0, 1.35, -0.18);
  // vials + the signature amber bubble
  voxelPart(ctx, g, 0.14, 0.3, 0.14, pal.metal, 0.6, -0.3, 1.08, 0.05);
  voxelPart(ctx, g, 0.14, 0.26, 0.14, pal.metal, 0.6, 0.05, 1.06, 0.1, { rotY: 0.4 });
  voxelPart(ctx, g, 0.12, 0.12, 0.12, '', 0.3, 0.35, 1.46, -0.18, { amber: true });
}

// ---------------------------------------------------------------------------
// StationEntity — one world-placeable station
// ---------------------------------------------------------------------------

export class StationEntity {
  readonly stationId: StationId;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly interactable: Interactable;

  /** The instancible render root — the owner-agnostic registerEnemy({ renderRoot }) path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  constructor(
    private readonly engine: Engine,
    stationId: StationId,
    position: THREE.Vector3,
    index: number,
    mapSeed: number,
  ) {
    this.stationId = stationId;
    const genre = engine.spec.meta.genre;
    this.name = stationDisplayName(stationId, genre, mapSeed, index);
    // per-station rng: deterministic build jitter, seeded off
    // (mapSeed, STATION_SALT, index) — never engine.rng
    const rng = new Rng(((mapSeed ^ STATION_SALT ^ Math.imul(index + 7, 0x9e3779b1)) >>> 0));
    const ctx: VoxelBuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      rng: rng.fork(0x5eed),
    };
    const pal = paletteFor(engine.spec.theme.environment);
    if (stationId === STATION_WORKBENCH) buildWorkbench(ctx, this.root, pal);
    else if (stationId === STATION_ANVIL) buildAnvil(ctx, this.root, pal);
    else if (stationId === STATION_FORGE) buildForge(ctx, this.root, pal);
    else buildAlchemy(ctx, this.root, pal);
    // per-station silhouette variety: rotation + slight uniform scale —
    // instance matrices, never unique geometry
    this.root.rotation.y = rng.range(0, Math.PI * 2);
    this.root.scale.setScalar(rng.range(0.95, 1.1));
    this.root.position.copy(position);

    const short = stationId.split('_')[1] ?? stationId;
    this.interactable = {
      id: `station-${short}-${(mapSeed >>> 0).toString(16)}-${index}`,
      type: 'station',
      position: position.clone().add(new THREE.Vector3(0, 1.2, 0)),
      radius: 3.5,
      enabled: true,
      prompt: `Use ${this.name}`,
      // requires/produces: the QUEST seam (see module header). The
      // crafting wave leaves both undefined — recipe requirements are
      // per-recipe and resolve inside checkCraft()/craft() against the
      // live map station set, not per-interactable.
      requires: undefined,
      produces: undefined,
    };
  }
}

/** Register station interactables into the engine NPC registry. Idempotent. */
export function registerStationInteractables(engine: Engine, stations: readonly StationEntity[]): void {
  const reg = engine.npcInteractions;
  for (const s of stations) {
    if (!reg.get(s.interactable.id)) reg.register(s.interactable);
  }
}

/** Unregister station interactables. Missing ids are ignored. */
export function unregisterStationInteractables(engine: Engine, stations: readonly StationEntity[]): void {
  const reg = engine.npcInteractions;
  for (const s of stations) reg.unregister(s.interactable.id);
}

// ---------------------------------------------------------------------------
// StationManager — map-local lifecycle
// ---------------------------------------------------------------------------

function poiXZ(p: THREE.Vector3 | StationPoi): { x: number; z: number; r: number } {
  return p instanceof THREE.Vector3
    ? { x: p.x, z: p.z, r: 0 }
    : { x: p.x, z: p.z, r: p.r ?? 0 };
}

export class StationManager implements MapLocalEntitySystem {
  readonly id = 'stations';
  private readonly opts: StationManagerOpts;
  private readonly instancer: NpcInstancer;
  private list: StationEntity[] = [];

  constructor(private readonly engine: Engine, opts: StationManagerOpts = {}) {
    this.opts = opts;
    // Same shared per-engine instancer the NPC/enemy/node layers use;
    // buckets are shared across all of them.
    this.instancer = NpcInstancer.for(engine);
  }

  /** Live roster (read-only view). */
  get stations(): readonly StationEntity[] {
    return this.list;
  }

  /** Station ids present in this map — the `stations` opt for checkCraft()/craft(). */
  stationIds(): string[] {
    return this.list.map((s) => s.stationId);
  }

  /**
   * Place this map's station roster deterministically from mapSeed alone:
   * exactly one station per contract id, in STATION_IDS order. Idempotent:
   * despawns any live roster first (portal arrival after an aborted
   * transition can never double-spawn).
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    const rng = new Rng((mapSeed ^ STATION_SALT) >>> 0);
    const anchors = this.resolveAnchors(mapSeed);
    STATION_IDS.forEach((stationId, i) => {
      const pos = this.placeStation(rng, anchors, i);
      const st = new StationEntity(this.engine, stationId, pos, i, mapSeed);
      this.engine.scene.add(st.root);
      this.list.push(st);
      // owner-agnostic path: the station only needs { renderRoot }
      this.instancer.registerEnemy(st);
    });
    registerStationInteractables(this.engine, this.list);
  }

  /**
   * Remove every live payload: per-entity instancer unregister, scene
   * removal, interaction unregistration. Idempotent.
   *
   * Enemies wave C lesson: unregister per-entity from the SHARED instancer —
   * NEVER instancer.reset() here (reset() would wipe the NPC/enemy/node
   * buckets too).
   */
  despawnAll(): void {
    for (const s of this.list) {
      try { this.instancer.unregister(s); } catch { /* never strand the rest */ }
      try { this.engine.scene.remove(s.root); } catch { /* never strand the rest */ }
    }
    unregisterStationInteractables(this.engine, this.list);
    this.list = [];
  }

  /**
   * Submit each live station to the shared instancer. The blueprint drives
   * the instancer frame (beginFrame/endFrame) around the manager updates —
   * the enemies-wave-C shared-frame fix.
   */
  update(_dt: number): void {
    for (const s of this.list) this.instancer.submit(s);
  }

  /**
   * Deterministic POI anchors: each landmark gets an anchor point outside
   * its footprint so stations sit *near* points of interest, not inside
   * their colliders. Pure function of (mapSeed, pois).
   */
  private resolveAnchors(mapSeed: number): THREE.Vector3[] {
    const raw = this.opts.pois;
    if (!raw?.length) return [];
    const rng = new Rng((mapSeed ^ STATION_SALT ^ STATION_POI_SALT) >>> 0);
    return raw.map((p) => {
      const { x, z, r } = poiXZ(p);
      const a = rng.range(0, Math.PI * 2);
      const d = r + 6 + rng.range(0, 8);
      return new THREE.Vector3(x + Math.cos(a) * d, 0, z + Math.sin(a) * d);
    });
  }

  /** Ring a station outside the anchor footprint (or scatter when no POIs), grounded via terrain.heightAt. */
  private placeStation(rng: Rng, anchors: THREE.Vector3[], index: number): THREE.Vector3 {
    const terrain = this.engine.terrain;
    if (anchors.length) {
      const a = anchors[index % anchors.length];
      for (let tries = 0; tries < 8; tries++) {
        const ang = rng.range(0, Math.PI * 2);
        const dist = rng.range(4, 14);
        const x = a.x + Math.cos(ang) * dist;
        const z = a.z + Math.sin(ang) * dist;
        if (terrain && !terrain.inBounds(x, z)) continue;
        const y = terrain ? (terrain.heightAt(x, z) ?? 0) : 0;
        return new THREE.Vector3(x, y, z);
      }
      const y = terrain ? (terrain.heightAt(a.x, a.z) ?? 0) : 0;
      return new THREE.Vector3(a.x, y, a.z);
    }
    // no POIs: scatter in a ring away from origin
    for (let tries = 0; tries < 8; tries++) {
      const ang = rng.range(0, Math.PI * 2);
      const dist = rng.range(15, 40);
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      if (terrain && !terrain.inBounds(x, z)) continue;
      const y = terrain ? (terrain.heightAt(x, z) ?? 0) : 0;
      return new THREE.Vector3(x, y, z);
    }
    return new THREE.Vector3(index * 5, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// CraftingInteractionSession — the [E] Use prompt + the crafting panel
// ---------------------------------------------------------------------------

export interface CraftingSessionOpts {
  /** override the UI container (default: engine.container) */
  container?: HTMLElement;
  /** override the player position source (default: portalsPlayerAvatar) */
  getPlayerPos?: () => THREE.Vector3;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** false = headless: register interactables but build no UI */
  enableUi?: boolean;
  /** the seeded recipe pool for this spec (buildRecipePool — pure) */
  recipes: () => CraftingRecipe[];
  /** item def table (must include the recipe output + ingredient ids) */
  defs: () => Record<string, ItemDef>;
  /** live inventory sink (null = no inventory; craft buttons disable honestly) */
  inventory: () => CraftingInventory | null;
  /** player progression level for minLevel gates */
  playerLevel: () => number;
  /** toast surface for craft success/failure feedback */
  toast: (msg: string) => void;
}

/** Stale-session guard: one live session per engine (mirrors the gathering session rule). */
const liveSessions = new WeakMap<Engine, CraftingInteractionSession>();

/**
 * The [E] Use <station> prompt for crafting stations — the
 * NpcInteractionSession / GatheringInteractionSession pattern. The prompt
 * shares engine.npcInteractions; onActivate dispatches station ids only
 * (returns false for anything else so the event passes through to the
 * node/NPC handlers). The session owns the CraftingPanel: [E] at a station
 * opens the recipe list, Esc/E closes it.
 */
export class CraftingInteractionSession {
  private readonly byId = new Map<string, StationEntity>();
  private prompt: InteractionPrompt | null = null;
  private panel: CraftingPanel | null = null;
  private disposed = false;
  private scratch = new THREE.Vector3();

  constructor(
    private readonly engine: Engine,
    private readonly stations: StationManager,
    private readonly opts: CraftingSessionOpts,
  ) {
    // replace any stale session from a blueprint rebuild (one prompt pill, one panel)
    liveSessions.get(engine)?.dispose();
    liveSessions.set(engine, this);

    this.refresh();
    if (opts.enableUi === false) return;
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container ?? engine.container;
    this.panel = new CraftingPanel({
      container,
      doc,
      inventory: opts.inventory,
      defs: opts.defs,
      recipes: opts.recipes,
      stationIds: () => new Set(stations.stationIds()),
      playerLevel: opts.playerLevel,
      toast: opts.toast,
    });
    this.prompt = new InteractionPrompt(container, engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      getRival: (pos) => this.chestRival(pos),
      onActivate: (target) => this.openFor(target.id),
      isModalOpen: () => this.panel?.isOpen ?? false,
    }, doc);
  }

  /** True while the crafting panel is open (blueprints wire this into the other sessions' isModalOpen). */
  get isPanelOpen(): boolean {
    return this.panel?.isOpen ?? false;
  }

  /** Visible for tests: the owned panel (null when enableUi === false). */
  get ownedPanel(): CraftingPanel | null {
    return this.panel;
  }

  /**
   * Open the crafting panel for a station interactable id. Returns true
   * when the id is a known station (the activation is consumed); false
   * lets E continue to other handlers (nodes, NPCs, chests). With
   * enableUi === false there is no panel, but the dispatch result is the
   * same — the prompt itself only exists when UI is enabled.
   */
  openFor(interactableId: string): boolean {
    const st = this.byId.get(interactableId);
    if (!st) return false;
    // pass the station id so the panel's missing-station check narrows to
    // the station the player is actually at (not every station in the map)
    this.panel?.show(st.name, st.stationId);
    return true;
  }

  /** Per-frame: pick up respawns after spawnForMap, tick prompt + panel. */
  update(dt: number): void {
    if (this.disposed) return;
    this.refresh();
    this.prompt?.update();
    this.panel?.update(dt);
  }

  /** Teardown: kill the prompt + panel. Station lifecycle stays with the manager. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prompt?.dispose();
    this.prompt = null;
    this.panel?.dispose();
    this.panel = null;
    this.byId.clear();
    if (liveSessions.get(this.engine) === this) liveSessions.delete(this.engine);
  }

  private refresh(): void {
    registerStationInteractables(this.engine, this.stations.stations);
    this.byId.clear();
    for (const s of this.stations.stations) this.byId.set(s.interactable.id, s);
  }

  private playerPos(): THREE.Vector3 {
    const p = this.opts.getPlayerPos?.() ?? this.engine.portalsPlayerAvatar?.ctrl.position;
    return p ? this.scratch.copy(p) : this.scratch.set(0, 0, 0);
  }

  /** The chest registry's nearest eligible — the arbitration rival (same as NPCs/nodes). */
  private chestRival(pos: THREE.Vector3): Interactable | null {
    const iw = (this.engine as unknown as {
      itemWorld?: { interactions: import('./Interaction').InteractionRegistry };
    }).itemWorld;
    return iw?.interactions.nearestEligible(pos) ?? null;
  }

  /** Visible for tests: live session count for this engine (0 or 1). */
  static liveFor(engine: Engine): boolean {
    return liveSessions.has(engine);
  }
}
