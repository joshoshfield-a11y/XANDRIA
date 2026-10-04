/**
 * Pickup variety + timed buffs (blueprint layer).
 *
 * The engine's Pickups only knows coin/health/ammo/powerup. This module adds
 * shield (temporary damage absorb), rapid-fire (timed), score multiplier
 * (timed) and magnet (timed): new kinds are spawned as 'powerup' shells, then
 * given distinct meshes + an effect tag. Collecting one flows through the
 * blueprint's normal onCollect (so Progression.onPickup XP is automatic).
 *
 * Timed effects tick down in EffectState; remaining time renders in a small
 * blueprint-side DOM overlay (EffectHud) since HUD.ts is engine-owned.
 * All placement rolls use the passed rng — deterministic.
 */
import * as THREE from 'three';
import type { Engine } from '../engine/Engine';
import type { GameSpec } from '@spec';
import { Pickups, type Pickup } from '../engine/game/Pickups';
import type { Rng } from '../engine/core/Rng';
import type { PlayerAvatar } from './common';

export type EffectKind = 'shield' | 'rapid' | 'mult' | 'magnet';

export const EFFECT_DEFS: Record<EffectKind, { name: string; color: string; duration: number; hint: string }> = {
  shield: { name: 'AEGIS SHIELD', color: '#4db8ff', duration: 25, hint: 'damage absorbed' },
  rapid:  { name: 'RAPID FIRE', color: '#ff9a3c', duration: 12, hint: 'fire rate doubled' },
  mult:   { name: 'SCORE ×2', color: '#ffd23f', duration: 20, hint: 'double score' },
  magnet: { name: 'MAGNETIZE', color: '#c97aff', duration: 15, hint: 'pickup range up' },
};

const effectTags = new WeakMap<Pickup, EffectKind>();
/** Effect tag for a collected pickup (undefined for vanilla kinds). */
export function effectOf(p: Pickup): EffectKind | undefined {
  return effectTags.get(p);
}

export class EffectState {
  timers = new Map<EffectKind, number>();
  /** remaining absorb pool for the shield effect */
  shieldPool = 0;
  /** weaponMods.rateOfFire value to restore when rapid expires */
  savedRof: number | null = null;

  tick(dt: number, spec?: GameSpec): void {
    for (const [k, t] of [...this.timers]) {
      const nt = t - dt;
      if (nt <= 0) {
        this.timers.delete(k);
        if (k === 'rapid' && spec && this.savedRof !== null) {
          const wm = spec.custom?.weaponMods;
          if (wm) wm.rateOfFire = this.savedRof;
          this.savedRof = null;
        }
        if (k === 'shield') this.shieldPool = 0;
      } else {
        this.timers.set(k, nt);
      }
    }
  }

  isActive(k: EffectKind): boolean { return this.timers.has(k); }
  remaining(k: EffectKind): number { return this.timers.get(k) ?? 0; }
  scoreMult(): number { return this.isActive('mult') ? 2 : 1; }
  magnetMult(): number { return this.isActive('magnet') ? 1.8 : 1; }
  /** racing: boost-pad charge multiplier while rapid is active */
  boostMult(): number { return this.isActive('rapid') ? 2 : 1; }
}

export interface EffectFlavor { name?: string; hint?: string; }

/**
 * Apply a collected effect. Rapid-fire doubles weaponMods.rateOfFire (the
 * value PlayerAvatar.shoot() reads per shot) and restores it on expiry;
 * racing passes avatar=null and reads boostMult() for pad charging instead.
 */
export function applyPickupEffect(
  engine: Engine,
  fx: EffectState,
  avatar: PlayerAvatar | null,
  spec: GameSpec,
  kind: EffectKind,
  flavor: EffectFlavor = {},
): void {
  const def = EFFECT_DEFS[kind];
  engine.audio.play('powerup');
  engine.hud.toast(`${flavor.name ?? def.name} — ${flavor.hint ?? def.hint}`);
  switch (kind) {
    case 'shield':
      fx.shieldPool = 60;
      fx.timers.set('shield', def.duration);
      if (avatar) wrapShieldDamage(engine, avatar, fx);
      break;
    case 'rapid': {
      fx.timers.set('rapid', def.duration);
      if (avatar) {
        const custom = spec.custom ?? (spec.custom = {});
        const wm = custom.weaponMods ?? (custom.weaponMods = {});
        if (fx.savedRof === null) fx.savedRof = wm.rateOfFire ?? 1;
        wm.rateOfFire = fx.savedRof * 2;
      }
      break;
    }
    case 'mult':
      fx.timers.set('mult', def.duration);
      break;
    case 'magnet':
      fx.timers.set('magnet', def.duration);
      break;
  }
}

/**
 * Install the shield absorb in front of avatar.damage (once). While the pool
 * holds, incoming damage is eaten first; iframes are still respected so a
 * shield never spends itself on a hit the iframes would have blocked.
 */
export function wrapShieldDamage(engine: Engine, avatar: PlayerAvatar, fx: EffectState): void {
  const a = avatar as unknown as { __shieldWrapped?: boolean; iframes: number };
  if (a.__shieldWrapped) return;
  a.__shieldWrapped = true;
  const orig = avatar.damage.bind(avatar);
  avatar.damage = (amount: number, from?: THREE.Vector3) => {
    if (fx.shieldPool > 0 && a.iframes <= 0 && engine.state === 'playing' && amount > 0) {
      const absorbed = Math.min(fx.shieldPool, amount);
      fx.shieldPool -= absorbed;
      amount -= absorbed;
      engine.particles.magic(
        avatar.ctrl.position.clone().add(new THREE.Vector3(0, 1.2, 0)),
        '#4db8ff',
        10,
      );
      engine.audio.play('pickup', { pitch: 1.4, vol: 0.5 });
      engine.hud.setHealth(avatar.health / avatar.maxHealth);
      if (amount <= 0) return;
    }
    orig(amount, from);
  };
}

/** Spawn one effect pickup: a 'powerup' shell with a distinct mesh + tag. */
export function spawnEffectPickup(pickups: Pickups, engine: Engine, kind: EffectKind, pos: THREE.Vector3): void {
  pickups.spawn('powerup', pos);
  const p = pickups.list[pickups.list.length - 1];
  effectTags.set(p, kind);
  engine.scene.remove(p.mesh);
  const mesh = makeEffectMesh(engine, kind);
  mesh.position.copy(p.pos);
  mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  engine.scene.add(mesh);
  p.mesh = mesh;
}

function makeEffectMesh(engine: Engine, kind: EffectKind): THREE.Object3D {
  const m = engine.mats;
  const def = EFFECT_DEFS[kind];
  switch (kind) {
    case 'shield':
      return new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), m.glow(def.color, 1.8));
    case 'rapid': {
      const g = new THREE.Group();
      const mat = m.glow(def.color, 1.8);
      const up = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 6), mat);
      up.position.y = 0.35;
      const down = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 6), mat);
      down.position.y = -0.35;
      down.rotation.x = Math.PI;
      g.add(up, down);
      return g;
    }
    case 'mult': {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), m.glow(def.color, 2)));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.07, 8, 24), m.glow('#fff2b0', 1.4));
      ring.rotation.x = Math.PI / 2.4;
      g.add(ring);
      return g;
    }
    case 'magnet':
      return new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.16, 10, 22), m.glow(def.color, 1.8));
  }
}

/** Deterministically scatter one of each requested effect kind over terrain. */
export function scatterEffects(
  pickups: Pickups,
  engine: Engine,
  rng: Rng,
  y: (x: number, z: number) => number,
  half: number,
  kinds: EffectKind[],
  avoid?: { x: number; z: number; r: number }[],
): void {
  for (const k of kinds) {
    for (let tries = 0; tries < 12; tries++) {
      const x = rng.range(-half, half), z = rng.range(-half, half);
      if (avoid?.some((a) => (x - a.x) ** 2 + (z - a.z) ** 2 < a.r * a.r)) continue;
      spawnEffectPickup(pickups, engine, k, new THREE.Vector3(x, y(x, z) + 1.1, z));
      break;
    }
  }
}

/**
 * Timed-effect countdown overlay. Blueprint-side DOM (HUD.ts is engine-owned):
 * small pills, top-right under the objective tracker, pointer-events none.
 * No-ops cleanly when document.body is unavailable (unit-test stubs).
 */
export class EffectHud {
  private root: { innerHTML: string; remove(): void } | null = null;
  private lastHtml = '';
  private lastT = -1;

  constructor() {
    try {
      const doc = (globalThis as unknown as { document?: any }).document;
      if (!doc || typeof doc.createElement !== 'function' || !doc.body?.appendChild) return;
      const root = doc.createElement('div');
      const s = root.style;
      s.position = 'fixed';
      s.top = '76px';
      s.right = '14px';
      s.display = 'flex';
      s.flexDirection = 'column';
      s.gap = '6px';
      s.zIndex = '40';
      s.pointerEvents = 'none';
      s.fontFamily = 'monospace';
      doc.body.appendChild(root);
      this.root = root;
    } catch {
      this.root = null;
    }
  }

  update(fx: EffectState, now: number): void {
    if (!this.root || now - this.lastT < 0.25) return;
    this.lastT = now;
    const pills: string[] = [];
    for (const [k, t] of fx.timers) {
      const d = EFFECT_DEFS[k];
      const extra = k === 'shield' ? ` · ${Math.ceil(fx.shieldPool)}` : '';
      pills.push(
        `<div style="background:rgba(8,10,18,.72);border:1px solid ${d.color};border-radius:6px;` +
        `padding:4px 10px;color:#fff;font-size:12px;letter-spacing:.08em">` +
        `<span style="color:${d.color}">◆</span> ${d.name} <b>${Math.ceil(t)}s${extra}</b></div>`,
      );
    }
    const html = pills.join('');
    if (html !== this.lastHtml) {
      this.root.innerHTML = html;
      this.lastHtml = html;
    }
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
  }
}
