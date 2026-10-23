/**
 * UPGRADE LOOP (weather-cycles phase): seeded day/night + weather cycles with
 * additive gameplay hooks.
 *
 * One pure scheduler + one map-local manager:
 *
 * - `planWeatherCycle(mapSeed)` — PURE. `Rng(mapSeed ^ WEATHER_SALT)` builds
 *   the full cycle: phase segments (day→dusk→night→dawn) × seeded weather
 *   spans (clear/rain/fog/storm) merged into combined segments, plus the
 *   storm lightning-strike schedule. Same mapSeed → identical plan, always.
 * - `WeatherCycleManager` — `MapLocalEntitySystem` (id 'weather'). Advances
 *   a cycle clock with the frame dt, applies the phase/weather blend to the
 *   existing sky rig (lights, fog, exposure — additive on top of the authored
 *   spec.theme.timeOfDay setup), drives particle drizzle through the existing
 *   `engine.particles.setWeather` path, fires seeded lightning strikes as
 *   hazard zones during storm, and exposes additive gameplay multipliers.
 *
 * Determinism rules: seeded RNG only (never Math.random/Date.now for
 * gameplay); the strike/telegraph visuals are pure functions of the cycle
 * clock, so in-test replication is exact.
 *
 * Gameplay hooks (all additive, all in WEATHER_TUNING):
 * - night: per-kind enemy melee damage multipliers (e.g. brutes hit harder
 *   in the dark). Applied by the blueprint wrapping EnemyManager onPlayerHit
 *   (see the optional `kind` param on EnemyEvents.onPlayerHit).
 * - rain: fog density multiplier (visibility drop) — no behavior change.
 * - storm: lightning strikes as seeded hazard zones (telegraph ring → flash
 *   → radial player damage). Player-only; enemies are unaffected.
 *
 * Studio: `spec.custom.weatherCycles = { enabled, forced }` — the force
 * select pins one weather for testing (the phase cycle keeps running).
 * `enabled: false` leaves the authored static look untouched.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { GameSpec, Weather, EnemyKind } from '@spec';
import { Rng } from '../core/Rng';
import type { MapLocalEntitySystem } from '../world/MapEntities';

/**
 * Salt for the weather-cycle stream. Distinct from every other system salt
 * (pinned by unit test).
 */
export const WEATHER_SALT = 0x1ea711;

export type DayPhase = 'day' | 'dusk' | 'night' | 'dawn';
/** Weather states the cycle can schedule (subset of the authored Weather). */
export type CycleWeather = 'clear' | 'rain' | 'fog' | 'storm';
export const CYCLE_WEATHERS: readonly CycleWeather[] = ['clear', 'rain', 'fog', 'storm'] as const;

export interface PhaseLightFactors {
  /** multipliers applied to the captured baseline (1 = authored look) */
  sun: number;
  hemi: number;
  ambient: number;
  exposure: number;
  /** sun color target; lerp target is a pure function of phase */
  sunTint: string;
}

export interface WeatherTuning {
  /** target full day length (seconds); seeded jitter keeps maps distinct */
  cycleSec: number;
  /** phase durations as fractions of the cycle; must sum to 1 */
  phaseFractions: Record<DayPhase, number>;
  /** per-phase light factors, relative to the authored baseline */
  phaseLight: Record<DayPhase, PhaseLightFactors>;
  /** seconds to smooth-blend into the next segment at a phase boundary */
  transitionSec: number;
  /** weather pick weights per weather span */
  weatherWeights: Record<CycleWeather, number>;
  /** seeded weather-span duration bounds */
  weatherMinSec: number;
  weatherMaxSec: number;
  /** fog-density multipliers per weather (rain reads as a visibility drop) */
  fogDensityMult: Record<CycleWeather, number>;
  /** fog-color brightness multipliers per weather (storm darkens the haze) */
  fogColorMult: Record<CycleWeather, number>;
  /** sun-intensity multiplier per weather (storm gloom) */
  sunWeatherMult: Record<CycleWeather, number>;
  /** additive night melee-damage multipliers per enemy kind (absent = 1) */
  nightEnemyDamageMult: Partial<Record<EnemyKind, number>>;
  storm: {
    telegraphSec: number;
    intervalMinSec: number;
    intervalMaxSec: number;
    /** hazard radius (m) */
    radius: number;
    /** player damage on a direct strike */
    damage: number;
    telegraphColor: string;
    boltColor: string;
  };
}

/**
 * THE tuning table. Every gameplay number in this wave lives here — nothing
 * is hardcoded in the manager.
 */
export const WEATHER_TUNING: WeatherTuning = {
  cycleSec: 240,
  phaseFractions: { day: 0.5, dusk: 0.12, night: 0.28, dawn: 0.1 },
  phaseLight: {
    day:   { sun: 1.0,  hemi: 1.0,  ambient: 1.0,  exposure: 1.0,  sunTint: '#ffffff' },
    dusk:  { sun: 0.85, hemi: 0.9,  ambient: 0.9,  exposure: 1.0,  sunTint: '#ffb070' },
    night: { sun: 0.35, hemi: 0.6,  ambient: 0.65, exposure: 0.94, sunTint: '#8fa3d9' },
    dawn:  { sun: 0.9,  hemi: 0.95, ambient: 0.95, exposure: 1.0,  sunTint: '#ffc890' },
  },
  transitionSec: 8,
  weatherWeights: { clear: 0.5, rain: 0.2, fog: 0.14, storm: 0.16 },
  weatherMinSec: 45,
  weatherMaxSec: 110,
  fogDensityMult: { clear: 1.0, rain: 1.6, fog: 3.0, storm: 2.0 },
  fogColorMult: { clear: 1.0, rain: 0.9, fog: 1.0, storm: 0.72 },
  sunWeatherMult: { clear: 1.0, rain: 0.9, fog: 0.8, storm: 0.62 },
  // night: the heavy kinds hit harder in the dark. Additive — daytime (and
  // every other system) is untouched.
  nightEnemyDamageMult: { brute: 1.25, walker: 1.15, turret: 1.0, drone: 1.0 },
  storm: {
    telegraphSec: 0.9,
    intervalMinSec: 4,
    intervalMaxSec: 9,
    radius: 4.5,
    damage: 25,
    telegraphColor: '#ff5a3c',
    boltColor: '#cfe4ff',
  },
};

export interface CycleSegment {
  startT: number;
  endT: number;
  phase: DayPhase;
  weather: CycleWeather;
}

export interface LightningStrike {
  /** cycle-clock seconds */
  at: number;
  x: number;
  z: number;
}

export interface WeatherPlan {
  segments: CycleSegment[];
  strikes: LightningStrike[];
  cycleSec: number;
}

const PHASE_ORDER: DayPhase[] = ['day', 'dusk', 'night', 'dawn'];

function pickWeighted(rng: Rng, weights: Record<CycleWeather, number>): CycleWeather {
  let total = 0;
  for (const w of CYCLE_WEATHERS) total += weights[w];
  let r = rng.next() * total;
  for (const w of CYCLE_WEATHERS) {
    r -= weights[w];
    if (r <= 0) return w;
  }
  return 'clear';
}

/**
 * Build the full cycle for a map seed. PURE — no engine access, no Date,
 * no Math.random. The returned plan is JSON-serializable (deep-equal safe).
 */
export function planWeatherCycle(mapSeed: number, spec?: GameSpec): WeatherPlan {
  const rng = new Rng((mapSeed ^ WEATHER_SALT) >>> 0);
  const T = WEATHER_TUNING;
  const cycleSec = T.cycleSec * (0.9 + 0.2 * rng.next());

  // phase spans: one day→dusk→night→dawn pass with seeded duration jitter
  const phaseSpans: Array<{ startT: number; endT: number; phase: DayPhase }> = [];
  {
    let t = 0;
    for (const phase of PHASE_ORDER) {
      const dur = cycleSec * T.phaseFractions[phase] * (0.85 + 0.3 * rng.next());
      phaseSpans.push({ startT: t, endT: t + dur, phase });
      t += dur;
    }
    // normalize: the jittered spans cover the cycle exactly
    const scale = cycleSec / t;
    for (const s of phaseSpans) { s.startT *= scale; s.endT *= scale; }
  }

  // weather spans: seeded sequence over the same cycle
  const weatherSpans: Array<{ startT: number; endT: number; weather: CycleWeather }> = [];
  {
    let t = 0;
    while (t < cycleSec) {
      const dur = Math.min(
        T.weatherMinSec + rng.next() * (T.weatherMaxSec - T.weatherMinSec),
        cycleSec - t,
      );
      weatherSpans.push({ startT: t, endT: t + dur, weather: pickWeighted(rng, T.weatherWeights) });
      t += dur;
    }
  }

  // merge into combined segments on the shared timeline
  const segments: CycleSegment[] = [];
  {
    let pi = 0, wi = 0;
    let t = 0;
    while (t < cycleSec - 1e-6) {
      const p = phaseSpans[pi], w = weatherSpans[wi];
      const end = Math.min(p.endT, w.endT, cycleSec);
      segments.push({ startT: t, endT: end, phase: p.phase, weather: w.weather });
      t = end;
      if (end >= p.endT - 1e-9) pi = Math.min(pi + 1, phaseSpans.length - 1);
      if (end >= w.endT - 1e-9) wi = Math.min(wi + 1, weatherSpans.length - 1);
      if (pi >= phaseSpans.length - 1 && p.endT <= end && wi >= weatherSpans.length - 1 && w.endT <= end) break;
    }
  }

  // lightning: seeded strikes inside storm spans, ringed 12–70m from origin
  const strikes: LightningStrike[] = [];
  {
    const size = spec?.world.terrain.size ?? 512;
    const maxR = Math.max(20, Math.min(70, size / 2 - 20));
    for (const w of weatherSpans) {
      if (w.weather !== 'storm') continue;
      let t = w.startT + 2 + rng.next() * 3;
      while (t < w.endT - 1 && strikes.length < 48) {
        const a = rng.next() * Math.PI * 2;
        const r = 12 + rng.next() * (maxR - 12);
        strikes.push({ at: t, x: Math.cos(a) * r, z: Math.sin(a) * r });
        t += T.storm.intervalMinSec + rng.next() * (T.storm.intervalMaxSec - T.storm.intervalMinSec);
      }
    }
    strikes.sort((a, b) => a.at - b.at);
  }

  return { segments, strikes, cycleSec };
}

/** Segment active at cycle-clock t (wraps). */
export function segmentAt(plan: WeatherPlan, t: number): CycleSegment {
  const tt = ((t % plan.cycleSec) + plan.cycleSec) % plan.cycleSec;
  for (const s of plan.segments) {
    if (tt >= s.startT && tt < s.endT) return s;
  }
  return plan.segments[plan.segments.length - 1];
}

/** Next segment after `seg` (wraps to the first). */
export function nextSegment(plan: WeatherPlan, seg: CycleSegment): CycleSegment {
  const i = plan.segments.indexOf(seg);
  return plan.segments[(i + 1) % plan.segments.length];
}

// ---------------------------------------------------------------------------
// Spec resolvers (Studio surface)
// ---------------------------------------------------------------------------

/** Master toggle. Default true — the seeded cycle runs unless opted out. */
export function resolveWeatherCyclesEnabled(spec: GameSpec): boolean {
  return spec.custom?.weatherCycles?.enabled ?? true;
}

/**
 * Studio force-weather (for testing). 'auto'/absent/invalid → null, meaning
 * the seeded cycle picks the weather. The day/night phase cycle still runs
 * when a weather is forced.
 */
export function resolveForcedWeather(spec: GameSpec): Weather | null {
  const f = spec.custom?.weatherCycles?.forced;
  if (!f || f === 'auto') return null;
  return (CYCLE_WEATHERS as readonly string[]).includes(f) ? (f as Weather) : null;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface WeatherCycleOpts {
  /** live player position (null = player not on this map yet) */
  playerPos: () => THREE.Vector3 | null;
  /** additive player-damage sink (the blueprint's avatar.damage path) */
  damagePlayer: (dmg: number, from: THREE.Vector3) => void;
  toast?: (msg: string) => void;
}

interface SkyBaseline {
  sunColor: THREE.Color; sunI: number;
  hemiI: number; ambientI: number;
  fogColor: THREE.Color; fogDensity: number;
  bg: THREE.Color | null;
  exposure: number;
}

/**
 * Per-engine authored sky baseline. Captured once (the first spawnForMap on
 * an engine) and reused by every later manager on the same engine. This is
 * what makes in-place restart() drift-free: the old manager is torn down
 * with the scene (its despawnAll never runs), so a fresh manager must NOT
 * re-capture from the still-modified sky — it reuses the stashed authored
 * values. The sky is built once per Engine construction, so the stash stays
 * valid for the engine's lifetime.
 */
const ENGINE_BASELINES = new WeakMap<object, SkyBaseline>();

export class WeatherCycleManager implements MapLocalEntitySystem {
  readonly id = 'weather';
  private readonly engine: Engine;
  private readonly spec: GameSpec;
  private readonly opts: WeatherCycleOpts;
  private plan: WeatherPlan | null = null;
  private active = false;
  private cycleT = 0;
  private baseline: SkyBaseline | null = null;
  private lastSeg: CycleSegment | null = null;
  private strikeIdx = 0;
  private telegraphAt = -1;
  /** test seam: how many strikes have actually fired via fireStrike */
  private firedCount = 0;
  /** test seam: how many times update() has run */
  private updateCount = 0; // strike index currently telegraphed (-1 = none)
  private boltUntil = -1;   // cycleT until which the bolt mesh stays visible
  private ring: THREE.Mesh | null = null;
  private bolt: THREE.Mesh | null = null;
  // scratch (no per-frame allocations)
  private readonly tmpC = new THREE.Color();
  private readonly tmpC2 = new THREE.Color();
  private readonly tmpV = new THREE.Vector3();

  constructor(engine: Engine, spec: GameSpec, opts: WeatherCycleOpts) {
    this.engine = engine;
    this.spec = spec;
    this.opts = opts;
  }

  // -- MapLocalEntitySystem -------------------------------------------------

  spawnForMap(mapSeed: number): void {
    if (!resolveWeatherCyclesEnabled(this.spec)) {
      this.active = false;
      return;
    }
    this.captureBaseline();
    this.plan = planWeatherCycle(mapSeed, this.spec);
    this.cycleT = 0;
    this.lastSeg = null;
    this.strikeIdx = 0;
    this.telegraphAt = -1;
    this.boltUntil = -1;
    this.ensureStrikeMeshes();
    this.active = true;
    // apply the opening segment immediately: visuals + particle drizzle +
    // transition toasts, exactly like a segment change into it
    const first = segmentAt(this.plan, 0);
    this.onSegmentChange(first, null);
    this.lastSeg = first;
    this.applySegment(first, 0, true);
  }

  despawnAll(): void {
    if (this.ring) this.ring.visible = false;
    if (this.bolt) this.bolt.visible = false;
    this.telegraphAt = -1;
    this.strikeIdx = 0;
    if (this.baseline) this.restoreBaseline();
    // NB: the per-engine baseline STASH is kept (see ENGINE_BASELINES) —
    // only this manager's reference is dropped, so a later spawnForMap on
    // the same engine (portal arrival, in-place restart) reuses the true
    // authored values instead of re-capturing a modified sky.
    this.baseline = null;
    this.plan = null;
    this.active = false;
    this.lastSeg = null;
    // particles back to the authored static weather (the engine boot default)
    const p = this.engine.particles as unknown as {
      setWeather?: (k: Weather, seed: number, q: 'retro' | 'standard' | 'high', g?: string) => void;
    };
    p.setWeather?.(this.spec.theme.weather, this.spec.meta.seed, this.engine.effectiveQuality(), this.spec.meta.genre);
  }

  // -- per-frame ------------------------------------------------------------

  update(dt: number): void {
    if (!this.active || !this.plan) return;
    this.updateCount++;
    const plan = this.plan;
    this.cycleT += dt;
    if (this.cycleT >= plan.cycleSec) {
      this.cycleT -= plan.cycleSec;
      this.strikeIdx = 0;
      this.telegraphAt = -1;
      this.lastSeg = null; // re-apply on wrap
    }
    const seg = segmentAt(plan, this.cycleT);
    if (seg !== this.lastSeg) {
      this.onSegmentChange(seg, this.lastSeg);
      this.lastSeg = seg;
    }
    this.applySegment(seg, this.cycleT, false);
    this.processStrikes(plan);
    if (this.bolt && this.bolt.visible && this.cycleT > this.boltUntil) {
      this.bolt.visible = false;
    }
  }

  // -- additive gameplay hooks (read by the blueprint) -----------------------

  /** Night melee-damage multiplier for an enemy kind (1 outside night). */
  enemyDamageMult(kind?: EnemyKind): number {
    if (!this.active || !this.plan) return 1;
    if (segmentAt(this.plan, this.cycleT).phase !== 'night') return 1;
    return kind ? (WEATHER_TUNING.nightEnemyDamageMult[kind] ?? 1) : 1;
  }

  /** Current phase/weather for HUD/test seams. */
  current(): { phase: DayPhase; weather: CycleWeather; cycleT: number; active: boolean; strikesFired: number; updates: number } {
    if (!this.active || !this.plan) return { phase: 'day', weather: 'clear', cycleT: 0, active: false, strikesFired: this.firedCount, updates: this.updateCount };
    const seg = segmentAt(this.plan, this.cycleT);
    return { phase: seg.phase, weather: this.effectiveWeather(seg), cycleT: this.cycleT, active: true, strikesFired: this.firedCount, updates: this.updateCount };
  }

  /** The live plan (test seam). */
  getPlan(): WeatherPlan | null { return this.plan; }

  /**
   * Test seam: jump the cycle clock (e2e hazard verification). Processes
   * segment transitions on the way so particles/lights stay consistent.
   */
  debugSetCycleT(t: number): void {
    if (!this.active || !this.plan) return;
    const target = ((t % this.plan.cycleSec) + this.plan.cycleSec) % this.plan.cycleSec;
    this.cycleT = target;
    this.strikeIdx = 0;
    while (this.strikeIdx < this.plan.strikes.length && this.plan.strikes[this.strikeIdx].at < target) {
      this.strikeIdx++;
    }
    this.telegraphAt = -1;
    if (this.ring) this.ring.visible = false;
    if (this.bolt) this.bolt.visible = false;
    this.lastSeg = null;
    const seg = segmentAt(this.plan, this.cycleT);
    this.onSegmentChange(seg, null);
    this.lastSeg = seg;
    this.applySegment(seg, this.cycleT, true);
  }

  // -- internals ------------------------------------------------------------

  private effectiveWeather(seg: CycleSegment): CycleWeather {
    return (resolveForcedWeather(this.spec) as CycleWeather | null) ?? seg.weather;
  }

  private captureBaseline(): void {
    const stashed = ENGINE_BASELINES.get(this.engine);
    if (stashed) {
      this.baseline = stashed;
      return;
    }
    const sky = this.engine.sky;
    const fog = this.engine.scene.fog as THREE.FogExp2 | null;
    const bg = this.engine.scene.background;
    const b: SkyBaseline = {
      sunColor: sky.sun.color.clone(),
      sunI: sky.sun.intensity,
      hemiI: sky.hemi.intensity,
      ambientI: sky.ambient.intensity,
      fogColor: fog ? fog.color.clone() : new THREE.Color('#000000'),
      fogDensity: fog ? fog.density : 0,
      bg: bg instanceof THREE.Color ? bg.clone() : null,
      exposure: this.engine.renderer.toneMappingExposure,
    };
    ENGINE_BASELINES.set(this.engine, b);
    this.baseline = b;
  }

  private restoreBaseline(): void {
    const b = this.baseline;
    if (!b) return;
    const sky = this.engine.sky;
    sky.sun.color.copy(b.sunColor);
    sky.sun.intensity = b.sunI;
    sky.hemi.intensity = b.hemiI;
    sky.ambient.intensity = b.ambientI;
    const fog = this.engine.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(b.fogColor);
      fog.density = b.fogDensity;
    }
    if (b.bg && this.engine.scene.background instanceof THREE.Color) {
      this.engine.scene.background.copy(b.bg);
    }
    this.engine.renderer.toneMappingExposure = b.exposure;
  }

  /** Blend factor 0..1 into the next segment over the transition window. */
  private transitionK(plan: WeatherPlan, seg: CycleSegment, t: number): number {
    const remain = seg.endT - t;
    const w = WEATHER_TUNING.transitionSec;
    if (remain >= w) return 0;
    return Math.min(1, Math.max(0, 1 - remain / w));
  }

  private applySegment(seg: CycleSegment, t: number, snap: boolean): void {
    const b = this.baseline;
    if (!b || !this.plan) return;
    const T = WEATHER_TUNING;
    const sky = this.engine.sky;
    const weather = this.effectiveWeather(seg);

    // light targets for this segment and the next (for the boundary blend)
    const cur = T.phaseLight[seg.phase];
    let sunF = cur.sun * T.sunWeatherMult[weather];
    let hemiF = cur.hemi;
    let ambF = cur.ambient;
    let expF = cur.exposure;
    this.tmpC.set(cur.sunTint);
    if (!snap) {
      const k = this.transitionK(this.plan, seg, t);
      if (k > 0) {
        const nxt = T.phaseLight[nextSegment(this.plan, seg).phase];
        sunF += (nxt.sun * T.sunWeatherMult[weather] - sunF) * k;
        hemiF += (nxt.hemi - hemiF) * k;
        ambF += (nxt.ambient - ambF) * k;
        expF += (nxt.exposure - expF) * k;
        this.tmpC2.set(nxt.sunTint);
        this.tmpC.lerp(this.tmpC2, k);
      }
    }
    // sun color: baseline tinted toward the phase tint (white = identity)
    sky.sun.color.copy(b.sunColor).lerp(this.tmpC, 0.55);
    sky.sun.intensity = b.sunI * sunF;
    sky.hemi.intensity = b.hemiI * hemiF;
    sky.ambient.intensity = b.ambientI * ambF;
    this.engine.renderer.toneMappingExposure = b.exposure * expF;

    const fog = this.engine.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density = b.fogDensity * T.fogDensityMult[weather];
      const cm = T.fogColorMult[weather];
      fog.color.copy(b.fogColor).multiplyScalar(cm);
      if (this.engine.scene.background instanceof THREE.Color) {
        this.engine.scene.background.copy(fog.color);
      }
    }
  }

  private onSegmentChange(seg: CycleSegment, prev: CycleSegment | null): void {
    const weather = this.effectiveWeather(seg);
    const prevWeather = prev ? this.effectiveWeather(prev) : null;
    if (weather !== prevWeather) {
      // drive particle drizzle through the existing path (idempotent per kind)
      const p = this.engine.particles as unknown as {
        setWeather?: (k: Weather, seed: number, q: 'retro' | 'standard' | 'high', g?: string) => void;
      };
      p.setWeather?.(weather, this.spec.meta.seed, this.engine.effectiveQuality(), this.spec.meta.genre);
      if (weather === 'storm') this.opts.toast?.('STORM ROLLING IN');
      else if (weather === 'rain' && prevWeather !== 'storm') this.opts.toast?.('RAIN');
    }
    if (seg.phase !== prev?.phase) {
      if (seg.phase === 'night') this.opts.toast?.('NIGHT FALLS — hostiles grow bolder');
      else if (seg.phase === 'dawn') this.opts.toast?.('DAWN BREAKS');
    }
  }

  private ensureStrikeMeshes(): void {
    if (this.ring && this.bolt) return;
    const T = WEATHER_TUNING.storm;
    const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    const ringMat = new THREE.MeshBasicMaterial({
      color: T.telegraphColor, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    const boltGeo = new THREE.BoxGeometry(0.6, 46, 0.6);
    const boltMat = new THREE.MeshBasicMaterial({ color: T.boltColor, transparent: true, opacity: 0.95, depthWrite: false });
    this.bolt = new THREE.Mesh(boltGeo, boltMat);
    this.bolt.visible = false;
    this.engine.scene.add(this.ring, this.bolt);
  }

  private groundY(x: number, z: number): number {
    const t = (this.engine as unknown as { terrain?: { heightAt?: (x: number, z: number) => number } }).terrain;
    return t?.heightAt ? t.heightAt(x, z) : 0;
  }

  private processStrikes(plan: WeatherPlan): void {
    const T = WEATHER_TUNING.storm;
    // fire strikes whose time has come
    while (this.strikeIdx < plan.strikes.length && plan.strikes[this.strikeIdx].at <= this.cycleT) {
      const s = plan.strikes[this.strikeIdx];
      const seg = segmentAt(plan, s.at);
      if (this.effectiveWeather(seg) === 'storm') this.fireStrike(s);
      if (this.telegraphAt === this.strikeIdx) {
        this.telegraphAt = -1;
        if (this.ring) this.ring.visible = false;
      }
      this.strikeIdx++;
    }
    // telegraph the next strike (storm only)
    const next = plan.strikes[this.strikeIdx];
    if (next && this.telegraphAt !== this.strikeIdx) {
      const seg = segmentAt(plan, next.at);
      if (this.effectiveWeather(seg) === 'storm' && next.at - this.cycleT <= T.telegraphSec && next.at > this.cycleT) {
        this.telegraphAt = this.strikeIdx;
        if (this.ring) {
          const y = this.groundY(next.x, next.z);
          this.ring.position.set(next.x, y + 0.15, next.z);
          this.ring.visible = true;
        }
      }
    }
    // pulse the telegraph ring (pure function of the cycle clock)
    if (this.ring?.visible && this.telegraphAt >= 0) {
      const s = 1 + 0.1 * Math.sin(this.cycleT * 18);
      this.ring.scale.setScalar(T.radius * s);
    }
  }

  private fireStrike(s: LightningStrike): void {
    const T = WEATHER_TUNING.storm;
    const y = this.groundY(s.x, s.z);
    this.tmpV.set(s.x, y + 2, s.z);
    if (this.bolt) {
      this.bolt.position.set(s.x, y + 23, s.z);
      this.bolt.visible = true;
      this.boltUntil = this.cycleT + 0.12;
    }
    // light pop through the pooled flash system (no new lights)
    this.engine.sky.lightLife.flash(T.boltColor, this.tmpV, 30, 60, 0.3);
    this.engine.audio.play('thunder');
    // hazard: player inside the radius takes the hit
    const pp = this.opts.playerPos();
    if (pp) {
      const dx = pp.x - s.x, dz = pp.z - s.z;
      if (dx * dx + dz * dz <= T.radius * T.radius) {
        this.opts.damagePlayer(T.damage, this.tmpV);
      }
    }
    this.firedCount++;
  }
}
