/**
 * UPGRADE LOOP (deployables): deployable field items — campfire, spike
 * trap, lure totem. Player-crafted (recipes ride the crafting catalog),
 * deployed with the `deploy` action (G / Digit3 / DEPLOY touch button),
 * world-space placement near the player, time-limited auras with seeded
 * effect ticks.
 *
 * DETERMINISM: everything seeded derives from (mapSeed, deployIndex,
 * tickIndex) via Rng — never engine.rng, never Math.random, never
 * Date.now. Same deploy sequence on the same map -> identical placements
 * and identical tick magnitudes.
 *
 * RENDERING: deployables ride the shared per-engine NpcInstancer through
 * the owner-agnostic registerEnemy({ renderRoot }) path (the gathering
 * nodes' pattern). Props use the shared VoxelGeoCache + per-biome
 * palettes; the aura slab uses the existing amber emissive role
 * (amberGlowMaterial(mats, 2.0) — the gathering nodes' accent) so all
 * auras collapse into a small set of shared buckets.
 *
 * PORTAL LIFECYCLE: DeployablesManager implements MapLocalEntitySystem
 * (id 'deployables'). Deployables are player-placed and time-limited —
 * portal departure despawns them and arrival does NOT regenerate them
 * (unlike nodes/enemies, there is no deterministic roster to rebuild;
 * the consumed items are already gone from the inventory). Documented
 * as the design.
 *
 * ENEMY CONTRACT: untouched except the additive `Enemy.lureTarget` hook
 * (null = byte-identical behavior). The manager assigns lureTarget
 * per-frame from live totems and clears it on expiry/despawn — the
 * enemy's chase/attack ranges, facing and ranged aim read the lure point
 * instead of the player while assigned, and melee onPlayerHit is gated
 * off while lured (the enemy mauls the totem, not the player).
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
import { ItemBuilder } from './items/ItemBuilder';
import type { ItemDef } from '@spec';
import type { CraftingRecipe } from './crafting';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import type { Enemy } from './EnemyAI';
import {
  STATUS_TRAP_SALT,
  StatusRoller,
  tryApplyStatus,
} from './statusEffects';

/** Salt for the deploy-placement stream — off the GATHER/ENEMY/CRAFT streams. */
export const DEPLOY_SALT = 0xde9107;

export type DeployEffectKind = 'heal' | 'damage' | 'lure';

/**
 * Data-driven deployable def. ALL tuning lives here — the manager and
 * the e2e/perf harnesses read this table, never magic numbers.
 */
export interface DeployableDef {
  /** stable deployable id */
  id: string;
  /** item id of the crafted deployable (consumed on deploy) */
  itemId: string;
  /** display name */
  name: string;
  effectKind: DeployEffectKind;
  /** effect radius in meters */
  radius: number;
  /** lifetime in seconds */
  duration: number;
  /** per-kind redeploy cooldown in seconds */
  cooldown: number;
  /** seconds between effect ticks (lure has no ticks) */
  tickInterval: number;
  /** base magnitude per tick (heal HP / damage HP) */
  tickMagnitude: number;
  /** seeded +0..variance added to the magnitude per tick */
  tickVariance: number;
  /** max simultaneously live deployables of this kind */
  maxActive: number;
  desc: string;
}

export const DEPLOYABLE_DEFS: readonly DeployableDef[] = [
  {
    id: 'campfire',
    itemId: 'deploy_campfire',
    name: 'Campfire',
    effectKind: 'heal',
    radius: 6,
    duration: 45,
    cooldown: 25,
    tickInterval: 1,
    tickMagnitude: 5,
    tickVariance: 2,
    maxActive: 2,
    desc: 'Heals the player inside its light, 5 HP/s for 45s.',
  },
  {
    id: 'spike_trap',
    itemId: 'deploy_spike_trap',
    name: 'Spike Trap',
    effectKind: 'damage',
    radius: 3.5,
    duration: 30,
    cooldown: 15,
    tickInterval: 0.5,
    tickMagnitude: 8,
    tickVariance: 3,
    maxActive: 4,
    desc: 'Seeded damage ticks to enemies in radius, 2 ticks/s for 30s.',
  },
  {
    id: 'lure_totem',
    itemId: 'deploy_lure_totem',
    name: 'Lure Totem',
    effectKind: 'lure',
    radius: 14,
    duration: 40,
    cooldown: 30,
    tickInterval: 0,
    tickMagnitude: 0,
    tickVariance: 0,
    maxActive: 2,
    desc: 'Draws enemies toward it instead of the player for 40s.',
  },
];

export function deployableDefOf(id: string): DeployableDef | undefined {
  return DEPLOYABLE_DEFS.find((d) => d.id === id);
}

/** Retire (expiry collapse) animation length — shrink, never pop (the node pattern). */
const RETIRE_TIME = 0.5;

// ---------------------------------------------------------------------------
// Item defs + recipes (additive to the crafting wave's tables)
// ---------------------------------------------------------------------------

/** Item defs for the three crafted deployables. Merged into the crafting
 *  defs by crafting.ts's craftedItemDefs() (the loot-tier-2 pattern). */
export function deployableItemDefs(): Record<string, ItemDef> {
  return {
    deploy_campfire: new ItemBuilder('deploy_campfire')
      .named('Campfire Kit')
      .consumable()
      .rarity('uncommon')
      .stackable(5)
      .value(15)
      .description('A bundled campfire. Deploy with G — heals you in its light.')
      .build(),
    deploy_spike_trap: new ItemBuilder('deploy_spike_trap')
      .named('Spike Trap Kit')
      .consumable()
      .rarity('uncommon')
      .stackable(5)
      .value(20)
      .description('A folded spike plate. Deploy with G — shreds enemies that step in.')
      .build(),
    deploy_lure_totem: new ItemBuilder('deploy_lure_totem')
      .named('Lure Totem Kit')
      .consumable()
      .rarity('uncommon')
      .stackable(5)
      .value(25)
      .description('A carved decoy totem. Deploy with G — enemies hunt it, not you.')
      .build(),
  };
}

/**
 * Crafting recipes for the deployables. Tier-1 materials only
 * (mat_ore/mat_fiber/mat_scrap), hand-crafted anywhere (no station), no
 * level/skill gates — field items are utility, always reachable.
 * alwaysInPool: true so the seeded recipe-pool subset can never lock
 * them out (the master-crafting rank-3 precedent).
 */
export const DEPLOY_CATALOG_RECIPES: readonly CraftingRecipe[] = [
  {
    id: 'recipe_deploy_campfire',
    name: 'Campfire Kit',
    ingredients: [
      { itemId: 'mat_fiber', count: 2 },
      { itemId: 'mat_scrap', count: 1 },
    ],
    output: { itemId: 'deploy_campfire', count: 1 },
    alwaysInPool: true,
  },
  {
    id: 'recipe_deploy_spike_trap',
    name: 'Spike Trap Kit',
    ingredients: [
      { itemId: 'mat_scrap', count: 2 },
      { itemId: 'mat_ore', count: 2 },
    ],
    output: { itemId: 'deploy_spike_trap', count: 1 },
    alwaysInPool: true,
  },
  {
    id: 'recipe_deploy_lure_totem',
    name: 'Lure Totem Kit',
    ingredients: [
      { itemId: 'mat_fiber', count: 3 },
      { itemId: 'mat_ore', count: 2 },
    ],
    output: { itemId: 'deploy_lure_totem', count: 1 },
    alwaysInPool: true,
  },
];

/**
 * Pure seeded tick magnitude: base + rng.int(0, variance) off
 * (seed, tickIndex). The manager uses this for every effect tick; the
 * e2e harness recomputes exact expected values with the same function
 * (exposed via the deployTest seam).
 */
export function rollDeployTickMagnitude(
  def: DeployableDef,
  seed: number,
  tickIndex: number,
): number {
  const rng = new Rng((seed ^ Math.imul(tickIndex + 1, 0x9e3779b1)) >>> 0);
  return def.tickMagnitude + rng.int(0, def.tickVariance);
}

// ---------------------------------------------------------------------------
// Voxel builders — blocky props, deterministic jitter from the deploy rng
// ---------------------------------------------------------------------------

interface BuildCtx extends VoxelBuildCtx {
  pal: VoxelPalette;
  rng: Rng;
}

/** Aura slab: the shared amber emissive role (gathering's accent). Dims
 *  differ per kind (radius-driven), so each kind owns one amber bucket —
 *  disclosed in the perf table. */
function buildAura(ctx: BuildCtx, g: THREE.Group, radius: number): void {
  const d = Math.round(radius * 2 * 2) / 2; // 0.5-quantized, stable cache keys
  voxelPart(ctx, g, d, 0.08, d, '', 0.3, 0, 0.05, 0, { amber: true, shadow: false });
}

function buildCampfireProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  // stone ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + ctx.rng.range(-0.1, 0.1);
    voxelPart(ctx, g, 0.34, 0.3, 0.34, p.rockDark, 0.9,
      Math.cos(a) * 0.85, 0.15, Math.sin(a) * 0.85, { rotY: a });
  }
  // crossed logs
  voxelPart(ctx, g, 1.1, 0.22, 0.22, p.wood, 0.9, 0, 0.25, 0, { rotY: 0.5 });
  voxelPart(ctx, g, 1.1, 0.22, 0.22, p.woodDark, 0.9, 0, 0.35, 0, { rotY: -0.6 });
  // flame — the amber accent
  voxelPart(ctx, g, 0.28, 0.55, 0.28, '', 0.3, 0, 0.7, 0, { amber: true, rotY: 0.3 });
  voxelPart(ctx, g, 0.16, 0.35, 0.16, '', 0.3, 0.12, 0.55, -0.08, { amber: true, rotZ: 0.25 });
}

function buildSpikeTrapProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.7, 0.16, 1.7, p.woodDark, 0.9, 0, 0.08, 0);
  voxelPart(ctx, g, 1.85, 0.1, 1.85, p.metal, 0.6, 0, 0.2, 0);
  // spikes — deterministic tilt jitter, instance matrices only
  const offs: Array<[number, number]> = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]];
  for (const [ox, oz] of offs) {
    voxelPart(ctx, g, 0.16, 0.75, 0.16, p.metal, 0.55, ox, 0.55, oz,
      { rotX: ctx.rng.range(-0.12, 0.12), rotZ: ctx.rng.range(-0.12, 0.12) });
  }
  // amber trip-wire glints
  voxelPart(ctx, g, 1.7, 0.06, 0.06, '', 0.3, 0, 0.28, 0.8, { amber: true, shadow: false });
  voxelPart(ctx, g, 1.7, 0.06, 0.06, '', 0.3, 0, 0.28, -0.8, { amber: true, shadow: false });
}

function buildLureTotemProp(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 0.7, 0.25, 0.7, p.rockDark, 0.9, 0, 0.12, 0);
  voxelPart(ctx, g, 0.3, 2.1, 0.3, p.woodDark, 0.9, 0, 1.25, 0);
  voxelPart(ctx, g, 1.25, 0.24, 0.24, p.wood, 0.9, 0, 1.7, 0);
  // carved skull
  voxelPart(ctx, g, 0.52, 0.52, 0.52, p.rock, 0.85, 0, 2.55, 0, { rotY: 0.4 });
  // amber eyes — the signature glow accent
  voxelPart(ctx, g, 0.13, 0.13, 0.13, '', 0.3, -0.14, 2.6, 0.24, { amber: true, shadow: false });
  voxelPart(ctx, g, 0.13, 0.13, 0.13, '', 0.3, 0.14, 2.6, 0.24, { amber: true, shadow: false });
}

// ---------------------------------------------------------------------------
// Deployable — one live placed item
// ---------------------------------------------------------------------------

export class Deployable {
  readonly def: DeployableDef;
  readonly root = new THREE.Group();
  /** deterministic stream seed for placement + tick rolls */
  readonly seed: number;
  readonly expiresAt: number;
  /** effect ticks applied so far (heal/damage kinds) */
  tickIndex = 0;
  /** cumulative applied magnitude (exact, for e2e assertions) */
  totalApplied = 0;
  /** true once the retire collapse has started */
  retiring = false;

  private nextTickAt: number;
  private retireT = 0;
  private readonly baseScale: number;

  /** The instancible render root — the owner-agnostic registerEnemy({ renderRoot }) path. */
  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  constructor(
    engine: Engine,
    def: DeployableDef,
    position: THREE.Vector3,
    index: number,
    mapSeed: number,
    now: number,
  ) {
    this.def = def;
    this.seed = ((mapSeed ^ DEPLOY_SALT ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    const rng = new Rng(this.seed);
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: rng.fork(0xd3c0),
    };
    if (def.effectKind === 'heal') buildCampfireProp(ctx, this.root);
    else if (def.effectKind === 'damage') buildSpikeTrapProp(ctx, this.root);
    else buildLureTotemProp(ctx, this.root);
    buildAura(ctx, this.root, def.radius);
    this.root.rotation.y = rng.range(0, Math.PI * 2);
    this.baseScale = rng.range(0.95, 1.08);
    this.root.scale.setScalar(this.baseScale);
    this.root.position.copy(position);
    this.expiresAt = now + def.duration;
    this.nextTickAt = now + def.tickInterval;
  }

  get expired(): boolean {
    return this.retiring;
  }

  /** Roll the next effect tick magnitude (seeded; pure). */
  rollTick(): number {
    return rollDeployTickMagnitude(this.def, this.seed, this.tickIndex);
  }

  /**
   * Advance effect timers. Returns the tick magnitude when a tick fires
   * this frame, else null. Callers apply the magnitude (heal/damage) and
   * add it to totalApplied — this method never touches totalApplied, so
   * out-of-radius schedule advances don't count as applied ticks.
   */
  pollTick(now: number): number | null {
    if (this.retiring || this.def.tickInterval <= 0) return null;
    if (now < this.nextTickAt) return null;
    const mag = this.rollTick();
    this.tickIndex++;
    this.nextTickAt += this.def.tickInterval;
    return mag;
  }

  /** Begin the retire collapse (expiry). Idempotent. */
  startRetire(): void {
    this.retiring = true;
  }

  /**
   * Tick the retire collapse. Returns true when fully collapsed — the
   * manager then unregisters it. Ease-in shrink: continuous, no pop
   * (the gathering-node pattern).
   */
  updateRetire(dt: number): boolean {
    if (!this.retiring) return false;
    this.retireT += dt;
    const k = Math.min(1, this.retireT / RETIRE_TIME);
    this.root.scale.setScalar(Math.max(0.001, this.baseScale * (1 - k * k)));
    return k >= 1;
  }
}

// ---------------------------------------------------------------------------
// DeployablesManager — map-local lifecycle + the deploy action
// ---------------------------------------------------------------------------

export interface DeployablesManagerOpts {
  /** live player position source */
  getPlayerPos: () => THREE.Vector3;
  /** live enemy roster (for damage ticks + lure assignment) */
  getEnemies: () => Enemy[];
  /** heal the player by n HP (blueprint passes avatar.heal) */
  healPlayer: (n: number) => void;
  /**
   * STATUS-EFFECTS: clear the player's statuses when a campfire heal
   * tick lands in radius (the campfire-aura cleanse). Optional — a
   * manager without a status system heals exactly as before.
   */
  clearPlayerStatuses?: () => void;
  /** player feedback (blueprint passes engine.hud.toast) */
  toast: (m: string) => void;
  /** inventory to consume deployable items from (null = deploy disabled) */
  inventory: () => { count(id: string): number; remove(id: string, n?: number): number } | null;
  /** false = the spec disables deployables (crafting off); tryDeploy refuses honestly */
  enabled?: boolean;
  /** current map seed for the placement stream (updated on spawnForMap) */
  mapSeed?: number;
}

export interface DeployResult {
  ok: boolean;
  /** the deployed kind, or null when nothing was deployed */
  kind: string | null;
  /** human-readable reason when !ok */
  reason?: string;
}

export class DeployablesManager implements MapLocalEntitySystem {
  readonly id = 'deployables';
  private readonly opts: DeployablesManagerOpts;
  private readonly instancer: NpcInstancer;
  private readonly enabled: boolean;
  private live: Deployable[] = [];
  private readonly lastDeployedAt = new Map<string, number>();
  /** round-robin cursor over DEPLOYABLE_DEFS */
  private cursor = 0;
  /** per-map deploy counter feeding the placement stream */
  private deployIndex = 0;
  private mapSeed: number;
  private readonly scratch = new THREE.Vector3();
  /**
   * STATUS-EFFECTS: dedicated seeded stream for spike-trap poison
   * rolls (mapSeed ^ STATUS_TRAP_SALT, re-seeded on every spawnForMap
   * like the loot stream — the trap roll sequence never disturbs the
   * deploy tick magnitudes, which derive from (seed, tickIndex)).
   */
  private statusRoller: StatusRoller;

  constructor(private readonly engine: Engine, opts: DeployablesManagerOpts) {
    this.opts = opts;
    this.enabled = opts.enabled ?? true;
    this.mapSeed = opts.mapSeed ?? engine.spec.meta.seed;
    this.statusRoller = new StatusRoller((this.mapSeed ^ STATUS_TRAP_SALT) >>> 0);
    // the per-engine singleton — buckets shared with NPCs/enemies/nodes
    this.instancer = NpcInstancer.for(engine);
  }

  /** Live deployables (read-only view). */
  get deployables(): readonly Deployable[] {
    return this.live;
  }

  /**
   * The deploy action: deploys the next owned deployable kind
   * (round-robin over DEPLOYABLE_DEFS, skipping kinds with zero stock,
   * on cooldown, or at the live cap). Consumes one unit from the
   * inventory. Placement is a seeded-safe position near the player
   * (seeded angle/distance jitter, grounded via terrain.heightAt,
   * in-bounds checked with retries).
   */
  tryDeploy(): DeployResult {
    if (!this.enabled) {
      return { ok: false, kind: null, reason: 'Deployables are disabled for this spec.' };
    }
    const inv = this.opts.inventory();
    if (!inv) {
      return { ok: false, kind: null, reason: 'No inventory — cannot deploy.' };
    }
    const now = this.engine.time;
    // round-robin: find the next deployable kind with stock, off cooldown,
    // and under the live cap.
    let picked: DeployableDef | null = null;
    let skipReason: string | undefined;
    for (let i = 0; i < DEPLOYABLE_DEFS.length; i++) {
      const def = DEPLOYABLE_DEFS[(this.cursor + i) % DEPLOYABLE_DEFS.length];
      if (inv.count(def.itemId) <= 0) continue;
      const last = this.lastDeployedAt.get(def.id) ?? -Infinity;
      if (now - last < def.cooldown) {
        skipReason = `${def.name} recharging (${Math.ceil(def.cooldown - (now - last))}s)`;
        continue;
      }
      const active = this.live.filter((d) => d.def.id === def.id && !d.retiring).length;
      if (active >= def.maxActive) {
        skipReason = `${def.name} at cap (${def.maxActive} live)`;
        continue;
      }
      picked = def;
      this.cursor = (this.cursor + i + 1) % DEPLOYABLE_DEFS.length;
      break;
    }
    if (!picked) {
      const anyStock = DEPLOYABLE_DEFS.some((d) => inv.count(d.itemId) > 0);
      const reason = skipReason
        ?? (anyStock ? 'All deployables recharging or at cap.' : 'No deployables in inventory — craft a kit first.');
      this.opts.toast(reason);
      return { ok: false, kind: null, reason };
    }
    const removed = inv.remove(picked.itemId, 1);
    if (removed < 1) {
      return { ok: false, kind: null, reason: `Inventory refused to release ${picked.itemId}.` };
    }
    const pos = this.placeNearPlayer(this.opts.getPlayerPos());
    const d = new Deployable(this.engine, picked, pos, this.deployIndex++, this.mapSeed, now);
    this.engine.scene.add(d.root);
    this.live.push(d);
    // owner-agnostic path: the deployable only needs { renderRoot }
    this.instancer.registerEnemy(d);
    this.lastDeployedAt.set(picked.id, now);
    this.opts.toast(`Deployed ${picked.name}`);
    this.engine.audio?.play('click');
    return { ok: true, kind: picked.id };
  }

  /**
   * Seeded-safe placement near the player: seeded angle + distance
   * jitter off (mapSeed, deployIndex), grounded via terrain.heightAt,
   * in-bounds checked with retries. Same deploy sequence on the same
   * map -> identical placements (given identical player positions).
   */
  private placeNearPlayer(playerPos: THREE.Vector3): THREE.Vector3 {
    const rng = new Rng(
      ((this.mapSeed ^ DEPLOY_SALT ^ 0x9e4 ^ Math.imul(this.deployIndex + 1, 0x9e3779b1)) >>> 0),
    );
    const terrain = this.engine.terrain;
    for (let tries = 0; tries < 8; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const dist = rng.range(2.2, 3.6);
      const x = playerPos.x + Math.cos(a) * dist;
      const z = playerPos.z + Math.sin(a) * dist;
      if (terrain && !terrain.inBounds(x, z)) continue;
      const y = terrain ? (terrain.heightAt(x, z) ?? 0) : 0;
      return new THREE.Vector3(x, y, z);
    }
    const y = terrain ? (terrain.heightAt(playerPos.x, playerPos.z) ?? 0) : 0;
    return new THREE.Vector3(playerPos.x, y, playerPos.z);
  }

  /**
   * Per-frame: expiry, effect ticks (campfire heal / trap damage), lure
   * assignment, instancer submits. MUST run before EnemyManager.update in
   * the blueprint's instancer frame — enemies read lureTarget during
   * their update.
   */
  update(dt: number): void {
    const now = this.engine.time;
    const playerPos = this.opts.getPlayerPos();
    for (const d of [...this.live]) {
      if (!d.retiring && now >= d.expiresAt) d.startRetire();
      if (d.retiring) {
        if (d.updateRetire(dt)) this.removeDeployable(d);
        continue;
      }
      if (d.def.effectKind === 'heal') {
        const mag = d.pollTick(now);
        if (mag !== null && mag > 0 && d.root.position.distanceTo(playerPos) <= d.def.radius) {
          d.totalApplied += mag;
          this.opts.healPlayer(mag);
          // STATUS-EFFECTS: standing in a campfire's light cleanses —
          // the aura clear rides the existing heal tick (one clear per
          // tick at most; clearAll on an empty tracker is a no-op).
          try { this.opts.clearPlayerStatuses?.(); } catch { /* cleanse must never break the frame */ }
        }
      } else if (d.def.effectKind === 'damage') {
        const mag = d.pollTick(now);
        if (mag !== null && mag > 0) {
          let hit = false;
          for (const e of this.opts.getEnemies()) {
            if (!e.alive) continue;
            if (e.position.distanceTo(d.root.position) <= d.def.radius) {
              try { e.damage(mag, d.root.position); hit = true; } catch { /* a trap must never break the frame */ }
              // STATUS-EFFECTS: spike-trap hits may poison (table
              // chance, dedicated stream, after the damage lands).
              tryApplyStatus(e, 'poison', this.statusRoller.next(), now);
            }
          }
          if (hit) d.totalApplied += mag;
        }
      }
      this.instancer.submit(d);
    }
    this.assignLures();
  }

  /**
   * Lure assignment: every frame, clear all lure targets, then assign
   * each live enemy the nearest live totem within its radius. O(E*T),
   * deterministic, no RNG. Clearing first guarantees no stale targets
   * survive totem expiry/despawn.
   */
  private assignLures(): void {
    const enemies = this.opts.getEnemies();
    for (const e of enemies) e.lureTarget = null;
    const totems = this.live.filter((d) => d.def.effectKind === 'lure' && !d.retiring);
    if (!totems.length) return;
    for (const e of enemies) {
      if (!e.alive) continue;
      const ep = e.position;
      let best: Deployable | null = null;
      let bd = Infinity;
      for (const t of totems) {
        const dist = ep.distanceTo(t.root.position);
        if (dist <= t.def.radius && dist < bd) { best = t; bd = dist; }
      }
      if (best) e.lureTarget = best.root.position;
    }
  }

  private removeDeployable(d: Deployable): void {
    const i = this.live.indexOf(d);
    if (i >= 0) this.live.splice(i, 1);
    // per-entity unregister from the SHARED instancer — never reset()
    // (the gathering/enemies-wave-C lesson: reset() would wipe the
    // NPC/enemy/node buckets too).
    try { this.instancer.unregister(d); } catch { /* never strand the rest */ }
    try { this.engine.scene.remove(d.root); } catch { /* never strand the rest */ }
  }

  /**
   * MapLocalEntitySystem departure path: remove every live deployable
   * (instancer unregister + scene removal) and clear any lure targets
   * still assigned to live enemies. Idempotent.
   */
  despawnAll(): void {
    for (const d of [...this.live]) this.removeDeployable(d);
    this.live = [];
    for (const e of this.opts.getEnemies()) e.lureTarget = null;
  }

  /**
   * MapLocalEntitySystem arrival path: deployables are player-placed and
   * time-limited — portal arrival does NOT regenerate them (there is no
   * deterministic roster to rebuild; the consumed items are already gone
   * from the inventory). The arrival only refreshes the placement seed
   * and resets the per-map deploy counter. Any stale live deployables
   * are despawned first (idempotent, like every other system).
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    this.mapSeed = mapSeed;
    this.deployIndex = 0;
    // STATUS-EFFECTS: fresh map, fresh trap-status stream.
    this.statusRoller = new StatusRoller((mapSeed ^ STATUS_TRAP_SALT) >>> 0);
  }
}
