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
import { HUD } from './game/HUD';

export type EngineState = 'loading' | 'ready' | 'playing' | 'paused' | 'won' | 'lost';

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
  readonly audio: AudioEngine;
  readonly particles: Particles;
  readonly hud: HUD;
  readonly rng: Rng;
  readonly postfx: PostFX;
  sky!: SkyRig;
  terrain!: Terrain;
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

  constructor(container: HTMLElement, spec: GameSpec, opts: EngineOptions = {}) {
    this.container = container;
    this.spec = spec;
    this.testMode = opts.testMode ?? new URLSearchParams(location.search).has('test');
    this.rng = new Rng(spec.meta.seed);

    this.renderer = new THREE.WebGLRenderer({ antialias: !spec.theme.retroFilter, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const pr = spec.theme.retroFilter ? Math.min(devicePixelRatio, 1) * 0.66 : Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(66, (container.clientWidth || innerWidth) / (container.clientHeight || innerHeight), 0.1, 1400);
    this.physics = new Physics(spec.world.gravity);
    this.mats = new MaterialLibrary(spec);
    this.input = new Input(this.renderer.domElement);
    this.audio = new AudioEngine(spec);
    this.particles = new Particles(this.scene, spec.meta.seed ^ 0x9a77);
    this.hud = new HUD(container, spec);
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
    this.state = 'ready';
  }

  onUpdate(fn: (dt: number) => void) { this.updateHooks.push(fn); return () => { this.updateHooks = this.updateHooks.filter((f) => f !== fn); }; }

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
    this.state = 'playing';
    this.last = performance.now();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      let dt = this.testMode ? 1 / 60 : Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  step(dt: number) {
    this.frame++;
    this.input.beginFrame();
    if (this.state === 'playing') {
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
    }
    if (this.input.justPressed('pause')) this.togglePause();
    this.sky.update(dt, this.camera.getWorldPosition(new THREE.Vector3()));
    this.postfx.render();
    this.input.endFrame();
  }

  togglePause() {
    if (this.state === 'playing') { this.state = 'paused'; this.hud.showPause(); }
    else if (this.state === 'paused') { this.state = 'playing'; this.hud.hidePause(); this.last = performance.now(); }
  }

  win() {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this.audio.play('win');
    this.hud.showEnd(true, this.score, this.elapsed);
  }

  lose(reason = '') {
    if (this.state !== 'playing') return;
    this.state = 'lost';
    this.audio.play('lose');
    this.hud.showEnd(false, this.score, this.elapsed, reason);
  }

  restart() {
    try { sessionStorage.setItem('xandria.restart', '1'); } catch { /* ignore */ }
    location.reload();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.resizeObs.disconnect();
    this.input.dispose();
    this.audio.dispose();
    this.postfx.dispose();
    this.renderer.dispose();
  }
}
