/**
 * Unit tests for the subscription tier-gating helpers (src/studio/tierGate.ts).
 * Pure logic — no supabase, no DOM, no backend.
 */
import { describe, expect, it } from 'vitest';
import {
  TIER_GENERATIONS_PER_MONTH,
  canExportItch,
  canExportSteam,
  canUseApi,
  effectiveSplash,
  splashForcedOn,
  tierAtLeast,
  tierBadge,
  truncateEmail,
  upgradeNudge,
  SIGNIN_NUDGE,
} from '../src/studio/tierGate';

describe('tierAtLeast', () => {
  it('orders free < hobby < pro', () => {
    expect(tierAtLeast('free', 'free')).toBe(true);
    expect(tierAtLeast('hobby', 'free')).toBe(true);
    expect(tierAtLeast('pro', 'hobby')).toBe(true);
    expect(tierAtLeast('free', 'hobby')).toBe(false);
    expect(tierAtLeast('hobby', 'pro')).toBe(false);
    expect(tierAtLeast('free', 'pro')).toBe(false);
  });
});

describe('export / api gates', () => {
  it('itch.io export needs hobby+', () => {
    expect(canExportItch('free')).toBe(false);
    expect(canExportItch('hobby')).toBe(true);
    expect(canExportItch('pro')).toBe(true);
    expect(canExportItch(null)).toBe(false);
  });
  it('steam export and API are pro-only', () => {
    expect(canExportSteam('free')).toBe(false);
    expect(canExportSteam('hobby')).toBe(false);
    expect(canExportSteam('pro')).toBe(true);
    expect(canExportSteam(null)).toBe(false);
    expect(canUseApi('hobby')).toBe(false);
    expect(canUseApi('pro')).toBe(true);
    expect(canUseApi(null)).toBe(false);
  });
});

describe('splash policy', () => {
  it('free tier (and signed-out) forces the splash on', () => {
    expect(splashForcedOn('free')).toBe(true);
    expect(splashForcedOn(null)).toBe(true);
    expect(splashForcedOn('hobby')).toBe(false);
    expect(splashForcedOn('pro')).toBe(false);
  });
  it('effectiveSplash: forced on for free, toggle for paid (default off)', () => {
    expect(effectiveSplash('free', false)).toBe(true);
    expect(effectiveSplash('free', true)).toBe(true);
    expect(effectiveSplash('hobby', false)).toBe(false);
    expect(effectiveSplash('hobby', true)).toBe(true);
    expect(effectiveSplash('pro', false)).toBe(false);
    expect(effectiveSplash(null, false)).toBe(true);
  });
});

describe('documented monthly caps', () => {
  it('matches the packaging tiers: 5 / 50 / 500', () => {
    expect(TIER_GENERATIONS_PER_MONTH).toEqual({ free: 5, hobby: 50, pro: 500 });
  });
});

describe('nudge copy', () => {
  it('every gate explains the block and the unlock — never silent', () => {
    for (const action of ['generate', 'export', 'steam', 'api'] as const) {
      const msg = upgradeNudge(action, 'free');
      expect(msg.length).toBeGreaterThan(20);
      expect(msg.toLowerCase()).toMatch(/upgrade|hobby|pro|\$/);
    }
  });
  it('export nudge differs for signed-out users', () => {
    expect(upgradeNudge('export', null)).toMatch(/sign in/i);
    expect(upgradeNudge('export', 'free')).toMatch(/hobby/i);
  });
  it('signin nudge mentions the free tier and no card', () => {
    expect(SIGNIN_NUDGE).toMatch(/free/i);
  });
});

describe('truncateEmail / tierBadge', () => {
  it('short emails pass through untouched', () => {
    expect(truncateEmail('a@b.co')).toBe('a@b.co');
  });
  it('long emails are truncated with an ellipsis', () => {
    const out = truncateEmail('verylongaddressname@example.com', 22);
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.endsWith('…')).toBe(true);
  });
  it('badges are uppercase tier names', () => {
    expect(tierBadge('free')).toBe('FREE');
    expect(tierBadge('hobby')).toBe('HOBBY');
    expect(tierBadge('pro')).toBe('PRO');
  });
});
