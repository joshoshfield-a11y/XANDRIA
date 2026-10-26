/**
 * CRIT-SYSTEM (upgrade loop): unit tests for the seeded crit mechanic.
 * Pure table/roll checks plus roller replication — no Engine needed.
 * The manager-level real-crit behavior is covered in damage-numbers.test.ts
 * (ability crit is real) and the e2e spec (seeded combat legs).
 */
import { describe, it, expect } from 'vitest';
import {
  CRIT_TABLE,
  CRIT_MELEE_SALT,
  CRIT_PROJECTILE_SALT,
  critChanceFor,
  critMultiplierFor,
  critStatsFor,
  rollCrit,
  applyCrit,
  CritRoller,
} from '../src/engine/game/crit';
import { Rng } from '../src/engine/core/Rng';

describe('crit table', () => {
  it('ships the briefed base values', () => {
    expect(CRIT_TABLE.baseChance).toBe(0.05);
    expect(CRIT_TABLE.baseMultiplier).toBe(2.0);
  });

  it('tier bonuses rise monotonically with rarity', () => {
    const tiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
    const chances = tiers.map((t) => critChanceFor(t, 0));
    const mults = tiers.map((t) => critMultiplierFor(t, 0));
    for (let i = 1; i < tiers.length; i++) {
      expect(chances[i]).toBeGreaterThan(chances[i - 1]);
      expect(mults[i]).toBeGreaterThan(mults[i - 1]);
    }
    expect(critChanceFor('common', 0)).toBe(0.05);
    expect(critChanceFor('legendary', 0)).toBe(0.15);
    expect(critMultiplierFor('legendary', 0)).toBe(2.5);
  });

  it('smithing rank bonuses apply only at ranks 2-3', () => {
    expect(critChanceFor('common', 0)).toBe(0.05);
    expect(critChanceFor('common', 1)).toBe(0.05);
    expect(critChanceFor('common', 2)).toBe(0.07);
    expect(critChanceFor('common', 3)).toBe(0.09);
    expect(critMultiplierFor('common', 1)).toBe(2.0);
    expect(critMultiplierFor('common', 3)).toBe(2.2);
  });

  it('clamps out-of-range ranks and caps chance at 1', () => {
    expect(critChanceFor('common', 99)).toBe(critChanceFor('common', 3));
    expect(critChanceFor('common', -5)).toBe(0.05);
    expect(critChanceFor('legendary', 3)).toBeLessThanOrEqual(1);
  });

  it('critStatsFor reports the auditable inputs', () => {
    expect(critStatsFor({ tier: 'rare', skillRank: 2 })).toEqual({
      chance: 0.11,
      multiplier: 2.3,
      tier: 'rare',
      skillRank: 2,
    });
    // no weapon -> common bonuses
    expect(critStatsFor({ tier: null, skillRank: 0 })).toEqual({
      chance: 0.05,
      multiplier: 2.0,
      tier: 'common',
      skillRank: 0,
    });
  });
});

describe('rollCrit / applyCrit', () => {
  it('crits strictly below the chance, never at or above it', () => {
    expect(rollCrit(0.049999, 'common', 0).crit).toBe(true);
    expect(rollCrit(0.05, 'common', 0).crit).toBe(false);
    expect(rollCrit(0.149999, 'legendary', 0).crit).toBe(true);
    expect(rollCrit(0.15, 'legendary', 0).crit).toBe(false);
  });

  it('crit multiplier follows tier + rank, non-crit multiplier is 1', () => {
    expect(rollCrit(0.01, 'epic', 3).multiplier).toBe(2.5);
    expect(rollCrit(0.5, 'epic', 3).multiplier).toBe(1);
  });

  it('non-crit returns the input bit-identical; crit rounds once', () => {
    expect(applyCrit(43.377, { crit: false, multiplier: 1 })).toBe(43.377);
    expect(applyCrit(42.8224, { crit: true, multiplier: 2.0 })).toBe(86);
    expect(applyCrit(25, { crit: true, multiplier: 2.0 })).toBe(50);
  });
});

describe('CritRoller determinism', () => {
  it('same seed + same sequence -> identical rolls (independent replication)', () => {
    const run = () => {
      const r = new CritRoller(777);
      return Array.from({ length: 50 }, () => r.roll({ tier: 'rare', skillRank: 2 }));
    };
    expect(run()).toEqual(run());
  });

  it('matches a hand-rolled mulberry32 replication draw for draw', () => {
    // Independent reimplementation of the Rng (mulberry32) — the test
    // does not import the game's roll path, only its PRNG contract.
    const mulberry = (seed: number) => {
      let s = seed >>> 0 || 0x9e3779b9;
      return () => {
        let t = (s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const seed = 4242;
    const mine = mulberry(seed);
    const roller = new CritRoller(seed);
    for (let i = 0; i < 20; i++) {
      const u = mine();
      const expected = rollCrit(u, 'common', 0);
      expect(roller.roll({ tier: null, skillRank: 0 })).toEqual(expected);
    }
  });

  it('melee and projectile salts keep the streams apart', () => {
    expect(CRIT_MELEE_SALT).not.toBe(CRIT_PROJECTILE_SALT);
    const a = new CritRoller((9 ^ CRIT_MELEE_SALT) >>> 0);
    const b = new CritRoller((9 ^ CRIT_PROJECTILE_SALT) >>> 0);
    const seqA = Array.from({ length: 10 }, () => a.roll({ tier: null, skillRank: 0 }));
    const seqB = Array.from({ length: 10 }, () => b.roll({ tier: null, skillRank: 0 }));
    expect(seqA).not.toEqual(seqB);
  });

  it('roller draws agree with the game Rng class on the same seed', () => {
    const seed = 99;
    const rng = new Rng(seed);
    const roller = new CritRoller(seed);
    for (let i = 0; i < 10; i++) {
      const u = rng.next();
      expect(roller.roll({ tier: null, skillRank: 0 })).toEqual(rollCrit(u, null, 0));
    }
  });
});
