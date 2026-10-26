/**
 * UPGRADE LOOP (fast-travel phase): discovered-portal registry + fast-travel
 * arrival geometry.
 *
 * A portal is "discovered" when the player ARRIVES on its map — walked
 * arrivals and fast-travel arrivals both record (PortalManager calls
 * record() on every completed transition; the origin map is recorded at
 * construction, since every run starts there). Discovery is player-scoped
 * (one registry per PortalManager) and survives save/reload: the registry
 * persists to a guarded localStorage key namespaced by world seed, so a
 * reload on the same run restores the same list, while a different world
 * seed starts empty.
 *
 * The registry stores LABELS only (biome id + world tier at discovery
 * time). It never drives spawning: a fast-travel arrival runs the exact
 * same PortalTransition pipeline as a walked arrival (same derived map
 * seed, same LandmarkSystem/enemy spawn), so landmarks, tier, and enemy
 * bands on a fast-traveled map are identical to a walked arrival by
 * construction. Travel is cost-free — a pure convenience system, no
 * currency gate (the wallet is never read here).
 *
 * Determinism: biome labels use deriveMapBiome and tiers use
 * deriveWorldTier — both pure functions of (worldSeed, coord). No
 * Math.random / Date.now anywhere in this module (discovery order is an
 * insertion counter, not a timestamp).
 */
import { deriveMapSeed, type MapCoord, type MapEdge } from './MapGraph';
import { deriveMapBiome, type BiomeId } from './Biomes';
import { deriveWorldTier } from './worldTiers';

/** localStorage key prefix; the full key appends the world seed. */
export const FAST_TRAVEL_STORAGE_KEY = 'xandria.fasttravel.v1';

/** One discovered portal: its map, plus the labels the UI shows. */
export interface DiscoveredPortal {
  mx: number;
  my: number;
  /** per-map biome id (deriveMapBiome, or the live spec's biome at arrival) */
  biome: BiomeId;
  /** world tier of the map (deriveWorldTier) */
  tier: number;
  /** insertion order (0 = origin); stable across serialize/restore */
  order: number;
}

/** Minimal storage surface so unit tests can inject a fake backend. */
export interface FastTravelStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

function defaultStorage(): FastTravelStorage {
  const mem = new Map<string, string>();
  return {
    get(key: string): string | null {
      try {
        if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
      } catch { /* guarded: headless/test envs fall through to memory */ }
      return mem.get(key) ?? null;
    },
    set(key: string, value: string): void {
      try {
        if (typeof localStorage !== 'undefined') { localStorage.setItem(key, value); return; }
      } catch { /* fall through to memory */ }
      mem.set(key, value);
    },
  };
}

function storageKey(worldSeed: number): string {
  return `${FAST_TRAVEL_STORAGE_KEY}.${worldSeed | 0}`;
}

/**
 * Pure biome + tier labels for a map. PortalManager overrides the biome
 * with the live spec's biome at arrival time (a Studio biome override
 * wins over the derived biome); the tier always comes from this function
 * (engine.worldTier is this same derivation, applied pre-spawn).
 */
export function labelFor(worldSeed: number, coord: MapCoord): { biome: BiomeId; tier: number } {
  return {
    biome: deriveMapBiome(worldSeed, coord.mx, coord.my),
    tier: deriveWorldTier(deriveMapSeed(worldSeed, coord.mx, coord.my), Math.abs(coord.mx) + Math.abs(coord.my)),
  };
}

/**
 * The edge a fast-travel arrival lands on, from the direction of travel.
 * Mirrors walked arrivals: traveling north (my increases) arrives at the
 * S edge facing north, exactly as if the player had walked across the N
 * edge; east arrives at the W edge, and so on. Diagonal targets use the
 * dominant axis (ties prefer the N/S axis, matching the grid's my-major
 * walk order). Returns null for a same-map target (no travel).
 */
export function fastTravelArrivalEdge(from: MapCoord, to: MapCoord): MapEdge | null {
  const dx = to.mx - from.mx;
  const dy = to.my - from.my;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'S' : 'N';
  return dx > 0 ? 'W' : 'E';
}

/**
 * Discovered-portal registry for one world seed. record() is idempotent:
 * re-recording a known map keeps its original order and labels (labels
 * are discovery-time facts, not live state).
 */
export class FastTravelRegistry {
  private portals: DiscoveredPortal[] = [];
  private nextOrder = 0;

  constructor(
    private worldSeed: number,
    private readonly storage: FastTravelStorage = defaultStorage(),
  ) {
    this.load();
  }

  /** The world seed this registry is currently keyed to. */
  get seed(): number {
    return this.worldSeed;
  }

  /** Record a discovery (idempotent). Returns true when newly recorded. */
  record(coord: MapCoord, biome?: BiomeId, tier?: number): boolean {
    if (this.has(coord)) return false;
    const label = biome !== undefined && tier !== undefined
      ? { biome, tier }
      : labelFor(this.worldSeed, coord);
    this.portals.push({ mx: coord.mx, my: coord.my, biome: label.biome, tier: label.tier, order: this.nextOrder++ });
    this.persist();
    return true;
  }

  has(coord: MapCoord): boolean {
    return this.portals.some((p) => p.mx === coord.mx && p.my === coord.my);
  }

  /** Discovered portals in discovery order (origin first). Copy, not live. */
  list(): DiscoveredPortal[] {
    return [...this.portals].sort((a, b) => a.order - b.order);
  }

  get size(): number {
    return this.portals.length;
  }

  /**
   * Re-key to a new world seed (startRun / daily-challenge reseed): loads
   * that seed's persisted list (or an empty one) and drops the old seed's
   * in-memory entries. No-op when the seed is unchanged.
   */
  rekey(worldSeed: number): void {
    if ((worldSeed | 0) === (this.worldSeed | 0)) return;
    this.worldSeed = worldSeed;
    this.load();
  }

  /** JSON round-trip (versioned); corrupt input restores empty, never throws. */
  serialize(): string {
    return JSON.stringify({ version: 1, portals: this.portals });
  }

  static restore(worldSeed: number, json: string, storage: FastTravelStorage = defaultStorage()): FastTravelRegistry {
    const reg = new FastTravelRegistry(worldSeed, storage);
    try {
      const data = JSON.parse(json) as { version?: unknown; portals?: unknown };
      if (data.version !== 1 || !Array.isArray(data.portals)) return reg;
      reg.portals = [];
      reg.nextOrder = 0;
      for (const p of data.portals) {
        const q = p as Partial<DiscoveredPortal>;
        if (!Number.isInteger(q.mx) || !Number.isInteger(q.my)
          || typeof q.biome !== 'string' || !Number.isInteger(q.tier)) continue;
        reg.portals.push({
          mx: q.mx!, my: q.my!, biome: q.biome as BiomeId,
          tier: q.tier!, order: Number.isInteger(q.order) ? q.order! : reg.nextOrder,
        });
        reg.nextOrder = Math.max(reg.nextOrder, reg.portals[reg.portals.length - 1].order + 1);
      }
      reg.portals.sort((a, b) => a.order - b.order);
    } catch { /* corrupt input → the storage-loaded (or empty) list stands */ }
    return reg;
  }

  private load(): void {
    this.portals = [];
    this.nextOrder = 0;
    try {
      const raw = this.storage.get(storageKey(this.worldSeed));
      if (!raw) return;
      const data = JSON.parse(raw) as { version?: unknown; portals?: unknown };
      if (data.version !== 1 || !Array.isArray(data.portals)) return;
      for (const p of data.portals) {
        const q = p as Partial<DiscoveredPortal>;
        if (!Number.isInteger(q.mx) || !Number.isInteger(q.my)
          || typeof q.biome !== 'string' || !Number.isInteger(q.tier)) continue;
        const order = Number.isInteger(q.order) ? q.order! : this.nextOrder;
        this.portals.push({ mx: q.mx!, my: q.my!, biome: q.biome as BiomeId, tier: q.tier!, order });
        this.nextOrder = Math.max(this.nextOrder, order + 1);
      }
      this.portals.sort((a, b) => a.order - b.order);
    } catch { /* corrupt storage → start empty, never throw */ }
  }

  private persist(): void {
    try {
      this.storage.set(storageKey(this.worldSeed), this.serialize());
    } catch { /* storage unavailable (private mode, quota) → in-memory only */ }
  }
}
