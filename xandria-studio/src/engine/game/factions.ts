/**
 * Factions-reputation wave: player-scoped faction standing.
 *
 * Design (all tuning in this one table — nothing scattered):
 *   - Standing is an integer in [-1000, 1000] per faction, starting at 0.
 *   - Tiers are derived from the highest threshold at or below the value:
 *       hostile [-1000], unfriendly [-300], neutral [-50],
 *       friendly [250], honored [600], exalted [900].
 *   - Factions are derived from content that already exists — no new
 *     enemies or vendors: each enemy kind and each vendor id maps to one
 *     faction (tables below). Unknown kinds / vendor ids map to null and
 *     are ignored honestly, never fabricated.
 *   - Observe-only hooks (no contract changes): kills, quest turn-ins and
 *     vendor trades adjust standing through the methods below; the
 *     blueprints call them from the existing onDeath / turnIn / shop
 *     paths. Deltas are fixed integers, never RNG:
 *       kill: -10 per mob, -50 per boss
 *       trade: +5 per buy, +3 per sell (per transaction, not per unit)
 *       quest turn-in: the quest def's standingReward when present,
 *         otherwise +20 to 'freeholds' (the villager/setler faction —
 *         story and side quests are villager quests).
 *   - Vendor pricing (wired in ShopPanel, AFTER every existing modifier:
 *     seeded jitter and buyMult/sellMult already sit inside the stock
 *     price / unit sell price; the standing factor applies last):
 *       buyPrice  = max(1, round(stockPrice * (1 + adj)))
 *       sellPrice = max(1, floor(unitSellPrice * (1 - adj)))
 *     where adj comes from the tier table: hostile +0.25, unfriendly
 *     +0.10, neutral 0, friendly -0.10, honored -0.20, exalted -0.30.
 *     So friends buy cheaper and sell dearer; enemies pay a surcharge
 *     and get short-changed. At neutral (the default) both factors are
 *     exactly 1, so existing price assertions are untouched.
 *   - Player-scoped persistence (mirrors Wallet/QuestManager): the
 *     standings object is owned by the blueprint and NEVER registered in
 *     engine.portalEntities, so portal travel leaves it untouched by
 *     construction. portalSnapshot()/portalRestore() cover rebuild
 *     paths, and the blueprint additionally persists to localStorage
 *     (guarded, keyed by spec seed) so a full page reload keeps the
 *     standings for the same spec.
 *   - Determinism: standings are pure state — no RNG anywhere here.
 */

export const STANDING_MIN = -1000;
export const STANDING_MAX = 1000;

/** One standing tier: id + the lowest standing value that earns it. */
export interface StandingTier {
  id: 'hostile' | 'unfriendly' | 'neutral' | 'friendly' | 'honored' | 'exalted';
  /** display name */
  name: string;
  /** inclusive lower bound */
  min: number;
  /** additive vendor-price adjustment (see header for the exact math) */
  priceAdj: number;
}

export const STANDING_TIERS: readonly StandingTier[] = [
  { id: 'hostile', name: 'Hostile', min: -1000, priceAdj: 0.25 },
  { id: 'unfriendly', name: 'Unfriendly', min: -300, priceAdj: 0.1 },
  { id: 'neutral', name: 'Neutral', min: -50, priceAdj: 0 },
  { id: 'friendly', name: 'Friendly', min: 250, priceAdj: -0.1 },
  { id: 'honored', name: 'Honored', min: 600, priceAdj: -0.2 },
  { id: 'exalted', name: 'Exalted', min: 900, priceAdj: -0.3 },
];

/** Tier for a standing value: the highest tier whose min is <= value. */
export function tierForStanding(standing: number): StandingTier {
  const v = Number.isFinite(standing) ? standing : 0;
  let tier = STANDING_TIERS[0];
  for (const t of STANDING_TIERS) {
    if (v >= t.min) tier = t;
    else break;
  }
  return tier;
}

/** Clamp a standing value into [-1000, 1000] (floored, non-finite -> 0). */
export function clampStanding(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(STANDING_MIN, Math.min(STANDING_MAX, Math.floor(v)));
}

/** Multiplicative buy-price factor for a standing (1 at neutral). */
export function standingBuyFactor(standing: number): number {
  return 1 + tierForStanding(standing).priceAdj;
}

/** Multiplicative sell-price factor for a standing (1 at neutral). */
export function standingSellFactor(standing: number): number {
  return 1 - tierForStanding(standing).priceAdj;
}

/** Effective buy price: standing factor applied AFTER all existing modifiers. */
export function effectiveBuyPrice(stockPrice: number, standing: number): number {
  const base = Number.isFinite(stockPrice) ? stockPrice : 0;
  return Math.max(1, Math.round(base * standingBuyFactor(standing)));
}

/** Effective sell price: standing factor applied AFTER unitSellPrice. */
export function effectiveSellPrice(unitPrice: number, standing: number): number {
  const base = Number.isFinite(unitPrice) ? unitPrice : 0;
  return Math.max(1, Math.floor(base * standingSellFactor(standing)));
}

export interface FactionDef {
  id: string;
  name: string;
  blurb: string;
}

/**
 * The faction roster — derived from existing content:
 *   ironfangs  — the melee horde (walker, brute) + Kess's blade shop
 *   ember_order — the machines (drone, turret) + Vex's tonic shop
 *   freeholds  — the fast movers (flyer, racer) + Bram's armor shop,
 *                and the villager/settler faction quests reward by default
 */
export const FACTION_CATALOG: readonly FactionDef[] = [
  { id: 'ironfangs', name: 'Ironfangs', blurb: 'The blade-hungry horde.' },
  { id: 'ember_order', name: 'Ember Order', blurb: 'The machine cult of the warm rocks.' },
  { id: 'freeholds', name: 'Freeholds', blurb: 'Settlers, traders, and everyone just passing through.' },
];

export const FACTION_IDS = FACTION_CATALOG.map((f) => f.id);

/** Enemy kind -> faction. Unknown kinds -> null (ignored, never invented). */
export const ENEMY_KIND_FACTION: Readonly<Record<string, string>> = {
  walker: 'ironfangs',
  brute: 'ironfangs',
  drone: 'ember_order',
  turret: 'ember_order',
  flyer: 'freeholds',
  racer: 'freeholds',
};

export function factionOfEnemyKind(kind: string): string | null {
  return ENEMY_KIND_FACTION[kind] ?? null;
}

/** Vendor id -> faction. Unknown vendor ids -> null. */
export const VENDOR_FACTION: Readonly<Record<string, string>> = {
  vendor_ironfangs: 'ironfangs',
  vendor_ember_vial: 'ember_order',
  vendor_scrap_plate: 'freeholds',
};

export function factionOfVendor(vendorId: string): string | null {
  return VENDOR_FACTION[vendorId] ?? null;
}

/** Fixed deltas (integers, no RNG). */
export const KILL_STANDING_DELTA = -10;
export const BOSS_KILL_STANDING_DELTA = -50;
export const TRADE_BUY_STANDING_DELTA = 5;
export const TRADE_SELL_STANDING_DELTA = 3;
export const QUEST_DEFAULT_STANDING_DELTA = 20;
export const QUEST_DEFAULT_FACTION = 'freeholds';

export interface FactionStandingsSnapshot {
  version: 1;
  standings: Record<string, number>;
}

export interface FactionStandingsStorage {
  load: () => FactionStandingsSnapshot | null;
  save: (snap: FactionStandingsSnapshot) => void;
}

/**
 * Guarded localStorage adapter keyed by spec seed — the reload leg.
 * Any storage failure degrades to a no-op, never a crash (same stance
 * as Profile's guarded storage). In-memory fallback when localStorage
 * is absent (headless/unit tests).
 */
export function localStorageFactionsAdapter(seed: number): FactionStandingsStorage {
  const key = `xandria.factions.v1:${seed >>> 0}`;
  const mem = new Map<string, string>();
  const backend = (): { get(k: string): string | null; set(k: string, v: string): void } | null => {
    try {
      if (typeof localStorage === 'undefined') return null;
      return {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
      };
    } catch {
      return null;
    }
  };
  return {
    load: () => {
      try {
        const raw = backend()?.get(key) ?? mem.get(key) ?? null;
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FactionStandingsSnapshot>;
        if (parsed?.version !== 1 || !parsed.standings || typeof parsed.standings !== 'object') return null;
        return { version: 1, standings: parsed.standings };
      } catch {
        return null;
      }
    },
    save: (snap) => {
      try {
        const raw = JSON.stringify(snap);
        const b = backend();
        if (b) b.set(key, raw);
        else mem.set(key, raw);
      } catch {
        // storage failure is never fatal to gameplay
      }
    },
  };
}

/**
 * Player-scoped standings store. Pure data + an onChange hook (the
 * blueprint wires it to the panel, the quest-gate refresh, the shop
 * refresh and the localStorage save); no DOM, no RNG — unit-testable.
 */
export class FactionStandings {
  /** Fired after every successful adjustment / restore. Never throws. */
  onChange: (() => void) | null = null;

  private values = new Map<string, number>();

  constructor(private readonly storage: FactionStandingsStorage | null = null) {
    for (const f of FACTION_CATALOG) this.values.set(f.id, 0);
    if (storage) this.restore(storage.load());
  }

  /** Standing for a faction (0 for unknown ids — never NaN). */
  standingOf(factionId: string): number {
    return this.values.get(factionId) ?? 0;
  }

  /** Tier for a faction's current standing. */
  tierOf(factionId: string): StandingTier {
    return tierForStanding(this.standingOf(factionId));
  }

  /** Snapshot rows for the panel, in catalog order. */
  rows(): Array<{ id: string; name: string; blurb: string; standing: number; tier: StandingTier }> {
    return FACTION_CATALOG.map((f) => ({
      id: f.id,
      name: f.name,
      blurb: f.blurb,
      standing: this.standingOf(f.id),
      tier: this.tierOf(f.id),
    }));
  }

  /** Adjust one faction by a delta (clamped, unknown ids ignored). */
  adjust(factionId: string, delta: number): number {
    if (!this.values.has(factionId)) return 0;
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
      return this.standingOf(factionId);
    }
    const next = clampStanding(this.standingOf(factionId) + Math.floor(delta));
    this.values.set(factionId, next);
    this.emitChange();
    return next;
  }

  /** Enemy killed: -10 per mob, -50 per boss (unknown kinds ignored). */
  onKill(kind: string, isBoss: boolean): void {
    const faction = factionOfEnemyKind(kind);
    if (!faction) return;
    this.adjust(faction, isBoss ? BOSS_KILL_STANDING_DELTA : KILL_STANDING_DELTA);
  }

  /** Vendor trade: +5 per buy, +3 per sell (unknown vendors ignored). */
  onTrade(vendorId: string, kind: 'buy' | 'sell'): void {
    const faction = factionOfVendor(vendorId);
    if (!faction) return;
    this.adjust(faction, kind === 'buy' ? TRADE_BUY_STANDING_DELTA : TRADE_SELL_STANDING_DELTA);
  }

  /**
   * Quest turned in: the def's standingReward when present, otherwise
   * +20 to 'freeholds'. The def shape is structural (no import cycle
   * with quests.ts — the manager passes its def through).
   */
  onQuestComplete(def: {
    standingReward?: { factionId: string; amount: number } | undefined;
  }): void {
    const r = def.standingReward;
    if (r && this.values.has(r.factionId) && Number.isFinite(r.amount)) {
      this.adjust(r.factionId, r.amount);
      return;
    }
    this.adjust(QUEST_DEFAULT_FACTION, QUEST_DEFAULT_STANDING_DELTA);
  }

  /** Freeze for a portal snapshot / save. Pure data copy. */
  portalSnapshot(): FactionStandingsSnapshot {
    const standings: Record<string, number> = {};
    for (const [k, v] of this.values) standings[k] = v;
    return { version: 1, standings };
  }

  /** Persist the current snapshot through the storage adapter (if any). */
  save(): void {
    this.storage?.save(this.portalSnapshot());
  }

  /**
   * Restore a snapshot. Defensive: unknown ids dropped, corrupt values
   * clamp via clampStanding (which maps non-finite to 0), missing
   * factions stay at their current value when the snapshot omits them
   * only if this is a partial restore — a full snapshot resets omitted
   * catalog factions to 0 so a stale save cannot resurrect values.
   */
  restore(snap: FactionStandingsSnapshot | null | undefined): void {
    if (!snap || snap.version !== 1 || !snap.standings || typeof snap.standings !== 'object') return;
    for (const f of FACTION_CATALOG) {
      const v = (snap.standings as Record<string, unknown>)[f.id];
      this.values.set(f.id, v === undefined ? 0 : clampStanding(v));
    }
    this.emitChange();
  }

  private emitChange(): void {
    try { this.onChange?.(); } catch (e) { console.warn('[factions] onChange threw', e); }
  }
}
