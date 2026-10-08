-- XANDRIA billing schema.
-- Apply once in the Supabase SQL editor (or as a migration). Safe to re-run.
--
-- Tables:
--   profiles           one row per auth user (lazy-created by the api/ functions)
--   subscriptions      one row per Stripe subscription, keyed by stripe_subscription_id
--   generation_counts  per-user monthly generation usage, keyed by (user_id, month)
--
-- All server writes go through the api/ functions using the SERVICE ROLE key,
-- which bypasses RLS. Authenticated clients may only SELECT their own rows.

-- ---------------------------------------------------------------- profiles
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------- subscriptions
create table if not exists subscriptions (
  user_id uuid not null references profiles (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  tier text not null default 'free' check (tier in ('free', 'hobby', 'pro')),
  status text not null default 'active',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx
  on subscriptions (user_id);

-- ------------------------------------------------------- generation_counts
create table if not exists generation_counts (
  user_id uuid not null references profiles (id) on delete cascade,
  month text not null,          -- "YYYY-MM", see src/billing/entitlements.ts monthKey()
  count integer not null default 0,
  primary key (user_id, month)
);

-- --------------------------------------------------------------------- RLS
alter table profiles enable row level security;
alter table subscriptions enable row level security;
alter table generation_counts enable row level security;

drop policy if exists "users can read own profile" on profiles;
create policy "users can read own profile"
  on profiles for select to authenticated
  using (auth.uid() = id);

drop policy if exists "users can read own subscription" on subscriptions;
create policy "users can read own subscription"
  on subscriptions for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users can read own generation counts" on generation_counts;
create policy "users can read own generation counts"
  on generation_counts for select to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for `authenticated`: writes happen only
-- through the server-side api/ functions with the service role key.
