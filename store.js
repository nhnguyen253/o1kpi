/**
 * Data layer: load, save, auth, realtime.
 *
 * Two modes, chosen automatically:
 *
 *   supabase — config.js is filled in. Shared state, magic-link auth, live
 *              updates across open tabs, optimistic concurrency on save.
 *   local    — config.js still has placeholders. Seeds from data/seed.json and
 *              saves to localStorage. Nothing is shared; the header says so.
 *              Lets the whole UI be reviewed before the backend exists.
 *
 * Concurrency: os_state carries an integer `version`. A save matches on the
 * version it loaded; zero rows updated means someone else saved first, so we
 * surface a conflict instead of silently clobbering their work.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';

const LOCAL_KEY = 'o1kpi_local_db_v2';

export const store = {
  mode: 'local',
  db: null,
  version: 0,
  user: null,
  canEdit: false,
  lastError: null,
  _client: null,
  _listeners: new Set(),
};

export function onChange(fn) {
  store._listeners.add(fn);
  return () => store._listeners.delete(fn);
}
function emit(reason) {
  store._listeners.forEach((fn) => {
    try { fn(reason); } catch (e) { console.error('listener failed', e); }
  });
}

async function fetchSeed() {
  const res = await fetch('./data/seed.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not load data/seed.json (${res.status})`);
  return res.json();
}

// ------------------------------------------------------------------ init

export async function init() {
  if (!isConfigured()) return initLocal('config.js has no Supabase credentials yet');

  if (!window.supabase?.createClient) {
    return initLocal('the Supabase client script did not load');
  }

  try {
    store._client = window.supabase.createClient(SUPABASE_URL.replace(/\/$/, ''), SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    store.mode = 'supabase';

    const { data: sessionData } = await store._client.auth.getSession();
    await applySession(sessionData?.session ?? null);

    store._client.auth.onAuthStateChange(async (_event, session) => {
      await applySession(session);
      emit('auth');
    });

    await load();
    subscribeRealtime();
    emit('init');
    return store;
  } catch (e) {
    console.error(e);
    return initLocal(`Supabase failed to initialise (${e.message})`);
  }
}

async function initLocal(reason) {
  store.mode = 'local';
  store.lastError = reason;
  store.canEdit = true; // local mode is your own browser; editing is the point
  const cached = localStorage.getItem(LOCAL_KEY);
  if (cached) {
    try {
      store.db = JSON.parse(cached);
      emit('init');
      return store;
    } catch { /* fall through to seed */ }
  }
  store.db = await fetchSeed();
  emit('init');
  return store;
}

async function applySession(session) {
  // No allowlist: any signed-in user may edit. RLS enforces the same rule
  // server-side, so this flag only decides whether to show the controls.
  store.user = session?.user ?? null;
  store.canEdit = !!store.user;
}

// ------------------------------------------------------------------ load

export async function load() {
  if (store.mode === 'local') return store.db;

  const { data, error } = await store._client
    .from('os_state')
    .select('data, version, updated_at, updated_by')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    store.lastError = error.message;
    if (!store.db) store.db = await fetchSeed();
    return store.db;
  }

  const empty = !data || !data.data || !Array.isArray(data.data.nodes);
  if (empty) {
    // Fresh project: show the seed. It is written back on the first save by a
    // signed-in user, so an anonymous visitor never bootstraps the row.
    store.db = await fetchSeed();
    store.version = data?.version ?? 1;
    store.lastError = 'Database is empty — showing the bundled seed. Sign in and save to publish it.';
    return store.db;
  }

  store.db = data.data;
  store.version = data.version;
  store.db.meta = { ...(store.db.meta ?? {}), updated_at: data.updated_at, updated_by: data.updated_by };
  store.lastError = null;
  return store.db;
}

// ------------------------------------------------------------------ save

/**
 * @returns {{ok: true} | {ok: false, conflict?: true, message: string}}
 */
export async function save(auditEntries = []) {
  store.db.meta = store.db.meta ?? {};
  store.db.meta.updated_at = new Date().toISOString();

  if (store.mode === 'local') {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(store.db));
    emit('save');
    return { ok: true };
  }

  if (!store.canEdit) {
    return { ok: false, message: 'Sign in to save changes.' };
  }

  store.db.meta.updated_by = store.user?.email ?? null;

  const { data, error } = await store._client
    .from('os_state')
    .update({
      data: store.db,
      version: store.version + 1,
      updated_at: store.db.meta.updated_at,
      updated_by: store.user?.email ?? null,
    })
    .eq('id', 1)
    .eq('version', store.version)   // <- the concurrency guard
    .select('version');

  if (error) return { ok: false, message: error.message };

  if (!data || data.length === 0) {
    // Either someone else saved first, or RLS rejected the write. Distinguish
    // them, because "nothing happened" is the worst possible feedback here.
    const { data: current } = await store._client
      .from('os_state').select('version, updated_by').eq('id', 1).maybeSingle();
    if (current && current.version !== store.version) {
      return {
        ok: false,
        conflict: true,
        message: `${current.updated_by || 'Someone'} saved changes since you opened this page.`,
      };
    }
    return { ok: false, message: 'Write rejected by the database. Is your session still valid?' };
  }

  store.version = data[0].version;
  if (auditEntries.length) writeAudit(auditEntries);
  emit('save');
  return { ok: true };
}

function writeAudit(entries) {
  const actor = store.user?.email ?? 'unknown';
  store._client
    .from('os_audit')
    .insert(entries.map((e) => ({ ...e, actor })))
    .then(({ error }) => { if (error) console.warn('audit write failed', error.message); });
}

// ------------------------------------------------------------------ realtime

function subscribeRealtime() {
  store._client
    .channel('os_state_changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'os_state' }, (payload) => {
      const incoming = payload.new;
      if (!incoming || incoming.version === store.version) return;
      store.db = incoming.data;
      store.version = incoming.version;
      emit('remote');
    })
    .subscribe();
}

// ------------------------------------------------------------------ auth

export async function signIn(email) {
  if (store.mode === 'local') return { ok: false, message: 'Local mode — no sign-in needed.' };
  const { error } = await store._client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: window.location.href.split('#')[0] },
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}

export async function signOut() {
  if (store.mode === 'supabase') await store._client.auth.signOut();
  store.user = null;
  store.canEdit = false;
  emit('auth');
}

export async function recentAudit(limit = 50) {
  if (store.mode === 'local') return [];
  const { data, error } = await store._client
    .from('os_audit').select('*').order('at', { ascending: false }).limit(limit);
  return error ? [] : data;
}

export function resetLocal() {
  localStorage.removeItem(LOCAL_KEY);
}
