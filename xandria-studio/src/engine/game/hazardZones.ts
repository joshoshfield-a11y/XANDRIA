/**
 * UPGRADE LOOP (hazard-zones phase): seeded environmental hazard zones.
 *
 * Built on the weather-cycles + dynamic-events systems (read both REPORT.md
 * files first — this wave reuses their conventions, not their code):
 *
 * - `planHazardZones(mapSeed, spec, anchors)` — PURE scheduler, the same
 *   shape as planDynamicEvents: `Rng(mapSeed ^ HAZARD_SALT)` picks the
 *   zone set (def, position, tick phase). Same (mapSeed, spec, anchors)
 *   → identical hazard set. Never engine.rng / Math.random / Date.now.
 * - `HazardZoneManager` — `MapLocalEntitySystem` (id 'hazards'),
 *   registered in `engine.portalEntities` by the tpAction blueprint, so
 *   portal departure despawns the decals and arrival rebuilds the
 *   identical set from the derived map seed (stateless arrival, the
 *   gathering/weather contract — the hazard SET is preserved across
 *   portal re-entry; the per-zone tick clocks restart from their seeded
 *   phase offsets, exactly like the weather cycle clock).
 *
 * Each zone cycles: quiet → telegraph (ground decal pulses in the warning
 * color + one 'alarm' warning tick when the player is near) → damage tick
 * → quiet. Damage is applied additively through the blueprint's existing
 * damage path (the same `avatar.damage` sink the weather storm strikes
 * use) — no NPC/enemy behavior contract changes, and enemies are
 * unaffected, matching the storm-strike precedent. The tick interval of
 * every def exceeds the avatar's 0.8s damage iframes, so consecutive
 * ticks land on a player who stays in the zone.
 *
 * Placement is seeded-safe via the existing terrain/placement seams:
 * zones ring POI anchors outside their footprints (the gathering/events
 * pattern), stay in terrain bounds, keep a minimum separation from each
 * other and from the spawn origin, and are grounded via terrain.heightAt
 * at spawn time. Only x/z come from the pure planner; y is sampled live,
 * like the weather strike grounding.
 *
 * Rendering uses existing paths only: one flat ring decal mesh per zone
 * (RingGeometry + MeshBasicMaterial, the weather telegraph-ring pattern),
 * created at spawnForMap and removed + disposed at despawnAll. No new
 * instancing buckets, no per-frame allocations (one scratch vector).
 *
 * Studio: `spec.custom.hazards = { enabled, counts }` — the map (world)
 * tab writes these fields. `enabled: false` leaves the map hazard-free.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import type { MapLocalEntitySystem } from '../world/MapEntities';

/**
 * Salt for the hazard-zone stream. Distinct from every other system salt
 * (pinned by unit test).
 */
export const HAZARD_SALT = 0x9a2a0d;

export type HazardDefId = 'hazard_spike_field' | 'hazard_ember_vent' | 'hazard_toxic_pool';

export interface HazardDef {
  /** stable id, e.g. 'hazard_spike_field'. */
  id: HazardDefId;
  /** display name (minimap / Studio labels). */
  name: string;
  /** damage per tick (HP), applied through the existing damage path. */
  damage: number;
  /** hazard radius (m) — inside = damage on the tick. */
  radius: number;
  /** seconds between damage ticks (tick-to-tick; > 0.8s avatar iframes). */
  tickIntervalSec: number;
  /** seconds of telegraph warning before each tick. */
  telegraphSec: number;
  /** decal / minimap marker color (idle). */
  color: string;
  /** decal / marker color while telegraphing. */
  warningColor: string;
  /** ringed distance (m) from a POI anchor / origin. */
  ringMin: number;
  ringMax: number;
  /** default instances per map (spec.custom.hazards.counts overrides). */
  defaultCount: number;
}

/**
 * THE hazard defs table: damage, radius, telegraph style, all tuning.
 * Nothing about a zone's behavior is hardcoded in the manager below.
 */
export const HAZARD_DEFS: readonly HazardDef[] = [
  {
    id: 'hazard_spike_field',
    name: 'Spike Field',
    damage: 8,
    radius: 3.0,
    tickIntervalSec: 1.0,
    telegraphSec: 0.6,
    color: '#ff5a3c',
    warningColor: '#ffd23f',
    ringMin: 20, ringMax: 60,
    defaultCount: 2,
  },
  {
    id: 'hazard_ember_vent',
    name: 'Ember Vent',
    damage: 12,
    radius: 2.5,
    tickIntervalSec: 1.2,
    telegraphSec: 0.8,
    color: '#ff9a2a',
    warningColor: '#ff3d00',
    ringMin: 25, ringMax: 70,
    defaultCount: 2,
  },
  {
    id: 'hazard_toxic_pool',
    name: 'Toxic Pool',
    damage: 6,
    radius: 3.5,
    tickIntervalSec: 1.5,
    telegraphSec: 0.6,
    color: '#7ae25a',
    warningColor: '#d4ff3f',
    ringMin: 20, ringMax: 55,
    defaultCount: 2,
  },
];

export const HAZARD_DEF_IDS: readonly HazardDefId[] = HAZARD_DEFS.map((d) => d.id);

export function hazardDefById(id: string): HazardDef | null {
  return HAZARD_DEFS.find((d) => d.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Spec resolvers (Studio surface)
// ---------------------------------------------------------------------------

export interface HazardsCustom {
  /** false = the whole wave is off (no zones spawn). Default true. */
  enabled?: boolean;
  /** per-def instance counts, e.g. { hazard_toxic_pool: 0 }. Clamped 0..4. */
  counts?: Record<string, number>;
}

export function resolveHazardsEnabled(spec: GameSpec): boolean {
  return spec.custom?.hazards?.enabled !== false;
}

export function resolveHazardCount(spec: GameSpec, def: HazardDef): number {
  const raw = spec.custom?.hazards?.counts?.[def.id];
  if (raw === undefined) return def.defaultCount;
  if (!Number.isFinite(raw)) return def.defaultCount;
  return Math.max(0, Math.min(4, Math.floor(raw)));
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface HazardAnchor {
  x: number;
  z: number;
  /** footprint radius to stay outside of (default 0). */
  r: number;
}

export interface PlannedHazard {
  /** the def this zone follows. */
  defId: HazardDefId;
  /** 0-based instance index within the def. */
  index: number;
  /** per-instance seed: decorrelates the tick-phase draw. */
  seed: number;
  /** world position (x/z pure; y is grounded live at spawn). */
  x: number;
  z: number;
  /** seconds of quiet before the first telegraph window opens. */
  phaseOffset: number;
}

/** Minimum separation (m) between two zones. */
export const HAZARD_MIN_SEPARATION = 12;
/** Minimum distance (m) from the spawn origin. */
export const HAZARD_MIN_SPAWN_DIST = 14;
/** Rejection-sampling tries per zone before falling back to the best candidate. */
const PLACEMENT_TRIES = 10;

/**
 * PURE scheduler: the hazard set for a map is a function of
 * (mapSeed, spec, anchors) alone. Same inputs → identical zones
 * (defs, positions, phase offsets). Positions stay inside the terrain
 * bounds for the spec's terrain size, ring POI anchors outside their
 * footprints, keep separation, and stay clear of the spawn origin.
 */
export function planHazardZones(
  mapSeed: number,
  spec: GameSpec,
  anchors: readonly HazardAnchor[],
): PlannedHazard[] {
  if (!resolveHazardsEnabled(spec)) return [];
  const rng = new Rng((mapSeed ^ HAZARD_SALT) >>> 0);
  const size = spec?.world?.terrain?.size ?? 512;
  const half = size / 2;
  const base = anchors.length > 0 ? anchors : [{ x: 0, z: 0, r: 0 }];
  const out: PlannedHazard[] = [];
  const placed: Array<{ x: number; z: number }> = [];

  for (const def of HAZARD_DEFS) {
    const count = resolveHazardCount(spec, def);
    for (let i = 0; i < count; i++) {
      let best: { x: number; z: number } | null = null;
      let bestScore = -Infinity;
      for (let t = 0; t < PLACEMENT_TRIES; t++) {
        const a = rng.pick(base);
        const ang = rng.range(0, Math.PI * 2);
        const d = a.r + rng.range(def.ringMin, def.ringMax);
        const x = a.x + Math.cos(ang) * d;
        const z = a.z + Math.sin(ang) * d;
        // in-bounds with a margin for the zone's own radius
        const margin = def.radius + 4;
        if (Math.abs(x) > half - margin || Math.abs(z) > half - margin) continue;
        const spawnDist = Math.hypot(x, z);
        if (spawnDist < HAZARD_MIN_SPAWN_DIST) continue;
        // separation score: worst (smallest) gap to an accepted zone
        let minGap = Infinity;
        for (const p of placed) minGap = Math.min(minGap, Math.hypot(x - p.x, z - p.z));
        if (minGap >= HAZARD_MIN_SEPARATION) {
          best = { x, z };
          bestScore = Infinity;
          break;
        }
        if (minGap > bestScore) { bestScore = minGap; best = { x, z }; }
      }
      if (!best) continue; // no in-bounds candidate survived (tiny maps) — skip, never place unsafe
      const seed = ((mapSeed ^ HAZARD_SALT ^ Math.imul(i + 1, 0x9e3779b9) ^ (def.id.length * 0x85ebca6b + i)) >>> 0);
      const phaseOffset = new Rng(seed).range(0, def.tickIntervalSec);
      placed.push(best);
      out.push({ defId: def.id, index: i, seed, x: best.x, z: best.z, phaseOffset });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface HazardZoneManagerOpts {
  /** POIs to ring zones around (blueprint passes landmarks.placed). */
  pois?: HazardAnchor[];
  /** live player position (null = player not on this map yet). */
  playerPos: () => THREE.Vector3 | null;
  /** additive player-damage sink (the blueprint's avatar.damage path). */
  damagePlayer: (dmg: number, from: THREE.Vector3) => void;
  /** warning-tick sound sink (the engine audio path; default: engine.audio). */
  playWarning?: (kind: string) => void;
}

/** Live zone: a planned hazard + its decal + tick clock. */
export interface LiveHazardZone {
  plan: PlannedHazard;
  def: HazardDef;
  /** ground decal mesh (null until spawn / after despawn). */
  decal: THREE.Mesh | null;
  /** seconds until the next damage tick. */
  nextTickAt: number;
  /** true while inside the telegraph window before the next tick. */
  telegraphing: boolean;
  /** damage ticks fired since spawn (test seam). */
  ticksFired: number;
  /** warning ticks sounded for the current telegraph (test seam). */
  warningTicks: number;
  /** whether the warning tick already sounded for the current telegraph. */
  warned: boolean;
}

/** Read-only marker view for the observe-only minimap layer. */
export interface HazardMarkerView {
  defId: HazardDefId;
  x: number;
  z: number;
  radius: number;
  color: string;
  telegraphing: boolean;
}

const WARNING_HEAR_RADIUS = 25;

export class HazardZoneManager implements MapLocalEntitySystem {
  readonly id = 'hazards';
  private readonly engine: Engine;
  private readonly spec: GameSpec;
  private readonly opts: HazardZoneManagerOpts;
  private live: LiveHazardZone[] = [];
  private clock = 0;
  private active = false;
  private decalGeo: THREE.BufferGeometry | null = null;
  /** scratch (no per-frame allocations). */
  private readonly tmpV = new THREE.Vector3();

  constructor(engine: Engine, spec: GameSpec, opts: HazardZoneManagerOpts) {
    this.engine = engine;
    this.spec = spec;
    this.opts = opts;
  }

  /** Read-only view for tests / the minimap layer. */
  get zones(): readonly LiveHazardZone[] {
    return this.live;
  }

  /** The live plan (test seam). */
  getPlan(): PlannedHazard[] {
    return this.live.map((z) => z.plan);
  }

  /** The POI anchors the live plan was built from (test seam: pure-plan replication). */
  getPois(): HazardAnchor[] {
    return [...(this.opts.pois ?? [])];
  }

  /** Observe-only marker view for the minimap (fog rules applied there). */
  markerView(): HazardMarkerView[] {
    return this.live.map((z) => ({
      defId: z.def.id,
      x: z.plan.x,
      z: z.plan.z,
      radius: z.def.radius,
      color: z.telegraphing ? z.def.warningColor : z.def.color,
      telegraphing: z.telegraphing,
    }));
  }

  /** Current state for HUD/test seams. */
  current(): {
    active: boolean;
    clock: number;
    zones: Array<{ defId: HazardDefId; x: number; z: number; telegraphing: boolean; ticksFired: number; nextTickAt: number }>;
  } {
    return {
      active: this.active,
      clock: this.clock,
      zones: this.live.map((z) => ({
        defId: z.def.id, x: z.plan.x, z: z.plan.z,
        telegraphing: z.telegraphing, ticksFired: z.ticksFired, nextTickAt: z.nextTickAt,
      })),
    };
  }

  // -- MapLocalEntitySystem -------------------------------------------------

  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    if (!resolveHazardsEnabled(this.spec)) {
      this.active = false;
      return;
    }
    const planned = planHazardZones(mapSeed, this.spec, this.opts.pois ?? []);
    this.decalGeo = new THREE.RingGeometry(0.78, 1, 40);
    for (const plan of planned) {
      const def = hazardDefById(plan.defId);
      if (!def) continue;
      const y = this.groundY(plan.x, plan.z);
      const mat = new THREE.MeshBasicMaterial({
        color: def.color, transparent: true, opacity: 0.35,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const decal = new THREE.Mesh(this.decalGeo, mat);
      decal.rotation.x = -Math.PI / 2;
      decal.position.set(plan.x, y + 0.15, plan.z);
      decal.scale.setScalar(def.radius);
      decal.renderOrder = 5;
      this.engine.scene.add(decal);
      this.live.push({
        plan,
        def,
        decal,
        // first tick at phaseOffset + telegraph: the zone is quiet for
        // `phaseOffset`, then telegraphs, then ticks — the telegraph
        // always precedes the first tick.
        nextTickAt: plan.phaseOffset + def.telegraphSec,
        telegraphing: false,
        ticksFired: 0,
        warningTicks: 0,
        warned: false,
      });
    }
    this.clock = 0;
    this.active = true;
  }

  despawnAll(): void {
    for (const z of this.live) {
      if (z.decal) {
        try { this.engine.scene.remove(z.decal); } catch { /* never strand */ }
        try { (z.decal.material as THREE.Material).dispose(); } catch { /* never strand */ }
        z.decal = null;
      }
    }
    try { this.decalGeo?.dispose(); } catch { /* never strand */ }
    this.decalGeo = null;
    this.live = [];
    this.clock = 0;
    this.active = false;
  }

  // -- per-frame ------------------------------------------------------------

  update(dt: number): void {
    if (!this.active) return;
    this.advance(dt);
  }

  /**
   * Test seam: advance the zone clocks synchronously (the same code path
   * as update, without waiting on the frame loop). Lets the e2e harness
   * assert telegraph-before-tick ordering deterministically.
   */
  debugTick(dt: number): void {
    if (!this.active) return;
    this.advance(dt);
  }

  // -- internals ------------------------------------------------------------

  private advance(dt: number): void {
    this.clock += dt;
    const pp = this.opts.playerPos();
    for (const z of this.live) {
      const def = z.def;
      // fire every tick whose time has come — a long frame (tab stall,
      // slow SwiftShader step) must not silently swallow ticks. The
      // weather strike loop uses the same while-shape.
      let guard = 0;
      while (this.clock >= z.nextTickAt && guard++ < 1000) {
        this.fireTick(z, pp);
        z.nextTickAt += def.tickIntervalSec;
        z.warned = false;
      }
      // telegraph window: [nextTickAt - telegraphSec, nextTickAt)
      z.telegraphing = this.clock >= z.nextTickAt - def.telegraphSec && this.clock < z.nextTickAt;
      if (z.telegraphing && !z.warned) {
        z.warned = true;
        z.warningTicks++;
        // warning tick: one short alarm when the player is near enough
        // to care (existing audio path only — no new SFX).
        if (pp && Math.hypot(pp.x - z.plan.x, pp.z - z.plan.z) <= def.radius + WARNING_HEAR_RADIUS) {
          if (this.opts.playWarning) this.opts.playWarning('alarm');
          else this.engine.audio.play('alarm');
        }
      }
      this.paintDecal(z);
    }
  }

  private fireTick(z: LiveHazardZone, pp: THREE.Vector3 | null): void {
    z.ticksFired++;
    if (!pp) return;
    const dx = pp.x - z.plan.x, dz = pp.z - z.plan.z;
    if (dx * dx + dz * dz > z.def.radius * z.def.radius) return;
    this.tmpV.set(z.plan.x, this.groundY(z.plan.x, z.plan.z) + 1, z.plan.z);
    // additive damage through the existing damage path (the blueprint's
    // avatar.damage sink) — the storm-strike pattern, player-only.
    this.opts.damagePlayer(z.def.damage, this.tmpV);
  }

  /** Decal paint: idle color/opacity, telegraph = warning color + pulse. */
  private paintDecal(z: LiveHazardZone): void {
    const decal = z.decal;
    if (!decal) return;
    const mat = decal.material as THREE.MeshBasicMaterial;
    if (z.telegraphing) {
      mat.color.set(z.def.warningColor);
      mat.opacity = 0.9;
      const s = 1 + 0.08 * Math.sin(this.clock * 18);
      decal.scale.setScalar(z.def.radius * s);
    } else {
      mat.color.set(z.def.color);
      mat.opacity = 0.35;
      decal.scale.setScalar(z.def.radius);
    }
  }

  private groundY(x: number, z: number): number {
    const t = (this.engine as unknown as { terrain?: { heightAt?: (x: number, z: number) => number } }).terrain;
    return t?.heightAt ? t.heightAt(x, z) : 0;
  }
}
