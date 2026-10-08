import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { IncomingMessage } from "node:http";
import { serverEnv } from "./http.js";

/**
 * Server-side Supabase client using the SERVICE ROLE key.
 * Service role bypasses RLS, so all DB writes go through this client.
 * Never expose this client (or the key) to the browser.
 */
let cached: SupabaseClient | null = null;

export function getServerClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(serverEnv("SUPABASE_URL"), serverEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

export interface AuthUser {
  id: string;
  email: string | null;
}

/**
 * Verify the Supabase JWT from `Authorization: Bearer <token>`.
 * Returns the user on success, null when the header is missing/malformed
 * or the token fails verification (expired, wrong secret, etc.).
 */
export async function requireUser(req: IncomingMessage): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  const { data, error } = await getServerClient().auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
