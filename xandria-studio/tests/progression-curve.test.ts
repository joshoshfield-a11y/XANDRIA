/**
 * progression-curve phase: data-driven XP/stat table, symmetric derivation
 * with the enemy-scaling bands, level cap, one additive XP path, and
 * per-level stat growth application.
 */
import { describe, it, expect } from 'vitest';
import {
  PROGRESSION_TABLE,
  LEVEL_CAP,
  levelRow,
  xpForNextLevel,
} from '../src/engine/game/progressionCurve';
import {
  ENEMY_LEVEL_BANDS,
  bandIndexForLevel,
} from '../src/engine/game/enemyScaling';
import { Progression } from '../src/engine/game/Progression';
import { invalidateProgressionSpeedAnchor } from '../src/engine/game/Progression';
import { Rng } from '../src/engine/core/Rng';
import type { Engine } from '../src/engine/Engine';
import type { GameSpec } from '../src/spec/schema';
import type { PlayerAvatar } from '../src/blueprints/common';

const progEngine = (seed = 42) =>
  ({
    rng: new Rng(seed),
    spec: { custom: {} },
    hooks: {
      emit() {},
      tap() {},
      tapCount: () => 0,
      enemyKinds: new Map(),
      upgrades: new Map(),
      customUpgradeDefs: () => [],
    },
  }) as unknown as Engine;

const opts = { enabled: true, xpPerKill: 20, xpPerPickup: 5 };

const fakeAvatar = () => {
  const a: any = {
    maxHealth: 100,
    health: 100,
    heal(n: number) {
      a.health = Math.min(a.maxHealth, a.health + n);
    },
  };
  return a as PlayerAvatar;
};
const fakeSpec = () => ({ player: { speed: 7 } }) as unknown as GameSpec;

describe('PROGRESSION_TABLE', () => {
  it('has exactly LEVEL_CAP rows, frozen', () => {
    expect(LEVEL_CAP).toBe(50);
    expect(PROGRESSION_TABLE).toHaveLength(50);
    expect(Object.isFrozen(PROGRESSION_TABLE)).toBe(true);
  });

  it('xpToNext preserves the legacy 100*level^1.5 curve', () => {
    expect(xpForNextLevel(1)).toBe(100);
    expect(xpForNextLevel(2)).toBe(283);
    expect(xpForNextLevel(3)).toBe(Math.round(100 * Math.pow(3, 1.5)));
    expect(xpForNextLevel(50)).toBe(Math.round(100 * Math.pow(50, 1.5)));
  });

  it('level 1 is the identity row (fresh player byte-identical)', () => {
    const r = levelRow(1);
    expect(r.dmgMult).toBe(1);
    expect(r.hpMult).toBe(1);
    expect(r.speedMult).toBe(1);
  });

  it('is derived symmetrically from ENEMY_LEVEL_BANDS (player dmg ~ enemy hp, player hp ~ enemy dmg)', () => {
    for (let level = 1; level <= 50; level++) {
      const row = levelRow(level);
      const band = ENEMY_LEVEL_BANDS[bandIndexForLevel(level)];
      expect(row.dmgMult).toBe(band.hpMult);
      expect(row.hpMult).toBe(band.dmgMult);
    }
  });

  it('top band matches the documented enemy ladder', () => {
    const r = levelRow(50);
    expect(r.dmgMult).toBe(6.8); // enemy hpMult at band 46-50
    expect(r.hpMult).toBe(3.4); // enemy dmgMult at band 46-50
    expect(r.speedMult).toBeCloseTo(1 + 0.004 * 49, 9);
  });

  it('clamps defensively', () => {
    expect(levelRow(0)).toBe(levelRow(1));
    expect(levelRow(999)).toBe(levelRow(50));
    expect(levelRow(NaN)).toBe(levelRow(1));
  });
});

describe('Progression level cap + additive XP path', () => {
  it('caps at level 50, XP keeps accumulating', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.addXp(10_000_000)).toBe(true);
    expect(p.level).toBe(50);
    const xpAtCap = p.xp;
    expect(p.addXp(1000)).toBe(false);
    expect(p.level).toBe(50);
    expect(p.xp).toBe(xpAtCap + 1000);
  });

  it('addXpEx returns the from→to span for multi-level jumps', () => {
    const p = new Progression(progEngine(), opts);
    const r = p.addXpEx(100 + 283 + 50); // 1→2→3, 50 left over
    expect(r.leveled).toBe(true);
    expect(r.gain).toEqual({ from: 1, to: 3 });
    expect(p.level).toBe(3);
  });

  it('addXpEx is additive-only: never subtracts, NaN/negative no-op', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.addXpEx(-5)).toEqual({ leveled: false, gain: null });
    expect(p.addXpEx(NaN)).toEqual({ leveled: false, gain: null });
    expect(p.xp).toBe(0);
    expect(p.level).toBe(1);
  });

  it('damageMult folds the level table (1.0 at level 1, symmetric at 12)', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.damageMult()).toBe(1);
    p.portalRestore({ level: 12, xp: 0, counts: {} });
    expect(p.levelDamageMult()).toBe(1.55); // band 11-15 hpMult
    expect(p.levelHpMult()).toBe(1.35); // band 11-15 dmgMult
    expect(p.damageMult()).toBe(1.55);
  });

  it('portalRestore clamps corrupt levels into [1, 50]', () => {
    const p = new Progression(progEngine(), opts);
    p.portalRestore({ level: 999, xp: 0, counts: {} });
    expect(p.level).toBe(50);
    p.portalRestore({ level: -3, xp: 0, counts: {} });
    expect(p.level).toBe(1);
  });
});

describe('applyLevelStatGrowth', () => {
  it('scales maxHealth by the hpMult ratio and heals the gain only', () => {
    const p = new Progression(progEngine(), opts);
    p.portalRestore({ level: 12, xp: 0, counts: {} });
    const av = fakeAvatar();
    av.health = 40; // damaged before leveling
    p.applyLevelStatGrowth(av, fakeSpec());
    expect(av.maxHealth).toBe(Math.round(100 * 1.35));
    expect(av.health).toBe(40 + (Math.round(100 * 1.35) - 100)); // gain healed, no free full heal
  });

  it('recomputes spec speed idempotently (no compounding across portals)', () => {
    const p = new Progression(progEngine(), opts);
    p.portalRestore({ level: 12, xp: 0, counts: {} });
    const spec = fakeSpec();
    const av = fakeAvatar();
    p.applyLevelStatGrowth(av, spec);
    const after = spec.player.speed;
    expect(after).toBeCloseTo(7 * (1 + 0.004 * 11), 9);
    // second avatar, same spec (portal arrival): same result, no compounding
    p.applyLevelStatGrowth(fakeAvatar(), spec);
    expect(spec.player.speed).toBeCloseTo(after, 9);
  });

  it('speed upgrade stacks multiply on top of the level factor', () => {
    const p = new Progression(progEngine(), opts);
    p.portalRestore({ level: 12, xp: 0, counts: {} });
    const spec = fakeSpec();
    const av = fakeAvatar();
    p.applyLevelStatGrowth(av, spec);
    p.applyUpgrade('speed', av);
    p.applyLevelStatGrowth(av, spec);
    expect(spec.player.speed).toBeCloseTo(7 * (1 + 0.004 * 11) * 1.12, 9);
  });

  it('level 1 is a no-op', () => {
    const p = new Progression(progEngine(), opts);
    const av = fakeAvatar();
    const spec = fakeSpec();
    p.applyLevelStatGrowth(av, spec);
    expect(av.maxHealth).toBe(100);
    expect(spec.player.speed).toBe(7);
  });

  it('invalidation re-anchors (applyLoadout / editor speed edits)', () => {
    const p = new Progression(progEngine(), opts);
    p.portalRestore({ level: 12, xp: 0, counts: {} });
    const spec = fakeSpec();
    p.applyLevelStatGrowth(fakeAvatar(), spec); // anchors 7
    // loadout applies swift: speed rewritten, anchor invalidated
    spec.player.speed = 7 * 1.08;
    invalidateProgressionSpeedAnchor(spec);
    p.applyLevelStatGrowth(fakeAvatar(), spec);
    expect(spec.player.speed).toBeCloseTo(7 * 1.08 * (1 + 0.004 * 11), 9);
  });
});

describe('craft XP on the one additive path', () => {
  it('xpPerCraft defaults to 15, honours the spec override', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.xpPerCraft()).toBe(15);
    const p2 = new Progression(progEngine(), { ...opts, xpPerCraft: 40 });
    expect(p2.xpPerCraft()).toBe(40);
  });

  it('craft XP flows through addXpEx and levels up', () => {
    const p = new Progression(progEngine(), opts);
    const r = p.addXpEx(p.xpPerCraft() * 7); // 105 >= 100
    expect(r.leveled).toBe(true);
    expect(p.level).toBe(2);
    expect(p.xp).toBe(5);
  });
});
