/**
 * Wandering world-boss wave unit tests.
 * - salt distinctness (WORLDBOSS_SALT vs every other system salt)
 * - planWorldBoss: pure, deterministic, ringed spawn, waypoint loop,
 *   lifetime band/overrides, bossId pick/override/fallback
 * - resolvers: explicit opt-in only, lifetime/patrol clamps
 * - BossEncounter open-field mode with fakes: no arena, no tether, patrol
 *   steering, telegraphs unchanged, arena suppression when the flag is on
 * - WorldBossEvent lifecycle with fakes: spawn (one brute, beacon, toast,
 *   boss loot flag), kill completion, timer retreat (no kill path),
 *   portal despawn (roster-owned brute untouched)
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  WORLDBOSS_SALT,
  WORLDBOSS_RING_MIN,
  WORLDBOSS_RING_MAX,
  WORLDBOSS_WAYPOINT_COUNT,
  WORLDBOSS_LIFETIME_MIN,
  WORLDBOSS_LIFETIME_MAX,
  planWorldBoss,
  resolveWorldBossEnabled,
  resolveWorldBossDef,
  resolveWorldBossLifetimeOverride,
  resolveWorldBossPatrolRadius,
  WorldBossEvent,
} from '../src/engine/game/worldBoss';
import {
  BOSS_SALT,
  BOSS_DEFS,
  BossEncounter,
} from '../src/engine/game/bosses';
import { Rng } from '../src/engine/core/Rng';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { LOOT_SALT } from '../src/engine/game/loot';
import { EVENT_SALT } from '../src/engine/game/dynamicEvents';
import { defaultSpec, type GameSpec } from '../src/spec/schema';

describe('WORLDBOSS_SALT', () => {
  it('is distinct from every other system salt', () => {
    const salts = [BOSS_SALT, EVENT_SALT, ENEMY_SALT, NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT, LOOT_SALT];
    for (const s of salts) expect(WORLDBOSS_SALT).not.toBe(s);
    expect(new Set([WORLDBOSS_SALT, ...salts]).size).toBe(salts.length + 1);
  });
});

function worldBossSpec(over: Partial<GameSpec['custom']> = {}): GameSpec {
  const s = defaultSpec(20261012);
  s.custom = { ...(s.custom ?? {}), ...over } as GameSpec['custom'];
  return s;
}

describe('planWorldBoss', () => {
  const spec = () => worldBossSpec({ worldBoss: { enabled: true } });
  it('is deterministic per (mapSeed, spec)', () => {
    expect(planWorldBoss(20261012, spec())).toEqual(planWorldBoss(20261012, spec()));
  });
  it('varies with the seed and rings the spawn 55-95m out', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 20; s++) {
      const p = planWorldBoss(s * 7919, spec());
      const d = Math.hypot(p.x, p.z);
      expect(d).toBeGreaterThanOrEqual(WORLDBOSS_RING_MIN);
      expect(d).toBeLessThanOrEqual(WORLDBOSS_RING_MAX);
      seen.add(`${p.x.toFixed(3)},${p.z.toFixed(3)}`);
    }
    expect(seen.size).toBeGreaterThan(15);
  });
  it('picks a valid boss def deterministically and honors bossId', () => {
    const p = planWorldBoss(7, spec());
    expect(Object.keys(BOSS_DEFS)).toContain(p.bossId);
    const fixed = planWorldBoss(7, worldBossSpec({ worldBoss: { enabled: true, bossId: 'ember-titan' } }));
    expect(fixed.bossId).toBe('ember-titan');
    const unknown = planWorldBoss(7, worldBossSpec({ worldBoss: { enabled: true, bossId: 'nope' } }));
    expect(Object.keys(BOSS_DEFS)).toContain(unknown.bossId);
  });
  it('builds a 5-waypoint loop around the spawn point', () => {
    const p = planWorldBoss(20261012, spec());
    expect(p.waypoints.length).toBe(WORLDBOSS_WAYPOINT_COUNT);
    for (const w of p.waypoints) {
      const d = Math.hypot(w.x - p.x, w.z - p.z);
      expect(d).toBeGreaterThanOrEqual(28 * 0.7 - 1e-6);
      expect(d).toBeLessThanOrEqual(28 * 1.15 + 1e-6);
    }
  });
  it('seeds the lifetime in 240-420s and honors overrides', () => {
    for (let s = 1; s <= 10; s++) {
      const p = planWorldBoss(s * 104729, spec());
      expect(p.lifetimeSeconds).toBeGreaterThanOrEqual(WORLDBOSS_LIFETIME_MIN);
      expect(p.lifetimeSeconds).toBeLessThanOrEqual(WORLDBOSS_LIFETIME_MAX);
    }
    const over = planWorldBoss(7, worldBossSpec({ worldBoss: { enabled: true, lifetimeSeconds: 120 } }));
    expect(over.lifetimeSeconds).toBe(120);
  });
  it('does not depend on the wall clock or engine rng', () => {
    const rng = new Rng(1);
    void rng;
    expect(planWorldBoss(5, spec())).toEqual(planWorldBoss(5, spec()));
  });
});

describe('resolvers', () => {
  it('is opt-in only: absent/false means off, explicit true means on', () => {
    expect(resolveWorldBossEnabled(defaultSpec(7))).toBe(false);
    expect(resolveWorldBossEnabled(worldBossSpec({ worldBoss: { enabled: false } }))).toBe(false);
    expect(resolveWorldBossEnabled(worldBossSpec({ worldBoss: { enabled: true } }))).toBe(true);
  });
  it('resolveWorldBossDef honors a valid id and falls back to the seeded pick', () => {
    const s = worldBossSpec({ worldBoss: { enabled: true, bossId: 'void-herald' } });
    expect(resolveWorldBossDef(s, 7).id).toBe('void-herald');
    const bad = worldBossSpec({ worldBoss: { enabled: true, bossId: 'nope' } });
    expect(resolveWorldBossDef(bad, 7).id).toBe(planWorldBoss(7, bad).bossId);
  });
  it('lifetime override clamps to 30..900, invalid means no override', () => {
    const at = (v: unknown) => resolveWorldBossLifetimeOverride(
      worldBossSpec({ worldBoss: { enabled: true, lifetimeSeconds: v as number } }));
    expect(at(10)).toBe(30);
    expect(at(1000)).toBe(900);
    expect(at(120)).toBe(120);
    expect(at(0)).toBeNull();
    expect(at(-5)).toBeNull();
    expect(at(NaN)).toBeNull();
    expect(at(undefined)).toBeNull();
  });
  it('patrol radius clamps to 8..60, default 28', () => {
    const at = (v: unknown) => resolveWorldBossPatrolRadius(
      worldBossSpec({ worldBoss: { enabled: true, patrolRadius: v as number } }));
    expect(at(undefined)).toBe(28);
    expect(at(5)).toBe(8);
    expect(at(100)).toBe(60);
    expect(at(40)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Fakes (mirroring tests/bosses.test.ts)
// ---------------------------------------------------------------------------

function fakeEnemyAt(x: number, y: number, z: number) {
  const pos = new THREE.Vector3(x, y, z);
  return {
    isBoss: false,
    alive: true,
    health: 100,
    maxHealth: 100,
    spec: { kind: 'brute' },
    position: pos,
    home: new THREE.Vector3(x, y, z),
    renderRoot: null,
    body: {
      position: { set: vi.fn((nx: number, ny: number, nz: number) => { pos.set(nx, ny, nz); }) },
      velocity: { set: vi.fn() },
      angularVelocity: { set: vi.fn() },
    },
    rig: { flash: vi.fn() },
    instancer: { flash: vi.fn() },
    dispose: vi.fn(),
  };
}

function fakeEngine(spec: GameSpec) {
  const added: THREE.Object3D[] = [];
  const removed: THREE.Object3D[] = [];
  const taps: Record<string, Array<(p: unknown) => void>> = {};
  const engine = {
    spec,
    scene: { add: vi.fn((o: THREE.Object3D) => { added.push(o); }), remove: vi.fn((o: THREE.Object3D) => { removed.push(o); }) },
    hud: { showCard: vi.fn() },
    audio: { play: vi.fn() },
    hooks: {
      tap: vi.fn((name: string, fn: (p: unknown) => void) => {
        (taps[name] ??= []).push(fn);
        return () => { taps[name] = taps[name].filter((f) => f !== fn); };
      }),
    },
    _added: added,
    _removed: removed,
    _taps: taps,
    emit(name: string, payload: unknown) {
      for (const fn of taps[name] ?? []) fn(payload);
    },
  };
  return engine;
}

function makeEncounter(spec: GameSpec, enemies: unknown[]) {
  const engine = fakeEngine(spec);
  const bar = { show: vi.fn(), setHealth: vi.fn(), setPhase: vi.fn(), hide: vi.fn() };
  const hits: Array<{ damage: number }> = [];
  const enc = new BossEncounter(engine as unknown as never, {
    manager: { enemies } as never,
    terrain: { heightAt: () => 0 },
    onPlayerHit: (damage: number) => { hits.push({ damage }); },
    bar: bar as never,
  });
  return { enc, engine, bar, hits };
}

describe('BossEncounter open-field mode', () => {
  const def = BOSS_DEFS['ember-titan'];
  const waypoints = [new THREE.Vector3(50, 1, 50), new THREE.Vector3(60, 1, 40)];

  it('spawnOpenField activates without arena visuals or a tether', () => {
    const boss = fakeEnemyAt(5, 0, 5);
    boss.isBoss = true;
    const { enc, engine, bar } = makeEncounter(worldBossSpec(), [boss]);
    enc.spawnOpenField(20261012, def, waypoints);
    expect(enc.isActive).toBe(true);
    expect(enc.isOpenField).toBe(true);
    expect(enc.liveArena).toBeNull();
    expect(engine._added.length).toBe(0); // no arena group, no pylons
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(enc.liveBoss).toBe(boss);
    expect(boss.body.position.set).not.toHaveBeenCalled(); // never teleported
    expect(boss.home.x).toBe(5); // home stays at the spawn point
    expect(boss.maxHealth).toBe(Math.round(100 * def.healthMult));
    expect(bar.show).toHaveBeenCalledWith(def.name);
  });

  it('steers the boss along waypoints while the player is far away', () => {
    const boss = fakeEnemyAt(5, 0, 5);
    boss.isBoss = true;
    const { enc } = makeEncounter(worldBossSpec(), [boss]);
    enc.spawnOpenField(20261012, def, waypoints);
    enc.update(1 / 60, new THREE.Vector3(200, 0, 200)); // player far: patrol steering
    expect(boss.home.x).toBe(50);
    expect(boss.home.z).toBe(50);
    expect(boss.home.y).toBe(1); // grounded via terrain.heightAt + 1
  });

  it('does not steer while the player is in combat range', () => {
    const boss = fakeEnemyAt(5, 0, 5);
    boss.isBoss = true;
    const { enc } = makeEncounter(worldBossSpec(), [boss]);
    enc.spawnOpenField(20261012, def, waypoints);
    enc.update(1 / 60, new THREE.Vector3(8, 0, 5)); // 3m away: combat, not patrol
    expect(boss.home.x).toBe(5);
  });

  it('runs the telegraph cycle unchanged in open-field mode', () => {
    const boss = fakeEnemyAt(5, 0, 5);
    boss.isBoss = true;
    const { enc, hits } = makeEncounter(worldBossSpec(), [boss]);
    enc.spawnOpenField(20261012, def, waypoints);
    const player = new THREE.Vector3(8, 0, 5);
    for (let i = 0; i < 130; i++) enc.update(1 / 60, player); // opening beat
    let guard = 0;
    while (hits.length === 0 && guard++ < 2000) enc.update(1 / 60, player);
    expect(hits.length).toBeGreaterThan(0);
    expect(boss.rig.flash).toHaveBeenCalled();
  });

  it('spawnForMap stands down when the world-boss flag is on', () => {
    const spec = worldBossSpec({
      worldBoss: { enabled: true },
      boss: { enabled: true },
    });
    spec.objective = { type: 'boss', count: 1, timeLimit: 0, description: 'boss' };
    const { enc, engine } = makeEncounter(spec, []);
    enc.spawnForMap(20261012);
    expect(enc.isActive).toBe(false);
    expect(enc.liveArena).toBeNull();
    expect(engine._added.length).toBe(0);
  });

  it('despawnAll resets open-field state and is idempotent', () => {
    const boss = fakeEnemyAt(5, 0, 5);
    boss.isBoss = true;
    const { enc } = makeEncounter(worldBossSpec(), [boss]);
    enc.spawnOpenField(20261012, def, waypoints);
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    enc.despawnAll();
    enc.despawnAll();
    expect(enc.isActive).toBe(false);
    expect(enc.isOpenField).toBe(false);
    expect(enc.liveBoss).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorldBossEvent with fakes
// ---------------------------------------------------------------------------

function makeWorldBoss(spec: GameSpec) {
  const engine = fakeEngine(spec);
  const roster: unknown[] = [];
  const spawned: Array<{ spec: unknown; pos: THREE.Vector3; seed: number }> = [];
  const manager = {
    enemies: roster,
    spawnOne: vi.fn((s: unknown, pos: THREE.Vector3, seed: number) => {
      const e = fakeEnemyAt(pos.x, pos.y, pos.z);
      roster.push(e);
      spawned.push({ spec: s, pos, seed });
      return e;
    }),
  };
  const bar = { show: vi.fn(), setHealth: vi.fn(), setPhase: vi.fn(), hide: vi.fn() };
  const toasts: string[] = [];
  const hits: Array<{ damage: number }> = [];
  const ev = new WorldBossEvent(engine as unknown as never, {
    manager: manager as never,
    terrain: { heightAt: () => 0 },
    onPlayerHit: (damage: number) => { hits.push({ damage }); },
    bar: bar as never,
    toast: (m: string) => { toasts.push(m); },
  });
  return { ev, engine, manager, roster, spawned, bar, toasts, hits };
}

describe('WorldBossEvent lifecycle', () => {
  it('spawns one isBoss brute, a beacon, and a toast on an enabled map', () => {
    const spec = worldBossSpec({ worldBoss: { enabled: true, bossId: 'ember-titan' } });
    const { ev, engine, manager, roster, bar, toasts } = makeWorldBoss(spec);
    ev.spawnForMap(20261012);
    expect(ev.liveStatus).toBe('active');
    expect(manager.spawnOne).toHaveBeenCalledTimes(1);
    expect(roster.length).toBe(1); // exactly one boss, no double-push
    const boss = roster[0] as ReturnType<typeof fakeEnemyAt>;
    expect(boss.isBoss).toBe(true);
    expect(ev.liveBoss).toBe(boss);
    expect(ev.livePlan).toEqual(planWorldBoss(20261012, spec));
    expect(ev.liveBeacon).not.toBeNull();
    expect(engine._added).toContain(ev.liveBeacon!.group);
    expect(toasts.some((t) => t.includes('EMBER TITAN'))).toBe(true);
    expect(ev.liveEncounter.isOpenField).toBe(true);
    // the encounter binds and scales health by the def on its first tick
    ev.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(ev.liveEncounter.liveBoss).toBe(boss);
    expect(boss.maxHealth).toBe(Math.round(100 * BOSS_DEFS['ember-titan'].healthMult)); // fake base is 100; production spawns at WORLDBOSS_BASE_HEALTH (120)
    expect(bar.show).toHaveBeenCalledWith('EMBER TITAN');
    // spawn position matches the plan, grounded
    expect(boss.position.x).toBeCloseTo(ev.livePlan!.x, 9);
    expect(boss.position.z).toBeCloseTo(ev.livePlan!.z, 9);
  });

  it('does nothing on a map without the opt-in flag', () => {
    const { ev, manager, engine } = makeWorldBoss(defaultSpec(7));
    ev.spawnForMap(20261012);
    expect(ev.liveStatus).toBe('inactive');
    expect(manager.spawnOne).not.toHaveBeenCalled();
    expect(engine._added.length).toBe(0);
  });

  it('kill completion retires the beacon and the event, without touching the roster', () => {
    const spec = worldBossSpec({ worldBoss: { enabled: true } });
    const { ev, engine, roster, bar, toasts } = makeWorldBoss(spec);
    ev.spawnForMap(20261012);
    const boss = ev.liveBoss!;
    const beaconGroup = ev.liveBeacon!.group;
    engine.emit('onKill', { enemy: boss });
    expect(ev.liveStatus).toBe('done');
    expect(ev.liveBoss).toBeNull();
    expect(engine._removed).toContain(beaconGroup);
    expect(bar.hide).toHaveBeenCalled();
    expect(toasts.some((t) => t.includes('felled'))).toBe(true);
    expect(roster.length).toBe(1); // kill cleanup stays with the enemy manager
    expect((boss as unknown as ReturnType<typeof fakeEnemyAt>).dispose).not.toHaveBeenCalled();
  });

  it('timer retreat removes the brute with no kill path and no loot side effects', () => {
    const spec = worldBossSpec({ worldBoss: { enabled: true, lifetimeSeconds: 30 } });
    const { ev, roster, bar, toasts } = makeWorldBoss(spec);
    ev.spawnForMap(20261012);
    const boss = ev.liveBoss as unknown as ReturnType<typeof fakeEnemyAt>;
    expect(ev.remainingSeconds).toBe(30);
    // three 10s ticks at a far player position (patrol steering, no combat)
    for (let i = 0; i < 3; i++) ev.update(10, new THREE.Vector3(500, 0, 500));
    expect(ev.liveStatus).toBe('done');
    expect(boss.dispose).toHaveBeenCalledTimes(1);
    expect(roster).not.toContain(boss); // spliced out of the roster
    expect(ev.liveBoss).toBeNull();
    expect(ev.liveBeacon).toBeNull();
    expect(bar.hide).toHaveBeenCalled();
    expect(toasts.some((t) => t.includes('retreats'))).toBe(true);
  });

  it('despawnAll (portal departure) drops refs without disposing the roster brute', () => {
    const spec = worldBossSpec({ worldBoss: { enabled: true } });
    const { ev, engine, roster } = makeWorldBoss(spec);
    ev.spawnForMap(20261012);
    const boss = ev.liveBoss as unknown as ReturnType<typeof fakeEnemyAt>;
    const beaconGroup = ev.liveBeacon!.group;
    ev.despawnAll();
    ev.despawnAll(); // idempotent
    expect(ev.liveStatus).toBe('inactive');
    expect(ev.liveBoss).toBeNull();
    expect(ev.liveBeacon).toBeNull();
    expect(engine._removed).toContain(beaconGroup);
    expect(boss.dispose).not.toHaveBeenCalled(); // EnemyManager sweeps it
    expect(roster).toContain(boss);
  });

  it('update is a no-op before spawn and after completion', () => {
    const spec = worldBossSpec({ worldBoss: { enabled: true } });
    const { ev } = makeWorldBoss(spec);
    expect(() => ev.update(1, new THREE.Vector3(0, 0, 0))).not.toThrow();
    ev.spawnForMap(20261012);
    ev.despawnAll();
    expect(() => ev.update(1, new THREE.Vector3(0, 0, 0))).not.toThrow();
  });

  it('re-spawn after a portal round-trip re-plans identically', () => {
    const spec = worldBossSpec({ worldBoss: { enabled: true } });
    const { ev } = makeWorldBoss(spec);
    ev.spawnForMap(20261012);
    const first = ev.livePlan;
    ev.despawnAll();
    ev.spawnForMap(20261012);
    expect(ev.livePlan).toEqual(first);
    ev.despawnAll();
    ev.spawnForMap(999);
    expect(ev.livePlan).not.toEqual(first);
  });
});
