/**
 * Vendor-economy wave: currency wallet + NPC vendor shops.
 *
 * CONTENT
 * - Player-scoped currency ("scrap"): a Wallet owned by the blueprint,
 *   never registered in engine.portalEntities, so it survives portal
 *   transitions by construction (same standing as Progression/Inventory/
 *   QuestManager — see engine/world/PortalState.ts). The portal snapshot
 *   also carries the balance (PortalParts.wallet) for blueprint-rebuild
 *   paths. Shop stock, by contrast, is MAP-LOCAL and deterministic: it
 *   regenerates identically per map visit from the vendor NPC's spawn seed
 *   (the gathering-nodes precedent — depleted state is not persisted
 *   across portals; sold-out stock restores on arrival).
 * - Data-driven vendor defs (VENDOR_CATALOG + spec.custom.vendors
 *   overrides): id, shop name, keeper name, stock pool (item ids),
 *   buy/sell pricing multipliers. Vendors ride the villager roster as
 *   NPCs with role 'merchant' + spec.vendorId — they register in
 *   engine.npcInteractions like any interactable (the prompt reads
 *   "Trade with <name>"), and the QuestTalkSession dispatches them to the
 *   shop panel instead of the quest dialogue (NPC behavior contracts are
 *   otherwise untouched).
 * - Seeded vendor stock: Rng((npcSpawnSeed ^ VENDOR_SALT ^ hash(vendorId)))
 *   — never engine.rng / Math.random / Date.now. Same (mapSeed, roster
 *   index) -> identical stock lists and prices. Prices derive from the
 *   item def's `value` (the items wave's fixed contract) times the
 *   vendor's buyMult; selling pays def.value * sellMult.
 * - Currency drops: a SEPARATE seeded stream off the loot stream —
 *   Rng(mapSeed ^ LOOT_SALT ^ CURRENCY_SALT) — so the items-expansion
 *   drop sequence (and its e2e replication) is byte-identical to before.
 *   Bosses always drop scrap; brutes ("elites") have a 40% chance of a
 *   larger chunk; other kinds a 15% chance of a small chunk.
 *
 * CONTRACTS (owned by this wave):
 * - VENDOR_SALT / CURRENCY_SALT are distinct from every other wave salt
 *   (pinned by unit test).
 * - resolveVendorDefs never mutates the catalog; Studio overrides win
 *   per-field; unknown/empty stock pools fall back to the catalog pool.
 * - Wallet.spend is atomic: false leaves the balance untouched.
 * - buildVendorStock is pure; sold-out state lives in the ShopPanel's
 *   per-(vendor,spawnSeed) cache, never in this module.
 */
import type { GameSpec, ItemDef, NpcSpec, VendorDef, VendorsCustom } from '@spec';
import { Rng } from '../core/Rng';

// ---------------------------------------------------------------- salts

/**
 * Salt for the vendor-stock stream off the vendor NPC's spawn seed.
 * ('VECO' ~ 0xE507 — checked distinct from the other wave salts by unit
 * test.)
 */
export const VENDOR_SALT = 0xe507;

/**
 * Salt for the currency-drop stream off mapSeed. Keeps kill-currency
 * draws off the LOOT_SALT item stream (the items-expansion e2e
 * replicates the item stream exactly — an extra draw per kill would
 * silently shift every later kill's drops).
 */
export const CURRENCY_SALT = 0xc017;

/** Currency unit name (flavor): the settlement trades in scrap. */
export const CURRENCY_NAME = 'scrap';

/** Default buy multiplier over def.value (vendors sell at a markup). */
export const DEFAULT_BUY_MULT = 1.5;
/** Default sell multiplier over def.value (vendors buy low). */
export const DEFAULT_SELL_MULT = 0.3;

/** 32-bit FNV-1a: decorrelates the per-vendor stock stream from the NPC's own seed. */
export function hashStr32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- vendor defs

/**
 * Studio override surface (spec.custom.vendors) — the interface lives in
 * @spec/schema.ts (VendorsCustom) to keep the schema typed without a
 * module cycle.
 */

/**
 * The default vendor roster. Stock pools reference the fixed item-id
 * contracts of the items-expansion (loot_ and mat_ ids) and crafting
 * (craft_ ids) waves — every id is pinned by unit test against the real
 * def tables.
 */
export const VENDOR_CATALOG: readonly VendorDef[] = [
  {
    id: 'vendor_ironfangs',
    name: "Ironfang's Edge",
    keeper: 'Kess',
    tagline: 'Blades with a hungry edge. No refunds on cursed steel.',
    stockPool: [
      'loot_ironfang_blade',
      'loot_void_edge',
      'craft_ember_blade',
      'loot_surge_tonic',
    ],
    buyMult: 1.5,
    sellMult: 0.3,
    maxStock: 4,
  },
  {
    id: 'vendor_scrap_plate',
    name: 'Scrap & Plate',
    keeper: 'Bram',
    tagline: 'Armor that outlived its last three owners.',
    stockPool: [
      'loot_scorched_plate',
      'loot_war_helm',
      'craft_scorched_harness',
      'loot_star_aegis',
    ],
    buyMult: 1.5,
    sellMult: 0.3,
    maxStock: 4,
  },
  {
    id: 'vendor_ember_vial',
    name: 'Ember & Vial',
    keeper: 'Vex',
    tagline: 'Tonics, elixirs, and warm rocks. Mostly rocks.',
    stockPool: [
      'craft_ember_tonic',
      'craft_surge_elixir',
      'loot_surge_tonic',
      'mat_ember_shard',
      'mat_beast_hide',
      'mat_core_fragment',
    ],
    buyMult: 1.5,
    sellMult: 0.3,
    maxStock: 5,
  },
];

// (VendorDef / VendorsCustom interfaces live in @spec/schema.ts.)

/**
 * Resolve the live vendor roster: catalog + Studio overrides.
 * Defensive: unknown def ids are dropped, empty/invalid stock pools fall
 * back to the catalog pool, non-finite multipliers clamp to defaults.
 * Never mutates VENDOR_CATALOG. Returns a fresh array every call.
 */
export function resolveVendorDefs(spec: GameSpec): VendorDef[] {
  const custom = (spec.custom as { vendors?: VendorsCustom } | undefined)?.vendors;
  const disabled = new Set(custom?.disabledVendors ?? []);
  const out: VendorDef[] = [];
  for (const base of VENDOR_CATALOG) {
    if (disabled.has(base.id)) continue;
    const over = custom?.defs?.[base.id];
    if (!over) {
      out.push({ ...base, stockPool: [...base.stockPool] });
      continue;
    }
    const stockPool =
      Array.isArray(over.stockPool) && over.stockPool.length > 0
        ? [...over.stockPool]
        : [...base.stockPool];
    const buyMult = Number.isFinite(over.buyMult) && (over.buyMult as number) > 0
      ? (over.buyMult as number)
      : base.buyMult;
    const sellMult = Number.isFinite(over.sellMult) && (over.sellMult as number) >= 0
      ? (over.sellMult as number)
      : base.sellMult;
    const maxStock = Number.isFinite(over.maxStock) && (over.maxStock as number) > 0
      ? Math.floor(over.maxStock as number)
      : base.maxStock;
    out.push({
      id: base.id,
      name: typeof over.name === 'string' && over.name ? over.name : base.name,
      keeper: typeof over.keeper === 'string' && over.keeper ? over.keeper : base.keeper,
      tagline: typeof over.tagline === 'string' ? over.tagline : base.tagline,
      stockPool,
      buyMult,
      sellMult,
      maxStock,
    });
  }
  return out;
}

/**
 * NpcSpecs for the vendor roster: role 'merchant' + vendorId, appended to
 * the blueprint's villager specs. Vendors cycle AFTER the villagers so the
 * villager indices (and their seeded spawns) are untouched by this wave.
 */
export function buildVendorNpcSpecs(vendorDefs: readonly VendorDef[]): NpcSpec[] {
  return vendorDefs.map((v) => ({
    name: v.keeper,
    role: 'merchant',
    vendorId: v.id,
    count: 1,
  }) as NpcSpec);
}

// ---------------------------------------------------------------- stock

/** One stocked line: item, unit buy price, units left this map visit. */
export interface VendorStockEntry {
  itemId: string;
  price: number;
  stock: number;
}

/**
 * This map visit's stock for one vendor. Pure in (def, npcSpawnSeed,
 * defs): the stream is Rng((spawnSeed ^ VENDOR_SALT ^ hash(vendorId))),
 * so the same vendor on the same map always offers the same lines at
 * the same prices. Ids missing from defs (or with non-positive value)
 * are skipped honestly — never fabricated.
 */
export function buildVendorStock(
  def: VendorDef,
  npcSpawnSeed: number,
  defs: Record<string, ItemDef>,
): VendorStockEntry[] {
  const rng = new Rng((((npcSpawnSeed >>> 0) ^ VENDOR_SALT ^ hashStr32(def.id)) >>> 0));
  const pool = def.stockPool.filter((id) => {
    const d = defs[id];
    return d && Number.isFinite(d.value) && (d.value as number) > 0;
  });
  if (pool.length === 0) return [];
  // seeded subset (Fisher-Yates on a copy), capped at maxStock
  const order = [...pool];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lines = order.slice(0, Math.max(1, Math.min(def.maxStock, order.length)));
  return lines.map((itemId) => {
    const value = defs[itemId].value as number;
    // small seeded price jitter (±10%) so restocks feel alive, still deterministic
    const price = Math.max(1, Math.round(value * def.buyMult * rng.range(0.9, 1.1)));
    const stock = itemId.startsWith('mat_') ? rng.int(3, 8) : rng.int(1, 2);
    return { itemId, price, stock };
  });
}

/** Unit sell price for an item at a vendor: floor(def.value * sellMult), min 1. */
export function unitSellPrice(def: ItemDef, sellMult: number): number {
  const v = Number.isFinite(def.value) ? (def.value as number) : 0;
  return Math.max(1, Math.floor(v * sellMult));
}

/** True when an item can be sold (has a positive value). */
export function isSellable(def: ItemDef | undefined): boolean {
  return !!def && Number.isFinite(def.value) && (def.value as number) > 0;
}

// ---------------------------------------------------------------- currency drops

/** The seeded currency stream for one map: Rng of (mapSeed ^ LOOT_SALT ^ CURRENCY_SALT). */
export function buildCurrencyRng(mapSeed: number, lootSalt: number): Rng {
  return new Rng((((mapSeed >>> 0) ^ lootSalt ^ CURRENCY_SALT) >>> 0));
}

/**
 * Roll one kill's scrap payout. Always consumes the same draws per
 * (kind, isBoss) so an e2e replication stays in lockstep with the live
 * stream: bosses draw one int; others draw a chance roll and, on success,
 * one int. Brutes are the "elites" (40% / 12–30); everything else 15% /
 * 3–10; bosses 60–140 guaranteed.
 */
export function rollCurrencyDrops(rng: Rng, kind: string, isBoss: boolean): number {
  if (isBoss) return rng.int(60, 140);
  const elite = kind === 'brute';
  if (!rng.chance(elite ? 0.4 : 0.15)) return 0;
  return elite ? rng.int(12, 30) : rng.int(3, 10);
}

// ---------------------------------------------------------------- wallet

/**
 * Player-scoped currency wallet. Pure data + an onChange hook (the
 * blueprint wires it to HUD.setCurrency); no DOM, no RNG — unit-testable.
 * portalSnapshot()/portalRestore() mirror Progression's API for the
 * blueprint-rebuild path (live portal transitions never touch the object
 * at all — it's never in engine.portalEntities).
 */
export class Wallet {
  /** Fired after every successful add/spend/restore. Never throws. */
  onChange: (() => void) | null = null;

  private balance_: number;

  constructor(initial = 0) {
    this.balance_ = Math.max(0, Math.floor(initial));
  }

  /** Current balance (whole scrap). */
  get balance(): number {
    return this.balance_;
  }

  /** Add scrap (floored, negatives ignored). Returns the new balance. */
  add(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return this.balance_;
    this.balance_ += Math.floor(amount);
    this.emitChange();
    return this.balance_;
  }

  /**
   * Spend scrap. Atomic: returns false and changes nothing when the
   * balance is insufficient or the amount is invalid.
   */
  spend(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const n = Math.floor(amount);
    if (n > this.balance_) return false;
    this.balance_ -= n;
    this.emitChange();
    return true;
  }

  /** Freeze for a portal snapshot / save. Pure data copy. */
  portalSnapshot(): { balance: number } {
    return { balance: this.balance_ };
  }

  /**
   * Restore a portalSnapshot(). Defensive: corrupt values clamp to 0,
   * never wipe to NaN.
   */
  portalRestore(snap: { balance?: unknown } | null | undefined): void {
    const b = snap?.balance;
    this.balance_ = typeof b === 'number' && Number.isFinite(b) ? Math.max(0, Math.floor(b)) : 0;
    this.emitChange();
  }

  private emitChange(): void {
    try { this.onChange?.(); } catch (e) { console.warn('[economy] wallet onChange threw', e); }
  }
}
