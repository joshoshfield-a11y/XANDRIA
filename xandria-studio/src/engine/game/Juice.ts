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
}

export class Juice {
  /** 0..1 — screenshake trauma, decays in update(). */
  trauma = 0;
  private freezeUntil = 0;
  private layer: HTMLDivElement;
  private items: DmgItem[] = [];
  private cursor = 0;
  private tmp = new THREE.Vector3();

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
      this.items.push({ el, life: 0, max: 1, wp: new THREE.Vector3() });
    }
  }

  /** Screenshake impulse, 0..1. Stacks up to 1. */
  shake(amount: number): void {
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
    if (this.trauma <= 0) return out.set(0, 0, 0);
    const s = this.trauma * this.trauma * 0.55;
    return out.set((Math.random() * 2 - 1) * s, (Math.random() * 2 - 1) * s * 0.7, 0);
  }

  /** Particle burst at a world position (delegates to the pooled Points system). */
  burst(
    pos: THREE.Vector3,
    opts: { count?: number; color?: string; color2?: string; speed?: number; life?: number; size?: number; gravity?: number; up?: number } = {},
  ): void {
    this.particles.burst(pos, opts);
  }

  /** Pickup sparkle trail puff. */
  sparkle(pos: THREE.Vector3, color = '#7af7ff'): void {
    this.particles.trail(pos, color);
  }

  /** Floating combat-text number at a world position. Pooled (cap 20, oldest reused). */
  damageNumber(camera: THREE.Camera, worldPos: THREE.Vector3, text: string, color = '#ffd23f'): void {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.wp.copy(worldPos);
    it.life = it.max = 0.9;
    it.el.textContent = text;
    it.el.style.color = color;
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
    it.el.style.left = `${(this.tmp.x * 0.5 + 0.5) * w}px`;
    it.el.style.top = `${(-this.tmp.y * 0.5 + 0.5) * h}px`;
    it.el.style.opacity = '1';
  }

  update(dt: number, camera: THREE.Camera): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) {
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
    for (const it of this.items) {
      it.life = 0;
      it.el.style.opacity = '0';
    }
  }
}
