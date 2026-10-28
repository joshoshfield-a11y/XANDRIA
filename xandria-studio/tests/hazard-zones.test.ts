/**
 * UPGRADE LOOP (hazard-zones phase): seeded environmental hazard zones.
 * - HAZARD_SALT is distinct from every other system salt
 * - HAZARD_DEFS is sane (positive damage/radius, telegraph < interval,
 *   tick intervals clear the 0.8s avatar iframes)
 * - planHazardZones is pure + deterministic (same seed → identical set),
 *   varies across seeds, stays in bounds, rings anchors, keeps separation
 *   and spawn clearance, honors spec counts / enabled:false
 * - resolvers: enabled default true, counts clamped 0..4
 * - manager: lifecycle, telegraph-before-tick ordering, exact tick
 *   damage through the damage sink, no damage outside the radius,
 *   portal round-trip regenerates the identical set, idempotent
 *   despawnAll, disabled spec leaves the manager inert
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 600,
      appendChild(c: any) { el.children.push(c); return c; }, append(...cs: any[]) { for (const c of cs) el.children.push(c); }, remove() {}, setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
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
  HAZARD_SALT,
  HAZARD_DEFS,
  HAZARD_MIN_SEPARATION,
  HAZARD_MIN_SPAWN_DIST,
  hazardDefById,
  planHazardZones,
  resolveHazardsEnabled,
  resolveHazardCount,
  HazardZoneManager,
} from '../src/engine/game/hazardZones';
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
import { EVENT_SALT } from '../src/engine/game/dynamicEvents';
import { WEATHER_SALT } from '../src/engine/game/weatherCycles';

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
  const warnings: string[] = [];
  const player = { pos: new THREE.Vector3(1000, 0, 1000) };
  const s = spec ?? (engine as any).spec as GameSpec;
  const mgr = new HazardZoneManager(engine, s, {
    playerPos: () => player.pos,
    damagePlayer: (dmg, from) => { hits.push({ dmg, from }); },
    playWarning: (k) => { warnings.push(k); },
  });
  return { mgr, hits, warnings, player, spec: s };
}

describe('HAZARD_SALT', () => {
  it('is distinct from every other system salt', () => {
    const others = [ENEMY_SALT, NPC_SALT, BOSS_SALT, CRAFT_SALT, SCALING_SALT, GATHER_SALT, LOOT_SALT, MASTER_SALT, QUEST_SALT, SIDE_QUEST_SALT, STATION_SALT, QUEST_REWARD_BONUS_SALT, EVENT_SALT, WEATHER_SALT];
    expect(others).not.toContain(HAZARD_SALT);
    expect(new Set([HAZARD_SALT, ...others]).size).toBe(others.length + 1);
  });
});

describe('HAZARD_DEFS', () => {
  it('covers exactly the three briefed kinds with unique ids', () => {
    expect(HAZARD_DEFS.map((d) => d.id)).toEqual(['hazard_spike_field', 'hazard_ember_vent', 'hazard_toxic_pool']);
    expect(new Set(HAZARD_DEFS.map((d) => d.id)).size).toBe(3);
  });
  it('tuning is sane: positive damage/radius, telegraph inside the tick interval, intervals clear avatar iframes', () => {
    for (const d of HAZARD_DEFS) {
      expect(d.damage).toBeGreaterThan(0);
      expect(d.radius).toBeGreaterThan(0);
      expect(d.telegraphSec).toBeGreaterThan(0);
      expect(d.telegraphSec).toBeLessThan(d.tickIntervalSec);
      expect(d.tickIntervalSec).toBeGreaterThan(0.8); // avatar damage() iframes
      expect(d.ringMin).toBeLessThan(d.ringMax);
      expect(d.defaultCount).toBeGreaterThan(0);
      expect(/^#[0-9a-f]{6}$/.test(d.color)).toBe(true);
      expect(/^#[0-9a-f]{6}$/.test(d.warningColor)).toBe(true);
      expect(hazardDefById(d.id)).toBe(d);
    }
    expect(hazardDefById('nope')).toBeNull();
  });
});

describe('planHazardZones (pure scheduler)', () => {
  const spec = () => defaultSpec(99) as GameSpec;
  it('is deterministic: same seed → identical plan', () => {
    const a = planHazardZones(4242, spec(), []);
    const b = planHazardZones(4242, spec(), []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });
  it('varies across seeds', () => {
    const a = planHazardZones(1, spec(), []);
    const b = planHazardZones(2, spec(), []);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
  it('stays in bounds, keeps separation, and clears the spawn origin', () => {
    const s = spec();
    const size = s.world.terrain.size;
    const half = size / 2;
    for (const seed of [1, 7, 42, 4242, 99999]) {
      const plan = planHazardZones(seed, s, []);
      for (const p of plan) {
        const def = hazardDefById(p.defId)!;
        expect(Math.abs(p.x)).toBeLessThanOrEqual(half - def.radius - 4);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(half - def.radius - 4);
        expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(HAZARD_MIN_SPAWN_DIST);
        expect(p.phaseOffset).toBeGreaterThanOrEqual(0);
        expect(p.phaseOffset).toBeLessThan(def.tickIntervalSec);
      }
      for (let i = 0; i < plan.length; i++) {
        for (let j = i + 1; j < plan.length; j++) {
          expect(Math.hypot(plan[i].x - plan[j].x, plan[i].z - plan[j].z))
            .toBeGreaterThanOrEqual(HAZARD_MIN_SEPARATION - 1e-6);
        }
      }
    }
  });
  it('rings POI anchors outside their footprints', () => {
    const s = spec();
    const anchors = [{ x: 50, z: -30, r: 10 }];
    const plan = planHazardZones(4242, s, anchors);
    expect(plan.length).toBeGreaterThan(0);
    for (const p of plan) {
      const def = hazardDefById(p.defId)!;
      const d = Math.hypot(p.x - 50, p.z + 30);
      expect(d).toBeGreaterThanOrEqual(10 + def.ringMin - 1e-6);
      expect(d).toBeLessThanOrEqual(10 + def.ringMax + 1e-6);
    }
  });
  it('honors spec counts, including zero', () => {
    const s = spec();
    s.custom = { hazards: { counts: { hazard_spike_field: 0, hazard_ember_vent: 3, hazard_toxic_pool: 1 } } };
    const plan = planHazardZones(4242, s, []);
    expect(plan.filter((p) => p.defId === 'hazard_spike_field')).toHaveLength(0);
    expect(plan.filter((p) => p.defId === 'hazard_ember_vent')).toHaveLength(3);
    expect(plan.filter((p) => p.defId === 'hazard_toxic_pool')).toHaveLength(1);
  });
  it('enabled:false plans nothing', () => {
    const s = spec();
    s.custom = { hazards: { enabled: false } };
    expect(planHazardZones(4242, s, [])).toEqual([]);
  });
});

describe('resolvers', () => {
  it('enabled defaults to true; explicit false disables', () => {
    const s = defaultSpec(99) as GameSpec;
    expect(resolveHazardsEnabled(s)).toBe(true);
    s.custom = { hazards: { enabled: false } };
    expect(resolveHazardsEnabled(s)).toBe(false);
  });
  it('counts clamp to 0..4 and default per def', () => {
    const s = defaultSpec(99) as GameSpec;
    const def = HAZARD_DEFS[0];
    expect(resolveHazardCount(s, def)).toBe(def.defaultCount);
    s.custom = { hazards: { counts: { [def.id]: 99 } } };
    expect(resolveHazardCount(s, def)).toBe(4);
    s.custom = { hazards: { counts: { [def.id]: -3 } } };
    expect(resolveHazardCount(s, def)).toBe(0);
  });
});

describe('HazardZoneManager lifecycle', () => {
  it('spawnForMap activates with the deterministic plan; two engines agree', () => {
    const e1 = makeEngine(), e2 = makeEngine();
    const m1 = makeManager(e1), m2 = makeManager(e2);
    m1.mgr.spawnForMap(4242);
    m2.mgr.spawnForMap(4242);
    expect(JSON.stringify(m1.mgr.getPlan())).toBe(JSON.stringify(m2.mgr.getPlan()));
    expect(JSON.stringify(m1.mgr.getPlan())).toBe(
      JSON.stringify(planHazardZones(4242, m1.spec, [])));
    expect(m1.mgr.zones.length).toBeGreaterThan(0);
    expect(m1.mgr.zones.every((z) => z.decal !== null)).toBe(true);
    expect(m1.mgr.current().active).toBe(true);
  });
  it('despawnAll is idempotent and removes every decal from the scene', () => {
    const e = makeEngine();
    const { mgr } = makeManager(e);
    mgr.spawnForMap(4242);
    const before = e.scene.children.length;
    expect(before).toBeGreaterThan(0);
    mgr.despawnAll();
    expect(mgr.zones).toHaveLength(0);
    expect(e.scene.children.length).toBeLessThan(before);
    mgr.despawnAll(); // idempotent — no throw
    expect(mgr.zones).toHaveLength(0);
  });
  it('portal round-trip regenerates the identical set', () => {
    const e = makeEngine();
    const { mgr, spec } = makeManager(e);
    mgr.spawnForMap(111);
    const first = JSON.stringify(mgr.getPlan());
    mgr.despawnAll();
    mgr.spawnForMap(222);
    expect(JSON.stringify(mgr.getPlan())).not.toBe(first);
    mgr.despawnAll();
    mgr.spawnForMap(111);
    expect(JSON.stringify(mgr.getPlan())).toBe(first);
    expect(JSON.stringify(mgr.getPlan())).toBe(JSON.stringify(planHazardZones(111, spec, [])));
  });
  it('disabled spec leaves the manager inert', () => {
    const e = makeEngine();
    const s = (e as any).spec as GameSpec;
    s.custom = { hazards: { enabled: false } };
    const { mgr } = makeManager(e, s);
    mgr.spawnForMap(4242);
    expect(mgr.zones).toHaveLength(0);
    expect(mgr.current().active).toBe(false);
    mgr.despawnAll(); // no-op, no throw
  });

  it('telegraph precedes the first tick, and the tick deals exactly the tuned damage', () => {
    const e = makeEngine();
    const { mgr, hits, warnings, player } = makeManager(e);
    mgr.spawnForMap(4242);
    const z = mgr.zones[0];
    // stand in the zone center
    player.pos.set(z.plan.x, 0, z.plan.z);
    // step in small increments: record when telegraphing first appears
    // and when the first damage lands
    let firstTelegraphAt: number | null = null;
    let firstDamageAt: number | null = null;
    let t = 0;
    for (let i = 0; i < 400 && firstDamageAt === null; i++) {
      mgr.debugTick(0.05);
      t += 0.05;
      const cur = mgr.zones[0];
      if (cur.telegraphing && firstTelegraphAt === null) firstTelegraphAt = t;
      if (hits.length > 0 && firstDamageAt === null) firstDamageAt = t;
      // no damage before the telegraph window opens
      if (firstTelegraphAt === null) expect(hits).toHaveLength(0);
    }
    expect(firstTelegraphAt).not.toBeNull();
    expect(firstDamageAt).not.toBeNull();
    expect(firstTelegraphAt!).toBeLessThan(firstDamageAt!);
    expect(hits).toHaveLength(1);
    expect(hits[0].dmg).toBe(z.def.damage);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(z.ticksFired).toBe(1);
  });

  it('standing outside the radius takes no damage across ticks', () => {
    const e = makeEngine();
    const { mgr, hits, player } = makeManager(e);
    mgr.spawnForMap(4242);
    const z = mgr.zones[0];
    player.pos.set(z.plan.x + z.def.radius + 5, 0, z.plan.z);
    for (let i = 0; i < 60; i++) mgr.debugTick(0.1);
    expect(hits).toHaveLength(0);
    expect(z.ticksFired).toBeGreaterThanOrEqual(2);
  });

  it('consecutive ticks land while the player stays (intervals clear iframes)', () => {
    const e = makeEngine();
    const { mgr, hits, player } = makeManager(e);
    mgr.spawnForMap(4242);
    const z = mgr.zones[0];
    player.pos.set(z.plan.x, 0, z.plan.z);
    mgr.debugTick(10);
    expect(z.ticksFired).toBeGreaterThanOrEqual(3);
    expect(hits.length).toBe(z.ticksFired);
    expect(hits.every((h) => h.dmg === z.def.damage)).toBe(true);
  });

  it('markerView matches the live roster and flips color while telegraphing', () => {
    const e = makeEngine();
    const { mgr, player } = makeManager(e);
    mgr.spawnForMap(4242);
    const view = mgr.markerView();
    expect(view).toHaveLength(mgr.zones.length);
    expect(view[0].color).toBe(mgr.zones[0].def.color);
    const z = mgr.zones[0];
    player.pos.set(z.plan.x, 0, z.plan.z);
    // jump into the telegraph window of the first zone
    const target = z.nextTickAt - z.def.telegraphSec / 2;
    mgr.debugTick(Math.max(0, target - mgr.current().clock) + 0.01);
    const view2 = mgr.markerView();
    const m0 = view2.find((m) => m.defId === z.def.id && m.x === z.plan.x)!;
    expect(m0.telegraphing).toBe(true);
    expect(m0.color).toBe(z.def.warningColor);
  });
});
