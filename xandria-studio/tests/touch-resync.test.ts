/**
 * R2-N13 + R2-N9 regression tests.
 *
 * R2-N13: TouchControls.held went stale after engine.restart() while the
 * overlay stayed visible — Input was reset but the overlay still believed
 * racing's auto-forward 'forward' was held, so the car got no gas. The fix
 * re-applies held actions when setVisible() is called with no state change
 * (the engine calls it every frame).
 *
 * R2-N9: the touch pause button overlapped the HUD score panel on narrow
 * viewports (was top:76px). It now sits below the score panel.
 *
 * DOM is hand-stubbed (no jsdom), following tests/touch.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TouchControls } from '../src/engine/game/TouchControls';
import { Input } from '../src/engine/core/Input';

function makeEl(): any {
  const el: any = {
    children: [] as any[],
    style: {} as Record<string, string>,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    textContent: '',
    appendChild(c: any) { el.children.push(c); return c; },
    querySelector() { return null; }, // R3-T1: no HUD in this stub → positionPauseButton keeps the CSS fallback
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
  };
  return el;
}

const g = globalThis as Record<string, unknown>;
let capturedCss = '';

beforeEach(() => {
  capturedCss = '';
  // NB: node exposes a getter-only global `navigator`; delete it first (as
  // tests/touch.test.ts's afterEach does) so the stub assignment below works.
  delete g.navigator;
  g.window = {
    ontouchstart: null,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 390,
    innerHeight: 844,
  };
  g.navigator = { maxTouchPoints: 5 };
  g.document = {
    createElement: () => makeEl(),
    head: { appendChild(el: any) { capturedCss += el.textContent; } },
    addEventListener() {},
    removeEventListener() {},
  };
});

afterEach(() => {
  delete g.window;
  delete g.document;
  delete g.navigator;
});

function makeTouch() {
  const container = makeEl();
  const input = new Input(container);
  const tc = new TouchControls(container, input, 'racing');
  expect(tc.active).toBe(true);
  return { input, tc };
}

describe('R2-N13 held-state consistent across restart', () => {
  it("re-applies auto-forward when the overlay stays visible across an input reset", () => {
    const { input, tc } = makeTouch();
    tc.setVisible(true);
    expect(input.pressed('forward')).toBe(true);

    input.reset(); // what engine.restart()/resetRun() does to Input
    expect(input.pressed('forward')).toBe(false); // the stale state from the bug report

    tc.setVisible(true); // engine calls this every frame; a no-op when already visible
    expect(input.pressed('forward')).toBe(true); // healed: gas is back
  });

  it('resyncHeld() is idempotent and never resurrects released actions', () => {
    const { input, tc } = makeTouch();
    tc.setVisible(true);
    input.reset();

    tc.resyncHeld();
    tc.resyncHeld();
    expect(input.pressed('forward')).toBe(true);

    tc.setVisible(false); // releaseAll() clears held
    expect(input.pressed('forward')).toBe(false);
    tc.resyncHeld();
    expect(input.pressed('forward')).toBe(false); // stays released
  });

  it('the hide/show cycle still behaves as before', () => {
    const { input, tc } = makeTouch();
    tc.setVisible(true);
    expect(input.pressed('forward')).toBe(true);
    tc.setVisible(false);
    expect(input.pressed('forward')).toBe(false);
    tc.setVisible(true);
    expect(input.pressed('forward')).toBe(true);
  });
});

describe('R2-N9/R3-T1 pause button clears the HUD score panel', () => {
  it('CSS fallback sits below the score panel, not overlapping it', () => {
    makeTouch(); // the constructor injects the overlay CSS into <head>
    // R3-T1: the CSS offset is now only a FALLBACK — the real offset is
    // measured from the score panel at layout time (positionPauseButton, on
    // every setVisible(true) and on resize). The fallback keeps the old
    // R2-N9 clearance for the no-HUD / not-yet-laid-out case.
    // score panel: top = max(12px, safe-area-inset-top), ~83px tall → bottom ≈ 95px.
    // pause button top = inset + 96px → 13px of clearance on a 390px viewport.
    expect(capturedCss).toContain('top:calc(max(12px, env(safe-area-inset-top)) + 96px)');
    expect(capturedCss).not.toContain('top:76px');
  });
});
