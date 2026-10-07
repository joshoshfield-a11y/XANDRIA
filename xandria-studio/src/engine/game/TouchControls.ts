/**
 * TouchControls — DOM-overlay touch UI for touch devices (phones/tablets).
 *
 * Detects touch hardware and, only then, renders virtual controls over the
 * canvas: a floating-origin left stick (move / steer), an optional right stick
 * (twin-stick aim) or right-half drag area (FPS look), per-genre action
 * buttons, and a pause button. All state is translated into the same `Input`
 * abstraction the keyboard/mouse path uses (actions + axes + look deltas), so
 * blueprints need zero changes.
 *
 * Desktop behavior is completely unaffected: on non-touch devices the class
 * builds no DOM and every method is a no-op.
 */
import type { Action, Input } from '../core/Input';

/** True on real touch hardware. Safe to call in node (returns false). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if ('ontouchstart' in window) return true;
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
}

/**
 * Pure stick math: pixel displacement from the stick origin → normalized,
 * clamped unit vector. Screen-space: x right+, y down+ (matches Input axes
 * convention where ly is down+).
 */
export function stickVector(dx: number, dy: number, radius: number): { x: number; y: number } {
  if (radius <= 0) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy);
  const c = len > radius ? radius / len : 1;
  return { x: (dx * c) / radius, y: (dy * c) / radius };
}

export type MoveMode = 'stick' | 'steer' | 'dpad';
export type AimMode = 'look' | 'rstick' | null;

export interface TouchButtonDef {
  label: string;
  action: Action;
  /** 'hold' keeps the action down while pressed; 'tap' fires a single edge. */
  kind: 'hold' | 'tap';
  /** px from the right edge */
  right: number;
  /** px from the bottom edge */
  bottom: number;
  /** diameter px */
  size: number;
}

export interface TouchLayout {
  move: MoveMode;
  aim: AimMode;
  /** racing: hold 'forward' while playing so gas is automatic */
  autoForward: boolean;
  buttons: TouchButtonDef[];
}

/**
 * Per-genre control scheme. Pure function — unit-tested.
 *
 * - fps-arena: left stick move, drag right half to look (replaces pointer lock),
 *   FIRE + JUMP buttons.
 * - third-person-action: left stick move, ATK / DASH / JUMP buttons.
 * - top-down-shooter: twin sticks — left move, right aim + auto-fire while deflected.
 * - racing: left stick steers (X only), gas auto-on, BRAKE + BOOST buttons.
 * - platformer: LEFT/RIGHT d-pad + JUMP button.
 */
export function layoutForGenre(genre: string): TouchLayout {
  switch (genre) {
    case 'fps-arena':
      return {
        move: 'stick', aim: 'look', autoForward: false,
        buttons: [
          { label: 'FIRE', action: 'attack', kind: 'hold', right: 24, bottom: 96, size: 88 },
          { label: 'JUMP', action: 'jump', kind: 'tap', right: 128, bottom: 44, size: 64 },
        ],
      };
    case 'third-person-action':
      return {
        move: 'stick', aim: null, autoForward: false,
        buttons: [
          { label: 'ATK', action: 'attack', kind: 'hold', right: 24, bottom: 96, size: 88 },
          { label: 'DASH', action: 'dash', kind: 'tap', right: 128, bottom: 44, size: 64 },
          { label: 'JUMP', action: 'jump', kind: 'tap', right: 208, bottom: 100, size: 64 },
        ],
      };
    case 'top-down-shooter':
      return {
        move: 'stick', aim: 'rstick', autoForward: false,
        buttons: [
          { label: 'DASH', action: 'dash', kind: 'tap', right: 24, bottom: 216, size: 60 },
        ],
      };
    case 'racing':
      return {
        move: 'steer', aim: null, autoForward: true,
        buttons: [
          { label: 'BOOST', action: 'boost', kind: 'hold', right: 24, bottom: 96, size: 88 },
          { label: 'BRAKE', action: 'brake', kind: 'hold', right: 128, bottom: 44, size: 64 },
          // N3: desktop has R — a beached-but-upright car was unrecoverable on touch
          { label: 'RESET', action: 'reset', kind: 'tap', right: 208, bottom: 100, size: 64 },
        ],
      };
    case 'platformer':
      return {
        move: 'dpad', aim: null, autoForward: false,
        buttons: [
          { label: 'JUMP', action: 'jump', kind: 'tap', right: 24, bottom: 96, size: 88 },
        ],
      };
    default:
      return {
        move: 'stick', aim: null, autoForward: false,
        buttons: [{ label: 'ACT', action: 'attack', kind: 'hold', right: 24, bottom: 96, size: 88 }],
      };
  }
}

const CSS = `
.xtouch { position:absolute; inset:0; z-index:5; touch-action:none; -webkit-user-select:none; user-select:none; -webkit-tap-highlight-color:transparent; -webkit-touch-callout:none; }
.xtouch.hidden { display:none; }
.xtouch .zone { position:absolute; touch-action:none; }
.xtouch .stickbase { position:absolute; width:112px; height:112px; margin:-56px 0 0 -56px; border-radius:50%;
  background:rgba(120,160,200,.10); border:2px solid rgba(140,180,220,.35); display:none; pointer-events:none; }
.xtouch .stickknob { position:absolute; left:50%; top:50%; width:52px; height:52px; margin:-26px 0 0 -26px; border-radius:50%;
  background:rgba(150,190,235,.45); border:2px solid rgba(200,225,255,.6); }
.xtouch .tbtn { position:absolute; border-radius:50%; border:2px solid rgba(140,180,220,.45);
  background:rgba(20,30,44,.55); color:#e8ecf1; font-family:'Segoe UI',system-ui,sans-serif; font-weight:700;
  letter-spacing:.06em; display:flex; align-items:center; justify-content:center; touch-action:none; backdrop-filter:blur(2px); }
.xtouch .tbtn.held { background:rgba(255,210,63,.45); border-color:#ffd23f; }
.xtouch .dpad { position:absolute; border-radius:16px; border:2px solid rgba(140,180,220,.45);
  background:rgba(20,30,44,.55); color:#e8ecf1; font-weight:800; font-size:26px;
  display:flex; align-items:center; justify-content:center; touch-action:none; font-family:'Segoe UI',system-ui,sans-serif; }
.xtouch .dpad.held { background:rgba(255,210,63,.45); border-color:#ffd23f; }
.xtouch .pausebtn { position:absolute; top:76px; right:16px; width:42px; height:42px; border-radius:10px;
  border:1px solid rgba(140,180,220,.4); background:rgba(20,30,44,.55); color:#e8ecf1; font-size:17px;
  display:flex; align-items:center; justify-content:center; touch-action:none; }
`;

const STICK_R = 56; // px travel radius for stickVector

export class TouchControls {
  /** False on desktop: no DOM is built and every method is a no-op. */
  readonly active: boolean;
  private input: Input;
  private layout: TouchLayout;
  private root: HTMLElement | null = null;
  private visible = false;
  private held = new Set<Action>();
  private moveId: number | null = null;
  private moveOX = 0; private moveOY = 0;
  private moveBase: HTMLElement | null = null;
  private moveKnob: HTMLElement | null = null;
  private aimId: number | null = null;
  private aimOX = 0; private aimOY = 0;
  private aimBase: HTMLElement | null = null;
  private aimKnob: HTMLElement | null = null;
  private lookId: number | null = null;
  private lookLX = 0; private lookLY = 0;
  private disposers: Array<() => void> = [];

  constructor(container: HTMLElement, input: Input, genre: string) {
    this.input = input;
    this.layout = layoutForGenre(genre);
    this.active = isTouchDevice() && typeof document !== 'undefined';
    if (!this.active) return;
    input.touchManaged = true; // Input's built-in canvas touch handlers stand down
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'xtouch hidden';
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    container.appendChild(root);
    this.root = root;

    // --- move zone (left 45%) ---
    if (this.layout.move === 'dpad') this.buildDpad(root);
    else this.buildStickZone(root, 'move');

    // --- aim: right stick zone or look-drag area (right 55%) ---
    if (this.layout.aim === 'rstick') this.buildStickZone(root, 'aim');
    else if (this.layout.aim === 'look') this.buildLookZone(root);

    // --- action buttons ---
    for (const b of this.layout.buttons) this.buildButton(root, b);

    // --- pause ---
    const pb = document.createElement('div');
    pb.className = 'pausebtn';
    pb.textContent = '⏸';
    const onPb = (e: PointerEvent) => { e.preventDefault(); e.stopPropagation(); this.input.tap('pause'); };
    pb.addEventListener('pointerdown', onPb);
    root.appendChild(pb);
    this.disposers.push(() => pb.removeEventListener('pointerdown', onPb));
  }

  // ----- public API -----

  /** Show/hide the overlay (Engine calls this with state === 'playing'). */
  setVisible(v: boolean) {
    if (!this.active || v === this.visible) return;
    this.visible = v;
    this.root!.classList.toggle('hidden', !v);
    if (v) {
      if (this.layout.autoForward) this.hold('forward');
    } else {
      this.releaseAll();
    }
  }

  dispose() {
    if (!this.active) return;
    this.releaseAll();
    for (const d of this.disposers) d();
    this.disposers = [];
    this.input.touchManaged = false;
    this.root?.remove();
    this.root = null;
  }

  // ----- internals -----

  private hold(a: Action) {
    this.held.add(a);
    this.input.pressAction(a);
  }
  private release(a: Action) {
    this.held.delete(a);
    this.input.releaseAction(a);
  }
  private releaseAll() {
    for (const a of [...this.held]) this.release(a);
    this.input.setMoveStick(null);
    this.moveId = this.aimId = this.lookId = null;
    if (this.moveBase) this.moveBase.style.display = 'none';
    if (this.aimBase) this.aimBase.style.display = 'none';
  }

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions,
  ) {
    el.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private makeStickVisual(root: HTMLElement): { base: HTMLElement; knob: HTMLElement } {
    const base = document.createElement('div');
    base.className = 'stickbase';
    const knob = document.createElement('div');
    knob.className = 'stickknob';
    base.appendChild(knob);
    root.appendChild(base);
    return { base, knob };
  }

  /** Floating-origin analog stick zone. kind 'move' drives input axes; 'aim' drives aim+autofire. */
  private buildStickZone(root: HTMLElement, kind: 'move' | 'aim') {
    const zone = document.createElement('div');
    zone.className = 'zone';
    const isMove = kind === 'move';
    zone.style.cssText = isMove
      ? 'left:0; top:0; width:45%; height:100%;'
      : 'right:0; top:0; width:45%; height:100%;';
    root.appendChild(zone);
    const { base, knob } = this.makeStickVisual(root);
    if (isMove) { this.moveBase = base; this.moveKnob = knob; }
    else { this.aimBase = base; this.aimKnob = knob; }

    const setKnob = (vx: number, vy: number) => {
      knob.style.transform = `translate(${vx * 38}px, ${vy * 38}px)`;
    };
    this.on(zone, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      if (isMove ? this.moveId !== null : this.aimId !== null) return;
      const id = e.pointerId;
      if (isMove) { this.moveId = id; this.moveOX = e.clientX; this.moveOY = e.clientY; }
      else { this.aimId = id; this.aimOX = e.clientX; this.aimOY = e.clientY; }
      base.style.display = 'block';
      base.style.left = `${e.clientX}px`;
      base.style.top = `${e.clientY}px`;
      setKnob(0, 0);
      try { zone.setPointerCapture(id); } catch { /* ignore */ }
    });
    this.on(zone, 'pointermove', (e: PointerEvent) => {
      const id = isMove ? this.moveId : this.aimId;
      if (e.pointerId !== id) return;
      e.preventDefault();
      const ox = isMove ? this.moveOX : this.aimOX;
      const oy = isMove ? this.moveOY : this.aimOY;
      const v = stickVector(e.clientX - ox, e.clientY - oy, STICK_R);
      setKnob(v.x, v.y);
      if (isMove) {
        const steerOnly = this.layout.move === 'steer';
        this.input.setMoveStick(steerOnly ? { lx: v.x, ly: 0 } : { lx: v.x, ly: v.y });
      } else {
        // twin-stick aim: synthesize a pointer offset from screen center in the
        // stick direction; the blueprint's ground-plane raycast turns it into a
        // world aim direction. Auto-fire while deflected past the deadzone.
        this.input.setPointerPos(v.x * 0.45, -v.y * 0.45);
        if (Math.hypot(v.x, v.y) > 0.25) this.hold('attack');
        else this.release('attack');
      }
    });
    const end = (e: PointerEvent) => {
      const id = isMove ? this.moveId : this.aimId;
      if (e.pointerId !== id) return;
      if (isMove) { this.moveId = null; this.input.setMoveStick(null); }
      else { this.aimId = null; this.release('attack'); }
      base.style.display = 'none';
    };
    this.on(zone, 'pointerup', end);
    this.on(zone, 'pointercancel', end);
  }

  /** Right-half drag area for FPS look (replaces pointer lock). */
  private buildLookZone(root: HTMLElement) {
    const zone = document.createElement('div');
    zone.className = 'zone';
    zone.style.cssText = 'right:0; top:0; width:55%; height:100%;';
    root.appendChild(zone);
    this.on(zone, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      this.lookLX = e.clientX; this.lookLY = e.clientY;
      try { zone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    this.on(zone, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.lookId) return;
      e.preventDefault();
      // 2x desktop-mouse rate: finger drags cover less ground than a mouse
      this.input.look.x += (e.clientX - this.lookLX) * 2.0;
      this.input.look.y += (e.clientY - this.lookLY) * 2.0;
      this.lookLX = e.clientX; this.lookLY = e.clientY;
    });
    const end = (e: PointerEvent) => { if (e.pointerId === this.lookId) this.lookId = null; };
    this.on(zone, 'pointerup', end);
    this.on(zone, 'pointercancel', end);
  }

  private buildButton(root: HTMLElement, b: TouchButtonDef) {
    const el = document.createElement('div');
    el.className = 'tbtn';
    el.textContent = b.label;
    el.style.cssText = `right:${b.right}px; bottom:${b.bottom}px; width:${b.size}px; height:${b.size}px; font-size:${Math.round(b.size / 5)}px;`;
    root.appendChild(el);
    this.on(el, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.add('held');
      if (b.kind === 'hold') this.hold(b.action);
      else this.input.tap(b.action);
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    const up = (e: PointerEvent) => {
      e.stopPropagation();
      el.classList.remove('held');
      if (b.kind === 'hold') this.release(b.action);
    };
    this.on(el, 'pointerup', up);
    this.on(el, 'pointercancel', up);
  }

  /** Platformer d-pad: LEFT / RIGHT hold-buttons on the bottom-left. */
  private buildDpad(root: HTMLElement) {
    const defs: Array<{ label: string; action: Action; left: number }> = [
      { label: '◀', action: 'left', left: 24 },
      { label: '▶', action: 'right', left: 108 },
    ];
    for (const d of defs) {
      const el = document.createElement('div');
      el.className = 'dpad';
      el.textContent = d.label;
      el.style.cssText = `left:${d.left}px; bottom:48px; width:72px; height:72px;`;
      root.appendChild(el);
      this.on(el, 'pointerdown', (e: PointerEvent) => {
        e.preventDefault(); e.stopPropagation();
        el.classList.add('held');
        this.hold(d.action);
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      });
      const up = (e: PointerEvent) => {
        e.stopPropagation();
        el.classList.remove('held');
        this.release(d.action);
      };
      this.on(el, 'pointerup', up);
      this.on(el, 'pointercancel', up);
    }
  }
}
