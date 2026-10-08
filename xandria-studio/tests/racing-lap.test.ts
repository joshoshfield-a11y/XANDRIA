/**
 * R2-M3 regression tests: the racing lap debounce is track-length-aware and a
 * discarded lap is never silent.
 *
 * Old behavior: a fixed `lapTime > 10` gate silently discarded legitimate
 * sub-10s laps (short track + fast car) — no progress, no feedback,
 * potentially unwinnable. New behavior: the debounce floor comes from
 * minLapTimeForTrack(trackLen) and every discard fires a HUD toast.
 *
 * Full-engine harness: hand-stubbed DOM + fake WebGLRenderer, same pattern as
 * tests/engine.test.ts. The car is teleported to curve params just before /
 * after the start line to drive the wrap branch deterministically.
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
        const l = listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
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

import { Engine } from '../src/engine/Engine';
import { generateSpec } from '../src/generator/generate';
import { buildRacing, minLapTimeForTrack } from '../src/blueprints/racing';
import { _setProfileStorage } from '../src/engine/game/Profile';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
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

type RacingRun = ReturnType<typeof buildRacing>;

function makeRacingRun() {
  const spec = generateSpec('neon street race', { seed: 11 });
  expect(spec.meta.genre).toBe('racing');
  spec.world.terrain.size = 160; // short track: the regime the old 10s gate broke
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true });
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  (engine as any).state = 'playing';
  const built = buildRacing(engine, spec);
  return { engine, spec, built };
}

/** Park the car exactly on the track at curve param t (XZ drives nearestT). */
function placeCarAt(built: RacingRun, t: number) {
  const p = built.track.curve.getPointAt(t);
  built.car.chassis.position.set(p.x, p.y + 1, p.z);
  built.car.chassis.velocity.set(0, 0, 0);
  built.car.chassis.angularVelocity.set(0, 0, 0);
}

const toastText = (engine: Engine) => (engine.hud as any).toastEl.textContent as string;
const progressText = (engine: Engine) => (engine.hud as any).objProg.textContent as string;

describe('minLapTimeForTrack', () => {
  it('floors at 2s for very short tracks', () => {
    expect(minLapTimeForTrack(50)).toBe(2);
    expect(minLapTimeForTrack(150)).toBe(2);
  });

  it('scales with track length', () => {
    expect(minLapTimeForTrack(600)).toBeGreaterThan(minLapTimeForTrack(300));
    expect(minLapTimeForTrack(300)).toBeCloseTo(3, 10);
    expect(minLapTimeForTrack(600)).toBeCloseTo(6, 10);
  });

  it('a short track gets a threshold under a realistic fast lap and under the old 10s gate', () => {
    // 300m at the car's ~42 m/s top speed ≈ 7.1s/lap — the old fixed 10s
    // debounce discarded every such lap; the new threshold must not.
    const t = minLapTimeForTrack(300);
    expect(t).toBeLessThan(7.1);
    expect(t).toBeLessThan(10);
    expect(t).toBeGreaterThan(1); // still above spurious sub-second wraps
  });
});

describe('R2-M3 lap counting on a short track', () => {
  it('counts a legitimate fast lap that the old 10s gate would have discarded', () => {
    const { engine, built } = makeRacingRun();
    const trackLen = built.track.curve.getLength();
    const minLap = minLapTimeForTrack(trackLen);
    // sanity: this track is in the regime the old fixed gate broke
    expect(trackLen).toBeLessThan(400);
    expect(minLap).toBeLessThan(10);

    placeCarAt(built, 0.95);
    engine.step(1 / 60); // lastT ≈ 0.95, no wrap yet

    // accumulate a credible lap time that stays UNDER the old 10s gate
    const dtPerStep = 10 / 60; // testMode runs 10 substeps per step()
    const steps = Math.ceil((minLap + 1.5) / dtPerStep);
    for (let i = 0; i < steps; i++) engine.step(1 / 60);

    const scoreBefore = engine.score;
    placeCarAt(built, 0.02);
    engine.step(1 / 60); // wrap: lastT 0.95 → 0.02

    expect(engine.score - scoreBefore).toBe(500); // lap counted
    expect(toastText(engine)).toMatch(/LAP 2/);
    expect(progressText(engine)).toContain('LAP 2 / 3');
  });

  it('discards a spurious sub-second wrap AND tells the player', () => {
    const { engine, built } = makeRacingRun();

    placeCarAt(built, 0.95);
    engine.step(1 / 60);
    const scoreBefore = engine.score;
    placeCarAt(built, 0.02);
    engine.step(1 / 60); // lapTime ≈ 0.33s — a jitter-grade wrap

    expect(engine.score).toBe(scoreBefore); // not counted
    expect(toastText(engine)).toContain('NOT COUNTED'); // never silent
    expect(progressText(engine)).toContain('LAP 1 / 3'); // no phantom progress
  });
});
