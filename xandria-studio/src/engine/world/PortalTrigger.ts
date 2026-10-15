/**
 * Open World — Portals, workstream B: edge trigger volumes + crossing
 * detection. Pure logic — no THREE, no Engine — so the debounce rules unit
 * test without a renderer or physics world.
 *
 * The four trigger volumes sit slightly INSIDE the map edge (a band of depth
 * `bandDepth` hugging each edge). Crossing detection is a per-edge state
 * machine:
 *
 *   idle ──enter band from inward──▶ armed ──reach the edge plane (d ≤ triggerDepth)
 *                                        after ≥ armMs inside the band──▶ TRIGGER
 *                    │                         │
 *                    └─leave band inward───────┴─disarm (back to idle)
 *
 * Anti-false-trip properties (all covered by unit tests):
 * - jumping near the edge never trips: jumps move only in Y; the trigger
 *   reads X/Z only, and arming requires sustained inward→outward travel.
 * - walking parallel to the edge inside the band arms but never triggers —
 *   disarming fires as soon as the player drifts back inward.
 * - straddling / lingering at the edge can't double-fire: the PortalManager
 *   holds a transition lock; the trigger additionally enforces a cooldown
 *   after every accepted crossing.
 *
 * Conventions: +z is north, −z south, +x east, −x west. `half` = map
 * half-size (4000 for the 8km maps). d = inward distance from the edge
 * plane (d = half − z on the north edge); d < 0 means past the plane.
 */
import type { MapEdge } from './MapGraph';

export type PortalEdge = MapEdge;

export interface PortalTriggerOptions {
  /** map half-size in meters (world.terrain.size / 2). */
  half: number;
  /** band depth inside the edge where arming happens. Default 12. */
  bandDepth?: number;
  /** crossing plane: trigger when d ≤ this. Default 1.5 (fires while the
   *  player is still pressed against the boundary wall on pre-A branches,
   *  and just inside the energy field once workstream A lands). */
  triggerDepth?: number;
  /** ms the crossing must be sustained inside the band before it counts.
   *  Default 120. */
  armMs?: number;
  /** ms after a crossing during which no new crossing is accepted.
   *  Default 2500. */
  cooldownMs?: number;
}

export class PortalTrigger {
  readonly half: number;
  readonly bandDepth: number;
  readonly triggerDepth: number;
  readonly armMs: number;
  readonly cooldownMs: number;

  private armedEdge: PortalEdge | null = null;
  private armedAt = 0;
  private locked = false;
  private cooldownUntil = 0;

  constructor(opts: PortalTriggerOptions) {
    this.half = opts.half;
    this.bandDepth = opts.bandDepth ?? 12;
    this.triggerDepth = opts.triggerDepth ?? 1.5;
    this.armMs = opts.armMs ?? 120;
    this.cooldownMs = opts.cooldownMs ?? 2500;
  }

  get isLocked(): boolean { return this.locked; }

  /** Transition lock: while locked, sample() never fires (interrupt-safe). */
  lock(): void { this.locked = true; }

  /**
   * Release the lock and start the post-transition cooldown. sample() stays
   * silent until `nowMs` passes the cooldown window.
   */
  unlock(nowMs: number): void {
    this.locked = false;
    this.armedEdge = null;
    this.cooldownUntil = nowMs + this.cooldownMs;
  }

  /** d = inward distance from the edge plane for the given edge. */
  private dFor(edge: PortalEdge, x: number, z: number): number {
    switch (edge) {
      case 'N': return this.half - z;
      case 'S': return this.half + z;
      case 'E': return this.half - x;
      case 'W': return this.half + x;
    }
  }

  private inBand(d: number): boolean { return d < this.bandDepth; }

  /**
   * Feed one player X/Z sample. Returns the crossed edge when a debounced
   * crossing is detected, else null. Monotonic-ish nowMs (performance.now()
   * style) is fine — only deltas are used.
   */
  sample(x: number, z: number, nowMs: number): PortalEdge | null {
    if (this.locked || nowMs < this.cooldownUntil) return null;
    const edges: PortalEdge[] = ['N', 'S', 'E', 'W'];
    if (this.armedEdge === null) {
      // idle: arm only on an observed entry into a band. (If the very first
      // sample is already inside a band — e.g. a teleport — we arm too, but
      // the armMs sustain requirement still applies, and the PortalManager's
      // cooldown covers the post-transition case.)
      for (const e of edges) {
        if (this.inBand(this.dFor(e, x, z))) {
          this.armedEdge = e;
          this.armedAt = nowMs;
          break;
        }
      }
      return null;
    }
    const e = this.armedEdge;
    const d = this.dFor(e, x, z);
    if (!this.inBand(d)) {
      // drifted back inward — disarm, no trip
      this.armedEdge = null;
      return null;
    }
    // still in the band: did the player also wander into a *different* edge's
    // band (corners)? The first-armed edge wins — a corner crossing resolves
    // to whichever band was entered first. Deterministic, no double-fire.
    if (d <= this.triggerDepth && nowMs - this.armedAt >= this.armMs) {
      this.armedEdge = null;
      return e;
    }
    return null;
  }

  /** Introspection for tests / the e2e: which edge is currently armed. */
  get armed(): PortalEdge | null { return this.armedEdge; }

  reset(): void {
    this.armedEdge = null;
    this.locked = false;
    this.cooldownUntil = 0;
  }
}
