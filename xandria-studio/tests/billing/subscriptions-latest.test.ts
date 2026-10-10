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
 * and .limit(1) the way PostgREST would, and records the call sequence so
 * the test can assert the query shape (latest-row selection).
 */
function makeClient(rows: SubscriptionRow[]): { calls: string[] } {
  const calls: string[] = [];
  let orderCol: string | null = null;
  let orderAsc = true;
  let limit: number | null = null;
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
  (chain as { limit: (n: number) => unknown }).limit = (n: number) => {
    calls.push(`limit:${n}`);
    limit = n;
    return chain;
  };
  (chain as { maybeSingle: () => Promise<unknown> }).maybeSingle = async () => {
    let out = [...rows];
    if (orderCol === "updated_at") {
      out.sort((a, b) =>
        orderAsc
          ? a.updated_at.localeCompare(b.updated_at)
          : b.updated_at.localeCompare(a.updated_at),
      );
    }
    if (limit !== null) out = out.slice(0, limit);
    return { data: out[0] ?? null, error: null };
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
    // Latest-row query shape (not .maybeSingle() on an unordered multi-row result).
    expect(calls).toContain("order:updated_at:false");
    expect(calls).toContain("limit:1");
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
