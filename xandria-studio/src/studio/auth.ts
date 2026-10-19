/**
 * Supabase auth for XANDRIA Studio billing.
 *
 * Email magic-link sign-in; the JWT is then used as the Bearer token for
 * the billing API (/api/me, /api/generations, /api/checkout).
 *
 * If VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are absent, every function
 * degrades to a no-op returning null/false and the studio runs exactly as
 * before billing existed (launch build keeps working).
 */
import { createClient } from '@supabase/supabase-js';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { DEFAULT_GENERATOR_URL } from '../runtime/splash';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || undefined;
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || undefined;

/** True when billing is configured. When false, all billing UI hides/disables. */
export function isBillingEnabled(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

let client: SupabaseClient | null = null;

/** Lazily-created client, or null when billing is not configured. */
export function getSupabase(): SupabaseClient | null {
  if (!isBillingEnabled()) {
    if (typeof console !== 'undefined') {
      console.info('[xandria] billing disabled: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set');
    }
    return null;
  }
  if (!client) {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: {
        // Pin PKCE explicitly — never rely on the implicit default. If the
        // Supabase project ever serves PKCE `?code=` email links, an implicit
        // client throws AuthInvalidGrantRedirectError on every magic-link
        // click (total sign-in breakage, no useful UI message).
        //
        // Dashboard checklist (Supabase → Authentication → URL Configuration):
        //   - Site URL = the production studio origin
        //     (https://xandria-taylorchristian-mattheisens-projects.vercel.app)
        //   - Redirect URLs must include the production origin plus any
        //     preview origins used for testing (Vercel preview deploys get
        //     their own URL each time).
        //   - If magic-link clicks start failing, check Email provider →
        //     "Confirm email" / link-expiry settings there too.
        flowType: 'pkce',
      },
    });
  }
  return client;
}

export async function getSession(): Promise<Session | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.auth.getSession();
  if (error) {
    console.warn('[xandria] getSession failed:', error.message);
    return null;
  }
  return data.session;
}

export async function getUser(): Promise<User | null> {
  const s = await getSession();
  return s?.user ?? null;
}

/** Bearer token for the billing API, or null when signed out / unconfigured. */
export async function getAccessToken(): Promise<string | null> {
  const s = await getSession();
  return s?.access_token ?? null;
}

export type OtpResult = { ok: true } | { ok: false; error: string };

/** Minimal location shape needed to build the magic-link return URL. */
export interface RedirectLocation {
  origin: string;
  protocol: string;
  pathname: string;
}

/**
 * Build `emailRedirectTo` for signInWithOtp.
 *
 * Pure (takes the location as a param) so it's unit-testable.
 *
 * Outside a real https page the origin is garbage: Electron loads via
 * loadFile (`location.origin === "null"`, `protocol === "file:"`) and the
 * Android APK WebView shell has the same problem. Supabase can't redirect
 * back to those (and they can't be whitelisted in the dashboard), so fall
 * back to the production studio URL instead of sending a dead redirect.
 * Query params are stripped so a ?checkout=... return doesn't re-fire toasts.
 */
export function resolveEmailRedirectTo(loc: RedirectLocation): string {
  if (loc.protocol === 'file:' || loc.origin === 'null' || !loc.origin) {
    return DEFAULT_GENERATOR_URL;
  }
  return `${loc.origin}${loc.pathname}`;
}

/**
 * Send a magic-link sign-in email. The link redirects back to the studio
 * (query params stripped so a ?checkout=... return doesn't re-fire toasts).
 */
export async function signInWithOtp(email: string): Promise<OtpResult> {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: 'billing is not configured' };
  const redirectTo = resolveEmailRedirectTo(location);
  const { error } = await sb.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: redirectTo },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.auth.signOut();
  if (error) console.warn('[xandria] signOut failed:', error.message);
}

/**
 * Subscribe to auth state changes (sign-in via magic link, sign-out).
 * Returns an unsubscribe function.
 */
export function onAuthChange(cb: (session: Session | null) => void): () => void {
  const sb = getSupabase();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

/**
 * Map a raw Supabase OTP/magic-link error to a human nudge. Pure.
 * Unknown messages pass through unchanged (rendered escaped by the caller).
 */
export function mapOtpError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('expir')) {
    return 'That sign-in link expired — links only last a little while. Request a fresh one below.';
  }
  if (m.includes('invalid') || m.includes('not found') || m.includes('already used')) {
    return "That sign-in link didn't work — request a fresh one below.";
  }
  if (m.includes('rate limit') || m.includes('too many') || m.includes('after ') && m.includes('second')) {
    return 'Too many attempts — wait a minute, then try again.';
  }
  return message;
}

/**
 * If `url` carries a Supabase auth failure (`?error=…&error_description=…`,
 * e.g. after clicking an expired magic link), return the human nudge for it.
 * Null when there's nothing to surface. Pure — pass `location.href`.
 */
export function authErrorNudge(url: string): string | null {
  let err: string | null = null;
  let desc: string | null = null;
  try {
    const u = new URL(url);
    err = u.searchParams.get('error') ?? new URLSearchParams(u.hash.replace(/^#/, '')).get('error');
    desc = u.searchParams.get('error_description') ?? new URLSearchParams(u.hash.replace(/^#/, '')).get('error_description');
  } catch {
    return null;
  }
  if (!err && !desc) return null;
  return mapOtpError(desc ? desc.replace(/\+/g, ' ') : err!);
}
