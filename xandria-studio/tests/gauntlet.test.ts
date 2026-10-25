/**
 * Gauntlet-mode unit tests.
 * - salt distinctness (GAUNTLET_SALT vs every other system salt)
 * - gauntletSeedForDate: pinned formula, throws on malformed dates
 * - generateGauntlet: pure/deterministic, 5 bosses, valid def ids,
 *   no immediate repeats, varies across seeds
 * - gauntletRoundSeed: deterministic, distinct per round
 * - scoreGauntlet: rounds dominate, time bonus, damage penalty, floor at 0
 * - recordGauntletResult: best-per-date wins, all-time best tracking
 * - gauntletBoard: 8 rows newest-first, today flagged, pure recompute
 * - migrateProfile: gauntletResults/gauntletBest defaults + validation
 * - GauntletDirector against a fake engine: round setup, kill advances,
 *   non-boss kills ignored, heal between rounds, 5th kill ends, rebuild
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  GAUNTLET_SALT,
  GAUNTLET_ROUNDS,
  GAUNTLET_HEAL_FRAC,
  GAUNTLET_BOSS_IDS,
  gauntletSupported,
  todayUtcDate,
  utcDateMinus,
  gauntletSeedForDate,
  generateGauntlet,
  gauntletRoundSeed,
  bossShortName,
  gauntletLine,
  scoreGauntlet,
  recordGauntletResult,
  gauntletBoard,
  GauntletDirector,
} from '../src/engine/game/gauntlet';
import { BOSS_SALT, BOSS_DEFS } from '../src/engine/game/bosses';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { LOOT_SALT } from '../src/engine/game/loot';
import {
  defaultProfile,
  migrateProfile,
  type ProfileData,
} from '../src/engine/game/Profile';

describe('GAUNTLET_SALT', () => {
  it('is distinct from every other system salt', () => {
    // DAILY_CHALLENGE_SALT (0xd41e5ca1) lives on the unmerged
    // feature/upgrade-daily-challenges branch — pin against its value here
    // so a future merge can't collide silently.
    const salts = [
      ENEMY_SALT, NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT,
      LOOT_SALT, BOSS_SALT, 0xd41e5ca1,
    ];
    for (const s of salts) expect(GAUNTLET_SALT).not.toBe(s);
    expect(new Set([GAUNTLET_SALT, ...salts]).size).toBe(salts.length + 1);
  });
});

describe('gauntletSeedForDate', () => {
  it('pins the seed as (SALT ^ yyyymmdd) >>> 0', () => {
    expect(gauntletSeedForDate('2026-10-23')).toBe((GAUNTLET_SALT ^ 20261023) >>> 0);
  });
  it('throws on malformed dates', () => {
    expect(() => gauntletSeedForDate('2026-1-1')).toThrow();
    expect(() => gauntletSeedForDate('nope')).toThrow();
  });
});

describe('generateGauntlet', () => {
  it('is deterministic per seed', () => {
    const a = generateGauntlet(123456);
    const b = generateGauntlet(123456);
    expect(a).toEqual(b);
  });
  it('produces GAUNTLET_ROUNDS bosses from the boss defs', () => {
    const g = generateGauntlet(999);
    expect(g.rounds).toBe(GAUNTLET_ROUNDS);
    expect(g.bosses).toHaveLength(GAUNTLET_ROUNDS);
    for (const id of g.bosses) expect(BOSS_DEFS[id]).toBeTruthy();
  });
  it('never repeats the same boss back-to-back', () => {
    for (let s = 1; s <= 200; s++) {
      const g = generateGauntlet(s * 7919);
      for (let i = 1; i < g.bosses.length; i++) {
        expect(g.bosses[i]).not.toBe(g.bosses[i - 1]);
      }
    }
  });
  it('varies across seeds', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 20; s++) seen.add(generateGauntlet(s).bosses.join(','));
    expect(seen.size).toBeGreaterThan(3);
  });
  it('draws from the canonical boss id order', () => {
    expect(GAUNTLET_BOSS_IDS).toEqual(Object.keys(BOSS_DEFS));
  });
});

describe('gauntletRoundSeed', () => {
  it('is deterministic and distinct per round', () => {
    const s0 = gauntletRoundSeed(424242, 0);
    expect(gauntletRoundSeed(424242, 0)).toBe(s0);
    const rounds = new Set<number>();
    for (let i = 0; i < GAUNTLET_ROUNDS; i++) rounds.add(gauntletRoundSeed(424242, i));
    expect(rounds.size).toBe(GAUNTLET_ROUNDS);
  });
});

describe('bossShortName / gauntletLine', () => {
  it('shortens THE-prefixed names', () => {
    expect(bossShortName('the-warden')).toBe('WARDEN');
    expect(bossShortName('ember-titan')).toBe('EMBER TITAN');
  });
  it('joins the order with arrows', () => {
    const g = generateGauntlet(7);
    expect(gauntletLine(g)).toBe(g.bosses.map(bossShortName).join(' → '));
  });
});

describe('gauntletSupported', () => {
  it('is true for combat blueprints, false otherwise', () => {
    expect(gauntletSupported('third-person-action')).toBe(true);
    expect(gauntletSupported('fps-arena')).toBe(true);
    expect(gauntletSupported('top-down-shooter')).toBe(true);
    expect(gauntletSupported('platformer')).toBe(false);
    expect(gauntletSupported('racing')).toBe(false);
  });
});

describe('scoreGauntlet', () => {
  it('is zero with zero rounds', () => {
    expect(scoreGauntlet({ roundsCleared: 0, timeSeconds: 10, damageTaken: 0 })).toBe(0);
  });
  it('rounds dominate: 5 fast clean rounds = 5000 + 1200 time bonus', () => {
    expect(scoreGauntlet({ roundsCleared: 5, timeSeconds: 0, damageTaken: 0 }))
      .toBe(5 * 1000 + 5 * 120 * 2);
  });
  it('rewards speed and punishes damage', () => {
    const fast = scoreGauntlet({ roundsCleared: 3, timeSeconds: 60, damageTaken: 0 });
    const slow = scoreGauntlet({ roundsCleared: 3, timeSeconds: 300, damageTaken: 0 });
    expect(fast).toBeGreaterThan(slow);
    const clean = scoreGauntlet({ roundsCleared: 3, timeSeconds: 100, damageTaken: 0 });
    const hurt = scoreGauntlet({ roundsCleared: 3, timeSeconds: 100, damageTaken: 200 });
    expect(clean - hurt).toBe(200);
  });
  it('floors at zero: damage can never drive the score negative', () => {
    expect(scoreGauntlet({ roundsCleared: 1, timeSeconds: 9999, damageTaken: 99999 })).toBe(0);
  });
  it('with equal damage, more rounds always outscore fewer', () => {
    const three = scoreGauntlet({ roundsCleared: 3, timeSeconds: 0, damageTaken: 500 });
    const four = scoreGauntlet({ roundsCleared: 4, timeSeconds: 4 * 120, damageTaken: 500 });
    expect(four).toBeGreaterThan(three);
    // even a perfect 3-round run can't catch the slowest 4-round run
    const threePerfect = scoreGauntlet({ roundsCleared: 3, timeSeconds: 0, damageTaken: 0 });
    const fourSlowest = scoreGauntlet({ roundsCleared: 4, timeSeconds: 9999, damageTaken: 0 });
    expect(fourSlowest).toBeGreaterThan(threePerfect);
  });
});

function gauntletResult(over: Record<string, number | boolean | string> = {}) {
  return {
    roundsCleared: 5, kills: 5, timeSeconds: 100, damageTaken: 50,
    won: true, genre: 'fps-arena', seed: 123, ...over,
  };
}

describe('recordGauntletResult', () => {
  it('stores the first attempt and returns true', () => {
    const p = defaultProfile();
    expect(recordGauntletResult(p, '2026-10-23', gauntletResult())).toBe(true);
    expect(p.gauntletResults['2026-10-23'].roundsCleared).toBe(5);
    expect(p.gauntletResults['2026-10-23'].won).toBe(true);
    expect(p.gauntletBest).toBe(p.gauntletResults['2026-10-23'].score);
  });
  it('best score per date wins: lower never overwrites', () => {
    const p = defaultProfile();
    recordGauntletResult(p, '2026-10-23', gauntletResult({ timeSeconds: 60, damageTaken: 0 }));
    const best = p.gauntletResults['2026-10-23'].score;
    expect(recordGauntletResult(p, '2026-10-23', gauntletResult({ timeSeconds: 500, damageTaken: 900 }))).toBe(false);
    expect(p.gauntletResults['2026-10-23'].score).toBe(best);
  });
  it('a higher score overwrites and lifts the all-time best', () => {
    const p = defaultProfile();
    recordGauntletResult(p, '2026-10-23', gauntletResult({ timeSeconds: 500, damageTaken: 900 }));
    const low = p.gauntletResults['2026-10-23'].score;
    expect(recordGauntletResult(p, '2026-10-23', gauntletResult({ timeSeconds: 60, damageTaken: 0 }))).toBe(true);
    expect(p.gauntletResults['2026-10-23'].score).toBeGreaterThan(low);
    expect(p.gauntletBest).toBe(p.gauntletResults['2026-10-23'].score);
  });
  it('tracks dates independently', () => {
    const p = defaultProfile();
    recordGauntletResult(p, '2026-10-23', gauntletResult());
    expect(recordGauntletResult(p, '2026-10-24', gauntletResult())).toBe(true);
    expect(Object.keys(p.gauntletResults)).toHaveLength(2);
  });
});

describe('gauntletBoard', () => {
  it('returns 8 rows, newest first, today flagged', () => {
    const rows = gauntletBoard(defaultProfile(), '2026-10-23');
    expect(rows).toHaveLength(8);
    expect(rows[0].today).toBe(true);
    expect(rows[0].date).toBe('2026-10-23');
    expect(rows[7].date).toBe('2026-10-16');
    expect(rows[7].today).toBe(false);
  });
  it('recomputes each date\'s tuple purely and maps stored results', () => {
    const p = defaultProfile();
    recordGauntletResult(p, '2026-10-23', gauntletResult({ roundsCleared: 5 }));
    const rows = gauntletBoard(p, '2026-10-23');
    const expected = generateGauntlet(gauntletSeedForDate('2026-10-23'));
    expect(rows[0].bossesText).toBe(gauntletLine(expected));
    expect(rows[0].result?.roundsCleared).toBe(5);
    expect(rows[0].result?.won).toBe(true);
    expect(rows[1].result).toBeNull();
    expect(rows[1].bossesText.length).toBeGreaterThan(0);
  });
});

describe('migrateProfile (gauntlet fields)', () => {
  it('defaults empty when absent', () => {
    const p = migrateProfile({});
    expect(p.gauntletResults).toEqual({});
    expect(p.gauntletBest).toBe(0);
  });
  it('keeps valid entries, drops malformed ones, never throws', () => {
    const p = migrateProfile({
      gauntletResults: {
        '2026-10-23': { score: 8500, roundsCleared: 5, kills: 5, timeSeconds: 200, damageTaken: 100, won: true, genre: 'fps-arena', seed: 42 },
        'bad-date': { score: 1 },
        '2026-10-24': 'garbage',
        '2026-10-25': { score: -5, roundsCleared: 2.7 },
      },
      gauntletBest: 8500,
    });
    expect(Object.keys(p.gauntletResults)).toEqual(['2026-10-23', '2026-10-25']);
    expect(p.gauntletResults['2026-10-25'].score).toBe(0);
    expect(p.gauntletResults['2026-10-25'].roundsCleared).toBe(2);
    expect(p.gauntletBest).toBe(8500);
  });
});

// ---------------------------------------------------------------------------
// GauntletDirector with a fake engine
// ---------------------------------------------------------------------------

function makeFakeEngine() {
  const taps = new Map<string, Array<(p: unknown) => void>>();
  const toasts: string[] = [];
  const avatar = {
    health: 100,
    maxHealth: 100,
    heal: vi.fn(function (this: { health: number; maxHealth: number }, amount: number) {
      (this as { health: number }).health = Math.min(this.maxHealth, this.health + amount);
    }),
    ctrl: { position: new THREE.Vector3(0, 0, 0) },
  };
  const spawned: Array<{ spec: unknown; pos: THREE.Vector3; seed: number }> = [];
  const bosses: Array<{ isBoss: boolean; alive: boolean }> = [];
  const encounter = {
    spawnForMap: vi.fn(),
    liveArena: { x: 80, z: 0, radius: 26 },
  };
  const engine = {
    spec: { custom: {} as Record<string, unknown> },
    hooks: {
      tap: vi.fn((name: string, fn: (p: unknown) => void) => {
        const list = taps.get(name) ?? [];
        list.push(fn);
        taps.set(name, list);
        return () => {
          taps.set(name, (taps.get(name) ?? []).filter((f) => f !== fn));
        };
      }),
    },
    hud: { toast: vi.fn((t: string) => { toasts.push(t); }) },
    portalsPlayerAvatar: avatar,
    bossWiring: {
      encounter,
      manager: {
        spawnOne: vi.fn((spec: unknown, pos: THREE.Vector3, seed: number) => {
          spawned.push({ spec, pos, seed });
          const b = { isBoss: false, alive: true };
          bosses.push(b);
          return b;
        }),
      },
    },
    emitKill: (enemy: unknown) => {
      for (const fn of taps.get('onKill') ?? []) fn({ enemy });
    },
  };
  return { engine, avatar, spawned, bosses, encounter, toasts, taps };
}

describe('GauntletDirector', () => {
  it('sets up round 1 on start: boss flag, arena re-seed, one brute spawned', () => {
    const f = makeFakeEngine();
    const g = generateGauntlet(424242);
    const d = new GauntletDirector(f.engine as never, g);
    d.start();
    expect(f.engine.spec.custom.boss).toEqual({ enabled: true, bossId: g.bosses[0] });
    expect(f.encounter.spawnForMap).toHaveBeenCalledWith(gauntletRoundSeed(g.seed, 0));
    expect(f.spawned).toHaveLength(1);
    expect((f.spawned[0].spec as { kind: string }).kind).toBe('brute');
    expect(f.bosses[0].isBoss).toBe(true);
    expect(d.roundIndex).toBe(0);
  });

  it('a real boss kill advances the round and heals the player', () => {
    const f = makeFakeEngine();
    const g = generateGauntlet(424242);
    const d = new GauntletDirector(f.engine as never, g);
    d.start();
    const boss1 = f.bosses[0];
    f.avatar.health = 40;
    f.engine.emitKill(boss1);
    expect(d.roundsCleared).toBe(1);
    expect(d.kills).toBe(1);
    // healed GAUNTLET_HEAL_FRAC of max between rounds
    expect(f.avatar.heal).toHaveBeenCalledWith(100 * GAUNTLET_HEAL_FRAC);
    expect(f.avatar.health).toBe(40 + 100 * GAUNTLET_HEAL_FRAC);
    // next round set up: new flag, new arena seed, new brute
    expect(f.engine.spec.custom.boss).toEqual({ enabled: true, bossId: g.bosses[1] });
    expect(f.encounter.spawnForMap).toHaveBeenCalledWith(gauntletRoundSeed(g.seed, 1));
    expect(f.spawned).toHaveLength(2);
    expect(f.toasts[0]).toContain('ROUND 2');
  });

  it('ignores kills that are not the current boss', () => {
    const f = makeFakeEngine();
    const d = new GauntletDirector(f.engine as never, generateGauntlet(11));
    d.start();
    f.engine.emitKill({ isBoss: false, alive: false });
    expect(d.roundsCleared).toBe(0);
    expect(f.spawned).toHaveLength(1);
  });

  it('the 5th kill ends the run: no 6th round, director disarmed', () => {
    const f = makeFakeEngine();
    const g = generateGauntlet(31337);
    const d = new GauntletDirector(f.engine as never, g);
    d.start();
    for (let i = 0; i < GAUNTLET_ROUNDS; i++) {
      f.engine.emitKill(f.bosses[i]);
    }
    expect(d.roundsCleared).toBe(GAUNTLET_ROUNDS);
    expect(f.spawned).toHaveLength(GAUNTLET_ROUNDS);
    expect(d.active).toBe(false);
    // further kills are ignored after completion
    f.engine.emitKill({ isBoss: true, alive: false });
    expect(d.roundsCleared).toBe(GAUNTLET_ROUNDS);
  });

  it('onRunRebuilt re-drives the current round (in-place restart)', () => {
    const f = makeFakeEngine();
    const g = generateGauntlet(777);
    const d = new GauntletDirector(f.engine as never, g);
    d.start();
    f.engine.emitKill(f.bosses[0]);
    f.engine.emitKill(f.bosses[1]);
    expect(d.roundsCleared).toBe(2);
    d.onRunRebuilt();
    // round 3 (index 2) set up again: same flag, same round seed
    expect(f.engine.spec.custom.boss).toEqual({ enabled: true, bossId: g.bosses[2] });
    expect(f.encounter.spawnForMap).toHaveBeenLastCalledWith(gauntletRoundSeed(g.seed, 2));
    expect(d.roundsCleared).toBe(2);
  });

  it('start() is idempotent', () => {
    const f = makeFakeEngine();
    const d = new GauntletDirector(f.engine as never, generateGauntlet(5));
    d.start();
    d.start();
    expect(f.spawned).toHaveLength(1);
  });
});

describe('date helpers', () => {
  it('todayUtcDate formats UTC and utcDateMinus walks back', () => {
    expect(todayUtcDate(new Date(Date.UTC(2026, 9, 23, 12)))).toBe('2026-10-23');
    expect(utcDateMinus('2026-10-23', 7)).toBe('2026-10-16');
    expect(utcDateMinus('2026-01-01', 1)).toBe('2025-12-31');
  });
});
