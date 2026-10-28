/**
 * STATUS-EFFECTS (upgrade loop): data-driven damage-over-time / slow /
 * stun statuses, applied additively through the existing damage paths.
 *
 * ONE tuning table (STATUS_TABLE) — no other file carries status numbers.
 * Four statuses:
 *   - burn:       fire DoT, 3 HP every 1s for 4s (4 ticks, 12 total).
 *   - frost-slow: chilling DoT + 50% slow, 1 HP every 1s for 3s.
 *   - shock:      stunning chain DoT, 2 HP every 0.5s for 2s (4 ticks),
 *                 movement halted while active, chains to 2 nearby foes.
 *   - poison:     lingering DoT, 2 HP every 1s for 5s (5 ticks, 10 total).
 *
 * STAT-MATH ORDER (disclosed, exact — see REPORT.md for the full order):
 * status application is step 6, AFTER the hit's own math. The hit itself
 * is computed exactly as before (base -> damageMult -> seeded variance
 * -> crit -> elemental resistance, when the elemental wave merges); the
 * status chance roll happens only after Enemy.damage() returns, consumes
 * a draw from a DEDICATED status stream (never the damage/crit streams,
 * so every pre-existing damage replication is untouched), and never
 * changes the hit's damage. Tick damage is a SEPARATE stream: flat table
 * damage per tick, applied through Enemy.tickDamage() / the avatar's
 * status tick — it bypasses shields and knockback, respects the elite
 * damage-taken multiplier, and never draws RNG.
 *
 * ELEMENTAL NOTE: the elemental-damage-types branch (unmerged at this
 * phase's base) reserves fire->burn, frost->chill, shock->stun hooks and
 * its own damage-type plumbing. This phase does NOT duplicate that
 * plumbing. Instead it defines the forward-compatible mapping
 * statusForDamageType() and the single application funnel
 * Enemy.applyStatus() / PlayerAvatar.applyStatus(), so the elemental
 * wave can wire its hook to the funnel with one call. On this base the
 * live triggers are the ones that exist here: combat abilities
 * (ABILITY_STATUS), enemy-kind hits on the player (ENEMY_KIND_STATUS),
 * and spike-trap ticks (poison). Melee/projectile hits carry no damage
 * type on this base, so they apply no status — disclosed, not faked.
 *
 * SEMANTICS (pinned by unit test):
 *   - One instance per (target, status). Re-application REFRESHES the
 *     duration (expiry = now + duration) and does NOT stack, does NOT
 *     reset the tick schedule, and does NOT add a second instance.
 *   - A missed chance roll never applies and never refreshes.
 *   - Ticks are driven by GAME TIME only (engine.time passed in as
 *     `now`) — never wall-clock, never Date.now. Tick times are
 *     now0 + k*interval for k = 1..duration/interval; a frame that
 *     jumps past several tick times fires each missed tick once,
 *     capped at the ticks the duration allows.
 *   - Slow is the MINIMUM slowMult over active statuses (shock's 0
 *     wins over frost-slow's 0.5). Shock (slowMult 0) also freezes the
 *     victim's attack cooldown while active (stun).
 *   - Statuses are run state, like the workbench buff: they do NOT
 *     survive save/reload, they persist across portal travel on the
 *     player (the avatar persists), and they die with their enemy
 *     (map-local). Death/respawn and camp rest / campfire aura clear
 *     the player's statuses.
 *
 * VISUALS: existing paths only — a pooled particle burst in the
 * status color on fresh application, the instancer's per-instance flash
 * pulse + a pooled floating number per tick, and codex lines from this
 * same table. No new meshes, no new buckets, no per-frame allocations
 * (the tick driver allocates nothing; the tracker reuses its map).
 */
import * as THREE from 'three';
import { Rng } from '../core/Rng';

/** Salts for the dedicated status streams — off every other stream. */
export const STATUS_ABILITY_SALT = 0x5717;
export const STATUS_PLAYER_SALT = 0x5e17;
export const STATUS_TRAP_SALT = 0x7a17;

export type StatusId = 'burn' | 'frost-slow' | 'shock' | 'poison';
export const STATUS_IDS: readonly StatusId[] = ['burn', 'frost-slow', 'shock', 'poison'];

/** Damage-type vocabulary shared with the (unmerged) elemental wave. */
export type StatusDamageType = 'physical' | 'fire' | 'frost' | 'shock';

/** One status definition — every status number lives in STATUS_TABLE. */
export interface StatusDef {
  id: StatusId;
  name: string;
  /** icon glyph rendered in codex lines / toasts */
  icon: string;
  /** VFX color (apply burst; codex swatch) */
  color: string;
  /** flat HP per tick (tick damage is never variance/crit/elemental) */
  tickDamage: number;
  /** seconds between ticks */
  tickInterval: number;
  /** total lifetime in seconds from (re-)application */
  duration: number;
  /** application chance per damaging hit from a triggering source */
  applyChance: number;
  /** speed multiplier while active (1 = no slow, 0.5 = half speed, 0 = stunned) */
  slowMult: number;
  /** shock only: extra targets chained to on a landed application */
  chainCount: number;
  /** shock only: max chain reach in metres from the primary target */
  chainRadius: number;
  /** elemental type that ignites this status (null = no elemental type) */
  elementalType: StatusDamageType | null;
  /** codex blurb, rendered verbatim */
  blurb: string;
}

/** THE status table — the single source of status truth. */
export const STATUS_TABLE: Record<StatusId, StatusDef> = {
  burn: {
    id: 'burn',
    name: 'Burn',
    icon: '🔥',
    color: '#ff6a3d',
    tickDamage: 3,
    tickInterval: 1,
    duration: 4,
    applyChance: 0.3,
    slowMult: 1,
    chainCount: 0,
    chainRadius: 0,
    elementalType: 'fire',
    blurb: 'Burning — 3 damage every 1s for 4s. Ignited by fire damage.',
  },
  'frost-slow': {
    id: 'frost-slow',
    name: 'Frost Slow',
    icon: '❄',
    color: '#7af7ff',
    tickDamage: 1,
    tickInterval: 1,
    duration: 3,
    applyChance: 0.35,
    slowMult: 0.5,
    chainCount: 0,
    chainRadius: 0,
    elementalType: 'frost',
    blurb: 'Chilled — 1 damage every 1s for 3s and half speed while active. Carried by frost damage.',
  },
  shock: {
    id: 'shock',
    name: 'Shock',
    icon: '⚡',
    color: '#ffd23d',
    tickDamage: 2,
    tickInterval: 0.5,
    duration: 2,
    applyChance: 0.3,
    slowMult: 0,
    chainCount: 2,
    chainRadius: 5,
    elementalType: 'shock',
    blurb: 'Shocked — 2 damage every 0.5s for 2s, stunned (cannot move or attack), chains to 2 nearby foes. Carried by shock damage.',
  },
  poison: {
    id: 'poison',
    name: 'Poison',
    icon: '☠',
    color: '#8fe34a',
    tickDamage: 2,
    tickInterval: 1,
    duration: 5,
    applyChance: 0.3,
    slowMult: 1,
    chainCount: 0,
    chainRadius: 0,
    elementalType: null,
    blurb: 'Poisoned — 2 damage every 1s for 5s. No elemental type; carried by venom and spike traps.',
  },
};

export function statusDefOf(id: string): StatusDef | undefined {
  return (STATUS_TABLE as Record<string, StatusDef>)[id];
}

/**
 * Forward-compatible elemental mapping (the elemental wave's reserved
 * hooks, spelled out): fire -> burn, frost -> frost-slow, shock ->
 * shock, physical / unknown -> no status. Poison has no elemental type
 * and is never produced by this mapping.
 */
export function statusForDamageType(type: string | null | undefined): StatusId | null {
  for (const id of STATUS_IDS) {
    const def = STATUS_TABLE[id];
    if (def.elementalType !== null && def.elementalType === type) return id;
  }
  return null;
}

/**
 * Combat-ability -> status assignments (this phase's live trigger for
 * player -> enemy statuses). Grounded in the ability defs themselves:
 * shockwave-slam is the shock AoE by name; dash-strike's VFX color is
 * the frost-cyan #7af7ff. Mend applies nothing. When the elemental wave
 * merges, ability damage types supersede this table — the funnel
 * (applyStatus) stays the same.
 */
export const ABILITY_STATUS: Partial<Record<string, StatusId>> = {
  'dash-strike': 'frost-slow',
  'shockwave-slam': 'shock',
};

export function statusForAbility(abilityId: string): StatusId | null {
  return ABILITY_STATUS[abilityId] ?? null;
}

/**
 * Enemy kind -> status applied to the PLAYER when that kind's melee
 * attack lands (the onPlayerHit channel). Grounded in the elemental
 * wave's field notes: ember-visored walker/brute kinds burn, machine
 * drone/turret kinds short out (shock), flyers carry poison. Frost-slow
 * is never applied to the player (slowing the controller would need a
 * CharacterController change — disclosed; the player still takes the
 * tick damage of every status it can carry).
 */
export const ENEMY_KIND_STATUS: Record<string, StatusId> = {
  walker: 'burn',
  brute: 'burn',
  drone: 'shock',
  turret: 'shock',
  flyer: 'poison',
};

export function statusForEnemyKind(kind: string): StatusId | null {
  return ENEMY_KIND_STATUS[kind] ?? null;
}

/** Total damage one fresh application deals if it runs its full course. */
export function statusTotalDamage(id: StatusId): number {
  const def = STATUS_TABLE[id];
  return def.tickDamage * Math.floor(def.duration / def.tickInterval);
}

/** Codex lines for the bestiary panel — rendered from this same table. */
export function statusCodexLines(): string[] {
  return STATUS_IDS.map((id) => {
    const def = STATUS_TABLE[id];
    const slow = def.slowMult === 0
      ? ', stunned while active'
      : def.slowMult < 1
        ? `, ${Math.round(def.slowMult * 100)}% speed while active`
        : '';
    const chain = def.chainCount > 0 ? `, chains to ${def.chainCount} foes within ${def.chainRadius}m` : '';
    return `${def.icon} ${def.name} — ${def.tickDamage} damage every ${def.tickInterval}s for ${def.duration}s (${statusTotalDamage(id)} total)${slow}${chain}.`;
  });
}

/** Seeded status roller: one Rng stream, one draw per application roll. */
export class StatusRoller {
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed >>> 0);
  }

  /** Draw one application roll in [0, 1). */
  next(): number {
    return this.rng.next();
  }

  /** Roll once against a status's table chance. */
  rollsFor(id: StatusId): boolean {
    return this.next() < STATUS_TABLE[id].applyChance;
  }
}

// ---------------------------------------------------------------------------
// Tracker — pure, game-time-driven, one instance per (target, status)
// ---------------------------------------------------------------------------

export interface StatusInstance {
  id: StatusId;
  /** game time the instance expires */
  expiresAt: number;
  /** game time the next tick fires */
  nextTickAt: number;
  /** ticks fired so far (survives refresh — the schedule is not reset) */
  ticks: number;
}

export interface ApplyOutcome {
  /** true when the instance exists after this call (applied or refreshed) */
  applied: boolean;
  /** true when an already-present instance had its duration extended */
  refreshed: boolean;
}

export class StatusTracker {
  private readonly instances = new Map<StatusId, StatusInstance>();

  /** Apply (or refresh) one status at game time `now`. */
  apply(
    id: string,
    now: number,
    opts: { force?: boolean; roll?: number } = {},
  ): ApplyOutcome {
    const def = statusDefOf(id);
    if (!def || !Number.isFinite(now)) return { applied: false, refreshed: false };
    if (!opts.force && opts.roll !== undefined && !(opts.roll < def.applyChance)) {
      return { applied: false, refreshed: false };
    }
    const existing = this.instances.get(def.id);
    if (existing) {
      // Refresh: extend the expiry, keep the tick schedule and tick count.
      existing.expiresAt = now + def.duration;
      return { applied: true, refreshed: true };
    }
    this.instances.set(def.id, {
      id: def.id,
      expiresAt: now + def.duration,
      nextTickAt: now + def.tickInterval,
      ticks: 0,
    });
    return { applied: true, refreshed: false };
  }

  /**
   * Fire every tick whose time has come (game time `now`), then drop
   * expired instances. Ticks fire in tick-time order per instance;
   * a long jump fires each missed tick once, up to the ticks the
   * duration allows. Returns the ids that ticked, in table order.
   */
  update(now: number, onTick: (id: StatusId, amount: number) => void): StatusId[] {
    const ticked: StatusId[] = [];
    for (const id of STATUS_IDS) {
      const inst = this.instances.get(id);
      if (!inst) continue;
      const def = STATUS_TABLE[id];
      let fired = false;
      // Bound the catch-up loop: a duration holds at most
      // duration/interval ticks (<= 10 for every shipped def).
      for (let guard = 0; guard < 64; guard++) {
        if (!(inst.nextTickAt <= now && inst.nextTickAt <= inst.expiresAt)) break;
        onTick(id, def.tickDamage);
        inst.ticks++;
        inst.nextTickAt += def.tickInterval;
        fired = true;
      }
      if (fired) ticked.push(id);
      if (now >= inst.expiresAt) this.instances.delete(id);
    }
    return ticked;
  }

  /** Drop instances whose expiry has passed (no ticks fired). */
  prune(now: number): void {
    for (const [id, inst] of this.instances) {
      if (now >= inst.expiresAt) this.instances.delete(id);
    }
  }

  /** Speed multiplier from active statuses: the minimum slowMult (1 = unslowed). */
  speedMult(): number {
    let mult = 1;
    for (const inst of this.instances.values()) {
      mult = Math.min(mult, STATUS_TABLE[inst.id].slowMult);
    }
    return mult;
  }

  /** True when any active status stuns (slowMult 0 — shock). */
  stunned(): boolean {
    for (const inst of this.instances.values()) {
      if (STATUS_TABLE[inst.id].slowMult === 0) return true;
    }
    return false;
  }

  has(id: string): boolean {
    return this.instances.has(id as StatusId);
  }

  activeIds(): StatusId[] {
    return STATUS_IDS.filter((id) => this.instances.has(id));
  }

  /** Remaining seconds for one status (0 when absent). */
  remaining(id: string, now: number): number {
    const inst = this.instances.get(id as StatusId);
    return inst ? Math.max(0, inst.expiresAt - now) : 0;
  }

  ticksFired(id: string): number {
    return this.instances.get(id as StatusId)?.ticks ?? 0;
  }

  /** Remove every instance; returns the ids that were cleared. */
  clearAll(): StatusId[] {
    const cleared = this.activeIds();
    this.instances.clear();
    return cleared;
  }

  snapshot(now: number): Array<{ id: StatusId; remaining: number; ticks: number }> {
    return this.activeIds().map((id) => ({
      id,
      remaining: this.remaining(id, now),
      ticks: this.ticksFired(id),
    }));
  }
}

// ---------------------------------------------------------------------------
// Application funnel helpers (safe against test fakes without applyStatus)
// ---------------------------------------------------------------------------

/** Minimal surface a status target exposes (Enemy / PlayerAvatar satisfy it). */
export interface StatusAppliable {
  applyStatus(id: StatusId, opts: { roll: number; now: number }): ApplyOutcome;
  readonly position: THREE.Vector3;
}

export function tryApplyStatus(
  target: unknown,
  id: StatusId,
  roll: number,
  now: number,
): boolean {
  const t = target as Partial<StatusAppliable> | null;
  if (!t || typeof t.applyStatus !== 'function') return false;
  try {
    return t.applyStatus(id, { roll, now }).applied;
  } catch {
    return false;
  }
}

/**
 * Apply a status to a primary target and, for chaining statuses
 * (shock), force-apply it to the nearest other live targets within
 * chainRadius. Chain targets always land once the primary lands (no
 * extra rolls — the chain is deterministic given the roster, and it
 * never disturbs the caller's roll stream). Returns the number of
 * targets carrying the status afterwards (primary + chained).
 */
export function applyStatusWithChain(
  primary: unknown,
  roster: readonly unknown[],
  id: StatusId,
  roll: number,
  now: number,
): number {
  if (!tryApplyStatus(primary, id, roll, now)) return 0;
  const def = STATUS_TABLE[id];
  if (def.chainCount <= 0) return 1;
  const origin = (primary as { position?: { x: number; y: number; z: number } }).position;
  if (!origin) return 1;
  const candidates: Array<{ target: unknown; d2: number }> = [];
  for (const other of roster) {
    if (other === primary) continue;
    const o = other as { alive?: boolean; position?: { x: number; y: number; z: number } };
    if (o.alive === false) continue;
    if (!o.position) continue;
    const dx = o.position.x - origin.x;
    const dy = o.position.y - origin.y;
    const dz = o.position.z - origin.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= def.chainRadius * def.chainRadius) candidates.push({ target: other, d2 });
  }
  candidates.sort((a, b) => a.d2 - b.d2);
  let count = 1;
  for (const c of candidates.slice(0, def.chainCount)) {
    if (tryApplyStatus(c.target, id, 0, now)) count++;
    // Chained targets are force-applied: pass roll 0 via a forced path.
    // tryApplyStatus above used roll 0 (< chance), which lands; the
    // force flag is unnecessary because 0 always passes the chance gate.
  }
  return count;
}
