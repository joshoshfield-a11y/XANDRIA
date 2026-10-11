/**
 * MeleeCombat (physics wave, item 6): formal melee phases
 * wind-up → active → recovery → return-to-idle, with capsule/sphere sweeps
 * along the weapon path during ACTIVE frames.
 *
 * Extends the projectile sweep pattern (Projectiles.update raycasts along
 * motion with skipBody per the wave-beta semantics): during active frames we
 * sample the weapon tip along its arc and raycast segment-to-segment with the
 * attacker's body excluded, so fast swings can't tunnel through enemies.
 *
 * Damage numbers stay with the caller: onHit(body, point) fires once per
 * target per swing; the blueprint resolves damage (same values as today —
 * feel unchanged, timing formalized).
 *
 * Adoption (PlayerAvatar.melee in blueprints/common.ts, ~3 lines):
 *   this.meleeSwing ??= new MeleeSwing(this.engine);
 *   this.meleeSwing.start(this.ctrl.position, aimYaw, {
 *     range, arc, damage, skipBody: this.ctrl.body,
 *     onHit: (body, point) => { resolve body→enemy, e.damage(damage, origin); juice… },
 *   });
 *   // per frame: this.meleeSwing.update(dt)
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';

export type MeleePhase = 'idle' | 'windup' | 'active' | 'recovery';

/** Per-phase timing in seconds. Data, not code — tune without touching logic. */
export interface MeleeTiming {
  windup: number;
  active: number;
  recovery: number;
}

export const DEFAULT_MELEE_TIMING: MeleeTiming = {
  windup: 0.18,
  active: 0.22,
  recovery: 0.34,
};

export interface MeleeSwingOpts {
  /** reach of the weapon tip from the attacker (m) */
  range?: number;
  /** half-angle of the swing arc (rad) */
  arc?: number;
  /** weapon tip height above the attacker's feet (m) */
  tipHeight?: number;
  /** collision mask for the sweep raycasts */
  mask?: number;
  /** attacker body — excluded from sweeps (wave-beta skipBody semantics) */
  skipBody?: CANNON.Body;
  /** per-phase timing override */
  timing?: Partial<MeleeTiming>;
  /** fired once per target body per swing */
  onHit?: (body: CANNON.Body, point: THREE.Vector3) => void;
  /** fired when the swing enters the active window (whoosh) */
  onActiveStart?: () => void;
}

const TIP_SAMPLES = 3; // arc subdivisions per active substep — deterministic

export class MeleeSwing {
  phase: MeleePhase = 'idle';
  private t = 0;
  private timing: MeleeTiming = { ...DEFAULT_MELEE_TIMING };
  private origin = new THREE.Vector3();
  private yaw = 0;
  private range = 2.6;
  private arc = 1.3;
  private tipHeight = 1.2;
  private mask = -1;
  private skipBody?: CANNON.Body;
  private onHit: (body: CANNON.Body, point: THREE.Vector3) => void = () => {};
  private onActiveStart: () => void = () => {};
  private hitSet = new Set<CANNON.Body>();
  private prevTip = new THREE.Vector3();
  private curTip = new THREE.Vector3();
  private swept = 0; // 0..1 progress through the active window

  constructor(private engine: Engine) {}

  get active(): boolean { return this.phase !== 'idle'; }

  /** Begin a swing. No-op if a swing is already in progress (no cancel-spam). */
  start(origin: THREE.Vector3, yaw: number, opts: MeleeSwingOpts = {}): boolean {
    if (this.phase !== 'idle') return false;
    this.origin.copy(origin);
    this.yaw = yaw;
    this.range = opts.range ?? 2.6;
    this.arc = opts.arc ?? 1.3;
    this.tipHeight = opts.tipHeight ?? 1.2;
    this.mask = opts.mask ?? -1;
    this.skipBody = opts.skipBody;
    this.timing = { ...DEFAULT_MELEE_TIMING, ...(opts.timing ?? {}) };
    this.onHit = opts.onHit ?? (() => {});
    this.onActiveStart = opts.onActiveStart ?? (() => {});
    this.hitSet.clear();
    this.swept = 0;
    this.t = 0;
    this.phase = 'windup';
    return true;
  }

  /** Advance the phase machine. Returns the current phase (allocation-free). */
  update(dt: number): MeleePhase {
    if (this.phase === 'idle') return this.phase;
    this.t += dt;
    switch (this.phase) {
      case 'windup':
        if (this.t >= this.timing.windup) {
          this.phase = 'active';
          this.t = 0;
          this.swept = 0;
          this.tipAt(0, this.prevTip);
          this.onActiveStart();
        }
        break;
      case 'active': {
        const prev = this.swept;
        this.swept = Math.min(1, this.t / this.timing.active);
        this.sweepSegment(prev, this.swept);
        if (this.swept >= 1) { this.phase = 'recovery'; this.t = 0; }
        break;
      }
      case 'recovery':
        if (this.t >= this.timing.recovery) { this.phase = 'idle'; this.t = 0; }
        break;
    }
    return this.phase;
  }

  /** 0..1 progress of the whole swing (drives the rig's `attacking` visual). */
  get progress(): number {
    const total = this.timing.windup + this.timing.active + this.timing.recovery;
    switch (this.phase) {
      case 'idle': return 0;
      case 'windup': return this.t / total;
      case 'active': return (this.timing.windup + this.t) / total;
      case 'recovery': return (this.timing.windup + this.timing.active + this.t) / total;
    }
  }

  /** Weapon tip position at arc fraction k (0 = arc start, 1 = arc end). */
  private tipAt(k: number, out: THREE.Vector3): THREE.Vector3 {
    const a = this.yaw - this.arc + 2 * this.arc * k;
    out.set(
      this.origin.x + Math.sin(a) * this.range,
      this.origin.y + this.tipHeight,
      this.origin.z + Math.cos(a) * this.range,
    );
    return out;
  }

  /**
   * Sweep the weapon path from arc fraction k0 to k1: subdivide into
   * TIP_SAMPLES segments, raycast each tip→tip segment with the attacker's
   * body skipped. First hit per body per swing calls onHit.
   */
  private sweepSegment(k0: number, k1: number) {
    const phys = this.engine.physics;
    let px = 0, py = 0, pz = 0;
    let first = true;
    for (let i = 0; i <= TIP_SAMPLES; i++) {
      const k = k0 + (k1 - k0) * (i / TIP_SAMPLES);
      this.tipAt(k, this.curTip);
      if (!first) {
        // reuse prevTip storage as the segment start without allocating
        this.prevTip.set(px, py, pz);
        const hit = phys.raycast(this.prevTip, this.curTip, this.mask, this.skipBody);
        if (hit && !this.hitSet.has(hit.body)) {
          this.hitSet.add(hit.body);
          this.onHit(hit.body, hit.point);
        }
      }
      px = this.curTip.x; py = this.curTip.y; pz = this.curTip.z;
      first = false;
    }
    this.prevTip.set(px, py, pz);
  }

  /** Cancel the swing (stagger, hit-interrupt). */
  cancel() {
    this.phase = 'idle';
    this.t = 0;
    this.hitSet.clear();
  }
}
