import type { IncomingMessage, ServerResponse } from "node:http";
import { json, methodNotAllowed, readJsonBody } from "./_lib/http.js";
import { requireUser } from "./_lib/supabase.js";
import { getStripe, resolvePriceId } from "./_lib/stripe.js";
import { SupabaseBillingStore } from "./_lib/subscriptions.js";

/**
 * POST /api/checkout — create a Stripe Checkout Session for a paid tier.
 *
 * Auth: Authorization: Bearer <supabase JWT> (401 on bad/missing JWT)
 * Body: { tier: "hobby" | "pro" } (400 on anything else)
 *
 * The price is resolved at runtime via Prices Search on the tier's
 * lookup_key, so price changes in the Stripe dashboard need no redeploy.
 * Returns { url } — the frontend redirects the browser there.
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

  const body = await readJsonBody<{ tier?: unknown }>(req);
  const tier = body?.tier;
  if (tier !== "hobby" && tier !== "pro") {
    json(res, 400, { error: "invalid_tier", detail: 'tier must be "hobby" or "pro"' });
    return;
  }

  try {
    const stripe = getStripe();
    const price = await resolvePriceId(stripe, tier);

    // Lazily ensure the profile exists so the webhook never races a missing row.
    await new SupabaseBillingStore().upsertProfile(user.id, user.email);

    const origin = req.headers.origin ?? (req.headers.host ? `https://${req.headers.host}` : "");
    if (!origin) {
      json(res, 500, { error: "no_origin" });
      return;
    }

    const metadata = { tier, supabase_user_id: user.id };
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      client_reference_id: user.id,
      ...(user.email ? { customer_email: user.email } : {}),
      metadata,
      // Copy the linkage metadata onto the Subscription object itself so
      // customer.subscription.updated/deleted events can be routed later.
      subscription_data: { metadata },
      success_url: `${origin}?checkout=success`,
      cancel_url: `${origin}?checkout=canceled`,
    });

    if (!session.url) {
      json(res, 500, { error: "no_checkout_url" });
      return;
    }
    json(res, 200, { url: session.url });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("checkout error", err);
    json(res, 500, { error: "checkout_failed" });
  }
}

