/**
 * R2-N1 regression tests: in testMode (10 substeps/frame) an edge-triggered
 * input must fire exactly once per rendered frame, not once per substep.
 *
 *  - a single injected `jump` edge reaches update hooks exactly once
 *  - pause/confirm edges still work in testMode (the M9 fix is preserved:
 *    edges are snapshotted before the substep loop and the engine-level
 *    checks read the snapshot)
 *  - production (substeps=1) ordering is unchanged: the clear guard never fires
 *
 * Same hand-stubbed DOM / stubbed WebGLRenderer harness as engine.test.ts.
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

function makeEngine(): Engine {
  const spec = generateSpec('neon fps arena at night', { seed: 42 });
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true, noTerrain: true });
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  return engine;
}

describe('R2-N1 testMode edges fire once per frame', () => {
  it('a single injected jump edge reaches update hooks exactly once (not 10x)', () => {
    const engine = makeEngine();
    let edges = 0;
    engine.onUpdate(() => { if (engine.input.justPressed('jump')) edges++; });
    engine.state = 'playing';
    engine.input.inject(['jump']);
    engine.step(1 / 60);
    expect(edges).toBe(1);
    // and the edge does not leak into the next frame
    engine.step(1 / 60);
    expect(edges).toBe(1);
  });

  it('pause edge still toggles pause exactly once in testMode (M9 preserved)', () => {
    const engine = makeEngine();
    engine.state = 'playing';
    engine.input.inject(['pause']);
    engine.step(1 / 60);
    // 10 toggles would land back on 'playing'; one toggle lands on 'paused'
    expect(engine.state).toBe('paused');
  });

  it('confirm edge still starts the run from title in testMode (M9 preserved)', () => {
    const engine = makeEngine();
    engine.state = 'title';
    engine.input.inject(['confirm']);
    engine.step(1 / 60);
    expect(engine.state).toBe('playing');
  });

  it('production (substeps=1) still fires an edge exactly once per step', () => {
    const engine = makeEngine();
    (engine as any).testMode = false; // production path: exactly one substep
    let edges = 0;
    engine.onUpdate(() => { if (engine.input.justPressed('jump')) edges++; });
    engine.state = 'playing';
    engine.input.inject(['jump']);
    engine.step(1 / 60);
    expect(edges).toBe(1);
  });
});
