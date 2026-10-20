/**
 * Gathering nodes — harvestable world nodes for the crafting wave (workstream B).
 *
 * GatheringManager implements MapLocalEntitySystem (id 'gathering',
 * engine/world/MapEntities.ts):
 *  - spawnForMap(mapSeed) spawns this map's deterministic node roster
 *    (ore veins, fiber plants, salvage caches) ringed outside landmark
 *    footprints and grounded via terrain.heightAt, using ONLY
 *    new Rng(mapSeed ^ GATHER_SALT): never engine.rng, never Math.random,
 *    never Date.now. Same mapSeed -> identical roster (kinds, positions).
 *  - despawnAll() removes every live payload (instancer unregister +
 *    scene removal + interaction unregistration) and is idempotent.
 *
 * The manager registers itself with engine.portalEntities (the blueprint
 * does `engine.portalEntities.register(gathering)`); PortalTransition
 * drives despawnAll/spawnForMap on every map change.
 *
 * Design decision — depleted state is NOT persisted across portals: arrival
 * regenerates the identical roster, so a harvested node is back on map
 * re-entry. This matches the NPC/enemy stateless-arrival design and keeps
 * the map-local contract pure (no cross-map save plumbing in this wave).
 *
 * Rendering: voxel/blocky node meshes (ore veins, fiber plants, salvage
 * caches) with per-biome palettes and amber-glow accents per the art
 * direction. Nodes ride the shared per-engine NpcInstancer through the
 * owner-agnostic registerEnemy({ renderRoot }) path — one InstancedMesh per
 * (geometry, material-role) bucket across ALL live nodes. Geometry dims are
 * quantized through the shared per-engine VoxelGeoCache (engine/game/voxelGeo.ts)
 * so identical parts collapse
 * into shared buckets; per-node variety rides on root rotation/scale and
 * per-instance tints (the enemies-wave-C geometry-quantization pattern).
 * The amber accent reuses the existing amber-clasp emissive role
 * (amberGlowMaterial(mats, 2.0) — #ffb545 @ 2.0); NO new emissive roles.
 * Nodes are static — they submit every frame from the manager's update
 * inside the blueprint-driven instancer frame (blueprints wrap manager
 * updates in beginFrame/endFrame — the enemies-wave-C shared-frame fix).
 *
 * Harvest: nodes register Interactables (type 'node') into
 * engine.npcInteractions (the [E] Talk pattern from npcInteraction.ts —
 * registration calls live HERE, npcInteraction.ts internals untouched).
 * GatheringInteractionSession owns the prompt pill + harvest dispatch.
 * Harvest grants materials to the inventory, then the node collapses
 * (shrinks over ~0.6s — no pop) and is retired from the instancer and the
 * interaction registry.
 *
 * Material ids — FIXED CONTRACT (workstream A defines the item defs; do
 * not rename): mat_ore, mat_fiber, mat_scrap. Inventory.add warns and
 * ignores unknown ids, so harvests are no-ops until A's defs land.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { NpcInstancer } from './npcInstancing';
import { voxelBoxCacheFor, paletteFor, voxelPart, type VoxelPalette, type VoxelGeoCache } from './voxelGeo';
import type { Interactable } from './Interaction';
import { InteractionPrompt } from '../ui/InteractionPrompt';
import type { InventoryLike } from './items/Inventory';
import { MAT_ORE, MAT_FIBER, MAT_SCRAP } from './crafting';
import type { MapLocalEntitySystem } from '../world/MapEntities';

/**
 * Salt for the gathering roster stream — keeps it off the NPC stream, the
 * enemy stream, the recipe stream and the engine.rng stream. Same mapSeed ->
 * identical roster. Value mandated by the workstream spec ('CRAF').
 * Named GATHER_SALT because workstream A owns CRAFT_SALT (0xc0a57) for the
 * recipe-pool stream — the two streams must stay independent.
 */
export const GATHER_SALT = 0x43524146;

/**
 * Material item ids — FIXED CONTRACT defined by workstream A
 * (engine/game/crafting: MAT_ORE/MAT_FIBER/MAT_SCRAP). Do not rename.
 */
export const MATERIAL_IDS = {
  ore: MAT_ORE,
  fiber: MAT_FIBER,
  scrap: MAT_SCRAP,
} as const;

export type NodeKind = keyof typeof MATERIAL_IDS; // 'ore' | 'fiber' | 'scrap'
const NODE_KINDS: NodeKind[] = ['ore', 'fiber', 'scrap'];

const NODE_LABELS: Record<NodeKind, string> = {
  ore: 'ore vein',
  fiber: 'fiber plant',
  scrap: 'salvage cache',
};

/** Yield range per kind: base + rng.int(0, variance), deterministic per node. */
const NODE_YIELD: Record<NodeKind, { base: number; variance: number }> = {
  ore: { base: 2, variance: 1 },
  fiber: { base: 2, variance: 1 },
  scrap: { base: 1, variance: 1 },
};

/** Depletion collapse duration (seconds) — shrink, never pop. */
const DEPLETE_TIME = 0.6;

/** Default node count per map (before density scaling). */
export const DEFAULT_NODE_COUNT = 18;

/** Salt for the POI-anchor stream — keeps it off the roster stream. */
const GATHER_POI_SALT = 0x90c;

/** Point of interest: landmark/structure anchor for node placement. */
export interface GatheringPoi {
  x: number;
  z: number;
  /** footprint radius to stay outside of (default 0) */
  r?: number;
}

export interface GatheringManagerOpts {
  /** POIs to ring nodes around (blueprint passes landmarks.placed) */
  pois?: Array<THREE.Vector3 | GatheringPoi>;
  /** 0..1+ scales the default roster (default 1; workstream C's GATHERING DENSITY slider wires here) */
  density?: number;
  /** exact node count (overrides density) */
  count?: number;
  /** where harvested materials land (blueprint passes itemKit?.inventory); null = harvest depletes the node but grants nothing */
  inventory?: InventoryLike | null;
  /**
   * Skills wave: flat harvest-yield bonus from the foraging skill rank
   * (blueprint passes () => skills.harvestYieldBonus()). Deterministic —
   * the bonus is a pure function of rank, never RNG.
   */
  yieldBonus?: () => number;
  /**
   * Fired after a successful harvest with the final granted counts
   * (base yield + foraging bonus). Blueprints grant foraging XP here
   * (skills wave) and report the grant to QuestManager.onHarvest
   * (quest wave — fires even when no inventory is wired; the quest
   * counts effort, not the landing). Additive — no behavior change
   * when unwired.
   */
  onHarvested?: (grant: { materialId: string; count: number }) => void;
}

// ---------------------------------------------------------------------------
// Geometry cache + per-biome palettes + voxel part builder: shared with the
// station layer via engine/game/voxelGeo.ts (identical dims return the
// identical geometry object, so node and station parts share instancer
// buckets wherever dims + material role match).
// Voxel node builders — blocky meshes, deterministic jitter from the node rng
// ---------------------------------------------------------------------------

interface BuildCtx {
  engine: Engine;
  geo: VoxelGeoCache;
  pal: VoxelPalette;
  rng: Rng;
}

/** Ore vein: dark rock cluster with amber crystal shards poking out. */
function buildOreVein(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.3, 0.35, 1.15, p.rockDark, 0.9, 0, 0.17, 0);
  voxelPart(ctx, g, 0.75, 0.62, 0.68, p.rock, 0.9, -0.15, 0.55, 0.1, { rotY: 0.4 });
  voxelPart(ctx, g, 0.55, 0.48, 0.5, p.rock, 0.9, 0.35, 0.45, -0.2, { rotY: -0.7 });
  voxelPart(ctx, g, 0.42, 0.38, 0.4, p.rockDark, 0.9, -0.35, 0.35, -0.25, { rotY: 1.1 });
  // amber crystals — the signature glow accent
  voxelPart(ctx, g, 0.14, 0.55, 0.14, '', 0.3, -0.1, 0.85, 0.05, { rotZ: 0.3, amber: true });
  voxelPart(ctx, g, 0.14, 0.45, 0.14, '', 0.3, 0.3, 0.7, -0.15, { rotZ: -0.35, rotX: 0.2, amber: true });
  voxelPart(ctx, g, 0.14, 0.4, 0.14, '', 0.3, -0.3, 0.6, -0.2, { rotZ: 0.15, rotX: -0.25, amber: true });
}

/** Fiber plant: blocky stem + fanned blades + amber bud. */
function buildFiberPlant(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 0.55, 0.22, 0.5, p.rockDark, 0.9, 0, 0.11, 0);
  voxelPart(ctx, g, 0.13, 0.85, 0.13, p.stem, 0.75, 0, 0.6, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + ctx.rng.next() * 0.5;
    voxelPart(ctx, g, 0.09, 0.75, 0.09, p.leaf, 0.75,
      Math.cos(a) * 0.14, 0.75, Math.sin(a) * 0.14,
      { rotZ: Math.cos(a) * 0.4, rotX: -Math.sin(a) * 0.4 });
  }
  // amber seed bud — the signature glow accent
  voxelPart(ctx, g, 0.18, 0.18, 0.18, '', 0.3, 0, 1.08, 0, { amber: true });
}

/** Salvage cache: wooden crate with metal bands + amber marker light. */
function buildSalvageCache(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 0.95, 0.6, 0.72, p.wood, 0.9, 0, 0.3, 0);
  voxelPart(ctx, g, 1.0, 0.14, 0.77, p.woodDark, 0.9, 0, 0.67, 0);
  voxelPart(ctx, g, 1.02, 0.09, 0.12, p.metal, 0.6, 0, 0.3, 0.2);
  voxelPart(ctx, g, 1.02, 0.09, 0.12, p.metal, 0.6, 0, 0.3, -0.2);
  // amber marker — the signature glow accent
  voxelPart(ctx, g, 0.12, 0.12, 0.12, '', 0.3, 0, 0.8, 0, { amber: true });
}

// ---------------------------------------------------------------------------
// GatherNode — one harvestable node
// ---------------------------------------------------------------------------

export class GatherNode {
  readonly kind: NodeKind;
  readonly root = new THREE.Group();
  readonly interactable: Interactable;
  /** true once the manager has fully retired this node (instancer + registry) */
  retired = false;

  private readonly rng: Rng;
  private depleting = false;
  private depleteT = 0;

  /** The instancible render root — the owner-agnostic registerEnemy({ renderRoot }) path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  constructor(
    private readonly engine: Engine,
    kind: NodeKind,
    position: THREE.Vector3,
    index: number,
    mapSeed: number,
  ) {
    this.kind = kind;
    // per-node rng: deterministic yield + deterministic build jitter,
    // seeded off (mapSeed, GATHER_SALT, index) — never engine.rng
    this.rng = new Rng(((mapSeed ^ GATHER_SALT ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0));
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: this.rng.fork(0xbeef),
    };
    if (kind === 'ore') buildOreVein(ctx, this.root);
    else if (kind === 'fiber') buildFiberPlant(ctx, this.root);
    else buildSalvageCache(ctx, this.root);
    // per-node silhouette variety: rotation + slight uniform scale —
    // instance matrices, never unique geometry
    this.root.rotation.y = this.rng.range(0, Math.PI * 2);
    this.root.scale.setScalar(this.rng.range(0.9, 1.15));
    this.root.position.copy(position);

    const label = NODE_LABELS[kind];
    this.interactable = {
      id: `node-${kind}-${(mapSeed >>> 0).toString(16)}-${index}`,
      type: 'node',
      position: position.clone().add(new THREE.Vector3(0, 1, 0)),
      radius: 3,
      enabled: true,
      prompt: kind === 'scrap' ? `Salvage ${label}` : `Harvest ${label}`,
    };
  }

  get isDepleted(): boolean {
    return this.depleting;
  }

  /**
   * Harvest the node: starts the collapse animation and returns the
   * material grant. Null when already harvested (double-harvest is a
   * no-op — the prompt is disabled at the same moment).
   */
  harvest(): { materialId: string; count: number } | null {
    if (this.depleting) return null;
    this.depleting = true;
    this.interactable.enabled = false;
    const y = NODE_YIELD[this.kind];
    return { materialId: MATERIAL_IDS[this.kind], count: y.base + this.rng.int(0, y.variance) };
  }

  /**
   * Tick the collapse animation. Returns true when the node has fully
   * collapsed — the manager then retires it (instancer unregister +
   * registry unregister). Ease-in shrink: continuous, no pop.
   */
  update(dt: number): boolean {
    if (!this.depleting || this.retired) return false;
    this.depleteT += dt;
    const k = Math.min(1, this.depleteT / DEPLETE_TIME);
    this.root.scale.setScalar(Math.max(0.001, 1 - k * k));
    return k >= 1;
  }
}

/** Register node interactables into the engine NPC registry. Idempotent. */
export function registerGatheringInteractables(engine: Engine, nodes: readonly GatherNode[]): void {
  const reg = engine.npcInteractions;
  for (const n of nodes) {
    if (!reg.get(n.interactable.id)) reg.register(n.interactable);
  }
}

/** Unregister node interactables. Missing ids are ignored. */
export function unregisterGatheringInteractables(engine: Engine, nodes: readonly GatherNode[]): void {
  const reg = engine.npcInteractions;
  for (const n of nodes) reg.unregister(n.interactable.id);
}

// ---------------------------------------------------------------------------
// GatheringManager — map-local lifecycle
// ---------------------------------------------------------------------------

function poiXZ(p: THREE.Vector3 | GatheringPoi): { x: number; z: number; r: number } {
  return p instanceof THREE.Vector3
    ? { x: p.x, z: p.z, r: 0 }
    : { x: p.x, z: p.z, r: p.r ?? 0 };
}

export class GatheringManager implements MapLocalEntitySystem {
  readonly id = 'gathering';
  private readonly opts: GatheringManagerOpts;
  private readonly instancer: NpcInstancer;
  private list: GatherNode[] = [];

  constructor(private readonly engine: Engine, opts: GatheringManagerOpts = {}) {
    this.opts = opts;
    // Crafting wave B: the manager owns the per-engine instancer — the same
    // singleton NpcManager and EnemyManager use; buckets are shared across
    // NPCs, enemies and nodes.
    this.instancer = NpcInstancer.for(engine);
  }

  /** Live roster (read-only view). */
  get nodes(): readonly GatherNode[] {
    return this.list;
  }

  /** Replace the inventory sink (e.g. when the item kit arrives after the manager). */
  setInventory(inv: InventoryLike | null): void {
    this.opts.inventory = inv;
  }

  /**
   * Spawn this map's node roster deterministically from mapSeed alone.
   * Idempotent: despawns any live roster first (portal arrival after an
   * aborted transition can never double-spawn).
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    const rng = new Rng((mapSeed ^ GATHER_SALT) >>> 0);
    const count = this.opts.count
      ?? Math.round(DEFAULT_NODE_COUNT * (this.opts.density ?? 1));
    const anchors = this.resolveAnchors(mapSeed);
    for (let i = 0; i < count; i++) {
      const kind = rng.pick(NODE_KINDS);
      const pos = this.placeNode(rng, anchors, i);
      const node = new GatherNode(this.engine, kind, pos, i, mapSeed);
      this.engine.scene.add(node.root);
      this.list.push(node);
      // owner-agnostic path: the node only needs { renderRoot }
      this.instancer.registerEnemy(node);
    }
    registerGatheringInteractables(this.engine, this.list);
  }

  /**
   * Remove every live payload: per-entity instancer unregister, scene
   * removal, interaction unregistration. Idempotent.
   *
   * Enemies wave C lesson: unregister per-entity from the SHARED instancer —
   * NEVER instancer.reset() here (reset() would wipe the NPC/enemy
   * buckets too; both managers own the same per-engine singleton and
   * spawnForMap self-cleans via despawnAll, so a global reset on every
   * spawn would drop the other rosters' instancing on every portal arrival).
   */
  despawnAll(): void {
    for (const n of this.list) {
      try { this.instancer.unregister(n); } catch { /* never strand the rest */ }
      try { this.engine.scene.remove(n.root); } catch { /* never strand the rest */ }
    }
    unregisterGatheringInteractables(this.engine, this.list);
    this.list = [];
  }

  /**
   * Tick the roster: depletion collapse animations + submit each live node
   * to the shared instancer. The blueprint drives the instancer frame
   * (beginFrame/endFrame) around the manager updates — the enemies-wave-C
   * shared-frame fix: a single begin/end per update keeps NPC, enemy and
   * node submits accumulating into the same frame.
   */
  update(dt: number): void {
    for (const n of this.list) {
      if (n.retired) continue;
      if (n.update(dt)) {
        // Collapse finished: retire the node — per-entity unregister from
        // the shared instancer + drop the interactable. Never reset().
        this.instancer.unregister(n);
        unregisterGatheringInteractables(this.engine, [n]);
        n.retired = true;
        continue;
      }
      this.instancer.submit(n);
    }
  }

  /**
   * Harvest a node by interactable id: starts its collapse and grants the
   * materials to the inventory (when one is wired). Returns the grant
   * (base yield + foraging yield bonus), or null when the id is unknown /
   * already harvested.
   */
  harvestById(id: string): { materialId: string; count: number } | null {
    const node = this.list.find((n) => n.interactable.id === id && !n.retired);
    if (!node) return null;
    const grant = node.harvest();
    if (!grant) return null;
    // Skills wave: the foraging rank adds a flat deterministic bonus on
    // top of the seeded base yield.
    const bonus = Math.max(0, Math.floor(this.opts.yieldBonus?.() ?? 0));
    const total = { materialId: grant.materialId, count: grant.count + bonus };
    if (this.opts.inventory) {
      this.opts.inventory.add(total.materialId, total.count);
    }
    // Quest wave + skills wave: report the final grant — the quest
    // counts the harvest even when no inventory is wired (effort, not
    // the landing); blueprints grant foraging XP from the same event.
    this.opts.onHarvested?.(total);
    return total;
  }

  /**
   * Deterministic POI anchors: each landmark gets an anchor point outside
   * its footprint so nodes ring *around* points of interest, not inside
   * their colliders. Pure function of (mapSeed, pois).
   */
  private resolveAnchors(mapSeed: number): THREE.Vector3[] {
    const raw = this.opts.pois;
    if (!raw?.length) return [];
    const rng = new Rng((mapSeed ^ GATHER_SALT ^ GATHER_POI_SALT) >>> 0);
    return raw.map((p) => {
      const { x, z, r } = poiXZ(p);
      const a = rng.range(0, Math.PI * 2);
      const d = r + 4 + rng.range(0, 6);
      return new THREE.Vector3(x + Math.cos(a) * d, 0, z + Math.sin(a) * d);
    });
  }

  /** Ring a node outside the anchor footprint (or scatter when no POIs), grounded via terrain.heightAt. */
  private placeNode(rng: Rng, anchors: THREE.Vector3[], index: number): THREE.Vector3 {
    const terrain = this.engine.terrain;
    if (anchors.length) {
      const a = rng.pick(anchors);
      for (let tries = 0; tries < 8; tries++) {
        const ang = rng.range(0, Math.PI * 2);
        const dist = rng.range(2, 12);
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
    return new THREE.Vector3(index * 3, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// GatheringInteractionSession — the [E] Harvest prompt (npcInteraction pattern)
// ---------------------------------------------------------------------------

export interface GatheringSessionOpts {
  /** override the UI container (default: engine.container) */
  container?: HTMLElement;
  /** override the player position source (default: portalsPlayerAvatar) */
  getPlayerPos?: () => THREE.Vector3;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** false = headless: register interactables but build no UI */
  enableUi?: boolean;
  /**
   * true while a modal UI (the crafting panel) owns input — the prompt
   * defers. Workstream C wires the station session's panel state here so
   * [E] can't harvest behind the open crafting UI.
   */
  isModalOpen?: () => boolean;
}

/** Stale-session guard: one live session per engine (mirrors portalEntities' replace-stale-entry rule). */
const liveSessions = new WeakMap<Engine, GatheringInteractionSession>();

/**
 * The [E] Harvest prompt for gathering nodes — the NpcInteractionSession
 * pattern applied to nodes. Registration calls live here and in the
 * manager; npcInteraction.ts internals are untouched.
 *
 * The prompt shares engine.npcInteractions with the NPC/chest registries;
 * onActivate dispatches node ids only (returns false for anything else so
 * the event passes through to the other prompt handlers). Idempotent
 * dispose: safe to call twice.
 */
export class GatheringInteractionSession {
  private readonly byId = new Map<string, GatherNode>();
  private prompt: InteractionPrompt | null = null;
  private disposed = false;
  private scratch = new THREE.Vector3();

  constructor(
    private readonly engine: Engine,
    private readonly manager: GatheringManager,
    private readonly opts: GatheringSessionOpts = {},
  ) {
    // replace any stale session from a blueprint rebuild (one prompt pill)
    liveSessions.get(engine)?.dispose();
    liveSessions.set(engine, this);

    this.refresh();
    if (opts.enableUi === false) return;
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container ?? engine.container;
    this.prompt = new InteractionPrompt(container, engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      getRival: (pos) => this.chestRival(pos),
      onActivate: (target) => this.harvest(target.id),
      isModalOpen: () => this.opts.isModalOpen?.() ?? false,
    }, doc);
  }

  /** The node currently shown in the prompt (null = none or a non-node target). */
  get promptedNode(): GatherNode | null {
    const t = this.prompt?.currentTarget;
    return t && t.type === 'node' ? this.byId.get(t.id) ?? null : null;
  }

  /**
   * Harvest the node behind an interactable id. Returns true when the
   * activation was consumed (a live node started its collapse); false lets
   * the E event continue to other handlers (NPC dialogue, chests).
   */
  harvest(interactableId: string): boolean {
    const node = this.byId.get(interactableId);
    if (!node || node.retired) return false;
    return this.manager.harvestById(interactableId) !== null;
  }

  /** Per-frame: pick up respawns after spawnForMap, tick the prompt. */
  update(_dt: number): void {
    if (this.disposed) return;
    this.refresh();
    this.prompt?.update();
  }

  /** Teardown: kill the prompt. Node lifecycle stays with the manager. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prompt?.dispose();
    this.prompt = null;
    this.byId.clear();
    if (liveSessions.get(this.engine) === this) liveSessions.delete(this.engine);
  }

  private refresh(): void {
    registerGatheringInteractables(this.engine, this.manager.nodes);
    this.byId.clear();
    for (const n of this.manager.nodes) {
      if (!n.retired) this.byId.set(n.interactable.id, n);
    }
  }

  private playerPos(): THREE.Vector3 {
    const p = this.opts.getPlayerPos?.() ?? this.engine.portalsPlayerAvatar?.ctrl.position;
    return p ? this.scratch.copy(p) : this.scratch.set(0, 0, 0);
  }

  /** The chest registry's nearest eligible — the arbitration rival (same as NPCs). */
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
