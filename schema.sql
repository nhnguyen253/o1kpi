-- o1kpi — Supabase schema.
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- Security model: the page is public and ships the anon key, so READS are open
-- (this was an explicit decision). WRITES are restricted to signed-in users
-- whose email appears in allowed_editors. RLS is the only thing standing
-- between the public anon key and your KPI data — do not disable it.

-- ---------------------------------------------------------------- state

create table if not exists os_state (
  id         int primary key default 1,
  data       jsonb       not null,
  version    bigint      not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint os_state_singleton check (id = 1)
);

-- ---------------------------------------------------------------- editors

create table if not exists allowed_editors (
  email      text primary key,
  note       text,
  added_at   timestamptz not null default now()
);

-- Seed with the team. Emails must match how each person signs in, lowercased.
-- insert into allowed_editors (email, note) values
--   ('nhnguyen@uchicago.edu', 'Nam'),
--   ('...', 'Ethan'),
--   ('...', 'Isaiah'),
--   ('...', 'Saif / LFG'),
--   ('...', 'Asad')
-- on conflict (email) do nothing;

create or replace function is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from allowed_editors
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------- audit

create table if not exists os_audit (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  actor     text,
  node_id   text,
  node_title text,
  field     text,
  old_value text,
  new_value text
);

create index if not exists os_audit_at_idx on os_audit (at desc);

-- ---------------------------------------------------------------- RLS

alter table os_state        enable row level security;
alter table allowed_editors enable row level security;
alter table os_audit        enable row level security;

-- Public read. To make the dashboard private later, change `to anon,
-- authenticated` to `to authenticated` on these two policies and redeploy
-- nothing — it takes effect immediately.
drop policy if exists os_state_read on os_state;
create policy os_state_read on os_state
  for select to anon, authenticated using (true);

drop policy if exists os_audit_read on os_audit;
create policy os_audit_read on os_audit
  for select to anon, authenticated using (true);

-- Writes: allowlisted editors only.
drop policy if exists os_state_write on os_state;
create policy os_state_write on os_state
  for update to authenticated using (is_editor()) with check (is_editor());

drop policy if exists os_audit_write on os_audit;
create policy os_audit_write on os_audit
  for insert to authenticated with check (is_editor());

-- Nobody edits the allowlist from the browser; manage it here in the
-- dashboard. Editors may read it so the UI can show who has access.
drop policy if exists allowed_editors_read on allowed_editors;
create policy allowed_editors_read on allowed_editors
  for select to authenticated using (is_editor());

-- No insert/update/delete policy on allowed_editors == no client can change it.

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table os_state;

-- ---------------------------------------------------------------- bootstrap
-- Paste the contents of data/seed.json in place of '{}' for the first load,
-- or just leave it: the app seeds this row from data/seed.json on first run
-- when an allowlisted editor signs in.

insert into os_state (id, data, version)
values (1, '{}'::jsonb, 1)
on conflict (id) do nothing;
