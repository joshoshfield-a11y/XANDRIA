/**
 * Curated-quest-rewards wave: unit tests.
 * - curated tables cover all 16 quest template slugs; every referenced
 *   item id exists in the boot-ensured item defs
 * - questBonusItem is a pure function of (poolSeed, slug): deterministic,
 *   small, in the bonus pool
 * - buildQuestPool / buildSideQuestPool stamp the curated rewards +
 *   independently-replicated bonus into every def
 * - Studio rewardOverrides merge over the curated tables (items, xp,
 *   partial); unknown slugs are loud in the validator, silent in the merge
 * - validateQuestDef accepts/rejects the bonus line
 * - validateSpec rejects malformed custom.quests.rewardOverrides
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec, type GameSpec } from '../src/spec/schema';
import {
  CURATED_STORY_REWARDS,
  CURATED_SIDE_REWARDS,
  QUEST_REWARD_SLUGS,
  QUEST_REWARD_BONUS_SALT,
  BONUS_MATERIALS,
  questBonusItem,
  curatedQuestReward,
  allCuratedItemIds,
  validateQuestRewardOverrides,
} from '../src/engine/game/questRewards';
import { buildQuestPool, validateQuestDef, QUEST_SALT, QuestManager, type QuestDef } from '../src/engine/game/quests';
import { buildSideQuestPool, SIDE_QUEST_SALT } from '../src/engine/game/sidequests';
import { materialItemDefs, craftedItemDefs } from '../src/engine/game/crafting';
import { lootItemDefs } from '../src/engine/game/loot';

function specWith(seed: number, mut: (s: GameSpec) => void = () => {}): GameSpec {
  const spec = defaultSpec(seed) as GameSpec;
  mut(spec);
  return spec;
}

function slugOfQuestId(id: string): string {
  // 'quest_story_1_first_blood' -> 'first_blood'; 'quest_side_2_spare_parts' -> 'spare_parts'
  const m = id.match(/^quest_(?:story|side)_\d+_(.+)$/);
  if (!m) throw new Error(`cannot derive slug from quest id ${id}`);
  return m[1];
}

describe('curated reward tables', () => {
  it('cover all 16 quest template slugs (6 story + 10 side)', () => {
    expect(Object.keys(CURATED_STORY_REWARDS)).toHaveLength(6);
    expect(Object.keys(CURATED_SIDE_REWARDS)).toHaveLength(10);
    expect(QUEST_REWARD_SLUGS).toHaveLength(16);
    expect(new Set(QUEST_REWARD_SLUGS).size).toBe(16);
  });

  it('every curated item id has a boot-ensured item def', () => {
    // Blueprints ensure materialItemDefs (via crafting) + craftedItemDefs
    // (via ensureCraftingItemDefs) + lootItemDefs (via ensureLootItemDefs).
    const defs = {
      ...materialItemDefs(),
      ...craftedItemDefs(),
      ...lootItemDefs(),
    };
    const missing = allCuratedItemIds().filter((id) => !defs[id]);
    expect(missing).toEqual([]);
  });

  it('curated item ids include the theme-matched gear (weapon for first_blood etc.)', () => {
    expect(CURATED_STORY_REWARDS.first_blood.items[0].id).toBe('loot_ironfang_blade');
    expect(CURATED_STORY_REWARDS.big_game.items[0].id).toBe('loot_scorched_plate');
    expect(CURATED_STORY_REWARDS.the_maker.items.map((i) => i.id)).toContain('craft_iron_edge');
    expect(CURATED_STORY_REWARDS.the_forager.items.map((i) => i.id)).toContain('craft_fiber_weave');
  });

  it('xp is finite and non-negative everywhere; counts are positive ints', () => {
    for (const t of Object.values({ ...CURATED_STORY_REWARDS, ...CURATED_SIDE_REWARDS })) {
      expect(Number.isFinite(t.xp) && t.xp >= 0).toBe(true);
      expect(t.items.length).toBeGreaterThan(0);
      for (const i of t.items) {
        expect(typeof i.id).toBe('string');
        expect(Number.isInteger(i.count) && i.count >= 1).toBe(true);
      }
    }
  });
});

describe('questBonusItem', () => {
  it('is deterministic: same (seed, slug) -> identical bonus', () => {
    expect(questBonusItem(20261012, 'first_blood')).toEqual(questBonusItem(20261012, 'first_blood'));
    expect(questBonusItem(20261012, 'spare_parts')).toEqual(questBonusItem(20261012, 'spare_parts'));
  });

  it('differs per seed and per slug (independent stream)', () => {
    // count 1..2, id in the bonus pool; at least one of the 16 slugs x 2
    // seeds must differ (variance exists), and every line is small.
    let seenDifferent = false;
    for (const slug of QUEST_REWARD_SLUGS) {
      const a = questBonusItem(111, slug);
      const b = questBonusItem(222, slug);
      expect(BONUS_MATERIALS).toContain(a.id);
      expect([1, 2]).toContain(a.count);
      if (a.id !== b.id || a.count !== b.count) seenDifferent = true;
    }
    expect(seenDifferent).toBe(true);
  });

  it('BONUS_SALT is distinct from the pool salts', () => {
    expect(QUEST_REWARD_BONUS_SALT).not.toBe(QUEST_SALT);
    expect(QUEST_REWARD_BONUS_SALT).not.toBe(SIDE_QUEST_SALT);
  });
});

describe('buildQuestPool curated rewards', () => {
  it('every story quest carries its curated reward + independently-replicated bonus', () => {
    const seed = 20261012;
    const spec = specWith(seed);
    for (const def of buildQuestPool(spec)) {
      const slug = slugOfQuestId(def.id);
      const curated = CURATED_STORY_REWARDS[slug];
      expect(curated, `unknown story slug ${slug}`).toBeDefined();
      // exact curated content (xp + items)
      expect(def.rewards.xp).toBe(curated.xp);
      expect(def.rewards.items).toEqual(curated.items);
      // bonus line matches the INDEPENDENT replication (pure function of
      // (poolSeed, slug), not read back out of the def)
      expect(def.rewards.bonus).toEqual([questBonusItem(seed, slug)]);
    }
  });

  it('pool is still deterministic with the bonus line present', () => {
    expect(buildQuestPool(specWith(777))).toEqual(buildQuestPool(specWith(777)));
  });

  it('Studio overrides merge over the curated tables (partial merge)', () => {
    const spec = specWith(20261012, (s) => {
      s.custom = s.custom ?? {};
      s.custom.quests = {
        rewardOverrides: {
          first_blood: { items: [{ id: 'loot_void_edge', count: 1 }] },
          big_game: { xp: 999 },
        },
      };
    });
    const pool = buildQuestPool(spec);
    const fb = pool.find((d) => d.id.endsWith('_first_blood'));
    const bg = pool.find((d) => d.id.endsWith('_big_game'));
    if (fb) {
      expect(fb.rewards.items).toEqual([{ id: 'loot_void_edge', count: 1 }]);
      expect(fb.rewards.xp).toBe(CURATED_STORY_REWARDS.first_blood.xp); // xp untouched
      expect(fb.rewards.bonus).toEqual([questBonusItem(20261012, 'first_blood')]); // bonus NOT overridable
    }
    if (bg) {
      expect(bg.rewards.xp).toBe(999);
      expect(bg.rewards.items).toEqual(CURATED_STORY_REWARDS.big_game.items);
    }
  });

  it('overrides for unknown slugs do not break the pool (loud only in the validator)', () => {
    const spec = specWith(20261012, (s) => {
      s.custom = s.custom ?? {};
      s.custom.quests = { rewardOverrides: { not_a_quest: { xp: 5 } } };
    });
    expect(() => buildQuestPool(spec)).not.toThrow();
    expect(curatedQuestReward(spec, 'not_a_quest')).toBeNull();
    const errs = validateQuestRewardOverrides(spec);
    expect(errs.some((e) => e.includes('not_a_quest'))).toBe(true);
  });

  it('validateQuestDef accepts a valid bonus and rejects a bad one', () => {
    const base = {
      id: 'q', name: 'Q', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'kill' as const, desc: 'd', target: 'walker', count: 1 }],
    };
    expect(validateQuestDef({ ...base, rewards: { xp: 10, items: [], bonus: [{ id: 'mat_ore', count: 2 }] } })).toEqual([]);
    const errs = validateQuestDef({ ...base, rewards: { xp: 10, items: [], bonus: [{ id: '', count: 0 }] } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/bonus/);
  });
});

describe('buildSideQuestPool curated rewards', () => {
  it('every side quest carries its curated minor reward + independently-replicated bonus', () => {
    const seed = 20261012;
    const spec = specWith(seed);
    const pool = buildSideQuestPool(spec);
    expect(pool.length).toBeGreaterThan(0);
    for (const def of pool) {
      const slug = slugOfQuestId(def.id);
      const curated = CURATED_SIDE_REWARDS[slug];
      expect(curated, `unknown side slug ${slug}`).toBeDefined();
      expect(def.rewards.xp).toBe(curated.xp);
      expect(def.rewards.items).toEqual(curated.items);
      expect(def.rewards.bonus).toEqual([questBonusItem(seed, slug)]);
      // side rewards stay minor: below story xp bands
      expect(def.rewards.xp).toBeLessThanOrEqual(100);
    }
  });

  it('side pool is deterministic with curated rewards', () => {
    expect(buildSideQuestPool(specWith(4242))).toEqual(buildSideQuestPool(specWith(4242)));
  });

  it('Studio overrides apply to side quests too', () => {
    const spec = specWith(20261012, (s) => {
      s.custom = s.custom ?? {};
      s.custom.quests = { rewardOverrides: { spare_parts: { xp: 5, items: [{ id: 'mat_ore', count: 1 }] } } };
    });
    const q = buildSideQuestPool(spec).find((d) => d.id.endsWith('_spare_parts'));
    if (q) {
      expect(q.rewards.xp).toBe(5);
      expect(q.rewards.items).toEqual([{ id: 'mat_ore', count: 1 }]);
    }
  });
});

describe('schema validation: custom.quests.rewardOverrides', () => {
  it('rejects malformed overrides structurally', () => {
    const mk = (mut: (s: GameSpec) => void): GameSpec => specWith(1, mut);
    const bad1 = mk((s) => {
      s.custom = { quests: { rewardOverrides: { first_blood: { items: [{ id: 'loot_ironfang_blade', count: 0 }] } } } };
    });
    const r1 = validateSpec(bad1);
    expect(r1.errors.some((e: string) => e.includes('rewardOverrides.first_blood'))).toBe(true);

    const bad2 = mk((s) => {
      s.custom = { quests: { rewardOverrides: { first_blood: { xp: -1 } } } };
    });
    expect(validateSpec(bad2).errors.some((e: string) => e.includes('rewardOverrides.first_blood'))).toBe(true);

    const good = mk((s) => {
      s.custom = { quests: { rewardOverrides: { first_blood: { xp: 200, items: [{ id: 'loot_ironfang_blade', count: 1 }] } } } };
    });
    const rg = validateSpec(good);
    expect(rg.errors.filter((e: string) => e.includes('rewardOverrides'))).toEqual([]);
  });
});

describe('turnIn grants curated items + seeded bonus', () => {
  function makeManager(defs: QuestDef[], defTable: Record<string, unknown>) {
    const inv = new Map<string, number>();
    const xpCalls: number[] = [];
    const mgr = new QuestManager({
      defs,
      inventory: () => ({
        add: (id: string, n = 1) => { inv.set(id, (inv.get(id) ?? 0) + n); return 0; },
      }),
      defsTable: () => defTable as any,
      progression: { addXp: (n: number) => { xpCalls.push(n); return false; }, addXpEx: (n: number) => { xpCalls.push(n); return { leveled: false, gain: null }; } } as any,
      toast: () => {},
    });
    return { mgr, inv, xpCalls };
  }

  function driveToComplete(h: { mgr: QuestManager }, def: QuestDef): boolean {
    if (!h.mgr.accept(def.id)) return false;
    for (const o of def.objectives) {
      if (o.kind === 'kill') for (let i = 0; i < o.count; i++) h.mgr.onKill(o.target);
      else if (o.kind === 'gather') h.mgr.onHarvest(o.target === 'any' ? 'mat_ore' : o.target, o.count);
      else if (o.kind === 'craft') h.mgr.onCraft(o.target);
      else if (o.kind === 'talk') for (let i = 0; i < o.count; i++) h.mgr.onTalk('villager');
      else return false; // explore quests are completed in the e2e leg
    }
    return h.mgr.statusOf(def.id) === 'complete';
  }

  it('turn-in grants the curated item lines and the bonus line', () => {
    const spec = specWith(20261012);
    const pool = buildQuestPool(spec);
    // defsTable: every curated + bonus id resolves (boot-ensured defs)
    const table: Record<string, unknown> = {};
    for (const id of allCuratedItemIds()) table[id] = { id };
    const h = makeManager(pool, table);
    // chain: quest N unlocks after N-1 turns in; walk the line in order.
    // The inventory is SHARED across the chain, so assert per-turn-in
    // deltas (snapshot before, diff after).
    let covered = 0;
    for (const def of pool) {
      if (!driveToComplete(h, def)) continue; // explore quest — e2e covers it
      const before = new Map(h.inv);
      expect(h.mgr.turnIn(def.id)).toBe(true);
      const slug = slugOfQuestId(def.id);
      const curated = CURATED_STORY_REWARDS[slug];
      const delta = (id: string) => (h.inv.get(id) ?? 0) - (before.get(id) ?? 0);
      for (const line of curated.items) {
        expect(delta(line.id), `${def.id} curated ${line.id}`).toBe(line.count);
      }
      const bonus = questBonusItem(20261012, slug);
      expect(delta(bonus.id), `${def.id} bonus ${bonus.id}`).toBe(bonus.count);
      expect(h.xpCalls[h.xpCalls.length - 1], `${def.id} xp`).toBe(curated.xp);
      covered++;
    }
    expect(covered).toBeGreaterThan(0);
  });

  it('bonus line is skipped honestly when its def is missing (never grants blind)', () => {
    // Hand-made def (like the 'nope_missing' test): the bonus id has no
    // entry in the def table while the curated item does.
    const def: QuestDef = {
      id: 'q1', name: 'X', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'talk', desc: 'Talk', target: 'any', count: 1 }],
      rewards: {
        xp: 10,
        items: [{ id: 'mat_ore', count: 2 }],
        bonus: [{ id: 'mat_fiber', count: 1 }],
      },
    };
    const h = makeManager([def], { mat_ore: { id: 'mat_ore' } });
    expect(h.mgr.accept('q1')).toBe(true);
    h.mgr.onTalk('villager');
    expect(h.mgr.statusOf('q1')).toBe('complete');
    expect(h.mgr.turnIn('q1')).toBe(true);
    expect(h.inv.get('mat_ore')).toBe(2); // curated item landed
    expect(h.inv.get('mat_fiber') ?? 0).toBe(0); // bonus skipped — no def
  });
});
