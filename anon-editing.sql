-- Open editing to everyone: no sign-in at all.
-- Paste into Supabase -> SQL Editor -> New query -> Run.
--
-- This grants WRITE access to the `anon` role. The anon key ships in the public
-- page, so this means anyone on the internet who finds the URL can change or
-- erase the KPI data, and no author is recorded beyond a self-selected name.
-- That is the intended trade here: five people, low stakes, zero friction.
--
-- Mitigations that remain: os_state.version increments on every write, and
-- os_audit keeps an append-only log, so damage is visible and reversible from
-- a backup. Use the Backup button periodically.
--
-- To undo, see revoke-anon-editing.sql.

drop policy if exists os_state_write on os_state;
create policy os_state_write on os_state
  for update to anon, authenticated using (true) with check (true);

drop policy if exists os_audit_write on os_audit;
create policy os_audit_write on os_audit
  for insert to anon, authenticated with check (true);
