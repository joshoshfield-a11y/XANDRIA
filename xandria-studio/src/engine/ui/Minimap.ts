/**
 * XANDRIA upgrade loop (minimap-fog): minimap with seeded fog-of-war.
 *
 * Observe-only: this system never touches gameplay state. It reads the
 * player avatar position, the map-local landmark/event systems, and the
 * terrain heightfield, and renders a 2D canvas overlay in the HUD.
 *
 * Determinism: the fog grid is a pure function of player position history
 * (no RNG, no Math.random/Date.now anywhere). Fog state is keyed per map
 * coordinate (mx,my) and kept across portal transitions within a run, so
 * re-entering a visited map restores the exact fog the player left.
 * resetRun() clears all fog (deterministic restarts).
 *
 * Perf contract: zero per-frame allocations and zero canvas work when idle.
 * The onTick tap does one cheap distance check; fog reveal + landmark
 * discovery scans run at most every SCAN_INTERVAL_S and only redraw the
 * canvas when something actually changed (new tiles revealed, a landmark
 * discovered, beacons changed, map arrival, toggle). Base terrain images
 * bake once per map at arrival (measured, see bakeMs).
 */
import type { Engine } from '../Engine';
import type { LandmarkSystem } from '../world/LandmarkSystem';
import type { DynamicEventManager } from '../game/dynamicEvents';
import { NODE_DEFS } from '../game/gathering';import type { HazardZoneManager } from '../game/hazardZones';
/** Tiles per side of the fog grid (covers the whole map). */
export const FOG_TILES = 128;
/** Exploration reveal radius in meters. */
export const EXPLORE_RADIUS_M = 150;
/** Landmark "discovery" radius in meters: closer than this and the
 *  landmark is considered discovered and gets a minimap marker. */
export const DISCOVERY_RADIUS_M = 60;
/** Player must move this far (m) before a new reveal sample is taken. */
export const REVEAL_STEP_M = 8;
/** Throttle for landmark/beacon scans (seconds of game time). */
export const SCAN_INTERVAL_S = 0.5;
/** Baked base-image resolution (px per side). 1:1 with the fog grid. */
export const BASE_PX = 128;
/** Max per-map fog grids kept (LRU); bounds memory on long portal runs. */
export const MAX_MAP_GRIDS = 16;

/**
 * Pure fog-of-war tile grid over one map. World coords: x east, z north,
 * map spans [-half, +half] on both axes. A tile is revealed when its
 * CENTER lies within the reveal radius of a sampled player position.
 */
export class FogOfWar {
  readonly tiles: Uint8Array;
  readonly tilesPerSide: number;
  readonly worldSize: number;
  readonly tileSize: number;
  readonly half: number;
  revealedTiles = 0;

  constructor(worldSize: number, tilesPerSide: number = FOG_TILES) {
    this.worldSize = worldSize;
    this.tilesPerSide = tilesPerSide;
    this.tileSize = worldSize / tilesPerSide;
    this.half = worldSize / 2;
    this.tiles = new Uint8Array(tilesPerSide * tilesPerSide);
  }

  /** Tile indices for a world position, or null when off-map. */
  tileOf(x: number, z: number): [number, number] | null {
    if (x < -this.half || x >= this.half || z < -this.half || z >= this.half) return null;
    const tx = Math.floor((x + this.half) / this.tileSize);
    const tz = Math.floor((z + this.half) / this.tileSize);
    const n = this.tilesPerSide;
    return [Math.min(n - 1, Math.max(0, tx)), Math.min(n - 1, Math.max(0, tz))];
  }

  /** World position of a tile's center. */
  tileCenter(tx: number, tz: number): [number, number] {
    return [-this.half + (tx + 0.5) * this.tileSize, -this.half + (tz + 0.5) * this.tileSize];
  }

  isRevealed(x: number, z: number): boolean {
    const t = this.tileOf(x, z);
    return t !== null && this.tiles[t[1] * this.tilesPerSide + t[0]] === 1;
  }

  /**
   * Reveal every tile whose center is within `radius` meters of (x, z).
   * Returns the number of newly revealed tiles (0 = nothing changed).
   */
  reveal(x: number, z: number, radius: number): number {
    const n = this.tilesPerSide;
    const r2 = radius * radius;
    const lo = this.tileOf(x - radius, z - radius);
    const hi = this.tileOf(x + radius, z + radius);
    // Clamp the sample box to the grid when the circle hangs off the edge.
    const tx0 = lo ? lo[0] : 0, tz0 = lo ? lo[1] : 0;
    const tx1 = hi ? hi[0] : n - 1, tz1 = hi ? hi[1] : n - 1;
    let fresh = 0;
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = tz * n + tx;
        if (this.tiles[i] === 1) continue;
        const [cx, cz] = this.tileCenter(tx, tz);
        const dx = cx - x, dz = cz - z;
        if (dx * dx + dz * dz <= r2) {
          this.tiles[i] = 1;
          this.revealedTiles++;
          fresh++;
        }
      }
    }
    return fresh;
  }

  get coverage(): number {
    return this.revealedTiles / (this.tilesPerSide * this.tilesPerSide);
  }
}

/** Per-map minimap state: fog grid, discovered landmark keys, baked flag. */
interface MapFogState {
  fog: FogOfWar;
  /** discovered landmark identity keys "round(x),round(z)" */
  discovered: Set<string>;
  /** base terrain image baked for the current terrain instance */
  baked: boolean;
  /** insertion order for the LRU */
  seq: number;
}

const CSS = `
.xmap { position:absolute; z-index:20; right:16px; bottom:16px; pointer-events:none;
  font-family:'Segoe UI',system-ui,sans-serif; color:#e8ecf1; user-select:none; }
.xmap .mbox { position:relative; width:208px; background:rgba(10,14,20,.55);
  border:1px solid rgba(140,180,220,.25); border-radius:10px; backdrop-filter:blur(4px); }
.xmap .mbox canvas { display:block; width:208px; height:208px; border-radius:9px 9px 0 0; }
.xmap .mfoot { display:flex; align-items:center; justify-content:space-between;
  padding:5px 10px 7px; font-size:10px; letter-spacing:.14em; opacity:.85; }
.xmap .mfoot .mtoggle { pointer-events:auto; cursor:pointer; border:1px solid rgba(140,180,220,.4);
  border-radius:6px; background:rgba(20,30,44,.7); color:#e8ecf1; font-size:10px;
  letter-spacing:.1em; padding:3px 8px; font-family:inherit; }
.xmap .mfoot .mtoggle:hover { border-color:#ffd23f; }
.xmap .mchip { pointer-events:auto; cursor:pointer; display:flex; align-items:center; justify-content:center;
  width:44px; height:44px; border-radius:10px; border:1px solid rgba(140,180,220,.4);
  background:rgba(10,14,20,.72); color:#ffd23f; font-size:11px; font-weight:800;
  letter-spacing:.08em; font-family:inherit; backdrop-filter:blur(4px); }
.xmap .mchip:hover { border-color:#ffd23f; }
@media (max-width:760px) {
  .xmap { right:10px; bottom:10px; }
  /* expanded panel docks ABOVE the touch buttons (highest button bottom
     edge is 276px from the viewport bottom) and BELOW the quest tracker
     (top-right, top:106px) — the e2e overlap audit verifies the gap. */
  .xmap .mbox { width:148px; }
  .xmap .mbox canvas { width:148px; height:148px; }
  .xmap.expand-mobile .mbox { position:absolute; right:0; bottom:286px; }
}
`;

/** World→canvas (px) transform for a square map image of `px` per side. North (+z) is up. */
export function worldToMap(x: number, z: number, half: number, px: number): [number, number] {
  const size = half * 2;
  return [((x + half) / size) * px, ((half - z) / size) * px];
}

/** Canvas (px) column/row of a fog tile's 1x1 cell in the fog overlay. */
export function fogTileCell(tx: number, tz: number): [number, number] {
  // tile (tx,tz) spans x∈[tx,tx+1), z∈[tz,tz+1) in tile units; the z axis
  // flips (north up), so its canvas row is (FOG_TILES-1-tz).
  return [tx, FOG_TILES - 1 - tz];
}

export class Minimap {
  private readonly engine: Engine;
  private readonly dom: boolean;
  /** false under unit-test DOM stubs (no usable 2d context) — logic still runs */
  private renderable = false;
  private root: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;
  private chip: HTMLButtonElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private foot: HTMLDivElement | null = null;
  /** offscreen base terrain image (BASE_PX x BASE_PX) */
  private baseCanvas: HTMLCanvasElement | null = null;
  /** offscreen fog overlay (FOG_TILES x FOG_TILES), revealed tiles punched out */
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogCtx: CanvasRenderingContext2D | null = null;

  private readonly fogByKey = new Map<string, MapFogState>();
  private seq = 0;
  private currentKey = '';
  private bakedTerrain: unknown = null;
  /** last bake cost (ms) — perf disclosure */
  bakeMs = 0;
  /** redraw counter + last redraw cost (ms) — perf disclosure */
  redraws = 0;
  lastRedrawMs = 0;

  private expanded: boolean;
  private untap: (() => void) | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private lastRX = Infinity;
  private lastRZ = Infinity;
  private scanT = 0;
  private lastBeaconSig = '';
  private lastNodeSig = '';
  /** UPGRADE LOOP (quest-waypoints): last waypoint marker signature. */
  private lastWaypointSig = '';  private lastHazardSig = '';  private disposed = false;

  constructor(container: HTMLElement, engine: Engine) {
    this.engine = engine;
    this.dom = typeof document !== 'undefined' && typeof document.createElement === 'function';
    this.expanded = !this.smallScreen();
    if (this.dom) this.buildDom(container);
    this.untap = engine.hooks.tap('onTick', ({ dt }) => this.tick(dt));
  }

  private smallScreen(): boolean {
    try {
      return typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= 760;
    } catch { return false; }
  }

  private buildDom(container: HTMLElement): void {
    const doc = document;
    // Minimal DOM stubs (unit tests) may not implement getElementById.
    const cssPresent = typeof doc.getElementById === 'function' && doc.getElementById('xandria-minimap-css');
    if (!cssPresent) {
      const style = doc.createElement('style');
      (style as HTMLStyleElement).id = 'xandria-minimap-css';
      style.textContent = CSS;
      doc.head.appendChild(style);
    }
    const root = doc.createElement('div');
    root.className = 'xmap';
    root.id = 'xandria-minimap';
    const box = doc.createElement('div');
    box.className = 'mbox';
    const canvas = doc.createElement('canvas');
    canvas.width = 208;
    canvas.height = 208;
    const foot = doc.createElement('div');
    foot.className = 'mfoot';
    const label = doc.createElement('span');
    label.textContent = 'MAP';
    const cov = doc.createElement('span');
    cov.className = 'mcov';
    cov.textContent = '0%';
    const toggle = doc.createElement('button');
    toggle.className = 'mtoggle';
    toggle.textContent = 'HIDE [M]';
    toggle.addEventListener('click', () => this.setExpanded(false));
    foot.append(label, cov, toggle);
    box.append(canvas, foot);
    const chip = doc.createElement('button');
    chip.className = 'mchip';
    chip.textContent = 'MAP';
    chip.setAttribute('aria-label', 'Toggle minimap (M)');
    chip.addEventListener('click', () => this.setExpanded(true));
    root.append(box, chip);
    container.appendChild(root);
    this.root = root;
    this.box = box;
    this.chip = chip;
    this.canvas = canvas;
    this.foot = foot;
    // Probe: unit-test DOM stubs expose getContext but only a partial 2d API.
    const ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null;
    this.renderable = !!ctx && typeof ctx.drawImage === 'function' && typeof ctx.clearRect === 'function';
    if (this.renderable) {
      this.ctx = ctx;
      this.baseCanvas = doc.createElement('canvas');
      this.baseCanvas.width = BASE_PX;
      this.baseCanvas.height = BASE_PX;
      this.fogCanvas = doc.createElement('canvas');
      this.fogCanvas.width = FOG_TILES;
      this.fogCanvas.height = FOG_TILES;
      this.fogCtx = this.fogCanvas.getContext('2d') as CanvasRenderingContext2D;
    }
    doc.addEventListener('keydown', this.onKey);
    this.applyExpanded();
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.disposed || e.code !== 'KeyM' || e.repeat) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    // Only when the game is actually running (the minimap is meaningless on
    // the title screen and must not steal M from any overlay flow).
    if (this.engine.state !== 'playing' && this.engine.state !== 'paused') return;
    this.setExpanded(!this.expanded);
  }

  setExpanded(v: boolean): void {
    if (this.expanded === v) return;
    this.expanded = v;
    this.applyExpanded();
    if (v) this.redraw();
  }

  get isExpanded(): boolean { return this.expanded; }

  private applyExpanded(): void {
    if (!this.root || !this.box || !this.chip) return;
    this.box.style.display = this.expanded ? '' : 'none';
    this.chip.style.display = this.expanded ? 'none' : '';
    // Mobile expanded dock: lift the panel above the touch buttons.
    this.root.classList.toggle('expand-mobile', this.expanded && this.smallScreen());
  }

  /** Map identity key for the current portal coordinate. */
  private mapKey(): string {
    const c = this.engine.portalManager?.coord;
    return `${c?.mx ?? 0},${c?.my ?? 0}`;
  }

  private landmarks(): LandmarkSystem | undefined {
    return this.engine.portalEntities.byId('landmarks') as unknown as LandmarkSystem | undefined;
  }

  private events(): DynamicEventManager | undefined {
    return this.engine.portalEntities.byId('events') as unknown as DynamicEventManager | undefined;
  }

  /**
   * UPGRADE LOOP (hazard-zones): the hazard manager, observe-only. The
   * minimap never writes hazard state — it reads the current map's zone
   * roster and draws markers above the fog, like the event beacons.
   */
  private hazards(): HazardZoneManager | undefined {
    return this.engine.portalEntities.byId('hazards') as unknown as HazardZoneManager | undefined;
  }

  /**
   * Test/introspection seam: the current map's hazard markers that pass
   * the fog rule — a marker is shown only when its tile is revealed.
   * Empty when no fog state exists yet for the current map.
   */
  get hazardMarkers(): Array<{ defId: string; x: number; z: number; color: string; telegraphing: boolean }> {
    const mgr = this.hazards();
    const state = this.fogByKey.get(this.currentKey);
    if (!mgr || !state) return [];
    const out: Array<{ defId: string; x: number; z: number; color: string; telegraphing: boolean }> = [];
    for (const m of mgr.markerView()) {
      if (!state.fog.isRevealed(m.x, m.z)) continue; // fog rules respected
      out.push({ defId: m.defId, x: m.x, z: m.z, color: m.color, telegraphing: m.telegraphing });
    }
    return out;
  }

  /**
   * UPGRADE LOOP (player-camp): the camp manager, observe-only. The
   * minimap never writes camp state — it reads the current map's site
   * (discovered on arrival) and draws the camp marker above the fog,
   * like the event beacons.
   */
  private camp(): { site: { x: number; z: number } | null; discovered: boolean } | undefined {
    return this.engine.portalEntities.byId('camp') as unknown as
      { site: { x: number; z: number } | null; discovered: boolean } | undefined;
  }

  /** Test/introspection seam: the current map's camp marker (null = none). */
  get campMarker(): { x: number; z: number } | null {
    const c = this.camp();
    if (!c || !c.discovered || !c.site) return null;
    return { x: c.site.x, z: c.site.z };
  }

/** Gathering manager, when the blueprint registered one (structural read only). */
  private gathering(): {
    nodes: ReadonlyArray<{
      kind: string;
      retired: boolean;
      nodeState?: string;
      interactable: { id: string };
      root: { position: { x: number; z: number } };
    }>;
  } | undefined {
    return this.engine.portalEntities.byId('gathering') as unknown as
      | { nodes: ReadonlyArray<{
        kind: string; retired: boolean; nodeState?: string;
        interactable: { id: string };
        root: { position: { x: number; z: number } };
      }> }
      | undefined;
  }

  /**
   * Markers redraw() draws, and the e2e seam for the minimap leg:
   * LIVE gathering nodes whose fog tile is already revealed. Observe
   * only — this reads node state and fog state, never mutates either.
   * Depleted/awaiting/regrowing nodes are not marked (nothing to
   * harvest there yet); unrevealed tiles stay dark per fog rules.
   */
  gatheringMarkers(): Array<{ id: string; kind: string; x: number; z: number; color: string }> {
    const state = this.fogByKey.get(this.currentKey);
    const mgr = this.gathering();
    if (!state || !mgr) return [];
    const out: Array<{ id: string; kind: string; x: number; z: number; color: string }> = [];
    for (const n of mgr.nodes) {
      if (n.retired) continue;
      if (n.nodeState !== undefined && n.nodeState !== 'live') continue;
      const p = n.root.position;
      if (!state.fog.isRevealed(p.x, p.z)) continue;
      const def = (NODE_DEFS as Record<string, { minimapColor: string }>)[n.kind];
      out.push({ id: n.interactable.id, kind: n.kind, x: p.x, z: p.z, color: def?.minimapColor ?? '#ffffff' });
    }
    return out;
  }

  private getOrCreateState(key: string, worldSize: number): MapFogState {
    let s = this.fogByKey.get(key);
    if (!s) {
      s = { fog: new FogOfWar(worldSize), discovered: new Set(), baked: false, seq: this.seq++ };
      this.fogByKey.set(key, s);
      // LRU cap — never evict the current map.
      if (this.fogByKey.size > MAX_MAP_GRIDS) {
        let oldest: string | null = null;
        let oldestSeq = Infinity;
        for (const [k, v] of this.fogByKey) {
          if (k !== this.currentKey && v.seq < oldestSeq) { oldestSeq = v.seq; oldest = k; }
        }
        if (oldest) this.fogByKey.delete(oldest);
      }
    }
    return s;
  }

  /** Test/introspection seam: per-map fog state. */
  fogStateFor(key: string): MapFogState | undefined {
    return this.fogByKey.get(key);
  }

  /** Test/introspection seam: current map key. */
  get activeKey(): string { return this.currentKey; }

  /**
   * UPGRADE LOOP (world-atlas): fog-reveal fraction for one map coord
   * (0 when the map has no fog state yet — it has not been walked this
   * session). Session-only: resetRun() clears every grid, so this is
   * the current session's exploration, never a persisted fact. Read-only.
   */
  coverageFor(mx: number, my: number): number {
    const state = this.fogByKey.get(`${mx},${my}`);
    if (!state) return 0;
    const c = state.fog.coverage;
    return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
  }

  get coverage(): number {
    return this.fogByKey.get(this.currentKey)?.fog.coverage ?? 0;
  }

  /** onTick — cheap when idle: one distance check, then return. */
  private tick(dt: number): void {
    if (this.disposed) return;
    const avatar = this.engine.portalsPlayerAvatar;
    const terrain = this.engine.terrain as unknown as { size?: number } | undefined;
    const worldSize = typeof terrain?.size === 'number' ? terrain.size : 0;
    if (!avatar || worldSize <= 0) {
      if (this.root) this.root.style.display = 'none';
      return;
    }
    if (this.root && this.root.style.display === 'none') this.root.style.display = '';

    const key = this.mapKey();
    const state = this.getOrCreateState(key, worldSize);
    if (key !== this.currentKey || this.bakedTerrain !== terrain) {
      this.arrive(key, state);
    }
    // NOTE: read body.position directly — the ctrl.position getter allocates a
    // Vector3 per call, and this tick runs every frame (brief: zero per-frame
    // allocations when idle).
    const bp = avatar.ctrl.body.position;
    const dx = bp.x - this.lastRX, dz = bp.z - this.lastRZ;
    const moved = dx * dx + dz * dz >= REVEAL_STEP_M * REVEAL_STEP_M;
    if (moved) {
      this.lastRX = bp.x;
      this.lastRZ = bp.z;
      const fresh = state.fog.reveal(bp.x, bp.z, EXPLORE_RADIUS_M);
      if (fresh > 0) this.punchFog(state, bp.x, bp.z);
      this.scanT += SCAN_INTERVAL_S; // a reveal sample also triggers a discovery scan
    }
    this.scanT += dt;
    if (this.scanT >= SCAN_INTERVAL_S) {
      this.scanT = 0;
      let dirty = false;
      if (this.scanLandmarks(state, bp.x, bp.z)) dirty = true;
      if (this.scanBeacons()) dirty = true;
      if (this.scanNodes()) dirty = true;
      if (this.scanWaypoint()) dirty = true;      if (this.scanHazards()) dirty = true;      if (dirty) this.redraw();
      else if (moved) this.redraw(); // marker moved even if nothing else changed
    }
    this.updateFooter(state);
  }

  /** Arrival on a map (first visit or re-entry): bake base image once, restore fog, reveal. */
  private arrive(key: string, state: MapFogState): void {
    this.currentKey = key;
    this.bakedTerrain = this.engine.terrain;
    if (this.renderable) this.bakeBase(state);
    state.baked = true;
    const avatar = this.engine.portalsPlayerAvatar;
    if (avatar) {
      const abp = avatar.ctrl.body.position;
      this.lastRX = abp.x;
      this.lastRZ = abp.z;
      const fresh = state.fog.reveal(abp.x, abp.z, EXPLORE_RADIUS_M);
      if (fresh > 0) this.punchFog(state, abp.x, abp.z);
      this.scanLandmarks(state, abp.x, abp.z);
    }
    this.scanBeacons();
    this.scanHazards();
    this.redraw();
  }

  /**
   * Bake the terrain-shape base image for the current map. Two passes over
   * BASE_PX² heightfield samples: heights (+water) → hypsometric tint.
   * Runs once per terrain instance (arrival); measured into bakeMs.
   */
  private bakeBase(state: MapFogState): void {
    const terrain = this.engine.terrain;
    const t0 = performance.now();
    const bc = this.baseCanvas!;
    const bctx = bc.getContext('2d') as CanvasRenderingContext2D;
    const n = BASE_PX;
    const img = bctx.createImageData(n, n);
    const half = state.fog.half;
    const size = state.fog.worldSize;
    const heights = new Float32Array(n * n);
    const waters = new Float32Array(n * n); // water level or NaN
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // north (+z) up: row 0 = z = +half.
        const x = -half + ((i + 0.5) / n) * size;
        const z = half - ((j + 0.5) / n) * size;
        const h = terrain.heightAt(x, z);
        const wl = terrain.waterLevelAt(x, z);
        const k = j * n + i;
        heights[k] = h;
        waters[k] = wl === null ? NaN : wl;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    const span = Math.max(1e-6, maxH - minH);
    const d = img.data;
    for (let k = 0; k < n * n; k++) {
      const h = heights[k];
      const wl = waters[k];
      let r: number, g: number, b: number;
      if (!Number.isNaN(wl) && h < wl) {
        // water: shallow → deep
        const depth = Math.min(1, (wl - h) / Math.max(1, span * 0.25));
        r = 42 - 24 * depth; g = 111 - 68 * depth; b = 143 - 81 * depth;
      } else {
        const t = (h - minH) / span;
        if (t < 0.12) { r = 184; g = 155; b = 94; }        // sand
        else if (t < 0.55) { r = 71; g = 107; b = 54; }     // grass
        else if (t < 0.8) { r = 122; g = 117; b = 104; }     // rock
        else { r = 223; g = 230; b = 234; }                  // snow
      }
      d[k * 4] = r; d[k * 4 + 1] = g; d[k * 4 + 2] = b; d[k * 4 + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
    // Reset the fog overlay to match this map's grid (fresh dark, revealed
    // tiles punched out).
    const fctx = this.fogCtx!;
    fctx.save();
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    fctx.clearRect(0, 0, FOG_TILES, FOG_TILES);
    fctx.fillStyle = 'rgba(5,8,13,0.84)';
    fctx.fillRect(0, 0, FOG_TILES, FOG_TILES);
    fctx.restore();
    const fog = state.fog.tiles;
    fctx.save();
    fctx.globalCompositeOperation = 'destination-out';
    for (let tz = 0; tz < FOG_TILES; tz++) {
      for (let tx = 0; tx < FOG_TILES; tx++) {
        if (fog[tz * FOG_TILES + tx] === 1) {
          const [cx, cy] = fogTileCell(tx, tz);
          fctx.clearRect(cx, cy, 1, 1);
        }
      }
    }
    fctx.restore();
    this.bakeMs = performance.now() - t0;
  }

  /**
   * Incrementally punch newly revealed tiles out of the fog overlay.
   * Only tiles inside the reveal circle are visited (same loop shape as
   * FogOfWar.reveal); fogCtx ops are 1x1 rects — no per-frame canvas cost.
   */
  private punchFog(state: MapFogState, x: number, z: number): void {
    if (!this.renderable || !this.fogCtx) return;
    const fog = state.fog;
    const n = fog.tilesPerSide;
    const lo = fog.tileOf(x - EXPLORE_RADIUS_M, z - EXPLORE_RADIUS_M);
    const hi = fog.tileOf(x + EXPLORE_RADIUS_M, z + EXPLORE_RADIUS_M);
    const tx0 = lo ? lo[0] : 0, tz0 = lo ? lo[1] : 0;
    const tx1 = hi ? hi[0] : n - 1, tz1 = hi ? hi[1] : n - 1;
    const r2 = EXPLORE_RADIUS_M * EXPLORE_RADIUS_M;
    const fctx = this.fogCtx;
    fctx.save();
    fctx.globalCompositeOperation = 'destination-out';
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (fog.tiles[tz * n + tx] !== 1) continue;
        const [cx, cz] = fog.tileCenter(tx, tz);
        const dx = cx - x, dz = cz - z;
        if (dx * dx + dz * dz > r2) continue;
        const [px, py] = fogTileCell(tx, tz);
        fctx.clearRect(px, py, 1, 1);
      }
    }
    fctx.restore();
  }

  /** Landmark discovery scan: marks newly in-range landmarks, returns true if any. */
  private scanLandmarks(state: MapFogState, px: number, pz: number): boolean {
    const lm = this.landmarks();
    if (!lm || !lm.placed.length) return false;
    const r2 = DISCOVERY_RADIUS_M * DISCOVERY_RADIUS_M;
    let fresh = false;
    for (const pl of lm.placed) {
      const dx = pl.pos.x - px, dz = pl.pos.z - pz;
      if (dx * dx + dz * dz > r2) continue;
      const k = `${Math.round(pl.pos.x)},${Math.round(pl.pos.z)}`;
      if (!state.discovered.has(k)) {
        state.discovered.add(k);
        fresh = true;
      }
    }
    return fresh;
  }

  /** Node-set change scan: returns true when the live-node roster changed. */
  private scanNodes(): boolean {
    const mgr = this.gathering();
    let sig = '';
    if (mgr) {
      for (const n of mgr.nodes) {
        const p = n.root.position;
        sig += `${n.kind}:${Math.round(p.x)},${Math.round(p.z)},${n.retired ? 0 : 1};`;
      }
    }
    if (sig !== this.lastNodeSig) {
      this.lastNodeSig = sig;
      return true;
    }
    return false;
  }

  /** Event-beacon change scan: returns true when the active-beacon set changed. */
  private scanBeacons(): boolean {
    const mgr = this.events();
    let sig = '';
    if (mgr) {
      for (const ev of mgr.events) {
        if (ev.status !== 'active' || !ev.beacon) continue;
        const bp = ev.beacon.group.position;
        sig += `${Math.round(bp.x)},${Math.round(bp.z)};`;
      }
    }
    if (sig !== this.lastBeaconSig) {
      this.lastBeaconSig = sig;
      return true;
    }
    return false;
  }

  /** Quest-waypoint change scan: returns true when the waypoint marker changed. */
  private scanWaypoint(): boolean {
    const w = this.engine.waypoints?.minimapMarker() ?? null;
    const sig = w ? `${Math.round(w.x / 2)},${Math.round(w.z / 2)}` : '';
    if (sig !== this.lastWaypointSig) {
      this.lastWaypointSig = sig;
      return true;
    }
    return false;
  }

  /**
   * Hazard-marker change scan: returns true when the zone roster or any
   * zone's telegraph state changed (telegraph flips recolor the marker).
   * The fog rule itself is applied at draw/getter time, not in the sig.
   */
  private scanHazards(): boolean {
    const mgr = this.hazards();
    let sig = '';
    if (mgr) {
      for (const m of mgr.markerView()) {
        sig += `${Math.round(m.x)},${Math.round(m.z)},${m.telegraphing ? 1 : 0};`;
      }
    }
    if (sig !== this.lastHazardSig) {
      this.lastHazardSig = sig;
      return true;
    }
    return false;
  }

  /** Test/introspection seam: discovered landmark count on the current map. */
  get discoveredCount(): number {
    return this.fogByKey.get(this.currentKey)?.discovered.size ?? 0;
  }

  private updateFooter(state: MapFogState): void {
    if (!this.renderable || !this.foot || !this.expanded) return;
    const cov = this.foot.querySelector('.mcov');
    if (cov) cov.textContent = `${Math.round(state.fog.coverage * 100)}%`;
  }

  /**
   * Full composite redraw: base image + fog overlay + markers. Runs only on
   * events (reveal, discovery, beacon change, arrival, toggle) — never per
   * frame. Cost measured into lastRedrawMs.
   */
  private redraw(): void {
    if (!this.renderable || !this.ctx || !this.canvas || !this.expanded) return;
    const t0 = performance.now();
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const state = this.fogByKey.get(this.currentKey);
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (state && this.baseCanvas && this.fogCanvas) {
      ctx.drawImage(this.baseCanvas, 0, 0, W, H);
      ctx.drawImage(this.fogCanvas, 0, 0, W, H);
      const half = state.fog.half;
      const toPx = (x: number, z: number): [number, number] => worldToMap(x, z, half, W);
      // Portal exits: chevrons at the four map mid-edges (edge-crossing
      // portals — see world/PortalTrigger; +z is north).
      ctx.fillStyle = '#ffb545';
      for (const [ex, ez] of [[0, -half], [0, half], [half, 0], [-half, 0]] as const) {
        const [px, py] = toPx(ex, ez);
        ctx.beginPath();
        ctx.moveTo(px, py - 5); ctx.lineTo(px + 4, py + 3); ctx.lineTo(px - 4, py + 3);
        ctx.closePath(); ctx.fill();
      }
      // Discovered landmarks.
      const lm = this.landmarks();
      if (lm) {
        ctx.fillStyle = '#7dd3fc';
        for (const pl of lm.placed) {
          const k = `${Math.round(pl.pos.x)},${Math.round(pl.pos.z)}`;
          if (!state.discovered.has(k)) continue;
          const [px, py] = toPx(pl.pos.x, pl.pos.z);
          ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Active event beacons.
      const mgr = this.events();
      if (mgr) {
        for (const ev of mgr.events) {
          if (ev.status !== 'active' || !ev.beacon) continue;
          const bp = ev.beacon.group.position;
          const [px, py] = toPx(bp.x, bp.z);
          ctx.fillStyle = ev.def.beaconColor || '#ff4d3d';
          ctx.beginPath();
          ctx.moveTo(px, py - 5); ctx.lineTo(px + 4, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 4, py);
          ctx.closePath(); ctx.fill();
        }
      }
      // Hazard markers (hazard-zones wave): def-colored diamonds above
      // the fog, drawn ONLY when the zone's tile is revealed — fog rules
      // respected. Telegraphing zones paint in the warning color.
      const hz = this.hazards();
      if (hz) {
        for (const m of hz.markerView()) {
          if (!state.fog.isRevealed(m.x, m.z)) continue;
          const [px, py] = toPx(m.x, m.z);
          ctx.fillStyle = m.color;
          ctx.beginPath();
          ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py);
          ctx.closePath(); ctx.fill();
        }
      }
      // Camp marker (player-camp wave): green diamond above the fog,
      // drawn only when the current map's site is discovered (arrival).
      const camp = this.camp();
      if (camp && camp.discovered && camp.site) {
        const [px, py] = toPx(camp.site.x, camp.site.z);
        ctx.fillStyle = '#4ade80';
        ctx.strokeStyle = '#0a0e14';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      // Live gathering nodes on revealed fog tiles (observe-only, see
      // gatheringMarkers): small dots in the node's table color.
      for (const m of this.gatheringMarkers()) {
        const [px, py] = toPx(m.x, m.z);
        ctx.fillStyle = m.color;
        ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      // Quest waypoint marker (quest-waypoints wave): amber diamond
      // above the fog, drawn ONLY when its tile is revealed — the fog
      // rules apply to the waypoint exactly as to landmarks (an
      // unrevealed objective stays hidden on the minimap).
      const wp = this.engine.waypoints?.minimapMarker() ?? null;
      if (wp && state.fog.isRevealed(wp.x, wp.z)) {
        const [px, py] = toPx(wp.x, wp.z);
        ctx.fillStyle = '#ffb545';
        ctx.strokeStyle = '#0a0e14';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py - 6); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 6); ctx.lineTo(px - 6, py);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      // Player marker: heading triangle from camYaw.
      const avatar = this.engine.portalsPlayerAvatar;
      if (avatar) {
        const rbp = avatar.ctrl.body.position;
        const [px, py] = toPx(rbp.x, rbp.z);
        const yaw = avatar.ctrl.camYaw;
        // forward at camYaw is (−sin yaw, −cos yaw) in (x,z); canvas y flips z.
        const hx = -Math.sin(yaw), hy = Math.cos(yaw);
        const ang = Math.atan2(hy, hx);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#0a0e14';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = ang + (i * 2 * Math.PI) / 3;
          const r = i === 0 ? 7 : 4.5;
          const vx = px + Math.cos(a) * r, vy = py + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
    this.lastRedrawMs = performance.now() - t0;
    this.redraws++;
    if (state) this.updateFooter(state);
  }

  /** Deterministic restart: drop every map's fog + discovery state. */
  resetRun(): void {
    this.fogByKey.clear();
    this.currentKey = '';
    this.bakedTerrain = null;
    this.lastRX = Infinity;
    this.lastRZ = Infinity;
    this.scanT = 0;
    this.lastBeaconSig = '';
    this.lastNodeSig = '';
    this.lastWaypointSig = '';    this.lastHazardSig = '';    this.bakeMs = 0;
    this.redraws = 0;
    this.lastRedrawMs = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.untap?.();
    this.untap = null;
    if (this.dom) {
      try { document.removeEventListener('keydown', this.onKey); } catch { /* noop */ }
    }
    this.root?.remove();
    this.root = null;
    this.ctx = null;
    this.fogCtx = null;
  }
}
