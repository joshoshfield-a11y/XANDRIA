/**
 * Creator/admin bypass for generation quota.
 *
 * ADMIN_EMAILS: comma-separated allowlist, e.g. "a@x.com, b@y.com".
 * Read lazily on every call (not at module load) so serverless instances
 * pick up env changes and unit tests can vary it per case.
 *
 * Checked at the quota enforcement point (api/generations.ts) and the
 * entitlement snapshot (api/me.ts). The list is never sent to the client.
 */

/** True when `email` is on the ADMIN_EMAILS allowlist (case-insensitive,
 *  whitespace-tolerant). Missing/empty env var → no admins. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return admins.has(email.trim().toLowerCase());
}
