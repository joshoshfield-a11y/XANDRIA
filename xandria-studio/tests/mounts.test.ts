/**
 * UPGRADE LOOP (mounts): rideable mounts — pure-state unit tests.
 * - defs table: exactly 3 seeded mounts with the shipped tuning table
 * - summon/dismiss: unknown ids rejected, dismiss clears the ride
 * - speed multiplier: exact per-def values, 1 when dismounted/exhausted
 * - stamina: drain only while mounted+moving, regen otherwise, capped
 * - exhaustion: latches at 0, releases at >=30% of the pool (hysteresis)
 * - persistence: serialize round-trip, unknown active ids dropped,
 *   profile migration defaults + validation
 */
import { describe, it, expect } from 'vitest';
import { MOUNT_DEFS, MountState, mountDefOf } from '../src/engine/game/mounts';
import { defaultProfile, migrateProfile } from '../src/engine/game/Profile';

describe('mount defs', () => {
  it('seeds exactly 3 mounts with the shipped tuning table', () => {
    expect(MOUNT_DEFS.map((d) => d.id)).toEqual(['swift-strider', 'armored-beetle', 'drake-lite']);
    const strider = mountDefOf('swift-strider')!;
    expect(strider.speedMult).toBe(1.5);
    expect(strider.staminaMax).toBe(100);
    expect(strider.drainPerSec).toBe(8);
    expect(strider.regenPerSec).toBe(15);
    const beetle = mountDefOf('armored-beetle')!;
    expect(beetle.speedMult).toBe(1.25);
    expect(beetle.staminaMax).toBe(140);
    expect(beetle.drainPerSec).toBe(5);
    expect(beetle.regenPerSec).toBe(10);
    const drake = mountDefOf('drake-lite')!;
    expect(drake.speedMult).toBe(1.75);
    expect(drake.staminaMax).toBe(80);
    expect(drake.drainPerSec).toBe(12);
    expect(drake.regenPerSec).toBe(12);
  });

  it('mountDefOf returns null for unknown ids', () => {
    expect(mountDefOf('nope')).toBeNull();
  });
});

describe('MountState summon/dismiss/speed', () => {
  it('starts dismounted at speed 1', () => {
    const s = new MountState();
    expect(s.mounted).toBe(false);
    expect(s.speedMultiplier()).toBe(1);
  });

  it('summon sets the exact speed multiplier; dismiss restores 1', () => {
    const s = new MountState();
    expect(s.summon('swift-strider')).toBe(true);
    expect(s.mounted).toBe(true);
    expect(s.speedMultiplier()).toBe(1.5);
    expect(s.summon('armored-beetle')).toBe(true);
    expect(s.speedMultiplier()).toBe(1.25);
    expect(s.summon('drake-lite')).toBe(true);
    expect(s.speedMultiplier()).toBe(1.75);
    s.dismiss();
    expect(s.mounted).toBe(false);
    expect(s.speedMultiplier()).toBe(1);
  });

  it('summon rejects unknown ids without changing state', () => {
    const s = new MountState();
    expect(s.summon('nope')).toBe(false);
    expect(s.mounted).toBe(false);
    s.summon('swift-strider');
    expect(s.summon('nope')).toBe(false);
    expect(s.activeId).toBe('swift-strider');
  });
});

describe('MountState stamina', () => {
  it('drains only while mounted and moving, at the def rate', () => {
    const s = new MountState();
    s.summon('swift-strider');
    expect(s.staminaOf('swift-strider')).toBe(100);
    s.update(10, true);
    expect(s.staminaOf('swift-strider')).toBe(20); // 100 - 8*10
    s.update(5, false);
    expect(s.staminaOf('swift-strider')).toBe(95); // 20 + 15*5, capped at 100 only above
    s.update(10, false);
    expect(s.staminaOf('swift-strider')).toBe(100); // capped
  });

  it('does not drain while dismounted', () => {
    const s = new MountState();
    s.update(60, true);
    s.summon('swift-strider');
    expect(s.staminaOf('swift-strider')).toBe(100);
  });

  it('exhaustion latches at 0 and releases at >=30% (hysteresis, no flicker)', () => {
    const s = new MountState();
    s.summon('swift-strider');
    s.update(13, true); // 100 - 104 -> 0
    expect(s.staminaOf('swift-strider')).toBe(0);
    expect(s.exhausted).toBe(true);
    expect(s.speedMultiplier()).toBe(1);
    s.update(1, false); // regen to 15 — still exhausted (below 30)
    expect(s.exhausted).toBe(true);
    expect(s.speedMultiplier()).toBe(1);
    s.update(1, false); // regen to 30 — released
    expect(s.exhausted).toBe(false);
    expect(s.speedMultiplier()).toBe(1.5);
  });

  it('beetle stamina math: 140 pool, 5/s drain, 10/s regen', () => {
    const s = new MountState();
    s.summon('armored-beetle');
    s.update(20, true);
    expect(s.staminaOf('armored-beetle')).toBe(40); // 140 - 100
    s.update(5, false);
    expect(s.staminaOf('armored-beetle')).toBe(90); // 40 + 50
  });
});

describe('MountState persistence', () => {
  it('serialize round-trip preserves active mount + stamina', () => {
    const s = new MountState();
    s.summon('drake-lite');
    s.update(2, true); // 80 - 24 = 56
    const restored = new MountState(s.toPersist());
    expect(restored.activeId).toBe('drake-lite');
    expect(restored.staminaOf('drake-lite')).toBe(56);
    expect(restored.speedMultiplier()).toBe(1.75);
  });

  it('unknown active ids in persisted state are dropped', () => {
    const s = new MountState({ active: 'ghost-mount', stamina: {} });
    expect(s.activeId).toBeNull();
    expect(s.mounted).toBe(false);
  });

  it('out-of-range stamina is clamped on load', () => {
    const s = new MountState({ active: 'swift-strider', stamina: { 'swift-strider': 9999 } });
    expect(s.staminaOf('swift-strider')).toBe(100);
    const s2 = new MountState({ active: 'swift-strider', stamina: { 'swift-strider': -5 } });
    expect(s2.staminaOf('swift-strider')).toBe(0);
  });
});

describe('profile mounts field', () => {
  it('defaultProfile starts on foot with empty stamina', () => {
    expect(defaultProfile().mounts).toEqual({ active: null, stamina: {} });
  });

  it('migrateProfile preserves a valid mounts record and drops junk', () => {
    const p = migrateProfile({ mounts: { active: 'swift-strider', stamina: { 'swift-strider': 42, junk: 'x' } } });
    expect(p.mounts.active).toBe('swift-strider');
    expect(p.mounts.stamina).toEqual({ 'swift-strider': 42 });
    const fresh = migrateProfile({});
    expect(fresh.mounts).toEqual({ active: null, stamina: {} });
    const bad = migrateProfile({ mounts: 'nope' });
    expect(bad.mounts).toEqual({ active: null, stamina: {} });
  });
});
