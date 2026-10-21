/**
 * skills.test.ts — skills wave (skill system + XP/rank progression +
 * skill-gated recipes).
 *
 * - SKILL_DEFS: stable ids, ranks 1..3, increasing thresholds, honest
 *   effect lines, per-event XP values.
 * - SkillSystem: rank boundaries, addXp rank-ups (exact/multi), disabled
 *   + unknown-id + non-positive no-ops, xpMultiplier, onHarvest/onCraft
 *   routing, harvestYieldBonus, craftTimeMult, progress helpers.
 * - Determinism: perturbing Math.random changes nothing (no RNG anywhere).
 * - Portal snapshot/restore round-trip + corrupt-input clamps.
 * - checkCraft/craft: 'missing-skill' gate, fail-closed without skills,
 *   check order (min-level before missing-skill), ungated recipes
 *   unaffected, pool deep-copies carry the new fields.
 */
import { describe, it, expect } from 'vitest';
import { Inventory } from '../src/engine/game/items/Inventory';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import type { Engine } from '../src/engine/Engine';
import {
  SKILL_DEFS,
  SKILL_IDS,
  SKILL_FORAGING,
  SKILL_SMITHING,
  SKILL_ALCHEMY,
  rankForXp,
  craftSkillForStation,
  SkillSystem,
  resolveSkillsEnabled,
  resolveSkillsXpMultiplier,
  type SkillDef,
} from '../src/engine/game/skills';
import {
  STATION_ALCHEMY,
  STATION_FORGE,
  STATION_IDS,
  buildRecipePool,
  materialItemDefs,
  craftedItemDefs,
  checkCraft,
  craft,
  type CraftOptions,
} from '../src/engine/game/crafting';
import {
  lootMaterialDefs,
  lootItemDefs,
} from '../src/engine/game/loot';

function fakeEngine(customSkills?: Record<string, unknown>): Engine {
  return {
    spec: { custom: customSkills ? { skills: customSkills } : {} },
    audio: { play(_id: string) {} },
  } as unknown as Engine;
}

function specWith(seed: number): GameSpec {
  const s = defaultSpec(seed);
  s.custom = { ...(s.custom ?? {}) };
  return s;
}

function allDefs() {
  // Master-crafting wave: master recipes (always in the pool) consume
  // loot materials, so the loot defs are legitimate test fixtures here.
  return { ...materialItemDefs(), ...craftedItemDefs(), ...lootMaterialDefs(), ...lootItemDefs() };
}

function gatedRecipe(skillId: string, minSkillRank?: number) {
  return {
    id: 'recipe_test_gated',
    name: 'Test Gated',
    ingredients: [],
    output: { itemId: 'mat_ore', count: 1 },
    skillId,
    ...(minSkillRank === undefined ? {} : { minSkillRank }),
  };
}

const rankStub = (rank: number) => ({
  rankOf: (_id: string) => rank,
  skillName: (id: string) => ({ foraging: 'Foraging', smithing: 'Smithing', alchemy: 'Alchemy' })[id] ?? id,
});

describe('SKILL_DEFS — data-driven table', () => {
  it('has the three stable skill ids', () => {
    expect(SKILL_IDS).toEqual(['foraging', 'smithing', 'alchemy']);
    expect(SKILL_DEFS.map((d) => d.id)).toEqual([...SKILL_IDS]);
  });

  it('every def: maxRank 3, thresholds start at 0 and strictly increase', () => {
    for (const d of SKILL_DEFS) {
      expect(d.xpThresholds.length).toBe(3);
      expect(d.xpThresholds[0]).toBe(0);
      expect(d.xpThresholds[1]).toBeGreaterThan(0);
      expect(d.xpThresholds[2]).toBeGreaterThan(d.xpThresholds[1]);
      expect(d.effects.length).toBe(3);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.desc.length).toBeGreaterThan(0);
    }
  });

  it('per-event XP values are positive', () => {
    const byId = new Map(SKILL_DEFS.map((d) => [d.id, d]));
    expect(byId.get('foraging')!.xpPerHarvest).toBeGreaterThan(0);
    expect(byId.get('smithing')!.xpPerCraft).toBeGreaterThan(0);
    expect(byId.get('alchemy')!.xpPerCraft).toBeGreaterThan(0);
  });

  it('effect tables match rank count where present', () => {
    for (const d of SKILL_DEFS) {
      if (d.yieldBonus) expect(d.yieldBonus.length).toBe(3);
      if (d.craftTimeMult) expect(d.craftTimeMult.length).toBe(3);
    }
  });
});

describe('rankForXp — threshold boundaries', () => {
  const def = SKILL_DEFS.find((d) => d.id === 'foraging') as SkillDef;
  it('maps xp to ranks at the exact boundaries', () => {
    expect(rankForXp(def, 0)).toBe(1);
    expect(rankForXp(def, 59)).toBe(1);
    expect(rankForXp(def, 60)).toBe(2);
    expect(rankForXp(def, 179)).toBe(2);
    expect(rankForXp(def, 180)).toBe(3);
    expect(rankForXp(def, 100000)).toBe(3);
  });
});

describe('SkillSystem — ranks and XP', () => {
  it('starts at rank 1 with 0 xp; unknown ids are rank 0 / xp 0', () => {
    const s = new SkillSystem(fakeEngine());
    expect(s.rankOf(SKILL_FORAGING)).toBe(1);
    expect(s.xpOf(SKILL_FORAGING)).toBe(0);
    expect(s.rankOf('bogus')).toBe(0);
    expect(s.xpOf('bogus')).toBe(0);
    expect(s.skillName('bogus')).toBe('bogus');
    expect(s.skillName(SKILL_SMITHING)).toBe('Smithing');
  });

  it('addXp at the exact threshold ranks up and fires onRankUp once', () => {
    const ups: Array<[string, number]> = [];
    const s = new SkillSystem(fakeEngine(), { onRankUp: (d, r) => ups.push([d.id, r]) });
    const res = s.addXp(SKILL_FORAGING, 60);
    expect(res).toEqual({ leveled: true, rank: 2 });
    expect(s.rankOf(SKILL_FORAGING)).toBe(2);
    expect(ups).toEqual([[SKILL_FORAGING, 2]]);
  });

  it('multi-rank jumps fire onRankUp once per rank gained', () => {
    const ups: number[] = [];
    const s = new SkillSystem(fakeEngine(), { onRankUp: (_d, r) => ups.push(r) });
    const res = s.addXp(SKILL_SMITHING, 1000);
    expect(res).toEqual({ leveled: true, rank: 3 });
    expect(ups).toEqual([2, 3]);
  });

  it('below-threshold gains do not level and do not fire', () => {
    let fired = 0;
    const s = new SkillSystem(fakeEngine(), { onRankUp: () => fired++ });
    expect(s.addXp(SKILL_FORAGING, 59)).toEqual({ leveled: false, rank: 1 });
    expect(fired).toBe(0);
    expect(s.xpOf(SKILL_FORAGING)).toBe(59);
  });

  it('disabled system no-ops (no xp, no rank-ups)', () => {
    let fired = 0;
    const s = new SkillSystem(fakeEngine({ enabled: false }), { onRankUp: () => fired++ });
    expect(s.enabled).toBe(false);
    expect(s.addXp(SKILL_FORAGING, 1000)).toEqual({ leveled: false, rank: 1 });
    expect(s.xpOf(SKILL_FORAGING)).toBe(0);
    expect(fired).toBe(0);
  });

  it('unknown skill ids and non-positive amounts no-op', () => {
    const s = new SkillSystem(fakeEngine());
    expect(s.addXp('bogus', 100).leveled).toBe(false);
    expect(s.addXp(SKILL_FORAGING, 0).leveled).toBe(false);
    expect(s.addXp(SKILL_FORAGING, -5).leveled).toBe(false);
    expect(s.xpOf(SKILL_FORAGING)).toBe(0);
  });

  it('xpMultiplier scales gains (0 freezes)', () => {
    const s = new SkillSystem(fakeEngine({ xpMultiplier: 2 }));
    s.addXp(SKILL_FORAGING, 30);
    expect(s.xpOf(SKILL_FORAGING)).toBe(60);
    expect(s.rankOf(SKILL_FORAGING)).toBe(2);
    const frozen = new SkillSystem(fakeEngine({ xpMultiplier: 0 }));
    frozen.addXp(SKILL_FORAGING, 500);
    expect(frozen.xpOf(SKILL_FORAGING)).toBe(0);
  });

  it('onHarvest feeds foraging; onCraft routes by station', () => {
    const s = new SkillSystem(fakeEngine());
    s.onHarvest();
    expect(s.xpOf(SKILL_FORAGING)).toBe(8);
    expect(s.xpOf(SKILL_SMITHING)).toBe(0);
    s.onCraft(STATION_ALCHEMY);
    expect(s.xpOf(SKILL_ALCHEMY)).toBe(12);
    s.onCraft(STATION_FORGE);
    s.onCraft(undefined);
    expect(s.xpOf(SKILL_SMITHING)).toBe(24);
  });

  it('craftSkillForStation: alchemy station -> alchemy, everything else -> smithing', () => {
    expect(craftSkillForStation(STATION_ALCHEMY)).toBe(SKILL_ALCHEMY);
    expect(craftSkillForStation(STATION_FORGE)).toBe(SKILL_SMITHING);
    expect(craftSkillForStation(undefined)).toBe(SKILL_SMITHING);
  });

  it('harvestYieldBonus follows the foraging rank (0/1/2)', () => {
    const s = new SkillSystem(fakeEngine());
    expect(s.harvestYieldBonus()).toBe(0);
    s.addXp(SKILL_FORAGING, 60);
    expect(s.harvestYieldBonus()).toBe(1);
    s.addXp(SKILL_FORAGING, 120);
    expect(s.harvestYieldBonus()).toBe(2);
  });

  it('craftTimeMult follows the station skill rank', () => {
    const s = new SkillSystem(fakeEngine());
    expect(s.craftTimeMult(STATION_FORGE)).toBe(1);
    s.addXp(SKILL_SMITHING, 80);
    expect(s.craftTimeMult(STATION_FORGE)).toBe(0.9);
    expect(s.craftTimeMult(STATION_ALCHEMY)).toBe(1); // alchemy still rank 1
    s.addXp(SKILL_SMITHING, 160);
    s.addXp(SKILL_ALCHEMY, 240);
    expect(s.craftTimeMult(STATION_FORGE)).toBe(0.75);
    expect(s.craftTimeMult(STATION_ALCHEMY)).toBe(0.75);
  });

  it('xpForNextRank / progressToNext', () => {
    const s = new SkillSystem(fakeEngine());
    expect(s.xpForNextRank(SKILL_FORAGING)).toBe(60);
    expect(s.progressToNext(SKILL_FORAGING)).toBe(0);
    s.addXp(SKILL_FORAGING, 30);
    expect(s.xpForNextRank(SKILL_FORAGING)).toBe(30);
    expect(s.progressToNext(SKILL_FORAGING)).toBeCloseTo(0.5);
    s.addXp(SKILL_FORAGING, 1000);
    expect(s.xpForNextRank(SKILL_FORAGING)).toBe(null);
    expect(s.progressToNext(SKILL_FORAGING)).toBe(1);
    expect(s.xpForNextRank('bogus')).toBe(null);
  });

  it('no Math.random anywhere: perturbing it changes nothing', () => {
    const real = Math.random;
    Math.random = () => 0.999999;
    try {
      const a = new SkillSystem(fakeEngine());
      a.addXp(SKILL_FORAGING, 61);
      const b = new SkillSystem(fakeEngine());
      b.onHarvest();
      expect(a.rankOf(SKILL_FORAGING)).toBe(2);
      expect(b.xpOf(SKILL_FORAGING)).toBe(8);
      expect(a.harvestYieldBonus()).toBe(1);
    } finally {
      Math.random = real;
    }
  });
});

describe('SkillSystem — portal snapshot/restore', () => {
  it('round-trips xp exactly', () => {
    const a = new SkillSystem(fakeEngine());
    a.addXp(SKILL_FORAGING, 61);
    a.addXp(SKILL_SMITHING, 200);
    const snap = a.portalSnapshot();
    expect(snap).toEqual({ xp: { foraging: 61, smithing: 200 } });
    const b = new SkillSystem(fakeEngine());
    b.portalRestore(snap);
    expect(b.xpOf(SKILL_FORAGING)).toBe(61);
    expect(b.rankOf(SKILL_FORAGING)).toBe(2);
    expect(b.rankOf(SKILL_SMITHING)).toBe(2);
    expect(b.xpOf(SKILL_ALCHEMY)).toBe(0);
  });

  it('corrupt snapshots clamp instead of throwing; unknown ids dropped', () => {
    const s = new SkillSystem(fakeEngine());
    s.portalRestore({ xp: { foraging: -50, smithing: NaN, alchemy: 90, bogus: 10 } });
    expect(s.xpOf(SKILL_FORAGING)).toBe(0);
    expect(s.xpOf(SKILL_SMITHING)).toBe(0);
    expect(s.xpOf(SKILL_ALCHEMY)).toBe(90);
    expect(s.rankOf('bogus')).toBe(0);
    expect(() => s.portalRestore(null)).not.toThrow();
    expect(() => s.portalRestore(undefined)).not.toThrow();
    expect(() => s.portalRestore({} as never)).not.toThrow();
  });
});

describe('resolvers', () => {
  it('resolveSkillsEnabled defaults true; false disables', () => {
    expect(resolveSkillsEnabled(specWith(1))).toBe(true);
    const off = specWith(1);
    off.custom!.skills = { enabled: false };
    expect(resolveSkillsEnabled(off)).toBe(false);
  });

  it('resolveSkillsXpMultiplier defaults 1; sanitizes garbage', () => {
    expect(resolveSkillsXpMultiplier(specWith(1))).toBe(1);
    const s = specWith(1);
    s.custom!.skills = { xpMultiplier: 2.5 };
    expect(resolveSkillsXpMultiplier(s)).toBe(2.5);
    for (const bad of [NaN, -3, Infinity, 'x' as never]) {
      const b = specWith(1);
      b.custom!.skills = { xpMultiplier: bad as number };
      expect(resolveSkillsXpMultiplier(b)).toBe(1);
    }
    const huge = specWith(1);
    huge.custom!.skills = { xpMultiplier: 999 };
    expect(resolveSkillsXpMultiplier(huge)).toBe(10);
  });
});

describe('checkCraft — missing-skill gate', () => {
  function baseOpts(inv: Inventory, extra?: Partial<CraftOptions>): CraftOptions {
    return {
      inventory: inv,
      defs: allDefs(),
      enabled: true,
      stations: new Set(STATION_IDS),
      ...extra,
    };
  }

  it('gated recipe fails closed with honest detail at low rank', () => {
    const inv = new Inventory(allDefs());
    const v = checkCraft([gatedRecipe('smithing', 2)], 'recipe_test_gated', baseOpts(inv, { skills: rankStub(1) }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('missing-skill');
    expect(v.detail).toBe('Requires Smithing rank 2 (you are rank 1).');
  });

  it('passes at sufficient rank (and crafts end-to-end)', () => {
    const inv = new Inventory(allDefs());
    const pool = [gatedRecipe('smithing', 2)];
    const v = checkCraft(pool, 'recipe_test_gated', baseOpts(inv, { skills: rankStub(2) }));
    expect(v.ok).toBe(true);
    const res = craft(pool, 'recipe_test_gated', baseOpts(inv, { skills: rankStub(2) }));
    expect(res.ok).toBe(true);
    expect(res.granted).toEqual({ itemId: 'mat_ore', count: 1 });
  });

  it('omitted skills fail closed at rank 0', () => {
    const inv = new Inventory(allDefs());
    const v = checkCraft([gatedRecipe('smithing', 2)], 'recipe_test_gated', baseOpts(inv));
    expect(v.reason).toBe('missing-skill');
    expect(v.detail).toBe('Requires smithing rank 2 (you are rank 0).');
  });

  it('minSkillRank defaults to 1', () => {
    const inv = new Inventory(allDefs());
    const pool = [gatedRecipe('smithing')];
    expect(checkCraft(pool, 'recipe_test_gated', baseOpts(inv, { skills: rankStub(1) })).ok).toBe(true);
    expect(checkCraft(pool, 'recipe_test_gated', baseOpts(inv)).reason).toBe('missing-skill');
  });

  it('unknown skill ids fail closed (rank 0)', () => {
    const inv = new Inventory(allDefs());
    // the real SkillSystem reports rank 0 for unknown ids
    const sys = new SkillSystem(fakeEngine());
    const v = checkCraft([gatedRecipe('necromancy', 1)], 'recipe_test_gated', baseOpts(inv, { skills: sys }));
    expect(v.reason).toBe('missing-skill');
    expect(v.detail).toBe('Requires necromancy rank 1 (you are rank 0).');
  });

  it('check order: min-level still beats missing-skill', () => {
    const inv = new Inventory(allDefs());
    const pool = [{ ...gatedRecipe('smithing', 2), minLevel: 5 }];
    const v = checkCraft(pool, 'recipe_test_gated', baseOpts(inv, { playerLevel: 1, skills: rankStub(1) }));
    expect(v.reason).toBe('min-level');
  });

  it('ungated recipes are unaffected by absent skills', () => {
    const inv = new Inventory(allDefs());
    const pool = buildRecipePool(specWith(7));
    const plain = pool.find((r) => r.skillId === undefined);
    expect(plain).toBeDefined();
    const v = checkCraft(pool, plain!.id, baseOpts(inv, { stations: new Set() }));
    // no skill gate involved: fails only on station/ingredients, never missing-skill
    expect(v.reason).not.toBe('missing-skill');
  });

  it('catalog recipes carry skillId/minSkillRank through the seeded pool (deep copies)', () => {
    const pool = buildRecipePool(specWith(42));
    const gated = pool.filter((r) => r.skillId !== undefined);
    expect(gated.length).toBeGreaterThan(0);
    for (const r of gated) {
      expect(SKILL_IDS).toContain(r.skillId);
      expect(r.minSkillRank ?? 1).toBeGreaterThanOrEqual(1);
    }
    // deep-copy isolation: mutating the pool never touches the catalog
    const r0 = gated[0];
    const before = r0.minSkillRank;
    r0.minSkillRank = 99;
    const again = buildRecipePool(specWith(42)).find((r) => r.id === r0.id)!;
    expect(again.minSkillRank).toBe(before);
  });

  it('real catalog: iron_edge needs smithing 2, ember_tonic alchemy 2, alloy_greaves smithing 3', () => {
    const inv = new Inventory(allDefs());
    const pool = buildRecipePool(specWith(20261012));
    const byId = new Map(pool.map((r) => [r.id, r]));
    const iron = byId.get('recipe_iron_edge');
    if (iron) {
      expect([iron.skillId, iron.minSkillRank]).toEqual(['smithing', 2]);
      const v = checkCraft(pool, iron.id, baseOpts(inv, { playerLevel: 5, skills: rankStub(1), stations: new Set(STATION_IDS) }));
      expect(v.reason).toBe('missing-skill');
    }
    // every gated recipe in the pool is blocked at rank 0 skills-omitted
    for (const r of pool) {
      if (!r.skillId) continue;
      const v = checkCraft(pool, r.id, baseOpts(inv, { playerLevel: 99, stations: new Set(STATION_IDS) }));
      expect(v.reason).toBe('missing-skill');
    }
  });
});
