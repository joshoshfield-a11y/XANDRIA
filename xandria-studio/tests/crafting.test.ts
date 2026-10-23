/**
 * crafting.test.ts — workstream A (recipes + schema + crafting engine).
 *
 * - Same GameSpec -> identical recipe pool (determinism, no Math.random).
 * - craft() transaction: success consumes + grants; honest failure paths
 *   (missing ingredients / missing station / minLevel / disabled / unknown
 *   ids); atomicity — no partial consume on failure, incl. the full-backpack
 *   rollback path.
 * - Material ids are the fixed B contract; every def passes validateSpec.
 */
import { describe, it, expect } from 'vitest';
import { Inventory, BACKPACK_SIZE } from '../src/engine/game/items/Inventory';
import { defaultSpec, validateSpec, type GameSpec } from '../src/spec/schema';
import {
  CRAFT_SALT,
  MAT_ORE,
  MAT_FIBER,
  MAT_SCRAP,
  MATERIAL_IDS,
  STATION_IDS,
  STATION_ANVIL,
  STATION_WORKBENCH,
  STATION_FORGE,
  STATION_ALCHEMY,
  DEFAULT_RECIPE_POOL_SIZE,
  RECIPE_CATALOG_SIZE,
  buildRecipePool,
  materialItemDefs,
  craftedItemDefs,
  ensureCraftingItemDefs,
  resolveCraftingEnabled,
  resolveGatheringDensity,
  checkCraft,
  craft,
  type CraftOptions,
} from '../src/engine/game/crafting';
import { lootItemDefs } from '../src/engine/game/loot';

function specWith(seed: number): GameSpec {
  const s = defaultSpec(seed);
  s.custom = { ...(s.custom ?? {}) };
  return s;
}

function specWithCrafting(seed: number, crafting: NonNullable<NonNullable<GameSpec['custom']>['crafting']>): GameSpec {
  const s = defaultSpec(seed);
  s.custom = { ...(s.custom ?? {}), crafting };
  return s;
}

function allDefs() {
  return { ...materialItemDefs(), ...craftedItemDefs() };
}

function freshInventory() {
  return new Inventory(allDefs());
}

function opts(inv: Inventory, extra?: Partial<CraftOptions>): CraftOptions {
  return { inventory: inv, defs: allDefs(), ...extra };
}

function give(inv: Inventory, id: string, n: number) {
  expect(inv.add(id, n)).toBe(0);
}

/**
 * Skills wave: several catalog recipes are now skill-gated. Tests whose
 * intent is a LATER gate (station, ingredients) pass max ranks so the
 * skill gate is not what fires; the missing-skill gate itself is covered
 * in tests/skills.test.ts.
 */
const skillsStub = (rank: number) => ({
  rankOf: (_id: string) => rank,
  skillName: (id: string) => id,
});

describe('recipe pool determinism', () => {
  it('same spec -> identical pool (ids, order, contents)', () => {
    const a = buildRecipePool(specWith(42));
    const b = buildRecipePool(specWith(42));
    expect(a).toEqual(b);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it('different seeds -> different pools', () => {
    const a = buildRecipePool(specWith(42)).map((r) => r.id).join(',');
    const b = buildRecipePool(specWith(1337)).map((r) => r.id).join(',');
    expect(a).not.toBe(b);
  });

  it('poolSize config is honored for the seeded subset; master recipes (minSkillRank 3) always join', () => {
    // 6 rank-3 masters (4 new + Alloy Greaves + the gear-sets wave's
    // Masterforged crown) ride along with every seeded subset, deduped —
    // so exact pool length is seed-dependent.
    const MASTERS = [
      'recipe_alloy_greaves',
      'recipe_starfall_warbrand',
      'recipe_dragonscale_aegis',
      'recipe_primordial_draught',
      'recipe_wildheart_regalia',
      'recipe_masterforged_crown',
    ];
    const expectPool = (rawSize: number, seededLen: number) => {
      const pool = buildRecipePool(specWithCrafting(7, { recipes: { poolSize: rawSize } }));
      const ids = pool.map((r) => r.id);
      const inSeed = MASTERS.filter((m) => ids.slice(0, seededLen).includes(m)).length;
      expect(pool, `poolSize ${rawSize}`).toHaveLength(seededLen + (MASTERS.length - inSeed));
      for (const m of MASTERS) expect(ids, m).toContain(m);
      expect(new Set(ids).size, 'deduped').toBe(ids.length);
    };
    expectPool(3, 3);
    expectPool(0, 1); // clamps to 1 seeded
    expectPool(NaN, DEFAULT_RECIPE_POOL_SIZE);
    expect(buildRecipePool(specWithCrafting(7, { recipes: { poolSize: 999 } }))).toHaveLength(RECIPE_CATALOG_SIZE);
  });

  it('pool is a prefix of the same seeded shuffle (smaller pool = first N of larger)', () => {
    const small = buildRecipePool(specWithCrafting(99, { recipes: { poolSize: 3 } }));
    const big = buildRecipePool(specWithCrafting(99, { recipes: { poolSize: 6 } }));
    // master-crafting wave: rank-3 masters ride along with every pool,
    // so the seeded portions (first N) are the exact prefixes
    expect(big.slice(0, 3).map((r) => r.id)).toEqual(small.slice(0, 3).map((r) => r.id));
  });

  it('returned recipes are deep copies — mutation never leaks into later builds', () => {
    const a = buildRecipePool(specWith(42));
    a[0].ingredients[0].count = 999;
    a[0].output.count = 999;
    const b = buildRecipePool(specWith(42));
    expect(b[0].ingredients[0].count).not.toBe(999);
    expect(b[0].output.count).not.toBe(999);
  });

  it('catalog uses the CRAFT_SALT stream, not Math.random', () => {
    // If Math.random leaked in, reseeding the global RNG could not change
    // anything — instead assert the stream is a pure function of the seed
    // by rebuilding after perturbing Math.random's state.
    const before = buildRecipePool(specWith(4242)).map((r) => r.id).join(',');
    for (let i = 0; i < 1000; i++) Math.random();
    const after = buildRecipePool(specWith(4242)).map((r) => r.id).join(',');
    expect(after).toBe(before);
    expect(CRAFT_SALT).toBe(0xc0a57);
  });
});

describe('material + crafted item defs', () => {
  it('material ids are the fixed B contract and typed material', () => {
    expect(MATERIAL_IDS).toEqual([MAT_ORE, MAT_FIBER, MAT_SCRAP]);
    expect(MAT_ORE).toBe('mat_ore');
    expect(MAT_FIBER).toBe('mat_fiber');
    expect(MAT_SCRAP).toBe('mat_scrap');
    const defs = materialItemDefs();
    for (const id of MATERIAL_IDS) {
      expect(defs[id].type).toBe('material');
      expect(defs[id].stack).toBe(999);
    }
  });

  it('every def passes the real validateSpec (same checks the Studio uses)', () => {
    for (const [id, def] of Object.entries({ ...materialItemDefs(), ...craftedItemDefs() })) {
      const s = defaultSpec(1);
      s.custom = { ...(s.custom ?? {}), items: { defs: { [id]: def } } };
      const { errors } = validateSpec(s);
      expect(errors, id).toEqual([]);
    }
  });

  it('crafted output defs cover every catalog output id', () => {
    const pool = buildRecipePool(specWithCrafting(5, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const defs = craftedItemDefs();
    for (const r of pool) {
      expect(defs[r.output.itemId]).toBeDefined();
      for (const ing of r.ingredients) {
        // items-expansion: tier-2 recipes consume tier-1 crafting outputs
        // (craft_*) and enemy-drop materials (mat_*) alongside the base
        // raw materials — all three tables are legitimate defs.
        expect(
          materialItemDefs()[ing.itemId] ??
            craftedItemDefs()[ing.itemId] ??
            lootItemDefs()[ing.itemId],
          ing.itemId,
        ).toBeDefined();
        expect(ing.count).toBeGreaterThan(0);
      }
      if (r.stationId !== undefined) expect(STATION_IDS).toContain(r.stationId);
      if (r.minLevel !== undefined) expect(r.minLevel).toBeGreaterThanOrEqual(0);
    }
  });

  it('station id constants are the fixed C contract', () => {
    expect([STATION_WORKBENCH, STATION_ANVIL, STATION_FORGE, STATION_ALCHEMY]).toEqual([
      'station_workbench',
      'station_anvil',
      'station_forge',
      'station_alchemy',
    ]);
  });
});

describe('ensureCraftingItemDefs', () => {
  it('merges materials + outputs into an empty spec, idempotent, never overwrites', () => {
    const s = specWith(1);
    ensureCraftingItemDefs(s);
    expect(s.custom?.items?.defs?.[MAT_ORE]?.type).toBe('material');
    expect(s.custom?.items?.defs?.['craft_field_kit']?.type).toBe('consumable');
    const before = s.custom!.items!.defs![MAT_ORE];
    ensureCraftingItemDefs(s);
    expect(s.custom!.items!.defs![MAT_ORE]).toBe(before);

    const s2 = specWith(1);
    s2.custom = { items: { defs: { [MAT_ORE]: { name: 'Custom Ore', type: 'material' } } } };
    ensureCraftingItemDefs(s2);
    expect(s2.custom.items!.defs![MAT_ORE].name).toBe('Custom Ore');
  });
});

describe('resolvers', () => {
  it('resolveCraftingEnabled defaults true', () => {
    expect(resolveCraftingEnabled(specWith(1))).toBe(true);
    expect(resolveCraftingEnabled(specWithCrafting(1, { enabled: false }))).toBe(false);
    expect(resolveCraftingEnabled(specWithCrafting(1, { enabled: true }))).toBe(true);
  });

  it('resolveGatheringDensity maps 0..100 slider to a 0..1 fraction', () => {
    expect(resolveGatheringDensity(specWith(1))).toBe(1);
    expect(resolveGatheringDensity(specWithCrafting(1, { gathering: { density: 50 } }))).toBe(0.5);
    expect(resolveGatheringDensity(specWithCrafting(1, { gathering: { density: 0 } }))).toBe(0);
    expect(resolveGatheringDensity(specWithCrafting(1, { gathering: { density: 150 } }))).toBe(1);
    expect(resolveGatheringDensity(specWithCrafting(1, { gathering: { density: -5 } }))).toBe(0);
    expect(resolveGatheringDensity(specWithCrafting(1, { gathering: { density: NaN } }))).toBe(1);
  });
});

describe('craft() transaction', () => {
  it('success consumes ingredients and grants the output (field kit, no station)', () => {
    const inv = freshInventory();
    give(inv, MAT_SCRAP, 2);
    give(inv, MAT_FIBER, 1);
    const pool = buildRecipePool(specWithCrafting(11, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const res = craft(pool, 'recipe_field_kit', opts(inv));
    expect(res.ok).toBe(true);
    expect(res.consumed).toEqual([
      { itemId: MAT_SCRAP, count: 2 },
      { itemId: MAT_FIBER, count: 1 },
    ]);
    expect(res.granted).toEqual({ itemId: 'craft_field_kit', count: 1 });
    expect(inv.count(MAT_SCRAP)).toBe(0);
    expect(inv.count(MAT_FIBER)).toBe(0);
    expect(inv.count('craft_field_kit')).toBe(1);
  });

  it('station-gated recipe fails honestly without the station; succeeds with it', () => {
    const inv = freshInventory();
    give(inv, MAT_ORE, 3);
    give(inv, MAT_SCRAP, 1);
    const pool = buildRecipePool(specWithCrafting(12, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const noStation = craft(pool, 'recipe_iron_edge', opts(inv, { playerLevel: 5, skills: skillsStub(3) }));
    expect(noStation.ok).toBe(false);
    expect(noStation.reason).toBe('missing-station');
    // nothing consumed on the failure path
    expect(inv.count(MAT_ORE)).toBe(3);
    expect(inv.count(MAT_SCRAP)).toBe(1);

    const withStation = craft(
      pool,
      'recipe_iron_edge',
      opts(inv, { playerLevel: 5, stations: new Set([STATION_ANVIL]), skills: skillsStub(3) }),
    );
    expect(withStation.ok).toBe(true);
    expect(inv.count('craft_iron_edge')).toBe(1);
    expect(inv.count(MAT_ORE)).toBe(0);
  });

  it('minLevel gate blocks below the level, passes at/above', () => {
    const pool = buildRecipePool(specWithCrafting(13, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const mk = () => {
      const inv = freshInventory();
      give(inv, MAT_ORE, 3);
      give(inv, MAT_SCRAP, 1);
      return inv;
    };
    const stations = new Set([STATION_ANVIL]);
    const low = craft(pool, 'recipe_iron_edge', opts(mk(), { playerLevel: 1, stations, skills: skillsStub(3) }));
    expect(low.ok).toBe(false);
    expect(low.reason).toBe('min-level');
    const exact = craft(pool, 'recipe_iron_edge', opts(mk(), { playerLevel: 2, stations, skills: skillsStub(3) }));
    expect(exact.ok).toBe(true);
  });

  it('missing ingredients fail with a per-ingredient shortfall and consume nothing', () => {
    const inv = freshInventory();
    give(inv, MAT_SCRAP, 1); // need 2 for the field kit
    give(inv, MAT_FIBER, 1);
    const pool = buildRecipePool(specWithCrafting(14, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const res = craft(pool, 'recipe_field_kit', opts(inv));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing-ingredients');
    expect(res.missing).toEqual([{ itemId: MAT_SCRAP, need: 2, have: 1 }]);
    expect(inv.count(MAT_SCRAP)).toBe(1);
    expect(inv.count(MAT_FIBER)).toBe(1);
    expect(inv.count('craft_field_kit')).toBe(0);
  });

  it('disabled crafting fails closed before anything is touched', () => {
    const inv = freshInventory();
    give(inv, MAT_SCRAP, 2);
    give(inv, MAT_FIBER, 1);
    const pool = buildRecipePool(specWithCrafting(15, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const res = craft(pool, 'recipe_field_kit', opts(inv, { enabled: false }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('crafting-disabled');
    expect(inv.count(MAT_SCRAP)).toBe(2);
  });

  it('unknown recipe id fails honestly', () => {
    const inv = freshInventory();
    const pool = buildRecipePool(specWith(16));
    const res = craft(pool, 'recipe_nope', opts(inv));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('recipe-not-found');
  });

  it('unknown output / ingredient defs fail before consuming', () => {
    const pool = buildRecipePool(specWithCrafting(17, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    // defs missing the output
    const inv1 = new Inventory({ ...materialItemDefs() });
    give(inv1, MAT_SCRAP, 2);
    give(inv1, MAT_FIBER, 1);
    const r1 = craft(pool, 'recipe_field_kit', { inventory: inv1, defs: { ...materialItemDefs() } });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe('unknown-output');
    expect(inv1.count(MAT_SCRAP)).toBe(2);
    // defs missing an ingredient
    const partial = allDefs();
    delete partial[MAT_SCRAP];
    const inv2 = new Inventory(partial);
    const r2 = craft(pool, 'recipe_field_kit', { inventory: inv2, defs: partial });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('unknown-ingredient');
  });

  it('ATOMICITY: full backpack rolls the consumed ingredients back in (no-room)', () => {
    const inv = freshInventory();
    // 22 filler slots (stack 1) + 5 scrap + 3 ore = full 24-slot backpack
    for (let i = 0; i < BACKPACK_SIZE - 2; i++) give(inv, 'craft_iron_edge', 1);
    give(inv, MAT_SCRAP, 5);
    give(inv, MAT_ORE, 3);
    expect(inv.freeSlots()).toBe(0);

    const pool = buildRecipePool(specWithCrafting(18, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    // whetstone: 1 scrap + 1 ore -> craft_whetstone (new item, no stack to top up)
    const res = craft(pool, 'recipe_whetstone', opts(inv));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-room');
    // rollback restored the ingredients exactly; no output granted
    expect(inv.count(MAT_SCRAP)).toBe(5);
    expect(inv.count(MAT_ORE)).toBe(3);
    expect(inv.count('craft_whetstone')).toBe(0);
    expect(inv.freeSlots()).toBe(0);
  });

  it('checkCraft is pure: same verdict, zero mutation', () => {
    const inv = freshInventory();
    give(inv, MAT_SCRAP, 2);
    give(inv, MAT_FIBER, 1);
    const pool = buildRecipePool(specWithCrafting(19, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const v = checkCraft(pool, 'recipe_field_kit', opts(inv));
    expect(v.ok).toBe(true);
    expect(inv.count(MAT_SCRAP)).toBe(2);
    expect(inv.count(MAT_FIBER)).toBe(1);
    expect(inv.count('craft_field_kit')).toBe(0);

    const inv2 = freshInventory();
    give(inv2, MAT_SCRAP, 1);
    const v2 = checkCraft(pool, 'recipe_field_kit', opts(inv2));
    expect(v2.ok).toBe(false);
    expect(v2.reason).toBe('missing-ingredients');
    expect(inv2.count(MAT_SCRAP)).toBe(1);
  });

  it('station predicate form works as well as a Set', () => {
    const inv = freshInventory();
    give(inv, MAT_SCRAP, 3);
    give(inv, MAT_ORE, 1);
    const pool = buildRecipePool(specWithCrafting(20, { recipes: { poolSize: RECIPE_CATALOG_SIZE } }));
    const res = craft(pool, 'recipe_scrap_buckler', opts(inv, { stations: (id) => id === STATION_WORKBENCH, skills: skillsStub(1) }));
    expect(res.ok).toBe(true);
    expect(inv.count('craft_scrap_buckler')).toBe(1);
  });
});
