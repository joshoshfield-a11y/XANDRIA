/**
 * ItemBuilder — code-first fluent API for authoring item definitions.
 * Produces the plain ItemDef object shape from src/spec/schema.ts
 * (commit 513fa6a); `.validate()` runs the REAL `validateSpec` validator
 * over a synthetic spec with the def in `custom.items.defs`, so a builder
 * that validates clean passes the same checks the Studio and generator use.
 *
 * Example:
 *   const sword = new ItemBuilder('ember_blade')
 *     .named('Ember Blade')
 *     .weapon('weapon')              // type=weapon, slot=weapon
 *     .stat('damage', 12)
 *     .rarity('rare')
 *     .skin('ember')
 *     .stackable(1)
 *     .value(250)
 *     .description('A blade that still remembers the forge.')
 *     .build();                      // ItemDef
 *
 * `.build()` never throws. `.validate()` returns the actual
 * `path: message` validator strings (empty = valid).
 */
import {
  ITEM_TYPES, EQUIP_SLOTS, ITEM_RARITIES, ITEM_STAT_KEYS,
  type ItemDef, type ItemType, type EquipSlot, type ItemRarity,
  type ItemStatKey, type ItemStats,
  defaultSpec, validateSpec,
} from '@spec';

const SYNTH_ID = '__item_builder__';

export class ItemBuilder {
  protected readonly id: string;
  protected def: ItemDef;
  /** Tracks whether the author picked a type — the constructor placeholder must never ship. */
  private typeChosen = false;

  constructor(id: string) {
    this.id = id;
    // Placeholder only to satisfy the type system; validate() rejects it when
    // no type setter (.type/.weapon/.armor/.consumable/.material/.key/.trinket) ran.
    this.def = { name: id, type: 'weapon' };
  }

  private choose(t: ItemType): this {
    this.typeChosen = true;
    this.def.type = t;
    return this;
  }

  /** Display name (≤ 48 chars, required). */
  named(name: string): this {
    this.def.name = name;
    return this;
  }

  /** Item kind: weapon|armor|consumable|material|key|trinket. */
  type(t: ItemType): this {
    return this.choose(t);
  }

  /** Equip slot — required for weapon/armor. */
  slot(s: EquipSlot): this {
    this.def.slot = s;
    return this;
  }

  /** Shorthand: type=weapon (+equip slot, default 'weapon'). */
  weapon(slot: EquipSlot = 'weapon'): this {
    this.choose('weapon');
    this.def.slot = slot;
    return this;
  }

  /** Shorthand: type=armor (+equip slot, default 'torso'). */
  armor(slot: EquipSlot = 'torso'): this {
    this.choose('armor');
    this.def.slot = slot;
    return this;
  }

  /** Shorthand: type=consumable. */
  consumable(): this {
    return this.choose('consumable');
  }

  /** Shorthand: type=material. */
  material(): this {
    return this.choose('material');
  }

  /** Shorthand: type=key. */
  key(): this {
    return this.choose('key');
  }

  /** Shorthand: type=trinket. */
  trinket(): this {
    return this.choose('trinket');
  }

  /** Rarity ladder (drives world-item glow color): common|uncommon|rare|epic|legendary. */
  rarity(r: ItemRarity): this {
    this.def.rarity = r;
    return this;
  }

  /** One additive equip stat (damage|defense|speed|maxHealth|crit|attackSpeed|luck), -1000..10000. */
  stat(key: ItemStatKey, value: number): this {
    this.def.stats = { ...(this.def.stats ?? {}), [key]: value };
    return this;
  }

  /** Bulk stats. */
  stats(s: ItemStats): this {
    this.def.stats = { ...(this.def.stats ?? {}), ...s };
    return this;
  }

  /** Consumable use-behavior: effect + optional amount + duration (buff seconds, 0 = instant). */
  behavior(effect: 'heal' | 'restore' | 'buff', amount?: number, duration?: number): this {
    this.def.behavior = { effect, ...(amount !== undefined ? { amount } : {}), ...(duration !== undefined ? { duration } : {}) };
    return this;
  }

  /** Item-skin id (built-in or custom.items.skins). Unknown ids are NOT resolved here — validated at spec time. */
  skin(skinId: string): this {
    this.def.skin = skinId;
    return this;
  }

  /** GLB/GLTF URL mesh override (https only; online-only, procedural fallback). */
  model(url: string): this {
    this.def.model = url;
    return this;
  }

  /** Max stack size, integer 1..999 (default 1). */
  stackable(n: number): this {
    this.def.stack = n;
    return this;
  }

  /** Coin/vendor value, ≥ 0. */
  value(n: number): this {
    this.def.value = n;
    return this;
  }

  /** Flavor text, ≤ 280 chars. */
  description(s: string): this {
    this.def.description = s;
    return this;
  }

  /** The finished def — plain JSON-serializable object. Never throws. */
  build(): ItemDef {
    const out: ItemDef = { ...this.def };
    if (out.stats) out.stats = { ...out.stats };
    if (out.behavior) out.behavior = { ...out.behavior };
    return out;
  }

  /**
   * Validate the built def with the real spec validator on a synthetic spec.
   * Returns `path: message` error strings (empty = valid).
   */
  validate(): string[] {
    const spec = defaultSpec(1);
    spec.custom = {
      ...(spec.custom ?? {}),
      items: { ...(spec.custom?.items ?? {}), defs: { [SYNTH_ID]: this.build() } },
    };
    const errors = validateSpec(spec).errors;
    if (!this.typeChosen) {
      errors.unshift(
        `custom.items.defs.${SYNTH_ID}.type: builder never chose a type — call .type(), .weapon(), .armor(), .consumable(), .material(), .key() or .trinket()`,
      );
    }
    return errors;
  }
}

export { ITEM_TYPES, EQUIP_SLOTS, ITEM_RARITIES, ITEM_STAT_KEYS };
export type { ItemType, EquipSlot, ItemRarity, ItemStatKey };
