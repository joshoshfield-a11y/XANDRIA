/**
 * Boss-fights wave unit tests.
 * - salt distinctness (BOSS_SALT vs every other system salt)
 * - planBossArena: pure, deterministic per mapSeed, ringed 70-110m out
 * - spec flag: bossEnabled / resolveBossDef / resolveArenaRadius
 * - BOSS_DEFS table integrity: phases sorted, attack ids resolve, tuning sane
 * - pure scheduler: phaseIndexFor, pickNextAttack determinism, attackHitsPlayer
 * - BossEncounter lifecycle with fakes: spawn/despawn, bind/teleport/
 *   health-scale, windup -> resolve damage, bar events, idempotent despawn
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  BOSS_SALT,
  BOSS_DEFS,
  BOSS_ATTACKS,
  DEFAULT_BOSS_ID,
  planBossArena,
  phaseIndexFor,
  pickNextAttack,
  rollCooldown,
  attackHitsPlayer,
  bossEnabled,
  resolveBossDef,
  resolveArenaRadius,
  BossEncounter,
  type BossDef,
} from '../src/engine/game/bosses';
import { Rng } from '../src/engine/core/Rng';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { LOOT_SALT } from '../src/engine/game/loot';
import { defaultSpec, type GameSpec } from '../src/spec/schema';

describe('BOSS_SALT', () => {
  it('is distinct from every other system salt', () => {
    const salts = [ENEMY_SALT, NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT, LOOT_SALT];
    for (const s of salts) expect(BOSS_SALT).not.toBe(s);
    expect(new Set([BOSS_SALT, ...salts]).size).toBe(salts.length + 1);
  });
});

describe('planBossArena', () => {
  it('is deterministic per mapSeed', () => {
    const a = planBossArena(20261012, 26);
    const b = planBossArena(20261012, 26);
    expect(a).toEqual(b);
  });
  it('varies with the seed and rings 70-110m from the spawn', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 20; s++) {
      const a = planBossArena(s * 7919, 26);
      const d = Math.hypot(a.x, a.z);
      expect(d).toBeGreaterThanOrEqual(70);
      expect(d).toBeLessThanOrEqual(110);
      expect(a.radius).toBe(26);
      seen.add(`${a.x.toFixed(3)},${a.z.toFixed(3)}`);
    }
    expect(seen.size).toBeGreaterThan(15); // no visible tiling
  });
});

function bossSpec(over: Partial<GameSpec['custom']> = {}): GameSpec {
  const s = defaultSpec(20261012);
  s.objective = { type: 'boss', count: 1, timeLimit: 0, description: 'boss' };
  s.custom = { ...(s.custom ?? {}), ...over } as GameSpec['custom'];
  return s;
}

describe('bossEnabled / resolveBossDef / resolveArenaRadius', () => {
  it('defaults on for boss stages, off otherwise', () => {
    expect(bossEnabled(bossSpec())).toBe(true);
    const plain = defaultSpec(7);
    expect(bossEnabled(plain)).toBe(false);
  });
  it('staged boss objectives enable it too', () => {
    const s = defaultSpec(7);
    s.objective = {
      type: 'eliminate', count: 0, timeLimit: 0, description: '',
      stages: [{ type: 'eliminate', count: 3, timeLimit: 0, description: 'a' }, { type: 'boss', count: 1, timeLimit: 0, description: 'b' }],
    };
    expect(bossEnabled(s)).toBe(true);
  });
  it('explicit enabled:false keeps legacy behavior on boss stages', () => {
    expect(bossEnabled(bossSpec({ boss: { enabled: false } }))).toBe(false);
  });
  it('explicit enabled:true forces it on non-boss specs', () => {
    const s = defaultSpec(7);
    s.custom = { boss: { enabled: true } };
    expect(bossEnabled(s)).toBe(true);
  });
  it('resolveBossDef picks bossId, falls back on unknown ids', () => {
    expect(resolveBossDef(bossSpec()).id).toBe(DEFAULT_BOSS_ID);
    expect(resolveBossDef(bossSpec({ boss: { bossId: 'ember-titan' } })).id).toBe('ember-titan');
    expect(resolveBossDef(bossSpec({ boss: { bossId: 'nope' } })).id).toBe(DEFAULT_BOSS_ID);
  });
  it('resolveArenaRadius prefers the author override', () => {
    expect(resolveArenaRadius(bossSpec())).toBe(BOSS_DEFS[DEFAULT_BOSS_ID].arenaRadius);
    expect(resolveArenaRadius(bossSpec({ boss: { arenaRadius: 40 } }))).toBe(40);
  });
});

describe('BOSS_DEFS table integrity', () => {
  const defs = Object.values(BOSS_DEFS);
  it('has at least the default boss', () => {
    expect(defs.length).toBeGreaterThanOrEqual(1);
    expect(BOSS_DEFS[DEFAULT_BOSS_ID]).toBeTruthy();
  });
  it('phases are sorted descending with atHpFrac 1 first', () => {
    for (const d of defs) {
      expect(d.phases.length).toBeGreaterThanOrEqual(2);
      expect(d.phases[0].atHpFrac).toBe(1);
      for (let i = 1; i < d.phases.length; i++) {
        expect(d.phases[i].atHpFrac).toBeLessThan(d.phases[i - 1].atHpFrac);
      }
      expect(d.healthMult).toBeGreaterThan(0);
      expect(d.arenaRadius).toBeGreaterThan(0);
    }
  });
  it('every phase attack id resolves in BOSS_ATTACKS with sane tuning', () => {
    for (const d of defs) {
      for (const p of d.phases) {
        expect(p.attacks.length).toBeGreaterThan(0);
        for (const id of p.attacks) {
          const a = BOSS_ATTACKS[id];
          expect(a, `${d.id} phase ${p.name} -> ${id}`).toBeTruthy();
          expect(a.cooldownMax).toBeGreaterThanOrEqual(a.cooldownMin);
          expect(a.cooldownMin).toBeGreaterThan(0);
          expect(a.windupMs).toBeGreaterThan(0);
          expect(a.damage).toBeGreaterThan(0);
          expect(a.radius).toBeGreaterThan(0);
        }
        expect(p.speedMult).toBeGreaterThan(0);
        expect(p.damageMult).toBeGreaterThan(0);
      }
    }
  });
  it('phase thresholds mirror the EnemyAI 66%/33% transitions', () => {
    for (const d of defs) {
      const th = d.phases.map((p) => p.atHpFrac);
      expect(th).toContain(0.66);
      expect(th).toContain(0.33);
    }
  });
});

describe('phaseIndexFor', () => {
  const def: BossDef = BOSS_DEFS[DEFAULT_BOSS_ID];
  it('maps hp fractions to the deepest matching phase', () => {
    expect(phaseIndexFor(def, 1)).toBe(0);
    expect(phaseIndexFor(def, 0.9)).toBe(0);
    expect(phaseIndexFor(def, 0.66)).toBe(1);
    expect(phaseIndexFor(def, 0.5)).toBe(1);
    expect(phaseIndexFor(def, 0.33)).toBe(2);
    expect(phaseIndexFor(def, 0.01)).toBe(2);
  });
});

describe('pickNextAttack / rollCooldown', () => {
  const def: BossDef = BOSS_DEFS[DEFAULT_BOSS_ID];
  it('is deterministic for the same rng stream', () => {
    const a = new Rng(1234), b = new Rng(1234);
    const seqA = Array.from({ length: 10 }, () => pickNextAttack(a, def, 2).id);
    const seqB = Array.from({ length: 10 }, () => pickNextAttack(b, def, 2).id);
    expect(seqA).toEqual(seqB);
  });
  it('only picks attacks available in the phase', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 30; i++) {
      const atk = pickNextAttack(rng, def, 0);
      expect(def.phases[0].attacks).toContain(atk.id);
    }
  });
  it('cooldowns land inside the tuned band', () => {
    const rng = new Rng(7);
    const atk = BOSS_ATTACKS['warden-slam'];
    for (let i = 0; i < 20; i++) {
      const cd = rollCooldown(rng, atk);
      expect(cd).toBeGreaterThanOrEqual(atk.cooldownMin);
      expect(cd).toBeLessThanOrEqual(atk.cooldownMax);
    }
  });
});

describe('attackHitsPlayer', () => {
  const nova = BOSS_ATTACKS['warden-slam']; // radius 9
  const beam = BOSS_ATTACKS['warden-beam']; // half-width 2.2, range 30
  it('nova: inside radius hits, outside misses', () => {
    expect(attackHitsPlayer(nova, { x: 0, z: 0 }, null, { x: 5, z: 0 })).toBe(true);
    expect(attackHitsPlayer(nova, { x: 0, z: 0 }, null, { x: 9.1, z: 0 })).toBe(false);
  });
  it('beam: on the line hits, off the line misses, behind the boss misses', () => {
    const o = { x: 0, z: 0 }, t = { x: 20, z: 0 };
    expect(attackHitsPlayer(beam, o, t, { x: 10, z: 0 })).toBe(true);
    expect(attackHitsPlayer(beam, o, t, { x: 10, z: 5 })).toBe(false);
    expect(attackHitsPlayer(beam, o, t, { x: -5, z: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BossEncounter with fakes
// ---------------------------------------------------------------------------

function fakeVec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(nx: number, ny: number, nz: number) { x = nx; y = ny; z = nz; this.x = nx; this.y = ny; this.z = nz; return this; },
    clone() { return fakeVec(this.x, this.y, this.z); },
    distanceTo(o: { x: number; y: number; z: number }) {
      return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z);
    },
  };
}

function fakeEnemy() {
  const pos = new THREE.Vector3(5, 0, 5);
  return {
    isBoss: true,
    alive: true,
    health: 100,
    maxHealth: 100,
    spec: { kind: 'brute' },
    position: pos,
    home: new THREE.Vector3(5, 0, 5),
    body: {
      position: { set: vi.fn((x: number, y: number, z: number) => { pos.set(x, y, z); }) },
      velocity: { set: vi.fn() },
      angularVelocity: { set: vi.fn() },
    },
    rig: { flash: vi.fn() },
    instancer: { flash: vi.fn() },
    flashCalls: 0,
  };
}

function fakeEngine(spec: GameSpec) {
  const added: THREE.Object3D[] = [];
  const removed: THREE.Object3D[] = [];
  const taps: Record<string, Array<(p: unknown) => void>> = {};
  return {
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
  };
}

function makeEncounter(spec: GameSpec, enemies: unknown[]) {
  const engine = fakeEngine(spec);
  const bar = { show: vi.fn(), setHealth: vi.fn(), setPhase: vi.fn(), hide: vi.fn(), isVisible: false };
  const hits: Array<{ damage: number }> = [];
  const enc = new BossEncounter(engine as unknown as never, {
    manager: { enemies } as never,
    terrain: { heightAt: () => 0 },
    onPlayerHit: (damage: number) => { hits.push({ damage }); },
    bar: bar as never,
  });
  return { enc, engine, bar, hits };
}

describe('BossEncounter lifecycle', () => {
  let spec: GameSpec;
  beforeEach(() => { spec = bossSpec(); });

  it('spawnForMap places the arena deterministically; disabled flag skips it', () => {
    const { enc, engine } = makeEncounter(spec, []);
    enc.spawnForMap(20261012);
    expect(enc.isActive).toBe(true);
    const a = enc.liveArena!;
    expect(a).toBeTruthy();
    const expected = planBossArena(20261012, BOSS_DEFS[DEFAULT_BOSS_ID].arenaRadius);
    expect(a.x).toBeCloseTo(expected.x, 9);
    expect(a.z).toBeCloseTo(expected.z, 9);
    expect(engine._added.length).toBeGreaterThan(0); // arena visuals

    const off = makeEncounter(bossSpec({ boss: { enabled: false } }), []);
    off.enc.spawnForMap(20261012);
    expect(off.enc.isActive).toBe(false);
    expect(off.enc.liveArena).toBeNull();
  });

  it('binds the first living isBoss enemy, teleports it to the arena, scales health', () => {
    const boss = fakeEnemy();
    const { enc, engine, bar } = makeEncounter(spec, [boss]);
    enc.spawnForMap(20261012);
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(enc.liveBoss).toBe(boss);
    // teleported into the arena
    const a = enc.liveArena!;
    expect(boss.body.position.set).toHaveBeenCalledWith(a.x, expect.any(Number), a.z);
    expect(boss.home.x).toBeCloseTo(a.x, 9);
    // health scaled by the def
    expect(boss.maxHealth).toBe(Math.round(100 * BOSS_DEFS[DEFAULT_BOSS_ID].healthMult));
    expect(boss.health).toBe(boss.maxHealth);
    // bar shown with the boss name
    expect(bar.show).toHaveBeenCalledWith(BOSS_DEFS[DEFAULT_BOSS_ID].name);
    expect(engine.hud.showCard).toHaveBeenCalledWith(
      BOSS_DEFS[DEFAULT_BOSS_ID].name, BOSS_DEFS[DEFAULT_BOSS_ID].intro);
  });

  it('ignores non-boss enemies', () => {
    const mob = fakeEnemy();
    mob.isBoss = false;
    const { enc } = makeEncounter(spec, [mob]);
    enc.spawnForMap(20261012);
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(enc.liveBoss).toBeNull();
  });

  it('runs the telegraph -> resolve cycle and damages the player in the zone', () => {
    const boss = fakeEnemy();
    const { enc, bar, hits } = makeEncounter(spec, [boss]);
    enc.spawnForMap(20261012);
    const a = enc.liveArena!;
    // park the player inside the arena next to the boss (nova radius 9)
    const player = new THREE.Vector3(a.x + 3, 0, a.z);
    // burn through the 2s opening beat
    for (let i = 0; i < 130; i++) enc.update(1 / 60, player);
    // then run until an attack resolves (windup <= 1.5s + margin)
    let guard = 0;
    while (hits.length === 0 && guard++ < 2000) enc.update(1 / 60, player);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].damage).toBeGreaterThan(0);
    // the boss flashed during windups and the bar tracked health
    expect(boss.rig.flash).toHaveBeenCalled();
    expect(bar.setHealth).toHaveBeenCalled();
    expect(bar.setPhase).toHaveBeenCalledWith(
      BOSS_DEFS[DEFAULT_BOSS_ID].phases[0].name); // the bar uppercases for display
  });

  it('does not damage a player standing clear of the zone', () => {
    const boss = fakeEnemy();
    const { enc, hits } = makeEncounter(spec, [boss]);
    enc.spawnForMap(20261012);
    const player = new THREE.Vector3(0, 0, 0); // spawn — 70-110m from the arena
    for (let i = 0; i < 600; i++) enc.update(1 / 60, player);
    expect(hits.length).toBe(0);
  });

  it('onKill unbinds synchronously (bar hides even when the run ends)', () => {
    // Regression: update() only runs while the engine is 'playing' — a boss
    // kill that triggers VICTORY left the bar on screen over the end panel.
    const boss = fakeEnemy();
    const { enc, engine, bar } = makeEncounter(spec, [boss]);
    enc.spawnForMap(20261012);
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(enc.liveBoss).toBe(boss);
    const killTaps = (engine._taps as Record<string, Array<(p: unknown) => void>>).onKill;
    expect(killTaps.length).toBe(1);
    killTaps[0]({ enemy: boss }); // the die() path, no update() tick after
    expect(enc.liveBoss).toBeNull();
    expect(bar.hide).toHaveBeenCalled();
    // a non-boss kill does not unbind
    const mob = fakeEnemy();
    mob.isBoss = false;
    killTaps[0]({ enemy: mob });
  });

  it('boss death hides the bar and unbinds', () => {
    const boss = fakeEnemy();
    const { enc, bar } = makeEncounter(spec, [boss]);
    enc.spawnForMap(20261012);
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(enc.liveBoss).toBe(boss);
    boss.alive = false; // the die() path ran on the manager
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(enc.liveBoss).toBeNull();
    expect(bar.hide).toHaveBeenCalled();
  });

  it('despawnAll is idempotent and removes every payload', () => {
    const boss = fakeEnemy();
    const { enc, engine } = makeEncounter(spec, [boss]);
    enc.spawnForMap(20261012);
    enc.update(1 / 60, new THREE.Vector3(0, 0, 0));
    enc.despawnAll();
    enc.despawnAll(); // must not throw
    expect(enc.isActive).toBe(false);
    expect(enc.liveArena).toBeNull();
    expect(enc.liveBoss).toBeNull();
    expect(engine._removed.length).toBe(engine._added.length);
  });

  it('second spawnForMap re-seeds the arena deterministically', () => {
    const { enc } = makeEncounter(spec, []);
    enc.spawnForMap(111);
    const a1 = { ...enc.liveArena! };
    enc.spawnForMap(222);
    const a2 = { ...enc.liveArena! };
    expect(a1.x).not.toBeCloseTo(a2.x, 3);
    enc.spawnForMap(111);
    expect(enc.liveArena!.x).toBeCloseTo(a1.x, 9);
    expect(enc.liveArena!.z).toBeCloseTo(a1.z, 9);
  });
});
