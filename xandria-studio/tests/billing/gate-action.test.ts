/**
 * Regression tests for M-1 (fail-closed gate policy):
 * every gate failure — including 'unavailable' (backend unreachable for a
 * signed-in user) — must BLOCK generation. Warn-and-proceed was a one-click
 * quota bypass (DevTools network blocking) once the server enforces quota.
 */
import { describe, expect, it } from "vitest";
import { decideGateAction } from "../../src/studio/billing.js";

describe("decideGateAction fail-closed policy (M-1)", () => {
  it("blocks when the backend is unreachable for a signed-in user", () => {
    const action = decideGateAction({ ok: false, reason: "unavailable" }, "hobby");
    expect(action.proceed).toBe(false);
    expect(action.nudge).toBeTruthy();
    expect(action.focusSignin).toBe(false);
    expect(action.showPricing).toBe(false);
  });

  it("proceeds when the gate passes", () => {
    const action = decideGateAction({ ok: true }, "free");
    expect(action).toEqual({ proceed: true, nudge: null, focusSignin: false, showPricing: false });
  });

  it("blocks with sign-in nudge and focuses the email field when signed out", () => {
    const action = decideGateAction({ ok: false, reason: "signin" }, null);
    expect(action.proceed).toBe(false);
    expect(action.focusSignin).toBe(true);
    expect(action.showPricing).toBe(false);
    expect(action.nudge).toContain("Sign in");
  });

  it("blocks with upgrade nudge and shows pricing when over quota", () => {
    const action = decideGateAction({ ok: false, reason: "limit" }, "free");
    expect(action.proceed).toBe(false);
    expect(action.focusSignin).toBe(false);
    expect(action.showPricing).toBe(true);
    expect(action.nudge).toContain("Upgrade");
  });
});
