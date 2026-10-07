/**
 * Engine-kernel regression tests for the launch-blocker wave:
 *  M1  modifier loadout applies on the FIRST run (not just after restart)
 *  M3  generative music stops on pause/victory/defeat, resumes on unpause/restart
 *  M7a resetRun() disposes blueprint-created materials/textures (not shared cache entries)
 *  M7b Input.reset() clears a held touch stick
 *  M7c Engine.dispose() removes the window audio-unlock listeners
 *  M9  edge-triggered inputs survive substeps in testMode (Escape/P can pause in ?test=1)
 *  B4  day/dusk/dawn sky dome fits inside the camera far plane
 *
 * WebGLRenderer is stubbed and engine.postfx is replaced with a no-op so
 * step() never touches GL. DOM is hand-stubbed (no jsdom) — same pattern as
 * flow.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      tag,
      children: [] as any[],
      style: {} as Record<string, string>,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '',
      className: '',
      value: '',
      checked: false,
      innerHTML: '',
      appendChild(c: any) { el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {
        const p = (el as any).parent;
        if (p && Array.isArray(p.children)) {
          const i = p.children.indexOf(el);
          if (i >= 0) p.children.splice(i, 1);
        }
      },
      setAttribute() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
      removeEventListener(t: string, fn: Function) {
        const l = listeners[t];
        if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
      },
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      __listeners: listeners,
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas');
    shadowMap: any = {};
    toneMapping: any = null;
    toneMappingExposure = 1;
    setPixelRatio() {}
    setSize() {}
    getPixelRatio() { return 1; }
    getSize() { return { width: 800, height: 600 }; }
    dispose() {}
    render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { Input } from '../src/engine/core/Input';
import { AudioEngine } from '../src/engine/core/Audio';
import { createAtmosphere } from '../src/engine/gfx/Atmosphere';
import { createSky } from '../src/engine/gfx/Sky';
import { generateSpec } from '../src/generator/generate';
import { _setProfileStorage, defaultProfile, saveProfile } from '../src/engine/game/Profile';
import type { GameSpec } from '../src/spec/schema';

/* ---------------- harness ---------------- */

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

/** Minimal fake AudioContext: enough for tone()/noise()/setEngine() to run. */
function fakeAudioCtx(): any {
  const param = () => ({
    setValueAtTime() {}, linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {}, setTargetAtTime() {}, value: 0,
  });
  return {
    currentTime: 0,
    sampleRate: 44100,
    createOscillator: () => ({ type: '', frequency: param(), detune: param(), connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: param(), connect() {}, disconnect() {} }),
    createBiquadFilter: () => ({ type: '', frequency: param(), connect() {} }),
    createBuffer: (_ch: number, len: number, _sr: number) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), connect() {} }),
  };
}

beforeEach(() => {
  const head = makeEl('head');
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head,
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as any).localStorage = memStore();
  (globalThis as any).window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: vi.fn(() => 42),
    clearInterval: vi.fn(),
  };
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1;
  (globalThis as any).innerWidth = 800;
  (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
  _setProfileStorage(memStore() as any);
});

function makeEngine(spec?: GameSpec): Engine {
  const s = spec ?? generateSpec('neon fps arena at night', { seed: 42 });
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, s, { testMode: true, noTerrain: true });
  // unit tests never touch GL
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  return engine;
}

/* ---------------- M1 ---------------- */

describe('M1 modifier loadout on first run', () => {
  it('applies the equipped loadout in startRun() without any restart', () => {
    const p = defaultProfile();
    p.owned = ['vitality', 'swift', 'power', 'secondwind'];
    p.loadout = [...p.owned];
    saveProfile(p);

    const spec = generateSpec('neon fps arena at night', { seed: 42 });
    const baseHealth = spec.player.health;
    const baseSpeed = spec.player.speed;
    const baseLives = spec.rules.lives;
    const engine = makeEngine(spec);

    (engine as any).state = 'title';
    engine.startRun(); // first run — no resetRun()/restart() involved

    expect(engine.state).toBe('playing');
    expect(spec.player.health).toBe(baseHealth + 25); // vitality
    expect(spec.player.speed).toBeCloseTo(baseSpeed * 1.08, 10); // swift
    expect(spec.rules.lives).toBe(baseLives + 1); // secondwind
    expect((spec.custom as any).profileDamageMult).toBe(1.1); // power
  });
});

/* ---------------- M3 ---------------- */

describe('M3 generative music lifecycle', () => {
  const audioSpec = () =>
    ({
      meta: { seed: 7 },
      audio: { sfxVolume: 0.8, musicVolume: 0.6, music: true, tempo: 100, mode: 'minor', key: 0, mood: 'dark' },
    }) as unknown as GameSpec;

  it('pauseMusic/resumeMusic start and stop the scheduler without tearing down the context', () => {
    const audio = new AudioEngine(audioSpec());
    (audio as any).ctx = fakeAudioCtx();
    (audio as any).startMusic();
    expect((audio as any).musicTimer).not.toBeNull();

    audio.pauseMusic();
    expect((audio as any).musicTimer).toBeNull();
    expect((globalThis as any).window.clearInterval).toHaveBeenCalledWith(42);

    audio.resumeMusic();
    expect((globalThis as any).window.setInterval).toHaveBeenCalledTimes(2);
    expect((audio as any).musicTimer).not.toBeNull();

    // idempotent: no double-scheduling, safe to pause twice
    audio.resumeMusic();
    expect((globalThis as any).window.setInterval).toHaveBeenCalledTimes(2);
    audio.pauseMusic();
    audio.pauseMusic();
    expect((audio as any).musicTimer).toBeNull();

    // never started -> resume is a no-op (no context / music off)
    const idle = new AudioEngine(audioSpec());
    idle.resumeMusic();
    expect((idle as any).musicTimer).toBeNull();
  });

  it('Engine pause/resume/win/lose wire the music scheduler', () => {
    const spec = generateSpec('neon fps arena at night', { seed: 42 });
    spec.audio.music = true;
    const engine = makeEngine(spec);
    (engine.audio as any).ctx = fakeAudioCtx();
    (engine.audio as any).startMusic();
    const timer = () => (engine.audio as any).musicTimer;
    expect(timer()).not.toBeNull();

    engine.state = 'playing';
    engine.pause('menu');
    expect(engine.state).toBe('paused');
    expect(timer()).toBeNull(); // M3: no combat music under the pause menu

    engine.resume();
    expect(engine.state).toBe('playing');
    expect(timer()).not.toBeNull(); // resumes on unpause

    engine.state = 'playing';
    engine.win();
    expect(engine.state).toBe('won');
    expect(timer()).toBeNull(); // M3: no combat music under victory

    (engine.audio as any).startMusic();
    engine.state = 'playing';
    engine.lose('test');
    expect(engine.state).toBe('lost');
    expect(timer()).toBeNull(); // M3: no combat music under defeat
  });
});

/* ---------------- M7a ---------------- */

describe('M7a resetRun GPU disposal', () => {
  it('disposes blueprint-created geometries/materials/textures, spares shared cache entries', () => {
    const engine = makeEngine();
    const seen: Array<{ mat: THREE.MeshStandardMaterial; geo: THREE.BufferGeometry; tex: THREE.Texture }> = [];
    engine.setRunBuilder((e: Engine) => {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: '#ff0000' });
      const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
      mat.map = tex;
      e.scene.add(new THREE.Mesh(geo, mat));
      e.scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), e.mats.flat('#00ff00')));
      seen.push({ mat, geo, tex });
      return {};
    });

    (engine as any).resetRun(); // build #1
    const first = seen[0];
    const matDispose = vi.spyOn(first.mat, 'dispose');
    const geoDispose = vi.spyOn(first.geo, 'dispose');
    const texDispose = vi.spyOn(first.tex, 'dispose');
    const cachedDispose = vi.spyOn(engine.mats.flat('#00ff00'), 'dispose');

    (engine as any).resetRun(); // teardown build #1, build #2

    expect(matDispose).toHaveBeenCalled();
    expect(geoDispose).toHaveBeenCalled();
    expect(texDispose).toHaveBeenCalled();
    expect(cachedDispose).not.toHaveBeenCalled(); // shared MaterialLibrary entry survives
  });
});

/* ---------------- M7b ---------------- */

describe('M7b Input.reset', () => {
  it('clears a held touch stick', () => {
    const input = new Input(makeEl('canvas'));
    input.setMoveStick({ lx: 0.8, ly: -0.4 });
    expect(input.axes.x).toBeCloseTo(0.8, 6);
    input.reset();
    expect(input.axes.x).toBe(0);
    expect(input.axes.y).toBe(0);
  });
});

/* ---------------- M7c ---------------- */

describe('M7c Engine.dispose', () => {
  it('removes the window audio-unlock listeners added in the constructor', () => {
    const added: Array<[string, Function]> = [];
    const removed: Array<[string, Function]> = [];
    (globalThis as any).addEventListener = (t: string, fn: Function) => { added.push([t, fn]); };
    (globalThis as any).removeEventListener = (t: string, fn: Function) => { removed.push([t, fn]); };

    const engine = makeEngine();
    const unlocks = added.filter(([t]) => t === 'pointerdown' || t === 'keydown');
    expect(unlocks.length).toBe(2);

    engine.dispose();
    for (const u of unlocks) expect(removed).toContainEqual(u);
    expect(removed.length).toBe(2);
  });
});

/* ---------------- M9 ---------------- */

describe('M9 edge-triggered input in testMode', () => {
  it('injected pause survives all substeps and pauses (substeps=10)', () => {
    const engine = makeEngine();
    engine.state = 'playing';
    engine.input.inject(['pause']);
    engine.step(1 / 60);
    expect(engine.state).toBe('paused');
  });

  it('production single-substep ordering is unchanged (substeps=1)', () => {
    const engine = makeEngine();
    (engine as any).testMode = false; // production path: exactly one substep
    engine.state = 'playing';
    engine.input.inject(['pause']);
    engine.step(1 / 60);
    expect(engine.state).toBe('paused');
    // the edge is still consumed once per frame afterwards
    engine.state = 'playing';
    engine.step(1 / 60);
    expect(engine.state).toBe('playing');
  });
});

/* ---------------- B4 ---------------- */

describe('B4 sky dome vs camera far plane', () => {
  it('day sky dome fits comfortably inside the camera far plane (1400)', () => {
    const spec = generateSpec('a heroic knight adventure', { seed: 7 });
    expect(spec.theme.timeOfDay).toBe('day');
    const rig = createAtmosphere(spec);
    expect(rig.dome.scale.x).toBeLessThan(1400); // Engine.ts camera far
    expect(rig.dome.scale.x).toBe(1000);
    rig.dispose();
  });

  it('night dome is unchanged (radius 900)', () => {
    const spec = generateSpec('neon fps arena at night', { seed: 7 });
    expect(spec.theme.timeOfDay).toBe('night');
    const rig = createSky(spec, new THREE.Scene());
    const dome = rig.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    expect((dome.geometry as THREE.SphereGeometry).parameters.radius).toBe(900);
    rig.dispose();
  });
});
