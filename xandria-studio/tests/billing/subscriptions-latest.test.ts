/**
 * Regression tests for H-2 (getSubscriptionByUserId multi-row):
 * a user can legitimately own multiple subscription rows (subscribe →
 * cancel → resubscribe). The lookup must return the most recently updated
 * row — never throw via .maybeSingle() on a multi-row result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSubscriptionByUserId } from "../../api/_lib/subscriptions.js";
import type { SubscriptionRow } from "../../api/_lib/subscriptions.js";

const { mockGetServerClient } = vi.hoisted(() => ({
  mockGetServerClient: vi.fn(),
}));

vi.mock("../../api/_lib/supabase.js", () => ({
  getServerClient: mockGetServerClient,
}));

function row(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    user_id: "user-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_x",
    tier: "hobby",
    status: "active",
    current_period_end: null,
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Fake query builder that honors .order("updated_at", {ascending:false})
 * the way PostgREST would. The builder is thenable (awaiting it executes
 * the query, as in the real supabase-js client).
 */
function makeClient(rows: SubscriptionRow[]): { calls: string[] } {
  const calls: string[] = [];
  let orderCol: string | null = null;
  let orderAsc = true;
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  (chain as { order: (c: string, o: { ascending: boolean }) => unknown }).order = (
    col: string,
    opts: { ascending: boolean },
  ) => {
    calls.push(`order:${col}:${opts.ascending}`);
    orderCol = col;
    orderAsc = opts.ascending;
    return chain;
  };
  (chain as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => {
    let out = [...rows];
    if (orderCol === "updated_at") {
      out.sort((a, b) =>
        orderAsc
          ? a.updated_at.localeCompare(b.updated_at)
          : b.updated_at.localeCompare(a.updated_at),
      );
    }
    resolve({ data: out, error: null });
  };
  mockGetServerClient.mockReturnValue({
    from: (table: string) => {
      calls.push(`from:${table}`);
      return { select: () => chain };
    },
  });
  return { calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSubscriptionByUserId latest-row selection (H-2)", () => {
  it("returns the newest row when a user has multiple rows (cancel → resubscribe)", async () => {
    const canceled = row({
      stripe_subscription_id: "sub_old",
      status: "canceled",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    const active = row({
      stripe_subscription_id: "sub_new",
      status: "active",
      updated_at: "2026-10-05T00:00:00.000Z",
    });
    // Deliberately unsorted input — the query must order, not rely on storage order.
    const { calls } = makeClient([canceled, active]);

    const result = await getSubscriptionByUserId("user-1");

    expect(result).not.toBeNull();
    expect(result!.stripe_subscription_id).toBe("sub_new");
    expect(result!.status).toBe("active");
    // Newest-first query shape (M-2: selection now happens in JS over the
    // ordered rows — no .maybeSingle() on a multi-row result, no .limit(1)).
    expect(calls).toContain("order:updated_at:false");
    expect(calls).not.toContain("limit:1");
  });

  it("returns the single row when only one exists", async () => {
    const only = row({ stripe_subscription_id: "sub_only" });
    makeClient([only]);
    const result = await getSubscriptionByUserId("user-1");
    expect(result?.stripe_subscription_id).toBe("sub_only");
  });

  it("returns null when the user has no rows", async () => {
    makeClient([]);
    const result = await getSubscriptionByUserId("user-1");
    expect(result).toBeNull();
  });
});

describe("getSubscriptionByUserId active-row preference (M-2)", () => {
  it("prefers the newest ACTIVE row over a newer canceled row", async () => {
    // Hobby active (older) → bought Pro (newer) → canceled Pro.
    // The canceled Pro must not shadow the still-active Hobby.
    const hobby = row({
      stripe_subscription_id: "sub_hobby",
      tier: "hobby",
      status: "active",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    const proCanceled = row({
      stripe_subscription_id: "sub_pro",
      tier: "pro",
      status: "canceled",
      updated_at: "2026-10-05T00:00:00.000Z",
    });
    makeClient([proCanceled, hobby]); // deliberately unsorted input

    const result = await getSubscriptionByUserId("user-1");

    expect(result).not.toBeNull();
    expect(result!.stripe_subscription_id).toBe("sub_hobby");
    expect(result!.tier).toBe("hobby");
    expect(result!.status).toBe("active");
  });

  it("falls back to the latest row when nothing is active", async () => {
    const oldCanceled = row({
      stripe_subscription_id: "sub_old",
      status: "canceled",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const newCanceled = row({
      stripe_subscription_id: "sub_new",
      status: "canceled",
      updated_at: "2026-10-05T00:00:00.000Z",
    });
    makeClient([oldCanceled, newCanceled]);

    const result = await getSubscriptionByUserId("user-1");

    expect(result).not.toBeNull();
    expect(result!.stripe_subscription_id).toBe("sub_new");
  });

  it("treats trialing as active", async () => {
    const canceled = row({
      stripe_subscription_id: "sub_old",
      status: "canceled",
      updated_at: "2026-10-05T00:00:00.000Z",
    });
    const trialing = row({
      stripe_subscription_id: "sub_trial",
      tier: "pro",
      status: "trialing",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    makeClient([canceled, trialing]);

    const result = await getSubscriptionByUserId("user-1");

    expect(result!.stripe_subscription_id).toBe("sub_trial");
  });
});
