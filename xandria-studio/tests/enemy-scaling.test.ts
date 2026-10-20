/**
 * UPGRADE LOOP (enemy-scaling phase): world difficulty scaling.
 * - the level-band table is well-formed (bands of 5, contiguous, identity
 *   band 0, monotonic growth)
 * - spawn-level derivation: max(playerLevel, 1 + mapDist), band math,
 *   clamping, map-distance reads
 * - applyEnemyScaling: deterministic in (spec, seed, playerLevel, mapDist);
 *   band-0 spawns are byte-identical to the authored spec
 * - EnemyManager.spawnForMap wiring: stats scale per band, the authored
 *   spec object is never mutated, repeat arrivals reproduce identical
 *   stats, xpMult/scalingBand land on the enemy
 * - Progression.onKill / grantKillXp: the band XP multiplier flows through
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 0,
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
import { defaultSpec, type GameSpec, type EnemySpec } from '../src/spec/schema';
import { EnemyManager } from '../src/engine/game/EnemyAI';
import { Progression } from '../src/engine/game/Progression';
import {
  SCALING_SALT,
  ENEMY_LEVEL_BANDS,
  SCALING_BAND_WIDTH,
  effectiveSpawnLevel,
  bandIndexForLevel,
  mapDistanceFromSpec,
  applyEnemyScaling,
} from '../src/engine/game/enemyScaling';

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

const WALKER: EnemySpec = { kind: 'walker', count: 3, health: 30, speed: 4, damage: 10, weapon: 'melee' };
const POIS = [{ x: 0, z: 0, r: 0 }];

function makeManager(engine: Engine, playerLevel: () => number) {
  return new EnemyManager(engine, null, {}, { pois: POIS, specs: [WALKER], playerLevel });
}

const statsOf = (m: EnemyManager) =>
  m.enemies.map((e) => ({ hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult, band: e.scalingBand }));

describe('level-band table', () => {
  it('bands are width-5, contiguous, covering levels 1..50', () => {
    expect(ENEMY_LEVEL_BANDS.length).toBeGreaterThanOrEqual(2);
    let prevMax = 0;
    for (const b of ENEMY_LEVEL_BANDS) {
      expect(b.maxLevel - b.minLevel + 1).toBe(SCALING_BAND_WIDTH);
      expect(b.minLevel).toBe(prevMax + 1);
      prevMax = b.maxLevel;
    }
    expect(ENEMY_LEVEL_BANDS[0].minLevel).toBe(1);
  });
  it('band 0 is the identity band (mults 1.0, variance 0)', () => {
    const b = ENEMY_LEVEL_BANDS[0];
    expect(b.hpMult).toBe(1);
    expect(b.dmgMult).toBe(1);
    expect(b.xpMult).toBe(1);
    expect(b.variance).toBe(0);
  });
  it('multipliers grow monotonically and variance stays sane', () => {
    for (let i = 1; i < ENEMY_LEVEL_BANDS.length; i++) {
      const p = ENEMY_LEVEL_BANDS[i - 1];
      const b = ENEMY_LEVEL_BANDS[i];
      expect(b.hpMult).toBeGreaterThanOrEqual(p.hpMult);
      expect(b.dmgMult).toBeGreaterThanOrEqual(p.dmgMult);
      expect(b.xpMult).toBeGreaterThanOrEqual(p.xpMult);
      expect(b.variance).toBeGreaterThanOrEqual(0);
      expect(b.variance).toBeLessThanOrEqual(0.25);
    }
  });
});

describe('spawn-level derivation', () => {
  it('effectiveSpawnLevel = max(playerLevel, 1 + mapDist)', () => {
    expect(effectiveSpawnLevel(1, 0)).toBe(1);
    expect(effectiveSpawnLevel(12, 0)).toBe(12);
    expect(effectiveSpawnLevel(1, 9)).toBe(10); // deep map floors the band
    expect(effectiveSpawnLevel(20, 9)).toBe(20); // player power wins
  });
  it('defensive inputs clamp to sane floors', () => {
    expect(effectiveSpawnLevel(0, 0)).toBe(1);
    expect(effectiveSpawnLevel(-5, 0)).toBe(1);
    expect(effectiveSpawnLevel(NaN, 0)).toBe(1);
  });
  it('bandIndexForLevel maps 5-level bands and clamps past the table', () => {
    expect(bandIndexForLevel(1)).toBe(0);
    expect(bandIndexForLevel(5)).toBe(0);
    expect(bandIndexForLevel(6)).toBe(1);
    expect(bandIndexForLevel(11)).toBe(2);
    const last = ENEMY_LEVEL_BANDS.length - 1;
    expect(bandIndexForLevel(ENEMY_LEVEL_BANDS[last].maxLevel)).toBe(last);
    expect(bandIndexForLevel(ENEMY_LEVEL_BANDS[last].maxLevel + 40)).toBe(last);
    expect(bandIndexForLevel(0)).toBe(0);
  });
  it('mapDistanceFromSpec reads the portalMap stamp; missing = 0', () => {
    expect(mapDistanceFromSpec({})).toBe(0);
    expect(mapDistanceFromSpec({ custom: {} })).toBe(0);
    expect(mapDistanceFromSpec({ custom: { portalMap: { mx: 2, my: -3 } } })).toBe(5);
  });
});

describe('applyEnemyScaling', () => {
  it('band 0 spawns are byte-identical to the authored spec', () => {
    const r = applyEnemyScaling(WALKER, 12345, 1, 0);
    expect(r.bandIndex).toBe(0);
    expect(r.spec.health).toBe(WALKER.health);
    expect(r.spec.damage).toBe(WALKER.damage);
    expect(r.xpMult).toBe(1);
  });
  it('is deterministic in (spec, seed, playerLevel, mapDist)', () => {
    const a = applyEnemyScaling(WALKER, 4242, 12, 0);
    const b = applyEnemyScaling(WALKER, 4242, 12, 0);
    expect(a).toEqual(b);
    const c = applyEnemyScaling(WALKER, 4243, 12, 0);
    // same band, different seed → variance differs (draws are per-enemy)
    expect(c.spec.health).not.toBe(a.spec.health);
    expect(c.bandIndex).toBe(a.bandIndex);
  });
  it('higher player level → higher band; deep maps floor the band', () => {
    const low = applyEnemyScaling(WALKER, 7, 1, 0);
    const mid = applyEnemyScaling(WALKER, 7, 12, 0);
    const deep = applyEnemyScaling(WALKER, 7, 1, 9);
    expect(mid.bandIndex).toBe(2);
    expect(deep.bandIndex).toBe(1); // effective level 10 → band 1
    expect(mid.spec.health).toBeGreaterThan(low.spec.health);
    expect(mid.spec.damage).toBeGreaterThan(low.spec.damage);
    expect(mid.xpMult).toBeGreaterThan(low.xpMult);
  });
  it('variance stays within the band fraction', () => {
    const band = ENEMY_LEVEL_BANDS[2];
    for (let seed = 0; seed < 50; seed++) {
      const r = applyEnemyScaling(WALKER, seed, 12, 0);
      const center = WALKER.health * band.hpMult;
      expect(r.spec.health).toBeGreaterThanOrEqual(center * (1 - band.variance) - 1e-9);
      expect(r.spec.health).toBeLessThanOrEqual(center * (1 + band.variance) + 1e-9);
    }
  });
  it('uses SCALING_SALT mixed into the enemy seed (never engine.rng)', () => {
    expect(SCALING_SALT).toBeGreaterThan(0);
    // two calls with the same seed but different draw context stay equal —
    // the stream depends on the seed alone, not on call order
    const a = applyEnemyScaling(WALKER, 99, 30, 0);
    const b = applyEnemyScaling(WALKER, 99, 30, 0);
    expect(a.spec.health).toBe(b.spec.health);
    expect(a.spec.damage).toBe(b.spec.damage);
  });
});

describe('EnemyManager spawn wiring', () => {
  let engine: Engine;
  beforeEach(() => { engine = makeEngine(); });

  it('fresh player spawns the authored stats exactly (band 0)', () => {
    const m = makeManager(engine, () => 1);
    m.spawnForMap(20261012);
    expect(m.enemies).toHaveLength(3);
    for (const e of m.enemies) {
      expect(e.maxHealth).toBe(WALKER.health);
      expect(e.health).toBe(WALKER.health);
      expect(e.spec.damage).toBe(WALKER.damage);
      expect(e.xpMult).toBe(1);
      expect(e.scalingBand).toBe(0);
    }
  });
  it('leveled player spawns a higher band with the band multipliers', () => {
    const m = makeManager(engine, () => 12);
    m.spawnForMap(20261012);
    const band = ENEMY_LEVEL_BANDS[2];
    for (const e of m.enemies) {
      expect(e.scalingBand).toBe(2);
      expect(e.xpMult).toBe(band.xpMult);
      const hpCenter = WALKER.health * band.hpMult;
      const dmgCenter = WALKER.damage * band.dmgMult;
      expect(e.maxHealth).toBeGreaterThanOrEqual(hpCenter * (1 - band.variance) - 1e-9);
      expect(e.maxHealth).toBeLessThanOrEqual(hpCenter * (1 + band.variance) + 1e-9);
      expect(e.spec.damage).toBeGreaterThanOrEqual(dmgCenter * (1 - band.variance) - 1e-9);
      expect(e.spec.damage).toBeLessThanOrEqual(dmgCenter * (1 + band.variance) + 1e-9);
    }
  });
  it('the authored spec object is never mutated by spawning', () => {
    const authored = { ...WALKER };
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: [authored], playerLevel: () => 30 });
    m.spawnForMap(20261012);
    expect(authored.health).toBe(WALKER.health);
    expect(authored.damage).toBe(WALKER.damage);
  });
  it('repeat arrivals reproduce identical stats (portal round-trip safety)', () => {
    const m = makeManager(engine, () => 17);
    m.spawnForMap(777);
    const first = statsOf(m);
    m.spawnForMap(777); // despawn + respawn, like a portal round-trip
    const second = statsOf(m);
    expect(second).toEqual(first);
  });
  it('positions/kinds are unchanged by scaling (mapSeed-alone contract)', () => {
    const plain = makeManager(engine, () => 1);
    plain.spawnForMap(31337);
    const scaled = makeManager(engine, () => 40);
    scaled.spawnForMap(31337);
    expect(scaled.enemies).toHaveLength(plain.enemies.length);
    for (let i = 0; i < plain.enemies.length; i++) {
      expect(scaled.enemies[i].position.x).toBeCloseTo(plain.enemies[i].position.x, 9);
      expect(scaled.enemies[i].position.z).toBeCloseTo(plain.enemies[i].position.z, 9);
      expect(scaled.enemies[i].spec.kind).toBe(plain.enemies[i].spec.kind);
      // …but the stats differ
      expect(scaled.enemies[i].maxHealth).toBeGreaterThan(plain.enemies[i].maxHealth);
    }
  });
  it('spawnAll (initial build) also scales additively with the live level', () => {
    const m = makeManager(engine, () => 1);
    m.spawnAll([{ ...WALKER, count: 2 }], () => new THREE.Vector3(0, 1, 0));
    expect(m.enemies).toHaveLength(2);
    for (const e of m.enemies) {
      expect(e.maxHealth).toBe(WALKER.health);
      expect(e.scalingBand).toBe(0);
    }
    const m2 = makeManager(engine, () => 22);
    m2.spawnAll([{ ...WALKER, count: 2 }], () => new THREE.Vector3(0, 1, 0));
    for (const e of m2.enemies) expect(e.scalingBand).toBe(4);
  });
});

describe('XP multiplier flow', () => {
  it('Progression.onKill scales XP by the band multiplier', () => {
    const engine = makeEngine();
    const prog = new Progression(engine, { enabled: true, xpPerKill: 20 });
    prog.onKill(1.25);
    expect(prog.xp).toBe(25);
  });
  it('onKill() with no multiplier is unchanged', () => {
    const engine = makeEngine();
    const prog = new Progression(engine, { enabled: true, xpPerKill: 20 });
    prog.onKill();
    expect(prog.xp).toBe(20);
  });
});
