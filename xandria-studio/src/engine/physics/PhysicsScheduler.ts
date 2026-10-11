/**
 * PhysicsScheduler (physics wave, item 4): distance-based activation around
 * the player, an active-rigid-body budget cap, and clean release.
 *
 * Bands (squared-distance scan, allocation-free):
 *   ≤ activeRadius  → awake (wakeUp if sleeping)
 *   ≤ dormantRadius → leave alone (cannon sleep takes over)
 *   > dormantRadius → force sleep
 * Budget: awake dynamic bodies over the cap are put to sleep, farthest first.
 * Cap is configurable and quality-tier-scaled (budgetForQuality).
 *
 * Builds on cannon-es sleeping — it never fights it: we only nudge sleep
 * state, we never override velocities or disable sleep. unregister() removes
 * the body from the world for clean region-unload release.
 */
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';

export interface SchedulerEntry {
  body: CANNON.Body;
  /** exempt from budget sleep + forced sleep (player, mission-critical) */
  essential: boolean;
}

export interface SchedulerOpts {
  /** bodies within this radius of the player stay awake (m) */
  activeRadius: number;
  /** beyond this radius bodies are forced to sleep (m) */
  dormantRadius: number;
  /** max awake dynamic bodies; farthest non-essential sleep first */
  budget: number;
}

/** Quality-tier-scaled active-body budgets (perf acceptance bar). */
export function budgetForQuality(q: 'retro' | 'standard' | 'high'): number {
  return q === 'high' ? 96 : q === 'standard' ? 64 : 32;
}

export const DEFAULT_SCHEDULER_OPTS: SchedulerOpts = {
  activeRadius: 28,
  dormantRadius: 60,
  budget: budgetForQuality('standard'),
};

export class PhysicsScheduler {
  private entries: SchedulerEntry[] = [];
  private opts: SchedulerOpts;
  /** reused scratch — hot path is allocation-free */
  private player = { x: 0, y: 0, z: 0 };

  constructor(private engine: Engine, opts: Partial<SchedulerOpts> = {}) {
    this.opts = { ...DEFAULT_SCHEDULER_OPTS, ...opts };
  }

  /** Register a dynamic body for distance-based management. Returns an unregister fn. */
  register(body: CANNON.Body, essential = false): () => void {
    const e: SchedulerEntry = { body, essential };
    this.entries.push(e);
    return () => this.unregister(body);
  }

  /** Clean release: stop tracking AND remove the body from the physics world. */
  unregister(body: CANNON.Body) {
    const i = this.entries.findIndex((e) => e.body === body);
    if (i >= 0) this.entries.splice(i, 1);
    this.engine.physics.remove(body);
  }

  get tracked(): number { return this.entries.length; }

  /** Awake dynamic (non-static) tracked bodies. Allocation-free scan. */
  awakeCount(): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.body.type !== CANNON.Body.STATIC && e.body.sleepState !== CANNON.Body.SLEEPING) n++;
    }
    return n;
  }

  /**
   * Per-frame (or per-N-frames) update. Reads playerPos directly — no allocs.
   * Sleeping bodies use cannon's own sleepState; SLEEPING === 2 in cannon-es.
   */
  update(playerPos: { x: number; y: number; z: number }) {
    const { activeRadius, dormantRadius, budget } = this.opts;
    const ar2 = activeRadius * activeRadius;
    const dr2 = dormantRadius * dormantRadius;
    for (const e of this.entries) {
      const b = e.body;
      if (b.type === CANNON.Body.STATIC) continue;
      const dx = b.position.x - playerPos.x;
      const dy = b.position.y - playerPos.y;
      const dz = b.position.z - playerPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= ar2) {
        if (b.sleepState === CANNON.Body.SLEEPING) b.wakeUp();
      } else if (d2 > dr2 && !e.essential) {
        if (b.sleepState !== CANNON.Body.SLEEPING) b.sleep();
      }
    }

    // budget enforcement: sleep farthest awake non-essential bodies
    let awake = this.awakeCount();
    if (awake > budget) {
      // selection scan without allocation: repeatedly find the farthest awake
      // body. Budget overruns are small; this is O(over * n), no garbage.
      let guard = this.entries.length;
      while (awake > budget && guard-- > 0) {
        let far: SchedulerEntry | null = null;
        let farD2 = -1;
        for (const e of this.entries) {
          const b = e.body;
          if (e.essential || b.sleepState === CANNON.Body.SLEEPING) continue;
          const dx = b.position.x - playerPos.x;
          const dy = b.position.y - playerPos.y;
          const dz = b.position.z - playerPos.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > farD2) { farD2 = d2; far = e; }
        }
        if (!far) break;
        far.body.sleep();
        awake--;
      }
    }
  }

  dispose() {
    for (const e of this.entries) this.engine.physics.remove(e.body);
    this.entries.length = 0;
  }
}
