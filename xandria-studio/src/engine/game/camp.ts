/**
 * UPGRADE LOOP (player-camp): the player camp/base — one camp site per
 * map, data-driven structures, player-scoped storage chest, rest point,
 * workbench buff, minimap marker.
 *
 * Built on the deployables + save-slots waves:
 * - Site placement follows the deployables/gathering pattern: a seeded
 *   position from Rng(mapSeed ^ CAMP_SALT), grounded via terrain.heightAt,
 *   in-bounds checked with retries. "Discovered on arrival": the site
 *   marker + tent prop appear with spawnForMap, no scouting required.
 * - Structures are data-driven (CAMP_STRUCTURE_DEFS) and paid for with
 *   the existing tier-1 materials (mat_ore/mat_fiber/mat_scrap) through
 *   the inventory's remove() primitive — additive to the craft system,
 *   no contract changes, no new item types.
 * - The storage chest is PLAYER-SCOPED (one chest inventory for the
 *   player, not per camp): it lives in the save-slot profile
 *   (ProfileData.campChest) so it survives portal travel and save/reload
 *   exactly like merit/achievements. Built structures are per-map
 *   (ProfileData.campBuilt, keyed by map seed) so revisiting a map
 *   restores its camp.
 * - The workbench buff is a player-scoped timed effect (game time):
 *   activating a built workbench grants +10% melee damage for 600s.
 *   It survives portal travel (the manager is blueprint-owned; only its
 *   meshes are map-local) and is NOT persisted across reloads (a buff is
 *   run state, like a campfire aura — documented).
 * - Rendering rides the shared NpcInstancer via the owner-agnostic
 *   registerEnemy({ renderRoot }) path (deployables/stations pattern):
 *   site tent + one voxel prop per built structure, amber accent role
 *   only, zero new materials.
 * - The minimap reads the site observe-only (see Minimap.camp()) — the
 *   camp manager never writes minimap state.
 *
 * PORTAL LIFECYCLE: CampManager implements MapLocalEntitySystem
 * (id 'camp'). Departure despawns meshes + the site interactable;
 * arrival recomputes the identical site from the map seed and rebuilds
 * the persisted structures. The chest contents never despawn (profile).
 *
 * DETERMINISM: site position, structure offsets and prop jitter derive
 * from (mapSeed) alone via Rng — never engine.rng, never Math.random,
 * never Date.now for gameplay (saveProfile's updatedAt is UI metadata,
 * the pre-existing profile precedent).
 *
 * NPC/ENEMY CONTRACT: untouched. The only combat touch is the player's
 * own melee multiplier (blueprint multiplies by workbenchDamageMult(),
 * 1.0 when no buff is active — byte-identical behavior otherwise).
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { NpcInstancer } from './npcInstancing';
import {
  voxelBoxCacheFor,
  paletteFor,
  voxelPart,
  type VoxelPalette,
  type VoxelGeoCache,
  type VoxelBuildCtx,
} from './voxelGeo';
import { loadProfile, saveProfile } from './Profile';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import { InteractionPrompt } from '../ui/InteractionPrompt';
import { CampPanel, type CampPanelSource } from '../ui/CampPanel';

/** Salt for the camp-site stream — off the GATHER/DEPLOY/ENEMY streams. */
export const CAMP_SALT = 0xca7d5;

/** Workbench buff: melee damage multiplier while active. */
export const WORKBENCH_DAMAGE_MULT = 1.1;
/** Workbench buff duration in seconds of game time. */
export const WORKBENCH_BUFF_DURATION_S = 600;
/** Camp site interaction radius in meters. */
export const CAMP_PROMPT_RADIUS = 6;

export interface CampStructureCost {
  itemId: string;
  count: number;
}

export interface CampStructureDef {
  id: string;
  name: string;
  cost: CampStructureCost[];
  desc: string;
}

/**
 * Data-driven camp structures. ALL tuning lives here — the manager, the
 * panel and the tests read this table, never magic numbers.
 */
export const CAMP_STRUCTURE_DEFS: readonly CampStructureDef[] = [
  {
    id: 'chest',
    name: 'Storage Chest',
    cost: [
      { itemId: 'mat_scrap', count: 4 },
      { itemId: 'mat_fiber', count: 2 },
    ],
    desc: 'Player-scoped storage — deposit and withdraw items. Survives portal travel and reload.',
  },
  {
    id: 'workbench',
    name: 'Workbench',
    cost: [
      { itemId: 'mat_ore', count: 4 },
      { itemId: 'mat_scrap', count: 4 },
    ],
    desc: 'Sharpen tools: +10% melee damage for 10 minutes (game time) when activated.',
  },
  {
    id: 'rest',
    name: 'Rest Point',
    cost: [
      { itemId: 'mat_fiber', count: 4 },
      { itemId: 'mat_scrap', count: 2 },
    ],
    desc: 'Rest to restore HP to full, exactly.',
  },
];

export function campStructureDefOf(id: string): CampStructureDef | undefined {
  return CAMP_STRUCTURE_DEFS.find((d) => d.id === id);
}

/** Minimal terrain surface the site placement needs (engine.terrain satisfies it). */
export interface CampTerrainLike {
  size: number;
  inBounds(x: number, z: number): boolean;
  heightAt(x: number, z: number): number | null;
}

/**
 * Pure camp-site position for a map seed: seeded angle + ring radius,
 * grounded via terrain.heightAt, in-bounds checked with retries. Same
 * (mapSeed, terrain) -> identical site. Exported pure so unit tests can
 * assert determinism without an engine.
 */
export function campSitePosition(
  mapSeed: number,
  terrain: CampTerrainLike | null | undefined,
): THREE.Vector3 {
  const rng = new Rng((mapSeed ^ CAMP_SALT) >>> 0);
  const half = terrain ? terrain.size / 2 : 256;
  const minR = 30;
  const maxR = Math.max(60, half * 0.45);
  if (terrain) {
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(minR, maxR);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (!terrain.inBounds(x, z)) continue;
      const y = terrain.heightAt(x, z) ?? 0;
      return new THREE.Vector3(x, y, z);
    }
  }
  // No terrain (headless unit tests) or no in-bounds slot found: fall back
  // to a deterministic ring point, still grounded when terrain exists.
  const a = rng.range(0, Math.PI * 2);
  const d = rng.range(minR, maxR);
  const x = Math.cos(a) * d;
  const z = Math.sin(a) * d;
  const y = terrain ? (terrain.heightAt(x, z) ?? 0) : 0;
  return new THREE.Vector3(x, y, z);
}

/** Seeded structure offsets around the site (deterministic per map seed). */
function structureOffset(id: string, mapSeed: number): [number, number] {
  const base: Record<string, [number, number]> = {
    chest: [2.6, 1.8],
    workbench: [-2.8, 1.2],
    rest: [0.2, -3.2],
  };
  const b = base[id] ?? [0, 0];
  const rng = new Rng((mapSeed ^ CAMP_SALT ^ 0x51e) >>> 0);
  return [b[0] + rng.range(-0.3, 0.3), b[1] + rng.range(-0.3, 0.3)];
}

// ---------------------------------------------------------------------------
// Voxel builders — blocky props, deterministic jitter from the site rng
// ---------------------------------------------------------------------------

interface BuildCtx extends VoxelBuildCtx {
  pal: VoxelPalette;
  rng: Rng;
}

function buildSiteTent(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  // stone fire ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    voxelPart(ctx, g, 0.34, 0.3, 0.34, p.rockDark, 0.9, Math.cos(a) * 0.85, 0.15, Math.sin(a) * 0.85, { rotY: a });
  }
  // crossed tent poles + canvas slabs
  voxelPart(ctx, g, 0.18, 2.2, 0.18, p.woodDark, 0.9, -0.9, 1.1, 0, { rotZ: 0.5 });
  voxelPart(ctx, g, 0.18, 2.2, 0.18, p.woodDark, 0.9, 0.9, 1.1, 0, { rotZ: -0.5 });
  voxelPart(ctx, g, 2.2, 0.12, 1.6, p.wood, 0.9, 0, 1.9, 0, { rotY: 0.2 });
  // amber fire glint — the shared accent role, zero new materials
  voxelPart(ctx, g, 0.28, 0.5, 0.28, '', 0.3, 0, 0.6, 0, { amber: true, shadow: false });
}

function buildChestProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.4, 0.7, 0.9, p.woodDark, 0.9, 0, 0.35, 0);
  voxelPart(ctx, g, 1.4, 0.3, 0.9, p.wood, 0.9, 0, 0.85, 0);
  voxelPart(ctx, g, 0.2, 0.15, 0.2, p.metal, 0.6, 0, 0.95, 0.46);
  voxelPart(ctx, g, 1.44, 0.1, 0.94, p.metal, 0.6, 0, 0.12, 0);
}

function buildWorkbenchProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.8, 0.18, 0.9, p.wood, 0.9, 0, 0.95, 0);
  for (const [lx, lz] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]] as const) {
    voxelPart(ctx, g, 0.16, 0.95, 0.16, p.woodDark, 0.9, lx, 0.48, lz);
  }
  voxelPart(ctx, g, 1.2, 0.1, 0.5, p.metal, 0.6, 0, 1.08, 0);
  voxelPart(ctx, g, 0.3, 0.3, 0.3, '', 0.3, 0.6, 1.2, 0.2, { amber: true, shadow: false });
}

function buildRestProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.9, 0.18, 0.9, p.woodDark, 0.9, 0, 0.1, 0);
  voxelPart(ctx, g, 1.8, 0.22, 0.8, p.leaf, 0.95, 0, 0.28, 0);
  voxelPart(ctx, g, 0.5, 0.3, 0.7, p.rock, 0.85, -0.6, 0.4, 0, { rotY: 0.3 });
}

// ---------------------------------------------------------------------------
// CampProp — one rendered camp piece (site tent or built structure)
// ---------------------------------------------------------------------------

export class CampProp {
  readonly root = new THREE.Group();
  /** The instancible render root — the owner-agnostic registerEnemy path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  constructor(
    engine: Engine,
    kind: 'site' | string,
    position: THREE.Vector3,
    mapSeed: number,
  ) {
    const rng = new Rng((mapSeed ^ CAMP_SALT ^ 0x9e3779b1) >>> 0);
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: rng.fork(0xc4a9),
    };
    if (kind === 'site') buildSiteTent(ctx, this.root);
    else if (kind === 'chest') buildChestProp(ctx, this.root);
    else if (kind === 'workbench') buildWorkbenchProp(ctx, this.root);
    else buildRestProp(ctx, this.root);
    this.root.rotation.y = rng.range(0, Math.PI * 2);
    this.root.position.copy(position);
  }
}

// ---------------------------------------------------------------------------
// CampManager — map-local lifecycle + player-scoped persistence
// ---------------------------------------------------------------------------

export interface CampManagerOpts {
  /** inventory to charge build costs / move chest items (null = camp inert) */
  inventory: () => { count(id: string): number; add(id: string, n?: number): number; remove(id: string, n?: number): number } | null;
  /** restore the player to full HP (blueprint passes avatar.heal(maxHealth)) */
  restoreHealth: () => void;
  /** player feedback (blueprint passes engine.hud.toast) */
  toast: (m: string) => void;
  /** profile persistence hooks (default: the save-slot profile functions) */
  loadProfileFn?: typeof loadProfile;
  saveProfileFn?: typeof saveProfile;
}

export interface CampActionResult {
  ok: boolean;
  reason?: string;
}

export class CampManager implements MapLocalEntitySystem {
  readonly id = 'camp';
  private readonly opts: CampManagerOpts;
  private readonly instancer: NpcInstancer;
  private props: CampProp[] = [];
  private mapSeed = 0;
  private site_: THREE.Vector3 | null = null;
  private discovered_ = false;
  private built_: string[] = [];
  private chest_: Record<string, number> = {};
  /** workbench buff expiry in game time (0 = inactive). Player-scoped: NOT cleared by despawnAll. */
  private buffUntil = 0;

  constructor(private readonly engine: Engine, opts: CampManagerOpts) {
    this.opts = opts;
    this.instancer = NpcInstancer.for(engine);
  }

  /** Current map's camp site (null when no map is live). */
  get site(): THREE.Vector3 | null {
    return this.site_;
  }

  /** True once the current map's site has been placed (arrival discovery). */
  get discovered(): boolean {
    return this.discovered_;
  }

  /** Structure ids built on the current map (persisted per map seed). */
  get built(): readonly string[] {
    return this.built_;
  }

  /** Live view of the player-scoped chest contents (itemId -> count). */
  get chestContents(): Record<string, number> {
    return { ...this.chest_ };
  }

  /** Current map seed (the campBuilt persistence key). */
  get currentMapSeed(): number {
    return this.mapSeed;
  }

  // --- profile persistence (player-scoped chest + per-map built list) ---

  private mapKey(): string {
    return String(this.mapSeed);
  }

  private refreshFromProfile(): void {
    try {
      const load = this.opts.loadProfileFn ?? loadProfile;
      const p = load();
      this.chest_ = { ...(p.campChest ?? {}) };
      const built = (p.campBuilt ?? {})[this.mapKey()];
      this.built_ = Array.isArray(built) ? [...built] : [];
    } catch {
      this.chest_ = {};
      this.built_ = [];
    }
  }

  private persist(): void {
    try {
      const load = this.opts.loadProfileFn ?? loadProfile;
      const save = this.opts.saveProfileFn ?? saveProfile;
      const p = load();
      p.campChest = { ...this.chest_ };
      p.campBuilt = { ...(p.campBuilt ?? {}), [this.mapKey()]: [...this.built_] };
      save(p);
    } catch {
      /* profile persistence is best-effort; the live session state still applies */
    }
  }

  // --- structures ---

  /** Build a structure at the current camp, charging its material cost. */
  buildStructure(id: string): CampActionResult {
    const def = campStructureDefOf(id);
    if (!def) return { ok: false, reason: `Unknown camp structure ${id}.` };
    if (!this.site_) return { ok: false, reason: 'No camp site on this map.' };
    if (this.built_.includes(id)) return { ok: false, reason: `${def.name} is already built.` };
    const inv = this.opts.inventory();
    if (!inv) return { ok: false, reason: 'No inventory — cannot build.' };
    const missing = def.cost.filter((c) => inv.count(c.itemId) < c.count);
    if (missing.length) {
      const detail = missing.map((m) => `${m.itemId}: need ${m.count}, have ${inv.count(m.itemId)}`).join('; ');
      return { ok: false, reason: `Missing materials — ${detail}.` };
    }
    // consume (defensive rollback: a counted remove cannot fail, but never
    // leave a partial consume behind if it ever does).
    const consumed: CampStructureCost[] = [];
    for (const c of def.cost) {
      const removed = inv.remove(c.itemId, c.count);
      consumed.push({ itemId: c.itemId, count: removed });
      if (removed < c.count) {
        for (const r of consumed) inv.add(r.itemId, r.count);
        return { ok: false, reason: 'Materials changed mid-build; nothing consumed.' };
      }
    }
    this.built_.push(id);
    this.persist();
    this.addStructureProp(id);
    this.opts.toast(`${def.name} built at camp`);
    this.engine.audio?.play('click');
    return { ok: true };
  }

  // --- storage chest (player-scoped) ---

  /** Deposit n units from the backpack into the chest. Returns units moved. */
  deposit(itemId: string, count: number): number {
    if (!this.built_.includes('chest')) return 0;
    const inv = this.opts.inventory();
    if (!inv) return 0;
    const removed = inv.remove(itemId, Math.max(0, count));
    if (removed <= 0) return 0;
    this.chest_[itemId] = (this.chest_[itemId] ?? 0) + removed;
    this.persist();
    return removed;
  }

  /**
   * Withdraw n units from the chest into the backpack. Backpack overflow
   * (add() leftover) is refunded to the chest, so a withdraw never loses
   * items. Returns units actually moved into the backpack.
   */
  withdraw(itemId: string, count: number): number {
    if (!this.built_.includes('chest')) return 0;
    const inv = this.opts.inventory();
    if (!inv) return 0;
    const have = this.chest_[itemId] ?? 0;
    const take = Math.min(Math.max(0, count), have);
    if (take <= 0) return 0;
    const leftover = inv.add(itemId, take);
    const moved = take - leftover;
    if (moved <= 0) return 0;
    this.chest_[itemId] = have - moved;
    if (this.chest_[itemId] <= 0) delete this.chest_[itemId];
    this.persist();
    return moved;
  }

  // --- rest + workbench buff ---

  /** Rest at the camp's rest point: HP to full, exactly. */
  rest(): CampActionResult {
    if (!this.built_.includes('rest')) return { ok: false, reason: 'Build the rest point first.' };
    this.opts.restoreHealth();
    this.opts.toast('Rested — HP fully restored');
    return { ok: true };
  }

  /** Activate a built workbench's buff (10 min game time). */
  activateWorkbench(): CampActionResult {
    if (!this.built_.includes('workbench')) return { ok: false, reason: 'Build the workbench first.' };
    this.buffUntil = this.engine.time + WORKBENCH_BUFF_DURATION_S;
    this.opts.toast('Workbench: tools sharpened (+10% melee damage, 10 min)');
    return { ok: true };
  }

  /** True while the workbench buff is live (game time). */
  workbenchBuffActive(): boolean {
    return this.engine.time < this.buffUntil;
  }

  /** Seconds of workbench buff remaining (0 when inactive). */
  workbenchBuffRemaining(): number {
    return Math.max(0, this.buffUntil - this.engine.time);
  }

  /** Melee damage multiplier from the workbench buff (1.0 when inactive). */
  workbenchDamageMult(): number {
    return this.workbenchBuffActive() ? WORKBENCH_DAMAGE_MULT : 1;
  }

  // --- map-local lifecycle ---

  private addStructureProp(id: string): void {
    if (!this.site_) return;
    const [ox, oz] = structureOffset(id, this.mapSeed);
    const pos = this.site_.clone().add(new THREE.Vector3(ox, 0, oz));
    const terrain = this.engine.terrain as unknown as CampTerrainLike | null;
    if (terrain) pos.y = terrain.heightAt(pos.x, pos.z) ?? this.site_.y;
    const prop = new CampProp(this.engine, id, pos, this.mapSeed);
    this.engine.scene.add(prop.root);
    this.props.push(prop);
    this.instancer.registerEnemy(prop);
  }

  /**
   * MapLocalEntitySystem arrival path: despawn any stale payload, place
   * the deterministic site, restore the persisted structures for this
   * map seed, register the site interactable. Idempotent.
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    this.mapSeed = mapSeed;
    this.refreshFromProfile();
    const terrain = this.engine.terrain as unknown as CampTerrainLike | null;
    this.site_ = campSitePosition(mapSeed, terrain);
    this.discovered_ = true;
    const siteProp = new CampProp(this.engine, 'site', this.site_, mapSeed);
    this.engine.scene.add(siteProp.root);
    this.props.push(siteProp);
    this.instancer.registerEnemy(siteProp);
    for (const id of [...this.built_]) this.addStructureProp(id);
    this.engine.npcInteractions.register({
      id: `camp-${mapSeed}`,
      type: 'camp',
      position: this.site_.clone(),
      radius: CAMP_PROMPT_RADIUS,
      enabled: true,
      prompt: 'Visit camp',
    });
  }

  /**
   * MapLocalEntitySystem departure path: remove every live prop (instancer
   * unregister + scene removal) and the site interactable. Idempotent.
   * The workbench buff is player-scoped and intentionally NOT cleared.
   */
  despawnAll(): void {
    for (const p of this.props) {
      try { this.instancer.unregister(p); } catch { /* never strand the rest */ }
      try { this.engine.scene.remove(p.root); } catch { /* never strand the rest */ }
    }
    this.props = [];
    if (this.site_) {
      this.engine.npcInteractions.unregister(`camp-${this.mapSeed}`);
    }
    this.site_ = null;
    this.discovered_ = false;
  }

  /** Submit live props to the shared instancer (blueprint instancer frame). */
  update(): void {
    for (const p of this.props) this.instancer.submit(p);
  }
}

// ---------------------------------------------------------------------------
// CampInteractionSession — the [E] Visit camp prompt + the camp panel
// ---------------------------------------------------------------------------

export interface CampSessionOpts {
  container?: HTMLElement;
  doc?: Document;
  /** false = headless: register the prompt only, no panel (unit tests) */
  enableUi?: boolean;
  /** live player inventory (for the panel's have/need counts) */
  inventory: () => { count(id: string): number } | null;
  /** distinct backpack item ids for the panel's deposit list */
  backpackItems: () => string[];
  /** item display name (falls back to the id) */
  defName: (itemId: string) => string;
  /** true while another modal owns input (station/talk/shop chains) */
  isModalOpen?: () => boolean;
  /** live player position (default: portalsPlayerAvatar) */
  getPlayerPos?: () => THREE.Vector3;
}

const liveCampSessions = new WeakMap<Engine, CampInteractionSession>();

export class CampInteractionSession {
  private prompt: InteractionPrompt | null = null;
  private panel: CampPanel | null = null;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly camp: CampManager,
    private readonly opts: CampSessionOpts,
  ) {
    liveCampSessions.get(engine)?.dispose();
    liveCampSessions.set(engine, this);
    if (opts.enableUi === false) return;
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container ?? engine.container;
    const source: CampPanelSource = {
      structures: () => CAMP_STRUCTURE_DEFS,
      built: () => new Set(this.camp.built),
      inventoryCount: (id) => this.opts.inventory()?.count(id) ?? 0,
      chestContents: () => this.camp.chestContents,
      backpackItems: () => this.opts.backpackItems(),
      defName: (id) => this.opts.defName(id),
      buffRemaining: () => this.camp.workbenchBuffRemaining(),
      onBuild: (id) => {
        const r = this.camp.buildStructure(id);
        return r.ok ? null : (r.reason ?? 'Build failed.');
      },
      onDeposit: (id, n) => this.camp.deposit(id, n),
      onWithdraw: (id, n) => this.camp.withdraw(id, n),
      onRest: () => {
        const r = this.camp.rest();
        return r.ok ? null : (r.reason ?? 'Rest failed.');
      },
      onActivateBuff: () => {
        const r = this.camp.activateWorkbench();
        return r.ok ? null : (r.reason ?? 'Workbench failed.');
      },
    };
    this.panel = new CampPanel(container, source, doc);
    this.prompt = new InteractionPrompt(container, engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      onActivate: (target) => this.openFor(target.id),
      isModalOpen: () => (this.panel?.isOpen ?? false) || (this.opts.isModalOpen?.() ?? false),
    }, doc);
  }

  private playerPos(): THREE.Vector3 {
    return this.opts.getPlayerPos?.()
      ?? this.engine.portalsPlayerAvatar?.ctrl.position
      ?? new THREE.Vector3();
  }

  /** True while the camp panel owns input (blueprints chain this into other prompts). */
  get isPanelOpen(): boolean {
    return this.panel?.isOpen ?? false;
  }

  /** The camp prompt's current target (null = none) — e2e introspection. */
  get promptedCamp(): boolean {
    return this.prompt?.currentTarget?.type === 'camp';
  }

  /** Open the panel for the current camp (the [E] activation path). */
  openFor(interactableId: string): boolean {
    if (!this.panel || !this.camp.site) return false;
    if (!interactableId.startsWith('camp-')) return false;
    this.panel.open();
    return true;
  }

  /** Open the panel directly (e2e / programmatic path). */
  open(): boolean {
    if (!this.panel || !this.camp.site) return false;
    this.panel.open();
    return true;
  }

  /** Per-frame: refresh the [E] prompt. */
  update(): void {
    if (this.disposed) return;
    this.prompt?.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prompt?.dispose();
    this.prompt = null;
    this.panel?.dispose();
    this.panel = null;
    if (liveCampSessions.get(this.engine) === this) liveCampSessions.delete(this.engine);
  }
}
