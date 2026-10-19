/**
 * Auth phase-1 (magic-link hardening):
 * - resolveEmailRedirectTo: falls back to the production studio URL when the
 *   page has no usable origin (Electron loadFile, APK WebView shell).
 * - mapOtpError: raw Supabase OTP errors → human nudges.
 * - authErrorNudge: surfaces ?error=/error_description from a clicked
 *   magic link (e.g. expired) as a human nudge.
 */
import { describe, expect, it } from "vitest";
import {
  authErrorNudge,
  mapOtpError,
  resolveEmailRedirectTo,
} from "../../src/studio/auth.js";
import { DEFAULT_GENERATOR_URL } from "../../src/runtime/splash.js";

describe("resolveEmailRedirectTo", () => {
  it("keeps a normal https origin + pathname", () => {
    expect(
      resolveEmailRedirectTo({ origin: "https://foo.bar", protocol: "https:", pathname: "/studio/" }),
    ).toBe("https://foo.bar/studio/");
  });

  it("keeps http localhost (dev flow)", () => {
    expect(
      resolveEmailRedirectTo({ origin: "http://localhost:5173", protocol: "http:", pathname: "/" }),
    ).toBe("http://localhost:5173/");
  });

  it('falls back to production on file: protocol (Electron loadFile)', () => {
    expect(
      resolveEmailRedirectTo({ origin: "null", protocol: "file:", pathname: "/dist/index.html" }),
    ).toBe(DEFAULT_GENERATOR_URL);
  });

  it('falls back to production on "null" origin (APK WebView / opaque origin)', () => {
    expect(
      resolveEmailRedirectTo({ origin: "null", protocol: "https:", pathname: "/" }),
    ).toBe(DEFAULT_GENERATOR_URL);
  });

  it("falls back to production on empty origin", () => {
    expect(resolveEmailRedirectTo({ origin: "", protocol: "https:", pathname: "/" })).toBe(
      DEFAULT_GENERATOR_URL,
    );
  });
});

describe("mapOtpError", () => {
  it("maps expired links to an expiry nudge", () => {
    expect(mapOtpError("Email link is invalid or has expired")).toMatch(/expired/i);
  });

  it("maps invalid/used links to a fresh-link nudge", () => {
    expect(mapOtpError("Invalid login credentials")).toMatch(/fresh one/i);
  });

  it("maps rate limiting to a wait nudge", () => {
    expect(mapOtpError("For security purposes, you can only request this after 30 seconds")).toMatch(
      /wait/i,
    );
  });

  it("passes unknown messages through unchanged", () => {
    expect(mapOtpError("something completely unexpected")).toBe("something completely unexpected");
  });
});

describe("authErrorNudge", () => {
  it("surfaces an expired-link redirect as a human nudge", () => {
    const nudge = authErrorNudge(
      "https://xandria.example/?error=access_denied&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(nudge).not.toBeNull();
    expect(nudge!).toMatch(/expired/i);
  });

  it("returns null when the URL carries no auth error", () => {
    expect(authErrorNudge("https://xandria.example/studio/")).toBeNull();
    expect(authErrorNudge("not a url at all")).toBeNull();
  });
});
