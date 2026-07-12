create table if not exists public.ghl_oauth_onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  company_id text not null,
  access_token text,
  status text not null default 'active'
    check (status in ('active', 'expired', 'failed')),
  expires_at timestamptz not null,
  last_reconciled_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, company_id)
);

drop trigger if exists set_ghl_oauth_onboarding_sessions_updated_at
  on public.ghl_oauth_onboarding_sessions;
create trigger set_ghl_oauth_onboarding_sessions_updated_at
before update on public.ghl_oauth_onboarding_sessions
for each row execute function public.set_updated_at();

create table if not exists public.ghl_pending_app_installs (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  company_id text not null,
  location_id text not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  delivery_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  processing_started_at timestamptz,
  completed_at timestamptz,
  completed_session_id uuid references public.ghl_oauth_onboarding_sessions(id) on delete set null,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, company_id, location_id)
);

drop trigger if exists set_ghl_pending_app_installs_updated_at
  on public.ghl_pending_app_installs;
create trigger set_ghl_pending_app_installs_updated_at
before update on public.ghl_pending_app_installs
for each row execute function public.set_updated_at();

create index if not exists ghl_pending_app_installs_reconcile_idx
  on public.ghl_pending_app_installs (app_id, company_id, status, updated_at);

alter table public.ghl_oauth_onboarding_sessions enable row level security;
alter table public.ghl_pending_app_installs enable row level security;

revoke all on table public.ghl_oauth_onboarding_sessions from anon, authenticated;
revoke all on table public.ghl_pending_app_installs from anon, authenticated;

comment on table public.ghl_oauth_onboarding_sessions is
  'Short-lived server-only Company OAuth credentials used only to create exact location-scoped tokens.';
comment on column public.ghl_oauth_onboarding_sessions.access_token is
  'Sensitive short-lived Company access token. Never return or log this value; clear it when expired.';
comment on table public.ghl_pending_app_installs is
  'Idempotent correlation records for exact HighLevel AppInstall locations.';
