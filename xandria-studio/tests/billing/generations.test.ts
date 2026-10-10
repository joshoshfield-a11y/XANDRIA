/**
 * Regression tests for H-1 (server-side quota enforcement):
 * POST /api/generations must reject with 429 when the caller's tier cap is
 * reached — BEFORE incrementing — instead of recording unconditionally.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import handler from "../../api/generations.js";
import type { SubscriptionRow } from "../../api/_lib/subscriptions.js";

const { mockRequireUser, mockGetServerClient, mockGetSubscriptionByUserId, mockUpsertProfile } =
  vi.hoisted(() => ({
    mockRequireUser: vi.fn(),
    mockGetServerClient: vi.fn(),
    mockGetSubscriptionByUserId: vi.fn(),
    mockUpsertProfile: vi.fn(),
  }));

vi.mock("../../api/_lib/supabase.js", () => ({
  requireUser: mockRequireUser,
  getServerClient: mockGetServerClient,
}));

vi.mock("../../api/_lib/subscriptions.js", () => ({
  SupabaseBillingStore: class {
    upsertProfile = mockUpsertProfile;
  },
  getSubscriptionByUserId: mockGetSubscriptionByUserId,
}));

interface DbCall {
  table: string;
  op: string;
  row?: unknown;
}

/** Fake Supabase client: generation_counts reads return `count`; upserts are recorded. */
function makeDb(count: number | null): { client: unknown; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  (chain as { maybeSingle: () => Promise<unknown> }).maybeSingle = async () => ({
    data: count === null ? null : { count },
    error: null,
  });
  const client = {
    from: (table: string) => ({
      select: () => chain,
      upsert: async (row: unknown) => {
        calls.push({ table, op: "upsert", row });
        return { error: null };
      },
    }),
  };
  return { client, calls };
}

function makeReqRes() {
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    headers,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end(b: string) {
      body = b;
    },
  } as unknown as ServerResponse;
  const req = { method: "POST", headers: {} } as IncomingMessage;
  return { req, res, parsedBody: () => JSON.parse(body) as Record<string, unknown> };
}

function activeSub(tier: "hobby" | "pro"): SubscriptionRow {
  return {
    user_id: "user-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    tier,
    status: "active",
    current_period_end: null,
    updated_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: "user-1", email: "a@b.c" });
  mockUpsertProfile.mockResolvedValue(undefined);
});

describe("POST /api/generations quota enforcement (H-1)", () => {
  it("rejects 429 without incrementing when a free user is at cap", async () => {
    const { client, calls } = makeDb(5);
    mockGetServerClient.mockReturnValue(client);
    mockGetSubscriptionByUserId.mockResolvedValue(null); // free tier

    const { req, res, parsedBody } = makeReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    expect(parsedBody().error).toBe("quota_exceeded");
    expect(parsedBody().tier).toBe("free");
    // No generation_counts write happened.
    expect(calls.filter((c) => c.table === "generation_counts")).toHaveLength(0);
  });

  it("records and returns remaining when under cap", async () => {
    const { client, calls } = makeDb(3);
    mockGetServerClient.mockReturnValue(client);
    mockGetSubscriptionByUserId.mockResolvedValue(null); // free tier, cap 5

    const { req, res, parsedBody } = makeReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const writes = calls.filter((c) => c.table === "generation_counts");
    expect(writes).toHaveLength(1);
    expect((writes[0].row as { count: number }).count).toBe(4);
    expect(parsedBody().used).toBe(4);
    expect(parsedBody().remaining).toBe(1);
  });

  it("enforces the paid tier cap, not the free cap", async () => {
    // Hobby user at 50/50 → rejected.
    {
      const { client } = makeDb(50);
      mockGetServerClient.mockReturnValue(client);
      mockGetSubscriptionByUserId.mockResolvedValue(activeSub("hobby"));
      const { req, res, parsedBody } = makeReqRes();
      await handler(req, res);
      expect(res.statusCode).toBe(429);
      expect(parsedBody().tier).toBe("hobby");
    }
    // Same user at 49/50 → recorded.
    {
      const { client, calls } = makeDb(49);
      mockGetServerClient.mockReturnValue(client);
      mockGetSubscriptionByUserId.mockResolvedValue(activeSub("hobby"));
      const { req, res, parsedBody } = makeReqRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(parsedBody().remaining).toBe(0);
      expect(calls.filter((c) => c.table === "generation_counts")).toHaveLength(1);
    }
  });

  it("401s when unauthenticated", async () => {
    mockRequireUser.mockResolvedValue(null);
    const { client } = makeDb(0);
    mockGetServerClient.mockReturnValue(client);
    const { req, res } = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});
