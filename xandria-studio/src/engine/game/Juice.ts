/**
 * Game-feel ("juice"): decaying-trauma screenshake, hit-stop freezes,
 * pooled floating damage numbers, and particle helpers.
 *
 * Cosmetic only — Math.random is fine here; nothing here may influence
 * the simulation. Engine.step() applies the shake offset around the render
 * (add before, subtract after) so it never accumulates into the camera.
 */
import * as THREE from 'three';
import type { Particles } from '../gfx/Particles';
import {
  formatFloatingText,
  type FloatingTextKind,
} from './floatingText';

const CSS = `
.xjuice { position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:9; }
.xjuice .dmgnum { position:absolute; transform:translate(-50%,-50%); font-weight:800; font-size:18px;
  font-family:'Segoe UI',system-ui,sans-serif; text-shadow:0 2px 6px rgba(0,0,0,.85); opacity:0;
  white-space:nowrap; }
`;

const DMG_POOL = 20;

interface DmgItem {
  el: HTMLDivElement;
  life: number;
  max: number;
  wp: THREE.Vector3;
  scale: number;
}

export class Juice {
  /** 0..1 — screenshake trauma, decays in update(). */
  trauma = 0;
  /**
   * ACCESSIBILITY PASS: reduced-motion gate (set by Engine.
   * applyAccessibility). shake() becomes a no-op and shakeOffset() returns
   * zero, so the camera never moves from juice. Particle bursts are gated
   * separately in Particles.emit(); hit-stop and damage numbers are
   * deliberately untouched (not shake/particles/zoom).
   */
  reducedMotion = false;
  /**
   * DAMAGE-NUMBERS: floating-text master toggle (settings: DAMAGE
   * NUMBERS, persisted per save slot). When false, spawnText /
   * damageNumber are no-ops AND any live numbers are cleared, so
   * toggling off suppresses all numbers immediately. Default true.
   * Engine.applySettings() keeps this in step with Settings.data.
   */
  floatingTextEnabled = true;
  private freezeUntil = 0;
  private layer: HTMLDivElement;
  private items: DmgItem[] = [];
  private cursor = 0;
  /** Live items — the idle fast path: update() skips the pool loop at 0. */
  private activeCount = 0;
  /**
   * DAMAGE-NUMBERS mobile-safe clamp (px, container-relative): numbers
   * never project into the quest-tracker band (top) or the touch-button
   * cluster (bottom). Re-measured on every spawn (spawn-time cost only,
   * never per-frame) from the live DOM; 0 when the HUD elements are
   * absent (unit tests, desktop without touch UI).
   */
  private safeTopPx = 0;
  private safeBottomPx = 0;
  private tmp = new THREE.Vector3();
  /** Optional pooled flash-light hook (wired by Engine once Sky exists). */
  private flashLight: ((color: THREE.ColorRepresentation, pos: THREE.Vector3, intensity?: number, distance?: number, duration?: number) => void) | null = null;

  constructor(
    private container: HTMLElement,
    private particles: Particles,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.layer = document.createElement('div');
    this.layer.className = 'xjuice';
    container.appendChild(this.layer);
    for (let i = 0; i < DMG_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'dmgnum';
      this.layer.appendChild(el);
      this.items.push({ el, life: 0, max: 1, wp: new THREE.Vector3(), scale: 1 });
    }
  }

  /** Wire the pooled flash-light pool (called by Engine once Sky exists). */
  setFlash(fn: NonNullable<Juice['flashLight']>): void {
    this.flashLight = fn;
  }

  /**
   * DAMAGE-NUMBERS: set the floating-text master toggle. Turning it off
   * clears every live number immediately (no stragglers mid-float).
   */
  setFloatingTextEnabled(on: boolean): void {
    this.floatingTextEnabled = on;
    if (!on) {
      for (const it of this.items) {
        it.life = 0;
        it.el.style.opacity = '0';
      }
      this.activeCount = 0;
    }
  }

  /**
   * DAMAGE-NUMBERS: measure the mobile-safe exclusion bands from the live
   * HUD DOM (quest tracker above, touch buttons / stick / d-pad below).
   * Spawn-time only; any failure (fake containers in unit tests, missing
   * DOM) falls back to zero insets instead of throwing.
   */
  private measureSafeArea(): void {
    try {
      if (typeof document === 'undefined') return;
      const container = this.container as unknown as {
        getBoundingClientRect?: () => { top: number; bottom: number };
      };
      if (typeof container.getBoundingClientRect !== 'function') return;
      const crect = container.getBoundingClientRect();
      let top = 0;
      const tracker = document.querySelector('#xandria-quest-tracker');
      if (tracker) {
        const r = tracker.getBoundingClientRect();
        if (r.height > 0) top = Math.max(0, r.bottom - crect.top) + 8;
      }
      let bottom = 0;
      for (const sel of ['.tbtn', '.stickbase', '.dpad']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.height > 0) bottom = Math.max(bottom, crect.bottom - r.top);
        }
      }
      // Only overwrite on a successful measurement: when the container
      // cannot be measured (unit-test fakes), prior insets stand.
      this.safeTopPx = top;
      this.safeBottomPx = bottom > 0 ? bottom + 8 : 0;
    } catch {
      // Measurement must never break a spawn; keep prior insets.
    }
  }

  /** Screenshake impulse, 0..1. Stacks up to 1. No-op under reduced motion. */
  shake(amount: number): void {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  /** Freeze the simulation briefly (kill impact). Default 75ms. */
  hitStop(ms = 75): void {
    this.freezeUntil = Math.max(this.freezeUntil, performance.now() + ms);
  }

  hitStopActive(): boolean {
    return performance.now() < this.freezeUntil;
  }

  /**
   * Camera-space shake offset for this frame. Engine adds it to the camera
   * before render and subtracts it right after.
   */
  shakeOffset(out: THREE.Vector3): THREE.Vector3 {
    if (this.reducedMotion || this.trauma <= 0) return out.set(0, 0, 0);
    const s = this.trauma * this.trauma * 0.55;
    return out.set((Math.random() * 2 - 1) * s, (Math.random() * 2 - 1) * s * 0.7, 0);
  }

  /** Particle burst at a world position (delegates to the pooled Points system). */
  burst(
    pos: THREE.Vector3,
    opts: { count?: number; color?: string; color2?: string; speed?: number; life?: number; size?: number; gravity?: number; up?: number; blending?: 'additive' | 'normal'; grow?: number } = {},
  ): void {
    this.particles.burst(pos, opts);
  }

  /**
   * Polish wave: per-hit combat feedback. Sparks + smoke puff + small shake —
   * call from every damage event so combat hits READ. (Melee already adds its
   * own hit-stop + damage numbers on top of this.)
   */
  combatHit(pos: THREE.Vector3, scale = 1): void {
    this.particles.sparks(pos, '#ffe08a', Math.round(7 * scale));
    this.particles.smokePuff(pos, Math.max(2, Math.round(3 * scale)));
    this.shake(0.08 * scale);
  }

  /** Projectile impact: punchier than a bare spark burst — smoke + shake. */
  impact(pos: THREE.Vector3, scale = 1, sparkColor = '#ffe08a'): void {
    this.particles.impactFX(pos, scale, sparkColor);
    this.shake(0.12 * scale);
  }

  /** Muzzle flash + a wisp of (real, alpha-blended) gun smoke. */
  muzzle(pos: THREE.Vector3): void {
    this.particles.burst(pos, { count: 8, color: '#ffdd66', color2: '#ff8833', speed: 5, life: 0.14, size: 1.8, gravity: 0 });
    this.particles.smokePuff(pos, 4, '#9a9a92');
    this.flashLight?.('#ffcc55', pos, 8, 14, 0.12);
  }

  /** Enemy death: explosion + smoke column + shake + brief hit-stop. */
  deathFX(pos: THREE.Vector3, scale = 1): void {
    this.particles.explosion(pos, scale);
    this.particles.smokePuff(pos, Math.round(6 * scale), '#5a564c');
    this.shake(Math.min(0.4, 0.25 * scale));
    this.hitStop(60);
    this.flashLight?.('#ff7733', pos, 12 * scale, 18, 0.2);
  }

  /** Drift-smoke helper (vehicle crew may also call particles.burst() directly). */
  driftSmoke(pos: THREE.Vector3): void {
    this.particles.smokePuff(pos, 3, '#7a7568');
  }

  /** Pickup sparkle trail puff. */
  sparkle(pos: THREE.Vector3, color = '#7af7ff'): void {
    this.particles.trail(pos, color);
  }

  /** Floating combat-text number at a world position. Pooled (cap 20, oldest reused). */
  damageNumber(camera: THREE.Camera, worldPos: THREE.Vector3, text: string, color = '#ffd23f'): void {
    this.spawn(camera, worldPos, text, color, 1);
  }

  /**
   * DAMAGE-NUMBERS: themed floating number. Style (color via the live
   * colorblind palette, prefix/suffix/size) comes from FLOATING_TEXT_THEME
   * — callers pass a kind + amount, never a hex. No-op while the toggle
   * is off. Per-frame cost is zero when idle (activeCount fast path in
   * update()); the pool itself never allocates after construction.
   */
  spawnText(camera: THREE.Camera, worldPos: THREE.Vector3, kind: FloatingTextKind, amount: number): void {
    const f = formatFloatingText(kind, amount);
    this.spawn(camera, worldPos, f.text, f.color, f.scale);
  }

  private spawn(camera: THREE.Camera, worldPos: THREE.Vector3, text: string, color: string, scale: number): void {
    if (!this.floatingTextEnabled) return;
    this.measureSafeArea();
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    if (it.life <= 0) this.activeCount++;
    it.wp.copy(worldPos);
    it.life = it.max = 0.9;
    it.scale = scale;
    it.el.textContent = text;
    it.el.style.color = color;
    it.el.style.fontSize = `${Math.round(18 * scale)}px`;
    this.place(camera, it);
  }

  private place(camera: THREE.Camera, it: DmgItem): void {
    this.tmp.copy(it.wp).project(camera);
    if (this.tmp.z > 1) {
      it.el.style.opacity = '0';
      return;
    }
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    let px = (this.tmp.x * 0.5 + 0.5) * w;
    let py = (-this.tmp.y * 0.5 + 0.5) * h;
    // Mobile-safe clamp: keep numbers out of the tracker band (top) and
    // the touch-button cluster (bottom); fall back to viewport edges
    // when the bands would swallow the viewport (tiny heights).
    const top = this.safeTopPx + 8;
    const bottom = h - this.safeBottomPx - 8;
    if (bottom - top >= 32) {
      py = Math.min(Math.max(py, top), bottom);
    } else {
      py = Math.min(Math.max(py, 8), h - 8);
    }
    px = Math.min(Math.max(px, 8), w - 8);
    it.el.style.left = `${px}px`;
    it.el.style.top = `${py}px`;
    it.el.style.opacity = '1';
  }

  update(dt: number, camera: THREE.Camera): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.activeCount <= 0) return; // idle fast path: zero pool work
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) {
        this.activeCount--;
        it.el.style.opacity = '0';
        continue;
      }
      it.wp.y += dt * 1.7; // float upward
      this.place(camera, it);
      it.el.style.opacity = String(Math.min(1, (it.life / it.max) * 2.5));
    }
  }

  /** Clear all juice state (restart). */
  reset(): void {
    this.trauma = 0;
    this.freezeUntil = 0;
    this.activeCount = 0;
    for (const it of this.items) {
      it.life = 0;
      it.el.style.opacity = '0';
    }
  }
}
