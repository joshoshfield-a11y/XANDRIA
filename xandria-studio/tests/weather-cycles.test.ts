/**
 * UPGRADE LOOP (weather-cycles phase): seeded day/night + weather cycles.
 * - WEATHER_SALT is distinct from every other system salt
 * - WEATHER_TUNING is sane (fractions sum to 1, positive weights/bounds)
 * - planWeatherCycle is pure + deterministic (same seed → identical plan)
 * - segments tile the cycle contiguously; a night band always exists
 * - strikes are sorted, bounded, inside storm spans
 * - segmentAt wraps correctly
 * - resolvers: enabled default true, forced parse
 * - manager: lifecycle, determinism, night damage hooks, forced weather,
 *   lightning hazard, portal round-trip, idempotent despawnAll, baseline restore
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 600,
      appendChild(c: any) { el.children.push(c); return c; }, append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {}, setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {}, removeEventListener() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas'); shadowMap: any = {}; toneMapping: any = null; toneMappingExposure = 1;
    setPixelRatio() {} setSize() {} getPixelRatio() { return 1; } getSize() { return { width: 800, height: 600 }; }
    dispose() {} render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import {
  WEATHER_SALT,
  WEATHER_TUNING,
  CYCLE_WEATHERS,
  planWeatherCycle,
  segmentAt,
  resolveWeatherCyclesEnabled,
  resolveForcedWeather,
  WeatherCycleManager,
  type WeatherPlan,
} from '../src/engine/game/weatherCycles';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { BOSS_SALT } from '../src/engine/game/bosses';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { SCALING_SALT } from '../src/engine/game/enemyScaling';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { LOOT_SALT } from '../src/engine/game/loot';
import { MASTER_SALT } from '../src/engine/game/mastercraft';
import { QUEST_SALT } from '../src/engine/game/quests';
import { SIDE_QUEST_SALT } from '../src/engine/game/sidequests';
import { STATION_SALT } from '../src/engine/game/stations';
import { QUEST_REWARD_BONUS_SALT } from '../src/engine/game/questRewards';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

function makeManager(engine: Engine, spec?: GameSpec) {
  const hits: Array<{ dmg: number; from: THREE.Vector3 }> = [];
  const toasts: string[] = [];
  const s = spec ?? (engine as any).spec as GameSpec;
  const mgr = new WeatherCycleManager(engine, s, {
    playerPos: () => new THREE.Vector3(1000, 0, 1000), // far from every strike by default
    damagePlayer: (dmg, from) => { hits.push({ dmg, from }); },
    toast: (m) => { toasts.push(m); },
  });
  return { mgr, hits, toasts, spec: s };
}

/** first seed in 1..200 whose plan contains at least one lightning strike */
function seedWithStrikes(): number {
  for (let seed = 1; seed <= 200; seed++) {
    if (planWeatherCycle(seed).strikes.length > 0) return seed;
  }
  throw new Error('no seed in 1..200 produced storm strikes');
}

describe('WEATHER_SALT', () => {
  it('is distinct from every other system salt', () => {
    const others = [ENEMY_SALT, NPC_SALT, BOSS_SALT, CRAFT_SALT, SCALING_SALT, GATHER_SALT, LOOT_SALT, MASTER_SALT, QUEST_SALT, SIDE_QUEST_SALT, STATION_SALT, QUEST_REWARD_BONUS_SALT];
    expect(others).not.toContain(WEATHER_SALT);
    expect(new Set([WEATHER_SALT, ...others]).size).toBe(others.length + 1);
  });
});

describe('WEATHER_TUNING', () => {
  it('phase fractions sum to 1 and light factors are sane', () => {
    const f = WEATHER_TUNING.phaseFractions;
    expect(f.day + f.dusk + f.night + f.dawn).toBeCloseTo(1, 6);
    expect(WEATHER_TUNING.phaseLight.night.sun).toBeLessThan(WEATHER_TUNING.phaseLight.day.sun);
    expect(WEATHER_TUNING.phaseLight.night.hemi).toBeLessThanOrEqual(1);
    expect(WEATHER_TUNING.transitionSec).toBeGreaterThan(0);
  });
  it('weather weights are positive and fog mults ordered', () => {
    for (const w of CYCLE_WEATHERS) expect(WEATHER_TUNING.weatherWeights[w]).toBeGreaterThan(0);
    expect(WEATHER_TUNING.fogDensityMult.fog).toBeGreaterThan(WEATHER_TUNING.fogDensityMult.rain);
    expect(WEATHER_TUNING.fogDensityMult.rain).toBeGreaterThan(WEATHER_TUNING.fogDensityMult.clear);
    expect(WEATHER_TUNING.weatherMinSec).toBeLessThan(WEATHER_TUNING.weatherMaxSec);
  });
  it('storm hazard numbers are positive and sane', () => {
    const s = WEATHER_TUNING.storm;
    expect(s.damage).toBeGreaterThan(0);
    expect(s.radius).toBeGreaterThan(0);
    expect(s.telegraphSec).toBeGreaterThan(0);
    expect(s.intervalMinSec).toBeLessThan(s.intervalMaxSec);
  });
  it('night damage table only boosts (never nerfs below 1)', () => {
    for (const k of Object.keys(WEATHER_TUNING.nightEnemyDamageMult) as Array<keyof typeof WEATHER_TUNING.nightEnemyDamageMult>) {
      expect(WEATHER_TUNING.nightEnemyDamageMult[k]!).toBeGreaterThanOrEqual(1);
    }
    expect(WEATHER_TUNING.nightEnemyDamageMult.brute).toBeGreaterThan(1);
  });
});

describe('planWeatherCycle (pure scheduler)', () => {
  it('is deterministic: same seed → identical plan', () => {
    const a = JSON.stringify(planWeatherCycle(20261012));
    const b = JSON.stringify(planWeatherCycle(20261012));
    expect(a).toBe(b);
  });
  it('varies across seeds', () => {
    const a = JSON.stringify(planWeatherCycle(1));
    const b = JSON.stringify(planWeatherCycle(2));
    expect(a).not.toBe(b);
  });
  it('segments tile the cycle contiguously from 0 to cycleSec', () => {
    const plan = planWeatherCycle(777);
    expect(plan.segments.length).toBeGreaterThan(4);
    expect(plan.segments[0].startT).toBe(0);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i].startT).toBeCloseTo(plan.segments[i - 1].endT, 9);
    }
    expect(plan.segments[plan.segments.length - 1].endT).toBeCloseTo(plan.cycleSec, 9);
  });
  it('always contains a night band with real duration', () => {
    for (const seed of [1, 42, 20261012, 999999]) {
      const plan = planWeatherCycle(seed);
      const nightSec = plan.segments.filter((s) => s.phase === 'night').reduce((a, s) => a + (s.endT - s.startT), 0);
      expect(nightSec).toBeGreaterThan(plan.cycleSec * 0.1);
      const phases = new Set(plan.segments.map((s) => s.phase));
      expect(phases).toEqual(new Set(['day', 'dusk', 'night', 'dawn']));
    }
  });
  it('strikes are sorted, bounded, and inside storm spans', () => {
    for (const seed of [1, 42, 20261012]) {
      const plan = planWeatherCycle(seed);
      expect(plan.strikes.length).toBeLessThanOrEqual(48);
      const ats = plan.strikes.map((s) => s.at);
      expect([...ats].sort((a, b) => a - b)).toEqual(ats);
      // every strike lands inside a storm weather span
      for (const s of plan.strikes) {
        const spanHit = plan.segments.some((seg) => seg.weather === 'storm' && s.at >= seg.startT && s.at < seg.endT);
        expect(spanHit).toBe(true);
        expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(70.001);
        expect(Math.hypot(s.x, s.z)).toBeGreaterThanOrEqual(11.999);
      }
    }
  });
  it('segmentAt wraps around the cycle', () => {
    const plan = planWeatherCycle(555);
    const a = segmentAt(plan, 5);
    const b = segmentAt(plan, 5 + plan.cycleSec);
    expect(b).toBe(a);
    expect(segmentAt(plan, -1)).toBe(segmentAt(plan, plan.cycleSec - 1));
    expect(segmentAt(plan, 0)).toBe(plan.segments[0]);
  });
});

describe('resolvers', () => {
  it('enabled defaults to true; explicit false disables', () => {
    const s = defaultSpec(1) as GameSpec;
    expect(resolveWeatherCyclesEnabled(s)).toBe(true);
    s.custom = { ...(s.custom ?? {}), weatherCycles: { enabled: false } };
    expect(resolveWeatherCyclesEnabled(s)).toBe(false);
  });
  it('forced weather parses; auto/absent/invalid → null', () => {
    const s = defaultSpec(1) as GameSpec;
    expect(resolveForcedWeather(s)).toBeNull();
    s.custom = { ...(s.custom ?? {}), weatherCycles: { forced: 'auto' } };
    expect(resolveForcedWeather(s)).toBeNull();
    s.custom!.weatherCycles = { forced: 'storm' };
    expect(resolveForcedWeather(s)).toBe('storm');
    s.custom!.weatherCycles = { forced: 'snow' as never };
    expect(resolveForcedWeather(s)).toBeNull();
    s.custom!.weatherCycles = { forced: 'bogus' as never };
    expect(resolveForcedWeather(s)).toBeNull();
  });
});

describe('WeatherCycleManager lifecycle', () => {
  it('spawnForMap activates with the deterministic plan; two engines agree', () => {
    const e1 = makeEngine(), e2 = makeEngine();
    const m1 = makeManager(e1), m2 = makeManager(e2);
    m1.mgr.spawnForMap(4242);
    m2.mgr.spawnForMap(4242);
    expect(JSON.stringify(m1.mgr.getPlan())).toBe(JSON.stringify(planWeatherCycle(4242)));
    expect(JSON.stringify(m1.mgr.getPlan())).toBe(JSON.stringify(m2.mgr.getPlan()));
    expect(m1.mgr.current().active).toBe(true);
  });
  it('despawnAll is idempotent and restores the sky baseline', () => {
    const e = makeEngine();
    const { mgr } = makeManager(e);
    const sky = e.sky;
    const baseSunI = sky.sun.intensity;
    const baseFog = (e.scene.fog as THREE.FogExp2).density;
    mgr.spawnForMap(4242);
    // jump into a night segment and tick so the blend applies
    const plan = mgr.getPlan()!;
    const night = plan.segments.find((s) => s.phase === 'night')!;
    mgr.debugSetCycleT(night.startT + 1);
    mgr.update(1 / 60);
    expect(sky.sun.intensity).toBeLessThan(baseSunI);
    mgr.despawnAll();
    mgr.despawnAll(); // idempotent — no throw
    expect(sky.sun.intensity).toBeCloseTo(baseSunI, 9);
    expect((e.scene.fog as THREE.FogExp2).density).toBeCloseTo(baseFog, 9);
    expect(mgr.current().active).toBe(false);
  });
  it('portal round-trip regenerates the identical plan', () => {
    const e = makeEngine();
    const { mgr } = makeManager(e);
    mgr.spawnForMap(111);
    mgr.despawnAll();
    mgr.spawnForMap(222);
    expect(JSON.stringify(mgr.getPlan())).toBe(JSON.stringify(planWeatherCycle(222)));
    expect(mgr.current().cycleT).toBe(0);
  });
  it('disabled spec leaves the manager inert and the sky untouched', () => {
    const e = makeEngine();
    const spec = defaultSpec(7) as GameSpec;
    spec.custom = { ...(spec.custom ?? {}), weatherCycles: { enabled: false } };
    const { mgr } = makeManager(e, spec);
    const baseSunI = e.sky.sun.intensity;
    mgr.spawnForMap(4242);
    expect(mgr.current().active).toBe(false);
    mgr.update(1);
    expect(e.sky.sun.intensity).toBe(baseSunI);
    mgr.despawnAll(); // no-op, no throw
  });
  it('forced weather pins the weather while the phase cycle runs', () => {
    const e = makeEngine();
    const spec = defaultSpec(7) as GameSpec;
    spec.custom = { ...(spec.custom ?? {}), weatherCycles: { forced: 'storm' } };
    const { mgr } = makeManager(e, spec);
    mgr.spawnForMap(4242);
    const plan = mgr.getPlan()!;
    // pick a segment that is NOT storm in the natural plan
    const nonStorm = plan.segments.find((s) => s.weather !== 'storm')!;
    mgr.debugSetCycleT(nonStorm.startT + 0.5);
    expect(mgr.current().weather).toBe('storm');
    expect(mgr.current().phase).toBe(nonStorm.phase);
  });
  it('night damage hook: 1 by day, boosted for heavy kinds at night, 1 for others', () => {
    const e = makeEngine();
    const { mgr } = makeManager(e);
    mgr.spawnForMap(4242);
    const plan = mgr.getPlan()!;
    const day = plan.segments.find((s) => s.phase === 'day')!;
    const night = plan.segments.find((s) => s.phase === 'night')!;
    mgr.debugSetCycleT(day.startT + 0.5);
    expect(mgr.enemyDamageMult('brute')).toBe(1);
    expect(mgr.enemyDamageMult('walker')).toBe(1);
    mgr.debugSetCycleT(night.startT + 0.5);
    expect(mgr.enemyDamageMult('brute')).toBe(WEATHER_TUNING.nightEnemyDamageMult.brute);
    expect(mgr.enemyDamageMult('walker')).toBe(WEATHER_TUNING.nightEnemyDamageMult.walker);
    expect(mgr.enemyDamageMult('drone')).toBe(1);
    expect(mgr.enemyDamageMult(undefined)).toBe(1);
  });
  it('NIGHT FALLS toast fires on entering night', () => {
    const e = makeEngine();
    const { mgr, toasts } = makeManager(e);
    mgr.spawnForMap(4242);
    const plan = mgr.getPlan()!;
    const night = plan.segments.find((s) => s.phase === 'night')!;
    mgr.debugSetCycleT(night.startT + 0.5);
    expect(toasts.some((t) => t.includes('NIGHT FALLS'))).toBe(true);
  });
  it('lightning: strike at the player damages; far strike does not', () => {
    const seed = seedWithStrikes();
    const e = makeEngine();
    const spec = defaultSpec(7) as GameSpec;
    spec.custom = { ...(spec.custom ?? {}), weatherCycles: { forced: 'storm' } };
    const hits: Array<{ dmg: number }> = [];
    const playerAt = new THREE.Vector3(1000, 0, 1000);
    const mgr = new WeatherCycleManager(e, spec, {
      playerPos: () => playerAt,
      damagePlayer: (dmg) => { hits.push({ dmg }); },
    });
    mgr.spawnForMap(seed);
    const plan = mgr.getPlan()!;
    const strike = plan.strikes[0];
    // stand in the strike zone
    playerAt.set(strike.x, 0, strike.z);
    mgr.debugSetCycleT(strike.at - 0.05);
    mgr.update(0.2);
    expect(hits.length).toBe(1);
    expect(hits[0].dmg).toBe(WEATHER_TUNING.storm.damage);
    // next strike, player far away → no hit
    const strike2 = plan.strikes[1];
    playerAt.set(1000, 0, 1000);
    mgr.debugSetCycleT(strike2.at - 0.05);
    mgr.update(0.2);
    expect(hits.length).toBe(1);
  });
  it('cycle wrap resets the strike pointer (strikes refire next cycle)', () => {
    const seed = seedWithStrikes();
    const e = makeEngine();
    const spec = defaultSpec(7) as GameSpec;
    spec.custom = { ...(spec.custom ?? {}), weatherCycles: { forced: 'storm' } };
    const hits: number[] = [];
    const playerAt = new THREE.Vector3(1000, 0, 1000);
    const mgr = new WeatherCycleManager(e, spec, {
      playerPos: () => playerAt,
      damagePlayer: (dmg) => { hits.push(dmg); },
    });
    mgr.spawnForMap(seed);
    const plan = mgr.getPlan()!;
    const strike = plan.strikes[0];
    playerAt.set(strike.x, 0, strike.z);
    mgr.debugSetCycleT(strike.at - 0.05);
    mgr.update(0.2);
    expect(hits.length).toBe(1);
    // jump past the end of the cycle → wrap → the same strike fires again
    mgr.debugSetCycleT(plan.cycleSec - 0.05);
    mgr.update(0.2); // wraps
    mgr.debugSetCycleT(strike.at - 0.05);
    mgr.update(0.2);
    expect(hits.length).toBe(2);
  });
  it('in-place restart does not drift the baseline (stash per engine)', () => {
    const e = makeEngine();
    const authoredSunI = e.sky.sun.intensity;
    const { mgr: mgr1 } = makeManager(e);
    mgr1.spawnForMap(4242);
    const plan = mgr1.getPlan()!;
    const night = plan.segments.find((s) => s.phase === 'night')!;
    mgr1.debugSetCycleT(night.startT + 1);
    mgr1.update(1 / 60);
    expect(e.sky.sun.intensity).toBeLessThan(authoredSunI);
    // simulate resetRun(): the old manager is torn down WITHOUT despawnAll
    const { mgr: mgr2 } = makeManager(e);
    mgr2.spawnForMap(4242);
    const day = plan.segments.find((s) => s.phase === 'day' && s.weather === 'clear') ?? plan.segments[0];
    mgr2.debugSetCycleT(day.startT + 1);
    mgr2.update(1 / 60);
    // day on a clear segment must restore the authored intensity, not a
    // night-modified value captured fresh
    expect(e.sky.sun.intensity).toBeCloseTo(authoredSunI, 6);
  });
  it('update before spawnForMap is a safe no-op', () => {
    const e = makeEngine();
    const { mgr } = makeManager(e);
    expect(() => mgr.update(1 / 60)).not.toThrow();
    expect(mgr.current().active).toBe(false);
  });
});
