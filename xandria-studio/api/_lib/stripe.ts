import Stripe from "stripe";
import { serverEnv } from "./http.js";

/** Lazily-created Stripe client (live mode keys from Vercel env). */
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (!cached) {
    cached = new Stripe(serverEnv("STRIPE_SECRET_KEY"));
  }
  return cached;
}

/** Stripe lookup_key per paid tier. */
export const PRICE_LOOKUP_KEYS = {
  hobby: "xandria_hobby_monthly",
  pro: "xandria_pro_monthly",
} as const;

/**
 * Resolve the live price id for a tier at runtime via Prices Search,
 * so price ids can change in the Stripe dashboard without a redeploy.
 */
export async function resolvePriceId(stripe: Stripe, tier: "hobby" | "pro"): Promise<string> {
  const lookupKey = PRICE_LOOKUP_KEYS[tier];
  const result = await stripe.prices.search({
    query: `lookup_key:'${lookupKey}' active:'true'`,
    limit: 1,
  });
  const price = result.data[0];
  if (!price) {
    throw new Error(`No active Stripe price found for lookup_key ${lookupKey}`);
  }
  return price.id;
}
