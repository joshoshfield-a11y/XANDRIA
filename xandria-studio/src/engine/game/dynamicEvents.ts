/**
 * Dynamic-events wave: seeded dynamic world events — ambushes, wandering
 * merchants, supply caches, elite patrols.
 *
 * CONTENT
 * - EVENT_DEFS: the single tuning table — id, type, trigger condition,
 *   rewards, all tuning in one place. Data-driven: spec.custom.events can
 *   disable types and override per-type counts.
 * - planDynamicEvents(mapSeed, spec): PURE scheduler — Rng(mapSeed ^
 *   EVENT_SALT) picks which event instances exist and where. Same mapSeed
 *   -> identical event set (kinds, positions, trigger radii, stock seeds).
 *   Never engine.rng / Math.random / Date.now.
 * - DynamicEventManager: MapLocalEntitySystem (id 'events'). Lifecycle:
 *   toast + pulsing world-space beacon marker on start, completion
 *   condition per type, rewards through the existing loot path
 *   (enemyManager.lootHooks -> itemWorld drops) and inventory.
 * - Wandering merchant: its own NPC + seeded stock via the same seeded
 *   vendor path pattern the vendor-economy wave used (Fisher-Yates subset
 *   of the loot catalog pool, Rng((seed ^ EVENT_SALT ^ hash32(vendorId)))),
 *   with a lightweight barter trade panel (prices in the def's trade-good
 *   material). Stack choice (2026-10-21, still true): the merchant keeps its
 *   barter panel — it is a distinct trade surface from the vendor-economy
 *   shop, not a deferral. The currency-reward deferral IS resolved:
 *   vendor-economy merged to main (707acd1), so ambush/patrol/cache
 *   completions now grant seeded scrap through lootHooks.onCurrency (the
 *   merged wallet path) via grantEventCurrency; the stock builder here
 *   stays algorithm-identical to the vendor path by design.
 *
 * DETERMINISM: positions/kinds/stock/counts are pure functions of
 * mapSeed (+ spec overrides). Ambush/patrol combat outcomes and the patrol
 * activation timer run on wall-clock dt — the same standing as the boss
 * wave's attack scheduler (timing from dt, RNG never from wall clock).
 *
 * CONTRACTS (owned by this wave):
 * - EVENT_SALT is distinct from ENEMY_SALT / NPC_SALT / CRAFT_SALT /
 *   STATION_SALT / GATHER_SALT / LOOT_SALT / BOSS_SALT (pinned by unit
 *   test).
 * - NPC/enemy public behavior contracts are untouched: ambush/patrol
 *   combatants spawn through EnemyManager.spawnOne (the existing public
 *   API), and the merchant is a stock Npc with an [E] Trade prompt —
 *   no behavior fields beyond the public surface.
 * - despawnAll() removes every live payload (beacons, cache node, merchant
 *   npc + instancer entries, triggers, timers) and is idempotent.
 *   Event-spawned combatants are owned by the EnemyManager roster (its
 *   despawnAll sweeps them); this manager only drops its tracking refs.
 */
import * as THREE from 'three';
import type { GameSpec, ItemDef, NpcSpec, EnemySpec, EnemyKind } from '@spec';
import type { Engine } from '../Engine';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import type { Interactable } from './Interaction';
import { Rng, hashString } from '../core/Rng';
import { Npc } from './Npc';
import type { EnemyManager, Enemy, EnemyLootHooks } from './EnemyAI';
import { NpcInstancer } from './npcInstancing';
import { InteractionPrompt } from '../ui/InteractionPrompt';
/**
 * ACCESSIBILITY PASS: beacons resolve through the palette table at
 * announce time; live beacons recolor when the palette changes (see the
 * manager registry below — the manager is blueprint-owned, so Engine
 * reaches it through recolorAllEventBeacons() rather than a handle).
 */
import { beaconColorForType, type DynamicEventTypeId } from './accessibility';
import { voxelBoxCacheFor, voxelPart, paletteFor, type VoxelPalette, type VoxelGeoCache } from './voxelGeo';
import { CURRENCY_SALT } from './economy';


// ---------------------------------------------------------------- salts

/**
 * Salt for the dynamic-event stream off mapSeed. ('EVNT' 0xE1E4 — checked
 * distinct from the other wave salts by unit test.)
 */
export const EVENT_SALT = 0xe1e4;

/**
 * UPGRADE LOOP (blueprint-rollout): pure seeded scrap reward for an event
 * completion, by event type. The per-instance stream (planSeed ^
 * CURRENCY_SALT) keeps event currency independent of completion order and
 * off the item-loot stream. Exported for the e2e replication harness and
 * unit tests.
 */
export function rollEventCurrency(planSeed: number, type: string): number {
  const rng = new Rng((planSeed ^ CURRENCY_SALT) >>> 0);
  return type === 'patrol' ? rng.int(15, 35)
    : type === 'ambush' ? rng.int(10, 25)
    : rng.int(5, 15);
}

/** cache discovery: toast + beacon fire when the player spots the node. */
const CACHE_DISCOVERY_RADIUS = 25;

// ---------------------------------------------------------------- defs

export type DynamicEventType = 'ambush' | 'merchant' | 'cache' | 'patrol';

export type EventTrigger =
  | { kind: 'proximity'; radius: number }
  | { kind: 'onSpawn' }
  | { kind: 'timed'; afterSeconds: number };

export interface EventDef {
  /** stable id, e.g. 'event_ambush'. */
  id: string;
  type: DynamicEventType;
  /** display name used in toasts. */
  name: string;
  /** the one tuning table: trigger, combat, rewards, visuals. */
  trigger: EventTrigger;
  /** combatant spawn (null for non-combat events). */
  combatants: { kind: string; countMin: number; countMax: number; elite: boolean } | null;
  /** completion bonus: N seeded rolls from the loot pool, granted as world drops. */
  completionBonusRolls: number;
  /** cache contents: N seeded rolls granted on open. */
  cacheLootRolls: number;
  /** ringed distance (m) from a POI anchor / origin. */
  ringMin: number;
  ringMax: number;
  /** beacon marker color (hex). */
  beaconColor: string;
  /** merchant trade tuning (null for non-merchant events). */
  merchant: {
    /** the material prices are denominated in (barter, no currency on main). */
    tradeGoodId: string;
    /** buy cost = ceil(value * buyMult) trade goods. */
    buyMult: number;
    /** sell yield = floor(value * sellMult) trade goods. */
    sellMult: number;
    /** max stock lines. */
    maxStock: number;
  } | null;
  /** default instances per map (spec.custom.events.counts overrides). */
  defaultCount: number;
  toastStart: string;
  toastDone: string;
}

/**
 * THE event defs table: id, type, trigger condition, rewards, all tuning.
 * Nothing about an event's behavior is hardcoded in the manager below.
 */
export const EVENT_DEFS: readonly EventDef[] = [
  {
    id: 'event_ambush',
    type: 'ambush',
    name: 'Ambush',
    trigger: { kind: 'proximity', radius: 18 },
    combatants: { kind: 'walker', countMin: 3, countMax: 5, elite: false },
    completionBonusRolls: 2,
    cacheLootRolls: 0,
    ringMin: 45, ringMax: 85,
    beaconColor: '#ff4d3d',
    merchant: null,
    defaultCount: 1,
    toastStart: 'AMBUSH!',
    toastDone: 'Ambush repelled',
  },
  {
    id: 'event_merchant',
    type: 'merchant',
    name: 'Wandering Merchant',
    trigger: { kind: 'onSpawn' },
    combatants: null,
    completionBonusRolls: 0,
    cacheLootRolls: 0,
    ringMin: 30, ringMax: 60,
    beaconColor: '#ffcf7a',
    merchant: {
      tradeGoodId: 'mat_beast_hide',
      buyMult: 1.6,
      sellMult: 0.35,
      maxStock: 6,
    },
    defaultCount: 1,
    toastStart: 'WANDERING MERCHANT',
    toastDone: 'Trade complete',
  },
  {
    id: 'event_cache',
    type: 'cache',
    name: 'Supply Cache',
    trigger: { kind: 'onSpawn' },
    combatants: null,
    completionBonusRolls: 0,
    cacheLootRolls: 3,
    ringMin: 40, ringMax: 80,
    beaconColor: '#7ae2ff',
    merchant: null,
    defaultCount: 1,
    toastStart: 'SUPPLY CACHE SPOTTED',
    toastDone: 'Cache emptied',
  },
  {
    id: 'event_patrol',
    type: 'patrol',
    name: 'Elite Patrol',
    trigger: { kind: 'timed', afterSeconds: 120 },
    combatants: { kind: 'walker', countMin: 3, countMax: 4, elite: true },
    completionBonusRolls: 3,
    cacheLootRolls: 0,
    ringMin: 60, ringMax: 100,
    beaconColor: '#c77aff',
    merchant: null,
    defaultCount: 1,
    toastStart: 'ELITE PATROL INBOUND',
    toastDone: 'Patrol eliminated',
  },
];

/** All four event types covered by the table. */
export const EVENT_TYPE_IDS: readonly DynamicEventType[] = ['ambush', 'merchant', 'cache', 'patrol'];

export function eventDefById(id: string): EventDef | null {
  return EVENT_DEFS.find((d) => d.id === id) ?? null;
}

// ---------------------------------------------------------------- spec overrides

export interface EventsCustom {
  /** false/absent = the whole wave is off (no events spawn). */
  enabled?: boolean;
  /** disable whole event types, e.g. { event_patrol: true }. */
  disabled?: Record<string, boolean>;
  /** per-def instance counts, e.g. { event_cache: 2 }. */
  counts?: Record<string, number>;
}

export function resolveEventsEnabled(spec: GameSpec): boolean {
  return spec.custom?.events?.enabled !== false;
}

export function resolveEventCount(spec: GameSpec, def: EventDef): number {
  const raw = spec.custom?.events?.counts?.[def.id];
  if (raw === undefined) return def.defaultCount;
  if (!Number.isFinite(raw)) return def.defaultCount;
  return Math.max(0, Math.min(4, Math.floor(raw)));
}

export function isEventTypeDisabled(spec: GameSpec, defId: string): boolean {
  return spec.custom?.events?.disabled?.[defId] === true;
}

// ---------------------------------------------------------------- scheduler

export interface PlannedEvent {
  /** the def this instance follows. */
  defId: string;
  /** 0-based instance index within the def. */
  index: number;
  /** per-instance seed: decorrelates every draw this instance makes. */
  seed: number;
  /** world position (grounded). */
  x: number;
  z: number;
}

/**
 * PURE scheduler: the event set for a map is a function of (mapSeed, spec)
 * alone. Same inputs -> identical instances (ids, positions, seeds).
 */
export function planDynamicEvents(
  mapSeed: number,
  spec: GameSpec,
  anchors: readonly { x: number; z: number; r: number }[],
): PlannedEvent[] {
  if (!resolveEventsEnabled(spec)) return [];
  const rng = new Rng((mapSeed ^ EVENT_SALT) >>> 0);
  const out: PlannedEvent[] = [];
  const base = anchors.length > 0 ? anchors : [{ x: 0, z: 0, r: 0 }];
  for (const def of EVENT_DEFS) {
    if (isEventTypeDisabled(spec, def.id)) continue;
    const count = resolveEventCount(spec, def);
    for (let i = 0; i < count; i++) {
      const a = rng.pick(base);
      const ang = rng.range(0, Math.PI * 2);
      const d = a.r + rng.range(def.ringMin, def.ringMax);
      const seed = ((mapSeed ^ EVENT_SALT ^ Math.imul(i + 1, 0x9e3779b9) ^ hashString(def.id)) >>> 0);
      out.push({
        defId: def.id,
        index: i,
        seed,
        x: a.x + Math.cos(ang) * d,
        z: a.z + Math.sin(ang) * d,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- merchant stock

export interface MerchantStockLine {
  itemId: string;
  /** units available on this line. */
  count: number;
  /** buy price in trade-good units. */
  cost: number;
  /** sell yield per unit in trade-good units. */
  yieldPer: number;
}

/**
 * The same seeded vendor path pattern as the vendor-economy wave:
 * Fisher-Yates subset of the loot catalog pool (ids with a finite
 * positive value), priced off the def value. Pure in (def, merchantSeed,
 * defs) — identical inputs, identical stock.
 */
export function buildMerchantStock(
  def: EventDef,
  merchantSeed: number,
  defs: Record<string, ItemDef>,
): MerchantStockLine[] {
  const m = def.merchant;
  if (!m) return [];
  const rng = new Rng((((merchantSeed >>> 0) ^ EVENT_SALT ^ hashString(def.id + ':merchant')) >>> 0));
  const pool = Object.keys(defs).filter((id) => {
    const d = defs[id];
    return d && Number.isFinite(d.value) && (d.value as number) > 0;
  });
  if (pool.length === 0) return [];
  const order = rng.shuffle([...pool]);
  const lines = order.slice(0, Math.max(1, Math.min(m.maxStock, order.length)));
  return lines.map((itemId) => {
    const value = defs[itemId].value as number;
    const count = rng.int(1, 3);
    return {
      itemId,
      count,
      cost: Math.max(1, Math.ceil(value * m.buyMult)),
      yieldPer: Math.max(1, Math.floor(value * m.sellMult)),
    };
  });
}

// ---------------------------------------------------------------- event beacon marker

/**
 * The "map marker": a pulsing world-space beacon — emissive octahedron on
 * a faint vertical pillar — floating above the event. Followed by the
 * manager (merchant/patrol move), removed on completion/departure.
 */
export class EventBeacon {
  readonly group = new THREE.Group();
  private t = 0;
  private readonly gem: THREE.Mesh;
  private readonly pillar: THREE.Mesh;

  /** ACCESSIBILITY PASS: recolor both beacon materials in place (palette change). */
  recolor(colorHex: string): void {
    const color = new THREE.Color(colorHex);
    (this.gem.material as THREE.MeshBasicMaterial).color.copy(color);
    (this.pillar.material as THREE.MeshBasicMaterial).color.copy(color);
  }

  constructor(colorHex: string) {
    const color = new THREE.Color(colorHex);
    const gemGeo = new THREE.OctahedronGeometry(0.55);
    const gemMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    this.gem = new THREE.Mesh(gemGeo, gemMat);
    this.gem.position.y = 4.2;
    const pillarGeo = new THREE.CylinderGeometry(0.09, 0.16, 6.5, 6, 1, true);
    const pillarMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
    });
    this.pillar = new THREE.Mesh(pillarGeo, pillarMat);
    this.pillar.position.y = 3.1;
    this.group.add(this.gem, this.pillar);
  }

  setPosition(p: THREE.Vector3): void {
    this.group.position.set(p.x, p.y, p.z);
  }

  update(dt: number): void {
    this.t += dt;
    const k = 0.5 + 0.5 * Math.sin(this.t * 3.2);
    this.gem.position.y = 4.2 + k * 0.5;
    this.gem.rotation.y = this.t * 1.4;
    (this.gem.material as THREE.MeshBasicMaterial).opacity = 0.7 + k * 0.3;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.gem.geometry.dispose();
    (this.gem.material as THREE.Material).dispose();
    this.pillar.geometry.dispose();
    (this.pillar.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------- cache node

interface BuildCtx {
  engine: Engine;
  geo: VoxelGeoCache;
  pal: VoxelPalette;
  rng: Rng;
}

function buildSupplyCache(ctx: BuildCtx, g: THREE.Group): void {
  const p = ctx.pal;
  voxelPart(ctx, g, 1.05, 0.65, 0.8, p.wood, 0.9, 0, 0.33, 0);
  voxelPart(ctx, g, 1.1, 0.16, 0.85, p.woodDark, 0.9, 0, 0.72, 0);
  voxelPart(ctx, g, 1.12, 0.1, 0.14, p.metal, 0.6, 0, 0.33, 0.22);
  voxelPart(ctx, g, 1.12, 0.1, 0.14, p.metal, 0.6, 0, 0.33, -0.22);
  voxelPart(ctx, g, 0.14, 0.14, 0.14, '', 0.3, 0, 0.85, 0, { amber: true });
}

export class EventCacheNode {
  readonly root = new THREE.Group();
  readonly interactable: Interactable;
  opened = false;
  private openedT = 0;

  get renderRoot(): THREE.Group | null {
    return this.root;
  }

  constructor(engine: Engine, position: THREE.Vector3, instanceId: string) {
    const ctx: BuildCtx = {
      engine,
      geo: voxelBoxCacheFor(engine),
      pal: paletteFor(engine.spec.theme.environment),
      rng: new Rng(hashString(instanceId)),
    };
    buildSupplyCache(ctx, this.root);
    this.root.position.copy(position);
    this.interactable = {
      id: instanceId,
      type: 'event-cache',
      position: position.clone().add(new THREE.Vector3(0, 1, 0)),
      radius: 3,
      enabled: true,
      prompt: 'Open supply cache',
    };
  }

  open(): boolean {
    if (this.opened) return false;
    this.opened = true;
    this.interactable.enabled = false;
    return true;
  }

  /** sink animation; returns true when finished. */
  update(dt: number): boolean {
    if (!this.opened) return false;
    this.openedT += dt;
    const k = Math.min(1, this.openedT / 0.6);
    this.root.position.y -= dt * 1.2;
    this.root.scale.setScalar(Math.max(0.001, 1 - k * 0.9));
    return k >= 1;
  }
}

// ---------------------------------------------------------------- manager

export interface DynamicEventManagerOpts {
  pois?: { x: number; z: number; r: number }[];
  /** the blueprint's enemy roster (ambush/patrol combatants join it). */
  enemyManager: EnemyManager;
  /** the enemy manager's loot hooks (rewards reuse the loot path). */
  lootHooks: EnemyLootHooks | null;
  /** player inventory (cache grants + merchant trade). */
  inventory: { add(itemId: string, count?: number): number; remove(itemId: string, count?: number): number; count(itemId: string): number } | null;
  /** item defs (names/prices for trade + stock pool). */
  defs: () => Record<string, ItemDef>;
  toast: (msg: string) => void;
  getPlayerPos: () => THREE.Vector3;
}

type EventStatus = 'pending' | 'active' | 'done';

export interface LiveEvent {
  plan: PlannedEvent;
  def: EventDef;
  status: EventStatus;
  beacon: EventBeacon | null;
  /** combatants for ambush/patrol (owned by the EnemyManager roster). */
  combatants: Enemy[];
  /** patrol activation countdown (seconds remaining). */
  timer: number;
  cache: EventCacheNode | null;
  merchant: Npc | null;
  merchantInteractable: Interactable | null;
  stock: MerchantStockLine[];
  /** patrol waypoint loop. */
  waypoints: THREE.Vector3[];
  wpIndex: number;
  completedTrade: boolean;
  /** untap fn for the onKill listener (registered at combatant spawn). */
  untapKill: (() => void) | null;
}

/**
 * ACCESSIBILITY PASS: live-manager registry. The manager is
 * blueprint-owned and Engine holds no handle to it, so palette changes
 * reach live beacons through this set (registered on construct,
 * deregistered on despawnAll). Recoloring a stale manager's beacons is
 * harmless — it only sets material colors.
 */
const liveManagers = new Set<DynamicEventManager>();

/** ACCESSIBILITY PASS: recolor every live event beacon to the current palette. */
export function recolorAllEventBeacons(): void {
  for (const m of liveManagers) m.applyPalette();
}

export class DynamicEventManager implements MapLocalEntitySystem {
  readonly id = 'events';
  private readonly opts: DynamicEventManagerOpts;
  private readonly instancer: NpcInstancer;
  private live: LiveEvent[] = [];
  private spawned = false;

  constructor(private readonly engine: Engine, opts: DynamicEventManagerOpts) {
    this.opts = opts;
    this.instancer = NpcInstancer.for(engine);
    liveManagers.add(this);
  }

  /** ACCESSIBILITY PASS: recolor live beacons to the current palette. */
  applyPalette(): void {
    for (const ev of this.live) {
      if (ev.beacon) ev.beacon.recolor(beaconColorForType(ev.def.type as DynamicEventTypeId));
    }
  }

  /** Read-only view for tests / the trade session. */
  get events(): readonly LiveEvent[] {
    return this.live;
  }

  /** Test seam: force-start a pending instance immediately. */
  startEventForTest(defId: string, index = 0): boolean {
    const ev = this.live.find((e) => e.plan.defId === defId && e.plan.index === index && e.status === 'pending');
    if (!ev) return false;
    this.startEvent(ev);
    return true;
  }

  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    if (!resolveEventsEnabled(this.engine.spec)) return;
    const planned = planDynamicEvents(mapSeed, this.engine.spec, this.opts.pois ?? []);
    for (const plan of planned) {
      const def = eventDefById(plan.defId);
      if (!def) continue;
      const ev: LiveEvent = {
        plan, def,
        status: def.type === 'merchant' ? 'active' : 'pending',
        beacon: null,
        combatants: [],
        timer: def.trigger.kind === 'timed' ? def.trigger.afterSeconds : 0,
        cache: null,
        merchant: null,
        merchantInteractable: null,
        stock: [],
        waypoints: [],
        wpIndex: 0,
        completedTrade: false,
        untapKill: null,
      };
      // cache nodes exist before discovery; the toast+beacon fire when the
      // player comes within discovery range (see update()).
      if (def.type === 'cache') this.spawnCache(ev);
      if (def.type === 'merchant') this.spawnMerchant(ev);
      if (ev.status === 'active') this.announce(ev);
      this.live.push(ev);
    }
    this.spawned = true;
  }

  despawnAll(): void {
    liveManagers.delete(this);
    for (const ev of this.live) {
      try { ev.beacon?.dispose(this.engine.scene); } catch { /* never strand */ }
      ev.beacon = null;
      if (ev.cache) {
        try { this.instancer.unregister(ev.cache); } catch { /* never strand */ }
        try { this.engine.scene.remove(ev.cache.root); } catch { /* never strand */ }
        if (ev.cache.interactable) this.unregisterInteractable(ev.cache.interactable.id);
        ev.cache = null;
      }
      if (ev.merchant) {
        try { this.instancer.unregister(ev.merchant); } catch { /* never strand */ }
        try { ev.merchant.dispose(); } catch { /* never strand */ }
        ev.merchant = null;
      }
      if (ev.merchantInteractable) {
        this.unregisterInteractable(ev.merchantInteractable.id);
        ev.merchantInteractable = null;
      }
      ev.combatants = [];
      try { ev.untapKill?.(); } catch { /* never strand */ }
      ev.untapKill = null;
    }
    this.live = [];
    this.spawned = false;
  }

  /** Per-frame: triggers, patrol timing, waypoint wandering, beacons. */
  update(dt: number): void {
    if (!this.spawned) return;
    const playerPos = this.opts.getPlayerPos();
    for (const ev of this.live) {
      if (ev.status === 'pending') {
        const t = ev.def.trigger;
        if (t.kind === 'proximity') {
          const bp = ev.beacon?.group.position ?? this.planPos(ev.plan);
          if (bp.distanceTo(playerPos) <= t.radius) this.startEvent(ev);
        } else if (t.kind === 'timed') {
          ev.timer -= dt;
          if (ev.timer <= 0) this.startEvent(ev);
        } else if (ev.def.type === 'cache' && ev.cache) {
          // cache discovery: toast + beacon when the player spots the node
          if (ev.cache.root.position.distanceTo(playerPos) <= CACHE_DISCOVERY_RADIUS) {
            this.startEvent(ev);
          }
        }
      } else if (ev.status === 'active') {
        if (ev.def.type === 'ambush' || ev.def.type === 'patrol') {
          this.updateCombatants(ev, dt, playerPos);
        }
        if (ev.def.type === 'merchant' && ev.merchant) {
          ev.merchant.update(dt);
          if (ev.merchantInteractable) {
            ev.merchantInteractable.position.copy(ev.merchant.position).add(UP1);
          }
          if (ev.beacon) ev.beacon.setPosition(ev.merchant.position);
        }
      }
      // the cache sink animation runs past completion (status 'done').
      if (ev.cache?.opened && ev.cache.update(dt)) {
        try { this.instancer.unregister(ev.cache); } catch { /* never strand */ }
        try { this.engine.scene.remove(ev.cache.root); } catch { /* never strand */ }
        this.unregisterInteractable(ev.cache.interactable.id);
        ev.cache = null;
      }
      ev.beacon?.update(dt);
    }
    // submit merchant/cache payloads through the shared instancer frame
    // (the blueprint drives beginFrame/endFrame around manager updates).
    for (const ev of this.live) {
      if (ev.merchant) this.instancer.submit(ev.merchant);
      if (ev.cache && !ev.cache.opened) this.instancer.submit(ev.cache);
    }
  }

  /** Open a cache by interactable id. Returns the granted items. */
  openCache(interactableId: string): { itemId: string; count: number }[] | null {
    const ev = this.live.find((e) => e.cache?.interactable.id === interactableId && e.status === 'active');
    if (!ev || !ev.cache || !ev.cache.open()) return null;
    const drops = this.rollReward(ev, ev.def.cacheLootRolls);
    for (const d of drops) {
      this.opts.lootHooks?.onLoot(d, ev.cache!.root.position.clone());
      this.opts.inventory?.add(d.itemId, d.count);
    }
    // UPGRADE LOOP (blueprint-rollout): supply caches also pay seeded
    // scrap on the merged wallet path.
    this.grantEventCurrency(ev, ev.cache!.root.position.clone());
    this.completeEvent(ev, true);
    return drops;
  }

  /**
   * Buy one unit of a stock line: spends the trade-good material, grants
   * the item. Returns the failure reason or null on success.
   */
  merchantBuy(defId: string, index: number, itemId: string): string | null {
    const ev = this.live.find((e) => e.plan.defId === defId && e.plan.index === index && e.status === 'active');
    const inv = this.opts.inventory;
    if (!ev || !ev.merchant || !inv) return 'unavailable';
    const line = ev.stock.find((l) => l.itemId === itemId);
    if (!line || line.count <= 0) return 'sold-out';
    const good = ev.def.merchant!.tradeGoodId;
    if (inv.count(good) < line.cost) return 'cant-afford';
    const removed = inv.remove(good, line.cost);
    if (removed < line.cost) return 'cant-afford';
    const leftover = inv.add(itemId, 1);
    if (leftover > 0) {
      // no room: refund the trade goods rather than lose them
      inv.add(good, removed);
      return 'no-room';
    }
    line.count -= 1;
    if (!ev.completedTrade) {
      ev.completedTrade = true;
      this.opts.toast(ev.def.toastDone);
    }
    return null;
  }

  /**
   * Sell one unit from the player's backpack for trade goods. Returns the
   * granted trade-good count, or 0 when nothing was sold.
   */
  merchantSell(defId: string, index: number, itemId: string): number {
    const ev = this.live.find((e) => e.plan.defId === defId && e.plan.index === index && e.status === 'active');
    const inv = this.opts.inventory;
    if (!ev || !ev.merchant || !inv || !ev.def.merchant) return 0;
    const removed = inv.remove(itemId, 1);
    if (removed <= 0) return 0;
    const perUnit = this.sellYieldFor(ev, itemId);
    if (perUnit > 0) inv.add(ev.def.merchant.tradeGoodId, perUnit);
    if (!ev.completedTrade) {
      ev.completedTrade = true;
      this.opts.toast(ev.def.toastDone);
    }
    return perUnit;
  }

  // ------------------------------------------------------------ internals

  private planPos(plan: PlannedEvent): THREE.Vector3 {
    return new THREE.Vector3(plan.x, 0, plan.z);
  }

  private groundY(x: number, z: number): number {
    return this.engine.terrain ? (this.engine.terrain.heightAt(x, z) ?? 0) : 0;
  }

  private announce(ev: LiveEvent): void {
    this.opts.toast(ev.def.toastStart);
    const pos = this.eventAnchor(ev);
    // ACCESSIBILITY PASS: beacon color resolves through the live palette
    // ('none' returns the exact shipped hex — see accessibility.ts).
    const beacon = new EventBeacon(beaconColorForType(ev.def.type as DynamicEventTypeId));
    beacon.setPosition(pos);
    this.engine.scene.add(beacon.group);
    ev.beacon = beacon;
  }

  private eventAnchor(ev: LiveEvent): THREE.Vector3 {
    if (ev.merchant) return ev.merchant.position.clone();
    if (ev.cache) return ev.cache.root.position.clone();
    if (ev.combatants.length > 0) return ev.combatants[0].position.clone();
    return new THREE.Vector3(ev.plan.x, this.groundY(ev.plan.x, ev.plan.z), ev.plan.z);
  }

  private startEvent(ev: LiveEvent): void {
    if (ev.status !== 'pending') return;
    ev.status = 'active';
    if (ev.def.type === 'ambush' || ev.def.type === 'patrol') this.spawnCombatants(ev);
    this.announce(ev);
  }

  private spawnCombatants(ev: LiveEvent): void {
    const c = ev.def.combatants!;
    const rng = new Rng(ev.plan.seed);
    const count = rng.int(c.countMin, c.countMax);
    const mgr = this.opts.enemyManager;
    const baseSpec = { kind: c.kind as EnemyKind, count: 1 };
    for (let i = 0; i < count; i++) {
      // ambush: ring around the PLAYER (the trap closes); patrol: ring
      // around the planned point and walk waypoints from there.
      const cx = ev.def.type === 'ambush' ? this.opts.getPlayerPos().x : ev.plan.x;
      const cz = ev.def.type === 'ambush' ? this.opts.getPlayerPos().z : ev.plan.z;
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(10, 16);
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const y = this.groundY(x, z) + 1;
      const seed = ((ev.plan.seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
      const spec: EnemySpec = c.elite
        ? { kind: baseSpec.kind, count: 1, health: 220, speed: 4.2, damage: 22, weapon: 'melee' }
        : { kind: baseSpec.kind, count: 1, health: 30, speed: 3.2, damage: 10, weapon: 'melee' };
      const e = mgr.spawnOne(spec, new THREE.Vector3(x, y, z), seed);
      NpcInstancer.for(this.engine).registerEnemy(e);
      ev.combatants.push(e);
    }
    if (ev.def.type === 'patrol') {
      // seeded waypoint loop for the patrol to walk
      const prng = new Rng((ev.plan.seed ^ 0x9a7) >>> 0);
      for (let w = 0; w < 4; w++) {
        const a = (w / 4) * Math.PI * 2 + prng.range(-0.3, 0.3);
        const d = prng.range(18, 30);
        ev.waypoints.push(new THREE.Vector3(ev.plan.x + Math.cos(a) * d, 0, ev.plan.z + Math.sin(a) * d));
      }
    }
    // track kills through the engine's public onKill hook; the tap is
    // released in despawnAll so a departed map never strands a listener.
    ev.untapKill?.();
    ev.untapKill = this.engine.hooks.tap('onKill', (payload) => {
      if (!ev.combatants.includes(payload.enemy)) return;
      if (ev.combatants.every((e) => !e.alive)) {
        const bonus = this.rollReward(ev, ev.def.completionBonusRolls);
        for (const d of bonus) this.opts.lootHooks?.onLoot(d, payload.enemy.position.clone());
        // UPGRADE LOOP (blueprint-rollout): seeded scrap bonus on the
        // merged wallet path (ambush + patrol completions).
        this.grantEventCurrency(ev, payload.enemy.position.clone());
        this.completeEvent(ev, true);
      }
    });
  }

  private updateCombatants(ev: LiveEvent, _dt: number, playerPos: THREE.Vector3): void {
    if (ev.def.type !== 'patrol' || ev.waypoints.length === 0) return;
    // patrol: steer idle (non-aggroed) combatants along the waypoint loop
    // by re-pointing their public `home` — no EnemyAI internals touched.
    // The loop advances one waypoint when the roster's lead combatant gets
    // close to the current one (or when it has none alive to lead).
    const wp = ev.waypoints[ev.wpIndex];
    const lead = ev.combatants.find((e) => e.alive);
    if (lead && lead.position.distanceTo(wp) < 5) {
      ev.wpIndex = (ev.wpIndex + 1) % ev.waypoints.length;
    }
    const target = ev.waypoints[ev.wpIndex];
    for (const e of ev.combatants) {
      if (!e.alive) continue;
      if (e.position.distanceTo(playerPos) > 26) {
        e.home.set(target.x, this.groundY(target.x, target.z) + 1, target.z);
      }
    }
  }

  private spawnCache(ev: LiveEvent): void {
    const pos = new THREE.Vector3(ev.plan.x, this.groundY(ev.plan.x, ev.plan.z), ev.plan.z);
    const node = new EventCacheNode(this.engine, pos, `event-cache-${(ev.plan.seed >>> 0).toString(16)}`);
    this.engine.scene.add(node.root);
    NpcInstancer.for(this.engine).registerEnemy(node);
    this.registerInteractable(node.interactable);
    ev.cache = node;
  }

  private spawnMerchant(ev: LiveEvent): void {
    const pos = new THREE.Vector3(ev.plan.x, this.groundY(ev.plan.x, ev.plan.z), ev.plan.z);
    const name = `Wanderer ${new Rng(ev.plan.seed).int(10, 99)}`;
    const spec: NpcSpec = { name, role: 'villager', count: 1, wanderRadius: 12, speed: 1.4 };
    const npc = new Npc(this.engine, spec, pos, ev.plan.seed);
    NpcInstancer.for(this.engine).register(npc);
    const interactable: Interactable = {
      id: `event-merchant-${(ev.plan.seed >>> 0).toString(16)}`,
      type: 'event-merchant',
      position: pos.clone().add(UP1),
      radius: 3,
      enabled: true,
      prompt: `Trade with ${name}`,
    };
    this.registerInteractable(interactable);
    ev.merchant = npc;
    ev.merchantInteractable = interactable;
    ev.stock = buildMerchantStock(ev.def, ev.plan.seed, this.opts.defs());
  }

  private registerInteractable(i: Interactable): void {
    const reg = this.engine.npcInteractions;
    if (!reg.get(i.id)) reg.register(i);
  }

  private unregisterInteractable(id: string): void {
    try { this.engine.npcInteractions.unregister(id); } catch { /* never strand */ }
  }

  /**
   * UPGRADE LOOP (blueprint-rollout): seeded scrap reward for event
   * completion, wired to the merged wallet path (EnemyManager.lootHooks.
   * onCurrency — the vendor-economy hook the events wave deferred until
   * the wallet merged). Per-instance stream (plan.seed ^ CURRENCY_SALT) —
   * independent of completion order, never the item-loot stream. No-op
   * when the blueprint didn't wire onCurrency (blueprints without the
   * vendor-economy layer). The blueprint's own onCurrency hook toasts the
   * grant, so this stays silent.
   */
  private grantEventCurrency(ev: LiveEvent, pos: THREE.Vector3): void {
    const hook = this.opts.lootHooks?.onCurrency;
    if (!hook) return;
    const amount = rollEventCurrency(ev.plan.seed, ev.def.type);
    try {
      hook(amount, pos);
    } catch { /* currency is cosmetic */ }
  }

  private rollReward(ev: LiveEvent, rolls: number): { itemId: string; count: number }[] {
    const out: { itemId: string; count: number }[] = [];
    if (rolls <= 0) return out;
    const rng = new Rng((ev.plan.seed ^ 0x8e1) >>> 0);
    const pool = ['mat_ember_shard', 'mat_beast_hide', 'mat_core_fragment',
      'loot_ironfang_blade', 'loot_scorched_plate', 'loot_surge_tonic'];
    for (let i = 0; i < rolls; i++) {
      const itemId = rng.pick(pool);
      out.push({ itemId, count: itemId.startsWith('mat_') ? rng.int(2, 5) : 1 });
    }
    return out;
  }

  private sellYieldFor(ev: LiveEvent, itemId: string): number {
    const defs = this.opts.defs();
    const line = ev.stock.find((l) => l.itemId === itemId);
    if (line) return line.yieldPer;
    const d = defs[itemId];
    if (!d || !Number.isFinite(d.value)) return 0;
    return Math.max(1, Math.floor((d.value as number) * ev.def.merchant!.sellMult));
  }

  private completeEvent(ev: LiveEvent, retire: boolean): void {
    if (ev.status === 'done') return;
    ev.status = 'done';
    this.opts.toast(ev.def.toastDone);
    if (!retire) return;
    // the beacon leaves; the payload retires (cache sink animation handles
    // the node; the merchant is never retired — it trades until departure).
    const beacon = ev.beacon;
    ev.beacon = null;
    if (beacon) beacon.dispose(this.engine.scene);
  }
}

const UP1 = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- interaction session

export interface EventSessionOpts {
  /** override the UI container (default: engine.container) */
  container?: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** false = headless: no UI (tests). */
  enableUi?: boolean;
  /** true while another modal owns input (dialogue/crafting/trade panel). */
  isModalOpen?: () => boolean;
  /** open the trade panel for a merchant activation. */
  openTrade?: (defId: string, index: number) => void;
}

const liveSessions = new WeakMap<Engine, EventInteractionSession>();

/**
 * One InteractionPrompt pill for the event types: [E] Open supply cache /
 * [E] Trade with <name>. Activation routes to the manager (cache) or the
 * trade panel (merchant). Other prompts (quest/gathering/stations) dispatch
 * only their own types, so pills coexist by the established convention.
 */
export class EventInteractionSession {
  private readonly byCacheId = new Map<string, LiveEvent>();
  private readonly byMerchantId = new Map<string, LiveEvent>();
  private prompt: import('../ui/InteractionPrompt').InteractionPrompt | null = null;
  private disposed = false;
  private scratch = new THREE.Vector3();

  constructor(
    private readonly engine: Engine,
    private readonly manager: DynamicEventManager,
    private readonly opts: EventSessionOpts = {},
  ) {
    liveSessions.get(engine)?.dispose();
    liveSessions.set(engine, this);
    this.refresh();
    if (opts.enableUi === false) return;
    const doc = this.opts.doc ?? globalThis.document;
    const container = this.opts.container ?? this.engine.container;
    this.prompt = new InteractionPrompt(container, this.engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      getRival: () => null,
      onActivate: (target) => this.activate(target.id),
      isModalOpen: () => this.opts.isModalOpen?.() ?? false,
    }, doc);
  }

  /** The event instance behind an interactable id (tests). */
  eventFor(interactableId: string): LiveEvent | null {
    return this.byCacheId.get(interactableId) ?? this.byMerchantId.get(interactableId) ?? null;
  }

  activate(interactableId: string): boolean {
    const cacheEv = this.byCacheId.get(interactableId);
    if (cacheEv?.cache) {
      return this.manager.openCache(interactableId) !== null;
    }
    const merchantEv = this.byMerchantId.get(interactableId);
    if (merchantEv?.merchant) {
      this.opts.openTrade?.(merchantEv.plan.defId, merchantEv.plan.index);
      return true;
    }
    return false;
  }

  update(): void {
    if (this.disposed) return;
    this.refresh();
    this.prompt?.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prompt?.dispose();
    this.prompt = null;
    this.byCacheId.clear();
    this.byMerchantId.clear();
    if (liveSessions.get(this.engine) === this) liveSessions.delete(this.engine);
  }

  private refresh(): void {
    this.byCacheId.clear();
    this.byMerchantId.clear();
    for (const ev of this.manager.events) {
      if (ev.cache && ev.status !== 'done') this.byCacheId.set(ev.cache.interactable.id, ev);
      if (ev.merchantInteractable && ev.merchant && ev.status !== 'done') {
        this.byMerchantId.set(ev.merchantInteractable.id, ev);
      }
    }
  }

  private playerPos(): THREE.Vector3 {
    const p = this.engine.portalsPlayerAvatar?.ctrl.position;
    return p ? this.scratch.copy(p) : this.scratch.set(0, 0, 0);
  }
}
