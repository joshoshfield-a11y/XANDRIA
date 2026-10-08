import type { Stripe } from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tier } from "../../src/billing/entitlements.js";
import { getServerClient } from "./supabase.js";

/** Shape of a row in the `subscriptions` table. */
export interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: string;
  status: string;
  current_period_end: string | null;
  updated_at: string;
}

/** Shape of a row in the `generation_counts` table. */
export interface GenerationCountRow {
  user_id: string;
  month: string;
  count: number;
}

export interface UpsertSubscriptionInput {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
  tier: Tier;
  status: string;
  current_period_end: string | null;
}

/**
 * DB operations the webhook needs. Kept behind a small interface so tests
 * can stub it and the serverless functions can use the Supabase impl below.
 */
export interface BillingStore {
  /** Lazily create the user's profile row (idempotent). */
  upsertProfile(userId: string, email: string | null): Promise<void>;
  /**
   * Idempotent upsert keyed on stripe_subscription_id: insert the row, or
   * update tier/status/period/customer when it already exists.
   */
  upsertSubscription(input: UpsertSubscriptionInput): Promise<void>;
  /**
   * Patch tier/status/period_end for an existing row by stripe_subscription_id.
   * Used when a full upsert isn't possible (e.g. subscription metadata
   * missing); no-ops if no row exists for the id.
   */
  patchSubscription(
    stripeSubscriptionId: string,
    patch: { tier: Tier; status: string; current_period_end: string | null },
  ): Promise<void>;
  /** Mark a subscription canceled; tier access falls back to free via resolveTier. */
  markSubscriptionCanceled(stripeSubscriptionId: string): Promise<void>;
}

/** Sanitize a tier string from Stripe metadata; anything unknown -> free. */
export function normalizeTier(value: unknown): Tier {
  return value === "hobby" || value === "pro" ? value : "free";
}

/** Unix seconds -> ISO string (Supabase timestamptz), null-safe. */
export function unixToIso(ts: number | null | undefined): string | null {
  if (typeof ts !== "number") return null;
  return new Date(ts * 1000).toISOString();
}

/** Extra Stripe lookups the event handlers need, injected for testability. */
export interface StripeDeps {
  retrieveSubscription(id: string): Promise<{ current_period_end: number } | null>;
}

function checkoutSessionIds(
  session: Stripe.Checkout.Session,
): { userId: string; stripeSubscriptionId: string; customerId: string | null } | null {
  const md = session.metadata ?? {};
  const userId = typeof md.supabase_user_id === "string" ? md.supabase_user_id : null;
  const rawSub = session.subscription;
  const stripeSubscriptionId =
    typeof rawSub === "string" ? rawSub : rawSub && typeof rawSub === "object" ? rawSub.id : null;
  const rawCustomer = session.customer;
  const customerId =
    typeof rawCustomer === "string" ? rawCustomer : rawCustomer && typeof rawCustomer === "object" ? rawCustomer.id : null;
  if (!userId || !stripeSubscriptionId) return null; // not one of ours — ignore
  return { userId, stripeSubscriptionId, customerId };
}

/**
 * Route a verified Stripe event to the right store operation.
 * All operations are idempotent: replaying an event changes nothing beyond
 * the first application.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  store: BillingStore,
  deps: StripeDeps,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const ids = checkoutSessionIds(session);
      if (!ids) return;
      const tier = normalizeTier(session.metadata?.tier);
      const email =
        typeof session.customer_email === "string"
          ? session.customer_email
          : (session.customer_details?.email ?? null);
      await store.upsertProfile(ids.userId, email);
      const sub = await deps.retrieveSubscription(ids.stripeSubscriptionId);
      await store.upsertSubscription({
        user_id: ids.userId,
        stripe_customer_id: ids.customerId,
        stripe_subscription_id: ids.stripeSubscriptionId,
        tier,
        status: "active",
        current_period_end: sub ? unixToIso(sub.current_period_end) : null,
      });
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const tier = normalizeTier(sub.metadata?.tier);
      // Stripe v23: the period end is per subscription-item; our checkout
      // sessions always create single-item subscriptions.
      const firstItem = sub.items?.data?.[0];
      const currentPeriodEnd = unixToIso(firstItem?.current_period_end);
      const userId =
        typeof sub.metadata?.supabase_user_id === "string" ? sub.metadata.supabase_user_id : null;
      const rawCustomer = sub.customer;
      const customerId =
        typeof rawCustomer === "string"
          ? rawCustomer
          : rawCustomer && typeof rawCustomer === "object"
            ? rawCustomer.id
            : null;
      if (userId) {
        // Full idempotent upsert — works even if checkout.session.completed
        // was missed (e.g. a past_due sub flipping back to active).
        await store.upsertSubscription({
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: sub.id,
          tier,
          status: sub.status,
          current_period_end: currentPeriodEnd,
        });
      } else {
        // No user linkage in metadata: patch only, never create an orphan row.
        await store.patchSubscription(sub.id, {
          tier,
          status: sub.status,
          current_period_end: currentPeriodEnd,
        });
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      // Status-only change; resolveTier() falls back to free for canceled subs.
      await store.markSubscriptionCanceled(sub.id);
      break;
    }
    default:
      // Other event types are intentionally ignored.
      break;
  }
}

/** Supabase-backed BillingStore (server-side, service role bypasses RLS). */
export class SupabaseBillingStore implements BillingStore {
  constructor(private readonly client: SupabaseClient = getServerClient()) {}

  async upsertProfile(userId: string, email: string | null): Promise<void> {
    const { error } = await this.client.from("profiles").upsert({ id: userId, email }, { onConflict: "id" });
    if (error) throw error;
  }

  async upsertSubscription(input: UpsertSubscriptionInput): Promise<void> {
    const { error } = await this.client.from("subscriptions").upsert(
      {
        user_id: input.user_id,
        stripe_customer_id: input.stripe_customer_id,
        stripe_subscription_id: input.stripe_subscription_id,
        tier: input.tier,
        status: input.status,
        current_period_end: input.current_period_end,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_id" },
    );
    if (error) throw error;
  }

  async patchSubscription(
    stripeSubscriptionId: string,
    patch: { tier: Tier; status: string; current_period_end: string | null },
  ): Promise<void> {
    const { error } = await this.client
      .from("subscriptions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("stripe_subscription_id", stripeSubscriptionId);
    if (error) throw error;
  }

  async markSubscriptionCanceled(stripeSubscriptionId: string): Promise<void> {
    const { error } = await this.client
      .from("subscriptions")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("stripe_subscription_id", stripeSubscriptionId);
    if (error) throw error;
  }
}

/** Look up a user's subscription row by user id. */
export async function getSubscriptionByUserId(userId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await getServerClient()
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as SubscriptionRow | null) ?? null;
}
