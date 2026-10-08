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
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
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

/**
 * Send a magic-link sign-in email. The link redirects back to the studio
 * (query params stripped so a ?checkout=... return doesn't re-fire toasts).
 */
export async function signInWithOtp(email: string): Promise<OtpResult> {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: 'billing is not configured' };
  const redirectTo = `${location.origin}${location.pathname}`;
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
