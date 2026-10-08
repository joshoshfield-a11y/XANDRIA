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
 * POST /api/generations — record one completed generation.
 *
 * Auth: Authorization: Bearer <supabase JWT> (401 on bad/missing JWT)
 * Increments this month's generation_counts row for the user and returns
 * { used, remaining }.
 *
 * Usage contract (see packaging): the frontend checks the allowance via
 * GET /api/me BEFORE generating, and only calls this endpoint AFTER a build
 * completes successfully — failed builds don't count.
 *
 * Known v1 limitation (TOCTOU): the frontend's check-then-record pattern is
 * not atomic. Two builds racing the last remaining slot can both see
 * "remaining >= 1" and both record, pushing used one over the cap. This
 * endpoint just records honestly. Fixing it for real would need a server-side
 * atomic check-and-increment (e.g. a Postgres function doing the allowance
 * check inside the same transaction as the increment). For v1 the overage
 * is bounded by the race window and costs us nothing (generations are
 * throttled server-side later, not metered-billed).
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

    const { data, error } = await client
      .from("generation_counts")
      .select("count")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();
    if (error) throw error;

    const current = (data as { count: number } | null)?.count ?? 0;
    const next = current + 1;
    const { error: writeError } = await client.from("generation_counts").upsert(
      { user_id: user.id, month, count: next },
      { onConflict: "user_id,month" },
    );
    if (writeError) throw writeError;

    const sub = await getSubscriptionByUserId(user.id);
    const tier = resolveTier(sub);

    json(res, 200, { used: next, remaining: generationsRemaining(tier, next) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("generations error", err);
    json(res, 500, { error: "generations_failed" });
  }
}
