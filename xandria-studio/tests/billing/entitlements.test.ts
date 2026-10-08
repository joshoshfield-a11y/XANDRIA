import { describe, expect, it } from "vitest";
import {
  TIER_CAPS,
  generationsRemaining,
  monthKey,
  resolveTier,
  type Tier,
} from "../../src/billing/entitlements.js";

describe("TIER_CAPS", () => {
  it("caps match the packaging spec", () => {
    expect(TIER_CAPS).toEqual({ free: 5, hobby: 50, pro: 500 });
  });
});

describe("monthKey", () => {
  it("zero-pads months", () => {
    expect(monthKey(new Date(2026, 0, 15))).toBe("2026-01");
    expect(monthKey(new Date(2026, 9, 7))).toBe("2026-10");
  });

  it("rolls over the December -> January boundary", () => {
    expect(monthKey(new Date(2025, 11, 31, 23, 59))).toBe("2025-12");
    expect(monthKey(new Date(2026, 0, 1, 0, 0))).toBe("2026-01");
  });

  it("uses the server-local calendar month", () => {
    // last moment of Oct 31 local time is still October's bucket
    expect(monthKey(new Date(2026, 9, 30, 12, 0))).toBe("2026-10");
  });
});

describe("resolveTier", () => {
  it("returns free when there is no subscription", () => {
    expect(resolveTier(null)).toBe("free");
  });

  it.each(["active", "trialing"] as const)("grants the paid tier when status is %s", (status) => {
    expect(resolveTier({ tier: "hobby", status })).toBe("hobby");
    expect(resolveTier({ tier: "pro", status })).toBe("pro");
  });

  it.each(["canceled", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused"] as const)(
    "falls back to free when status is %s",
    (status) => {
      expect(resolveTier({ tier: "pro", status })).toBe("free");
      expect(resolveTier({ tier: "hobby", status })).toBe("free");
    },
  );

  it("falls back to free for unknown tier strings", () => {
    expect(resolveTier({ tier: "enterprise", status: "active" })).toBe("free");
    expect(resolveTier({ tier: "", status: "active" })).toBe("free");
  });

  it("the free tier row resolves to free", () => {
    expect(resolveTier({ tier: "free", status: "active" })).toBe("free");
  });
});

describe("generationsRemaining", () => {
  it("computes remaining per tier", () => {
    const tiers: Tier[] = ["free", "hobby", "pro"];
    const caps: Record<Tier, number> = { free: 5, hobby: 50, pro: 500 };
    for (const tier of tiers) {
      expect(generationsRemaining(tier, 0)).toBe(caps[tier]);
      expect(generationsRemaining(tier, 3)).toBe(caps[tier] - 3);
    }
  });

  it("never goes negative", () => {
    expect(generationsRemaining("free", 99)).toBe(0);
    expect(generationsRemaining("free", -1)).toBe(5);
  });
});
