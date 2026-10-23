/**
 * Gear set bonuses wave — unit tests.
 * - All seven new set-piece defs validate through the real spec validator.
 * - The set table is sane: 4 sets, 4 pieces each, 2+4 thresholds, no piece
 *   in two sets, no two pieces of one set sharing an equip slot (so 4pc is
 *   always achievable), every existing item id the table references
 *   resolves to a real def (literal<->source sync pin).
 * - computeSetBonuses is exact: 2pc -> threshold bonus, 4pc -> cumulative,
 *   partial/zero pieces -> no bonus, sets are independent.
 * - Inventory integration: setBonusStats()/effectiveStats() are additive
 *   and recompute on every equip/unequip.
 * - Loot tables are ADDITIVE ONLY: the base DROP_TABLES entries/weights
 *   match the items-expansion wave's table exactly (pinned), the addon
 *   merge adds only set_* ids, and the seeded stream stays deterministic
 *   (two replicas agree; portal re-seed reproduces kill #0).
 * - Rarity ladder preserved: legendary still never drops from non-boss
 *   kills (addon tables carry no legendary entries).
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec } from '@spec';
import { Inventory } from '../src/engine/game/items/Inventory';
import { lootItemDefs, lootGearDefs, buildLootRng, rollLoot, DROP_TABLES } from '../src/engine/game/loot';
import { craftedItemDefs, RECIPE_CATALOG_SIZE } from '../src/engine/game/crafting';
import { masterTier3OutputDefs } from '../src/engine/game/mastercraft';
import {
  GEAR_SETS,
  SET_PIECE_IDS,
  SET_DROP_ADDONS,
  SET_CATALOG_RECIPES,
  setGearDefs,
  computeSetBonuses,
  addItemStats,
} from '../src/engine/game/setBonuses';

const SET_IDS = new Set<string>(SET_PIECE_IDS);

/** Existing item ids the set table references (must resolve to real defs). */
const EXISTING_REFERENCES = [
  'loot_ironfang_blade',
  'loot_scorched_plate',
  'loot_void_edge',
  'loot_star_aegis',
  'craft_ember_blade',
  'craft_scorched_harness',
  'craft_starfall_warbrand',
  'craft_dragonscale_aegis',
  'craft_wildheart_regalia',
];

describe('set item defs', () => {
  it('all seven new set-piece defs validate clean through the real spec validator', () => {
    const defs = setGearDefs();
    expect(Object.keys(defs)).toHaveLength(7);
    for (const [id, def] of Object.entries(defs)) {
      const s = defaultSpec(1);
      s.custom = { ...(s.custom ?? {}), items: { defs: { [id]: def } } };
      const { errors } = validateSpec(s);
      expect(errors, id).toEqual([]);
    }
  });

  it('new pieces are equippable armor with stack 1', () => {
    for (const [id, def] of Object.entries(setGearDefs())) {
      expect(def.type, id).toBe('armor');
      expect(def.slot, id).toBeDefined();
      expect(def.stack, id).toBe(1);
    }
  });
});

describe('set table sanity', () => {
  it('four sets, four pieces each, two thresholds (2pc/4pc) ascending', () => {
    expect(GEAR_SETS).toHaveLength(4);
    for (const set of GEAR_SETS) {
      expect(set.pieces).toHaveLength(4);
      expect(set.thresholds.map((t) => t.pieces)).toEqual([2, 4]);
      for (const t of set.thresholds) {
        for (const [k, v] of Object.entries(t.bonus)) {
          expect(typeof v === 'number' && Number.isFinite(v), `${set.setId} ${k}`).toBe(true);
        }
      }
    }
  });

  it('no piece belongs to two sets', () => {
    const seen = new Map<string, string>();
    for (const set of GEAR_SETS) {
      for (const id of set.pieces) {
        expect(seen.has(id), `${id} in ${set.setId} and ${seen.get(id)}`).toBe(false);
        seen.set(id, set.setId);
      }
    }
  });

  it('no two pieces of one set share an equip slot (4pc is always achievable)', () => {
    const defs = { ...lootGearDefs(), ...craftedItemDefs(), ...setGearDefs() };
    for (const set of GEAR_SETS) {
      const slots = set.pieces.map((id) => {
        const def = defs[id];
        expect(def, `${id} resolves`).toBeDefined();
        return def?.slot;
      });
      expect(new Set(slots).size, set.setId).toBe(4);
    }
  });

  it('every existing item id the table references resolves (literal <-> source sync)', () => {
    const defs = { ...lootItemDefs(), ...craftedItemDefs(), ...masterTier3OutputDefs() };
    for (const id of EXISTING_REFERENCES) {
      expect(defs[id], id).toBeDefined();
      expect(defs[id].slot, `${id} slot`).toBeDefined();
    }
  });

  it('new set-piece ids do not shadow pre-existing loot/master defs', () => {
    // The crown's def legitimately lands in craftedItemDefs() (recipe
    // validation) — check against the tables that predate this wave.
    const existing = new Set(Object.keys({ ...lootItemDefs(), ...masterTier3OutputDefs() }));
    for (const id of SET_PIECE_IDS) expect(existing.has(id), id).toBe(false);
  });
});

describe('computeSetBonuses', () => {
  const IRON = GEAR_SETS[0];
  const eq = (ids: readonly string[]) => {
    const m: Record<string, string> = {};
    const defs = { ...lootGearDefs(), ...craftedItemDefs(), ...setGearDefs() };
    for (const id of ids) m[defs[id].slot as string] = id;
    return m;
  };

  it('zero pieces -> no bonus', () => {
    const r = computeSetBonuses({});
    expect(r.bonusStats).toEqual({});
    expect(r.sets.every((s) => s.active.length === 0)).toBe(true);
  });

  it('2 pieces -> exact 2pc threshold bonus', () => {
    const r = computeSetBonuses(eq([IRON.pieces[0], IRON.pieces[1]]));
    const s = r.sets[0];
    expect(s.equippedCount).toBe(2);
    expect(s.active.map((t) => t.pieces)).toEqual([2]);
    expect(s.bonus).toEqual({ defense: 3 });
    expect(r.bonusStats).toEqual({ defense: 3 });
  });

  it('4 pieces -> cumulative 2pc + 4pc bonus', () => {
    const r = computeSetBonuses(eq(IRON.pieces));
    const s = r.sets[0];
    expect(s.equippedCount).toBe(4);
    expect(s.active.map((t) => t.pieces)).toEqual([2, 4]);
    expect(s.bonus).toEqual({ defense: 3, damage: 8, maxHealth: 15 });
    expect(r.bonusStats).toEqual({ defense: 3, damage: 8, maxHealth: 15 });
  });

  it('3 pieces -> 2pc only (4pc not reached)', () => {
    const r = computeSetBonuses(eq([IRON.pieces[0], IRON.pieces[1], IRON.pieces[2]]));
    expect(r.sets[0].active.map((t) => t.pieces)).toEqual([2]);
    expect(r.sets[0].bonus).toEqual({ defense: 3 });
  });

  it('two sets active simultaneously, bonuses additive across sets', () => {
    // ironfang 2pc (defense 3) + emberforged 2pc (damage 6) on clash-free
    // slots (the two sets' weapons share the weapon slot, so mix helm +
    // plate from ironfang with blade + sabatons from emberforged).
    const EMBER = GEAR_SETS[1];
    const defs = { ...lootGearDefs(), ...craftedItemDefs(), ...setGearDefs() };
    const clashFree = eq([IRON.pieces[1], IRON.pieces[2]]);
    for (const id of [EMBER.pieces[0], EMBER.pieces[3]]) clashFree[defs[id].slot as string] = id;
    const r = computeSetBonuses(clashFree);
    expect(r.sets[0].equippedCount).toBe(2);
    expect(r.sets[1].equippedCount).toBe(2);
    expect(r.bonusStats).toEqual({ defense: 3, damage: 6 });
  });

  it('1 piece -> no thresholds fire', () => {
    const r = computeSetBonuses(eq([IRON.pieces[0]]));
    expect(r.sets[0].active).toHaveLength(0);
    expect(r.bonusStats).toEqual({});
  });
});

describe('inventory integration', () => {
  const defs = () => ({ ...lootGearDefs(), ...craftedItemDefs(), ...setGearDefs() });

  it('setBonusStats is zero with nothing equipped; effectiveStats == equippedStats', () => {
    const inv = new Inventory(defs());
    expect(inv.setBonusStats()).toEqual({});
    expect(inv.effectiveStats()).toEqual(inv.equippedStats());
  });

  it('recomputes on every equip change; unequip removes the bonus', () => {
    const inv = new Inventory(defs());
    inv.add('loot_ironfang_blade');
    inv.add('set_ironfang_helm');
    expect(inv.equip('loot_ironfang_blade')).not.toBeNull();
    expect(inv.equip('set_ironfang_helm')).not.toBeNull();
    // ironfang 2pc: +3 defense
    expect(inv.setBonusStats()).toEqual({ defense: 3 });
    const eff = inv.effectiveStats();
    expect(eff.defense).toBe((inv.equippedStats().defense ?? 0) + 3);
    // additive check: effective == equipped + setBonus key-by-key
    expect(eff).toEqual(addItemStats(inv.equippedStats(), inv.setBonusStats()));
    // unequip one piece -> 2pc threshold drops -> bonus gone
    expect(inv.unequip('weapon')).toBe(true);
    expect(inv.setBonusStats()).toEqual({});
    expect(inv.effectiveStats()).toEqual(inv.equippedStats());
  });

  it('4 pieces -> cumulative bonus flows into effectiveStats', () => {
    const inv = new Inventory(defs());
    for (const id of ['loot_ironfang_blade', 'set_ironfang_helm', 'loot_scorched_plate', 'set_ironfang_greaves']) {
      inv.add(id);
      expect(inv.equip(id), id).not.toBeNull();
    }
    expect(inv.setBonusStats()).toEqual({ defense: 3, damage: 8, maxHealth: 15 });
    const eff = inv.effectiveStats();
    // ironfang blade (9 dmg) + helm/greaves/plate defense (3+3+8) + 2pc/4pc bonuses
    expect(eff.damage).toBe(9 + 8);
    expect(eff.defense).toBe(14 + 3);
    expect(eff.maxHealth).toBe(15);
  });
});

describe('additive loot tables', () => {
  /** The items-expansion wave's base tables — pinned: additivity means these never change. */
  const BASE_TABLES = {
    walker: {
      materials: [
        { itemId: 'mat_ember_shard', weight: 40, min: 1, max: 2 },
        { itemId: 'mat_beast_hide', weight: 30, min: 1, max: 2 },
      ],
      gear: [
        { itemId: 'loot_surge_tonic', weight: 12, min: 1, max: 1 },
        { itemId: 'loot_ironfang_blade', weight: 6, min: 1, max: 1 },
        { itemId: 'loot_scorched_plate', weight: 4, min: 1, max: 1 },
      ],
      nothing: 20,
    },
    brute: {
      materials: [
        { itemId: 'mat_ember_shard', weight: 50, min: 1, max: 3 },
        { itemId: 'mat_beast_hide', weight: 35, min: 1, max: 2 },
      ],
      gear: [
        { itemId: 'loot_surge_tonic', weight: 10, min: 1, max: 1 },
        { itemId: 'loot_ironfang_blade', weight: 8, min: 1, max: 1 },
        { itemId: 'loot_war_helm', weight: 5, min: 1, max: 1 },
        { itemId: 'loot_void_edge', weight: 3, min: 1, max: 1 },
      ],
      nothing: 10,
    },
    drone: {
      materials: [{ itemId: 'mat_core_fragment', weight: 45, min: 1, max: 2 }],
      gear: [
        { itemId: 'loot_surge_tonic', weight: 10, min: 1, max: 1 },
        { itemId: 'loot_scorched_plate', weight: 5, min: 1, max: 1 },
      ],
      nothing: 25,
    },
    flyer: {
      materials: [{ itemId: 'mat_core_fragment', weight: 45, min: 1, max: 2 }],
      gear: [
        { itemId: 'loot_surge_tonic', weight: 10, min: 1, max: 1 },
        { itemId: 'loot_scorched_plate', weight: 5, min: 1, max: 1 },
      ],
      nothing: 25,
    },
    turret: {
      materials: [{ itemId: 'mat_core_fragment', weight: 55, min: 1, max: 3 }],
      gear: [
        { itemId: 'loot_surge_tonic', weight: 8, min: 1, max: 1 },
        { itemId: 'loot_war_helm', weight: 4, min: 1, max: 1 },
        { itemId: 'loot_void_edge', weight: 4, min: 1, max: 1 },
      ],
      nothing: 15,
    },
  } as const;

  it('base tables are byte-identical to the items-expansion wave (no edits)', () => {
    expect(JSON.parse(JSON.stringify(DROP_TABLES))).toEqual(JSON.parse(JSON.stringify(BASE_TABLES)));
  });

  it('addons reference only new set_* ids (never override a base entry)', () => {
    const baseIds = new Set(
      Object.values(DROP_TABLES).flatMap((t) => [...t.materials, ...t.gear].map((e) => e.itemId)),
    );
    for (const [kind, entries] of Object.entries(SET_DROP_ADDONS)) {
      expect(Object.keys(DROP_TABLES)).toContain(kind);
      for (const e of entries) {
        expect(SET_IDS.has(e.itemId), `${kind} addon ${e.itemId} is a new set piece`).toBe(true);
        expect(baseIds.has(e.itemId), `${e.itemId} not a base-table id`).toBe(false);
        expect(e.weight).toBeGreaterThan(0);
      }
    }
  });

  it('the seeded stream stays deterministic with addons (replicas agree)', () => {
    const script = (seed: number, n: number) => {
      const rng = buildLootRng(seed);
      const out: string[] = [];
      const kinds = ['walker', 'brute', 'drone', 'flyer', 'turret'];
      for (let i = 0; i < n; i++) {
        out.push(rollLoot(rng, kinds[i % kinds.length], false).map((d) => `${d.itemId}x${d.count}`).sort().join(','));
      }
      return out;
    };
    expect(script(20261012, 40)).toEqual(script(20261012, 40));
    // re-seed reproduces kill #0 (portal arrival semantics preserved)
    const a = script(99, 25);
    const b = script(99, 25);
    expect(a).toEqual(b);
    // set pieces are actually reachable in the stream
    const seen = new Set(script(20261012, 400).flatMap((s) => s.split(',').map((x) => x.split('x')[0])));
    const hit = [...SET_IDS].filter((id) => seen.has(id));
    expect(hit.length, `set pieces dropped in 400 seeded kills: ${hit.join(',')}`).toBeGreaterThan(0);
  });

  it('legendary still never drops from non-boss kills', () => {
    for (const kind of Object.keys(DROP_TABLES)) {
      const rng = buildLootRng(4242);
      for (let i = 0; i < 500; i++) {
        for (const d of rollLoot(rng, kind, false)) {
          expect(d.itemId).not.toBe('loot_star_aegis');
        }
      }
    }
  });
});

describe('master recipe (additive)', () => {
  it('exactly one set recipe, forge + smithing rank 3, output def exists', () => {
    expect(SET_CATALOG_RECIPES).toHaveLength(1);
    const r = SET_CATALOG_RECIPES[0];
    expect(r.id).toBe('recipe_masterforged_crown');
    expect(r.stationId).toBe('station_forge');
    expect(r.skillId).toBe('smithing');
    expect(r.minSkillRank).toBe(3);
    expect(r.output.itemId).toBe('set_masterforged_crown');
    expect(craftedItemDefs()[r.output.itemId]).toBeDefined();
    // ingredients resolve to real defs (consistency the crafting tests check)
    const all = { ...craftedItemDefs(), ...lootItemDefs() };
    for (const ing of r.ingredients) expect(all[ing.itemId], ing.itemId).toBeDefined();
  });

  it('catalog grew by exactly one (no check-order or pool changes beyond the addition)', () => {
    // 10 base + 3 tier-2 + 4 master + 1 set = 18
    expect(RECIPE_CATALOG_SIZE).toBe(18);
  });
});
