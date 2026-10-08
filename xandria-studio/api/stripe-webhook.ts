import type { IncomingMessage, ServerResponse } from "node:http";
import Stripe from "stripe";
import { json, methodNotAllowed, serverEnv } from "./_lib/http.js";
import { getStripe } from "./_lib/stripe.js";
import {
  SupabaseBillingStore,
  handleStripeEvent,
  type BillingStore,
  type StripeDeps,
} from "./_lib/subscriptions.js";

// Stripe signature verification requires the EXACT raw request body, so
// Vercel's JSON body parsing must stay off. This is a signature-security
// requirement, not an optimization.
export const config = { api: { bodyParser: false } };

/** Read the request stream verbatim as a Buffer. */
export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Verify the Stripe signature and route the event. Factored out of the
 * default handler so tests can inject a stub store and a fake StripeDeps
 * without touching the network or the database.
 */
export async function processWebhook(
  rawBody: Buffer,
  signature: string,
  store: BillingStore,
  stripe: Stripe,
  deps?: StripeDeps,
): Promise<void> {
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    serverEnv("STRIPE_WEBHOOK_SECRET"),
  );
  const stripeDeps: StripeDeps = deps ?? {
    retrieveSubscription: async (id: string) => {
      // Stripe v23: the period end is per subscription-item; our checkout
      // sessions always create single-item subscriptions.
      const response = await stripe.subscriptions.retrieve(id);
      const firstItem = response.items?.data?.[0];
      return firstItem ? { current_period_end: firstItem.current_period_end } : null;
    },
  };
  await handleStripeEvent(event, store, stripeDeps);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    methodNotAllowed(res, "POST");
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !signature) {
    json(res, 400, { error: "missing_signature" });
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const stripe = getStripe();
    await processWebhook(rawBody, signature, new SupabaseBillingStore(), stripe);
    json(res, 200, { received: true });
  } catch (err) {
    // Signature verification failed (or event handling blew up).
    // Return 400 so Stripe retries; do NOT log the raw body.
    // eslint-disable-next-line no-console
    console.error("webhook error", err instanceof Error ? err.message : err);
    json(res, 400, { error: "webhook_failed" });
  }
}
