/**
 * itemKit — coordinator-owned integration seam for the inventory wave.
 *
 * One call per on-foot blueprint: builds the Inventory, the ItemWorld (via
 * wireItems with the deluxe ItemModelForge), and the InventoryHUD; wires
 * pickup toasts, consumable behaviors, equip-rendering sync, and a defense
 * wrap on incoming damage. Returns null when the spec has no item tables.
 */
import * as THREE from 'three';
import type { Engine } from '../engine/Engine';
import { EQUIP_SLOTS, type EquipSlot, type GameSpec, type ItemDef } from '@spec';
import { Inventory } from '../engine/game/items/Inventory';
import { InventoryHUD, type InventorySellHooks, type InventorySalvageHooks } from '../engine/ui/InventoryHUD';
import { buildSetUiReport } from '../engine/game/setBonuses';
import { critStatsFor } from '../engine/game/crit';
import { applyGearLoadout, captureLoadout } from '../engine/game/loadouts';
import { clearSalvagedFromLoadouts } from '../engine/game/salvage';
import {
  loadProfile, saveProfile, getGearLoadouts, setGearLoadout,
  renameGearLoadout, clearGearLoadout,
} from '../engine/game/Profile';
import { wireItems } from '../engine/game/items/wireItems';
import { type ItemWorld } from '../engine/game/items/ItemWorld';
import { ItemModelForge } from '../engine/gfx/ItemModels';
import { equip as equipOnRig, unequip as unequipOnRig } from '../engine/gfx/EquipRig';
import { PlayerAvatar } from './common';

export class BlueprintItemKit {
  readonly inventory: Inventory;
  readonly itemWorld: ItemWorld;
  readonly hud: InventoryHUD;
  private readonly defs: Record<string, ItemDef>;
  private readonly lastEquipped = new Map<EquipSlot, string | null>();
  private readonly avatar: PlayerAvatar;
  private readonly engine: Engine;
  private readonly spec: GameSpec;
  private readonly disposers: Array<() => void> = [];
  private buffUntil = 0;
  private buffMult = 1;

  constructor(engine: Engine, spec: GameSpec, avatar: PlayerAvatar, opts?: { sell?: InventorySellHooks | null; smithingRank?: () => number; synergyCrit?: () => { chanceBonus: number; multiplierBonus: number }; salvageHooks?: InventorySalvageHooks | null }) {
    this.engine = engine;
    this.spec = spec;
    this.avatar = avatar;
    this.defs = spec.custom?.items?.defs ?? {};
    this.inventory = new Inventory(this.defs);
    const world = wireItems(engine, spec, this.inventory, ItemModelForge);
    if (!world) throw new Error('[itemKit] wireItems returned null despite custom.items');
    this.itemWorld = world;
    // Gear sets wave: the inventory HUD's SET BONUSES section reads live
    // set state from the inventory (owned + equipped pieces, active
    // thresholds) — recomputed on every refresh().
    this.hud = new InventoryHUD(engine.container, this.inventory, {
      input: engine.input,
      sell: opts?.sell ?? null,
      // Gear-salvage wave: loadout-clearing hook, wired now that the
      // loadout-presets wave has merged (REPORT loadout rule).
      salvageHooks: {
        clearFromLoadouts: (itemId) => {
          const p = loadProfile();
          if (clearSalvagedFromLoadouts(p.gearLoadouts, itemId)) saveProfile(p);
        },
      },
      setReport: () => buildSetUiReport(this.inventory),
      // CRIT-SYSTEM: the inventory panel's CRIT STATS section reads live
      // equipped-weapon tier + smithing rank through this resolver.
      // SKILL-SYNERGIES: synergy crit bonuses ride the same resolver so
      // the displayed stats always match the rolls' math.
      critReport: () => critStatsFor({
        tier: this.equippedWeaponRarity(),
        skillRank: opts?.smithingRank?.() ?? 0,
        synergyChanceBonus: opts?.synergyCrit?.().chanceBonus ?? 0,
        synergyMultiplierBonus: opts?.synergyCrit?.().multiplierBonus ?? 0,
      }),
      // Loadout-presets wave: the LOADOUTS section reads/writes the
      // active save slot's profile rack (persisted via saveProfile);
      // apply reuses equip/unequip through applyGearLoadout and is
      // refused while Engine.inCombat() reports combat.
      loadouts: {
        list: () => getGearLoadouts(loadProfile()),
        capture: (name) => captureLoadout(name, this.inventory.getAllEquipped(), this.defs),
        save: (index, loadout) => {
          const p = loadProfile();
          if (setGearLoadout(p, index, loadout)) saveProfile(p);
        },
        rename: (index, name) => {
          const p = loadProfile();
          const ok = renameGearLoadout(p, index, name);
          if (ok) saveProfile(p);
          return ok;
        },
        clear: (index) => {
          const p = loadProfile();
          if (clearGearLoadout(p, index)) saveProfile(p);
        },
        apply: (index) => {
          const loadout = getGearLoadouts(loadProfile())[index];
          if (!loadout) return { ok: false, reason: 'unknown-loadout', applied: [], unchanged: [], missing: [], blocked: [] };
          return applyGearLoadout(this.inventory, loadout, this.defs, () => this.engine.inCombat());
        },
        inCombat: () => this.engine.inCombat(),
      },
    });

    // single loot path: drops → magnet → onPickup → inventory.add (no double-count)
    const basePickup = world.onPickup;
    world.onPickup = (itemId, count) => {
      basePickup(itemId, count);
      this.hud.refresh();
      const def = this.defs[itemId];
      this.hud.toast(`+${count} ${def?.name ?? itemId}`);
    };

    this.inventory.onUseEffect = (def) => this.applyBehavior(def);

    // defense: equipped defense rating reduces incoming damage, capped at 60%.
    // Gear sets wave: effectiveStats() = equipped + active set bonuses.
    const baseDamage = avatar.damage.bind(avatar);
    avatar.damage = (amount: number, from?: THREE.Vector3) => {
      const reduction = Math.min(0.6, (this.inventory.effectiveStats().defense ?? 0) / 200);
      return baseDamage(amount * (1 - reduction), from);
    };

    // E: interact — via the Interactable contract (roadmap Priority 2).
    // Discovery (nearestEligible) + activation (activateInteractable) are the
    // exact seam the future InteractionSystem will own; the data shape stays.
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || this.hud.isOpen() || engine.state !== 'playing') return;
      const target = this.itemWorld.interactions.nearestEligible(avatar.ctrl.position);
      if (!target) return;
      const ids = this.itemWorld.activateInteractable(target.id) ?? [];
      this.hud.refresh();
      this.hud.toast(ids.length
        ? `Looted: ${ids.map((id) => this.defs[id]?.name ?? id).join(', ')}`
        : `${target.prompt} — nothing inside`);
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));

    // test hook: A's e2e spec looks for blueprint.itemWorld ?? engine.itemWorld
    (engine as unknown as Record<string, unknown>).itemWorld = world;
  }

  /**
   * CRIT-SYSTEM: rarity of the equipped weapon (null = none equipped).
   * The crit table reads this for the per-tier crit bonus; a missing
   * rarity field on the def defaults to common via the crit table.
   */
  equippedWeaponRarity(): import('@spec').ItemRarity | null {
    const id = this.inventory.getEquipped('weapon');
    if (!id) return null;
    return this.defs[id]?.rarity ?? null;
  }

  /** Outgoing damage type from the equipped weapon's enchant (elemental.ts). */
  outgoingDamageType(): import('../engine/game/elemental').DamageType {
    return this.inventory.outgoingDamageType();
  }

  /** Outgoing damage multiplier from equipped damage stat + active set bonuses + active buffs. */
  damageMult(): number {
    const dmg = this.inventory.effectiveStats().damage ?? 0;
    const buff = this.engine.time < this.buffUntil ? this.buffMult : 1;
    return (1 + dmg / 100) * buff;
  }

  private applyBehavior(def: ItemDef): void {
    const b = def.behavior;
    if (!b) return;
    if (b.effect === 'heal') this.avatar.heal(b.amount ?? 20);
    else if (b.effect === 'restore') this.avatar.heal((b.amount ?? 10) * 0.5);
    else if (b.effect === 'buff') {
      this.buffUntil = this.engine.time + (b.duration ?? 10);
      this.buffMult = 1 + (b.amount ?? 25) / 100;
    }
    this.hud.toast(`${def.name} used`);
    this.hud.refresh();
  }

  /** Per-frame: item world sim, HUD gamepad poll, equip-render sync. */
  update(dt: number): void {
    const p = this.avatar.ctrl.position;
    this.itemWorld.update(dt, p);
    this.hud.update();
    this.syncEquipped();
  }

  private syncEquipped(): void {
    const rig = this.avatar.ctrl.rig;
    if (!rig) return;
    for (const slot of EQUIP_SLOTS) {
      const id = this.inventory.getEquipped(slot);
      if (this.lastEquipped.get(slot) === id) continue;
      this.lastEquipped.set(slot, id);
      try {
        // pass spec so EquipRig can resolve voxel armor sets from item skins (art-direction pass)
        if (id && this.defs[id]) equipOnRig(rig, slot, this.defs[id], { spec: this.spec });
        else unequipOnRig(rig, slot);
      } catch (err) { console.warn(`[itemKit] equip sync failed for slot "${slot}"`, err); }
    }
    // animation post-pass: relaxed weapon-carry arm pose when a weapon is equipped
    this.avatar.ctrl.weaponCarry = !!this.inventory.getEquipped('weapon');
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.hud.dispose();
    this.itemWorld.dispose();
  }
}

/** Build the kit, or null when the spec has no `custom.items`. */
export function buildItemKit(
  engine: Engine,
  spec: GameSpec,
  avatar: PlayerAvatar,
  opts?: { sell?: InventorySellHooks | null; smithingRank?: () => number; synergyCrit?: () => { chanceBonus: number; multiplierBonus: number }; salvageHooks?: InventorySalvageHooks | null },
): BlueprintItemKit | null {
  if (!spec.custom?.items) return null;
  const kit = new BlueprintItemKit(engine, spec, avatar, opts);
  // Tutorial wave: let the observe-only tutorial manager poll equip slots.
  // Additive — the manager only reads getEquipped(); no behavior changes.
  engine.tutorial.setInventory(() => kit.inventory);
  return kit;
}
