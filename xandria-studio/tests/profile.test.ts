/**
 * Profile — cross-run progression: save/load, migration, economy,
 * modifier math, daily-seed determinism.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _setProfileStorage,
  applyLoadout,
  dailySeed,
  defaultProfile,
  loadProfile,
  meritForRun,
  migrateProfile,
  purchaseModifier,
  recordRun,
  saveProfile,
  setLoadout,
  todayLocalDate,
  MODIFIERS,
  PROFILE_KEY,
  type ProfileData,
} from '../src/engine/game/Profile';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    _map: m,
  };
}

function fakeSpec() {
  return {
    player: { health: 100, speed: 6 },
    rules: { lives: 3 },
    custom: {} as Record<string, unknown>,
  } as any;
}

beforeEach(() => {
  _setProfileStorage(memStore());
});

describe('save/load round-trip', () => {
  it('persists a full profile through JSON', () => {
    const p = defaultProfile();
    p.merit = 42;
    p.owned = ['vitality'];
    p.loadout = ['vitality'];
    p.runsPlayed = { 'fps-arena': 3 };
    p.dailyBest = { '2026-10-04': 1234 };
    saveProfile(p);
    const q = loadProfile();
    expect(q.merit).toBe(42);
    expect(q.owned).toEqual(['vitality']);
    expect(q.loadout).toEqual(['vitality']);
    expect(q.runsPlayed['fps-arena']).toBe(3);
    expect(q.dailyBest['2026-10-04']).toBe(1234);
  });

  it('missing data yields a fresh default profile', () => {
    expect(loadProfile()).toEqual(defaultProfile());
  });

  it('corrupt JSON yields a fresh default profile (never throws)', () => {
    const s = memStore();
    _setProfileStorage(s);
    s._map.set(PROFILE_KEY, '{not json');
    expect(loadProfile()).toEqual(defaultProfile());
  });

  it('works when storage is entirely unavailable', () => {
    _setProfileStorage(null);
    const p = defaultProfile();
    p.merit = 7;
    expect(() => saveProfile(p)).not.toThrow();
    // falls back to in-memory: still round-trips within the session
    expect(loadProfile().merit).toBe(7);
  });
});

describe('migration', () => {
  it('fills defaults for a sparse old record', () => {
    const p = migrateProfile({ merit: 5 });
    expect(p.merit).toBe(5);
    expect(p.owned).toEqual([]);
    expect(p.totalKills).toBe(0);
  });

  it('drops unknown modifier ids and loadout entries that are not owned', () => {
    const p = migrateProfile({
      owned: ['vitality', 'hax'],
      loadout: ['vitality', 'power'],
    });
    expect(p.owned).toEqual(['vitality']);
    expect(p.loadout).toEqual(['vitality']);
  });

  it('clamps negative / non-finite numbers', () => {
    const p = migrateProfile({ merit: -10, totalKills: NaN, bestScore: { a: 'x' } });
    expect(p.merit).toBe(0);
    expect(p.totalKills).toBe(0);
    expect(p.bestScore).toEqual({});
  });

  it('rejects non-object payloads', () => {
    expect(migrateProfile(null)).toEqual(defaultProfile());
    expect(migrateProfile([1, 2])).toEqual(defaultProfile());
    expect(migrateProfile('x')).toEqual(defaultProfile());
  });
});

describe('merit economy', () => {
  it('wins pay 10 + level, losses pay 2 + level', () => {
    expect(meritForRun(true, 3)).toBe(13);
    expect(meritForRun(false, 3)).toBe(5);
    expect(meritForRun(true, 0)).toBe(10);
  });

  it('purchase deducts merit, blocks duplicates and the unaffordable', () => {
    const p = defaultProfile();
    p.merit = 30;
    expect(purchaseModifier(p, 'vitality')).toBe(true); // cost 20
    expect(p.merit).toBe(10);
    expect(p.owned).toEqual(['vitality']);
    expect(purchaseModifier(p, 'vitality')).toBe(false); // duplicate
    expect(purchaseModifier(p, 'power')).toBe(false); // cost 25 > 10
    expect(purchaseModifier(p, 'nope')).toBe(false); // unknown
    expect(p.merit).toBe(10);
  });

  it('setLoadout keeps only owned ids in canonical order', () => {
    const p = defaultProfile();
    p.owned = ['swift', 'vitality'];
    setLoadout(p, ['swift', 'vitality', 'power', 'bogus']);
    // canonical MODIFIERS order: vitality, power, swift, secondwind
    expect(p.loadout).toEqual(['vitality', 'swift']);
  });
});

describe('recordRun aggregation', () => {
  it('aggregates stats, merit and per-genre bests', () => {
    const p = defaultProfile();
    recordRun(p, { genre: 'fps-arena', won: true, score: 1000, level: 4, kills: 30, timeSeconds: 120 });
    recordRun(p, { genre: 'fps-arena', won: false, score: 800, level: 2, kills: 10, timeSeconds: 60 });
    expect(p.runsPlayed['fps-arena']).toBe(2);
    expect(p.runsWon['fps-arena']).toBe(1);
    expect(p.bestScore['fps-arena']).toBe(1000);
    expect(p.bestLevel['fps-arena']).toBe(4);
    expect(p.totalKills).toBe(40);
    expect(p.totalPlaytime).toBe(180);
    expect(p.merit).toBe((10 + 4) + (2 + 2));
  });

  it('tracks the daily best per date', () => {
    const p = defaultProfile();
    recordRun(p, { genre: 'racing', won: true, score: 500, level: 1, kills: 0, timeSeconds: 90, daily: '2026-10-04' });
    recordRun(p, { genre: 'racing', won: true, score: 300, level: 1, kills: 0, timeSeconds: 95, daily: '2026-10-04' });
    expect(p.dailyBest['2026-10-04']).toBe(500);
  });
});

describe('applyLoadout math', () => {
  function equippedProfile(ids: string[]): ProfileData {
    const p = defaultProfile();
    p.owned = [...ids];
    p.loadout = [...ids];
    return p;
  }

  it('applies each modifier from base values', () => {
    const spec = fakeSpec();
    applyLoadout(spec, equippedProfile(['vitality', 'swift', 'secondwind', 'power']));
    expect(spec.player.health).toBe(125);
    expect(spec.player.speed).toBeCloseTo(6 * 1.08, 9);
    expect(spec.rules.lives).toBe(4);
    expect(spec.custom.profileDamageMult).toBe(1.1);
  });

  it('is idempotent across repeated applies (restarts never compound)', () => {
    const spec = fakeSpec();
    const p = equippedProfile(['vitality', 'swift', 'secondwind', 'power']);
    applyLoadout(spec, p);
    applyLoadout(spec, p);
    applyLoadout(spec, p);
    expect(spec.player.health).toBe(125);
    expect(spec.player.speed).toBeCloseTo(6 * 1.08, 9);
    expect(spec.rules.lives).toBe(4);
    expect(spec.custom.profileDamageMult).toBe(1.1);
  });

  it('clears effects when the loadout is emptied', () => {
    const spec = fakeSpec();
    const p = equippedProfile(['vitality', 'power']);
    applyLoadout(spec, p);
    expect(spec.player.health).toBe(125);
    setLoadout(p, []);
    applyLoadout(spec, p);
    expect(spec.player.health).toBe(100);
    expect(spec.custom.profileDamageMult).toBeUndefined();
  });

  it('ignores loadout ids that are not owned', () => {
    const spec = fakeSpec();
    const p = defaultProfile();
    p.loadout = ['power']; // not owned
    applyLoadout(spec, p);
    expect(spec.custom.profileDamageMult).toBeUndefined();
  });

  it('no-ops on an empty profile', () => {
    const spec = fakeSpec();
    applyLoadout(spec, defaultProfile());
    expect(spec.player.health).toBe(100);
    expect(spec.player.speed).toBe(6);
    expect(spec.rules.lives).toBe(3);
  });
});

describe('daily seed', () => {
  it('same date -> same seed (deterministic)', () => {
    expect(dailySeed('2026-10-04')).toBe(dailySeed('2026-10-04'));
  });

  it('different dates -> different seeds', () => {
    const seeds = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const ds = `2026-10-${String(d).padStart(2, '0')}`;
      seeds.add(String(dailySeed(ds)));
    }
    // 28 distinct dates must not collide (would need a 1-in-2^32 coincidence)
    expect(seeds.size).toBe(28);
  });

  it('yields a uint32 usable as an RNG seed', () => {
    const s = dailySeed('2026-10-04');
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });

  it('todayLocalDate formats the local calendar date', () => {
    // month is 0-indexed in the Date constructor; Oct 4 2026 15:30 local
    expect(todayLocalDate(new Date(2026, 9, 4, 15, 30))).toBe('2026-10-04');
    expect(todayLocalDate(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05');
  });

  it('every modifier has a unique id, name, desc and positive cost', () => {
    const ids = new Set(MODIFIERS.map((m) => m.id));
    expect(ids.size).toBe(MODIFIERS.length);
    for (const m of MODIFIERS) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.desc.length).toBeGreaterThan(0);
      expect(m.cost).toBeGreaterThan(0);
    }
  });
});
