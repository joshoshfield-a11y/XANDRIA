/**
 * loot.test.ts — items-expansion wave (enemy loot drops + tier-2 gear).
 *
 * - Loot defs (materials, gear, tier-2 outputs) all pass the real
 *   validateSpec; ensureLootItemDefs is idempotent, non-destructive, and
 *   never creates custom.items (preserves wireItems' null contract).
 * - LOOT_SALT is distinct from every other wave salt.
 * - rollLoot is deterministic: same (seed, kill script) -> identical
 *   drops; no Math.random/Date.now anywhere in the roll path.
 * - Rarity ladder: bosses always drop epic+ gear; legendary is
 *   boss-exclusive; drop counts stay inside table bounds.
 * - Tier-2 recipes ride the crafting pool and craft() end-to-end
 *   (tier-1 output + drop materials -> tier-2 gear, station + level
 *   gated); tier-2 weapons equip through the existing equip slots.
 */
import { describe, it, expect } from 'vitest';
import { Inventory } from '../src/engine/game/items/Inventory';
import { defaultSpec, validateSpec, type GameSpec, type ItemDef } from '../src/spec/schema';
import { Rng } from '../src/engine/core/Rng';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { STATION_SALT } from '../src/engine/game/stations';
import { NPC_SALT } from '../src/engine/game/Npc';
import {
  CRAFT_SALT,
  STATION_IDS,
  STATION_FORGE,
  STATION_WORKBENCH,
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
  LOOT_MATERIAL_IDS,
  LOOT_GEAR_IDS,
  LOOT_TIER2_OUTPUT_IDS,
  LOOT_CATALOG_RECIPES,
  MAT_EMBER_SHARD,
  MAT_BEAST_HIDE,
  MAT_CORE_FRAGMENT,
  buildLootRng,
  rollLoot,
  ensureLootItemDefs,
  lootItemDefs,
  lootMaterialDefs,
  lootGearDefs,
  lootTier2OutputDefs,
  type LootDrop,
} from '../src/engine/game/loot';
import { setGearDefs } from '../src/engine/game/setBonuses';

const KINDS = ['walker', 'brute', 'drone', 'flyer', 'turret'];

/** one deterministic "kill script": (kind, isBoss) pairs */
function killScript(seed: number, n: number): LootDrop[][] {
  const pick = new Rng(seed ^ 0x5eed);
  const rng = buildLootRng(seed);
  const out: LootDrop[][] = [];
  for (let i = 0; i < n; i++) {
    out.push(rollLoot(rng, pick.pick(KINDS), pick.chance(0.1)));
  }
  return out;
}

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

describe('loot defs', () => {
  it('every loot def passes the real validateSpec', () => {
    for (const [id, def] of Object.entries(lootItemDefs())) {
      const s = defaultSpec(1);
      s.custom = { ...(s.custom ?? {}), items: { defs: { [id]: def } } };
      const { errors } = validateSpec(s);
      expect(errors, id).toEqual([]);
    }
  });

  it('gear defs sit on the rarity ladder with equip slots', () => {
    const gear = lootGearDefs();
    const rarities = new Set(Object.values(gear).map((d) => d.rarity));
    // ladder coverage: uncommon through legendary on the drop tables
    for (const r of ['uncommon', 'rare', 'epic', 'legendary'] as const) {
      expect(rarities.has(r), r).toBe(true);
    }
    expect(gear.loot_ironfang_blade.slot).toBe('weapon');
    expect(gear.loot_void_edge.slot).toBe('weapon');
    expect(gear.loot_scorched_plate.slot).toBe('torso');
    expect(gear.loot_war_helm.slot).toBe('head');
    expect(gear.loot_star_aegis.slot).toBe('accessory');
    expect(gear.loot_surge_tonic.type).toBe('consumable');
  });

  it('LOOT_SALT is distinct from every other wave salt', () => {
    const salts = new Set([LOOT_SALT, ENEMY_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT, NPC_SALT]);
    expect(salts.size).toBe(6);
  });

  it('tier-2 recipe station ids match the crafting wave fixed contract', () => {
    // loot.ts repeats these as literals to avoid a module cycle;
    // this pins them against the real constants.
    const byId = new Map(LOOT_CATALOG_RECIPES.map((r) => [r.id, r.stationId]));
    expect(byId.get('recipe_ember_blade')).toBe(STATION_FORGE);
    expect(byId.get('recipe_scorched_harness')).toBe(STATION_WORKBENCH);
    expect(byId.get('recipe_surge_elixir')).toBe(STATION_ALCHEMY);
    for (const r of LOOT_CATALOG_RECIPES) {
      expect(STATION_IDS).toContain(r.stationId);
    }
  });

  it('ensureLootItemDefs is idempotent and non-destructive', () => {
    const s = defaultSpec(7);
    s.custom = { ...(s.custom ?? {}), items: { defs: { [MAT_EMBER_SHARD]: { name: 'Mine', type: 'material' } } } };
    ensureLootItemDefs(s);
    const first = JSON.stringify(s.custom?.items?.defs);
    // studio-authored def wins
    expect((s.custom?.items?.defs as Record<string, ItemDef>)[MAT_EMBER_SHARD].name).toBe('Mine');
    ensureLootItemDefs(s);
    expect(JSON.stringify(s.custom?.items?.defs)).toBe(first);
    // every id registered
    for (const id of [...LOOT_MATERIAL_IDS, ...LOOT_GEAR_IDS, ...LOOT_TIER2_OUTPUT_IDS]) {
      expect((s.custom?.items?.defs as Record<string, ItemDef>)[id]).toBeDefined();
    }
  });

  it('ensureLootItemDefs never creates custom.items (wireItems null contract)', () => {
    const s = defaultSpec(7);
    expect(s.custom?.items).toBeUndefined();
    ensureLootItemDefs(s);
    expect(s.custom?.items).toBeUndefined();
  });
});

describe('rollLoot determinism', () => {
  it('same (seed, kill script) -> identical drops', () => {
    expect(killScript(20261012, 40)).toEqual(killScript(20261012, 40));
  });

  it('different seeds -> different drop sequences', () => {
    const a = JSON.stringify(killScript(20261012, 20));
    const b = JSON.stringify(killScript(20261013, 20));
    expect(a).not.toBe(b);
  });

  it('Math.random perturbation cannot change the rolls', () => {
    const before = killScript(99, 25);
    for (let i = 0; i < 1000; i++) Math.random();
    expect(killScript(99, 25)).toEqual(before);
  });

  it('unknown kind falls back to the walker table', () => {
    const a = rollLoot(buildLootRng(5), 'bogus-kind', false);
    const b = rollLoot(buildLootRng(5), 'walker', false);
    expect(a).toEqual(b);
  });

  it('material drop counts stay inside table bounds', () => {
    for (const kind of KINDS) {
      const rng = buildLootRng(1234);
      for (let i = 0; i < 500; i++) {
        for (const d of rollLoot(rng, kind, false)) {
          expect(d.count).toBeGreaterThanOrEqual(1);
          expect(d.count).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe('rarity ladder', () => {
  it('every boss kill drops epic+ gear (first drop), never nothing', () => {
    for (const kind of KINDS) {
      const rng = buildLootRng(777);
      for (let i = 0; i < 200; i++) {
        const drops = rollLoot(rng, kind, true);
        expect(drops.length).toBeGreaterThanOrEqual(1);
        expect(['loot_void_edge', 'loot_star_aegis']).toContain(drops[0].itemId);
        expect(drops[0].count).toBe(1);
      }
    }
  });

  it('legendary never drops from non-boss kills', () => {
    for (const kind of KINDS) {
      const rng = buildLootRng(4242);
      for (let i = 0; i < 1000; i++) {
        for (const d of rollLoot(rng, kind, false)) {
          expect(d.itemId).not.toBe('loot_star_aegis');
        }
      }
    }
  });

  it('every dropped id has a registered def', () => {
    // Gear sets wave: set pieces roll off the same tables — the def
    // registry must include them (blueprints merge them via
    // ensureSetItemDefs).
    const all = { ...lootItemDefs(), ...setGearDefs() };
    for (const kind of KINDS) {
      const rng = buildLootRng(31337);
      for (let i = 0; i < 300; i++) {
        for (const d of [...rollLoot(rng, kind, false), ...rollLoot(rng, kind, true)]) {
          expect(all[d.itemId], d.itemId).toBeDefined();
        }
      }
    }
  });
});

describe('tier-2 recipes in the crafting pool', () => {
  it('the three tier-2 recipes ride the seeded pool', () => {
    const s = specWithItems(5);
    s.custom = { ...(s.custom ?? {}), crafting: { recipes: { poolSize: RECIPE_CATALOG_SIZE } } };
    const ids = buildRecipePool(s).map((r) => r.id);
    for (const r of LOOT_CATALOG_RECIPES) expect(ids).toContain(r.id);
  });

  it('tier-2 outputs are covered by craftedItemDefs', () => {
    const d = craftedItemDefs();
    for (const id of LOOT_TIER2_OUTPUT_IDS) expect(d[id], id).toBeDefined();
  });

  it('craft() forges a tier-2 weapon from a tier-1 output + drop materials', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_iron_edge', 1)).toBe(0);
    expect(inv.add(MAT_EMBER_SHARD, 3)).toBe(0);
    const s = specWithItems(11);
    s.custom = { ...(s.custom ?? {}), crafting: { recipes: { poolSize: RECIPE_CATALOG_SIZE } } };
    const pool = buildRecipePool(s);
    const o = {
      inventory: inv,
      defs: defs(),
      stations: new Set([STATION_FORGE]),
      playerLevel: 4,
    };
    expect(checkCraft(pool, 'recipe_ember_blade', o).ok).toBe(true);
    const res = craft(pool, 'recipe_ember_blade', o);
    expect(res.ok).toBe(true);
    expect(inv.count('craft_iron_edge')).toBe(0);
    expect(inv.count(MAT_EMBER_SHARD)).toBe(0);
    expect(inv.count('craft_ember_blade')).toBe(1);
  });

  it('tier-2 craft fails honestly when the drop material is missing', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_iron_edge', 1)).toBe(0);
    expect(inv.add(MAT_EMBER_SHARD, 2)).toBe(0); // one short
    const s = specWithItems(11);
    s.custom = { ...(s.custom ?? {}), crafting: { recipes: { poolSize: RECIPE_CATALOG_SIZE } } };
    const pool = buildRecipePool(s);
    const res = craft(pool, 'recipe_ember_blade', {
      inventory: inv,
      defs: defs(),
      stations: new Set([STATION_FORGE]),
      playerLevel: 4,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing-ingredients');
    expect(inv.count('craft_iron_edge')).toBe(1); // nothing consumed
    expect(inv.count(MAT_EMBER_SHARD)).toBe(2);
  });

  it('tier-2 weapon equips through the existing weapon slot', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_ember_blade', 1)).toBe(0);
    const r = inv.equip('craft_ember_blade');
    expect(r).not.toBeNull();
    expect(inv.getEquipped('weapon')).toBe('craft_ember_blade');
  });

  it('tier-2 armor equips through the existing torso slot', () => {
    const inv = new Inventory(defs());
    expect(inv.add('craft_scorched_harness', 1)).toBe(0);
    expect(inv.equip('craft_scorched_harness')).not.toBeNull();
    expect(inv.getEquipped('torso')).toBe('craft_scorched_harness');
  });
});
