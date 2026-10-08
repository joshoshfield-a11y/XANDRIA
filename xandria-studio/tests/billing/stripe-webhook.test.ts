import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  processWebhook,
  readRawBody,
} from "../../api/stripe-webhook.js";
import type { BillingStore, UpsertSubscriptionInput } from "../../api/_lib/subscriptions.js";
import { unixToIso, normalizeTier } from "../../api/_lib/subscriptions.js";
import { Readable } from "node:stream";

const WEBHOOK_SECRET = "whsec_test_dummy_secret_for_unit_tests";

process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const stripe = new Stripe("sk_test_dummy_key_no_network", {
  // Webhook signature verification is fully local (HMAC); no API calls made.
});

/** In-memory stub of BillingStore that records every call. */
function makeFakeStore(): BillingStore & {
  calls: Array<{ method: string; args: unknown[] }>;
  subscriptions: Map<string, UpsertSubscriptionInput & { status: string }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const subscriptions = new Map<string, UpsertSubscriptionInput & { status: string }>();
  return {
    calls,
    subscriptions,
    async upsertProfile(userId, email) {
      calls.push({ method: "upsertProfile", args: [userId, email] });
    },
    async upsertSubscription(input) {
      calls.push({ method: "upsertSubscription", args: [input] });
      subscriptions.set(input.stripe_subscription_id, { ...input });
    },
    async patchSubscription(id, patch) {
      calls.push({ method: "patchSubscription", args: [id, patch] });
      const existing = subscriptions.get(id);
      if (existing) subscriptions.set(id, { ...existing, ...patch });
    },
    async markSubscriptionCanceled(id) {
      calls.push({ method: "markSubscriptionCanceled", args: [id] });
      const existing = subscriptions.get(id);
      if (existing) subscriptions.set(id, { ...existing, status: "canceled" });
    },
  };
}

const stripeDeps = {
  retrieveSubscription: vi.fn(async (_id: string) => ({ current_period_end: 1_780_000_000 })),
};

/** Build a signed event payload using the REAL stripe lib signature code. */
function signedPayload(event: unknown): { raw: Buffer; signature: string } {
  const raw = Buffer.from(JSON.stringify(event), "utf8");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: raw.toString("utf8"),
    secret: WEBHOOK_SECRET,
  });
  return { raw, signature };
}

function checkoutCompletedEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "evt_checkout_completed_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        object: "checkout.session",
        customer: "cus_test_123",
        customer_email: "test@example.com",
        customer_details: { email: "test@example.com" },
        subscription: "sub_test_123",
        metadata: { tier: "hobby", supabase_user_id: "user-uuid-1" },
        ...overrides,
      },
    },
  };
}

describe("processWebhook signature verification", () => {
  it("rejects a tampered signature (400 path)", async () => {
    const { raw } = signedPayload(checkoutCompletedEvent());
    await expect(
      processWebhook(raw, "t=123,v1=deadbeef", makeFakeStore(), stripe, stripeDeps),
    ).rejects.toThrow();
  });

  it("rejects a mismatched webhook secret", async () => {
    const raw = Buffer.from(JSON.stringify(checkoutCompletedEvent()), "utf8");
    const sig = stripe.webhooks.generateTestHeaderString({
      payload: raw.toString("utf8"),
      secret: "whsec_wrong_secret",
    });
    await expect(processWebhook(raw, sig, makeFakeStore(), stripe, stripeDeps)).rejects.toThrow();
  });
});

describe("checkout.session.completed", () => {
  let store: ReturnType<typeof makeFakeStore>;

  beforeEach(() => {
    store = makeFakeStore();
    stripeDeps.retrieveSubscription.mockClear();
  });

  it("upserts an active hobby subscription row with the period end", async () => {
    const { raw, signature } = signedPayload(checkoutCompletedEvent());
    await processWebhook(raw, signature, store, stripe, stripeDeps);

    expect(stripeDeps.retrieveSubscription).toHaveBeenCalledWith("sub_test_123");
    expect(store.calls.find((c) => c.method === "upsertProfile")?.args).toEqual([
      "user-uuid-1",
      "test@example.com",
    ]);
    const sub = store.subscriptions.get("sub_test_123");
    expect(sub).toMatchObject({
      user_id: "user-uuid-1",
      stripe_customer_id: "cus_test_123",
      stripe_subscription_id: "sub_test_123",
      tier: "hobby",
      status: "active",
      current_period_end: unixToIso(1_780_000_000),
    });
  });

  it("is idempotent across replays (same values, no duplicates)", async () => {
    const { raw, signature } = signedPayload(checkoutCompletedEvent());
    await processWebhook(raw, signature, store, stripe, stripeDeps);
    await processWebhook(raw, signature, store, stripe, stripeDeps);
    const upserts = store.calls.filter((c) => c.method === "upsertSubscription");
    expect(upserts).toHaveLength(2);
    expect(upserts[0].args[0]).toEqual(upserts[1].args[0]);
    expect(store.subscriptions.size).toBe(1);
  });

  it("ignores sessions without our metadata linkage", async () => {
    const { raw, signature } = signedPayload(
      checkoutCompletedEvent({ metadata: {}, subscription: null }),
    );
    await processWebhook(raw, signature, store, stripe, stripeDeps);
    expect(store.calls).toHaveLength(0);
  });
});

describe("customer.subscription.updated", () => {
  let store: ReturnType<typeof makeFakeStore>;

  beforeEach(() => {
    store = makeFakeStore();
  });

  function updatedEvent(md: Record<string, string>): unknown {
    return {
      id: "evt_sub_updated_1",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test_123",
          object: "subscription",
          customer: "cus_test_123",
          status: "past_due",
          items: { data: [{ current_period_end: 1_780_000_100 }] },
          metadata: md,
        },
      },
    };
  }

  it("syncs status/tier/period end by stripe_subscription_id when metadata is linked", async () => {
    const { raw, signature } = signedPayload(
      updatedEvent({ tier: "pro", supabase_user_id: "user-uuid-1" }),
    );
    await processWebhook(raw, signature, store, stripe, stripeDeps);
    const sub = store.subscriptions.get("sub_test_123");
    expect(sub).toMatchObject({
      user_id: "user-uuid-1",
      tier: "pro",
      status: "past_due",
      current_period_end: unixToIso(1_780_000_100),
    });
  });

  it("patches but never creates an orphan row when metadata is missing", async () => {
    const { raw, signature } = signedPayload(updatedEvent({}));
    await processWebhook(raw, signature, store, stripe, stripeDeps);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].method).toBe("patchSubscription");
    expect(store.subscriptions.size).toBe(0);
  });
});

describe("customer.subscription.deleted", () => {
  it("marks the subscription canceled; tier resolution falls back to free", async () => {
    const store = makeFakeStore();
    const event = {
      id: "evt_sub_deleted_1",
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test_123", object: "subscription" } },
    };
    const { raw, signature } = signedPayload(event);
    await processWebhook(raw, signature, store, stripe, stripeDeps);
    expect(store.calls).toEqual([{ method: "markSubscriptionCanceled", args: ["sub_test_123"] }]);
  });
});

describe("helpers", () => {
  it("normalizeTier sanitizes metadata", () => {
    expect(normalizeTier("hobby")).toBe("hobby");
    expect(normalizeTier("pro")).toBe("pro");
    expect(normalizeTier("enterprise")).toBe("free");
    expect(normalizeTier(undefined)).toBe("free");
    expect(normalizeTier(null)).toBe("free");
  });

  it("unixToIso is null-safe", () => {
    expect(unixToIso(null)).toBeNull();
    expect(unixToIso(undefined)).toBeNull();
    expect(unixToIso(0)).toBe(new Date(0).toISOString());
  });

  it("readRawBody returns the exact bytes (signature integrity)", async () => {
    const raw = Buffer.from("{\"a\":1}", "utf8");
    const req = Readable.from([raw]) as unknown as Parameters<typeof readRawBody>[0];
    const out = await readRawBody(req);
    expect(out.equals(raw)).toBe(true);
  });
});
