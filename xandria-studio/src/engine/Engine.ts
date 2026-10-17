/**
 * Engine — the runtime kernel. Owns renderer, scene, physics, sky, terrain, audio, input,
 * particles, HUD and the frame loop. Blueprints receive the Engine and build gameplay on top.
 *
 * Test mode (?test=1): fixed 1/60 dt, audio muted, deterministic stepping, window.__XANDRIA__ hooks.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import { Rng } from './core/Rng';
import { Physics } from './core/Physics';
import { Input } from './core/Input';
import { AudioEngine } from './core/Audio';
import { PerfMonitor } from './core/Perf';
import { PerformanceManager, type PerfTier } from './core/PerformanceManager';
import { MaterialLibrary, applyGroundDetailForQuality } from './gfx/Materials';
import { createSky, type SkyRig } from './gfx/Sky';
import { Particles } from './gfx/Particles';
import { PostFX } from './gfx/PostFX';
import { Terrain } from './world/Terrain';
import { FarTerrain } from './world/FarTerrain';
// PORTALS-B: portal travel between 8km maps (workstream B)
import { PortalManager } from './world/PortalManager';
// PORTALS-D (workstream D): cross-map state for portal transitions.
// portalEntities = per-map entity lifecycle registry (world/MapEntities);
// portalCache = visited-map LRU (world/MapCache), wired by the portal flow.
// The transition itself is driven by workstream B via PortalTransition
// (world/PortalState) or the capture/park/despawn → acquire/swap/unpark/
// restore/spawn primitives. Engine changes here are only the two fields
// and the two methods below.
import { MapEntityRegistry } from './world/MapEntities';
import { PortalMapCache, TerrainMapContext } from './world/MapCache';
import { ORIGIN, stampOriginMap, type MapCoord } from './world/MapGraph';
import { portalsEnabled } from '@spec';
import { cameraFarForWorldSize, cameraNearForWorldSize, FAR_TERRAIN_MIN_SIZE } from './gfx/FarField';
import { HUD, type RunStats } from './game/HUD';
import { AssetBridge } from './gfx/AssetBridge';
import { Settings } from './game/Settings';
import { Juice } from './game/Juice';
import { Modding } from './game/Modding';
import { TouchControls, isTouchDevice } from './game/TouchControls';
import { showIntroCard } from '../blueprints/campaign';
import type { PlayerAvatar } from '../blueprints/common';
import {
  applyLoadout,
  dailySeed,
  loadProfile,
  purchaseModifier,
  recordRun,
  saveProfile,
  setLoadout,
  todayLocalDate,
  MODIFIERS,
  type ProfileData,
} from './game/Profile';

export type EngineState = 'loading' | 'ready' | 'title' | 'playing' | 'paused' | 'won' | 'lost';

export interface EngineOptions {
  testMode?: boolean;
  /** skip terrain entirely (blueprints that build their own world geometry) */
  noTerrain?: boolean;
  flatCenters?: THREE.Vector3[];
  flatRadius?: number;
  /**
   * Graphics wave 2 (E): explicit perf tier for this engine instance
   * ('desktop' | 's25'). Overrides ?tier= / spec.custom.tier / auto-detect.
   * Test + harness seam; the player path resolves without it.
   */
  tier?: PerfTier;
}

export class Engine {
  readonly spec: GameSpec;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly physics: Physics;
  readonly mats: MaterialLibrary;
  readonly input: Input;
  readonly touch: TouchControls;
  readonly audio: AudioEngine;
  readonly particles: Particles;
  readonly hud: HUD;
  readonly rng: Rng;
  readonly postfx: PostFX;
  readonly settings: Settings;
  readonly juice: Juice;
  /** modding surface: hook taps + custom enemy/upgrade registries (additive) */
  readonly hooks: Modding;
  /**
   * Workstream E: thin perf instrumentation for the future PerformanceManager
   * (W3.3). Read-only counters — frame time + rolling variance, renderer.info
   * (draw calls / triangles / geometries / textures / programs), physics step
   * cost. Nothing here ever adapts quality (audit W0: instrumentation only).
   * Reachable from the console as __XANDRIA__.engine.perf.
   */
  readonly perf = new PerfMonitor();
  /**
   * Graphics wave 2 (E): the resolved perf tier (desktop | s25) + its flag
   * table. Resolved once at construction, held for the run's lifetime —
   * never adaptive. Blueprints read engine.tiers.flags for density budgets,
   * real-light caps, and sway. Reachable as __XANDRIA__.engine.tiers.
   */
  readonly tiers: PerformanceManager;
  sky!: SkyRig;
  terrain!: Terrain;
  /** low-res far-field shell under the detail terrain (workstream D); null on small worlds */
  private farTerrain: FarTerrain | null = null;
  assetBridge: AssetBridge;
  readonly container: HTMLElement;
  readonly testMode: boolean;

  state: EngineState = 'loading';
  time = 0;
  frame = 0;
  score = 0;
  elapsed = 0; // gameplay seconds (excludes pause)

  private updateHooks: Array<(dt: number) => void> = [];
  private last = 0;
  private rafId = 0;
  private started = false;
  private resizeObs: ResizeObserver;
  /** live perf debug overlay element (workstream E, ?perfoverlay=1); null when hidden */
  private perfOverlayEl: HTMLElement | null = null;
  /** blueprint rebuild fn, registered by the runtime bootstrap (enables in-place restart) */
  private runBuilder: ((e: Engine) => unknown) | null = null;
  private playerAvatar: PlayerAvatar | null = null;
  /**
   * Stage-1 B: optional exact streaming focus (the player position).
   * Blueprints may point this at their controller's position each frame;
   * Engine.step falls back to the camera (which tracks the player in every
   * genre) when it is null.
   */
  streamFocus: THREE.Vector3 | null = null;
  /**
   * PORTALS-D: per-map entity lifecycle registry (enemies, pickups, loot —
   * see world/MapEntities.ts). Blueprints register their map-local systems;
   * the portal transition despawns them on departure and respawns them
   * deterministically on arrival.
   */
  readonly portalEntities = new MapEntityRegistry();
  /**
   * PORTALS-D: visited-map LRU (world/MapCache.ts). Wired by the portal
   * transition flow (workstream B/C). Null = portals disabled; transitions
   * throw rather than silently rebuild without a cache.
   */
  portalCache: PortalMapCache | null = null;
  /** hooks that survive restart() (runtime bootstrap); blueprint hooks are torn down */
  private persistentHooks = new Set<(dt: number) => void>();
  private pauseReason: 'menu' | 'modal' | null = null;
  private sceneBaseline = 0;

  /** window audio-unlock listeners (added in the constructor, removed in dispose()). */
  private audioUnlockHandler!: () => void;
  private physicsBodiesBaseline = 0;
  private physicsConstraintsBaseline = 0;
  private shakeVec = new THREE.Vector3();
  /** stage-1 B: scratch vector for the streaming focus (no per-frame alloc) */
  private streamTmp = new THREE.Vector3();
  /** the spec's original seed — daily runs temporarily override spec.meta.seed */
  private baseSeed: number;
  /** YYYY-MM-DD while a daily-challenge run is active; null otherwise */
  private dailyDate: string | null = null;
  /** terrain construction options, kept so terrain can be rebuilt from a new seed (R2-M1) */
  private terrainOpts: { flatCenters?: THREE.Vector3[]; flatRadius?: number; noTerrain?: boolean };
  /** the seed the live terrain was generated from */
  private terrainSeed: number;
  /**
   * PORTALS-B: portal travel manager (workstream B). Null unless the spec
   * enables portals — arena genres and portal-off specs see no hooks, no
   * overlay, no per-frame work. Attached in the constructor, after terrain.
   */
  portalManager: PortalManager | null = null;

  constructor(container: HTMLElement, spec: GameSpec, opts: EngineOptions = {}) {
    this.container = container;
    this.spec = spec;
    this.testMode = opts.testMode ?? new URLSearchParams(location.search).has('test');
    this.rng = new Rng(spec.meta.seed);
    this.settings = new Settings();
    // Graphics wave 2 (E): resolve the perf tier once — settings override >
    // explicit engine opt > ?tier= > spec.custom.tier > device auto-detect.
    const search = typeof location !== 'undefined' ? location.search : '';
    this.tiers = new PerformanceManager(spec, this.settings, {
      tierParam: opts.tier ?? PerformanceManager.tierParamFromSearch(search),
    });

    this.renderer = new THREE.WebGLRenderer({ antialias: !(spec.theme.retroFilter && (spec.custom?.quality ?? 'retro') === 'retro'), powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const quality = this.effectiveQuality();
    // Graphics wave 2, workstream A: ground micro-detail layer follows the
    // quality tier (shared uniforms — one material, no second code path).
    // E integration: the perf tier provides a quality floor for this GFX
    // fidelity knob (desktop → high), with max-semantics so an explicit
    // s25+high user setting keeps A's quality behavior.
    applyGroundDetailForQuality(this.detailQualityForTier(quality));
    const pr = quality === 'high' ? Math.min(devicePixelRatio, 2)
      : quality === 'standard' ? Math.min(devicePixelRatio, 1.5)
      : spec.theme.retroFilter ? Math.min(devicePixelRatio, 1) * 0.66
      : Math.min(devicePixelRatio, 2);
    // Graphics wave 2 (E): the tier caps the pixel ratio on top of the
    // quality formula (s25 = tuned-down profile; desktop cap is a no-op on
    // the base formulas — 2.0 only binds user-forced high on mobile).
    this.renderer.setPixelRatio(Math.min(pr, this.tiers.flags.pixelRatioCap));
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    container.appendChild(this.renderer.domElement);
    // Workstream E (instrumentation): renderer.info resets per render call by
    // default, which with the PostFX composer leaves only the LAST pass's
    // counters. The documented three.js pattern for multi-pass rendering is
    // autoReset=false + one manual reset per frame (done in step()), giving
    // honest per-frame draw calls / triangles. (The if-guard no-ops on unit-test
    // renderer stubs, which carry no info object.)
    if (this.renderer.info) this.renderer.info.autoReset = false;

    // Open World stage 1 (workstream D): the far plane scales with world size
    // so the horizon is never GPU-clipped on big maps; the near plane scales
    // with it so the near:far ratio (and z-precision) matches the legacy
    // 1400/0.1 baseline. Worlds at/below the knee keep the legacy planes.
    const worldSize = spec.world.terrain.size;
    this.camera = new THREE.PerspectiveCamera(66, (container.clientWidth || innerWidth) / (container.clientHeight || innerHeight), cameraNearForWorldSize(worldSize), cameraFarForWorldSize(worldSize));
    this.physics = new Physics(spec.world.gravity);
    this.mats = new MaterialLibrary(spec);
    this.input = new Input(this.renderer.domElement);
    this.audio = new AudioEngine(spec);
    this.audio.setVolume(this.settings.data.volume);
    this.audio.setMuted(this.settings.data.muted);
    this.particles = new Particles(this.scene, spec.meta.seed ^ 0x9a77);
    this.juice = new Juice(container, this.particles);
    this.hooks = new Modding(this);
    this.hud = new HUD(container, spec);
    this.hud.attachEngine(this);
    this.touch = new TouchControls(container, this.input, spec.meta.genre);
    this.hud.setTouchMode(this.touch.active);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, spec, {
      // Graphics wave 2 (E): desktop tier gets the heavier-post bloom look.
      bloomBoost: this.tiers.flags.bloomBoost,
    });

    this.sky = createSky(spec, this.scene, this.effectiveQuality());
    this.renderer.toneMappingExposure = this.sky.exposure;
    // Graphics wave 2 (E): the tier may floor-raise the shadow-map
    // resolution createSky just set (desktop 2048 = the "real-time shadows"
    // look; s25 keeps the base 1024). Never lowers. Resolution changes GPU
    // cost, never the draw-call census. applySettings keeps it in step with
    // later pause-menu changes.
    if (this.sky.sun) {
      const want = this.tiers.flags.shadowMapSize;
      if (this.sky.sun.shadow.mapSize.x < want) this.sky.sun.shadow.mapSize.set(want, want);
    }
    // Wire the pooled flash-light pool into juice (muzzle flashes, explosions).
    this.juice.setFlash((color, pos, intensity, distance, duration) =>
      this.sky.lightLife.flash(color, pos, intensity, distance, duration));
    this.terrainOpts = { flatCenters: opts.flatCenters, flatRadius: opts.flatRadius, noTerrain: opts.noTerrain };
    // PORTALS (merge): stamp the origin map's identity BEFORE terrain creation
    // so the boot map builds from deriveMapSeed(worldSeed, 0, 0) — the same
    // path as every later map (C's session contract). Without this, "there
    // and back" would land on a different map than the boot map. A spec that
    // already carries a portalMap (pre-stamped) is left alone.
    if (portalsEnabled(spec) && !spec.custom?.portalMap) stampOriginMap(spec, spec.meta.seed);
    if (!opts.noTerrain) {
      this.terrain = new Terrain(spec, this.physics, this.mats, this.scene, {
        flatCenters: opts.flatCenters,
        flatRadius: opts.flatRadius,
      });
    }
    this.syncFarTerrain();
    this.terrainSeed = spec.meta.seed;
    // PORTALS-B: attach portal travel. Null unless portals are enabled for
    // this spec — arena genres keep walls and are completely unaffected.
    this.portalManager = PortalManager.attach(this);
    // PORTALS (merge): construct the visited-map LRU and seed it with the
    // live origin terrain, so the first return trip is a cache hit instead
    // of a rebuild. The context wraps the live terrain — no extra build.
    if (this.portalManager && this.terrain) {
      this.portalCache = new PortalMapCache(3);
      const origin: MapCoord = { ...ORIGIN };
      this.portalCache.acquire(origin, (c) => new TerrainMapContext(c, this.terrain, this.scene, this.physics));
    }

    // audio unlock on first gesture (removed again in dispose())
    this.audioUnlockHandler = () => { if (!this.testMode) this.audio.unlock(); };
    addEventListener('pointerdown', this.audioUnlockHandler);
    addEventListener('keydown', this.audioUnlockHandler);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);

    // opt-in online asset packs — additive only; failures keep the procedural world
    this.assetBridge = new AssetBridge(spec, this.scene, this.terrain);
    if (this.assetBridge.enabled && !this.testMode) {
      this.assetBridge.load().then((r) => {
        if (r.loaded.length) console.info(`[xandria] asset packs loaded: ${r.loaded.join(', ')}`);
        if (r.failed.length) console.warn(`[xandria] asset packs failed (procedural fallback kept): ${r.failed.join(', ')}`);
      });
    }

    // restart baselines: everything the blueprint adds beyond this point is
    // torn down by resetRun() (scene objects, physics bodies, hooks)
    this.sceneBaseline = this.scene.children.length;
    this.physicsBodiesBaseline = this.physics.bodyBaseline();
    this.physicsConstraintsBaseline = this.physics.constraintBaseline();

    this.state = 'ready';

    // Workstream E: opt-in live perf debug overlay (?perfoverlay=1), read-only
    // numbers for measurement runs. The typeof guard keeps headless/unit-test
    // environments (no location global) safe.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('perfoverlay')) {
      this.setPerfOverlayVisible(true);
    }

    // cross-run progression: the seed this spec shipped with (daily runs
    // override it temporarily; toTitle()/startRun() restore it).
    // PORTALS (merge): the WORLD seed, not the map build seed — on portal
    // specs the origin stamp above already rewrote spec.meta.seed to
    // deriveMapSeed(worldSeed, 0, 0); startRun()/toTitle() re-derive from
    // the world seed via stampOriginMap.
    this.baseSeed = spec.custom?.portalMap?.worldSeed ?? spec.meta.seed;

    // record finished runs into the persistent profile (skipped in testMode
    // so automated runs never pollute player stats)
    if (!this.testMode) {
      this.hooks.tap('onWin', ({ stats }) => this.recordRunResult(true, stats));
      this.hooks.tap('onLose', ({ stats }) => this.recordRunResult(false, stats));
    }
  }

  onUpdate(fn: (dt: number) => void) { this.updateHooks.push(fn); return () => { this.updateHooks = this.updateHooks.filter((f) => f !== fn); }; }

  /**
   * Like onUpdate, but the hook survives restart() — for runtime-bootstrap
   * hooks (body dataset, weather follow). Blueprint hooks use onUpdate and
   * are torn down on restart.
   */
  onUpdatePersistent(fn: (dt: number) => void) {
    this.persistentHooks.add(fn);
    return this.onUpdate(fn);
  }

  /**
   * Register the blueprint build function so restart()/toTitle() can rebuild
   * the run in place from the same spec+seed. Called once by the runtime
   * bootstrap.
   */
  setRunBuilder(fn: (e: Engine) => unknown) {
    this.runBuilder = fn;
  }

  /**
   * R5-M1: the live player avatar, self-registered by PlayerAvatar on
   * construction (re-registered on every rebuild). beginPlay() re-syncs its
   * construction-time loadout copies after applyLoadout(), so title-shop
   * purchases made after boot() still take effect on the run.
   */
  setPlayerAvatar(a: PlayerAvatar | null) {
    this.playerAvatar = a;
  }

  /**
   * PORTALS-B: the live player avatar (workstream B/D seam — portal
   * placement and the cross-map state handoff). Re-registered by
   * PlayerAvatar on every blueprint build.
   */
  get portalsPlayerAvatar(): PlayerAvatar | null {
    return this.playerAvatar;
  }

  /**
   * Rebuild the heightfield terrain from the current spec.meta.seed (R2-M1).
   * The daily challenge overrides the seed *after* construction; without a
   * rebuild every daily run would play on the base game's terrain, and an
   * in-place restart would silently change the world between attempts.
   * Rebuilds only when the seed actually changed, so the normal flow (and
   * in-place restarts, which keep the same seed) never pay for it.
   */
  private syncTerrainToSeed() {
    if (this.terrainOpts.noTerrain || !this.terrain) return;
    if (this.terrainSeed === this.spec.meta.seed) return;
    // PORTALS-D: a seed change abandons every cached map — clear the visited
    // LRU first (disposes all cached contexts including the live terrain;
    // the dispose below is then a harmless no-op). Without this, cached
    // contexts would leak on startRun/toTitle during a portal run.
    this.portalCache?.clear();
    this.terrain.dispose(this.scene, this.physics);
    this.terrain = new Terrain(this.spec, this.physics, this.mats, this.scene, {
      flatCenters: this.terrainOpts.flatCenters,
      flatRadius: this.terrainOpts.flatRadius,
    });
    this.terrainSeed = this.spec.meta.seed;
    this.syncFarTerrain();
    // The opt-in asset packs ground their props on engine terrain — keep the
    // bridge's reference fresh (private field, so set from here rather than
    // touching AssetBridge.ts).
    (this.assetBridge as unknown as { terrain?: Terrain }).terrain = this.terrain;
  }

  /**
   * PORTALS-B: rebuild the world from a derived map seed (portal travel,
   * workstream B). The constructor's initial update() sync-builds the
   * teleportSyncRadius neighborhood around `arrival` (spawn-first — the
   * ChunkStream teleport path), and the rest of the load radius streams in
   * over the next frames via the normal budget. flatCenters is steered at
   * the arrival point (and restored) so the arrival pad is flattened exactly
   * like the run spawn.
   *
   * PORTALS (merge): the live flow now goes through the visited-map LRU
   * (PortalManager → PortalTransition → buildTerrainForPortal); this method
   * remains for direct/external callers. When `portal` is given, the target
   * map's identity is stamped so C's per-map biome resolves.
   */
  transitionToMapSeed(mapSeed: number, arrival: THREE.Vector3, portal?: { mx: number; my: number; worldSeed: number }): void {
    this.spec.meta.seed = mapSeed;
    if (portal) {
      this.spec.custom = this.spec.custom ?? {};
      this.spec.custom.portalMap = { ...portal };
    }
    const prevFlat = this.terrainOpts.flatCenters;
    this.terrainOpts.flatCenters = [arrival.clone()];
    try {
      this.syncTerrainToSeed();
    } finally {
      this.terrainOpts.flatCenters = prevFlat;
    }
  }

  /**
   * PORTALS-D: park the live map's payloads ahead of a portal transition.
   * Chunk bodies/meshes, boundary walls, and water come off the physics
   * world / scene WITHOUT disposing cached chunk geometry; the far-field
   * shell is disposed (it rebuilds cheaply per map). The Terrain instance
   * stays valid — the visited-map LRU (portalCache) may re-attach it later.
   * Pair with swapTerrainForPortal() on the arrival side.
   */
  parkWorldForPortal(): void {
    if (this.terrainOpts.noTerrain || !this.terrain) return;
    this.terrain.parkPortals(this.scene, this.physics);
    this.farTerrain?.dispose();
    this.farTerrain = null;
  }

  /**
   * PORTALS-D: make `next` the live terrain after a portal transition.
   * `next` must already be unparked (see TerrainMapContext.unpark). Rebuilds
   * the far-field shell for the new map and refreshes the asset bridge's
   * terrain reference, mirroring syncTerrainToSeed().
   *
   * PORTALS (E gate fix): the engine's live spec describes the live map. C's
   * session contract requires spec.meta.seed = deriveMapSeed(worldSeed,mx,my)
   * for every visited map (origin included), and every portal transition —
   * LRU hit or fresh build — funnels through here, so the derived seed and
   * the portalMap stamp land on the live spec exactly once per transition.
   * This also keeps the terrainSeed === spec.meta.seed invariant that
   * syncTerrainToSeed() relies on for its no-op check.
   */
  swapTerrainForPortal(next: Terrain, coord: MapCoord, mapSeed: number): void {
    this.terrain = next;
    this.terrainSeed = mapSeed;
    this.spec.meta.seed = mapSeed;
    this.spec.custom = {
      ...(this.spec.custom ?? {}),
      portalMap: {
        mx: coord.mx,
        my: coord.my,
        worldSeed: this.spec.custom?.portalMap?.worldSeed ?? this.baseSeed,
      },
    };
    this.syncFarTerrain();
    // keep the opt-in asset packs grounded on the live terrain (same
    // private-field pattern as syncTerrainToSeed)
    (this.assetBridge as unknown as { terrain?: Terrain }).terrain = next;
  }

  /**
   * PORTALS (merge): build a not-yet-live Terrain for a portal-map coordinate
   * (the visited-map LRU's factory). The spec copy carries the derived build
   * seed AND the stamped portalMap so C's per-map biome resolves for the new
   * map; arrival flattening is steered at the arrival focus exactly like the
   * run spawn. The caller (PortalTransition via PortalManager) parks the live
   * map first and swaps this in via swapTerrainForPortal.
   */
  buildTerrainForPortal(coord: MapCoord, mapSeed: number, arrivalFocus: THREE.Vector3): Terrain {
    const spec: GameSpec = {
      ...this.spec,
      meta: { ...this.spec.meta, seed: mapSeed },
      custom: {
        ...(this.spec.custom ?? {}),
        portalMap: {
          mx: coord.mx,
          my: coord.my,
          worldSeed: this.spec.custom?.portalMap?.worldSeed ?? this.baseSeed,
        },
      },
    };
    return new Terrain(spec, this.physics, this.mats, this.scene, {
      flatCenters: [arrivalFocus.clone()],
      flatRadius: this.terrainOpts.flatRadius,
    });
  }

  /**
   * Open World stage 1 (workstream D): build/rebuild the low-res far-field
   * shell under the detail terrain. Big worlds only — small worlds render
   * byte-identical without it.
   */
  private syncFarTerrain() {
    this.farTerrain?.dispose();
    this.farTerrain = null;
    if (!this.terrainOpts.noTerrain && this.terrain && this.terrain.size > FAR_TERRAIN_MIN_SIZE) {
      this.farTerrain = new FarTerrain(this.spec, this.terrain, this.mats, this.scene);
    }
  }

  /** Effective render quality: settings override, else the spec hint. */
  effectiveQuality(): 'retro' | 'standard' | 'high' {
    const q = this.settings.data.quality;
    if (q !== 'auto') return q;
    const sq = this.spec.custom?.quality;
    return sq === 'high' || sq === 'standard' ? sq : 'retro';
  }

  /**
   * Graphics wave 2 (E integration): the perf tier provides a quality floor
   * for the ground micro-detail layer (workstream A). Ordering: retro <
   * standard < high. Desktop always gets 'high'; s25 gets max('retro', q).
   */
  detailQualityForTier(q: 'retro' | 'standard' | 'high'): 'retro' | 'standard' | 'high' {
    const order = { retro: 0, standard: 1, high: 2 } as const;
    const floor = this.tiers.flags.detailQuality;
    return order[q] >= order[floor] ? q : floor;
  }

  /** Apply settings to audio + renderer (called on boot and from the pause menu). */
  applySettings() {
    this.audio.setVolume(this.settings.data.volume);
    this.audio.setMuted(this.settings.data.muted);
    const quality = this.effectiveQuality();
    // Graphics wave 2, workstream A: keep the ground detail layer in step
    // with pause-menu quality changes (uniform update — no recompile).
    // E integration: tier floor applies here too (see constructor).
    applyGroundDetailForQuality(this.detailQualityForTier(quality));
    const pr = quality === 'high' ? Math.min(devicePixelRatio, 2)
      : quality === 'standard' ? Math.min(devicePixelRatio, 1.5)
      : this.spec.theme.retroFilter ? Math.min(devicePixelRatio, 1) * 0.66
      : Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(Math.min(pr, this.tiers.flags.pixelRatioCap));
    // T1-4: keep the shadow map resolution in step with quality changes from
    // the pause menu (resizing a shadow map requires dropping the old one).
    // Graphics wave 2 (E): the tier floor-raises it — desktop gets the
    // 2048 "real-time shadows" look, s25 stays at the base 1024. Resolution
    // changes GPU cost, never the draw-call census.
    const shadowRes = Math.max(
      quality === 'high' ? 2048 : 1024,
      this.tiers.flags.shadowMapSize,
    );
    const sun = this.sky?.sun;
    if (sun && sun.shadow.mapSize.x !== shadowRes) {
      sun.shadow.mapSize.set(shadowRes, shadowRes);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postfx.resize(w, h);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.last = performance.now();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      let dt = this.testMode ? 1 / 60 : Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
    };
    this.rafId = requestAnimationFrame(tick);
    // automated runs skip the title screen (?test=1 sets testMode; ?autostart=1 is the explicit alias)
    const autostart = new URLSearchParams(location.search).has('autostart');
    if (this.testMode || autostart) {
      this.state = 'playing';
    } else {
      this.showTitle();
    }
  }

  private showTitle() {
    this.state = 'title';
    const nar = this.spec.narrative;
    const racing = this.spec.meta.genre === 'racing';
    const touch = isTouchDevice();
    const controls = touch
      ? racing
        ? ['LEFT STICK — steer (gas is automatic)', 'BRAKE / BOOST buttons', '⏸ button — pause']
        : ['LEFT STICK — move',
           this.spec.meta.genre === 'fps-arena' ? 'DRAG RIGHT SIDE — look' : 'RIGHT STICK — aim',
           'Buttons — attack / jump / dash', '⏸ button — pause']
      : racing
        ? ['WASD / ARROWS — drive', 'SPACE — boost', 'R — reset car', 'ESC / P — pause']
        : ['WASD / ARROWS — move', 'MOUSE — attack / aim', 'SPACE — jump / boost', 'SHIFT — sprint / dash', 'E — interact', 'ESC / P — pause'];
    const profile = loadProfile();
    const g = this.spec.meta.genre;
    const played = profile.runsPlayed[g] ?? 0;
    const won = profile.runsWon[g] ?? 0;
    const best = profile.bestScore[g] ?? 0;
    const profileLine = played > 0
      ? `${played} run${played === 1 ? '' : 's'} · ${won} won · best ${best.toLocaleString()}`
      : 'first run — good luck';
    const today = todayLocalDate();
    const dailyBest = profile.dailyBest[today] ?? null;
    const equipped = new Set(profile.loadout);
    this.hud.showTitle({
      name: this.spec.meta.name,
      premise: nar?.premise ?? this.spec.objective.description,
      controls,
      onStart: () => this.startRun(),
      profileLine,
      merit: profile.merit,
      modifiers: MODIFIERS.map((m) => ({
        id: m.id,
        name: m.name,
        desc: m.desc,
        cost: m.cost,
        owned: profile.owned.includes(m.id),
        equipped: equipped.has(m.id),
      })),
      onToggleModifier: (id) => this.toggleModifier(id),
      onBuyModifier: (id) => this.buyModifier(id),
      dailyLabel: `DAILY ${today}`,
      dailyBest,
      onDaily: () => this.startDailyRun(),
    });
  }

  /** Equip/unequip a purchased modifier, then re-render the title. */
  private toggleModifier(id: string): void {
    const p = loadProfile();
    const equipped = new Set(p.loadout);
    if (equipped.has(id)) equipped.delete(id);
    else if (p.owned.includes(id)) equipped.add(id);
    setLoadout(p, [...equipped]);
    saveProfile(p);
    this.showTitle();
  }

  /** Buy a modifier with merit, then re-render the title. */
  private buyModifier(id: string): void {
    const p = loadProfile();
    if (purchaseModifier(p, id)) {
      // auto-equip on purchase
      setLoadout(p, [...p.loadout, id]);
      saveProfile(p);
    }
    this.showTitle();
  }

  /** Begin the run from the title screen (the click is a user gesture: audio unlocks). */
  /**
   * PORTALS (merge): re-establish the origin map identity after a seed reset
   * (startRun/toTitle/startDailyRun). Forces spec.meta.seed back to
   * deriveMapSeed(worldSeed, 0, 0) and re-points the portal manager at the
   * run's world seed. Call BEFORE syncTerrainToSeed so the rebuild uses the
   * derived origin seed.
   */
  private reseedPortalOrigin(worldSeed: number): void {
    if (!portalsEnabled(this.spec)) return;
    stampOriginMap(this.spec, worldSeed);
    this.portalManager?.resetWorldSeed(worldSeed);
  }

  /**
   * PORTALS (merge): re-seed the visited-map LRU with the live origin terrain
   * after a seed reset cleared it (via syncTerrainToSeed's seed-change hook).
   * Call AFTER syncTerrainToSeed. No-op when the origin entry survived.
   */
  private reseedPortalCache(): void {
    if (this.portalCache && this.terrain) {
      const origin: MapCoord = { ...ORIGIN };
      this.portalCache.acquire(origin, (c) => new TerrainMapContext(c, this.terrain, this.scene, this.physics));
    }
  }

  startRun() {
    if (this.state !== 'title') return;
    this.dailyDate = null;
    this.spec.meta.seed = this.baseSeed;
    // PORTALS (merge): a fresh run restarts at the origin map — re-stamp
    // before the terrain sync, then re-seed the LRU the sync cleared.
    this.reseedPortalOrigin(this.baseSeed);
    this.syncTerrainToSeed(); // no-op in the normal flow; restores base terrain after a daily run
    this.reseedPortalCache();
    this.beginPlay();
  }

  /**
   * Daily challenge: the seed is derived deterministically from the calendar
   * date, so everyone gets the same run today. Local best tracked per day.
   *
   * R2-M1: the seed must drive the WORLD, not just the spawns. The terrain is
   * rebuilt from the daily seed and the run itself is rebuilt too (via
   * resetRun), so attempt 1 and every in-place restart play the identical
   * world: same seed → same terrain + same spawns, every time.
   */
  startDailyRun() {
    if (this.state !== 'title') return;
    this.dailyDate = todayLocalDate();
    this.spec.meta.seed = dailySeed(this.dailyDate);
    // PORTALS (merge): the daily seed is the run's world seed — re-stamp the
    // origin from it before the terrain sync, then re-seed the LRU.
    this.reseedPortalOrigin(this.spec.meta.seed);
    this.syncTerrainToSeed();
    this.reseedPortalCache();
    if (this.runBuilder) this.resetRun();
    this.beginPlay();
  }

  private beginPlay() {
    this.hud.clearOverlays();
    this.audio.unlock();
    this.audio.play('click');
    // cross-run progression: the equipped modifier loadout applies from the
    // very first run, not just after an in-place restart (M1). applyLoadout()
    // is idempotent (restores pristine base values before re-applying), so
    // the resetRun() call below stays valid.
    applyLoadout(this.spec, loadProfile());
    // R5-M1: the avatar snapshots loadout values at construction (boot), but
    // the player may have bought/equipped modifiers in the title shop after
    // that. Re-sync its construction-time copies now that the spec carries
    // the current loadout. (Per-frame values like swift/power read live.)
    this.playerAvatar?.resyncLoadout();
    // R4-N2: the intro story card belongs here, after clearOverlays — the
    // blueprints used to show it at build time, so a fresh run's beginPlay
    // wiped it (card never visible) while in-place restarts (which rebuild
    // without beginPlay) showed it. Now it shows on every fresh run start
    // and never on restarts.
    showIntroCard(this, this.spec);
    this.state = 'playing';
    this.last = performance.now();
  }

  /** Back to the title screen, with a fresh run waiting underneath. */
  toTitle() {
    // leave any daily run behind: the title background is always the base game
    this.dailyDate = null;
    this.spec.meta.seed = this.baseSeed;
    // PORTALS (merge): the title background is the origin map — re-stamp
    // before the terrain sync, then re-seed the LRU the sync cleared.
    this.reseedPortalOrigin(this.baseSeed);
    this.syncTerrainToSeed(); // R2-M1: restore the base-game terrain after a daily run
    this.reseedPortalCache();
    if (this.runBuilder) this.resetRun();
    else this.hud.clearOverlays();
    this.audio.setIntensity(0.5);
    this.audio.setEngine(0, false);
    this.audio.resumeMusic(); // title screen is interactive — music resumes here too
    this.showTitle();
  }

  /** Aggregate a finished run into the persistent profile. Best-effort. */
  private recordRunResult(won: boolean, stats: Partial<RunStats>): void {
    try {
      const p = loadProfile();
      recordRun(p, {
        genre: this.spec.meta.genre,
        won,
        score: Math.round(this.score),
        level: stats.level ?? 1,
        kills: stats.kills ?? 0,
        timeSeconds: this.elapsed,
        daily: this.dailyDate ?? undefined,
      });
      saveProfile(p);
    } catch {
      /* profile is best-effort — a storage failure must never break the game */
    }
  }

  step(dt: number) {
    this.frame++;
    // Workstream E: thin perf sampling. One branch when disabled (zero cost);
    // when enabled: a performance.now() pair around the frame, a pair around
    // each physics substep (summed into physicsMs), one renderer.info.reset()
    // before the render (see the autoReset=false in the constructor) and one
    // sample() after. No allocations anywhere in this path.
    const perf = this.perf;
    const sampling = perf.enabled;
    const frameStart = sampling ? performance.now() : 0;
    let physicsMs = 0;
    this.input.beginFrame();
    // R2-N1: snapshot the engine-level edges BEFORE the substep loop. Update
    // hooks consume edges on substep 0 only (see below), so the pause/confirm
    // checks after the loop must read the snapshot — this keeps the M9 fix
    // (an Escape/P edge still pauses in ?test=1) working.
    const pauseEdge = this.input.justPressed('pause');
    const confirmEdge = this.input.justPressed('confirm');
    if (this.state === 'playing' && !this.juice.hitStopActive()) {
      // testMode: advance many sim steps per rendered frame so headless/SwiftShader
      // runs at full simulation speed regardless of render rate.
      const substeps = this.testMode ? 10 : 1;
      for (let s = 0; s < substeps; s++) {
        this.time += dt;
        this.elapsed += dt;
        if (sampling) {
          const ps = performance.now();
          this.physics.step(dt);
          physicsMs += performance.now() - ps;
        } else {
          this.physics.step(dt);
        }
        for (const f of this.updateHooks) f(dt);
        // edge-triggered input is consumed by the first substep only: a single
        // injected edge fires exactly once per rendered frame in testMode.
        // For production (substeps=1) the guard never fires, so the frame
        // ordering is identical to the M9 behavior (restores the pre-M9
        // clear for hooks; pause/confirm read the snapshot above).
        if (s === 0 && substeps > 1) this.input.endFrame();
      }
      this.particles.update(dt * substeps);
      this.hud.update(dt);
      this.hooks.emit('onTick', { dt, t: this.elapsed });
    }
    if (this.state === 'title' && confirmEdge) this.startRun();
    if (pauseEdge) this.togglePause();
    this.touch.setVisible(this.state === 'playing');
    this.juice.update(dt, this.camera);
    this.sky.update(dt, this.camera.getWorldPosition(new THREE.Vector3()));
    // Stage-1 B: chunk streaming follows the player every frame (all states —
    // the title backdrop is a live world too). Instrumentation only: the
    // counters below feed ?perfoverlay=1, nothing adapts quality.
    if (this.terrain) {
      this.terrain.update(this.streamFocus ?? this.camera.getWorldPosition(this.streamTmp));
      const ss = this.terrain.getStreamStats();
      perf.sampleStream(ss.loaded, ss.buildMs, ss.queue);
    }
    // screenshake: offset around the render only, never accumulates into the camera
    const off = this.juice.shakeOffset(this.shakeVec);
    this.camera.position.add(off);
    if (sampling) this.renderer.info?.reset();
    this.postfx.render();
    this.camera.position.sub(off);
    if (sampling) perf.sample(performance.now() - frameStart, physicsMs, this.renderer.info);
    this.input.endFrame();
    if (this.perfOverlayEl !== null && this.frame % 10 === 0) this.renderPerfOverlay();
  }

  /**
   * Workstream E: opt-in live perf debug overlay — a fixed corner div with
   * the current perf counters, refreshed 6x/sec. Off by default; enable with
   * ?perfoverlay=1 or setPerfOverlayVisible(true). Read-only: the overlay
   * never changes engine behavior (no adaptive quality in this wave).
   */
  setPerfOverlayVisible(v: boolean) {
    const on = this.perfOverlayEl !== null;
    if (v === on) return;
    if (!v) {
      this.perfOverlayEl!.remove();
      this.perfOverlayEl = null;
      return;
    }
    const el = document.createElement('div');
    el.id = 'xandria-perf-overlay';
    el.style.cssText = [
      'position:fixed', 'left:8px', 'top:8px', 'z-index:99998', 'pointer-events:none',
      'background:rgba(0,0,0,0.72)', 'color:#7dff9a', 'font:11px/1.5 monospace',
      'padding:6px 8px', 'border-radius:4px', 'white-space:pre',
    ].join(';');
    (document.body ?? this.container).appendChild(el);
    this.perfOverlayEl = el;
    this.renderPerfOverlay();
  }

  private renderPerfOverlay() {
    const el = this.perfOverlayEl;
    if (!el) return;
    const p = this.perf;
    el.textContent =
      `frame ${p.frameMs.toFixed(2)}ms (±${Math.sqrt(p.frameMsVariance).toFixed(2)}) ${p.fps.toFixed(0)}fps\n` +
      `physics ${p.physicsMs.toFixed(2)}ms\n` +
      `draws ${p.drawCalls} tris ${(p.triangles / 1000).toFixed(1)}k\n` +
      `geo ${p.geometries} tex ${p.textures} prog ${p.programs}\n` +
      `chunks ${p.chunksLoaded} build ${p.chunkBuildMs.toFixed(2)}ms queue ${p.streamQueue}`;
  }

  /**
   * Pause the sim. reason 'menu' (Esc/P pause menu) can be toggled back;
   * reason 'modal' (level-up choice etc.) must resolve through its own UI.
   */
  pause(reason: 'menu' | 'modal' = 'modal') {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.pauseReason = reason;
      this.audio.setEngine(0, false);
      this.audio.pauseMusic(); // generative music must not play under the pause menu (M3)
      this.last = performance.now();
    }
  }

  /** Resume the sim after pause(). */
  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.pauseReason = null;
      this.audio.resumeMusic();
      this.last = performance.now();
    }
  }

  togglePause() {
    if (this.state === 'playing') { this.pause('menu'); this.hud.showPause(); }
    else if (this.state === 'paused' && this.pauseReason === 'menu') { this.resume(); this.hud.hidePause(); }
  }

  win(stats: Partial<RunStats> = {}, winText?: string) {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this.audio.setEngine(0, false);
    this.audio.pauseMusic(); // combat music must not play under the victory screen (M3)
    this.audio.play('win');
    this.hooks.emit('onWin', { stats });
    this.hud.showEnd(true, {
      score: this.score,
      time: this.elapsed,
      kills: 0,
      level: 1,
      stagesCleared: 0,
      ...stats,
    }, winText);
  }

  lose(reason = '', stats: Partial<RunStats> = {}) {
    if (this.state !== 'playing') return;
    this.state = 'lost';
    this.audio.setEngine(0, false);
    this.audio.pauseMusic(); // combat music must not play under the defeat screen (M3)
    this.audio.play('lose');
    this.hooks.emit('onLose', { reason, stats });
    this.hud.showEnd(false, {
      score: this.score,
      time: this.elapsed,
      kills: 0,
      level: 1,
      stagesCleared: 0,
      reason,
      ...stats,
    });
  }

  /**
   * In-place restart: tear down everything the blueprint built and rebuild
   * the run from the same spec+seed (deterministic — same seed = same run).
   * Falls back to a page reload when no run builder was registered.
   */
  restart() {
    if (!this.runBuilder) {
      // No blueprint builder was registered (runtime bootstrap skipped it):
      // the only option is a plain page reload. (R2-N12: the old
      // 'xandria.restart' sessionStorage flag was write-only — nothing ever
      // read it — so it was removed rather than left as dead state.)
      location.reload();
      return;
    }
    this.resetRun();
    this.state = 'playing';
    this.last = performance.now();
  }

  /**
   * Tear down blueprint state back to the post-construction baseline, then
   * re-run the registered blueprint builder. Deterministic: rng re-seeded,
   * particles cleared, physics/scene/hooks restored.
   */
  private resetRun() {
    // drop blueprint update hooks, keep persistent bootstrap hooks
    this.updateHooks = this.updateHooks.filter((h) => this.persistentHooks.has(h));
    // remove blueprint scene objects (dispose their geometries, plus
    // blueprint-created materials/textures — but never shared MaterialLibrary
    // cache entries, which other blueprints may still reference)
    for (let i = this.scene.children.length - 1; i >= this.sceneBaseline; i--) {
      const o = this.scene.children[i];
      this.scene.remove(o);
      o.traverse((c: THREE.Object3D) => {
        const mesh = c as THREE.Mesh;
        const g = mesh.geometry as THREE.BufferGeometry | undefined;
        g?.dispose();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const list = Array.isArray(m) ? m : m ? [m] : [];
        for (const mat of list) {
          if (this.mats.ownsMaterial(mat)) continue;
          for (const k of Object.keys(mat)) {
            const v = (mat as unknown as Record<string, unknown>)[k];
            if (v instanceof THREE.Texture && !this.mats.ownsTexture(v)) v.dispose();
          }
          mat.dispose();
        }
      });
    }
    // physics back to baseline
    this.physics.resetToBaseline(this.physicsBodiesBaseline, this.physicsConstraintsBaseline);
    // deterministic state
    this.rng.reseed(this.spec.meta.seed);
    this.particles.reset(this.spec.meta.seed ^ 0x9a77);
    // polish wave: weather counts scale with quality tier + per-genre mood
    this.particles.setWeather(this.spec.theme.weather, this.spec.meta.seed, this.effectiveQuality(), this.spec.meta.genre);
    // HUD / juice / input
    this.hud.resetRun();
    this.juice.reset();
    this.input.reset();
    // audio
    this.audio.setEngine(0, false);
    this.audio.setIntensity(0.5);
    this.audio.resumeMusic(); // a fresh run gets its music scheduler back (M3)
    // clocks
    this.time = 0;
    this.elapsed = 0;
    this.score = 0;
    this.frame = 0;
    // Workstream E: a rebuilt run starts a fresh measurement window — the old
    // run's frame times must not leak into the new run's rolling variance.
    this.perf.reset();
    this.pauseReason = null;
    this.last = performance.now();
    // cross-run progression: apply the equipped modifier loadout to this
    // run's config (never to the seed — determinism is preserved)
    applyLoadout(this.spec, loadProfile());
    // rebuild the run from the same spec+seed
    const blueprint = this.runBuilder!(this);
    if (typeof window !== 'undefined') {
      const X = (window as unknown as { __XANDRIA__?: { blueprint?: unknown } }).__XANDRIA__;
      if (X) X.blueprint = blueprint;
    }
    // re-trigger opt-in asset packs (their objects were cleared with the scene)
    if (this.assetBridge.enabled && !this.testMode) {
      this.assetBridge.load().then((r) => {
        if (r.loaded.length) console.info(`[xandria] asset packs loaded: ${r.loaded.join(', ')}`);
        if (r.failed.length) console.warn(`[xandria] asset packs failed (procedural fallback kept): ${r.failed.join(', ')}`);
      });
    }
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    removeEventListener('pointerdown', this.audioUnlockHandler);
    removeEventListener('keydown', this.audioUnlockHandler);
    this.resizeObs.disconnect();
    this.input.dispose();
    this.touch.dispose();
    this.audio.dispose();
    this.assetBridge.dispose();
    // PORTALS-B: tear down the portal overlay + update hook.
    this.portalManager?.dispose();
    this.portalManager = null;
    this.postfx.dispose();
    this.farTerrain?.dispose();
    this.renderer.dispose();
  }
}
