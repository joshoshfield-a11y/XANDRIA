/**
 * Unified input: keyboard + mouse (+ pointer lock) + gamepad. Blueprints read the abstract `axes` and
 * `pressed/justPressed` maps and never touch DOM events directly. Also exposes `inject` so automated
 * playtests can drive the game headlessly.
 */
export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'dash' | 'attack' | 'attack2'
  | 'interact' | 'pause' | 'boost' | 'brake' | 'reset' | 'confirm' | 'weapon1' | 'weapon2';

const KEYMAP: Record<string, Action[]> = {
  KeyW: ['forward'], ArrowUp: ['forward'],
  KeyS: ['back'], ArrowDown: ['back'],
  KeyA: ['left'], ArrowLeft: ['left'],
  KeyD: ['right'], ArrowRight: ['right'],
  Space: ['jump', 'boost', 'confirm'],
  ShiftLeft: ['sprint', 'dash'], ShiftRight: ['sprint', 'dash'],
  KeyE: ['interact'], KeyF: ['interact'],
  KeyQ: ['attack2'],
  KeyR: ['reset'],
  Escape: ['pause'], KeyP: ['pause'],
  Enter: ['confirm'],
  ControlLeft: ['brake'], KeyX: ['brake'],
  Digit1: ['weapon1'], Digit2: ['weapon2'],
};

export class Input {
  private down = new Set<Action>();
  private just = new Set<Action>();
  private released = new Set<Action>();
  private injected = new Set<Action>();
  private injectedAxes: { lx: number; ly: number } | null = null;
  /** mouse look delta this frame (pixels) */
  look = { x: 0, y: 0 };
  /** raw mouse position normalized to [-1,1] (for top-down aiming) */
  pointer = { x: 0, y: 0 };
  pointerDown = false;
  pointerLocked = false;
  wheel = 0;
  private el: HTMLElement;
  private handlers: Array<[EventTarget, string, any]> = [];
  enabled = true;

  constructor(el: HTMLElement) {
    this.el = el;
    const on = <K extends keyof GlobalEventHandlersEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void) => {
      t.addEventListener(type, fn as any);
      this.handlers.push([t, type, fn]);
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      const acts = KEYMAP[e.code];
      if (!acts) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      for (const a of acts) {
        if (!this.down.has(a)) this.just.add(a);
        this.down.add(a);
      }
    });
    on(window, 'keyup', (e: KeyboardEvent) => {
      const acts = KEYMAP[e.code];
      if (!acts) return;
      for (const a of acts) {
        this.down.delete(a);
        this.released.add(a);
      }
    });
    on(window, 'blur', () => this.down.clear());
    on(el, 'mousedown', (e: MouseEvent) => {
      this.pointerDown = true;
      const a: Action = e.button === 2 ? 'attack2' : 'attack';
      if (!this.down.has(a)) this.just.add(a);
      this.down.add(a);
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      this.pointerDown = false;
      const a: Action = e.button === 2 ? 'attack2' : 'attack';
      this.down.delete(a);
      this.released.add(a);
    });
    on(el, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'mousemove', (e: MouseEvent) => {
      if (this.pointerLocked) {
        this.look.x += e.movementX;
        this.look.y += e.movementY;
      }
      const r = this.el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
    });
    on(el, 'wheel', (e: WheelEvent) => { this.wheel += Math.sign(e.deltaY); }, );
    on(document, 'pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.el;
    });
    // touch: simple virtual stick on left half, look on right half
    let touchStart: { id: number; x: number; y: number; side: 'l' | 'r' }[] = [];
    on(el, 'touchstart', (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const side = t.clientX < window.innerWidth / 2 ? 'l' : 'r';
        touchStart.push({ id: t.identifier, x: t.clientX, y: t.clientY, side });
        if (side === 'r') { this.down.add('attack'); this.just.add('attack'); }
      }
    });
    on(el, 'touchmove', (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        const s = touchStart.find((k) => k.id === t.identifier);
        if (!s) continue;
        if (s.side === 'l') {
          const dx = (t.clientX - s.x) / 60, dy = (t.clientY - s.y) / 60;
          this.touchAxes = { lx: clamp(dx, -1, 1), ly: clamp(dy, -1, 1) };
        } else {
          this.look.x += (t.clientX - s.x) * 0.3; this.look.y += (t.clientY - s.y) * 0.3;
          s.x = t.clientX; s.y = t.clientY;
        }
      }
    });
    on(el, 'touchend', (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const s = touchStart.find((k) => k.id === t.identifier);
        if (s?.side === 'l') this.touchAxes = null;
        if (s?.side === 'r') this.down.delete('attack');
        touchStart = touchStart.filter((k) => k.id !== t.identifier);
      }
    });
  }
  private touchAxes: { lx: number; ly: number } | null = null;

  requestPointerLock() {
    try { this.el.requestPointerLock?.(); } catch { /* ignore */ }
  }
  exitPointerLock() {
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ }
  }

  pressed(a: Action): boolean {
    return this.enabled && (this.down.has(a) || this.injected.has(a) || this.gamepadDown.has(a));
  }
  justPressed(a: Action): boolean {
    return this.enabled && (this.just.has(a) || this.gamepadJust.has(a));
  }
  justReleased(a: Action): boolean {
    return this.enabled && this.released.has(a);
  }

  /** movement axes: x = right(+)/left(-), y = forward(+)/back(-) — already normalized */
  get axes(): { x: number; y: number } {
    let x = 0, y = 0;
    if (this.pressed('right')) x += 1;
    if (this.pressed('left')) x -= 1;
    if (this.pressed('forward')) y += 1;
    if (this.pressed('back')) y -= 1;
    const gp = this.gamepadAxes;
    const inj = this.injectedAxes ?? this.touchAxes;
    if (inj) { x += inj.lx; y -= inj.ly; }
    if (gp) { x += gp.lx; y -= gp.ly; }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  private gamepadDown = new Set<Action>();
  private gamepadJust = new Set<Action>();
  private gamepadAxes: { lx: number; ly: number; rx: number; ry: number } | null = null;
  private prevGamepadButtons: boolean[] = [];

  private pollGamepad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    this.gamepadJust.clear();
    if (!gp) { this.gamepadAxes = null; this.gamepadDown.clear(); return; }
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
    this.gamepadAxes = { lx: dz(gp.axes[0] ?? 0), ly: dz(gp.axes[1] ?? 0), rx: dz(gp.axes[2] ?? 0), ry: dz(gp.axes[3] ?? 0) };
    this.look.x += this.gamepadAxes.rx * 18;
    this.look.y += this.gamepadAxes.ry * 18;
    const map: Record<number, Action[]> = { 0: ['jump', 'confirm'], 1: ['dash'], 2: ['interact'], 3: ['attack2'], 5: ['attack'], 7: ['attack', 'boost'], 6: ['brake', 'attack2'], 4: ['sprint'], 9: ['pause'], 8: ['reset'] };
    this.gamepadDown.clear();
    gp.buttons.forEach((b, i) => {
      const acts = map[i];
      if (!acts) return;
      if (b.pressed) {
        for (const a of acts) { this.gamepadDown.add(a); if (!this.prevGamepadButtons[i]) this.gamepadJust.add(a); }
      }
      this.prevGamepadButtons[i] = b.pressed;
    });
  }

  /** For automated tests: hold a set of actions and optional movement axes until changed. */
  inject(actions: Action[], axes?: { lx: number; ly: number } | null) {
    for (const a of actions) if (!this.injected.has(a)) this.just.add(a);
    this.injected = new Set(actions);
    this.injectedAxes = axes ?? null;
  }
  tap(a: Action) { this.just.add(a); }

  /** Call once per frame AFTER the game has consumed input. */
  endFrame() {
    this.just.clear();
    this.released.clear();
    this.look.x = 0;
    this.look.y = 0;
    this.wheel = 0;
  }
  beginFrame() { this.pollGamepad(); }

  dispose() {
    for (const [t, type, fn] of this.handlers) t.removeEventListener(type, fn);
    this.handlers = [];
  }
}

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
