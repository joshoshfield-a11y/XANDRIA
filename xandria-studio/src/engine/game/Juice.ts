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
      this.items.push({ el, life: 0, max: 1, wp: new THREE.Vector3() });
    }
  }

  /** Wire the pooled flash-light pool (called by Engine once Sky exists). */
  setFlash(fn: NonNullable<Juice['flashLight']>): void {
    this.flashLight = fn;
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
