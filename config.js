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
export const SUPABASE_URL = 'PASTE_YOUR_SUPABASE_URL_HERE';
export const SUPABASE_ANON_KEY = 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';

export const isConfigured = () =>
  /^https:\/\/.+\.supabase\.co\/?$/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 40;
