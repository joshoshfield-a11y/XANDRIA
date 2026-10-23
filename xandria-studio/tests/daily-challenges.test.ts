/**
 * Daily challenges — pure-logic unit tests.
 *
 * Covers: UTC date handling, the pinned seed formula (DAILY_CHALLENGE_SALT ^
 * yyyymmdd), tuple determinism (same date -> deep-equal challenge on every
 * machine), loadout/goal validity, first-attempt-wins persistence, profile
 * migration of dailyResults, the goal tracker against a fake engine, and
 * the challenge board rows.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DAILY_CHALLENGE_SALT,
  CHALLENGE_BOARD_DAYS,
  todayUtcDate,
  utcDateMinus,
  challengeSeed,
  generateDailyChallenge,
  goalLabel,
  loadoutLabel,
  challengeProfile,
  recordDailyResult,
  challengeBoard,
  ChallengeGoalTracker,
  type DailyChallenge,
} from '../src/engine/game/dailyChallenges';
import {
  MODIFIER_IDS,
  defaultProfile,
  migrateProfile,
  type ProfileData,
} from '../src/engine/game/Profile';

/** Minimal fake hook bus — the tracker only ever calls hooks.tap. */
function fakeHooks() {
  const taps = new Map<string, Set<Function>>();
  return {
    tap(name: string, fn: Function) {
      let s = taps.get(name);
      if (!s) taps.set(name, (s = new Set()));
      s.add(fn);
      return () => { s!.delete(fn); };
    },
    fire(name: string, payload: any) {
      for (const fn of [...(taps.get(name) ?? [])]) fn(payload);
    },
    count(name: string) { return taps.get(name)?.size ?? 0; },
  };
}

function fakeEngine(challenge: DailyChallenge, hooks: ReturnType<typeof fakeHooks>) {
  const win = vi.fn();
  return {
    win,
    hooks,
    state: 'playing' as string,
    score: 0,
    elapsed: 0,
    __win: win,
  };
}

describe('UTC date handling', () => {
  it('todayUtcDate uses UTC components, not local time', () => {
    // 23:59 UTC Oct 21 — still Oct 21 in UTC even where local time is Oct 22
    expect(todayUtcDate(new Date(Date.UTC(2026, 9, 21, 23, 59)))).toBe('2026-10-21');
    expect(todayUtcDate(new Date(Date.UTC(2026, 9, 22, 1, 0)))).toBe('2026-10-22');
    expect(todayUtcDate(new Date(Date.UTC(2026, 0, 5, 0, 5)))).toBe('2026-01-05');
  });

  it('utcDateMinus does calendar arithmetic across month boundaries', () => {
    expect(utcDateMinus('2026-10-22', 1)).toBe('2026-10-21');
    expect(utcDateMinus('2026-10-01', 1)).toBe('2026-09-30');
    expect(utcDateMinus('2026-01-01', 1)).toBe('2025-12-31');
    expect(utcDateMinus('2026-10-22', 0)).toBe('2026-10-22');
  });
});

describe('pinned seed formula', () => {
  it('challengeSeed = (SALT ^ yyyymmdd) >>> 0, deterministic', () => {
    expect(challengeSeed('2026-10-21')).toBe((DAILY_CHALLENGE_SALT ^ 20261021) >>> 0);
    expect(challengeSeed('2026-10-21')).toBe(challengeSeed('2026-10-21'));
    expect(challengeSeed('2026-10-22')).not.toBe(challengeSeed('2026-10-21'));
  });

  it('rejects malformed dates loudly', () => {
    expect(() => challengeSeed('tomorrow')).toThrow();
    expect(() => challengeSeed('2026-1-5')).toThrow();
    expect(() => challengeSeed('')).toThrow();
  });
});

describe('generateDailyChallenge', () => {
  it('is deterministic: same date -> deep-equal tuple (every player, every machine)', () => {
    const a = generateDailyChallenge('2026-10-21');
    const b = generateDailyChallenge('2026-10-21');
    expect(a).toEqual(b);
    expect(a.date).toBe('2026-10-21');
    expect(a.seed).toBe(challengeSeed('2026-10-21'));
  });

  it('differs across dates (seed pinned per day)', () => {
    const seeds = new Set<string>();
    for (let d = 1; d <= 30; d++) {
      const ds = `2026-10-${String(d).padStart(2, '0')}`;
      seeds.add(String(generateDailyChallenge(ds).seed));
    }
    expect(seeds.size).toBe(30);
  });

  it('produces a valid fixed loadout: 2 distinct known modifier ids', () => {
    for (const ds of ['2026-10-21', '2026-10-22', '2027-01-01', '2025-12-31']) {
      const ch = generateDailyChallenge(ds);
      expect(ch.loadout).toHaveLength(2);
      expect(new Set(ch.loadout).size).toBe(2);
      for (const id of ch.loadout) expect(MODIFIER_IDS).toContain(id);
    }
  });

  it('produces a valid goal with a sane target band', () => {
    for (let d = 1; d <= 30; d++) {
      const ds = `2026-11-${String(d).padStart(2, '0')}`;
      const { goal } = generateDailyChallenge(ds);
      expect(['kills', 'score', 'survive']).toContain(goal.kind);
      if (goal.kind === 'kills') expect(goal.target).toBeGreaterThanOrEqual(25);
      if (goal.kind === 'kills') expect(goal.target).toBeLessThanOrEqual(60);
      if (goal.kind === 'score') {
        expect(goal.target).toBeGreaterThanOrEqual(750);
        expect(goal.target).toBeLessThanOrEqual(2500);
      }
      if (goal.kind === 'survive') {
        expect(goal.target).toBeGreaterThanOrEqual(120);
        expect(goal.target).toBeLessThanOrEqual(300);
      }
      expect(goalLabel(goal).length).toBeGreaterThan(0);
    }
  });

  it('loadoutLabel names the modifiers', () => {
    const ch = generateDailyChallenge('2026-10-21');
    const label = loadoutLabel(ch.loadout);
    expect(label).not.toBe('no modifiers');
    expect(label).toContain('+');
    expect(loadoutLabel([])).toBe('no modifiers');
  });
});

describe('challenge profile + first-attempt-wins persistence', () => {
  it('challengeProfile carries the fixed loadout as owned+equipped', () => {
    const ch = generateDailyChallenge('2026-10-21');
    const p = challengeProfile(ch);
    expect(p.owned).toEqual(ch.loadout);
    expect(p.loadout).toEqual(ch.loadout);
    expect(p.merit).toBe(0);
  });

  function sampleResult(ch: DailyChallenge, score: number) {
    return {
      score, kills: 12, timeSeconds: 95.5, damageTaken: 34,
      won: true, goal: ch.goal, genre: 'fps-arena', seed: ch.seed,
    };
  }

  it('recordDailyResult stores the first attempt and keeps it (first wins)', () => {
    const p = defaultProfile();
    const ch = generateDailyChallenge('2026-10-21');
    expect(recordDailyResult(p, '2026-10-21', sampleResult(ch, 500))).toBe(true);
    expect(p.dailyResults['2026-10-21'].score).toBe(500);
    // a later completion for the same date is dropped
    expect(recordDailyResult(p, '2026-10-21', sampleResult(ch, 9999))).toBe(false);
    expect(p.dailyResults['2026-10-21'].score).toBe(500);
    // a different date is independent
    expect(recordDailyResult(p, '2026-10-22', sampleResult(ch, 100))).toBe(true);
    expect(p.dailyResults['2026-10-22'].score).toBe(100);
  });

  it('recordDailyResult clamps/floors values', () => {
    const p = defaultProfile();
    const ch = generateDailyChallenge('2026-10-21');
    recordDailyResult(p, '2026-10-21', {
      score: -5, kills: 3.9, timeSeconds: -1, damageTaken: 7.7,
      won: false, goal: ch.goal, genre: 'racing', seed: ch.seed,
    });
    const r = p.dailyResults['2026-10-21'];
    expect(r.score).toBe(0);
    expect(r.kills).toBe(3);
    expect(r.timeSeconds).toBe(0);
    expect(r.damageTaken).toBe(7);
    expect(r.won).toBe(false);
  });

  it('migrateProfile keeps valid dailyResults and drops malformed ones', () => {
    const raw = {
      dailyResults: {
        '2026-10-21': {
          score: 500, kills: 12, timeSeconds: 95, damageTaken: 34,
          won: true, goalKind: 'kills', goalTarget: 40, genre: 'fps-arena', seed: 123,
        },
        'not-a-date': { score: 1 },
        '2026-10-22': 'garbage',
      },
    };
    const p = migrateProfile(raw);
    expect(Object.keys(p.dailyResults)).toEqual(['2026-10-21']);
    expect(p.dailyResults['2026-10-21'].score).toBe(500);
    // missing entirely -> empty record, never undefined
    expect(migrateProfile({}).dailyResults).toEqual({});
  });
});

describe('ChallengeGoalTracker', () => {
  function findGoalDate(kind: string): string {
    for (let d = 1; d <= 400; d++) {
      const ds = `2026-${String(1 + (d % 12)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`;
      if (generateDailyChallenge(ds).goal.kind === kind) return ds;
    }
    throw new Error(`no ${kind} goal found in scan window`);
  }

  it('wins the run when the kills goal is reached', () => {
    const ds = findGoalDate('kills');
    const ch = generateDailyChallenge(ds);
    const hooks = fakeHooks();
    const e = fakeEngine(ch, hooks);
    const t = new ChallengeGoalTracker(e as any, ch);
    expect(t.armed).toBe(false);
    t.arm();
    t.arm(); // idempotent
    expect(t.armed).toBe(true);
    expect(hooks.count('onKill')).toBe(1);
    for (let i = 0; i < ch.goal.target - 1; i++) hooks.fire('onKill', {});
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).not.toHaveBeenCalled();
    hooks.fire('onKill', {});
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).toHaveBeenCalledTimes(1);
    const [stats, text] = e.__win.mock.calls[0];
    expect(stats.kills).toBe(ch.goal.target);
    expect(String(text)).toContain('DAILY CHALLENGE COMPLETE');
    // disarmed after the win — no double-win
    expect(t.armed).toBe(false);
    hooks.fire('onTick', { dt: 0.016, t: 2 });
    expect(e.__win).toHaveBeenCalledTimes(1);
  });

  it('wins on the score goal via engine.score', () => {
    const ds = findGoalDate('score');
    const ch = generateDailyChallenge(ds);
    const hooks = fakeHooks();
    const e = fakeEngine(ch, hooks);
    const t = new ChallengeGoalTracker(e as any, ch);
    t.arm();
    e.score = ch.goal.target - 1;
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).not.toHaveBeenCalled();
    e.score = ch.goal.target;
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).toHaveBeenCalledTimes(1);
  });

  it('wins on the survive goal via engine.elapsed', () => {
    const ds = findGoalDate('survive');
    const ch = generateDailyChallenge(ds);
    const hooks = fakeHooks();
    const e = fakeEngine(ch, hooks);
    const t = new ChallengeGoalTracker(e as any, ch);
    t.arm();
    e.elapsed = ch.goal.target - 1;
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).not.toHaveBeenCalled();
    e.elapsed = ch.goal.target;
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).toHaveBeenCalledTimes(1);
  });

  it('never fires while the engine is not playing; disarm() detaches', () => {
    const ds = findGoalDate('kills');
    const ch: DailyChallenge = { ...generateDailyChallenge(ds), goal: { kind: 'kills', target: 1 } };
    const hooks = fakeHooks();
    const e = fakeEngine(ch, hooks);
    const t = new ChallengeGoalTracker(e as any, ch);
    t.arm();
    e.state = 'won';
    hooks.fire('onKill', {});
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).not.toHaveBeenCalled();
    e.state = 'playing';
    t.disarm();
    expect(t.armed).toBe(false);
    expect(hooks.count('onKill')).toBe(0);
    hooks.fire('onKill', {});
    hooks.fire('onTick', { dt: 0.016, t: 1 });
    expect(e.__win).not.toHaveBeenCalled();
  });
});

describe('challengeBoard', () => {
  it('returns today + the last N days, newest first, all local', () => {
    const p = defaultProfile();
    const rows = challengeBoard(p, '2026-10-22');
    expect(rows).toHaveLength(CHALLENGE_BOARD_DAYS + 1);
    expect(rows[0].date).toBe('2026-10-22');
    expect(rows[0].today).toBe(true);
    expect(rows[7].date).toBe('2026-10-15');
    expect(rows[7].today).toBe(false);
    for (const r of rows) {
      expect(r.result).toBeNull();
      expect(r.goalText.length).toBeGreaterThan(0);
      expect(r.loadoutText.length).toBeGreaterThan(0);
    }
  });

  it('attaches stored results to their date rows', () => {
    const p: ProfileData = defaultProfile();
    const ch = generateDailyChallenge('2026-10-20');
    recordDailyResult(p, '2026-10-20', {
      score: 777, kills: 20, timeSeconds: 120, damageTaken: 10,
      won: true, goal: ch.goal, genre: 'fps-arena', seed: ch.seed,
    });
    const rows = challengeBoard(p, '2026-10-22');
    const row = rows.find((r) => r.date === '2026-10-20')!;
    expect(row.result).toMatchObject({ score: 777, kills: 20, won: true });
    expect(rows.find((r) => r.date === '2026-10-21')!.result).toBeNull();
  });
});
