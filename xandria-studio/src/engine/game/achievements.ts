/**
 * Achievements wave (upgrade loop): data-driven achievement / trophy system.
 *
 * Observe-only by design: the manager taps the existing engine hook bus
 * (onKill / onLevelUp / onTick), the portal manager's free onAfterTransition
 * field, and the blueprint's existing onCrafted chain. It never changes
 * gameplay behavior — no AI, spawn, damage, or economy contract is touched.
 *
 * All tuning lives in ACHIEVEMENT_DEFS below (one table: id, name,
 * description, trigger, reward). Triggers are pure state-driven counters —
 * no RNG anywhere in this file (seeded or otherwise).
 *
 * Persistence (two layers, mirroring the quest/progression conventions):
 * - Unlocks are player-scoped AND cross-run: unlocked ids merge into the
 *   Profile (`achievements: string[]`, additive field, saved at unlock time
 *   via the loadProfile -> mutate -> saveProfile pattern). A page reload
 *   restores them.
 * - In-run progress counters (kills, crafts, distance, ...) ride the live
 *   manager, which is blueprint-owned and never despawned by portal
 *   transitions (same model as QuestManager). portalSnapshot/portalRestore
 *   round-trip the counters defensively, like Progression/QuestManager.
 */
import type { HookName, Modding } from './Modding';
import type { Progression } from './Progression';
import type { LevelGain } from './progressionCurve';
import type { QuestManager } from './quests';
import type { PortalSeamHooks, PortalTransitionContext } from '../world/PortalManager';
import { loadProfile, saveProfile } from './Profile';

/** What an achievement counts. All params are plain data — no RNG. */
export type AchievementTrigger =
  | { kind: 'kills'; count: number; enemyKind?: string; bossOnly?: boolean }
  | { kind: 'crafts'; count: number; stationId?: string }
  | { kind: 'quests'; count: number; sideOnly?: boolean }
  | { kind: 'portals'; count: number }
  | { kind: 'maps'; count: number }
  | { kind: 'level'; level: number }
  | { kind: 'distance'; meters: number };

/** Reward lines: XP goes through the one additive path (Progression.addXpEx),
 *  score rides engine.score + hud.setScore (the coin-pickup call sites). */
export interface AchievementReward {
  xp?: number;
  score?: number;
}

export type AchievementCategory =
  | 'kills'
  | 'crafting'
  | 'quests'
  | 'portals'
  | 'leveling'
  | 'exploration';

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  trigger: AchievementTrigger;
  reward: AchievementReward;
}

/**
 * THE tuning table. 25 achievements across kills / crafting / quests /
 * portals / leveling / exploration. Edit this table to retune; the manager
 * and the codex panel read it live.
 */
export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  // ---- kills -----------------------------------------------------------
  { id: 'first-blood', name: 'First Blood', description: 'Defeat your first enemy.', category: 'kills',
    trigger: { kind: 'kills', count: 1 }, reward: { xp: 25 } },
  { id: 'hunter-10', name: 'Hunter', description: 'Defeat 10 enemies.', category: 'kills',
    trigger: { kind: 'kills', count: 10 }, reward: { xp: 50 } },
  { id: 'slayer-50', name: 'Slayer', description: 'Defeat 50 enemies.', category: 'kills',
    trigger: { kind: 'kills', count: 50 }, reward: { xp: 150, score: 50 } },
  { id: 'exterminator-150', name: 'Exterminator', description: 'Defeat 150 enemies.', category: 'kills',
    trigger: { kind: 'kills', count: 150 }, reward: { xp: 400, score: 150 } },
  { id: 'giant-slayer', name: 'Giant Slayer', description: 'Defeat a boss.', category: 'kills',
    trigger: { kind: 'kills', count: 1, bossOnly: true }, reward: { xp: 300, score: 100 } },
  { id: 'bug-zapper', name: 'Bug Zapper', description: 'Defeat 25 drones.', category: 'kills',
    trigger: { kind: 'kills', count: 25, enemyKind: 'drone' }, reward: { xp: 100 } },
  // ---- crafting --------------------------------------------------------
  { id: 'maker', name: 'Maker', description: 'Craft your first item.', category: 'crafting',
    trigger: { kind: 'crafts', count: 1 }, reward: { xp: 25 } },
  { id: 'artisan', name: 'Artisan', description: 'Craft 10 items.', category: 'crafting',
    trigger: { kind: 'crafts', count: 10 }, reward: { xp: 100 } },
  { id: 'master-artisan', name: 'Master Artisan', description: 'Craft 25 items.', category: 'crafting',
    trigger: { kind: 'crafts', count: 25 }, reward: { xp: 250, score: 75 } },
  { id: 'alchemist', name: 'Alchemist', description: 'Brew 5 items at an alchemy station.', category: 'crafting',
    trigger: { kind: 'crafts', count: 5, stationId: 'station_alchemy' }, reward: { xp: 120 } },
  // ---- quests ----------------------------------------------------------
  { id: 'errand-runner', name: 'Errand Runner', description: 'Complete your first quest.', category: 'quests',
    trigger: { kind: 'quests', count: 1 }, reward: { xp: 50 } },
  { id: 'adventurer', name: 'Adventurer', description: 'Complete 5 quests.', category: 'quests',
    trigger: { kind: 'quests', count: 5 }, reward: { xp: 150 } },
  { id: 'hero-of-the-valley', name: 'Hero of the Valley', description: 'Complete 12 quests.', category: 'quests',
    trigger: { kind: 'quests', count: 12 }, reward: { xp: 400, score: 150 } },
  { id: 'helping-hand', name: 'Helping Hand', description: 'Complete 3 side quests.', category: 'quests',
    trigger: { kind: 'quests', count: 3, sideOnly: true }, reward: { xp: 100 } },
  // ---- portals ---------------------------------------------------------
  { id: 'wayfarer', name: 'Wayfarer', description: 'Travel through your first portal.', category: 'portals',
    trigger: { kind: 'portals', count: 1 }, reward: { xp: 50 } },
  { id: 'planeswalker', name: 'Planeswalker', description: 'Travel through 5 portals.', category: 'portals',
    trigger: { kind: 'portals', count: 5 }, reward: { xp: 150 } },
  { id: 'worldhopper', name: 'Worldhopper', description: 'Travel through 10 portals.', category: 'portals',
    trigger: { kind: 'portals', count: 10 }, reward: { xp: 350, score: 100 } },
  { id: 'globetrotter', name: 'Globetrotter', description: 'Set foot on 5 distinct maps.', category: 'portals',
    trigger: { kind: 'maps', count: 5 }, reward: { xp: 200 } },
  // ---- leveling --------------------------------------------------------
  { id: 'getting-started', name: 'Getting Started', description: 'Reach level 2.', category: 'leveling',
    trigger: { kind: 'level', level: 2 }, reward: { xp: 25 } },
  { id: 'rising-star', name: 'Rising Star', description: 'Reach level 5.', category: 'leveling',
    trigger: { kind: 'level', level: 5 }, reward: { xp: 100 } },
  { id: 'veteran', name: 'Veteran', description: 'Reach level 10.', category: 'leveling',
    trigger: { kind: 'level', level: 10 }, reward: { xp: 250, score: 75 } },
  { id: 'legend', name: 'Legend', description: 'Reach level 20.', category: 'leveling',
    trigger: { kind: 'level', level: 20 }, reward: { xp: 500, score: 200 } },
  // ---- exploration -----------------------------------------------------
  { id: 'wanderer', name: 'Wanderer', description: 'Travel 1,000 meters on foot.', category: 'exploration',
    trigger: { kind: 'distance', meters: 1000 }, reward: { xp: 50 } },
  { id: 'explorer', name: 'Explorer', description: 'Travel 5,000 meters on foot.', category: 'exploration',
    trigger: { kind: 'distance', meters: 5000 }, reward: { xp: 150 } },
  { id: 'cartographer', name: 'Cartographer', description: 'Travel 15,000 meters on foot.', category: 'exploration',
    trigger: { kind: 'distance', meters: 15000 }, reward: { xp: 350, score: 100 } },
];

/** Stable id set, for stale-id filtering on profile load. */
export const ACHIEVEMENT_IDS = new Set(ACHIEVEMENT_DEFS.map((d) => d.id));

/** Def lookup by id (unknown ids -> undefined, never throws). */
export function achievementDef(id: string): AchievementDef | undefined {
  return ACHIEVEMENT_DEFS.find((d) => d.id === id);
}

export interface AchievementManagerOpts {
  /** engine hook bus (Modding) — the manager taps onKill/onLevelUp/onTick */
  hooks: Modding;
  /** toast surface for the unlock fanfare */
  toast: (msg: string, seconds?: number) => void;
  /** player progression (XP rewards + level triggers); null = no XP side */
  progression: () => Progression | null;
  /** quest manager for completion polling; null = quests off */
  quests: () => QuestManager | null;
  /** portal seam hooks (the free onAfterTransition field); null = no portals */
  portalHooks: () => PortalSeamHooks | null;
  /** live player position for the distance accumulator; null = unknown */
  avatarPos: () => { x: number; y: number; z: number } | null;
  /** score grant (blueprint wires engine.score += n + hud.setScore) */
  addScore: (n: number) => void;
  /** fired when a reward's XP causes a level-up (blueprint wires the modal) */
  onLevelUp?: (gain?: LevelGain) => void;
  /** fired after every unlock (the codex panel refreshes on this) */
  onUnlocked?: (def: AchievementDef) => void;
}

/** Portal-safe snapshot of the in-run counters (mirrors Progression.portalSnapshot). */
export interface AchievementPortalSnapshot {
  version: 1;
  kills: number;
  bossKills: number;
  killsByKind: Record<string, number>;
  crafts: number;
  craftsByStation: Record<string, number>;
  questsDone: number;
  sideQuestsDone: number;
  portals: number;
  mapsVisited: string[];
  distanceM: number;
}

/** Per-tick teleport clamp (m): portal arrivals move the avatar kilometers;
 *  anything bigger than this in one tick is a teleport, not a walk. */
const DISTANCE_TICK_CLAMP_M = 50;
/** Quest-status poll cadence (ticks): statuses only change on dialogue /
 *  turn-in frames, so polling every ~0.5s of tick time is plenty. */
const QUEST_POLL_EVERY_TICKS = 30;

export class AchievementManager {
  private readonly untaps: Array<() => void> = [];
  private readonly unlocked = new Set<string>();
  private readonly unlockListeners = new Set<(def: AchievementDef) => void>();
  private readonly lastQuestStatus = new Map<string, string>();
  private mapsVisited = new Set<string>();
  /** the onAfterTransition installed at construction (for dispose) */
  private installedPortalHook:
    | ((ctx: PortalTransitionContext) => void | Promise<void>)
    | undefined;
  private prevOnAfterTransition:
    | ((ctx: PortalTransitionContext) => void | Promise<void>)
    | undefined;

  private kills = 0;
  private bossKills = 0;
  private killsByKind: Record<string, number> = {};
  private crafts = 0;
  private craftsByStation: Record<string, number> = {};
  private questsDone = 0;
  private sideQuestsDone = 0;
  private portals = 0;
  private distanceM = 0;
  private lastPos: { x: number; y: number; z: number } | null = null;
  private tickCount = 0;

  private evaluating = false;
  private evaluateAgain = false;
  private disposed = false;

  constructor(private readonly opts: AchievementManagerOpts) {
    // Cross-run unlocks: merge the profile's ids over the def table, drop
    // stale ids from retired achievements (same discipline as Profile.owned).
    for (const id of loadProfile().achievements) {
      if (ACHIEVEMENT_IDS.has(id)) this.unlocked.add(id);
    }
    if (opts.onUnlocked) this.unlockListeners.add(opts.onUnlocked);
    this.seedQuestStatuses();

    this.untaps.push(
      opts.hooks.tap('onKill', ({ enemy }) => this.handleKill(enemy)),
      opts.hooks.tap('onLevelUp', () => this.evaluate()),
      opts.hooks.tap('onTick', () => this.handleTick()),
    );

    // Portal travel: the onAfterTransition field is unassigned engine-wide;
    // chain defensively in case a future system claims it first.
    const ph = opts.portalHooks();
    if (ph) {
      this.prevOnAfterTransition = ph.onAfterTransition;
      const prev = this.prevOnAfterTransition;
      const mgr = this;
      this.installedPortalHook = function (ctx) {
        const r = prev?.(ctx);
        if (r && typeof (r as Promise<void>).then === 'function') {
          return (r as Promise<void>).then(() => mgr.handlePortal(ctx));
        }
        mgr.handlePortal(ctx);
        return r;
      };
      ph.onAfterTransition = this.installedPortalHook;
    }
  }

  // ------------------------------------------------------------ queries

  /** All defs, in table order (the codex renders this). */
  defs(): AchievementDef[] {
    return ACHIEVEMENT_DEFS;
  }

  isUnlocked(id: string): boolean {
    return this.unlocked.has(id);
  }

  unlockedIds(): string[] {
    return ACHIEVEMENT_DEFS.map((d) => d.id).filter((id) => this.unlocked.has(id));
  }

  /** Current vs target for the codex progress bar (null = n/a). */
  progressOf(id: string): { current: number; target: number } | null {
    const def = achievementDef(id);
    if (!def) return null;
    const t = def.trigger;
    switch (t.kind) {
      case 'kills':
        return {
          current: t.bossOnly ? this.bossKills : t.enemyKind ? (this.killsByKind[t.enemyKind] ?? 0) : this.kills,
          target: t.count,
        };
      case 'crafts':
        return {
          current: t.stationId ? (this.craftsByStation[t.stationId] ?? 0) : this.crafts,
          target: t.count,
        };
      case 'quests':
        return { current: t.sideOnly ? this.sideQuestsDone : this.questsDone, target: t.count };
      case 'portals':
        return { current: this.portals, target: t.count };
      case 'maps':
        return { current: this.mapsVisited.size, target: t.count };
      case 'level':
        return { current: this.opts.progression()?.level ?? 0, target: t.level };
      case 'distance':
        return { current: Math.floor(this.distanceM), target: t.meters };
    }
  }

  /** Live progress counters (debug / e2e introspection). */
  debugCounters(): Record<string, number> {
    return {
      kills: this.kills,
      bossKills: this.bossKills,
      crafts: this.crafts,
      questsDone: this.questsDone,
      sideQuestsDone: this.sideQuestsDone,
      portals: this.portals,
      mapsVisited: this.mapsVisited.size,
      distanceM: Math.floor(this.distanceM),
    };
  }

  /** Subscribe to unlocks (the codex panel uses this to refresh live). */
  onUnlocked(fn: (def: AchievementDef) => void): () => void {
    this.unlockListeners.add(fn);
    return () => { this.unlockListeners.delete(fn); };
  }

  // ------------------------------------------------------------ events

  private handleKill(enemy: { isBoss?: boolean; spec?: { kind?: string } }): void {
    if (this.disposed) return;
    this.kills++;
    const kind = enemy?.spec?.kind;
    if (typeof kind === 'string' && kind) {
      this.killsByKind[kind] = (this.killsByKind[kind] ?? 0) + 1;
    }
    if (enemy?.isBoss === true) this.bossKills++;
    this.evaluate();
  }

  /** Blueprint onCrafted chain calls this (the one additive line per blueprint). */
  onCraft(recipe: { id: string; stationId?: string | null }): void {
    if (this.disposed) return;
    this.crafts++;
    if (recipe?.stationId) {
      this.craftsByStation[recipe.stationId] = (this.craftsByStation[recipe.stationId] ?? 0) + 1;
    }
    this.evaluate();
  }

  private handlePortal(ctx: PortalTransitionContext): void {
    if (this.disposed) return;
    this.portals++;
    if (ctx?.to) this.mapsVisited.add(`${ctx.to.mx},${ctx.to.my}`);
    this.evaluate();
  }

  private handleTick(): void {
    if (this.disposed) return;
    this.tickCount++;
    // Distance accumulator: walk distance only, teleports clamped out.
    const p = this.opts.avatarPos();
    if (p) {
      if (this.lastPos) {
        const dx = p.x - this.lastPos.x;
        const dy = p.y - this.lastPos.y;
        const dz = p.z - this.lastPos.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= DISTANCE_TICK_CLAMP_M && d > 0) {
          this.distanceM += d;
          this.evaluate();
        }
      }
      this.lastPos = { x: p.x, y: p.y, z: p.z };
    } else {
      this.lastPos = null;
    }
    if (this.tickCount % QUEST_POLL_EVERY_TICKS === 0) this.pollQuests();
  }

  private seedQuestStatuses(): void {
    const qm = this.opts.quests();
    if (!qm) return;
    for (const d of qm.defs) this.lastQuestStatus.set(d.id, qm.statusOf(d.id));
  }

  /**
   * Quest completion has no hook bus today, so the manager polls quest
   * statuses on a throttled tick: any def whose status newly reaches
   * 'complete' / 'turned-in' counts once. The seeded map means portal
   * restores (same statuses) never double-count.
   */
  private pollQuests(): void {
    if (this.disposed) return;
    const qm = this.opts.quests();
    if (!qm) return;
    let changed = false;
    for (const d of qm.defs) {
      const st = qm.statusOf(d.id);
      const prev = this.lastQuestStatus.get(d.id);
      this.lastQuestStatus.set(d.id, st);
      if (prev === st) continue;
      if ((st === 'complete' || st === 'turned-in') && prev !== 'complete' && prev !== 'turned-in') {
        this.questsDone++;
        if (d.side === true) this.sideQuestsDone++;
        changed = true;
      }
    }
    if (changed) this.evaluate();
  }

  // ------------------------------------------------------------ unlock

  private triggerMet(def: AchievementDef): boolean {
    const p = this.progressOf(def.id);
    return p !== null && p.current >= p.target;
  }

  /**
   * Fixpoint evaluation with a re-entrancy guard: reward XP can level the
   * player, which re-fires onLevelUp mid-unlock. Each def unlocks once, so
   * the loop terminates; re-entrant calls set the flag and run after.
   */
  private evaluate(): void {
    if (this.evaluating) {
      this.evaluateAgain = true;
      return;
    }
    this.evaluating = true;
    try {
      for (let iter = 0; iter < 64; iter++) {
        let any = false;
        for (const def of ACHIEVEMENT_DEFS) {
          if (!this.unlocked.has(def.id) && this.triggerMet(def)) {
            this.unlockNow(def);
            any = true;
          }
        }
        if (!any) break;
      }
    } finally {
      this.evaluating = false;
      if (this.evaluateAgain) {
        this.evaluateAgain = false;
        this.evaluate();
      }
    }
  }

  private unlockNow(def: AchievementDef): void {
    this.unlocked.add(def.id);
    // Cross-run persistence: the canonical loadProfile -> mutate ->
    // saveProfile pattern (same as buyModifier).
    const profile = loadProfile();
    if (!profile.achievements.includes(def.id)) {
      profile.achievements.push(def.id);
      saveProfile(profile);
    }
    this.opts.toast(`\u{1F3C6} ${def.name} — ${def.description}`, 3.2);
    this.grantReward(def);
    for (const fn of [...this.unlockListeners]) fn(def);
  }

  private grantReward(def: AchievementDef): void {
    const xp = def.reward.xp ?? 0;
    const score = def.reward.score ?? 0;
    if (xp > 0) {
      const prog = this.opts.progression();
      if (prog) {
        // The one additive XP path (same call the quest turn-in uses).
        const r = prog.addXpEx(xp);
        if (r.leveled) this.opts.onLevelUp?.(r.gain ?? undefined);
      }
    }
    if (score > 0) this.opts.addScore(score);
  }

  // ------------------------------------------------------------ portal

  /** Defensive round-trip (mirrors Progression.portalSnapshot). */
  portalSnapshot(): AchievementPortalSnapshot {
    return {
      version: 1,
      kills: this.kills,
      bossKills: this.bossKills,
      killsByKind: { ...this.killsByKind },
      crafts: this.crafts,
      craftsByStation: { ...this.craftsByStation },
      questsDone: this.questsDone,
      sideQuestsDone: this.sideQuestsDone,
      portals: this.portals,
      mapsVisited: [...this.mapsVisited],
      distanceM: this.distanceM,
    };
  }

  /** Restore clamps corrupt values to sane floors (never throws). */
  portalRestore(snap: AchievementPortalSnapshot | null | undefined): void {
    if (!snap || snap.version !== 1) return;
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
    const rec = (v: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          const n = num(x);
          if (n > 0) out[k] = Math.floor(n);
        }
      }
      return out;
    };
    this.kills = Math.floor(num(snap.kills));
    this.bossKills = Math.floor(num(snap.bossKills));
    this.killsByKind = rec(snap.killsByKind);
    this.crafts = Math.floor(num(snap.crafts));
    this.craftsByStation = rec(snap.craftsByStation);
    this.questsDone = Math.floor(num(snap.questsDone));
    this.sideQuestsDone = Math.floor(num(snap.sideQuestsDone));
    this.portals = Math.floor(num(snap.portals));
    this.mapsVisited = new Set(
      Array.isArray(snap.mapsVisited) ? snap.mapsVisited.filter((x): x is string => typeof x === 'string') : [],
    );
    this.distanceM = num(snap.distanceM);
    this.lastPos = null;
    this.evaluate();
  }

  // ------------------------------------------------------------ lifecycle

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const untap of this.untaps) untap();
    this.untaps.length = 0;
    this.unlockListeners.clear();
    const ph = this.opts.portalHooks();
    // Only restore the previous hook when ours is still installed — never
    // clobber a hook a foreign system installed after us.
    if (ph && this.installedPortalHook && ph.onAfterTransition === this.installedPortalHook) {
      ph.onAfterTransition = this.prevOnAfterTransition;
    }
    this.installedPortalHook = undefined;
  }
}

/** Hook-name sanity: the manager only taps hooks that exist on the bus. */
const TAPPED_HOOKS: HookName[] = ['onKill', 'onLevelUp', 'onTick'];
export function tappedHookNames(): HookName[] {
  return [...TAPPED_HOOKS];
}
