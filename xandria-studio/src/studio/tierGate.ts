/**
 * Pure tier-gating logic for XANDRIA's subscription checkout.
 *
 * No imports from auth/billing/backend code: every helper is a pure function
 * over explicit arguments so it can be unit-tested in isolation.
 *
 * Tier facts (from the monetization packaging v0.1):
 *   free  — 5 generations/month, unskippable ~3s "Made with XANDRIA" splash,
 *           non-commercial, account (email magic link) required to generate.
 *   hobby — $12/mo, 50 generations/month, splash removable (default off),
 *           itch.io export, commercial use.
 *   pro   — $39/mo, 500 generations/month, Steam-ready export, API access,
 *           priority queue.
 */

export type Tier = 'free' | 'hobby' | 'pro';

/** Documented monthly generation caps per tier. The /api/me `generations_remaining`
 *  field is the runtime source of truth; these are only for display copy. */
export const TIER_GENERATIONS_PER_MONTH: Record<Tier, number> = {
  free: 5,
  hobby: 50,
  pro: 500,
};

const TIER_RANK: Record<Tier, number> = { free: 0, hobby: 1, pro: 2 };

/** True when `tier` is at or above `required` in the free < hobby < pro ladder. */
export function tierAtLeast(tier: Tier, required: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[required];
}

/** itch.io HTML export (#export) requires hobby or better. */
export function canExportItch(tier: Tier | null): boolean {
  return tier !== null && tierAtLeast(tier, 'hobby');
}

/** Steam-ready export requires pro. */
export function canExportSteam(tier: Tier | null): boolean {
  return tier === 'pro';
}

/** API access requires pro. */
export function canUseApi(tier: Tier | null): boolean {
  return tier === 'pro';
}

/**
 * Splash policy: free tier → splash forced ON (unskippable); hobby/pro →
 * the user's own toggle (default off) decides.
 */
export function splashForcedOn(tier: Tier | null): boolean {
  return tier === null || tier === 'free';
}

/**
 * Effective splash flag for a preview/export given the tier and the user's
 * paid-tier toggle (default false = off for paid tiers).
 */
export function effectiveSplash(tier: Tier | null, userToggle: boolean): boolean {
  if (splashForcedOn(tier)) return true;
  return userToggle;
}

/** Actions that can be gated, for upgrade-nudge copy. */
export type GatedAction = 'generate' | 'export' | 'steam' | 'api' | 'signin';

/**
 * Human upgrade-nudge message for a gated action. Never silent: every gate
 * explains what happened and what unlocks it.
 */
export function upgradeNudge(action: Exclude<GatedAction, 'signin'>, tier: Tier | null): string {
  switch (action) {
    case 'generate':
      return 'You\'ve used all your generations this month. Upgrade to Hobby ($12/mo, 50 gens) or Pro ($39/mo, 500 gens) for more — or wait for next month\'s reset.';
    case 'export':
      return tier === 'free'
        ? 'Export is a Hobby feature ($12/mo). Upgrade to download your games as standalone HTML.'
        : 'Sign in to export your game.';
    case 'steam':
      return 'Steam-ready export is a Pro feature ($39/mo). Upgrade to package your games for Steam.';
    case 'api':
      return 'API access is a Pro feature ($39/mo). Upgrade to generate games programmatically.';
  }
}

export const SIGNIN_NUDGE =
  'Sign in with your email to generate games — it\'s free, 5 generations a month, no card required.';

/** Truncate an email for the account chip (e.g. "verylongaddress…" at 22 chars). */
export function truncateEmail(email: string, max = 22): string {
  if (email.length <= max) return email;
  return email.slice(0, max - 1) + '…';
}

/** Tier badge label for the account chip. */
export function tierBadge(tier: Tier): string {
  return tier.toUpperCase();
}
