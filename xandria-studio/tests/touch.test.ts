import { describe, it, expect, afterEach } from 'vitest';
import { isTouchDevice, stickVector, layoutForGenre } from '../src/engine/game/TouchControls';

describe('isTouchDevice', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.window;
    delete g.navigator;
  });

  it('is false in a non-DOM environment', () => {
    expect(isTouchDevice()).toBe(false);
  });

  it('is true when maxTouchPoints > 0', () => {
    g.window = {};
    g.navigator = { maxTouchPoints: 5 };
    expect(isTouchDevice()).toBe(true);
  });

  it("is true when 'ontouchstart' is on window", () => {
    g.window = { ontouchstart: null };
    g.navigator = { maxTouchPoints: 0 };
    expect(isTouchDevice()).toBe(true);
  });

  it('is false when maxTouchPoints is 0 and no touch events', () => {
    g.window = {};
    g.navigator = { maxTouchPoints: 0 };
    expect(isTouchDevice()).toBe(false);
  });
});

describe('stickVector', () => {
  it('returns zero for zero displacement', () => {
    expect(stickVector(0, 0, 56)).toEqual({ x: 0, y: 0 });
  });

  it('normalizes displacement within the radius', () => {
    const v = stickVector(28, 0, 56);
    expect(v.x).toBeCloseTo(0.5, 6);
    expect(v.y).toBeCloseTo(0, 6);
  });

  it('clamps displacement beyond the radius to unit length', () => {
    const v = stickVector(100, 0, 56);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(1, 6);
  });

  it('clamps diagonal displacement to the circle', () => {
    const v = stickVector(200, 200, 56);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(v.y, 6);
  });

  it('returns zero for a non-positive radius', () => {
    expect(stickVector(10, 10, 0)).toEqual({ x: 0, y: 0 });
    expect(stickVector(10, 10, -5)).toEqual({ x: 0, y: 0 });
  });

  it('keeps screen-space sign convention (y down+)', () => {
    const v = stickVector(0, 28, 56);
    expect(v.y).toBeGreaterThan(0);
  });
});

describe('layoutForGenre', () => {
  it('fps-arena: move stick + look drag + FIRE/JUMP', () => {
    const l = layoutForGenre('fps-arena');
    expect(l.move).toBe('stick');
    expect(l.aim).toBe('look');
    expect(l.autoForward).toBe(false);
    const acts = l.buttons.map((b) => b.action);
    expect(acts).toContain('attack');
    expect(acts).toContain('jump');
  });

  it('third-person-action: move stick, no aim, ATK/DASH/JUMP', () => {
    const l = layoutForGenre('third-person-action');
    expect(l.move).toBe('stick');
    expect(l.aim).toBe(null);
    const acts = l.buttons.map((b) => b.action);
    expect(acts).toEqual(expect.arrayContaining(['attack', 'dash', 'jump']));
  });

  it('top-down-shooter: twin sticks with auto-fire aim', () => {
    const l = layoutForGenre('top-down-shooter');
    expect(l.move).toBe('stick');
    expect(l.aim).toBe('rstick');
    expect(l.autoForward).toBe(false);
  });

  it('racing: steer-only stick, automatic gas, BRAKE/BOOST/RESET', () => {
    const l = layoutForGenre('racing');
    expect(l.move).toBe('steer');
    expect(l.aim).toBe(null);
    expect(l.autoForward).toBe(true);
    const acts = l.buttons.map((b) => b.action);
    expect(acts).toEqual(expect.arrayContaining(['brake', 'boost', 'reset'])); // N3: touch reset
  });

  it('platformer: d-pad + JUMP', () => {
    const l = layoutForGenre('platformer');
    expect(l.move).toBe('dpad');
    expect(l.aim).toBe(null);
    expect(l.buttons.map((b) => b.action)).toContain('jump');
  });

  it('unknown genre falls back to a generic layout', () => {
    const l = layoutForGenre('tower-defense');
    expect(l.move).toBe('stick');
    expect(l.buttons.length).toBeGreaterThan(0);
  });

  it('button hit-areas do not overlap each other', () => {
    for (const genre of ['fps-arena', 'third-person-action', 'top-down-shooter', 'racing', 'platformer']) {
      const l = layoutForGenre(genre);
      const rects = l.buttons.map((b) => ({
        l: 10000 - b.right - b.size, r: 10000 - b.right, b: b.bottom, t: b.bottom + b.size,
      }));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], c = rects[j];
          const overlap = a.l < c.r && c.l < a.r && a.b < c.t && c.b < a.t;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});
