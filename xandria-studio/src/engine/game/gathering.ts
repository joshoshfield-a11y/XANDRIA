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
import { MAT_ORE, MAT_FIBER, MAT_SCRAP, MAT_HERB, MAT_CRYSTAL } from './crafting';
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
 * THE node tuning table (upgrade loop, gathering-nodes phase): every
 * per-kind number lives here and nowhere else — label, material, yield
 * range, respawn interval, minimap color. Kinds, yields and respawn
 * rules are data, not code paths.
 *
 * Respawn rule: a harvested node collapses (0.6s, no pop), waits
 * respawnSeconds, then regrows (0.6s) and becomes harvestable again —
 * in-map, no portal trip required. Portal trips preserve the wait:
 * despawn snapshots each non-live node's remaining wait per mapSeed
 * and spawnForMap restores it, so portal-hopping never refreshes a
 * node early (this supersedes the crafting wave's "depleted state is
 * NOT persisted" note — that note predates timed respawn, under which
 * non-persistence would make the table meaningless).
 */
export interface NodeDef {
  /** prompt + UI label */
  label: string;
  /** material item id granted on harvest */
  materialId: string;
  /** yield = base + rng.int(0, variance), deterministic per node */
  yieldBase: number;
  yieldVariance: number;
  /** seconds from full collapse to regrow start */
  respawnSeconds: number;
  /** minimap marker color (Minimap.ts reads this table) */
  minimapColor: string;
}

export const NODE_DEFS = {
  ore: { label: 'ore vein', materialId: MAT_ORE, yieldBase: 2, yieldVariance: 1, respawnSeconds: 120, minimapColor: '#eab308' },
  fiber: { label: 'fiber thicket', materialId: MAT_FIBER, yieldBase: 2, yieldVariance: 1, respawnSeconds: 90, minimapColor: '#a3e635' },
  herb: { label: 'herb patch', materialId: MAT_HERB, yieldBase: 2, yieldVariance: 1, respawnSeconds: 45, minimapColor: '#34d399' },
  crystal: { label: 'crystal cluster', materialId: MAT_CRYSTAL, yieldBase: 1, yieldVariance: 1, respawnSeconds: 180, minimapColor: '#67e8f9' },
  scrap: { label: 'salvage cache', materialId: MAT_SCRAP, yieldBase: 1, yieldVariance: 1, respawnSeconds: 120, minimapColor: '#fb923c' },
} as const satisfies Record<string, NodeDef>;

export type NodeKind = keyof typeof NODE_DEFS;
const NODE_KINDS: NodeKind[] = ['ore', 'fiber', 'herb', 'crystal', 'scrap'];

/**
 * Material item ids — FIXED CONTRACT defined by workstream A
 * (engine/game/crafting: MAT_*). Do not rename. Derived from NODE_DEFS
 * so the kind->material map can never drift from the tuning table.
 */
export const MATERIAL_IDS = {
  ore: MAT_ORE,
  fiber: MAT_FIBER,
  herb: MAT_HERB,
  crystal: MAT_CRYSTAL,
  scrap: MAT_SCRAP,
} as const;

/** Depletion collapse / regrow duration (seconds) — shrink/grow, never pop. */
const DEPLETE_TIME = 0.6;

/** Default node count per map (before density scaling). Gathering-nodes
 * phase: 30, not 18 — the kind count grew from 3 to 5, and holding 18
 * would starve each kind (the 18-node split left only 2 fiber nodes,
 * below the crafting spec's fiber quota). 30 restores ~6 nodes per kind,
 * the density the crafting wave shipped with. */
export const DEFAULT_NODE_COUNT = 30;

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
  /**
   * Multiplier on NODE_DEFS respawnSeconds (default 1). Deterministic —
   * tests accelerate regrow with it; production never sets it.
   */
  respawnScale?: number;
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

/** Herb patch: low leafy tufts on a soil mound + amber buds. Reuses the
 *  stem/leaf roles (no new emissive roles, no new buckets). */
function buildHerbPatch(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 0.9, 0.16, 0.8, p.rockDark, 0.9, 0, 0.08, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + ctx.rng.next() * 0.5;
    const r = 0.22 + ctx.rng.next() * 0.12;
    voxelPart(ctx, g, 0.1, 0.55, 0.1, p.stem, 0.75,
      Math.cos(a) * r, 0.35, Math.sin(a) * r, { rotZ: Math.cos(a) * 0.35 });
    voxelPart(ctx, g, 0.22, 0.14, 0.22, p.leaf, 0.75,
      Math.cos(a) * r, 0.62, Math.sin(a) * r, { rotY: a });
  }
  // amber buds — the signature glow accent
  voxelPart(ctx, g, 0.13, 0.13, 0.13, '', 0.3, 0.1, 0.7, 0.05, { amber: true });
  voxelPart(ctx, g, 0.13, 0.13, 0.13, '', 0.3, -0.15, 0.65, -0.1, { amber: true });
}

/** Crystal cluster: rock base + tall amber crystal shards. Reuses the
 *  rock/amber roles only — the shards read as crystal by silhouette,
 *  not by a new material role. */
function buildCrystalCluster(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.1, 0.3, 1.0, p.rockDark, 0.9, 0, 0.15, 0);
  voxelPart(ctx, g, 0.16, 1.1, 0.16, '', 0.3, 0, 0.85, 0, { rotZ: 0.12 });
  voxelPart(ctx, g, 0.14, 0.85, 0.14, '', 0.3, 0.3, 0.7, 0.2, { rotZ: -0.3, rotX: 0.15 });
  voxelPart(ctx, g, 0.14, 0.75, 0.14, '', 0.3, -0.3, 0.65, -0.15, { rotZ: 0.35, rotX: -0.2 });
  voxelPart(ctx, g, 0.11, 0.6, 0.11, '', 0.3, 0.15, 0.55, -0.3, { rotZ: -0.15, rotX: 0.3 });
  voxelPart(ctx, g, 0.11, 0.5, 0.11, '', 0.3, -0.2, 0.5, 0.3, { rotZ: 0.2, rotX: -0.1 });
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

/** Node lifecycle: live -> depleting (collapse) -> awaiting (respawn
 *  wait) -> regrowing (scale-up) -> live. Awaiting nodes are invisible
 *  (unsubmitted); regrowing nodes are visible but not yet promptable. */
export type GatherNodeState = 'live' | 'depleting' | 'awaiting' | 'regrowing';

/** update() transition events the manager acts on. */
export type GatherNodeEvent = 'collapsed' | 'regrowing' | 'regrown' | null;

export class GatherNode {
  readonly kind: NodeKind;
  readonly root = new THREE.Group();
  readonly interactable: Interactable;
  /** true once the manager has fully retired this node (instancer + registry) */
  retired = false;

  private readonly rng: Rng;
  private readonly baseScale: number;
  private readonly respawnSeconds: number;
  private state: GatherNodeState = 'live';
  private depleteT = 0;
  private awaitT = 0;
  private regrowT = 0;

  /** The instancible render root — the owner-agnostic registerEnemy({ renderRoot }) path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  /** Current lifecycle state (manager + session read this, never set it). */
  get nodeState(): GatherNodeState {
    return this.state;
  }

  constructor(
    private readonly engine: Engine,
    kind: NodeKind,
    position: THREE.Vector3,
    index: number,
    mapSeed: number,
    opts: { respawnScale?: number } = {},
  ) {
    this.kind = kind;
    // per-node rng: deterministic yield + deterministic build jitter,
    // seeded off (mapSeed, GATHER_SALT, index) — never engine.rng
    this.rng = new Rng(((mapSeed ^ GATHER_SALT ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0));
    this.respawnSeconds = NODE_DEFS[kind].respawnSeconds * (opts.respawnScale ?? 1);
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: this.rng.fork(0xbeef),
    };
    if (kind === 'ore') buildOreVein(ctx, this.root);
    else if (kind === 'fiber') buildFiberPlant(ctx, this.root);
    else if (kind === 'herb') buildHerbPatch(ctx, this.root);
    else if (kind === 'crystal') buildCrystalCluster(ctx, this.root);
    else buildSalvageCache(ctx, this.root);
    // per-node silhouette variety: rotation + slight uniform scale —
    // instance matrices, never unique geometry. NOTE: these two draws
    // run before any harvest draw, so the yield below is a pure
    // function of (mapSeed, index, kind) — the e2e replication relies
    // on this exact draw order.
    this.root.rotation.y = this.rng.range(0, Math.PI * 2);
    this.baseScale = this.rng.range(0.9, 1.15);
    this.root.scale.setScalar(this.baseScale);
    this.root.position.copy(position);

    const label = NODE_DEFS[kind].label;
    this.interactable = {
      id: `node-${kind}-${(mapSeed >>> 0).toString(16)}-${index}`,
      type: 'node',
      position: position.clone().add(new THREE.Vector3(0, 1, 0)),
      radius: 3,
      enabled: true,
      prompt: kind === 'scrap' ? `Salvage ${label}` : `Harvest ${label}`,
    };
  }

  /** True unless the node is live and harvestable (collapse, wait and regrow all block). */
  get isDepleted(): boolean {
    return this.state !== 'live';
  }

  /** Collapse progress 0..1 (the harvest "progress": 0 live, 1 fully collapsed). */
  get depleteProgress(): number {
    if (this.state === 'live') return 0;
    if (this.state === 'depleting') return Math.min(1, this.depleteT / DEPLETE_TIME);
    return 1;
  }

  /** Seconds left before regrow starts (0 when live/depleting/regrowing). */
  get regrowRemaining(): number {
    return this.state === 'awaiting' ? Math.max(0, this.awaitT) : 0;
  }

  /** Effective respawn wait for this node (table value x respawnScale). */
  get respawnTotal(): number {
    return this.respawnSeconds;
  }

  /**
   * Harvest the node: starts the collapse animation and returns the
   * material grant. Null when not live (double-harvest is a no-op —
   * the prompt is disabled at the same moment).
   */
  harvest(): { materialId: string; count: number } | null {
    if (this.state !== 'live') return null;
    this.state = 'depleting';
    this.depleteT = 0;
    this.interactable.enabled = false;
    const def = NODE_DEFS[this.kind];
    return { materialId: def.materialId, count: def.yieldBase + this.rng.int(0, def.yieldVariance) };
  }

  /**
   * Portal restore: re-enter a map with this node still waiting out its
   * respawn (snapshot from the manager). The node sits collapsed and
   * invisible until its remaining wait elapses, then regrows normally.
   */
  restoreAwaiting(remainingSeconds: number): void {
    this.state = 'awaiting';
    this.awaitT = Math.max(0, remainingSeconds);
    this.retired = true;
    this.interactable.enabled = false;
    this.root.scale.setScalar(0.001);
  }

  /**
   * Tick the lifecycle. Returns the transition event for the manager:
   * 'collapsed' (retire: unregister instancer + registry),
   * 'regrowing' (re-register instancer so the scale-up is visible),
   * 'regrown' (re-register interactable, harvestable again).
   * Ease-in shrink/grow: continuous, no pop.
   */
  update(dt: number): GatherNodeEvent {
    if (this.state === 'depleting') {
      this.depleteT += dt;
      const k = Math.min(1, this.depleteT / DEPLETE_TIME);
      this.root.scale.setScalar(Math.max(0.001, this.baseScale * (1 - k * k)));
      if (k >= 1) {
        this.state = 'awaiting';
        this.awaitT = this.respawnSeconds;
        return 'collapsed';
      }
      return null;
    }
    if (this.state === 'awaiting') {
      this.awaitT -= dt;
      if (this.awaitT <= 0) {
        this.state = 'regrowing';
        this.regrowT = 0;
        return 'regrowing';
      }
      return null;
    }
    if (this.state === 'regrowing') {
      this.regrowT += dt;
      const k = Math.min(1, this.regrowT / DEPLETE_TIME);
      this.root.scale.setScalar(Math.max(0.001, this.baseScale * k * k));
      if (k >= 1) {
        this.state = 'live';
        this.root.scale.setScalar(this.baseScale);
        this.interactable.enabled = true;
        return 'regrown';
      }
      return null;
    }
    return null;
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
  /** mapSeed of the currently spawned roster (null before the first spawn) */
  private currentSeed: number | null = null;
  /**
   * Portal-preserved respawn state: mapSeed -> node interactable id ->
   * remaining await seconds. Written by despawnAll, read by spawnForMap.
   * A node absent from the map (or mapped to <= 0) respawns live.
   */
  private savedAwait = new Map<number, Map<string, number>>();

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
    this.currentSeed = mapSeed;
    const rng = new Rng((mapSeed ^ GATHER_SALT) >>> 0);
    const count = this.opts.count
      ?? Math.round(DEFAULT_NODE_COUNT * (this.opts.density ?? 1));
    const anchors = this.resolveAnchors(mapSeed);
    const restored = this.savedAwait.get(mapSeed);
    const live: GatherNode[] = [];
    for (let i = 0; i < count; i++) {
      const kind = rng.pick(NODE_KINDS);
      const pos = this.placeNode(rng, anchors, i);
      const node = new GatherNode(this.engine, kind, pos, i, mapSeed,
        { respawnScale: this.opts.respawnScale });
      this.engine.scene.add(node.root);
      this.list.push(node);
      // owner-agnostic path: the node only needs { renderRoot }
      this.instancer.registerEnemy(node);
      // Portal-preserved wait: a node harvested before the trip resumes
      // its countdown instead of respawning live. It stays registered
      // with the instancer (sources hidden, nothing submitted) so the
      // regrow path needs no visibility hacks — but it gets NO
      // interactable until it regrows.
      const remaining = restored?.get(node.interactable.id);
      if (remaining !== undefined && remaining > 0) {
        node.restoreAwaiting(remaining);
        continue;
      }
      live.push(node);
    }
    registerGatheringInteractables(this.engine, live);
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
    // Snapshot respawn state BEFORE clearing: awaiting nodes keep their
    // remaining wait; mid-collapse nodes restart the full wait (collapse
    // progress is animation, not state); regrowing nodes return live
    // (their wait already elapsed). Live nodes map to nothing = live.
    // An empty despawn (e.g. spawnForMap's self-clean right after a
    // manual despawnAll) must NOT overwrite a saved snapshot — there is
    // no roster here to snapshot, and wiping it would lose the trip's
    // preserved waits.
    if (this.currentSeed !== null && this.list.length > 0) {
      const snap = new Map<string, number>();
      for (const n of this.list) {
        if (n.nodeState === 'awaiting') snap.set(n.interactable.id, n.regrowRemaining);
        else if (n.nodeState === 'depleting') snap.set(n.interactable.id, n.respawnTotal);
      }
      this.savedAwait.set(this.currentSeed, snap);
    }
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
      const ev = n.update(dt);
      if (ev === 'collapsed') {
        // Collapse finished: retire the node — per-entity unregister from
        // the shared instancer + drop the interactable. Never reset().
        this.instancer.unregister(n);
        unregisterGatheringInteractables(this.engine, [n]);
        n.retired = true;
        continue;
      }
      if (ev === 'regrowing') {
        // Wait elapsed: re-register so the scale-up is visible. The
        // interactable stays down until 'regrown' (no harvesting a
        // half-grown node).
        this.instancer.registerEnemy(n);
      } else if (ev === 'regrown') {
        registerGatheringInteractables(this.engine, [n]);
        n.retired = false;
      }
      // Awaiting nodes are the only ones never submitted (invisible);
      // live, depleting and regrowing nodes all draw.
      if (n.nodeState !== 'awaiting') this.instancer.submit(n);
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
