/**
 * Admin quota bypass (creator unlimited generations):
 * - isAdminEmail: case-insensitive, whitespace-tolerant, empty env → no admins.
 * - POST /api/generations: an ADMIN_EMAILS user at the tier cap gets 200
 *   (with unlimited:true) instead of 429 — while the counter still increments.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAdminEmail } from "../../api/_lib/admin.js";
import handler from "../../api/generations.js";

const ENV_KEY = "ADMIN_EMAILS";
const ORIGINAL_ENV = process.env[ENV_KEY];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

function setAdmins(v: string | undefined) {
  if (v === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = v;
}

describe("isAdminEmail", () => {
  it("matches case-insensitively", () => {
    setAdmins("Boss@Xandria.Dev");
    expect(isAdminEmail("boss@xandria.dev")).toBe(true);
    expect(isAdminEmail("BOSS@XANDRIA.DEV")).toBe(true);
  });

  it("trims whitespace around entries and the input", () => {
    setAdmins("  a@x.com ,b@y.com  ");
    expect(isAdminEmail("a@x.com")).toBe(true);
    expect(isAdminEmail("  b@y.com ")).toBe(true);
  });

  it("missing or empty env means no admins", () => {
    setAdmins(undefined);
    expect(isAdminEmail("boss@xandria.dev")).toBe(false);
    setAdmins("");
    expect(isAdminEmail("boss@xandria.dev")).toBe(false);
    setAdmins("   ,  ");
    expect(isAdminEmail("boss@xandria.dev")).toBe(false);
  });

  it("rejects null/undefined emails and non-listed addresses", () => {
    setAdmins("boss@xandria.dev");
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
    expect(isAdminEmail("someone@else.com")).toBe(false);
    // Substring must not match: the allowlist is exact emails only.
    expect(isAdminEmail("boss@xandria.dev.evil.com")).toBe(false);
  });
});

// --- generations handler: admin skip ---

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

function makeDb(count: number | null) {
  const calls: Array<{ table: string; op: string; row?: unknown }> = [];
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
  const res = {
    statusCode: 0,
    setHeader() {},
    end(b: string) {
      body = b;
    },
  } as unknown as ServerResponse;
  const req = { method: "POST", headers: {} } as IncomingMessage;
  return { req, res, parsedBody: () => JSON.parse(body) as Record<string, unknown> };
}

describe("POST /api/generations admin bypass", () => {
  it("200 + unlimited:true for an admin at the free cap (counter still increments)", async () => {
    setAdmins("boss@xandria.dev");
    mockRequireUser.mockResolvedValue({ id: "user-1", email: "Boss@Xandria.Dev" });
    mockGetSubscriptionByUserId.mockResolvedValue(null); // free tier, cap 5
    const { client, calls } = makeDb(5); // already at cap
    mockGetServerClient.mockReturnValue(client);

    const { req, res, parsedBody } = makeReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = parsedBody();
    expect(body.unlimited).toBe(true);
    expect(body.remaining).toBeNull();
    expect(body.used).toBe(6);
    // The counter still increments for admins — usage stays visible.
    expect(calls.some((c) => c.table === "generation_counts" && c.op === "upsert")).toBe(true);
  });

  it("control: same user at cap without the allowlist still gets 429", async () => {
    setAdmins("");
    mockRequireUser.mockResolvedValue({ id: "user-1", email: "boss@xandria.dev" });
    mockGetSubscriptionByUserId.mockResolvedValue(null);
    const { client } = makeDb(5);
    mockGetServerClient.mockReturnValue(client);

    const { req, res, parsedBody } = makeReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    expect(parsedBody().error).toBe("quota_exceeded");
  });
});
