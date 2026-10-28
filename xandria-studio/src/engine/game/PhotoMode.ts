/**
 * Photo mode — presentation-only orbit camera with HUD-free framing.
 *
 * UPGRADE LOOP (photo-mode): entering photo mode FREEZES the simulation
 * deterministically — physics, update hooks, particles, HUD updates and the
 * run clock all stop advancing, exactly like a pause that keeps rendering.
 * Enemies, timers and damage therefore neither continue nor drift: the
 * frozen state is byte-identical on exit, because no gameplay code runs
 * while photo mode is active. The only thing that moves is the camera,
 * driven by this controller's own orbit state around the (frozen) player
 * position. Exiting restores the exact saved camera transform and the
 * exact prior DOM overlay visibility. No RNG, no wall clock, no gameplay
 * state is touched — photo mode observes and presents only.
 *
 * The freeze is owned by Engine.step (it skips the sim block while this
 * controller is active); this module owns the orbit math, the overlay
 * hide/restore snapshot, the orbit input, and the screenshot capture.
 * Screenshot capture reuses the existing canvas: Engine calls
 * consumeCapture() synchronously right after postfx.render() in the
 * same task, so toDataURL reads a valid drawing buffer without
 * preserveDrawingBuffer (and without a new dependency).
 */
import * as THREE from 'three';

/** Orbit limits: distance in metres, pitch in radians. */
export const PHOTO_ORBIT_MIN_DIST = 3;
export const PHOTO_ORBIT_MAX_DIST = 30;
export const PHOTO_ORBIT_MIN_PITCH = -0.15;
export const PHOTO_ORBIT_MAX_PITCH = 1.2;
/** Eye height above the target position the camera looks at. */
export const PHOTO_LOOK_HEIGHT = 1.2;

export interface PhotoOrbit {
  /** radians, atan2(x, z) of the camera offset from the look target */
  yaw: number;
  /** radians, elevation of the camera above the look target */
  pitch: number;
  /** metres from the look target */
  distance: number;
}

export interface SavedCamera {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

export function clampOrbit(o: PhotoOrbit): PhotoOrbit {
  return {
    yaw: o.yaw,
    pitch: Math.max(PHOTO_ORBIT_MIN_PITCH, Math.min(PHOTO_ORBIT_MAX_PITCH, o.pitch)),
    distance: Math.max(PHOTO_ORBIT_MIN_DIST, Math.min(PHOTO_ORBIT_MAX_DIST, o.distance)),
  };
}

/** Offset from the look target for an orbit state (spherical, yaw about Y). */
export function orbitOffset(o: PhotoOrbit, out: THREE.Vector3): THREE.Vector3 {
  const cp = Math.cos(o.pitch);
  out.set(
    Math.sin(o.yaw) * cp * o.distance,
    Math.sin(o.pitch) * o.distance,
    Math.cos(o.yaw) * cp * o.distance,
  );
  return out;
}

/**
 * Derive the orbit state that reproduces the current camera framing:
 * the camera position relative to the look target, as yaw/pitch/distance.
 * Entering photo mode from this state is a no-jump transition.
 */
export function deriveOrbit(cameraPos: THREE.Vector3, lookTarget: THREE.Vector3): PhotoOrbit {
  const dx = cameraPos.x - lookTarget.x;
  const dy = cameraPos.y - lookTarget.y;
  const dz = cameraPos.z - lookTarget.z;
  const distance = Math.hypot(dx, dy, dz) || PHOTO_ORBIT_MIN_DIST;
  return clampOrbit({
    yaw: Math.atan2(dx, dz),
    pitch: Math.asin(Math.max(-1, Math.min(1, dy / distance))),
    distance,
  });
}

export interface PhotoModeDeps {
  container: HTMLElement;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Frozen player position, or null when there is no live avatar. */
  getTarget: () => THREE.Vector3 | null;
  /** True only while a run is playing (never on title/pause/end screens). */
  canEnter: () => boolean;
  /** Clear held/edge input so a held key can't stick across the freeze. */
  clearInput: () => void;
}

const BAR_CSS = `
.xphoto-bar { position:absolute; left:50%; bottom:16px; transform:translateX(-50%); display:flex; gap:10px; align-items:center;
  pointer-events:none; z-index:20; font-family:'Segoe UI',system-ui,sans-serif; }
.xphoto-bar .xphoto-hint { font-size:12px; color:#e8ecf1; opacity:.85; background:rgba(10,14,20,.55);
  border:1px solid rgba(140,180,220,.25); border-radius:8px; padding:8px 12px; white-space:nowrap; }
.xphoto-bar button { pointer-events:auto; cursor:pointer; min-height:32px; min-width:32px; padding:8px 16px;
  font-size:13px; font-weight:700; letter-spacing:.08em; color:#e8ecf1; border-radius:8px;
  border:1px solid rgba(140,180,220,.4); background:linear-gradient(180deg,#2b3f57,#1a2536); }
.xphoto-bar button:hover { background:linear-gradient(180deg,#3a5474,#223048); }
`;

export class PhotoModeController {
  private deps: PhotoModeDeps;
  private _active = false;
  private orbitState: PhotoOrbit = { yaw: 0, pitch: 0.3, distance: 7.5 };
  private saved: SavedCamera | null = null;
  private hidden: Array<{ el: HTMLElement; display: string }> = [];
  private bar: HTMLDivElement;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private captureRequested = false;
  private _lastScreenshot: string | null = null;
  private readonly look = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private disposed = false;

  constructor(deps: PhotoModeDeps) {
    this.deps = deps;
    const style = document.createElement('style');
    style.textContent = BAR_CSS;
    document.head.appendChild(style);

    this.bar = document.createElement('div');
    this.bar.className = 'xphoto-bar';
    this.bar.style.display = 'none';
    this.bar.innerHTML =
      `<div class="xphoto-hint">PHOTO MODE — drag to orbit · scroll / pinch to zoom · O / Esc to exit</div>` +
      `<button type="button" data-photo-action="capture" aria-label="Take screenshot">📷 SNAPSHOT (U)</button>` +
      `<button type="button" data-photo-action="exit" aria-label="Exit photo mode">✕ EXIT</button>`;
    this.bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-photo-action]');
      if (!btn) return;
      if (btn.getAttribute('data-photo-action') === 'capture') this.requestCapture();
      else this.exit();
    });
    deps.container.appendChild(this.bar);

    // Toggle key (KeyO is unbound anywhere in the keymap) + screenshot key
    // (KeyU is likewise unbound). Escape is NOT handled here: Engine.step
    // owns the pause edge and exits photo mode instead of pausing.
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || this.disposed) return;
      if (e.code === 'KeyO') {
        if (this._active) this.exit();
        else this.enter();
      } else if (e.code === 'KeyU' && this._active) {
        this.requestCapture();
      }
    };
    window.addEventListener('keydown', this.onKeyDown);

    // Orbit input: pointer events (mouse drag + touch drag + pinch) and
    // wheel zoom. Wheel is capture-phase on the container so it pre-empts
    // Input's canvas wheel listener (which would otherwise consume the
    // zoom as a gameplay wheel delta). Pointer handlers ignore presses
    // that land on the photo bar's own buttons.
    this.onPointerDown = (e: PointerEvent) => {
      if (!this._active) return;
      if ((e.target as HTMLElement).closest?.('.xphoto-bar button')) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    this.onPointerMove = (e: PointerEvent) => {
      if (!this._active) return;
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      if (this.pointers.size === 2) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0 && d > 0) {
          this.orbitState = clampOrbit({ ...this.orbitState, distance: this.orbitState.distance * (this.pinchDist / d) });
        }
        this.pinchDist = d;
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.orbitState = clampOrbit({
        ...this.orbitState,
        yaw: this.orbitState.yaw - dx * 0.005,
        pitch: this.orbitState.pitch + dy * 0.005,
      });
    };
    this.onPointerUp = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
    };
    this.onWheel = (e: WheelEvent) => {
      if (!this._active) return;
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.orbitState = clampOrbit({ ...this.orbitState, distance: this.orbitState.distance * factor });
    };
    deps.container.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    deps.container.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
  }

  get active(): boolean { return this._active; }
  get orbit(): PhotoOrbit { return { ...this.orbitState }; }
  get savedCamera(): SavedCamera | null {
    return this.saved
      ? { position: this.saved.position.clone(), quaternion: this.saved.quaternion.clone(), fov: this.saved.fov }
      : null;
  }
  get lastScreenshot(): string | null { return this._lastScreenshot; }
  /** Test seam: a screenshot is queued for the next rendered frame. */
  get capturePending(): boolean { return this.captureRequested; }

  /** Test seam: drive the orbit directly (same clamps as pointer input). */
  setOrbit(o: Partial<PhotoOrbit>): void {
    this.orbitState = clampOrbit({ ...this.orbitState, ...o });
  }

  enter(): boolean {
    if (this._active || this.disposed) return this._active;
    if (!this.deps.canEnter()) return false;
    const target = this.deps.getTarget();
    if (!target) return false;
    const { camera } = this.deps;
    this.saved = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov };
    this.look.copy(target);
    this.look.y += PHOTO_LOOK_HEIGHT;
    this.orbitState = deriveOrbit(camera.position, this.look);
    this.hideOverlays();
    this.bar.style.display = 'flex';
    this._active = true;
    this.deps.clearInput();
    this.updateCamera();
    return true;
  }

  exit(): boolean {
    if (!this._active) return false;
    this._active = false;
    this.pointers.clear();
    this.pinchDist = 0;
    this.bar.style.display = 'none';
    this.restoreOverlays();
    if (this.saved) {
      const { camera } = this.deps;
      camera.position.copy(this.saved.position);
      camera.quaternion.copy(this.saved.quaternion);
      camera.fov = this.saved.fov;
      camera.updateProjectionMatrix();
    }
    this.saved = null;
    this.deps.clearInput();
    return true;
  }

  /**
   * Position the camera from the orbit state around the frozen target.
   * Called by Engine.step every rendered frame while active (after the
   * skipped sim block, before the render) — the only camera write in
   * photo mode. No collision probe: the orbit is presentation-only and
   * may pass through walls; the frozen world does not move to meet it.
   */
  updateCamera(): void {
    if (!this._active) return;
    const target = this.deps.getTarget();
    if (!target) return;
    this.look.copy(target);
    this.look.y += PHOTO_LOOK_HEIGHT;
    orbitOffset(this.orbitState, this.offset);
    this.deps.camera.position.copy(this.look).add(this.offset);
    this.deps.camera.lookAt(this.look);
  }

  /** Queue a screenshot for the next rendered frame (no-op when inactive). */
  requestCapture(): boolean {
    if (!this._active) return false;
    this.captureRequested = true;
    return true;
  }

  /**
   * Read the canvas synchronously after the frame's render (Engine.step
   * calls this in the same task as postfx.render(), so the drawing
   * buffer is still valid). Stores the data URL and triggers the
   * browser download for the user. No-op unless a capture was queued.
   */
  consumeCapture(): void {
    if (!this.captureRequested) return;
    this.captureRequested = false;
    try {
      const url = this.deps.canvas.toDataURL('image/png');
      this._lastScreenshot = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = 'xandria-photo.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      this._lastScreenshot = null;
    }
  }

  /**
   * Hide every DOM overlay that is a direct child of the engine container
   * except the WebGL canvas and this controller's own bar, snapshotting
   * each element's inline display so exit() restores it exactly. This
   * covers the HUD root, the modal layer, the minimap, every panel chip
   * and the touch controls — present and future — without naming them.
   * The perf overlay lives on document.body, so it is hidden too.
   */
  private hideOverlays(): void {
    this.hidden = [];
    for (const child of Array.from(this.deps.container.children)) {
      const el = child as HTMLElement;
      if (el === this.bar || el === this.deps.canvas) continue;
      this.hidden.push({ el, display: el.style.display });
      el.style.display = 'none';
    }
    const perf = document.getElementById('xandria-perf-overlay');
    if (perf) {
      this.hidden.push({ el: perf as HTMLElement, display: (perf as HTMLElement).style.display });
      (perf as HTMLElement).style.display = 'none';
    }
  }

  private restoreOverlays(): void {
    for (const { el, display } of this.hidden) el.style.display = display;
    this.hidden = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this._active) this.exit();
    window.removeEventListener('keydown', this.onKeyDown);
    this.deps.container.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.deps.container.removeEventListener('wheel', this.onWheel, { capture: true });
    this.bar.remove();
  }
}
