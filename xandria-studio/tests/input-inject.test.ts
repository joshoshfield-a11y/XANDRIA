/**
 * R2-N14 regression tests: Input.inject() edge-trigger semantics (automation-only).
 *
 * Documented contract (see Input.inject): inject() HOLDS a set of actions
 * until changed, mirroring a physical key. `justPressed` fires only for
 * actions newly added relative to the previously injected set — re-injecting
 * an already-held action produces no new edge. Release with `inject([])`
 * (or input.reset()) to re-arm, or use tap() for a one-shot edge with no hold.
 *
 * The M9 engine tests and the playability e2e rely on this hold contract, so
 * it is pinned here rather than "fixed" into per-call edges.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Input } from '../src/engine/core/Input';

function stubEl(): any {
  return {
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

beforeEach(() => {
  const noop = () => {};
  (globalThis as any).window = { addEventListener: noop, removeEventListener: noop, innerWidth: 800 };
  (globalThis as any).document = { addEventListener: noop, removeEventListener: noop };
});

describe('R2-N14 Input.inject() edge semantics', () => {
  it('first inject produces an edge and a hold', () => {
    const input = new Input(stubEl());
    input.inject(['jump']);
    expect(input.justPressed('jump')).toBe(true);
    expect(input.pressed('jump')).toBe(true);
  });

  it('back-to-back identical injects produce no second edge, hold persists', () => {
    const input = new Input(stubEl());
    input.inject(['jump']);
    input.endFrame();                    // frame consumed the edge
    input.inject(['jump']);              // re-inject the still-held action
    expect(input.justPressed('jump')).toBe(false);  // the documented quirk
    expect(input.pressed('jump')).toBe(true);       // ...but the hold persists
  });

  it('inject([]) releases, so a re-inject re-arms the edge', () => {
    const input = new Input(stubEl());
    input.inject(['jump']);
    input.endFrame();
    input.inject([]);
    expect(input.pressed('jump')).toBe(false);
    input.inject(['jump']);              // simulates a second key press
    expect(input.justPressed('jump')).toBe(true);
    expect(input.pressed('jump')).toBe(true);
  });

  it('only newly added actions get an edge when the set grows', () => {
    const input = new Input(stubEl());
    input.inject(['forward']);
    input.endFrame();
    input.inject(['forward', 'jump']);   // forward still held, jump is new
    expect(input.justPressed('forward')).toBe(false);
    expect(input.justPressed('jump')).toBe(true);
  });

  it('tap() gives a one-shot edge with no hold', () => {
    const input = new Input(stubEl());
    input.tap('attack');
    expect(input.justPressed('attack')).toBe(true);
    expect(input.pressed('attack')).toBe(false);
  });
});
