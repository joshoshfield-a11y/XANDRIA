# XANDRIA Monetization Setup — exact user action list

The code on branch `feature/stripe-checkout` is complete and green. Nothing
bills anyone until YOU do the steps below. Do them in order.

## 1. Create a free Supabase project (your account — ~5 min)

1. Go to https://supabase.com/dashboard and sign in / sign up.
2. New project → name it `xandria`, pick any region, set a database password
   (save it somewhere safe — Supabase shows it once).
3. Wait for the project to provision (~2 min).

## 2. Create the tables

1. In the Supabase dashboard: SQL Editor → New query.
2. Paste the entire contents of `supabase/schema.sql` (repo root) and Run.
3. Confirm: Table Editor should now show `profiles`, `subscriptions`,
   `generation_counts`.

## 3. Copy three keys

Project Settings → API:
- `SUPABASE_URL` — the Project URL (https://xyzcompany.supabase.co)
- `SUPABASE_ANON_KEY` — the `anon` `public` key
- `SUPABASE_SERVICE_ROLE_KEY` — the `service_role` `secret` key.
  Treat this like a password. It goes ONLY into Vercel env vars, never the repo.

Project Settings → Authentication → URL Configuration:
- Add `https://xandria-8g3x2x35h-taylorchristian-mattheisens-projects.vercel.app`
  (and later your custom domain) to **Redirect URLs** — required for the
  magic-link sign-in to return to the site.

## 4. Add env vars in Vercel (your action)

Vercel dashboard → project `xandria` → Settings → Environment Variables.
Add all of these (Production + Preview + Development):

| Variable | Value | Where from |
|---|---|---|
| `SUPABASE_URL` | Project URL | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | anon public key | same |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role secret | same — keep secret |
| `VITE_SUPABASE_URL` | same as SUPABASE_URL | (frontend needs the VITE_ prefix) |
| `VITE_SUPABASE_ANON_KEY` | same as SUPABASE_ANON_KEY | (frontend needs the VITE_ prefix) |
| `STRIPE_SECRET_KEY` | `sk_live_...` | Stripe dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | see step 5 — add AFTER creating the webhook |

## 5. Register the Stripe webhook (your action)

1. Stripe dashboard → Developers → Webhooks → Add endpoint.
2. Endpoint URL: `https://xandria-8g3x2x35h-taylorchristian-mattheisens-projects.vercel.app/api/stripe-webhook`
   (update this if/when the production URL or custom domain changes).
3. Select events: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
4. Create → reveal the **Signing secret** → put it in Vercel as
   `STRIPE_WEBHOOK_SECRET` (step 4).

## 6. Merge + redeploy (assistant does this on your word)

1. You say "merge it".
2. Assistant merges `feature/stripe-checkout` → `main`, pushes; Vercel
   auto-deploys with the env vars from step 4.
3. Smoke test: open the site → sign in with a magic link → Pricing tab →
   Hobby button → Stripe Checkout (use a real card only when you're ready
   to sell; cancel before paying to test the cancel path).

## Testing in Stripe test mode later (optional)

If you want a full end-to-end purchase test without real money: create the
same two products in a Stripe **test-mode** account (or toggle the existing
account to test mode keys), set `STRIPE_SECRET_KEY` to the `sk_test_...`
key and re-register the webhook in test mode. The code resolves prices by
`lookup_key` (`xandria_hobby_monthly` / `xandria_pro_monthly`), so no code
changes are needed — just matching lookup keys in test mode.

## What exists in Stripe already (live, ArchitectDigitalArchitecture)

- XANDRIA Hobby — $12/mo — `price_1UOA1ABnZoiXfXg2UYh8SNnc` (lookup `xandria_hobby_monthly`), 50 generations/mo
- XANDRIA Pro — $39/mo — `price_1UOA1YBnZoiXfXg2Nr2NlUFV` (lookup `xandria_pro_monthly`), 500 generations/mo
- Free tier needs no Stripe product (5 generations/mo, enforced in-app).

## Known v1 limitations (documented in code)

- Generation cap enforcement is check-then-record (GET /api/me → generate →
  POST /api/generations). A double-submit race can over-count by 1; acceptable
  for v1, fix path is an atomic Postgres check-and-increment.
- Backend-down behavior: generation proceeds uncounted with a warning rather
  than hard-blocking (a backend outage shouldn't brick the studio).
- Steam export is a single-file `*-steam.html` + depot instructions — no real
  Steamworks packaging yet. API access button is a gated placeholder.
