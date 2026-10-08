import type { IncomingMessage, ServerResponse } from "node:http";
import { json, methodNotAllowed } from "./_lib/http.js";
import { requireUser, getServerClient } from "./_lib/supabase.js";
import { SupabaseBillingStore, getSubscriptionByUserId } from "./_lib/subscriptions.js";
import {
  generationsRemaining,
  monthKey,
  resolveTier,
} from "../src/billing/entitlements.js";

/**
 * GET /api/me — entitlement snapshot for the signed-in user.
 *
 * Auth: Authorization: Bearer <supabase JWT> (401 on bad/missing JWT)
 * Lazily ensures the profile row exists, then returns:
 *   { tier, status, generations_used, generations_remaining, month: "YYYY-MM" }
 *
 * tier = the paid tier when an active/trialing subscription exists, else "free".
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    methodNotAllowed(res, "GET");
    return;
  }

  const user = await requireUser(req);
  if (!user) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    await new SupabaseBillingStore().upsertProfile(user.id, user.email);
    const sub = await getSubscriptionByUserId(user.id);
    const tier = resolveTier(sub);

    const month = monthKey(new Date());
    const { data, error } = await getServerClient()
      .from("generation_counts")
      .select("count")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();
    if (error) throw error;
    const used = (data as { count: number } | null)?.count ?? 0;

    json(res, 200, {
      tier,
      status: sub?.status ?? "active",
      generations_used: used,
      generations_remaining: generationsRemaining(tier, used),
      month,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("me error", err);
    json(res, 500, { error: "me_failed" });
  }
}
