/**
 * XANDRIA billing entitlements — pure helpers shared by the api/ serverless
 * functions and the (future) frontend. No I/O, no Stripe/Supabase imports,
 * so this module is trivially unit-testable.
 */

/** Subscription tier. `free` is the default when no paid subscription is active. */
export type Tier = "free" | "hobby" | "pro";

/** Monthly generation caps per tier. */
export const TIER_CAPS: Record<Tier, number> = {
  free: 5,
  hobby: 50,
  pro: 500,
};

/**
 * Usage bucket for a date, in the server's local calendar month.
 * Always zero-padded: "2026-01", never "2026-1".
 */
export function monthKey(d: Date): string {
  const month = d.getMonth() + 1; // 1–12
  return `${d.getFullYear()}-${String(month).padStart(2, "0")}`;
}

/** Minimal subscription row shape needed to resolve a tier. */
export interface SubscriptionLike {
  tier: string;
  status: string;
}

/** Statuses Stripe uses that still grant paid access. */
const PAID_ACTIVE_STATUSES = new Set(["active", "trialing"]);

/**
 * Resolve the effective tier from a subscription row (or null when the user
 * has none). Paid tiers only apply while the subscription is active/trialing;
 * anything else (canceled, past_due, unpaid, incomplete, ...) falls back to
 * "free". Unknown tier strings also fall back to "free" rather than throwing,
 * so a future tier rename can't accidentally grant paid access.
 */
export function resolveTier(sub: SubscriptionLike | null): Tier {
  if (sub === null) return "free";
  if (!PAID_ACTIVE_STATUSES.has(sub.status)) return "free";
  if (sub.tier === "hobby" || sub.tier === "pro") return sub.tier;
  return "free";
}

/** Remaining generations this month: never negative. */
export function generationsRemaining(tier: Tier, used: number): number {
  return Math.max(0, TIER_CAPS[tier] - Math.max(0, used));
}
