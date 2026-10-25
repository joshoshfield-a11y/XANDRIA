/**
 * Gear enchantment wave — unit tests.
 * - Both new enchant-material defs validate through the real spec validator.
 * - The enchant table is sane: 6 unique enchants, valid slots, finite
 *   positive stats, positive costs, every cost id resolves to a real def
 *   (literal<->source sync pin for the mat_* literals).
 * - computeEnchantStats is exact and slot-gated: an enchant counts only
 *   when its item is equipped in an allowed slot.
 * - Inventory integration: apply consumes exactly the cost (nothing on
 *   failure), blocked cases return machine-readable reasons, remove
 *   refunds the full cost (restacking), enchant state survives
 *   serialize/deserialize.
 * - Stat order is pinned: effectiveStats() = equipped + set bonuses +
 *   enchants, each layer asserted separately.
 * - Loot tables are ADDITIVE ONLY: the base DROP_TABLES carry no
 *   enchant-material ids (addons live outside the base tables), the
 *   seeded stream stays deterministic (replicas agree; re-seed
 *   reproduces kill #0), enchant materials are reachable from brute /
 *   turret kills and from boss material rolls, and no legendary gear
 *   ever drops from a non-boss kill.
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec } from '@spec';
import { Inventory } from '../src/engine/game/items/Inventory';
import { lootItemDefs, lootGearDefs, buildLootRng, rollLoot, DROP_TABLES } from '../src/engine/game/loot';
import { craftedItemDefs } from '../src/engine/game/crafting';
import { setGearDefs } from '../src/engine/game/setBonuses';
import {
  ENCHANT_DEFS,
  ENCHANT_MATERIAL_IDS,
  ENCHANT_DROP_ADDONS,
  enchantDef,
  enchantMaterialDefs,
  computeEnchantStats,
  ensureEnchantItemDefs,
} from '../src/engine/game/enchantments';

const allDefs = () => ({
  ...lootItemDefs(),
  ...craftedItemDefs(),
  ...setGearDefs(),
  ...enchantMaterialDefs(),
});

describe('enchant material defs', () => {
  it('both new materials validate clean through the real spec validator', () => {
    const defs = enchantMaterialDefs();
    expect(Object.keys(defs).sort()).toEqual([...ENCHANT_MATERIAL_IDS].sort());
    for (const [id, def] of Object.entries(defs)) {
      const s = defaultSpec(1);
      s.custom = { ...(s.custom ?? {}), items: { defs: { [id]: def } } };
      const { errors } = validateSpec(s);
      expect(errors, id).toEqual([]);
    }
  });

  it('materials are stackable 999 materials', () => {
    for (const [id, def] of Object.entries(enchantMaterialDefs())) {
      expect(def.type, id).toBe('material');
      expect(def.stack, id).toBe(999);
    }
  });

  it('ensureEnchantItemDefs never creates custom.items, is idempotent, respects overrides', () => {
    const noItems = defaultSpec(1);
    ensureEnchantItemDefs(noItems);
    expect(noItems.custom?.items).toBeUndefined();
    const s = defaultSpec(1);
    s.custom = { ...(s.custom ?? {}), items: { defs: {} } };
    ensureEnchantItemDefs(s);
    ensureEnchantItemDefs(s);
    for (const id of ENCHANT_MATERIAL_IDS) {
      expect(s.custom?.items?.defs?.[id]).toBeDefined();
    }
    const override = s.custom!.items!.defs![ENCHANT_MATERIAL_IDS[0]];
    const s2 = defaultSpec(1);
    const sentinel = { ...override, name: 'Studio Override' };
    s2.custom = { ...(s2.custom ?? {}), items: { defs: { [ENCHANT_MATERIAL_IDS[0]]: sentinel } } };
    ensureEnchantItemDefs(s2);
    expect(s2.custom?.items?.defs?.[ENCHANT_MATERIAL_IDS[0]]?.name).toBe('Studio Override');
  });
});

describe('enchant table sanity', () => {
  it('six unique enchants, valid slots, finite positive stats, positive costs', () => {
    expect(ENCHANT_DEFS).toHaveLength(6);
    const ids = new Set<string>();
    const validSlots = new Set(['weapon', 'head', 'torso', 'legs', 'accessory']);
    for (const e of ENCHANT_DEFS) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(e.slots.length).toBeGreaterThan(0);
      for (const s of e.slots) expect(validSlots.has(s), `${e.id} slot ${s}`).toBe(true);
      expect(Object.keys(e.stats).length).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(e.stats)) {
        expect(typeof v === 'number' && Number.isFinite(v) && v > 0, `${e.id} ${k}`).toBe(true);
      }
      expect(e.cost.length).toBeGreaterThan(0);
      for (const c of e.cost) {
        expect(Number.isInteger(c.count) && c.count > 0, `${e.id} cost ${c.itemId}`).toBe(true);
      }
    }
  });

  it('every cost id resolves to a real def (literal<->source sync pin)', () => {
    const defs = allDefs();
    for (const e of ENCHANT_DEFS) {
      for (const c of e.cost) {
        expect(defs[c.itemId], `${e.id} cost ${c.itemId}`).toBeDefined();
      }
    }
  });

  it('enchantDef lookup resolves all six, undefined for unknown', () => {
    for (const e of ENCHANT_DEFS) expect(enchantDef(e.id)).toBe(e);
    expect(enchantDef('ench_nope')).toBeUndefined();
  });
});

describe('computeEnchantStats', () => {
  it('sums only enchants whose slot matches the equipped slot', () => {
    const enchants = new Map([
      ['loot_ironfang_blade', 'ench_sharp'],
      ['loot_scorched_plate', 'ench_warded'],
    ]);
    expect(computeEnchantStats({ weapon: 'loot_ironfang_blade', torso: 'loot_scorched_plate' }, enchants))
      .toEqual({ damage: 4, defense: 4 });
    // same enchant map, plate in the wrong slot for warded? warded allows
    // torso, so it still counts — but a weapon-only enchant on a torso
    // item must NOT count:
    const wrong = new Map([['loot_scorched_plate', 'ench_sharp']]);
    expect(computeEnchantStats({ torso: 'loot_scorched_plate' }, wrong)).toEqual({});
    expect(computeEnchantStats({}, enchants)).toEqual({});
    expect(computeEnchantStats({ weapon: 'loot_ironfang_blade' }, new Map())).toEqual({});
  });
});

describe('Inventory enchant apply/remove', () => {
  const setup = () => {
    const inv = new Inventory(allDefs());
    inv.add('loot_ironfang_blade', 1);
    inv.add('set_ironfang_helm', 1);
    inv.add('mat_enchant_dust', 10);
    inv.add('mat_star_essence', 10);
    inv.add('mat_ember_shard', 10);
    inv.add('mat_beast_hide', 10);
    return inv;
  };

  it('apply consumes exactly the cost and grants exact stats after set bonuses', () => {
    const inv = setup();
    expect(inv.equip('loot_ironfang_blade')).not.toBeNull();
    expect(inv.equip('set_ironfang_helm')).not.toBeNull();
    const r = inv.enchant('loot_ironfang_blade', 'ench_sharp');
    expect(r).toEqual({ ok: true });
    expect(inv.getEnchant('loot_ironfang_blade')).toBe('ench_sharp');
    expect(inv.count('mat_enchant_dust')).toBe(7); // 10 - 3
    // order pin: equipped (blade 9 dmg, helm 3 def) + set 2pc (+3 def) + enchant (+4 dmg)
    expect(inv.equippedStats()).toEqual({ damage: 9, defense: 3 });
    expect(inv.setBonusStats()).toEqual({ defense: 3 });
    expect(inv.enchantStats()).toEqual({ damage: 4 });
    expect(inv.effectiveStats()).toEqual({ damage: 13, defense: 6 });
  });

  it('blocked cases return reasons and consume nothing', () => {
    const inv = setup();
    inv.equip('loot_ironfang_blade');
    // missing materials
    const poor = new Inventory(allDefs());
    poor.add('loot_ironfang_blade', 1);
    poor.equip('loot_ironfang_blade');
    expect(poor.enchant('loot_ironfang_blade', 'ench_sharp')).toEqual({ ok: false, reason: 'missing-materials' });
    expect(poor.count('mat_enchant_dust')).toBe(0);
    expect(poor.getEnchant('loot_ironfang_blade')).toBeNull();
    // slot mismatch: warded is armor-only
    expect(inv.enchant('loot_ironfang_blade', 'ench_warded')).toEqual({ ok: false, reason: 'slot-mismatch' });
    // unknown enchant / unknown item / not equippable
    expect(inv.enchant('loot_ironfang_blade', 'ench_nope')).toEqual({ ok: false, reason: 'unknown-enchant' });
    expect(inv.enchant('nope_item', 'ench_sharp')).toEqual({ ok: false, reason: 'unknown-item' });
    inv.add('loot_surge_tonic', 1);
    expect(inv.enchant('loot_surge_tonic', 'ench_sharp')).toEqual({ ok: false, reason: 'not-equippable' });
    // already enchanted
    expect(inv.enchant('loot_ironfang_blade', 'ench_sharp')).toEqual({ ok: true });
    expect(inv.enchant('loot_ironfang_blade', 'ench_starlit')).toEqual({ ok: false, reason: 'already-enchanted' });
    expect(inv.getEnchant('loot_ironfang_blade')).toBe('ench_sharp');
    expect(inv.count('mat_enchant_dust')).toBe(7); // second apply consumed nothing
  });

  it('remove refunds the full cost, restacking into existing stacks', () => {
    const inv = setup();
    inv.equip('loot_ironfang_blade');
    expect(inv.enchant('loot_ironfang_blade', 'ench_starlit')).toEqual({ ok: true });
    expect(inv.count('mat_star_essence')).toBe(8);
    expect(inv.count('mat_enchant_dust')).toBe(8);
    expect(inv.enchantStats()).toEqual({ damage: 3, crit: 3 });
    const refund = inv.removeEnchant('loot_ironfang_blade');
    expect(refund).toEqual([
      { itemId: 'mat_star_essence', count: 2 },
      { itemId: 'mat_enchant_dust', count: 2 },
    ]);
    expect(inv.count('mat_star_essence')).toBe(10);
    expect(inv.count('mat_enchant_dust')).toBe(10);
    expect(inv.getEnchant('loot_ironfang_blade')).toBeNull();
    expect(inv.enchantStats()).toEqual({});
    expect(inv.effectiveStats()).toEqual({ damage: 9 });
    // removing again is a no-op
    expect(inv.removeEnchant('loot_ironfang_blade')).toEqual([]);
  });

  it('enchant state survives serialize/deserialize and restore', () => {
    const inv = setup();
    inv.equip('loot_ironfang_blade');
    inv.enchant('loot_ironfang_blade', 'ench_sharp');
    const json = inv.serialize();
    const back = Inventory.deserialize(allDefs(), json);
    expect(back.getEnchant('loot_ironfang_blade')).toBe('ench_sharp');
    back.equip('loot_ironfang_blade');
    expect(back.enchantStats()).toEqual({ damage: 4 });
    const inv2 = setup();
    inv2.restore(json);
    expect(inv2.getEnchant('loot_ironfang_blade')).toBe('ench_sharp');
    // corrupt enchant entries are skipped, never crash
    const parsed = JSON.parse(json) as { ench: unknown };
    parsed.ench = [['loot_ironfang_blade', 'ench_nope'], ['nope_item', 'ench_sharp']];
    const back2 = Inventory.deserialize(allDefs(), JSON.stringify(parsed));
    expect(back2.getEnchant('loot_ironfang_blade')).toBeNull();
  });

  it('unequip keeps the enchant; re-equip restores the bonus', () => {
    const inv = setup();
    inv.equip('loot_ironfang_blade');
    inv.enchant('loot_ironfang_blade', 'ench_sharp');
    expect(inv.unequip('weapon')).toBe(true);
    expect(inv.enchantStats()).toEqual({});
    expect(inv.getEnchant('loot_ironfang_blade')).toBe('ench_sharp');
    expect(inv.equip('loot_ironfang_blade')).not.toBeNull();
    expect(inv.enchantStats()).toEqual({ damage: 4 });
  });
});

describe('enchant drop addons', () => {
  it('base DROP_TABLES carry no enchant-material ids; addons carry only enchant materials', () => {
    const matIds = new Set<string>(ENCHANT_MATERIAL_IDS);
    for (const [kind, t] of Object.entries(DROP_TABLES)) {
      for (const e of [...t.materials, ...t.gear]) {
        expect(matIds.has(e.itemId), `${kind} base ${e.itemId}`).toBe(false);
      }
    }
    expect(Object.keys(ENCHANT_DROP_ADDONS).sort()).toEqual(['brute', 'turret']);
    for (const entries of Object.values(ENCHANT_DROP_ADDONS)) {
      for (const e of entries) expect(matIds.has(e.itemId), e.itemId).toBe(true);
    }
  });

  it('seeded stream is deterministic: replicas agree, re-seed reproduces kill #0', () => {
    const run = () => {
      const rng = buildLootRng(20261012);
      const out: string[][] = [];
      for (let i = 0; i < 200; i++) {
        out.push(rollLoot(rng, i % 2 === 0 ? 'brute' : 'turret', false).map((d) => `${d.itemId}x${d.count}`));
      }
      return out;
    };
    expect(run()).toEqual(run());
    const first = buildLootRng(20261012);
    const kill0 = rollLoot(first, 'brute', false).map((d) => d.itemId);
    const again = buildLootRng(20261012);
    expect(rollLoot(again, 'brute', false).map((d) => d.itemId)).toEqual(kill0);
  });

  it('enchant materials are reachable from brute/turret kills and boss material rolls', () => {
    const rng = buildLootRng(20261012);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const d of rollLoot(rng, i % 2 === 0 ? 'brute' : 'turret', false)) seen.add(d.itemId);
    }
    for (const id of ENCHANT_MATERIAL_IDS) expect(seen.has(id), id).toBe(true);
    const bossRng = buildLootRng(20261012);
    const bossSeen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const d of rollLoot(bossRng, 'brute', true)) bossSeen.add(d.itemId);
    }
    expect([...bossSeen].some((id) => (ENCHANT_MATERIAL_IDS as readonly string[]).includes(id))).toBe(true);
  });

  it('no legendary gear ever drops from a non-boss kill', () => {
    const rng = buildLootRng(20261012);
    const kinds = ['walker', 'brute', 'drone', 'flyer', 'turret'];
    for (let i = 0; i < 1000; i++) {
      for (const d of rollLoot(rng, kinds[i % kinds.length], false)) {
        expect(d.itemId).not.toBe('loot_star_aegis');
      }
    }
  });
});

describe('enchant defs through the loot/gear defs', () => {
  it('lootGearDefs still contains every gear id the enchant tests rely on', () => {
    const gear = lootGearDefs();
    for (const id of ['loot_ironfang_blade', 'loot_scorched_plate', 'loot_surge_tonic']) {
      expect(gear[id]).toBeDefined();
    }
  });
});
