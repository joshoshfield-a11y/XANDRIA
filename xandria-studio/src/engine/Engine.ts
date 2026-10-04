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
import { MaterialLibrary } from './gfx/Materials';
import { createSky, type SkyRig } from './gfx/Sky';
import { Particles } from './gfx/Particles';
import { PostFX } from './gfx/PostFX';
import { Terrain } from './world/Terrain';
import { HUD, type RunStats } from './game/HUD';
import { AssetBridge } from './gfx/AssetBridge';
import { Settings } from './game/Settings';
import { Juice } from './game/Juice';
import { Modding } from './game/Modding';
import { TouchControls, isTouchDevice } from './game/TouchControls';
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
  sky!: SkyRig;
  terrain!: Terrain;
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
  /** blueprint rebuild fn, registered by the runtime bootstrap (enables in-place restart) */
  private runBuilder: ((e: Engine) => unknown) | null = null;
  /** hooks that survive restart() (runtime bootstrap); blueprint hooks are torn down */
  private persistentHooks = new Set<(dt: number) => void>();
  private pauseReason: 'menu' | 'modal' | null = null;
  private sceneBaseline = 0;
  private physicsBodiesBaseline = 0;
  private physicsConstraintsBaseline = 0;
  private shakeVec = new THREE.Vector3();
  /** the spec's original seed — daily runs temporarily override spec.meta.seed */
  private baseSeed: number;
  /** YYYY-MM-DD while a daily-challenge run is active; null otherwise */
  private dailyDate: string | null = null;

  constructor(container: HTMLElement, spec: GameSpec, opts: EngineOptions = {}) {
    this.container = container;
    this.spec = spec;
    this.testMode = opts.testMode ?? new URLSearchParams(location.search).has('test');
    this.rng = new Rng(spec.meta.seed);
    this.settings = new Settings();

    this.renderer = new THREE.WebGLRenderer({ antialias: !(spec.theme.retroFilter && (spec.custom?.quality ?? 'retro') === 'retro'), powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const quality = this.effectiveQuality();
    const pr = quality === 'high' ? Math.min(devicePixelRatio, 2)
      : quality === 'standard' ? Math.min(devicePixelRatio, 1.5)
      : spec.theme.retroFilter ? Math.min(devicePixelRatio, 1) * 0.66
      : Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(66, (container.clientWidth || innerWidth) / (container.clientHeight || innerHeight), 0.1, 1400);
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
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, spec);

    this.sky = createSky(spec, this.scene);
    this.renderer.toneMappingExposure = this.sky.exposure;
    if (!opts.noTerrain) {
      this.terrain = new Terrain(spec, this.physics, this.mats, this.scene, {
        flatCenters: opts.flatCenters,
        flatRadius: opts.flatRadius,
      });
    }

    // audio unlock on first gesture
    const unlock = () => { if (!this.testMode) this.audio.unlock(); };
    addEventListener('pointerdown', unlock, { once: false });
    addEventListener('keydown', unlock, { once: false });

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

    // cross-run progression: the seed this spec shipped with (daily runs
    // override it temporarily; toTitle()/startRun() restore it)
    this.baseSeed = spec.meta.seed;

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

  /** Effective render quality: settings override, else the spec hint. */
  effectiveQuality(): 'retro' | 'standard' | 'high' {
    const q = this.settings.data.quality;
    if (q !== 'auto') return q;
    const sq = this.spec.custom?.quality;
    return sq === 'high' || sq === 'standard' ? sq : 'retro';
  }

  /** Apply settings to audio + renderer (called on boot and from the pause menu). */
  applySettings() {
    this.audio.setVolume(this.settings.data.volume);
    this.audio.setMuted(this.settings.data.muted);
    const quality = this.effectiveQuality();
    const pr = quality === 'high' ? Math.min(devicePixelRatio, 2)
      : quality === 'standard' ? Math.min(devicePixelRatio, 1.5)
      : this.spec.theme.retroFilter ? Math.min(devicePixelRatio, 1) * 0.66
      : Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
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
  startRun() {
    if (this.state !== 'title') return;
    this.dailyDate = null;
    this.spec.meta.seed = this.baseSeed;
    this.beginPlay();
  }

  /**
   * Daily challenge: the seed is derived deterministically from the calendar
   * date, so everyone gets the same run today. Local best tracked per day.
   */
  startDailyRun() {
    if (this.state !== 'title') return;
    this.dailyDate = todayLocalDate();
    this.spec.meta.seed = dailySeed(this.dailyDate);
    this.beginPlay();
  }

  private beginPlay() {
    this.hud.clearOverlays();
    this.audio.unlock();
    this.audio.play('click');
    this.state = 'playing';
    this.last = performance.now();
  }

  /** Back to the title screen, with a fresh run waiting underneath. */
  toTitle() {
    // leave any daily run behind: the title background is always the base game
    this.dailyDate = null;
    this.spec.meta.seed = this.baseSeed;
    if (this.runBuilder) this.resetRun();
    else this.hud.clearOverlays();
    this.audio.setIntensity(0.5);
    this.audio.setEngine(0, false);
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
    this.input.beginFrame();
    if (this.state === 'playing' && !this.juice.hitStopActive()) {
      // testMode: advance many sim steps per rendered frame so headless/SwiftShader
      // runs at full simulation speed regardless of render rate.
      const substeps = this.testMode ? 10 : 1;
      for (let s = 0; s < substeps; s++) {
        this.time += dt;
        this.elapsed += dt;
        this.physics.step(dt);
        for (const f of this.updateHooks) f(dt);
        // edge-triggered input is consumed by the first substep only
        if (s === 0 && substeps > 1) this.input.endFrame();
      }
      this.particles.update(dt * substeps);
      this.hud.update(dt);
      this.hooks.emit('onTick', { dt, t: this.elapsed });
    }
    if (this.state === 'title' && this.input.justPressed('confirm')) this.startRun();
    if (this.input.justPressed('pause')) this.togglePause();
    this.touch.setVisible(this.state === 'playing');
    this.juice.update(dt, this.camera);
    this.sky.update(dt, this.camera.getWorldPosition(new THREE.Vector3()));
    // screenshake: offset around the render only, never accumulates into the camera
    const off = this.juice.shakeOffset(this.shakeVec);
    this.camera.position.add(off);
    this.postfx.render();
    this.camera.position.sub(off);
    this.input.endFrame();
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
      this.last = performance.now();
    }
  }

  /** Resume the sim after pause(). */
  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.pauseReason = null;
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
      try { sessionStorage.setItem('xandria.restart', '1'); } catch { /* ignore */ }
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
    // remove blueprint scene objects (dispose their geometries)
    for (let i = this.scene.children.length - 1; i >= this.sceneBaseline; i--) {
      const o = this.scene.children[i];
      this.scene.remove(o);
      o.traverse((c: THREE.Object3D) => {
        const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        g?.dispose();
      });
    }
    // physics back to baseline
    this.physics.resetToBaseline(this.physicsBodiesBaseline, this.physicsConstraintsBaseline);
    // deterministic state
    this.rng.reseed(this.spec.meta.seed);
    this.particles.reset(this.spec.meta.seed ^ 0x9a77);
    this.particles.setWeather(this.spec.theme.weather, this.spec.meta.seed);
    // HUD / juice / input
    this.hud.resetRun();
    this.juice.reset();
    this.input.reset();
    // audio
    this.audio.setEngine(0, false);
    this.audio.setIntensity(0.5);
    // clocks
    this.time = 0;
    this.elapsed = 0;
    this.score = 0;
    this.frame = 0;
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
    this.resizeObs.disconnect();
    this.input.dispose();
    this.touch.dispose();
    this.audio.dispose();
    this.assetBridge.dispose();
    this.postfx.dispose();
    this.renderer.dispose();
  }
}
