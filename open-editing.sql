-- Drop the editor allowlist: anyone SIGNED IN can edit.
-- Paste into Supabase -> SQL Editor -> New query -> Run. Takes effect immediately;
-- no redeploy needed.

-- Writes now require only a verified session, not allowlist membership.
drop policy if exists os_state_write on os_state;
create policy os_state_write on os_state
  for update to authenticated using (true) with check (true);

drop policy if exists os_audit_write on os_audit;
create policy os_audit_write on os_audit
  for insert to authenticated with check (true);

-- The allowlist table and helper are no longer consulted by any policy.
-- Kept (not dropped) so you can re-enable in one step if this gets abused:
--
--   drop policy if exists os_state_write on os_state;
--   create policy os_state_write on os_state
--     for update to authenticated using (is_editor()) with check (is_editor());
--
drop policy if exists allowed_editors_read on allowed_editors;
create policy allowed_editors_read on allowed_editors
  for select to authenticated using (true);
