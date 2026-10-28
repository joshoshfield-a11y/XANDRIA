/**
 * skill-synergies.test.ts — skill synergy passives (upgrade loop).
 *
 * - SYNERGY_DEFS: one table, 5 defs, sane effect values, real skill ids.
 * - Evaluation: pair/triple rank boundaries, pure function of ranks.
 * - Additive math, applied AFTER rank computation: harvest yield,
 *   craft-time multiplier, crit bonuses; gating / check order / XP math
 *   unchanged by synergies.
 * - Portal snapshot/restore preserves (and can drop) synergies.
 * - Per-seed localStorage persistence (the save/reload leg) with
 *   guarded storage; synergies follow restored ranks.
 * - Crit-table synergy bonuses: exact chance/multiplier math, roll
 *   forwarding through CritRoller, garbage-bonus sanitization.
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import type { Engine } from '../src/engine/Engine';
import {
  SKILL_IDS,
  SYNERGY_DEFS,
  evaluateSynergies,
  synergyIsActive,
  SkillSystem,
  loadPersistedSkillXp,
  savePersistedSkillXp,
  skillXpStorageKey,
  type SynergyDef,
} from '../src/engine/game/skills';
import {
  critChanceFor,
  critMultiplierFor,
  critStatsFor,
  rollCrit,
  synergyCritCtx,
  CritRoller,
} from '../src/engine/game/crit';

function engineWith(seed?: number, customSkills?: Record<string, unknown>): Engine {
  const spec = defaultSpec(seed ?? 4242) as GameSpec;
  if (customSkills) spec.custom = { ...(spec.custom ?? {}), skills: customSkills };
  return {
    spec,
    audio: { play(_id: string) {} },
  } as unknown as Engine;
}

function ranksStub(ranks: Record<string, number>) {
  return (id: string) => ranks[id] ?? 1;
}

function activeIds(ranks: Record<string, number>): string[] {
  return evaluateSynergies(ranksStub(ranks)).map((d) => d.id);
}

describe('SYNERGY_DEFS table', () => {
  it('seeds 5 synergies with unique ids and names', () => {
    expect(SYNERGY_DEFS.length).toBe(5);
    expect(new Set(SYNERGY_DEFS.map((d) => d.id)).size).toBe(5);
    expect(new Set(SYNERGY_DEFS.map((d) => d.name)).size).toBe(5);
  });

  it('every requirement names a real skill at rank 2..3', () => {
    for (const d of SYNERGY_DEFS) {
      expect(d.requires.length).toBeGreaterThanOrEqual(2);
      for (const r of d.requires) {
        expect(SKILL_IDS).toContain(r.skill);
        expect(r.rank).toBeGreaterThanOrEqual(2);
        expect(r.rank).toBeLessThanOrEqual(3);
      }
      expect(d.requirementLine.length).toBeGreaterThan(0);
      expect(d.effectLine.length).toBeGreaterThan(0);
    }
  });

  it('effect values are sane for their kind', () => {
    for (const d of SYNERGY_DEFS) {
      const v = d.effect.value;
      expect(Number.isFinite(v)).toBe(true);
      if (d.effect.kind === 'harvestYield') expect(Number.isInteger(v) && v >= 1).toBe(true);
      if (d.effect.kind === 'craftTime') expect(v > 0 && v < 1).toBe(true);
      if (d.effect.kind === 'critChance') expect(v > 0 && v <= 0.1).toBe(true);
      if (d.effect.kind === 'critMultiplier') expect(v > 0).toBe(true);
    }
  });

  it('covers pair and triple requirements across all three skills', () => {
    const triples = SYNERGY_DEFS.filter((d) => d.requires.length === 3);
    expect(triples.length).toBe(1);
    const kinds = new Set(SYNERGY_DEFS.map((d) => d.effect.kind));
    expect(kinds.has('harvestYield')).toBe(true);
    expect(kinds.has('craftTime')).toBe(true);
    expect(kinds.has('critChance')).toBe(true);
    expect(kinds.has('critMultiplier')).toBe(true);
    const used = new Set(SYNERGY_DEFS.flatMap((d) => d.requires.map((r) => r.skill)));
    expect(used.size).toBe(3);
  });
});

describe('synergy evaluation', () => {
  it('nothing active at rank 1 across the board', () => {
    expect(activeIds({})).toEqual([]);
    expect(activeIds({ foraging: 1, smithing: 1, alchemy: 1 })).toEqual([]);
  });

  it('field-smith needs both foraging 2 and smithing 2', () => {
    expect(activeIds({ foraging: 2, smithing: 1 })).toEqual([]);
    expect(activeIds({ foraging: 1, smithing: 2 })).toEqual([]);
    expect(activeIds({ foraging: 2, smithing: 2 })).toEqual(['field-smith']);
  });

  it('all rank-2 activates the three pair synergies, not the rank-3 ones', () => {
    expect(activeIds({ foraging: 2, smithing: 2, alchemy: 2 })).toEqual([
      'field-smith',
      'workshop-flow',
      'herbal-edge',
    ]);
  });

  it('tempered-edge needs smithing 3; grand-artisan needs the full triple', () => {
    expect(activeIds({ foraging: 2, smithing: 3, alchemy: 2 })).toEqual([
      'field-smith',
      'workshop-flow',
      'herbal-edge',
      'tempered-edge',
    ]);
    expect(activeIds({ foraging: 3, smithing: 3, alchemy: 3 })).toEqual([
      'field-smith',
      'workshop-flow',
      'herbal-edge',
      'tempered-edge',
      'grand-artisan',
    ]);
  });

  it('unknown skill ids rank 0, so nothing activates', () => {
    const def = SYNERGY_DEFS[0] as SynergyDef;
    expect(synergyIsActive(def, () => 0)).toBe(false);
  });

  it('evaluation is pure: it changes no XP and no ranks', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('foraging', 60);
    const xpBefore = s.xpOf('foraging');
    evaluateSynergies((id) => s.rankOf(id));
    expect(s.xpOf('foraging')).toBe(xpBefore);
    expect(s.rankOf('foraging')).toBe(2);
  });
});

describe('SkillSystem synergy math (additive, after rank computation)', () => {
  it('starts with no synergies and identity bonuses', () => {
    const s = new SkillSystem(engineWith());
    expect(s.activeSynergies()).toEqual([]);
    expect(s.harvestYieldBonus()).toBe(0);
    expect(s.craftTimeMult()).toBe(1);
    expect(s.synergyCritBonuses()).toEqual({ chanceBonus: 0, multiplierBonus: 0 });
  });

  it('harvest yield = rank bonus + synergy bonus', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('foraging', 60); // rank 2: rank bonus +1, no synergy yet
    expect(s.harvestYieldBonus()).toBe(1);
    s.addXp('smithing', 80); // rank 2: field-smith activates
    expect(s.activeSynergies().map((d) => d.id)).toEqual(['field-smith']);
    expect(s.harvestYieldBonus()).toBe(2);
    s.addXp('foraging', 120); // rank 3: rank bonus +2, synergy +1
    expect(s.harvestYieldBonus()).toBe(3);
  });

  it('craft time = rank multiplier x synergy multiplier', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('smithing', 80); // rank 2: 0.9, no synergy (alchemy 1)
    expect(s.craftTimeMult()).toBe(0.9);
    s.addXp('alchemy', 80); // workshop-flow: 0.9 x 0.9
    expect(s.craftTimeMult()).toBeCloseTo(0.81, 10);
    expect(s.craftTimeMult('station_alchemy')).toBeCloseTo(0.81, 10);
  });

  it('triple capstone stacks multiplicatively with workshop-flow', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('foraging', 180);
    s.addXp('smithing', 240);
    s.addXp('alchemy', 240);
    expect(s.activeSynergies().length).toBe(5);
    // rank 0.75 x workshop-flow 0.9 x grand-artisan 0.85
    expect(s.craftTimeMult()).toBeCloseTo(0.57375, 10);
  });

  it('crit bonuses sum from the combat-line synergies only', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('foraging', 60);
    s.addXp('alchemy', 80); // herbal-edge: +0.02 chance
    expect(s.synergyCritBonuses()).toEqual({ chanceBonus: 0.02, multiplierBonus: 0 });
    s.addXp('smithing', 240); // tempered-edge: +0.2 multiplier
    expect(s.synergyCritBonuses()).toEqual({ chanceBonus: 0.02, multiplierBonus: 0.2 });
  });

  it('synergies never change ranks, gating, or XP math', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('smithing', 80);
    expect(s.xpOf('smithing')).toBe(80);
    expect(s.rankOf('smithing')).toBe(2);
    // A synergy requirement is not a rank: foraging is still rank 1.
    expect(s.rankOf('foraging')).toBe(1);
  });

  it('disabled systems never activate synergies', () => {
    const s = new SkillSystem(engineWith(undefined, { enabled: false }));
    s.portalRestore({ xp: { foraging: 180, smithing: 240, alchemy: 240 } });
    expect(s.activeSynergies()).toEqual([]);
    expect(s.synergyHarvestYieldBonus()).toBe(0);
    expect(s.synergyCritBonuses()).toEqual({ chanceBonus: 0, multiplierBonus: 0 });
  });

  it('no RNG anywhere: perturbing Math.random changes nothing', () => {
    const s = new SkillSystem(engineWith());
    const orig = Math.random;
    Math.random = () => 0.999;
    try {
      s.addXp('foraging', 60);
      s.addXp('smithing', 80);
      expect(s.activeSynergies().map((d) => d.id)).toEqual(['field-smith']);
      expect(s.harvestYieldBonus()).toBe(2);
    } finally {
      Math.random = orig;
    }
  });
});

describe('portal snapshot / restore and synergies', () => {
  it('round-trip preserves active synergies and bonuses', () => {
    const a = new SkillSystem(engineWith());
    a.addXp('foraging', 60);
    a.addXp('smithing', 80);
    a.addXp('alchemy', 80);
    const b = new SkillSystem(engineWith());
    b.portalRestore(a.portalSnapshot());
    expect(b.activeSynergies().map((d) => d.id)).toEqual(
      a.activeSynergies().map((d) => d.id),
    );
    expect(b.harvestYieldBonus()).toBe(a.harvestYieldBonus());
    expect(b.craftTimeMult()).toBe(a.craftTimeMult());
    expect(b.synergyCritBonuses()).toEqual(a.synergyCritBonuses());
  });

  it('dropping below a required rank removes the synergy', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('foraging', 60);
    s.addXp('smithing', 80);
    expect(s.activeSynergies().map((d) => d.id)).toEqual(['field-smith']);
    expect(s.harvestYieldBonus()).toBe(2);
    s.portalRestore({ xp: { foraging: 0, smithing: 0, alchemy: 0 } });
    expect(s.activeSynergies()).toEqual([]);
    expect(s.harvestYieldBonus()).toBe(0);
    expect(s.craftTimeMult()).toBe(1);
  });

  it('corrupt restore drops synergies instead of throwing', () => {
    const s = new SkillSystem(engineWith());
    s.addXp('foraging', 60);
    s.addXp('smithing', 80);
    s.portalRestore({ xp: { foraging: -50, smithing: NaN, alchemy: 90, bogus: 10 } } as never);
    expect(s.activeSynergies()).toEqual([]);
    expect(s.harvestYieldBonus()).toBe(0);
  });
});

describe('per-seed persistence (save/reload leg)', () => {
  it('storage helpers guard absent storage and invalid payloads', () => {
    expect(loadPersistedSkillXp(999001)).toBeNull();
    expect(() => savePersistedSkillXp(999001, { xp: { foraging: 60 } })).not.toThrow();
    expect(loadPersistedSkillXp(999001)).toBeNull();
  });

  it('persisted ranks restore on a fresh system with the same seed', () => {
    const store = new Map<string, string>();
    const prev = (globalThis as unknown as { localStorage?: unknown }).localStorage;
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    try {
      const a = new SkillSystem(engineWith(777001), { persist: true });
      a.addXp('foraging', 60);
      a.addXp('smithing', 80);
      expect(store.has(skillXpStorageKey(777001))).toBe(true);
      const b = new SkillSystem(engineWith(777001), { persist: true });
      expect(b.xpOf('foraging')).toBe(60);
      expect(b.activeSynergies().map((d) => d.id)).toEqual(['field-smith']);
      // A different seed starts fresh.
      const c = new SkillSystem(engineWith(777002), { persist: true });
      expect(c.xpOf('foraging')).toBe(0);
      expect(c.activeSynergies()).toEqual([]);
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
      else (globalThis as unknown as { localStorage: unknown }).localStorage = prev;
    }
  });

  it('persist:false (default) writes nothing', () => {
    const store = new Map<string, string>();
    const prev = (globalThis as unknown as { localStorage?: unknown }).localStorage;
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    try {
      const a = new SkillSystem(engineWith(777003));
      a.addXp('foraging', 60);
      expect(store.size).toBe(0);
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
      else (globalThis as unknown as { localStorage: unknown }).localStorage = prev;
    }
  });

  it('invalid persisted payload restores nothing and never throws', () => {
    const prev = (globalThis as unknown as { localStorage?: unknown }).localStorage;
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: () => '{not json',
      setItem: () => {},
    };
    try {
      expect(() => new SkillSystem(engineWith(777004), { persist: true })).not.toThrow();
      const s = new SkillSystem(engineWith(777004), { persist: true });
      expect(s.xpOf('foraging')).toBe(0);
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
      else (globalThis as unknown as { localStorage: unknown }).localStorage = prev;
    }
  });
});

describe('crit synergy bonuses', () => {
  it('chance adds after base + tier + rank bonuses', () => {
    expect(critChanceFor('common', 1)).toBe(0.05);
    expect(critChanceFor('common', 1, 0.02)).toBe(0.07);
    expect(critChanceFor('common', 3, 0.02)).toBe(0.11);
    expect(critChanceFor('legendary', 3, 0.02)).toBe(0.21);
  });

  it('multiplier adds after base + tier + rank bonuses', () => {
    expect(critMultiplierFor('common', 1)).toBe(2.0);
    expect(critMultiplierFor('common', 1, 0.2)).toBe(2.2);
    expect(critMultiplierFor('common', 3, 0.2)).toBe(2.4);
  });

  it('critStatsFor honors synergy fields without changing its shape', () => {
    expect(critStatsFor({ tier: 'common', skillRank: 2 })).toEqual({
      chance: 0.07,
      multiplier: 2.1,
      tier: 'common',
      skillRank: 2,
    });
    expect(
      critStatsFor({
        tier: 'common',
        skillRank: 2,
        synergyChanceBonus: 0.02,
        synergyMultiplierBonus: 0.2,
      }),
    ).toEqual({ chance: 0.09, multiplier: 2.3, tier: 'common', skillRank: 2 });
  });

  it('rollCrit uses the boosted threshold and multiplier, same seeded draw', () => {
    // u=0.06: below the boosted 0.07 threshold, above the base 0.05.
    const boosted = rollCrit(0.06, 'common', 1, { chanceBonus: 0.02, multiplierBonus: 0.2 });
    expect(boosted).toEqual({ crit: true, multiplier: 2.2 });
    const base = rollCrit(0.06, 'common', 1);
    expect(base).toEqual({ crit: false, multiplier: 1 });
    // Above both thresholds: no crit either way.
    expect(rollCrit(0.08, 'common', 1, { chanceBonus: 0.02 }).crit).toBe(false);
  });

  it('synergyCritCtx carries the bonuses into a CritCtx', () => {
    expect(synergyCritCtx(null, 2, { chanceBonus: 0.02, multiplierBonus: 0.2 })).toEqual({
      tier: null,
      skillRank: 2,
      synergyChanceBonus: 0.02,
      synergyMultiplierBonus: 0.2,
    });
  });

  it('CritRoller forwards synergy bonuses deterministically', () => {
    const ctx = { tier: 'common' as const, skillRank: 1, synergyChanceBonus: 1 };
    // Chance bonus 1 caps the chance at 1: always a crit, same draw.
    expect(new CritRoller(1234).roll(ctx).crit).toBe(true);
    // Same seed + same context: identical rolls.
    expect(new CritRoller(1234).roll(ctx)).toEqual(new CritRoller(1234).roll(ctx));
    const plain = new CritRoller(1234).roll({ tier: 'common', skillRank: 1 });
    const boosted = new CritRoller(1234).roll({
      tier: 'common',
      skillRank: 1,
      synergyChanceBonus: 0.02,
    });
    // Same seeded draw: the boosted roll can only upgrade, never downgrade.
    expect(boosted.multiplier).toBeGreaterThanOrEqual(plain.multiplier);
  });

  it('negative / non-finite synergy bonuses sanitize to zero', () => {
    expect(critChanceFor('common', 1, -0.5)).toBe(0.05);
    expect(critChanceFor('common', 1, NaN)).toBe(0.05);
    expect(critMultiplierFor('common', 1, -1)).toBe(2.0);
    expect(critMultiplierFor('common', 1, Infinity)).toBe(2.0);
    expect(rollCrit(0.06, 'common', 1, { chanceBonus: -0.5 }).crit).toBe(false);
  });
});
