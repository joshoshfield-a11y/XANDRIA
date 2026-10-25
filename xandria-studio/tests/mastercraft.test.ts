/**
 * mastercraft.test.ts — tier-3 "master" recipes gated at skill rank 3.
 *
 * - All four master defs pass the real validateSpec; stat bands sit
 *   honestly above tier-2 (weapon dmg 18 > Ember Blade 14; legs def 11 >
 *   Alloy Greaves 5; draught heal 150 > Surge Elixir 80; regalia
 *   +20 maxHealth/6 def > Scrap Buckler 2); rarity caps at epic so the
 *   loot ladder's legendary stays boss-exclusive.
 * - MASTER_SALT is distinct from every other wave salt.
 * - Master recipes (minSkillRank 3, incl. Alloy Greaves) always join the
 *   seeded pool — any seed, any poolSize — deduped, deep-copied; the
 *   seeded prefix property is preserved.
 * - No Math.random anywhere in the module (perturbation check).
 * - craft() end-to-end per skill: rank 3 crafts, rank 2 fails
 *   'missing-skill' with an honest detail; ingredients consumed atomically.
 */
import { describe, it, expect } from 'vitest';
import { Inventory } from '../src/engine/game/items/Inventory';
import { defaultSpec, validateSpec, type GameSpec, type ItemDef } from '../src/spec/schema';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { BOSS_SALT } from '../src/engine/game/bosses';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { STATION_SALT } from '../src/engine/game/stations';
import { SCALING_SALT } from '../src/engine/game/enemyScaling';
import { QUEST_SALT } from '../src/engine/game/quests';
import { SIDE_QUEST_SALT } from '../src/engine/game/sidequests';
import {
  CRAFT_SALT,
  STATION_FORGE,
  STATION_ALCHEMY,
  RECIPE_CATALOG_SIZE,
  buildRecipePool,
  materialItemDefs,
  craftedItemDefs,
  ensureCraftingItemDefs,
  checkCraft,
  craft,
} from '../src/engine/game/crafting';
import {
  LOOT_SALT,
  MAT_EMBER_SHARD,
  MAT_BEAST_HIDE,
  MAT_CORE_FRAGMENT,
  ensureLootItemDefs,
  lootItemDefs,
  lootTier2OutputDefs,
} from '../src/engine/game/loot';
import {
  MASTER_SALT,
  MASTER_TIER3_OUTPUT_IDS,
  MASTER_CATALOG_RECIPES,
  masterTier3OutputDefs,
} from '../src/engine/game/mastercraft';
import type { SkillsLike } from '../src/engine/game/skills';

function defs(): Record<string, ItemDef> {
  return { ...materialItemDefs(), ...craftedItemDefs(), ...lootItemDefs() };
}

function specWithItems(seed: number): GameSpec {
  const s = defaultSpec(seed);
  s.custom = { ...(s.custom ?? {}), items: { defs: {} } };
  ensureLootItemDefs(s);
  ensureCraftingItemDefs(s);
  return s;
}

/** SkillsLike stub at a fixed rank for every skill. */
function skillsAt(rank: number): SkillsLike {
  const names: Record<string, string> = {
    foraging: 'Foraging',
    smithing: 'Smithing',
    alchemy: 'Alchemy',
  };
  return {
    rankOf: () => rank,
    skillName: (id) => names[id] ?? id,
  };
}

describe('master defs', () => {
  it('every master def passes the real validateSpec', () => {
    for (const [id, def] of Object.entries(masterTier3OutputDefs())) {
      const s = defaultSpec(1);
      s.custom = { ...(s.custom ?? {}), items: { defs: { [id]: def } } };
      const { errors } = validateSpec(s);
      expect(errors, id).toEqual([]);
    }
  });

  it('MASTER_SALT is distinct from every other wave salt', () => {
    const salts = new Set([
      ENEMY_SALT, NPC_SALT, BOSS_SALT, GATHER_SALT, STATION_SALT,
      SCALING_SALT, QUEST_SALT, SIDE_QUEST_SALT, CRAFT_SALT, LOOT_SALT,
    ]);
    expect(salts.has(MASTER_SALT), 'MASTER_SALT collides').toBe(false);
  });

  it('no Math.random perturbation can change the catalog or defs', () => {
    const before = JSON.stringify({ r: MASTER_CATALOG_RECIPES, d: masterTier3OutputDefs() });
    for (let i = 0; i < 1000; i++) Math.random();
    const after = JSON.stringify({ r: MASTER_CATALOG_RECIPES, d: masterTier3OutputDefs() });
    expect(after).toBe(before);
  });
});

describe('master catalog content', () => {
  it('four master recipes, all minSkillRank 3, one per target skill', () => {
    expect(MASTER_CATALOG_RECIPES).toHaveLength(4);
    const bySkill: Record<string, number> = {};
    for (const r of MASTER_CATALOG_RECIPES) {
      expect(r.minSkillRank, r.id).toBe(3);
      expect(r.skillId, r.id).toBeDefined();
      bySkill[r.skillId as string] = (bySkill[r.skillId as string] ?? 0) + 1;
    }
    expect(bySkill).toEqual({ smithing: 2, alchemy: 1, foraging: 1 });
  });

  it('every ingredient and output id resolves to a real item def', () => {
    const d = defs();
    for (const r of MASTER_CATALOG_RECIPES) {
      expect(d[r.output.itemId], `${r.id} output`).toBeDefined();
      for (const ing of r.ingredients) {
        expect(d[ing.itemId], `${r.id} ingredient ${ing.itemId}`).toBeDefined();
        expect(ing.count).toBeGreaterThan(0);
      }
    }
  });

  it('every master recipe consumes a tier-2 (or tier-1) crafting output + loot materials', () => {
    const tier2 = new Set(['craft_ember_blade', 'craft_scorched_harness', 'craft_surge_elixir']);
    const lootMats = new Set([MAT_EMBER_SHARD, MAT_BEAST_HIDE, MAT_CORE_FRAGMENT]);
    for (const r of MASTER_CATALOG_RECIPES) {
      const ids = new Set(r.ingredients.map((i) => i.itemId));
      const hasCraftOutput = [...ids].some((id) => id.startsWith('craft_'));
      const hasLootMat = [...ids].some((id) => lootMats.has(id));
      expect(hasCraftOutput, `${r.id} consumes a crafting output`).toBe(true);
      expect(hasLootMat, `${r.id} consumes a loot material`).toBe(true);
      // at least one tier-2 input for the smithing/alchemy masters
      if (r.skillId !== 'foraging') {
        expect([...ids].some((id) => tier2.has(id)), `${r.id} consumes a tier-2 output`).toBe(true);
      }
    }
  });

  it('station gates use the crafting wave contract ids', () => {
    const byId = new Map(MASTER_CATALOG_RECIPES.map((r) => [r.id, r]));
    expect(byId.get('recipe_starfall_warbrand')!.stationId).toBe(STATION_FORGE);
    expect(byId.get('recipe_dragonscale_aegis')!.stationId).toBe(STATION_FORGE);
    expect(byId.get('recipe_primordial_draught')!.stationId).toBe(STATION_ALCHEMY);
    expect(byId.get('recipe_wildheart_regalia')!.stationId).toBeUndefined();
  });

  it('stat bands sit honestly above tier-2 (and the tier-2 defs still exist)', () => {
    const master = masterTier3OutputDefs();
    const t2 = lootTier2OutputDefs();
    const stat = (d: ItemDef, k: string): number =>
      (d.stats as Record<string, number> | undefined)?.[k] ?? 0;
    // Starfall Warbrand (18 dmg / 6 crit) > Ember Blade (14 / 3)
    expect(stat(master.craft_starfall_warbrand, 'damage'))
      .toBeGreaterThan(stat(t2.craft_ember_blade, 'damage'));
    expect(stat(master.craft_starfall_warbrand, 'crit'))
      .toBeGreaterThan(stat(t2.craft_ember_blade, 'crit'));
    // Dragonscale Aegis (11 def / +10 maxHealth) > Alloy Greaves (5 def)
    const greaves = craftedItemDefs().craft_alloy_greaves;
    expect(stat(master.craft_dragonscale_aegis, 'defense'))
      .toBeGreaterThan(stat(greaves, 'defense'));
    // Primordial Draught (heal 150) > Surge Elixir (heal 80)
    const heal = (d: ItemDef): number =>
      (d.behavior as { effect?: string; amount?: number } | undefined)?.amount ?? 0;
    expect(heal(master.craft_primordial_draught))
      .toBeGreaterThan(heal(t2.craft_surge_elixir));
    // Wildheart Regalia (+20 maxHealth / 6 def) > Scrap Buckler (2 def)
    const buckler = craftedItemDefs().craft_scrap_buckler;
    expect(stat(master.craft_wildheart_regalia, 'defense'))
      .toBeGreaterThan(stat(buckler, 'defense'));
  });

  it('rarity caps at epic — legendary stays boss-drop exclusive on the loot ladder', () => {
    for (const id of MASTER_TIER3_OUTPUT_IDS) {
      expect(masterTier3OutputDefs()[id].rarity, id).toBe('epic');
    }
  });

  it('master outputs ride craftedItemDefs so ensureCraftingItemDefs merges them', () => {
    const d = craftedItemDefs();
    for (const id of MASTER_TIER3_OUTPUT_IDS) expect(d[id], id).toBeDefined();
    const s = defaultSpec(3);
    ensureCraftingItemDefs(s);
    for (const id of MASTER_TIER3_OUTPUT_IDS) {
      expect(s.custom!.items!.defs![id], id).toBeDefined();
    }
  });
});

describe('master recipes in the seeded pool', () => {
  it('master recipes always join the pool — any seed, default poolSize', () => {
    for (const seed of [1, 42, 20261012, 777]) {
      const ids = buildRecipePool(specWithItems(seed)).map((r) => r.id);
      for (const r of MASTER_CATALOG_RECIPES) expect(ids, `seed ${seed}`).toContain(r.id);
    }
  });

  it('masters join even at poolSize 1, deduped and deep-copied', () => {
    const s = specWithItems(9);
    s.custom = { ...(s.custom ?? {}), crafting: { recipes: { poolSize: 1 } } };
    const pool = buildRecipePool(s);
    const ids = pool.map((r) => r.id);
    for (const r of MASTER_CATALOG_RECIPES) expect(ids).toContain(r.id);
    // Alloy Greaves is also minSkillRank 3 and always included
    expect(ids).toContain('recipe_alloy_greaves');
    expect(new Set(ids).size, 'no duplicate pool entries').toBe(ids.length);
    // deep copies: mutating the pool never leaks into the catalog
    pool.find((r) => r.id === 'recipe_starfall_warbrand')!.ingredients[0].count = 999;
    const again = buildRecipePool(s)
      .find((r) => r.id === 'recipe_starfall_warbrand')!.ingredients[0].count;
    expect(again).not.toBe(999);
  });

  it('the seeded prefix property is preserved (smaller pool = first N of larger)', () => {
    const a = specWithItems(99);
    a.custom = { ...(a.custom ?? {}), crafting: { recipes: { poolSize: 3 } } };
    const b = specWithItems(99);
    b.custom = { ...(b.custom ?? {}), crafting: { recipes: { poolSize: 6 } } };
    const small = buildRecipePool(a);
    const big = buildRecipePool(b);
    // the seeded portions are exact prefixes; masters trail both
    expect(big.slice(0, 3).map((r) => r.id))
      .toEqual(small.slice(0, 3).map((r) => r.id));
  });

  it('pool is still a pure function of the seed (perturb Math.random, identical ids)', () => {
    const s = specWithItems(4242);
    const before = buildRecipePool(s).map((r) => r.id).join(',');
    for (let i = 0; i < 1000; i++) Math.random();
    const after = buildRecipePool(s).map((r) => r.id).join(',');
    expect(after).toBe(before);
  });

  it('catalog grew by exactly 4 (prefix pins elsewhere stay honest)', () => {
    expect(MASTER_CATALOG_RECIPES).toHaveLength(4);
    // Gear sets wave: +1 additive master recipe (recipe_masterforged_crown)
    // appended after the master entries.
    expect(RECIPE_CATALOG_SIZE).toBe(21); // 10 base + 3 tier-2 + 4 master + 1 set + 3 deployables
  });
});

describe('master craft() end-to-end', () => {
  function poolWith(seed: number) {
    const s = specWithItems(seed);
    s.custom = { ...(s.custom ?? {}), crafting: { recipes: { poolSize: RECIPE_CATALOG_SIZE } } };
    return buildRecipePool(s);
  }

  it('smithing 3 crafts the Starfall Warbrand (tier-2 output + loot mats -> master)', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_ember_blade', 1)).toBe(0);
    expect(inv.add(MAT_CORE_FRAGMENT, 3)).toBe(0);
    expect(inv.add(MAT_EMBER_SHARD, 2)).toBe(0);
    const pool = poolWith(11);
    const opts = {
      inventory: inv,
      defs: defs(),
      stations: new Set([STATION_FORGE]),
      playerLevel: 6,
      skills: skillsAt(3),
    };
    expect(checkCraft(pool, 'recipe_starfall_warbrand', opts).ok).toBe(true);
    const res = craft(pool, 'recipe_starfall_warbrand', opts);
    expect(res.ok).toBe(true);
    expect(inv.count('craft_starfall_warbrand')).toBe(1);
    expect(inv.count('craft_ember_blade')).toBe(0);
    expect(inv.count(MAT_CORE_FRAGMENT)).toBe(0);
    expect(inv.count(MAT_EMBER_SHARD)).toBe(0);
  });

  it('smithing 2 is locked out of the warbrand with missing-skill + honest detail', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_ember_blade', 1)).toBe(0);
    expect(inv.add(MAT_CORE_FRAGMENT, 3)).toBe(0);
    expect(inv.add(MAT_EMBER_SHARD, 2)).toBe(0);
    const pool = poolWith(11);
    const res = craft(pool, 'recipe_starfall_warbrand', {
      inventory: inv,
      defs: defs(),
      stations: new Set([STATION_FORGE]),
      playerLevel: 6,
      skills: skillsAt(2),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing-skill');
    expect(res.detail).toContain('Smithing rank 3');
    expect(inv.count('craft_ember_blade')).toBe(1); // nothing consumed
  });

  it('alchemy 3 brews the Primordial Draught at the alchemy station', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_surge_elixir', 2)).toBe(0);
    expect(inv.add(MAT_CORE_FRAGMENT, 2)).toBe(0);
    expect(inv.add(MAT_EMBER_SHARD, 2)).toBe(0);
    const pool = poolWith(12);
    const res = craft(pool, 'recipe_primordial_draught', {
      inventory: inv,
      defs: defs(),
      stations: new Set([STATION_ALCHEMY]),
      playerLevel: 6,
      skills: skillsAt(3),
    });
    expect(res.ok).toBe(true);
    expect(inv.count('craft_primordial_draught')).toBe(1);
  });

  it('foraging 3 wildcrafts the Wildheart Regalia with no station', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_grip_wrap', 1)).toBe(0);
    expect(inv.add('craft_trail_mix', 3)).toBe(0);
    expect(inv.add(MAT_BEAST_HIDE, 4)).toBe(0);
    const pool = poolWith(13);
    const res = craft(pool, 'recipe_wildheart_regalia', {
      inventory: inv,
      defs: defs(),
      playerLevel: 6,
      skills: skillsAt(3),
    });
    expect(res.ok).toBe(true);
    expect(inv.count('craft_wildheart_regalia')).toBe(1);
  });

  it('the warbrand equips through the existing weapon slot', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_starfall_warbrand', 1)).toBe(0);
    expect(inv.equip('craft_starfall_warbrand')).not.toBeNull();
    expect(inv.getEquipped('weapon')).toBe('craft_starfall_warbrand');
  });

  it('the aegis equips through the existing legs slot', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_dragonscale_aegis', 1)).toBe(0);
    expect(inv.equip('craft_dragonscale_aegis')).not.toBeNull();
    expect(inv.getEquipped('legs')).toBe('craft_dragonscale_aegis');
  });
});
