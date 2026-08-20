/**
 * Supabase connection settings.
 *
 * These two values are PUBLISHABLE — the anon key is designed to ship in a
 * public page. Row Level Security (see schema.sql) is what actually protects
 * the data, not the secrecy of this key. Never put the `service_role` key here.
 *
 * Find both under: Supabase Dashboard -> Project Settings -> API
 *   SUPABASE_URL      = "Project URL"
 *   SUPABASE_ANON_KEY = "anon / public" key
 *
 * Left as placeholders, the app runs in LOCAL MODE: it loads data/seed.json,
 * saves to this browser's localStorage only, and says so in the header. That
 * makes the whole UI reviewable before the backend exists.
 */
export const SUPABASE_URL = 'https://ggiodubaxzeoemgdjpxd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnaW9kdWJheHplb2VtZ2RqcHhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNTYxMTIsImV4cCI6MjEwMjgzMjExMn0.oUJo07mAL5mfAT2rHx-6zWlvOAJAW9iIKa-tcrBdjAM';

export const isConfigured = () =>
  /^https:\/\/.+\.supabase\.co\/?$/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 40;
