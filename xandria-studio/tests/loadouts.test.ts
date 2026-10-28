/**
 * Gear loadout presets — unit tests.
 * - validateGearLoadouts: exactly 3 slots, repairs garbage, never throws.
 * - captureLoadout: only slot-correct equippable defs survive.
 * - applyGearLoadout: exact-set via equip/unequip, missing items skipped
 *   and reported, backpack-full blocks reported, in-combat refuses whole,
 *   set bonuses recompute through the real Inventory path, never throws.
 * - Profile: gearLoadouts migrate (old saves without the field get the
 *   default rack), per-slot isolation through the slots store.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { defaultSpec, validateSpec } from '@spec';
import { Inventory } from '../src/engine/game/items/Inventory';
import { lootGearDefs } from '../src/engine/game/loot';
import { craftedItemDefs } from '../src/engine/game/crafting';
import { setGearDefs } from '../src/engine/game/setBonuses';
import {
  MAX_LOADOUTS,
  defaultGearLoadouts,
  validateGearLoadouts,
  captureLoadout,
  applyGearLoadout,
  loadoutPieceCount,
  type GearLoadout,
} from '../src/engine/game/loadouts';
import {
  _setProfileStorage,
  defaultProfile,
  migrateProfile,
  loadProfile,
  saveProfile,
  getGearLoadouts,
  setGearLoadout,
  renameGearLoadout,
  clearGearLoadout,
  loadSlots,
  setActiveSlotId,
} from '../src/engine/game/Profile';

const defs = () => ({ ...lootGearDefs(), ...craftedItemDefs(), ...setGearDefs() });

function memoryStorage() {
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
  };
}

describe('validateGearLoadouts', () => {
  it('returns exactly MAX_LOADOUTS slots for garbage input, never throws', () => {
    expect(MAX_LOADOUTS).toBe(3);
    for (const bad of [undefined, null, 42, 'x', {}, []]) {
      const rack = validateGearLoadouts(bad);
      expect(rack).toHaveLength(3);
      expect(rack.map((r) => r.name)).toEqual(['Loadout 1', 'Loadout 2', 'Loadout 3']);
      expect(rack.every((r) => Object.keys(r.equipped).length === 0)).toBe(true);
    }
  });

  it('repairs: pads short racks, truncates long ones, sanitizes names, drops bad slots and duplicate ids', () => {
    const rack = validateGearLoadouts([
      { name: '  Raid   Set  ', equipped: { weapon: 'loot_ironfang_blade', head: 'loot_ironfang_blade', bogus: 'x', torso: 7 } },
      { name: '', equipped: { head: 'set_ironfang_helm' } },
      'junk',
      { name: 'Extra', equipped: {} },
    ]);
    expect(rack).toHaveLength(3);
    expect(rack[0].name).toBe('Raid Set');
    expect(rack[0].equipped).toEqual({ weapon: 'loot_ironfang_blade' });
    expect(rack[1].name).toBe('Loadout 2');
    expect(rack[1].equipped).toEqual({ head: 'set_ironfang_helm' });
    expect(rack[2].name).toBe('Loadout 3');
    expect(rack[2].equipped).toEqual({});
  });

  it('returns fresh copies (mutating the result cannot corrupt a stored rack)', () => {
    const rack = validateGearLoadouts([{ name: 'A', equipped: { weapon: 'x' } }]);
    rack[0].equipped.weapon = 'mutated';
    expect(validateGearLoadouts([{ name: 'A', equipped: { weapon: 'x' } }])[0].equipped.weapon).toBe('x');
  });
});

describe('captureLoadout', () => {
  it('keeps only defs that exist, are equippable, and belong in the slot', () => {
    const d = defs();
    const lo = captureLoadout('  My Set ', {
      weapon: 'loot_ironfang_blade',
      head: 'set_ironfang_helm',
      torso: 'loot_ironfang_blade', // wrong slot for the blade
      legs: 'no_such_item',
      accessory: 'mat_ember_shard', // not equippable / may not exist
    }, d);
    expect(lo.name).toBe('My Set');
    expect(lo.equipped.weapon).toBe('loot_ironfang_blade');
    expect(lo.equipped.head).toBe('set_ironfang_helm');
    expect(lo.equipped.torso).toBeUndefined();
    expect(lo.equipped.legs).toBeUndefined();
    expect(lo.equipped.accessory).toBeUndefined();
  });

  it('an empty equip set captures as an empty snapshot', () => {
    expect(captureLoadout('Empty', {}, defs()).equipped).toEqual({});
  });
});

describe('applyGearLoadout', () => {
  const IRONFANG: GearLoadout = {
    name: 'Ironfang',
    equipped: {
      weapon: 'loot_ironfang_blade',
      head: 'set_ironfang_helm',
      torso: 'loot_scorched_plate',
      legs: 'set_ironfang_greaves',
    },
  };

  function kitted(): Inventory {
    const inv = new Inventory(defs());
    for (const id of ['loot_ironfang_blade', 'set_ironfang_helm', 'loot_scorched_plate', 'set_ironfang_greaves']) {
      inv.add(id, 1);
    }
    return inv;
  }

  it('applies the exact set and set bonuses recompute through the real path', () => {
    const inv = kitted();
    const r = applyGearLoadout(inv, IRONFANG, defs(), () => false);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.blocked).toEqual([]);
    expect(inv.getAllEquipped()).toEqual(IRONFANG.equipped);
    // 4pc ironfang via the real Inventory recompute (no parallel path)
    expect(inv.setBonusStats()).toEqual({ defense: 3, damage: 8, maxHealth: 15 });
    expect(inv.effectiveStats().damage).toBe(9 + 8);
  });

  it('re-applying the same loadout is a no-op (all unchanged)', () => {
    const inv = kitted();
    applyGearLoadout(inv, IRONFANG, defs(), () => false);
    const r = applyGearLoadout(inv, IRONFANG, defs(), () => false);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.unchanged).toEqual(['weapon', 'head', 'torso', 'legs', 'accessory']);
  });

  it('exact-set: slots absent from the snapshot are unequipped', () => {
    const inv = kitted();
    applyGearLoadout(inv, IRONFANG, defs(), () => false);
    const partial: GearLoadout = { name: 'Blade only', equipped: { weapon: 'loot_ironfang_blade' } };
    const r = applyGearLoadout(inv, partial, defs(), () => false);
    expect(r.ok).toBe(true);
    expect(inv.getAllEquipped()).toEqual({ weapon: 'loot_ironfang_blade' });
    expect(inv.setBonusStats()).toEqual({});
  });

  it('missing items are skipped and reported; the rest still equips; never throws', () => {
    const inv = new Inventory(defs());
    inv.add('loot_ironfang_blade', 1);
    inv.add('set_ironfang_helm', 1);
    // plate + greaves never added -> missing
    const r = applyGearLoadout(inv, IRONFANG, defs(), () => false);
    expect(r.ok).toBe(true);
    expect(r.missing.map((m) => m.slot).sort()).toEqual(['legs', 'torso']);
    expect(inv.getEquipped('weapon')).toBe('loot_ironfang_blade');
    expect(inv.getEquipped('head')).toBe('set_ironfang_helm');
    expect(inv.getEquipped('torso')).toBeNull();
    // 2pc still fires
    expect(inv.setBonusStats()).toEqual({ defense: 3 });
  });

  it('unknown ids and wrong-slot ids in a hand-built snapshot are reported missing, never thrown', () => {
    const inv = kitted();
    const weird: GearLoadout = {
      name: 'Weird',
      equipped: { weapon: 'no_such_item', head: 'loot_ironfang_blade' },
    };
    const r = applyGearLoadout(inv, weird, defs(), () => false);
    expect(r.ok).toBe(true);
    expect(r.missing).toHaveLength(2);
    expect(inv.getAllEquipped()).toEqual({});
  });

  it('in-combat refuses the whole apply: nothing changes, reason in-combat', () => {
    const inv = kitted();
    inv.equip('loot_ironfang_blade');
    const before = inv.getAllEquipped();
    const r = applyGearLoadout(inv, IRONFANG, defs(), () => true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('in-combat');
    expect(r.applied).toEqual([]);
    expect(inv.getAllEquipped()).toEqual(before);
  });

  it('a throwing guard or inventory is reported, never propagated', () => {
    const throwing = {
      getEquipped: () => { throw new Error('boom'); },
      count: () => 1,
      equip: () => null,
      unequip: () => false,
    };
    const r = applyGearLoadout(throwing, IRONFANG, defs(), () => { throw new Error('guard boom'); });
    // guard throwing is treated as not-in-combat; inventory throwing blocks per slot
    expect(r.ok).toBe(true);
    expect(r.blocked).toHaveLength(5);
  });

  it('backpack-full unequip blocks the slot and reports it (nothing lost)', () => {
    const inv = kitted();
    applyGearLoadout(inv, IRONFANG, defs(), () => false);
    // Fill every backpack slot with a distinct filler stack so no room remains.
    const d = defs();
    const fillerIds = Object.keys(d).filter((id) => !Object.values(IRONFANG.equipped).includes(id));
    // Use add() until freeSlots is 0 (stacks of 1 for non-stackables fill fast;
    // loop defensively with a cap).
    let guard = 0;
    while (inv.freeSlots() > 0 && guard++ < 200) {
      const id = fillerIds[guard % fillerIds.length];
      inv.add(id, 999);
    }
    expect(inv.freeSlots()).toBe(0);
    const empty: GearLoadout = { name: 'Empty', equipped: {} };
    const r = applyGearLoadout(inv, empty, defs(), () => false);
    expect(r.blocked.length).toBeGreaterThan(0);
    // Nothing was lost: all four pieces are still equipped or in the backpack.
    for (const id of Object.values(IRONFANG.equipped)) {
      expect(inv.count(id)).toBe(1);
    }
  });

  it('loadoutPieceCount counts equipped snapshot entries', () => {
    expect(loadoutPieceCount(IRONFANG)).toBe(4);
    expect(loadoutPieceCount({ name: 'E', equipped: {} })).toBe(0);
    expect(defaultGearLoadouts()).toHaveLength(3);
  });
});

describe('Profile gearLoadouts', () => {
  afterEach(() => { _setProfileStorage(undefined); });

  it('old saves without gearLoadouts migrate to the default rack', () => {
    const p = migrateProfile({ version: 1, merit: 5 });
    expect(p.gearLoadouts).toHaveLength(3);
    expect(p.merit).toBe(5);
    const fresh = defaultProfile();
    expect(fresh.gearLoadouts.map((g) => g.name)).toEqual(['Loadout 1', 'Loadout 2', 'Loadout 3']);
  });

  it('set/rename/clear round-trip through the profile helpers', () => {
    const p = defaultProfile();
    const lo: GearLoadout = { name: 'Raid', equipped: { weapon: 'loot_ironfang_blade' } };
    expect(setGearLoadout(p, 0, lo)).toBe(true);
    expect(getGearLoadouts(p)[0]).toEqual(lo);
    expect(setGearLoadout(p, 9, lo)).toBe(false);
    expect(renameGearLoadout(p, 0, '  Boss  Set ')).toBe(true);
    expect(getGearLoadouts(p)[0].name).toBe('Boss Set');
    expect(renameGearLoadout(p, 0, '   ')).toBe(false);
    expect(getGearLoadouts(p)[0].name).toBe('Boss Set');
    expect(clearGearLoadout(p, 0)).toBe(true);
    expect(getGearLoadouts(p)[0]).toEqual({ name: 'Loadout 1', equipped: {} });
    expect(clearGearLoadout(p, 9)).toBe(false);
  });

  it('loadouts persist per save slot and survive a store reload (slot isolation)', () => {
    _setProfileStorage(memoryStorage());
    const lo: GearLoadout = { name: 'Slot1 Set', equipped: { weapon: 'loot_ironfang_blade' } };
    const p1 = loadProfile();
    setGearLoadout(p1, 0, lo);
    saveProfile(p1);
    // Switch to slot 2: its rack is untouched.
    expect(setActiveSlotId('slot-2')).toBe(true);
    expect(getGearLoadouts(loadProfile())[0].name).toBe('Loadout 1');
    // Back to slot 1: the loadout is still there (store round-trip).
    expect(setActiveSlotId('slot-1')).toBe(true);
    expect(getGearLoadouts(loadProfile())[0]).toEqual(lo);
    // A fresh loadSlots() read from the same backend agrees.
    expect(getGearLoadouts(loadSlots().slots[0].profile)[0]).toEqual(lo);
  });

  it('a loadout snapshot validates cleanly as a spec-adjacent shape (no spec contract invented)', () => {
    // The rack itself is profile data, not spec data — this pins that
    // storing it never requires a spec change: validateSpec on a
    // default spec is unaffected by profile contents.
    const s = defaultSpec(1);
    expect(validateSpec(s).errors).toEqual([]);
    expect(getGearLoadouts(migrateProfile({}))).toHaveLength(3);
  });
});
