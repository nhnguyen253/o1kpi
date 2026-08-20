/**
 * Data layer: load, save, realtime.
 *
 * Two modes, chosen automatically:
 *
 *   supabase — config.js is filled in. Shared state, live updates across open
 *              tabs, optimistic concurrency on save.
 *   local    — config.js still has placeholders. Seeds from data/seed.json and
 *              saves to localStorage. Nothing is shared; the header says so.
 *
 * There is deliberately NO sign-in: anyone who opens the page can edit, and the
 * RLS policies grant write access to the anon role to match (anon-editing.sql).
 * In place of an authenticated identity, each browser picks a name once — see
 * `actor` below — which is recorded as the author of every change. That is a
 * courtesy label, not a credential; it is self-asserted and trivially faked.
 *
 * Concurrency: os_state carries an integer `version`. A save matches on the
 * version it loaded; zero rows updated means someone else saved first, so we
 * surface a conflict instead of silently clobbering their work.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';

const LOCAL_KEY = 'o1kpi_local_db_v2';
const ACTOR_KEY = 'o1kpi_actor';

export const store = {
  mode: 'local',
  db: null,
  version: 0,
  actor: localStorage.getItem(ACTOR_KEY) || '',
  canEdit: true,          // no sign-in; everyone can edit
  lastError: null,
  _client: null,
  _listeners: new Set(),
};

/** Remember who is using this browser, for the change log. */
export function setActor(name) {
  store.actor = (name || '').trim();
  if (store.actor) localStorage.setItem(ACTOR_KEY, store.actor);
  else localStorage.removeItem(ACTOR_KEY);
  emit('actor');
}

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
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    store.mode = 'supabase';

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
    store.lastError = 'Database is empty — showing the bundled seed. Save any node to publish it.';
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

  store.db.meta.updated_by = store.actor || 'anonymous';

  const { data, error } = await store._client
    .from('os_state')
    .update({
      data: store.db,
      version: store.version + 1,
      updated_at: store.db.meta.updated_at,
      updated_by: store.db.meta.updated_by,
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
    return {
      ok: false,
      message: 'The database rejected the write. Has anon-editing.sql been run on this project?',
    };
  }

  store.version = data[0].version;
  if (auditEntries.length) writeAudit(auditEntries);
  emit('save');
  return { ok: true };
}

function writeAudit(entries) {
  const actor = store.actor || 'anonymous';
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

export async function recentAudit(limit = 50) {
  if (store.mode === 'local') return [];
  const { data, error } = await store._client
    .from('os_audit').select('*').order('at', { ascending: false }).limit(limit);
  return error ? [] : data;
}

export function resetLocal() {
  localStorage.removeItem(LOCAL_KEY);
}
