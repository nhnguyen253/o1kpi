-- Undo anon-editing.sql: require a signed-in user again.
-- Paste into Supabase -> SQL Editor -> New query -> Run.
-- The app's sign-in UI was removed, so restore it from git history if you run
-- this (commit "db stuff" and earlier still carry it).

drop policy if exists os_state_write on os_state;
create policy os_state_write on os_state
  for update to authenticated using (true) with check (true);

drop policy if exists os_audit_write on os_audit;
create policy os_audit_write on os_audit
  for insert to authenticated with check (true);

-- Stricter still — named allowlist only (allowed_editors + is_editor() survive
-- in schema.sql for exactly this):
--
--   create policy os_state_write on os_state
--     for update to authenticated using (is_editor()) with check (is_editor());
