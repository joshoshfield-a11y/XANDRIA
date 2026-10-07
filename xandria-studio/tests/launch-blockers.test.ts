/**
 * Launch-blocker regression tests (QA 2026-10-06):
 *   B1 staged collect stages complete via the blueprint wiring
 *   B2 reach-flag predicate for staged beacon stages
 *   M2 restarts restore every run-mutated stat (speed, firerate, …)
 *   M4 boss-quota top-up for ruin-style stages
 *   M5 progress events: no kill/pickup cross-talk between stage types
 *   M8 rapid-fire expiry keeps a concurrent firerate upgrade
 */
import { describe, it, expect, vi } from 'vitest';
import { Objectives } from '../src/engine/game/Objectives';
import { needsReachGoal, bossQuotaDeficit } from '../src/blueprints/campaign';
import { applyLoadout, snapshotLoadoutBase, defaultProfile } from '../src/engine/game/Profile';
import { EffectState, EFFECT_DEFS, applyPickupEffect } from '../src/blueprints/fx';
import type { Engine } from '../src/engine/Engine';
import type { GameSpec, ObjectiveSpec, ObjectiveStage, ObjectiveType } from '../src/spec/schema';
import type { PlayerAvatar } from '../src/blueprints/common';

function fakeEngine() {
  return {
    state: 'playing' as const,
    elapsed: 0,
    score: 0,
    win: vi.fn(),
    lose: vi.fn(),
    hud: { setProgress: vi.fn(), setTimer: vi.fn() },
    hooks: { emit: vi.fn(), tap: vi.fn(), tapCount: () => 0 },
    audio: { play: vi.fn(), setIntensity: vi.fn() },
  };
}

const legacyEliminate = (count = 3): ObjectiveSpec =>
  ({ type: 'eliminate', count, timeLimit: 0, description: 'Kill them' }) as ObjectiveSpec;

/** Staged campaign: legacy 'eliminate', stage 0 = collect shards ×3. */
const stagedCollectFirst = (): ObjectiveSpec =>
  ({
    type: 'eliminate',
    count: 99,
    timeLimit: 0,
    description: 'legacy fallback',
    stages: [
      { id: 'shards', type: 'collect', count: 3, timeLimit: 0, description: 'Chapter I — Gather the shards' },
      { id: 'break', type: 'eliminate', count: 2, timeLimit: 0, description: 'Chapter II — Thin the patrols' },
    ],
  }) as ObjectiveSpec;

const fakeSpec = () =>
  ({
    player: { health: 100, speed: 6 },
    rules: { lives: 3 },
    custom: {} as Record<string, unknown>,
  }) as unknown as GameSpec;

describe('B1 — staged collect stages complete through the blueprint wiring', () => {
  it('coin collections advance the collect stage even though the legacy type is eliminate', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, stagedCollectFirst());
    expect(o.currentStageIndex).toBe(0);
    // mirrors the blueprint pickups.onCollect wiring: coin -> addProgress(1, 'collect')
    o.addProgress(1, 'collect');
    o.addProgress(1, 'collect');
    expect(o.currentStageIndex).toBe(0);
    expect(eng.win).not.toHaveBeenCalled();
    o.addProgress(1, 'collect');
    expect(o.currentStageIndex).toBe(1); // stage 0 completed
  });

  it('kill routing (platformer onDeath) advances the later eliminate stage', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, stagedCollectFirst());
    o.addProgress(3, 'collect'); // finish stage 0
    expect(o.currentStageIndex).toBe(1);
    o.addProgress(1, 'kill');
    expect(eng.win).not.toHaveBeenCalled();
    o.addProgress(1, 'kill');
    expect(eng.win).toHaveBeenCalled();
  });
});

describe('M5 — no kill/pickup progress cross-talk', () => {
  it('kills do not inflate a collect stage (and do not feed the kills stat there)', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, stagedCollectFirst());
    o.addProgress(5, 'kill'); // five kills during the collect stage
    expect(o.progress).toBe(0);
    expect(o.kills).toBe(0);
    expect(o.currentStageIndex).toBe(0);
    o.addProgress(3, 'collect'); // coins still count
    expect(o.currentStageIndex).toBe(1);
  });

  it('coins do not inflate an eliminate stage', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, legacyEliminate(2));
    o.addProgress(4, 'collect');
    expect(o.progress).toBe(0);
    expect(eng.win).not.toHaveBeenCalled();
    o.addProgress(2, 'kill');
    expect(eng.win).toHaveBeenCalled();
  });

  it('kill events feed the kills stat on kill stages', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, legacyEliminate(2));
    o.addProgress(1, 'kill');
    o.addProgress(1, 'kill');
    expect(eng.win).toHaveBeenCalledWith({ kills: 2, stagesCleared: 0, level: 1 });
  });

  it('laps only count toward race stages', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, legacyEliminate(2));
    o.addProgress(3, 'lap');
    expect(o.progress).toBe(0);
    expect(eng.win).not.toHaveBeenCalled();
  });

  it('untagged calls keep legacy unconditional behavior (backward compatible)', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, legacyEliminate(2));
    o.addProgress(2);
    expect(eng.win).toHaveBeenCalled();
  });
});

describe('B2 — reach goal flag for staged beacon stages', () => {
  const specWith = (type: ObjectiveType, stages?: ObjectiveStage[]): GameSpec =>
    ({ objective: { type, count: 0, timeLimit: 0, description: 'x', stages } }) as unknown as GameSpec;
  const stage = (type: ObjectiveType): ObjectiveStage =>
    ({ type, count: 0, timeLimit: 0, description: 'c' }) as ObjectiveStage;

  it('is true for a legacy-eliminate campaign containing a reach stage', () => {
    const spec = specWith('eliminate', [stage('collect'), stage('reach')]);
    expect(needsReachGoal(spec)).toBe(true);
  });

  it('is true for legacy reach, false when no reach stage exists', () => {
    expect(needsReachGoal(specWith('reach'))).toBe(true);
    expect(needsReachGoal(specWith('eliminate'))).toBe(false);
    expect(needsReachGoal(specWith('eliminate', [stage('collect'), stage('eliminate')]))).toBe(false);
  });

  it('reachedGoal completes the beacon stage once the campaign gets there', () => {
    const eng = fakeEngine();
    const spec = specWith('eliminate', [
      { ...stage('collect'), id: 'shards', count: 1 },
      { ...stage('reach'), id: 'beacon' },
    ]);
    const o = new Objectives(eng as unknown as Engine, spec.objective);
    o.addProgress(1, 'collect');
    expect(o.currentStageIndex).toBe(1);
    o.reachedGoal(); // the goal flag exists because needsReachGoal(spec) is true
    expect(eng.win).toHaveBeenCalled();
  });
});

describe('M2 — restarts restore every run-mutated stat', () => {
  it('repeated restarts keep speed and firerate identical', () => {
    const spec = fakeSpec();
    snapshotLoadoutBase(spec); // blueprint build captures the pristine base
    const profile = defaultProfile(); // no modifiers equipped
    // run 1: a speed upgrade (spec.player.speed *= 1.12) + firerate upgrades
    spec.player.speed *= 1.12;
    (spec.custom as any).weaponMods = { rateOfFire: 1.44 };
    applyLoadout(spec, profile); // restart 1
    expect(spec.player.speed).toBe(6);
    expect((spec.custom as any).weaponMods?.rateOfFire).toBeUndefined();
    // run 2: mutate again, restart again — still identical
    spec.player.speed *= 1.12;
    (spec.custom as any).weaponMods = { rateOfFire: 1.2 };
    applyLoadout(spec, profile); // restart 2
    expect(spec.player.speed).toBe(6);
    expect((spec.custom as any).weaponMods?.rateOfFire).toBeUndefined();
  });

  it('restores a shipped weaponMods.rateOfFire design value instead of deleting it', () => {
    const spec = fakeSpec();
    (spec.custom as any).weaponMods = { rateOfFire: 2 };
    snapshotLoadoutBase(spec);
    (spec.custom as any).weaponMods.rateOfFire = 2 * 1.2; // upgrade mid-run
    applyLoadout(spec, defaultProfile());
    expect((spec.custom as any).weaponMods.rateOfFire).toBe(2);
  });

  it('loadout modifiers apply on top of the restored base without compounding', () => {
    const spec = fakeSpec();
    snapshotLoadoutBase(spec);
    const p = defaultProfile();
    p.owned = ['swift', 'vitality'];
    p.loadout = ['swift', 'vitality'];
    applyLoadout(spec, p);
    expect(spec.player.speed).toBeCloseTo(6 * 1.08, 10);
    expect(spec.player.health).toBe(125);
    // restart after a mutated run re-applies cleanly (no compounding)
    spec.player.speed *= 1.12;
    spec.player.health = 999;
    applyLoadout(spec, p);
    expect(spec.player.speed).toBeCloseTo(6 * 1.08, 10);
    expect(spec.player.health).toBe(125);
  });

  it('the snapshot is taken once — a late first snapshot still cannot pollute it', () => {
    const spec = fakeSpec();
    snapshotLoadoutBase(spec);
    spec.player.speed = 42; // run-time mutation after the snapshot
    snapshotLoadoutBase(spec); // second call is a no-op
    applyLoadout(spec, defaultProfile());
    expect(spec.player.speed).toBe(6);
  });
});

describe('M4 — boss-quota top-up for ruin-style stages', () => {
  const ruin = { id: 'ruin', type: 'boss', count: 1, timeLimit: 0, description: 'Shatter the core' } as ObjectiveStage;

  it('reports a deficit when the stage needs a boss but none are alive or spawned in-stage', () => {
    // exact QA repro: brute×1 + walker×4, the one brute spent on 'warden'
    expect(bossQuotaDeficit(ruin, 0, 0, 0)).toBe(1);
  });

  it('no deficit when a brute is already alive', () => {
    expect(bossQuotaDeficit(ruin, 0, 0, 1)).toBe(0);
  });

  it('no deficit once the stage quota was already spawned in-stage', () => {
    expect(bossQuotaDeficit(ruin, 0, 1, 0)).toBe(0);
  });

  it('no deficit while the choice modal is open (stage already satisfied)', () => {
    expect(bossQuotaDeficit(ruin, 1, 0, 0)).toBe(0);
  });

  it('no deficit for non-boss stages', () => {
    const elim = { ...ruin, id: 'skirmish', type: 'eliminate' as const };
    expect(bossQuotaDeficit(elim, 0, 0, 0)).toBe(0);
    expect(bossQuotaDeficit(undefined, 0, 0, 0)).toBe(0);
  });

  it('scales with the stage count', () => {
    const big = { ...ruin, count: 3 };
    expect(bossQuotaDeficit(big, 0, 1, 0)).toBe(2);
  });
});

describe('M8 — rapid-fire expiry keeps a concurrent firerate upgrade', () => {
  const fxEngine = () => ({ audio: { play() {} }, hud: { toast() {} } });
  const avatar = {} as unknown as PlayerAvatar; // non-null: rapid folds into weaponMods

  it('rapid → firerate upgrade → rapid expiry retains the upgrade', () => {
    const fx = new EffectState();
    const spec = { custom: {} } as unknown as GameSpec;
    applyPickupEffect(fxEngine() as any, fx, avatar, spec, 'rapid');
    const wm = () => (spec.custom as any).weaponMods;
    expect(wm().rateOfFire).toBe(2);
    // firerate level-up taken while rapid is active (Progression.applyUpgrade math)
    wm().rateOfFire *= 1.2;
    fx.tick(EFFECT_DEFS.rapid.duration + 0.5, spec);
    expect(fx.isActive('rapid')).toBe(false);
    expect(wm().rateOfFire).toBeCloseTo(1.2, 10);
  });

  it('a plain rapid round-trips to the base value', () => {
    const fx = new EffectState();
    const spec = { custom: {} } as unknown as GameSpec;
    applyPickupEffect(fxEngine() as any, fx, avatar, spec, 'rapid');
    fx.tick(EFFECT_DEFS.rapid.duration + 0.5, spec);
    expect((spec.custom as any).weaponMods.rateOfFire).toBe(1);
  });

  it('expiry with no avatar (racing) touches nothing', () => {
    const fx = new EffectState();
    const spec = { custom: { weaponMods: { rateOfFire: 1.5 } } } as unknown as GameSpec;
    applyPickupEffect(fxEngine() as any, fx, null, spec, 'rapid');
    fx.tick(EFFECT_DEFS.rapid.duration + 0.5, spec);
    expect((spec.custom as any).weaponMods.rateOfFire).toBe(1.5);
  });
});
