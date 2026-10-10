import type { IncomingMessage, ServerResponse } from "node:http";
import { json, methodNotAllowed } from "./_lib/http.js";
import { requireUser, getServerClient } from "./_lib/supabase.js";
import { SupabaseBillingStore, getSubscriptionByUserId } from "./_lib/subscriptions.js";
import {
  TIER_CAPS,
  generationsRemaining,
  monthKey,
  resolveTier,
} from "../src/billing/entitlements.js";

/**
 * POST /api/generations — record one completed generation.
 *
 * Auth: Authorization: Bearer <supabase JWT> (401 on bad/missing JWT)
 *
 * Server-side quota enforcement (H-1 fix): resolves the caller's tier,
 * reads this month's count, and rejects with 429 when the tier cap is
 * reached — BEFORE incrementing. The frontend still pre-checks via
 * GET /api/me for UX, but the server is the enforcement point: a raw
 * curl loop past the cap gets 429s, not free generations.
 *
 * Usage contract (see packaging): the frontend checks the allowance via
 * GET /api/me BEFORE generating, and only calls this endpoint AFTER a build
 * completes successfully — failed builds don't count.
 *
 * Known v1 limitation (TOCTOU): check-then-increment is not atomic. Two
 * builds racing the last remaining slot can both pass the check and both
 * record, pushing used one over the cap. For v1 the overage is bounded by
 * the race window and costs us nothing (client-side compute, not
 * metered billing). A truly atomic check-and-increment would need a
 * Postgres function + migration — deliberately deferred so the live DB
 * (schema.sql already applied) needs no new migration for this fix wave.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    methodNotAllowed(res, "POST");
    return;
  }

  const user = await requireUser(req);
  if (!user) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    await new SupabaseBillingStore().upsertProfile(user.id, user.email);
    const client = getServerClient();
    const month = monthKey(new Date());

    // Resolve the tier BEFORE reading/incrementing — the cap depends on it.
    const sub = await getSubscriptionByUserId(user.id);
    const tier = resolveTier(sub);
    const cap = TIER_CAPS[tier];

    const { data, error } = await client
      .from("generation_counts")
      .select("count")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();
    if (error) throw error;

    const current = (data as { count: number } | null)?.count ?? 0;
    if (current >= cap) {
      json(res, 429, {
        error: "quota_exceeded",
        tier,
        used: current,
        cap,
        month,
      });
      return;
    }

    const next = current + 1;
    const { error: writeError } = await client.from("generation_counts").upsert(
      { user_id: user.id, month, count: next },
      { onConflict: "user_id,month" },
    );
    if (writeError) throw writeError;

    json(res, 200, { used: next, remaining: generationsRemaining(tier, next) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("generations error", err);
    json(res, 500, { error: "generations_failed" });
  }
}
