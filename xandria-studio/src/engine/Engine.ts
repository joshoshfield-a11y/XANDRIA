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
import { PerformanceManager, tierDetailQuality, tierShadowMapSize, type PerfTier, type QualityLevel } from './core/PerformanceManager';
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
import { InteractionRegistry } from './game/Interaction';
import { PortalMapCache, TerrainMapContext } from './world/MapCache';
import { ORIGIN, stampOriginMap, type MapCoord } from './world/MapGraph';
import { deriveWorldTier } from './world/worldTiers';
import { portalsEnabled } from '@spec';
import { cameraFarForWorldSize, cameraNearForWorldSize, FAR_TERRAIN_MIN_SIZE } from './gfx/FarField';
import { HUD, type RunStats } from './game/HUD';
/** UPGRADE LOOP (minimap-fog): observe-only minimap with seeded fog-of-war. */
import { Minimap } from './ui/Minimap';
import { AssetBridge } from './gfx/AssetBridge';
import { Settings } from './game/Settings';
import { Juice } from './game/Juice';
import { Modding } from './game/Modding';
import { biomeMusicPattern } from './game/biomeMusic';
import { wireAudioHooks } from './game/audioWiring';
import { resolveBiomeDef } from './world/Biomes';
import { TouchControls, isTouchDevice } from './game/TouchControls';
import { TutorialManager } from './game/Tutorial';
import type { QuestManager } from './game/quests';
import type { Wallet } from './game/economy';
import type { AchievementManager } from './game/achievements';
import { showIntroCard } from '../blueprints/campaign';
import type { PlayerAvatar } from '../blueprints/common';
import {
  applyLoadout,
  createSlot,
  deleteSlot,
  isActiveSlotDead,
  isActiveSlotIronman,
  loadProfile,
  markActiveSlotDead,
  markActiveSlotIronman,
  MAX_SLOTS,
  purchaseModifier,
  recordJournalEntry,
  recordRun,
  renameSlot,
  saveProfile,
  setActiveSlotId,
  setLoadout,
  slotSummaries,
  MODIFIERS,
  type ProfileData,
  type RunJournalEntry,
} from './game/Profile';
import { ironmanScoreMult } from './game/ironman';
import type { Progression } from './game/Progression';
import { JournalPanel } from './ui/JournalPanel';
import { CustomizationPanel } from './ui/CustomizationPanel';
/**
 * UPGRADE LOOP (difficulty-modes): DifficultyId/isDifficultyId are a pure
 * import — no cycle (difficulty.ts imports nothing).
 */
import { isDifficultyId, type DifficultyId } from './game/difficulty';
/**
 * UPGRADE LOOP (accessibility-pass): settings bundle + palette/beacon
 * plumbing. accessibility.ts imports nothing, so no cycle.
 */
import {
  clampTextScale, defaultAccessibilitySettings, setCurrentPalette,
  validateAccessibilitySettings, validateKeybinds,
  type AccessibilitySettings,
} from './game/accessibility';
import { setCameraReducedMotion } from './game/Cameras';
import { recolorAllEventBeacons } from './game/dynamicEvents';
import {
  CHALLENGE_BOARD_DAYS,
  ChallengeGoalTracker,
  challengeBoard,
  challengeProfile,
  generateDailyChallenge,
  goalLabel,
  loadoutLabel,
  recordDailyResult,
  todayUtcDate,
  type DailyChallenge,
} from './game/dailyChallenges';
import {
  GauntletDirector,
  gauntletBoard,
  gauntletLine,
  gauntletSeedForDate,
  gauntletSupported,
  generateGauntlet,
  recordGauntletResult,
  type Gauntlet,
} from './game/gauntlet';
import type { BossEncounter } from './game/bosses';
import type { EnemyManager } from './game/EnemyAI';

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
  /**
   * UPGRADE LOOP (minimap-fog): observe-only minimap (terrain shape, player
   * marker, discovered landmarks, event beacons, portal exits) with seeded
   * fog-of-war. Created once at construction like the HUD; fog state is
   * per-map and cleared by resetRun(). Never affects gameplay.
   */
  readonly minimap: Minimap;
  readonly rng: Rng;
  readonly postfx: PostFX;
  readonly settings: Settings;
  readonly juice: Juice;
  /** modding surface: hook taps + custom enemy/upgrade registries (additive) */
  readonly hooks: Modding;
  /**
   * Tutorial wave: the data-driven first-run tutorial manager. Observes
   * only (hook taps + public state reads); never mutates gameplay.
   * Constructed after the HUD so the card surface exists.
   */
  readonly tutorial: TutorialManager;
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
  /** cumulative player damage taken this run (daily-challenge scoring) */
  damageTaken = 0;
  /**
   * Boss-fights wiring handles, stashed by wireBossFights on every combat-
   * blueprint build (encounter + enemy manager). Null on blueprints without
   * boss wiring (platformer/racing) — gauntlet mode is gated on this.
   */
  bossWiring: { encounter: BossEncounter; manager: EnemyManager } | null = null;
  /** the active gauntlet director; null outside gauntlet runs */
  gauntlet: GauntletDirector | null = null;

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
   * NPCs wave (workstream C): engine-level registry for NPC Interactables
   * ({ type: 'npc', prompt: 'Talk to <name>' }). NPC interactables live
   * here — NOT in ItemWorld.interactions (chests) — so the chest activation
   * path never sees NPC ids. Registered on spawn, unregistered on despawn
   * (see engine/game/npcInteraction.ts); the quest wave stamps
   * `requires`/`produces` onto villager interactables (see
   * engine/game/questTalk.ts).
   */
  readonly npcInteractions = new InteractionRegistry();
  /**
   * Quest wave: the player-scoped quest manager. Set by the blueprint when
   * quests are enabled; null otherwise. Deliberately NOT part of
   * portalEntities — quest progress is player-scoped, not map-local, so it
   * survives portal travel by construction (see engine/game/quests.ts).
   * Read by PortalManager.portalParts for snapshot/restore.
   */
  questManager: QuestManager | null = null;
  /**
   * Vendor-economy wave: the player-scoped currency wallet. Set by the
   * blueprint; null when the economy is off. Deliberately NOT part of
   * portalEntities — the balance is player-scoped, not map-local, so it
   * survives portal travel by construction (the snapshot carries it for
   * rebuild paths). Read by PortalManager.portalParts.
   */
  wallet: Wallet | null = null;
  /**
   * Achievements wave: the player-scoped achievement manager. Set by the
   * blueprint; null otherwise. Deliberately NOT part of portalEntities —
   * unlocks and progress counters are player-scoped, not map-local, so
   * they survive portal travel by construction (see
   * engine/game/achievements.ts). Cross-run persistence rides the Profile.
   */
  achievementManager: AchievementManager | null = null;
  /**
   * UPGRADE LOOP (run-journal): blueprints publish their Progression here so
   * the run journal can read the run's total XP at run end (mirrors
   * achievementManager). Null when the genre has no XP side.
   */
  progression: Progression | null = null;
  /** UPGRADE LOOP (run-journal): the journal panel (title screen entry). */
  readonly journalPanel: JournalPanel;
  /**
   * UPGRADE LOOP (character-customization): the customization panel
   * (title-screen + pause-menu entry). Reads/writes the active slot's
   * profile cosmetics; applyToLiveAvatar re-applies to the live avatar
   * rig without a reload (no-op before the first avatar build).
   */
  readonly customizationPanel: CustomizationPanel;
  // Run-journal observe-only counters. Taps on the existing hook bus only —
  // they never influence gameplay. Reset per run by resetJournalRun().
  private journalKills = 0;
  private journalDeaths = 0;
  private journalPortals = 0;
  private journalBosses = 0;
  /**
   * UPGRADE LOOP (hardcore-ironman): true while the live run is an
   * ironman run. Set by startRun (from the active slot's flag) and
   * startIronmanRun (after the title confirm step); cleared by
   * startDailyRun/startGauntletRun (those modes are never ironman) and
   * by toTitle. Deliberately NOT reset by restart(): an in-place restart
   * of a live ironman run stays ironman, and a dead slot can never reach
   * restart() anyway (the end screen hides RESTART, restart() guards).
   * Read by PlayerAvatar.die() (no-respawn branch) and the
   * run-completion path. No RNG reads here — mode is data, not chance.
   */
  private ironmanRun = false;
  /**
   * UPGRADE LOOP (hardcore-ironman): true when the live ironman run
   * ended by PLAYER DEATH (set by PlayerAvatar.die()'s ironman branch
   * via noteIronmanDeath(), before engine.lose()). lose() has non-death
   * callers (time-out, core destroyed) — only this flag marks the slot
   * dead, so a timeout defeat ends the run but not the slot. Reset at
   * every run start and on toTitle.
   */
  private ironmanDeath = false;
  /** ISO 8601 UTC, captured once at run start (never mid-run). */
  private journalStartUtc = '';
  /** world seed of the live run (daily runs: the challenge seed). */
  private journalSeed = 0;
  /**
   * PORTALS-D: visited-map LRU (world/MapCache.ts). Wired by the portal
   * transition flow (workstream B/C). Null = portals disabled; transitions
   * throw rather than silently rebuild without a cache.
   */
  portalCache: PortalMapCache | null = null;
  /**
   * WORLD-TIERS (upgrade loop): the live map's world tier, 1..MAX_WORLD_TIER.
   * A pure function of (mapSeed, map depth): deriveWorldTier(mapSeed,
   * |mx| + |my|). Set at boot (origin) and on every portal arrival
   * (swapTerrainForPortal / transitionToMapSeed), before map entities
   * spawn — EnemyAI and loot read it at spawn/roll time. 1 on single-map
   * games: the identity tier, byte-identical behavior to pre-tier builds.
   */
  worldTier = 1;
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
  /** YYYY-MM-DD (UTC) while a daily-challenge run is active; null otherwise */
  private dailyDate: string | null = null;
  /**
   * The active daily challenge tuple (seed/loadout/goal for dailyDate).
   * Null outside challenge runs. resetRun()/beginPlay() apply the challenge's
   * FIXED loadout (not the profile's) while this is set.
   */
  private challenge: DailyChallenge | null = null;
  /** goal tracker for the active challenge run; null outside challenge runs */
  private challengeTracker: ChallengeGoalTracker | null = null;
  /** UTC YYYY-MM-DD key while a gauntlet run is active; null otherwise */
  private gauntletDate: string | null = null;
  /**
   * Base-spec snapshot taken by startGauntletRun (objective, enemies,
   * custom) — the gauntlet overrides the run's spec for the mode and
   * toTitle()/startRun() restore it from here.
   */
  private gauntletBaseSpec: {
    objective: GameSpec['objective'];
    enemies: GameSpec['enemies'];
    custom: GameSpec['custom'];
  } | null = null;
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
    // UPGRADE LOOP (audio-system): per-bus settings + the boot map's biome
    // loop. Settings are player-scoped (per save slot), so they survive
    // reload and portal travel; the biome loop is re-derived per map below.
    this.audio.setMusicEnabled(this.settings.data.musicEnabled);
    this.audio.setSfxEnabled(this.settings.data.sfxEnabled);
    this.audio.setMusicVolume(this.settings.data.musicVolume);
    this.audio.setSfxVolume(this.settings.data.sfxVolume);
    this.audio.setBiome(biomeMusicPattern(resolveBiomeDef(spec).id, spec.meta.seed));
    this.particles = new Particles(this.scene, spec.meta.seed ^ 0x9a77);
    this.juice = new Juice(container, this.particles);
    // DAMAGE-NUMBERS: apply the persisted toggle at boot (before any
    // combat can spawn a number); applySettings() re-applies it on
    // pause-menu changes and slot switches.
    this.juice.setFloatingTextEnabled(this.settings.data.floatingText !== false);
    this.hooks = new Modding(this);
    // UPGRADE LOOP (audio-system): observe-only SFX taps (kill, level-up,
    // craft, portal, quest turn-in). Idempotent — see audioWiring.
    wireAudioHooks(this);
    this.hud = new HUD(container, spec);
    this.hud.attachEngine(this);
    // UPGRADE LOOP (minimap-fog): the minimap observes avatar/terrain/portal
    // entities via the engine — construction is side-effect-free beyond DOM.
    this.minimap = new Minimap(container, this);
    // Tutorial wave: observe-only first-run guide (profile-gated, Studio
    // force/skip via custom.tutorial.mode). Taps engine.hooks, which
    // survive restart(), so mid-run restarts keep tutorial progress.
    this.tutorial = new TutorialManager(this);
    // ACCESSIBILITY PASS: apply profile settings (keybinds, palette,
    // reduced motion, text scale) before the first frame. Blueprints build
    // camera rigs later; they read the module-level camera flag, so this
    // boot-time apply covers them too.
    this.applyAccessibility();
    this.touch = new TouchControls(container, this.input, spec.meta.genre);
    this.hud.setTouchMode(this.touch.active);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, spec, {
      // Graphics wave 2 (E): desktop tier gets the heavier-post bloom look.
      bloomBoost: this.tiers.flags.bloomBoost,
      // QA 2026-10-22 (F3): tier MSAA ceiling (s25 caps composer samples at 2).
      msaaCap: this.tiers.flags.msaaCap,
    });

    this.sky = createSky(spec, this.scene, this.effectiveQuality());
    this.renderer.toneMappingExposure = this.sky.exposure;
    // Graphics wave 2 (E) + QA 2026-10-22 (F3): resolve the shadow-map
    // resolution createSky just set from quality against the tier. Desktop:
    // floor-raise only (2048 = the "real-time shadows" look), never lowers —
    // unchanged. s25: tier-as-ceiling — quality=high no longer forces 2048
    // over the tier's 1024 cap. Resolution changes GPU cost, never the
    // draw-call census. applySettings keeps it in step with later
    // pause-menu changes via the same helper.
    if (this.sky.sun) {
      const res = tierShadowMapSize(this.tiers.flags, this.sky.sun.shadow.mapSize.x);
      if (this.sky.sun.shadow.mapSize.x !== res) this.sky.sun.shadow.mapSize.set(res, res);
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
    // WORLD-TIERS: derive the boot map's tier from the (possibly pre-stamped)
    // portalMap identity. The origin map is always tier 1.
    {
      const pm = spec.custom?.portalMap;
      this.applyWorldTier(spec.meta.seed, pm?.mx ?? 0, pm?.my ?? 0);
    }
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
    // daily-challenge scoring: accumulate actual player damage taken. One
    // integer add per hit, untapped in the normal flow — zero behavior change.
    this.hooks.tap('onPlayerDamage', ({ amount }) => {
      this.damageTaken += amount;
    });
    // run-journal: observe-only per-run counters. One integer add per event,
    // untapped in the normal flow — zero behavior change (same discipline as
    // damageTaken above). The entry is written by recordRunResult.
    this.hooks.tap('onKill', ({ enemy }) => {
      this.journalKills++;
      if (enemy?.isBoss === true) this.journalBosses++;
    });
    this.hooks.tap('onPlayerDeath', () => {
      this.journalDeaths++;
    });
    // run-journal: count portal traversals via the portal seam. Defensive
    // chaining — the achievements manager chains the same seam after us, and
    // both wrappers call the previous hook, so both counts stay exact.
    const pm = this.portalManager;
    if (pm) {
      const prevTransition = pm.hooks.onAfterTransition;
      const eng = this;
      pm.hooks.onAfterTransition = function (ctx) {
        const r = prevTransition?.(ctx);
        if (r && typeof (r as Promise<void>).then === 'function') {
          return (r as Promise<void>).then(() => {
            eng.journalPortals++;
          });
        }
        eng.journalPortals++;
        return r;
      };
    }
    // run-journal: the journal panel (title-screen entry point). Reads the
    // profile fresh on every open, so it always lists finished runs.
    this.journalPanel = new JournalPanel({
      container: this.container,
      journal: () => loadProfile().journal,
    });
    // character-customization: preview uses the engine's material library
    // (shared cache is never mutated — preview rigs clone owned materials).
    this.customizationPanel = new CustomizationPanel({
      container: this.container,
      mats: this.mats,
      seed: this.spec.meta.seed,
      applyToLiveAvatar: (c) => {
        try { this.portalsPlayerAvatar?.ctrl.applyCosmetics(c); } catch { /* pre-avatar: no-op */ }
      },
    });
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
      // WORLD-TIERS: keep the tier consistent on direct/external map jumps.
      this.applyWorldTier(mapSeed, portal.mx, portal.my);
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
    // WORLD-TIERS: the arrival map's tier, derived BEFORE map entities
    // spawn (PortalTransition.finish calls spawnForMap next) so enemy
    // bands and loot rolls see the new map's tier. The HUD chip updates
    // here too — event-driven, zero per-frame cost.
    this.applyWorldTier(mapSeed, coord.mx, coord.my);
    this.syncFarTerrain();
    // keep the opt-in asset packs grounded on the live terrain (same
    // private-field pattern as syncTerrainToSeed)
    (this.assetBridge as unknown as { terrain?: Terrain }).terrain = next;
    // UPGRADE LOOP (audio-system): the arrival map's biome loop. The
    // portalMap stamp above is already on the live spec, so
    // resolveBiomeDef() returns the ARRIVAL biome here (not the origin's).
    // The AudioContext survives travel — only the pattern swaps.
    this.audio.setBiome(biomeMusicPattern(resolveBiomeDef(this.spec).id, mapSeed));
    // Tutorial wave: every portal transition funnels through here (LRU hit
    // or fresh build), so this is the single portal-arrival seam. Additive:
    // with no taps the emit is a no-op.
    this.hooks.emit('onPortalArrive', { mapSeed });
  }

  /**
   * WORLD-TIERS (upgrade loop): derive + publish the live map's world tier.
   * Called at boot, on every portal arrival, and on direct map jumps —
   * always BEFORE map entities spawn for the new map. Drives the HUD tier
   * chip (event-driven: no per-frame polling) and the onWorldTier hook.
   */
  private applyWorldTier(mapSeed: number, mx: number, my: number): void {
    this.worldTier = deriveWorldTier(mapSeed, Math.abs(mx) + Math.abs(my));
    this.hud.setTier(this.worldTier);
    this.hooks.emit('onWorldTier', { tier: this.worldTier, coord: { mx, my } });
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
   * Graphics wave 2 (E integration) + QA 2026-10-22 (F3): combine the quality
   * setting with the perf tier's ground-detail level. Ordering: retro <
   * standard < high. Desktop: tier is a floor (unchanged — always 'high').
   * s25: tier is a CEILING — quality=high no longer re-enables the full
   * micro-detail layer the tier turned off (pre-fix max-semantics defeated
   * the cap; see PerformanceManager.tierDetailQuality).
   */
  detailQualityForTier(q: QualityLevel): QualityLevel {
    return tierDetailQuality(this.tiers.flags, q);
  }

  /** Apply settings to audio + renderer (called on boot and from the pause menu). */
  applySettings() {
    this.audio.setVolume(this.settings.data.volume);
    this.audio.setMuted(this.settings.data.muted);
    // DAMAGE-NUMBERS: keep Juice in step with the persisted toggle.
    this.juice.setFloatingTextEnabled(this.settings.data.floatingText !== false);
    this.audio.setMusicEnabled(this.settings.data.musicEnabled);
    this.audio.setSfxEnabled(this.settings.data.sfxEnabled);
    this.audio.setMusicVolume(this.settings.data.musicVolume);
    this.audio.setSfxVolume(this.settings.data.sfxVolume);
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
    // Graphics wave 2 (E) + QA 2026-10-22 (F3): desktop floor-raises it to
    // the 2048 "real-time shadows" look (unchanged); on s25 the tier CAPS it
    // at 1024 even at quality=high. Resolution changes GPU cost, never the
    // draw-call census.
    const shadowRes = tierShadowMapSize(this.tiers.flags, quality === 'high' ? 2048 : 1024);
    const sun = this.sky?.sun;
    if (sun && sun.shadow.mapSize.x !== shadowRes) {
      sun.shadow.mapSize.set(shadowRes, shadowRes);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    this.resize();
  }

  /**
   * UPGRADE LOOP (accessibility-pass): the profile's accessibility
   * settings, validated (corrupt fields fall back to defaults, never
   * throw). HUD settings UI reads this; applyAccessibilitySettings writes it.
   */
  getAccessibilitySettings(): AccessibilitySettings {
    try {
      return validateAccessibilitySettings(loadProfile().accessibility);
    } catch {
      return defaultAccessibilitySettings();
    }
  }

  /**
   * UPGRADE LOOP (accessibility-pass): merge a patch into the profile's
   * accessibility settings, persist, and apply live. Keybind patches
   * replace the whole keybinds record (the UI passes the full validated
   * overrides); palette/text-scale values are clamped/validated, never
   * trusted blind. Returns the applied settings, or null when the profile
   * could not be saved (callers treat null as "rejected").
   */
  applyAccessibilitySettings(patch: Partial<AccessibilitySettings>): AccessibilitySettings | null {
    try {
      const profile = loadProfile();
      const cur = validateAccessibilitySettings(profile.accessibility);
      const next: AccessibilitySettings = {
        keybinds: patch.keybinds !== undefined ? validateKeybinds(patch.keybinds) : cur.keybinds,
        colorblind: patch.colorblind !== undefined
          ? validateAccessibilitySettings({ colorblind: patch.colorblind }).colorblind
          : cur.colorblind,
        reducedMotion: patch.reducedMotion !== undefined ? patch.reducedMotion === true : cur.reducedMotion,
        hudTextScale: patch.hudTextScale !== undefined ? clampTextScale(patch.hudTextScale) : cur.hudTextScale,
      };
      profile.accessibility = next;
      saveProfile(profile);
      this.applyAccessibility(next);
      return next;
    } catch {
      return null;
    }
  }

  /**
   * UPGRADE LOOP (accessibility-pass): push settings into every live
   * consumer — input keymap, juice + particle + camera-rig motion gates,
   * HUD palette/text scale, live event beacons. Engine-level state only
   * (nothing map-local), so settings survive portal travel by
   * construction; a fresh boot re-applies from storage. Never throws:
   * a broken settings apply must not take down the run.
   */
  applyAccessibility(settings?: AccessibilitySettings): void {
    try {
      const s = settings ?? this.getAccessibilitySettings();
      setCurrentPalette(s.colorblind);
      this.input.setKeybinds(s.keybinds);
      this.juice.reducedMotion = s.reducedMotion;
      this.particles.reducedMotion = s.reducedMotion;
      setCameraReducedMotion(s.reducedMotion);
      this.hud.applyAccessibility(s.colorblind, s.hudTextScale);
      recolorAllEventBeacons();
    } catch {
      /* settings apply is best-effort — the run continues on defaults */
    }
  }

  resize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postfx.resize(w, h);
  }

  /**
   * UPGRADE LOOP (difficulty-modes): the player's current difficulty mode,
   * read from the profile (player-scoped, persisted). 'normal' when the
   * profile is missing/corrupt. Blueprints wire this into EnemyManager via
   * `difficulty: () => engine.getDifficultyMode()`.
   */
  getDifficultyMode(): DifficultyId {
    try {
      const d = loadProfile().difficulty;
      return isDifficultyId(d) ? d : 'normal';
    } catch {
      return 'normal';
    }
  }

  /**
   * UPGRADE LOOP (difficulty-modes): true when any live enemy is hostile
   * (chasing/attacking). Duck-typed off portalEntities so Engine never
   * imports EnemyAI (EnemyAI already imports Engine — a value import would
   * be a module cycle).
   */
  inCombat(): boolean {
    try {
      const sys = this.portalEntities.byId('enemies') as
        | { anyHostile?: unknown }
        | undefined;
      return typeof sys?.anyHostile === 'function' && (sys.anyHostile as () => boolean)();
    } catch {
      return false;
    }
  }

  /**
   * UPGRADE LOOP (difficulty-modes): change the player's difficulty mode.
   * Refused (ok: false) while any enemy is hostile — difficulty may only
   * change outside combat. A change applies to enemies spawned after it;
   * already-spawned enemies keep their spawn-time stats. Persisted to the
   * profile immediately.
   */
  setDifficultyMode(id: DifficultyId): { ok: boolean; reason?: string } {
    if (!isDifficultyId(id)) return { ok: false, reason: 'unknown difficulty' };
    if (this.inCombat()) return { ok: false, reason: 'cannot change difficulty in combat' };
    try {
      const p = loadProfile();
      p.difficulty = id;
      saveProfile(p);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'profile unavailable' };
    }
  }

  /**
   * UPGRADE LOOP (hardcore-ironman): true while the live run is ironman.
   * Test seam + the PlayerAvatar death branch read this (never a private
   * field poke — the die() branch must survive refactors of the flag).
   */
  isIronmanRun(): boolean {
    return this.ironmanRun === true;
  }

  /**
   * UPGRADE LOOP (hardcore-ironman): called by PlayerAvatar.die() on
   * the ironman death branch, immediately before engine.lose(). This
   * is the death-only signal the run-completion path uses to mark the
   * slot dead — lose() alone cannot distinguish death from defeat.
   */
  noteIronmanDeath(): void {
    this.ironmanDeath = true;
  }

  /**
   * UPGRADE LOOP (new-game-plus): the player's prestige cycle, read from
   * the profile (player-scoped, persisted). 0 when the profile is
   * missing/corrupt. Blueprints wire this into EnemyManager via
   * `ngPlus: () => engine.getNgPlusCycle()`.
   */
  getNgPlusCycle(): number {
    try {
      const c = loadProfile().ngPlusCycle;
      return Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * UPGRADE LOOP (new-game-plus): enter the next prestige cycle from the
   * run-end screen (the HUD's NEW GAME+ button calls this). Only valid
   * from a completed run ('won'/'lost') — the run-completion path is
   * observed, never changed: recordRunResult already ran on the win/lose
   * hook before the end screen showed.
   *
   * What it does, in order:
   *   1. increments ONLY profile.ngPlusCycle and saves — gear (loadout /
   *      owned), merit, achievements, difficulty, bestiary, daily results
   *      and journal data are never written here;
   *   2. resets MAP progress: the run restarts at the origin map on the
   *      base seed (same reseed/terrain/cache sequence as startRun), so
   *      the next cycle replays the maps from the start — now with the
   *      cycle multiplier on spawns;
   *   3. resets the world tier to the origin derivation (cycle and tier
   *      are orthogonal — NG+ must not inherit a deep-map tier);
   *   4. rebuilds the run (same resetRun path as RESTART, which
   *      re-applies the preserved loadout) and syncs the HUD chips.
   * Determinism: the seed is unchanged, so same (seed, cycle) -> identical
   * encounters; only the cycle input moves.
   */
  enterNgPlus(): { ok: boolean; cycle?: number; reason?: string } {
    if (this.state !== 'won' && this.state !== 'lost') {
      return { ok: false, reason: 'no completed run' };
    }
    // hardcore-ironman: entering NG+ rebuilds a run on this slot — a
    // dead slot must never be resurrected through the NG+ button (the
    // end screen hides the offer for dead slots; this is defense in
    // depth for direct callers).
    if (isActiveSlotDead()) {
      return { ok: false, reason: 'slot dead' };
    }
    try {
      const p = loadProfile();
      const next = Math.max(0, Math.floor(p.ngPlusCycle ?? 0)) + 1;
      p.ngPlusCycle = next;
      saveProfile(p);
      // Map progress reset (mirrors startRun's origin reset).
      this.spec.meta.seed = this.baseSeed;
      this.reseedPortalOrigin(this.baseSeed);
      this.syncTerrainToSeed();
      this.reseedPortalCache();
      this.worldTier = deriveWorldTier(this.baseSeed, 0);
      if (this.runBuilder) {
        this.resetRun();
        this.state = 'playing';
        this.last = performance.now();
      } else {
        // No blueprint builder (runtime bootstrap skipped it): fall back
        // to the title screen with the new cycle stored — the next
        // startRun picks it up. Same fallback shape as restart().
        this.state = 'title';
        this.showTitle();
      }
      // Chips after the rebuild: resetRun -> hud.resetRun() re-hides the
      // tier chip, so both chips are (re)synced here, not before.
      this.hud.setTier(this.worldTier);
      this.hud.setNgPlus(next);
      return { ok: true, cycle: next };
    } catch {
      return { ok: false, reason: 'profile unavailable' };
    }
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
    // UPGRADE LOOP (new-game-plus): sync the NG+ chip at boot (covers the
    // autostart path, which never passes through beginPlay). Event-driven
    // and cached — a repeat call with the same cycle is a no-op.
    this.hud.setNgPlus(this.getNgPlusCycle());
    // UPGRADE LOOP (hardcore-ironman): the IRONMAN chip starts hidden
    // (boot has no live run; beginPlay re-syncs on run start).
    this.hud.setIronman(false);
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
    // UPGRADE LOOP (new-game-plus): the title line names the live cycle
    // once the player has prestiged (cycle 0 = base game, no suffix).
    const titleLine = profile.ngPlusCycle > 0 ? `${profileLine} · NG+ ${profile.ngPlusCycle}` : profileLine;
    // UPGRADE LOOP (hardcore-ironman): the title line also names the
    // slot's fate — an ironman slot, or a dead one (dead wins: a dead
    // slot's ironman flag is history, its death is the news).
    const ironmanActive = isActiveSlotIronman();
    const slotDead = isActiveSlotDead();
    const modeLine = slotDead ? `${titleLine} · SLOT DEAD`
      : ironmanActive ? `${titleLine} · IRONMAN` : titleLine;
    const today = todayUtcDate();
    const challenge = generateDailyChallenge(today);
    const dailyResult = profile.dailyResults[today] ?? null;
    const equipped = new Set(profile.loadout);
    // gauntlet mode (combat blueprints only): today's pinned gauntlet tuple
    // (pure — same for every player), the boss order line, and the board.
    const gauntletOK = gauntletSupported(g);
    const gauntlet = gauntletOK ? generateGauntlet(gauntletSeedForDate(today)) : null;
    const gauntletBest = profile.gauntletBest ?? 0;
    // UPGRADE LOOP (save-slots): slot picker on the title screen. Slot
    // switches also reload settings — each slot owns its own settings.
    const summaries = slotSummaries();
    const afterSlotSwitch = () => { this.settings.reload(); this.applySettings(); };
    this.hud.showTitle({
      name: this.spec.meta.name,
      premise: nar?.premise ?? this.spec.objective.description,
      controls,
      onStart: () => this.startRun(),
      profileLine: modeLine,
      slots: summaries,
      canNewSlot: summaries.length < MAX_SLOTS,
      onSelectSlot: (id) => { if (setActiveSlotId(id)) afterSlotSwitch(); this.showTitle(); },
      onRenameSlot: (id, name) => { renameSlot(id, name); this.showTitle(); },
      onDeleteSlot: (id) => { deleteSlot(id); afterSlotSwitch(); this.showTitle(); },
      onNewSlot: () => { createSlot(); afterSlotSwitch(); this.showTitle(); },
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
      dailyLabel: dailyResult
        ? `PLAYED — ${dailyResult.score.toLocaleString('en-US')} PTS`
        : `DAILY ${today} — ${goalLabel(challenge.goal)}`,
      dailyPlayed: !!dailyResult,
      dailyChallengeLine: `${goalLabel(challenge.goal)} · ${loadoutLabel(challenge.loadout)}`,
      dailyBoard: challengeBoard(profile, today),
      onDaily: () => this.startDailyRun(),
      gauntletLabel: gauntlet ? `GAUNTLET ${today}` : undefined,
      gauntletLine: gauntlet
        ? `${gauntletLine(gauntlet)}${gauntletBest > 0 ? ` · best ${gauntletBest.toLocaleString('en-US')}` : ''}`
        : undefined,
      gauntletBoard: gauntletOK ? gauntletBoard(profile, today) : undefined,
      onGauntlet: () => this.startGauntletRun(),
      onJournal: () => this.journalPanel.show(),
      onCustomize: () => this.customizationPanel.show(),
      // UPGRADE LOOP (hardcore-ironman): title-screen mode picker.
      ironmanActive,
      slotDead,
      onStartIronman: () => this.startIronmanRun(),
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
    // UPGRADE LOOP (hardcore-ironman): a dead slot has no start path —
    // re-render the title (which shows the dead notice) and stop. The
    // mode comes from the slot: an ironman slot's runs are always
    // ironman, so a reload or RESTART can never downgrade the mode.
    if (isActiveSlotDead()) { this.showTitle(); return; }
    this.ironmanRun = isActiveSlotIronman();
    this.startRunFromTitle();
  }

  /**
   * UPGRADE LOOP (hardcore-ironman): start an ironman run from the
   * title screen, after the picker's explicit confirm step. Marks the
   * active slot ironman (one-way, persisted) and then runs the exact
   * startRun body — the mode flag is the only difference, so an
   * ironman run is byte-identical to a normal run except for the
   * death branch, the score multiplier, and the HUD chip.
   */
  startIronmanRun() {
    if (this.state !== 'title') return;
    if (isActiveSlotDead()) { this.showTitle(); return; }
    markActiveSlotIronman();
    this.ironmanRun = true;
    this.startRunFromTitle();
  }

  /**
   * Shared title-screen run start (startRun's body, minus the mode
   * derivation — startRun derives from the slot, startIronmanRun sets
   * the flag first). Kept as one function so the two entries can never
   * drift apart.
   */
  private startRunFromTitle() {
    // hardcore-ironman: a fresh run starts undead (the flag is set only
    // by a death mid-run, never carried across runs).
    this.ironmanDeath = false;
    // leave any gauntlet run behind: the title background is always the base game
    this.gauntlet?.disarm();
    this.gauntlet = null;
    this.gauntletDate = null;
    this.restoreBaseSpec();
    this.dailyDate = null;
    this.challenge = null;
    this.challengeTracker?.disarm();
    this.challengeTracker = null;
    this.spec.meta.seed = this.baseSeed;
    // PORTALS (merge): a fresh run restarts at the origin map — re-stamp
    // before the terrain sync, then re-seed the LRU the sync cleared.
    this.reseedPortalOrigin(this.baseSeed);
    this.syncTerrainToSeed(); // no-op in the normal flow; restores base terrain after a daily run
    this.reseedPortalCache();
    this.beginPlay();
  }

  /**
   * Daily challenge: the day's tuple (seed / fixed loadout / goal) is
   * generated deterministically from the UTC calendar date, so everyone
   * gets the same run today. Local best + attempt history tracked per day.
   *
   * R2-M1: the seed must drive the WORLD, not just the spawns. The terrain is
   * rebuilt from the daily seed and the run itself is rebuilt too (via
   * resetRun), so attempt 1 and every in-place restart play the identical
   * world: same seed → same terrain + same spawns, every time.
   *
   * One attempt per UTC date per profile: when the profile already holds a
   * completed result for the date, the button is locked and this is a no-op.
   * The optional dateStr pins the challenge date (UTC YYYY-MM-DD) — used by
   * tests/e2e for determinism checks; players always get todayUtcDate().
   */
  startDailyRun(dateStr: string = todayUtcDate()) {
    if (this.state !== 'title') return;
    // hardcore-ironman: daily runs are never ironman, and a dead slot
    // starts nothing at all (the title re-render shows the dead notice).
    if (isActiveSlotDead()) { this.showTitle(); return; }
    this.ironmanRun = false;
    this.ironmanDeath = false;
    if (!this.testMode && loadProfile().dailyResults[dateStr]) return; // attempt used
    const challenge = generateDailyChallenge(dateStr);
    this.dailyDate = dateStr;
    this.challenge = challenge;
    this.challengeTracker?.disarm();
    this.challengeTracker = new ChallengeGoalTracker(this, challenge);
    this.challengeTracker.arm();
    this.spec.meta.seed = challenge.seed;
    // PORTALS (merge): the daily seed is the run's world seed — re-stamp the
    // origin from it before the terrain sync, then re-seed the LRU.
    this.reseedPortalOrigin(this.spec.meta.seed);
    this.syncTerrainToSeed();
    this.reseedPortalCache();
    if (this.runBuilder) this.resetRun();
    this.beginPlay();
  }


  /**
   * Gauntlet mode: a seeded 5-boss run. The gauntlet seed — pinned to the
   * UTC date (GAUNTLET_SALT ^ yyyymmdd, like daily-challenges), or an
   * explicit seed for tests/e2e — drives the world (the R2-M1 path:
   * terrain rebuilt from the seed, run rebuilt via resetRun, so every
   * player gets the identical run). The run's spec is overridden for the
   * mode (a {type:'boss',count:5} objective, no ambient enemies, the boss
   * flag re-pointed per round by the director); toTitle()/startRun()
   * restore the base spec from the snapshot below.
   *
   * Combat blueprints only — the boss encounter lives in the boss-fights
   * wiring (engine.bossWiring); the title screen gates the button on
   * gauntletSupported(), this is defense in depth.
   */
  startGauntletRun(dateStr: string = todayUtcDate()) {
    if (this.state !== 'title') return;
    // hardcore-ironman: gauntlet runs are never ironman; a dead slot
    // starts nothing at all (see startDailyRun).
    if (isActiveSlotDead()) { this.showTitle(); return; }
    this.ironmanRun = false;
    this.ironmanDeath = false;
    if (!gauntletSupported(this.spec.meta.genre)) return;
    const gauntlet: Gauntlet = generateGauntlet(gauntletSeedForDate(dateStr));
    // snapshot the base spec so toTitle()/startRun() can restore it
    this.gauntletBaseSpec = {
      objective: this.spec.objective,
      enemies: this.spec.enemies,
      custom: this.spec.custom,
    };
    this.spec.objective = {
      type: 'boss',
      count: gauntlet.rounds,
      timeLimit: 0,
      description: `GAUNTLET — defeat ${gauntlet.rounds} bosses`,
    };
    // no ambient enemies in gauntlet mode: the director spawns exactly one
    // boss brute per round, so the encounter always binds the round's boss
    this.spec.enemies = [];
    this.spec.meta.seed = gauntlet.seed;
    this.dailyDate = null;
    this.gauntletDate = dateStr;
    // PORTALS (merge): the gauntlet seed is the run's world seed — re-stamp
    // the origin from it before the terrain sync, then re-seed the LRU.
    this.reseedPortalOrigin(this.spec.meta.seed);
    this.syncTerrainToSeed();
    this.reseedPortalCache();
    if (this.runBuilder) this.resetRun();
    this.gauntlet?.disarm();
    this.gauntlet = new GauntletDirector(this, gauntlet);
    this.beginPlay();
    this.gauntlet.start();
  }

  /** Restore the base spec snapshotted by startGauntletRun (no-op otherwise). */
  private restoreBaseSpec(): void {
    const b = this.gauntletBaseSpec;
    if (!b) return;
    this.spec.objective = b.objective;
    this.spec.enemies = b.enemies;
    this.spec.custom = b.custom;
    this.gauntletBaseSpec = null;
  }

  private beginPlay() {
    this.hud.clearOverlays();
    this.audio.unlock();
    this.audio.play('click');
    // cross-run progression: the equipped modifier loadout applies from the
    // very first run, not just after an in-place restart (M1). applyLoadout()
    // is idempotent (restores pristine base values before re-applying), so
    // the resetRun() call below stays valid. A daily challenge run uses its
    // FIXED challenge loadout instead (everyone plays the identical build).
    applyLoadout(this.spec, this.challenge ? challengeProfile(this.challenge) : loadProfile());
    // UPGRADE LOOP (new-game-plus): sync the NG+ chip on every fresh run
    // start (startRun / startDailyRun). A daily run uses the base cycle
    // chip unchanged — the cycle is a profile property, not a challenge
    // property — and the chip is cached, so this is a no-op when idle.
    this.hud.setNgPlus(this.getNgPlusCycle());
    // UPGRADE LOOP (hardcore-ironman): sync the IRONMAN chip the same
    // way — event-driven, cached, zero per-frame cost.
    this.hud.setIronman(this.ironmanRun);
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
    this.resetJournalRun();
    this.state = 'playing';
    this.last = performance.now();
  }

  /**
   * Run-journal: reset the observe-only per-run counters for a fresh run.
   * The wall-clock date is captured once here — at run start — never mid-run
   * and never for gameplay (determinism rule).
   */
  private resetJournalRun(): void {
    this.journalKills = 0;
    this.journalDeaths = 0;
    this.journalPortals = 0;
    this.journalBosses = 0;
    this.journalStartUtc = new Date().toISOString();
    // startRun()/startDailyRun() set spec.meta.seed before beginPlay(), so
    // this captures the real run seed (daily runs: the challenge seed).
    this.journalSeed = this.spec.meta.seed >>> 0;
  }

  /**
   * Run-journal: build this run's journal record from the observe-only
   * counters. Pure — safe to call in testMode (no profile write here).
   */
  private buildJournalEntry(won: boolean): RunJournalEntry {
    return {
      startUtc: this.journalStartUtc || new Date().toISOString(),
      seed: this.journalSeed,
      genre: this.spec.meta.genre,
      duration: Math.max(0, Math.round(this.elapsed)),
      kills: this.journalKills,
      deaths: this.journalDeaths,
      portals: this.journalPortals,
      // runs start at 0 XP (fresh Progression per blueprint build; portal
      // travel keeps the same object), so the live total IS the run's gain.
      xpGained: Math.max(0, Math.floor(this.progression?.xp ?? 0)),
      bossesKilled: this.journalBosses,
      result: won ? 'won' : 'lost',
      // hardcore-ironman: the journal records the mode it was played in.
      ironman: this.ironmanRun,
    };
  }

  /** Back to the title screen, with a fresh run waiting underneath. */
  toTitle() {
    // leave any daily run behind: the title background is always the base game
    this.dailyDate = null;
    // leave any gauntlet run behind: disarm the director (before resetRun,
    // so its onRunRebuilt doesn't re-drive a round) and restore the base spec
    this.gauntlet?.disarm();
    this.gauntlet = null;
    this.gauntletDate = null;
    this.restoreBaseSpec();
    this.challenge = null;
    this.challengeTracker?.disarm();
    this.challengeTracker = null;
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
    // hardcore-ironman: leaving a run clears the mode + death flags and
    // the chip (a fresh title has no live run; the next start re-derives).
    this.ironmanRun = false;
    this.ironmanDeath = false;
    this.hud.setIronman(false);
    this.showTitle();
  }

  /** Aggregate a finished run into the persistent profile. Best-effort. */
  private recordRunResult(won: boolean, stats: Partial<RunStats>): void {
    try {
      const p = loadProfile();
      // UPGRADE LOOP (hardcore-ironman): a WON ironman run records the
      // table-multiplied score (cycle = live NG+ cycle); a lost one
      // records its raw score — the run is a tombstone, not a bonus.
      // The multiplier is a pure table lookup: no RNG, no wall clock.
      const ironmanMult = this.ironmanRun ? ironmanScoreMult(this.getNgPlusCycle()) : 1;
      const recordedScore = this.ironmanRun && won
        ? Math.round(this.score * ironmanMult)
        : Math.round(this.score);
      recordRun(p, {
        genre: this.spec.meta.genre,
        won,
        score: recordedScore,
        level: stats.level ?? 1,
        kills: stats.kills ?? 0,
        timeSeconds: this.elapsed,
        daily: this.dailyDate ?? undefined,
      });
      // daily challenge: score the attempt (time, kills, damage taken).
      // First completed attempt per date wins — later completions are kept
      // out of dailyResults. The attempt is consumed either way: disarm the
      // goal tracker.
      if (this.dailyDate && this.challenge) {
        recordDailyResult(p, this.dailyDate, {
          score: Math.round(this.score),
          kills: this.challengeTracker?.kills ?? stats.kills ?? 0,
          timeSeconds: this.elapsed,
          damageTaken: Math.round(this.damageTaken),
          won,
          goal: this.challenge.goal,
          genre: this.spec.meta.genre,
          seed: this.challenge.seed,
        });
        this.challengeTracker?.disarm();
      }
      // gauntlet mode: score the run (rounds cleared + time + damage taken).
      // Best score per date wins. The director's counters are read here,
      // before any disarm — the constructor's onWin/onLose taps run before
      // a director disarm tap could.
      if (this.gauntlet && this.gauntletDate) {
        const d = this.gauntlet;
        recordGauntletResult(p, this.gauntletDate, {
          roundsCleared: d.roundsCleared,
          kills: d.kills,
          timeSeconds: this.elapsed,
          damageTaken: Math.round(this.damageTaken),
          won,
          genre: this.spec.meta.genre,
          seed: d.gauntlet.seed,
        });
      }
      // run-journal: append the per-run record (observe-only — the
      // aggregate stats above are untouched). recordJournalEntry re-validates
      // and caps; a corrupt profile can never break the run-completion path.
      recordJournalEntry(p, this.buildJournalEntry(won));
      // UPGRADE LOOP (hardcore-ironman): death ends the slot, observed
      // here — not in lose() — so the run-completion path is the single
      // place slots die. Marked BEFORE saveProfile: saveProfile reloads
      // the store and overwrites only the slot's profile object, so the
      // dead flag survives the save that follows.
      if (this.ironmanRun && !won && this.ironmanDeath) markActiveSlotDead();
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
    // run-journal: the recap shows the same observed counts the journal
    // entry records (caller-provided stats still win on explicit overlap).
    const wonJournal = this.buildJournalEntry(true);
    // hardcore-ironman: the end screen shows the multiplied score (the
    // same value recordRunResult stored), unless the caller passed an
    // explicit score — caller-provided stats still win, per convention.
    const wonMult = this.ironmanRun ? ironmanScoreMult(this.getNgPlusCycle()) : 1;
    this.hud.showEnd(true, {
      score: this.ironmanRun && stats.score === undefined ? Math.round(this.score * wonMult) : this.score,
      time: this.elapsed,
      kills: wonJournal.kills,
      level: 1,
      stagesCleared: 0,
      deaths: wonJournal.deaths,
      portals: wonJournal.portals,
      xpGained: wonJournal.xpGained,
      bossesKilled: wonJournal.bossesKilled,
      seed: wonJournal.seed,
      ...stats,
      ironman: this.ironmanRun,
      ironmanMult: this.ironmanRun ? wonMult : undefined,
    }, winText, { targetCycle: this.getNgPlusCycle() + 1, onEnter: () => this.enterNgPlus() });
  }

  lose(reason = '', stats: Partial<RunStats> = {}) {
    if (this.state !== 'playing') return;
    this.state = 'lost';
    this.audio.setEngine(0, false);
    this.audio.pauseMusic(); // combat music must not play under the defeat screen (M3)
    this.audio.play('lose');
    this.hooks.emit('onLose', { reason, stats });
    const lostJournal = this.buildJournalEntry(false);
    // hardcore-ironman: a death-ended run marks the slot dead in
    // recordRunResult (already run via the onLose tap above); the end
    // screen hides RESTART and any NG+ offer for it — a dead slot has
    // no next run to offer. Non-death defeats (time-out) keep the slot.
    const ironmanDied = this.ironmanRun && this.ironmanDeath;
    const lostMult = this.ironmanRun ? ironmanScoreMult(this.getNgPlusCycle()) : 1;
    this.hud.showEnd(false, {
      score: this.score,
      time: this.elapsed,
      kills: lostJournal.kills,
      level: 1,
      stagesCleared: 0,
      reason,
      deaths: lostJournal.deaths,
      portals: lostJournal.portals,
      xpGained: lostJournal.xpGained,
      bossesKilled: lostJournal.bossesKilled,
      seed: lostJournal.seed,
      ...stats,
      ironman: this.ironmanRun,
      ironmanMult: this.ironmanRun ? lostMult : undefined,
      ironmanDead: ironmanDied,
    }, undefined, ironmanDied ? undefined : { targetCycle: this.getNgPlusCycle() + 1, onEnter: () => this.enterNgPlus() });
  }

  /**
   * In-place restart: tear down everything the blueprint built and rebuild
   * the run from the same spec+seed (deterministic — same seed = same run).
   * Falls back to a page reload when no run builder was registered.
   */
  restart() {
    // hardcore-ironman: a dead slot never rebuilds — back to the title
    // (which shows the dead notice) instead. The end screen hides
    // RESTART for dead slots, so this is defense in depth (pause menu).
    if (isActiveSlotDead()) { this.toTitle(); return; }
    if (!this.runBuilder) {
      // No blueprint builder was registered (runtime bootstrap skipped it):
      // the only option is a plain page reload. (R2-N12: the old
      // 'xandria.restart' sessionStorage flag was write-only — nothing ever
      // read it — so it was removed rather than left as dead state.)
      location.reload();
      return;
    }
    this.resetRun();
    this.resetJournalRun();
    this.state = 'playing';
    this.last = performance.now();
  }

  /**
   * Tear down blueprint state back to the post-construction baseline, then
   * re-run the registered blueprint builder. Deterministic: rng re-seeded,
   * particles cleared, physics/scene/hooks restored.
   */
  private resetRun() {
    // run-journal: drop the stale Progression ref before the rebuild — the
    // blueprint re-publishes engine.progression on build; genres without an
    // XP side leave it null so no XP leaks across runs.
    this.progression = null;
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
    // UPGRADE LOOP (minimap-fog): a fresh run replays the identical
    // exploration, so every map's fog + landmark discovery state is dropped.
    this.minimap.resetRun();
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
    this.damageTaken = 0;
    this.frame = 0;
    // Workstream E: a rebuilt run starts a fresh measurement window — the old
    // run's frame times must not leak into the new run's rolling variance.
    this.perf.reset();
    this.pauseReason = null;
    this.last = performance.now();
    // cross-run progression: apply the equipped modifier loadout to this
    // run's config (never to the seed — determinism is preserved). A daily
    // challenge run uses its FIXED challenge loadout instead (everyone
    // plays the identical build).
    applyLoadout(this.spec, this.challenge ? challengeProfile(this.challenge) : loadProfile());
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
    // Gauntlet mode: an in-place rebuild starts the world boss-less — the
    // director re-drives the current round (fresh arena + boss) so the run
    // continues. No-op outside gauntlet runs (and on the initial build,
    // where the director doesn't exist yet).
    this.gauntlet?.onRunRebuilt();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    removeEventListener('pointerdown', this.audioUnlockHandler);
    removeEventListener('keydown', this.audioUnlockHandler);
    this.resizeObs.disconnect();
    this.input.dispose();
    this.touch.dispose();
    this.audio.dispose();
    // UPGRADE LOOP (minimap-fog): remove the minimap DOM + key listener + hook tap.
    this.minimap.dispose();
    this.journalPanel.dispose();
    this.assetBridge.dispose();
    // PORTALS-B: tear down the portal overlay + update hook.
    this.portalManager?.dispose();
    this.portalManager = null;
    this.postfx.dispose();
    this.farTerrain?.dispose();
    this.renderer.dispose();
  }
}
