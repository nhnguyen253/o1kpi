/**
 * Accountability tracker — rendering and editing.
 *
 * Mounted by app.js, which hands in its drawer, banner and escape helpers so
 * this module never has to import app.js back. Pure logic lives in tracker.js.
 *
 * Every edit goes through `commit()`, which re-finds its target by id inside
 * the *current* store.db before mutating. That is deliberate: a realtime update
 * replaces store.db wholesale, so a reference captured when a drawer opened can
 * point at a copy that is no longer saved anywhere.
 */
import { store, save } from './store.js';
import { buildTree } from './rollup.js';
import {
  STATUSES, STATUS_LABEL, localDate, parseDate, daysBetween, addDays, weekBounds,
  isDone, isOpen, isOverdue, applyStatus, index, projectsIn, filterTasks, sortByDue,
  bucketByDue, overdueByOwner, blockedByDependency, weeklyRollup, weeklyByOwner,
  validateTracker,
} from './tracker.js';

const PREFS_KEY = 'o1kpi_tracker_v1';
const DEFAULT_PREFS = { view: 'mine', person: '', owner: '', category: '', project: '', status: 'open' };

const VIEWS = [
  ['mine', 'My tasks'],
  ['overdue', 'Overdue'],
  ['blocked', 'Blocked'],
  ['project', 'By project'],
  ['weekly', 'Weekly'],
];

// Which filters each view offers. Overdue and Blocked are already statuses,
// and the weekly rollup *is* a status breakdown, so none of those take one.
const FILTERS = {
  mine: ['person', 'category', 'project', 'status'],
  overdue: ['owner', 'category', 'project'],
  blocked: ['owner', 'category', 'project'],
  project: ['category', 'project', 'owner', 'status'],
  weekly: ['owner', 'category', 'project'],
};

const newId = (prefix) => prefix + Math.random().toString(36).slice(2, 10);

export function mountTracker(h) {
  const { esc } = h;
  const $ = (id) => document.getElementById(id);
  const root = $('tracker');
  let prefs = loadPrefs();
  let weekOffset = 0;      // navigation, not a filter — every visit starts on this week
  let ix = null;           // lookups, rebuilt each render

  // ---------------------------------------------------------------- prefs

  function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
    catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }

  /** Drop filter values that point at things deleted since they were saved. */
  function cleanPrefs() {
    const t = tr();
    if (!VIEWS.some(([v]) => v === prefs.view)) prefs.view = 'mine';
    if (prefs.category && !t.categories.some((c) => c.id === prefs.category)) prefs.category = '';
    const proj = t.projects.find((p) => p.id === prefs.project);
    if (prefs.project && (!proj || (prefs.category && proj.category_id !== prefs.category))) prefs.project = '';
    if (prefs.owner && !people().some((c) => c.id === prefs.owner)) prefs.owner = '';
    if (prefs.person && !people().some((c) => c.id === prefs.person)) prefs.person = '';
    if (!['', 'open', ...STATUSES].includes(prefs.status)) prefs.status = 'open';
  }

  // ---------------------------------------------------------------- lookups

  const tr = () => store.db.tracker;
  const people = () => store.db.contributors ?? [];
  const person = (id) => people().find((c) => c.id === id) ?? { id, name: 'Unknown' };
  const today = () => localDate();

  /** The header's "Who are you?" pick, as a contributor id. */
  const actorId = () => {
    const a = (store.actor || '').trim().toLowerCase();
    return a ? (people().find((c) => (c.name || '').toLowerCase() === a)?.id ?? '') : '';
  };
  /** My tasks shows an explicit pick if there is one, else whoever you said you are. */
  const minePerson = () => prefs.person || actorId();

  const ownerNames = (ids) => (ids ?? []).map((id) => person(id).name).sort().join(', ');
  const projectTitle = (id) => tr().projects.find((p) => p.id === id)?.title ?? '';

  function filtersFor(view) {
    const allowed = FILTERS[view];
    const f = {};
    if (allowed.includes('category')) f.category = prefs.category;
    if (allowed.includes('project')) f.project = prefs.project;
    if (allowed.includes('owner')) f.owner = prefs.owner;
    if (allowed.includes('person')) f.owner = minePerson();
    if (allowed.includes('status')) f.status = prefs.status;
    return f;
  }

  // ---------------------------------------------------------------- dates

  const fmtDate = (s, long = false) => {
    const d = parseDate(s);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, long
      ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  };
  const weekday = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'short' });
  const fmtStamp = (iso) => (iso ? fmtDate(localDate(new Date(iso))) : '');

  function dueLabel(t) {
    if (!t.due_date) return { text: 'No due date', cls: 'none', title: 'No due date set' };
    const d = daysBetween(today(), t.due_date);
    const title = `Due ${fmtDate(t.due_date, true)}`;
    if (isDone(t)) return { text: fmtDate(t.due_date), cls: '', title };
    if (d < 0) return { text: `${-d} day${d === -1 ? '' : 's'} overdue`, cls: 'overdue', title };
    if (d === 0) return { text: 'Due today', cls: 'soon', title };
    if (d === 1) return { text: 'Due tomorrow', cls: 'soon', title };
    if (d < 7) return { text: `Due ${weekday(t.due_date)}`, cls: '', title };
    return { text: fmtDate(t.due_date), cls: '', title };
  }

  // ---------------------------------------------------------------- pieces

  function statusSelect(t) {
    return `<select class="tk-status s-${esc(t.status)}" data-status-for="${esc(t.id)}"
      aria-label="Status of ${esc(t.title)}">${STATUSES.map((s) =>
        `<option value="${s}" ${s === t.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>`;
  }

  function blockedNote(t) {
    if (t.status !== 'blocked') return '';
    return t.blocked_by?.trim()
      ? `<span class="tk-blocked">Blocked on: ${esc(t.blocked_by)}</span>`
      : '<span class="tk-blocked">Blocked — reason not given</span>';
  }

  /**
   * One task. `hideOwner` drops the person a view is already about, so their
   * own list reads "with Nam" instead of repeating their name on every row.
   */
  function rowHtml(t, o = {}) {
    const cat = ix.categoryOf(t);
    const proj = ix.projectOf(t);
    const due = dueLabel(t);
    const owners = (t.owners ?? []).filter((id) => id !== o.hideOwner);
    const cls = ['tk-row', o.compact ? 'compact' : '', isDone(t) ? 'is-done' : ''].join(' ');
    const open = `<div class="${cls}" data-task="${esc(t.id)}" tabindex="0" role="button">`;

    if (o.compact) {
      const meta = [
        owners.map((id) => esc(person(id).name)).join(', '),
        `<span class="tk-due-inline ${due.cls}" title="${esc(due.title)}">${esc(due.text)}</span>`,
        o.tag ? `<span class="tk-tag ${o.tag[0]}">${esc(o.tag[1])}</span>` : '',
        blockedNote(t),
      ].filter(Boolean).join(' · ');
      return `${open}${statusSelect(t)}
        <div class="tk-main"><div class="tk-title">${esc(t.title)}</div><div class="tk-meta">${meta}</div></div>
      </div>`;
    }

    const meta = [
      !o.hidePath && cat && proj ? `${esc(cat.title)} › ${esc(proj.title)}` : '',
      t.source ? `from ${esc(t.source)}` : '',
      blockedNote(t),
    ].filter(Boolean).join(' · ');
    return `${open}${statusSelect(t)}
      <div class="tk-main">
        <div class="tk-title">${esc(t.title)}</div>
        ${meta ? `<div class="tk-meta">${meta}</div>` : ''}
      </div>
      <div class="tk-owners">${o.hideOwner && owners.length ? '<span class="muted">with</span> ' : ''}${
        // Real spaces between items: flex ignores them for layout, but without
        // them the text reads "withFrancis" to copy-paste and screen readers.
        owners.map((id) => `<span class="chip">${esc(person(id).name)}</span>`).join(' ')}</div>
      <div class="tk-due ${due.cls}" title="${esc(due.title)}">${esc(due.text)}</div>
    </div>`;
  }

  const rows = (list, o) => list.map((t) => rowHtml(t, o)).join('');

  const groupHtml = (title, body, { tone = '', hint = '', action = '' } = {}) => `
    <div class="tk-group">
      <div class="tk-group-head ${tone}">
        <h4>${title}</h4>
        <div class="tk-group-side">${hint ? `<span class="hint">${hint}</span>` : ''}${action}</div>
      </div>
      ${body}
    </div>`;

  const count = (n) => `<span class="tk-count">${n}</span>`;

  const emptyHtml = (headline, detail = '', action = '') => `
    <div class="card tk-empty"><b>${headline}</b>${detail ? `<div>${detail}</div>` : ''}${
      action ? `<div class="tk-empty-action">${action}</div>` : ''}</div>`;

  /** Undated work is invisible to Overdue and Weekly. Say so, or those views lie by omission. */
  function undatedNote(tasks) {
    const n = tasks.filter((t) => isOpen(t) && !t.due_date).length;
    if (!n) return '';
    return `<div class="callout tk-callout">${n} open task${n === 1 ? ' has' : 's have'} no due date, so ${
      n === 1 ? 'it' : 'they'} can never show up as overdue or slipped. Give ${n === 1 ? 'it' : 'them'} a date in My tasks or By project.</div>`;
  }

  // ---------------------------------------------------------------- chrome

  function renderTabs() {
    const t = today();
    const scoped = filterTasks(tr(), { category: prefs.category, project: prefs.project, owner: prefs.owner });
    const me = minePerson();
    const badges = {
      mine: me ? filterTasks(tr(), { category: prefs.category, project: prefs.project, owner: me, status: 'open' }).length : null,
      overdue: scoped.filter((x) => isOverdue(x, t)).length,
      blocked: scoped.filter((x) => x.status === 'blocked').length,
    };
    const tone = { overdue: 'alert', blocked: 'warn' };
    $('tkTabs').innerHTML = VIEWS.map(([v, label]) => {
      const n = badges[v];
      const show = n != null && (v === 'mine' || n > 0);
      return `<button type="button" class="${v === prefs.view ? 'active' : ''}" data-tk-view="${v}">${label}${
        show ? `<span class="n ${n > 0 ? tone[v] ?? '' : ''}">${n}</span>` : ''}</button>`;
    }).join('');
  }

  function renderFilters() {
    const allowed = FILTERS[prefs.view];
    const t = tr();
    const sel = (name, label, options, value) => `
      <label>${label}<select data-tk-filter="${name}">${options.map(([v, l]) =>
        `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    const parts = [];

    if (allowed.includes('person')) {
      const me = actorId();
      const opts = [['', me ? `Me (${person(me).name})` : 'Choose a person…']];
      for (const c of people()) if (c.id !== me) opts.push([c.id, c.name]);
      parts.push(sel('person', 'Person', opts, prefs.person === me ? '' : prefs.person));
    }
    if (allowed.includes('owner')) {
      parts.push(sel('owner', 'Owner', [['', 'Everyone'], ...people().map((c) => [c.id, c.name])], prefs.owner));
    }
    if (allowed.includes('category')) {
      parts.push(sel('category', 'Category', [['', 'All categories'], ...t.categories.map((c) => [c.id, c.title])], prefs.category));
    }
    if (allowed.includes('project')) {
      parts.push(sel('project', 'Project',
        [['', 'All projects'], ...projectsIn(t, prefs.category).map((p) => [p.id, p.title])], prefs.project));
    }
    if (allowed.includes('status')) {
      parts.push(sel('status', 'Status',
        [['open', 'Open'], ['', 'All'], ...STATUSES.map((s) => [s, STATUS_LABEL[s]])], prefs.status));
    }

    const narrowed = allowed.some((k) => k !== 'person' && prefs[k] && !(k === 'status' && prefs.status === 'open'));
    $('tkFilters').innerHTML = parts.join('')
      + (narrowed ? '<button type="button" class="tk-clear" data-tk-clear>Clear filters</button>' : '')
      + (prefs.view === 'weekly' ? weekNavHtml() : '');
  }

  function weekNavHtml() {
    const { start, end } = weekBounds(addDays(today(), weekOffset * 7));
    const label = { 0: 'This week', '-1': 'Last week', 1: 'Next week' }[weekOffset] ?? '';
    return `<span class="tk-spacer"></span>
      <div class="tk-week">
        <button type="button" class="btn tk-mini" data-tk-week="-1" aria-label="Previous week">←</button>
        <b>${fmtDate(start)} – ${fmtDate(end)}</b>${label ? `<span class="muted">${label}</span>` : ''}
        <button type="button" class="btn tk-mini" data-tk-week="1" aria-label="Next week">→</button>
        ${weekOffset ? '<button type="button" class="btn tk-mini" data-tk-week="0">This week</button>' : ''}
      </div>`;
  }

  // ---------------------------------------------------------------- views

  function mineHtml() {
    const me = minePerson();
    if (!me) {
      return emptyHtml('Whose tasks?', 'Pick your name in the header, top right — or choose a person above.');
    }
    const t = today();
    const f = filtersFor('mine');
    const all = filterTasks(tr(), { ...f, status: '' });     // stats ignore the status filter
    const shown = filterTasks(tr(), f);
    const openAll = all.filter(isOpen);
    const { end } = weekBounds(t);
    const stats = [
      ['Open', openAll.length, ''],
      ['Overdue', openAll.filter((x) => isOverdue(x, t)).length, 'alert'],
      ['Due this week', openAll.filter((x) => x.due_date && x.due_date >= t && x.due_date <= end).length, ''],
      ['No due date', openAll.filter((x) => !x.due_date).length, ''],
    ];
    const statsHtml = `<div class="tk-stats">${stats.map(([label, v, tone]) => `
      <div class="tk-stat ${v && tone ? tone : ''}"><div class="label">${label}</div><div class="value">${v}</div></div>`).join('')}</div>`;

    const name = esc(person(me).name);
    const addBtn = `<button type="button" class="btn" data-tk-new-task="" data-tk-owner="${esc(me)}">+ Task for ${name}</button>`;
    if (!all.length) return statsHtml + emptyHtml(`Nothing assigned to ${name}`, '', addBtn);

    const b = bucketByDue(shown, t);
    const sections = [
      ['Overdue', b.overdue, 'alert', ''],
      ['Due this week', b.week, '', ''],
      ['Later', b.later, '', ''],
      ['No due date', b.undated, '', 'Give these a date, or they can never show up as overdue.'],
      ['Done', b.done, '', ''],
    ].filter(([, list]) => list.length)
      .map(([title, list, tone, hint]) =>
        groupHtml(`${title} ${count(list.length)}`, rows(list, { hideOwner: me }), { tone, hint }));

    const hiddenDone = prefs.status === 'open' ? all.filter(isDone).length : 0;
    const foot = hiddenDone
      ? `<div class="tk-foot"><button type="button" class="tk-clear" data-tk-showdone>Show ${hiddenDone} done</button></div>` : '';
    if (!sections.length) return statsHtml + emptyHtml('Nothing matches these filters', '', foot);
    return `${statsHtml}<div class="card">${sections.join('')}${foot}</div>`;
  }

  function overdueHtml() {
    const tasks = filterTasks(tr(), filtersFor('overdue'));
    const groups = overdueByOwner(tasks, today());
    if (!groups.length) return emptyHtml('Nothing is overdue', '', '') + undatedNote(tasks);
    return groups.map((g) => `<div class="card tk-card">${groupHtml(
      `${esc(person(g.owner).name)} ${count(`${g.tasks.length} overdue`)}`,
      rows(g.tasks, { hideOwner: g.owner }))}</div>`).join('') + undatedNote(tasks);
  }

  function blockedHtml() {
    const tasks = filterTasks(tr(), filtersFor('blocked'));
    const g = blockedByDependency(tasks, people());
    if (!g.people.length && !g.external.length && !g.unexplained.length) {
      return emptyHtml('Nothing is blocked',
        'When something is blocked, say what it’s waiting on. Name a teammate and it lands under them here.');
    }
    const sections = [
      ...g.people.map((p) => groupHtml(
        `Waiting on ${esc(person(p.contributor_id).name)} ${count(p.tasks.length)}`, rows(p.tasks))),
      g.external.length ? groupHtml(`Waiting on something else ${count(g.external.length)}`, rows(g.external)) : '',
      g.unexplained.length ? groupHtml(`Reason not given ${count(g.unexplained.length)}`, rows(g.unexplained),
        { tone: 'warn', hint: 'Say what these are waiting on, so the right person sees them.' }) : '',
    ].filter(Boolean);
    return `<div class="card">${sections.join('')}</div>`;
  }

  function projectHtml() {
    const t = tr();
    if (!t.categories.length) {
      return emptyHtml('No categories yet', 'Start with a category — it can point at the KPI node it reconciles with.',
        '<button type="button" class="btn primary" data-tk-new-category>+ Category</button>');
    }
    const f = filtersFor('project');
    // An owner or a specific status hides projects with nothing matching. It
    // never hides a category: every category shows, however empty, because
    // that is where its "+ Project" button lives. Only picking a category or a
    // project narrows the categories shown.
    const narrowed = !!(f.owner || (f.status && f.status !== 'open'));
    const cards = [];

    for (const c of t.categories.filter((x) => !prefs.category || x.id === prefs.category)) {
      const projs = projectsIn(t, c.id).filter((x) => !prefs.project || x.id === prefs.project);
      if (prefs.project && !projs.length) continue;      // one project picked: just its category
      const blocks = [];
      for (const p of projs) {
        const list = sortByDue(filterTasks(t, { owner: f.owner, status: f.status, project: p.id }));
        if (!list.length && narrowed) continue;      // filtering: only projects with matches
        const inProj = t.tasks.filter((x) => x.project_id === p.id);
        const openN = inProj.filter(isOpen).length;
        const doneN = inProj.length - openN;
        blocks.push(groupHtml(
          `<button type="button" class="tk-link" data-tk-project="${esc(p.id)}" title="Edit project">${esc(p.title)}</button>
           ${count(`${openN} open${doneN ? ` · ${doneN} done` : ''}`)}`,
          list.length ? rows(list, { hidePath: true })
            : `<div class="tk-none">No ${f.status === 'open' ? 'open ' : ''}tasks.</div>`,
          { action: `<button type="button" class="btn tk-mini" data-tk-new-task="${esc(p.id)}">+ Task</button>` }));
      }
      const none = projectsIn(t, c.id).length ? 'No matching tasks.' : 'No projects yet.';
      const kpi = c.kpi_node_id ? store.db.nodes.find((n) => n.id === c.kpi_node_id) : null;
      cards.push(`<div class="card tk-card">
        <div class="tk-cat-head">
          <button type="button" class="tk-link tk-cat-title" data-tk-category="${esc(c.id)}" title="Edit category">${esc(c.title)}</button>
          ${kpi ? `<button type="button" class="chip tk-kpi" data-tk-kpi="${esc(kpi.id)}" title="Open in the KPI tree">KPI · ${esc(kpi.title)}</button>` : ''}
          <span class="tk-spacer"></span>
          <button type="button" class="btn tk-mini" data-tk-new-project="${esc(c.id)}">+ Project</button>
        </div>
        ${blocks.join('') || `<div class="tk-none">${none}</div>`}
      </div>`);
    }
    return cards.join('') || emptyHtml('Nothing matches these filters');
  }

  function weeklyHtml() {
    const t = today();
    const tasks = filterTasks(tr(), filtersFor('weekly'));
    const r = weeklyRollup(tasks, addDays(t, weekOffset * 7), t);
    const col = (title, n, body, empty, tone = '') => `
      <div class="card tk-col">
        <div class="tk-group-head ${tone}"><h4>${title} ${count(n)}</h4></div>
        ${body || `<div class="tk-none">${empty}</div>`}
      </div>`;
    const future = weekOffset > 0;
    const cols = `<div class="tk-cols">
      ${col('Due', r.due.length, rows(r.due, { compact: true }), 'Nothing was due.')}
      ${col('Shipped', r.shipped.length, rows(r.shipped, { compact: true }), future ? 'Not yet.' : 'Nothing shipped.')}
      ${col('Slipped', r.slipped.length,
        r.slipped.map((s) => rowHtml(s.task, { compact: true, tag: s.late ? ['late', 'Done late'] : ['open', 'Still open'] })).join(''),
        future ? 'Not yet.' : 'Nothing slipped.', r.slipped.length ? 'alert' : '')}
    </div>`;
    const tally = weeklyByOwner(r);
    const table = tally.length ? `
      <div class="card table-card tk-card">
        <h3 style="padding-top:10px">By person</h3>
        <table>
          <thead><tr><th>Owner</th><th>Due</th><th>Shipped</th><th>Slipped</th></tr></thead>
          <tbody>${tally.map((x) => `<tr>
            <td>${esc(person(x.owner).name)}</td><td>${x.due}</td><td>${x.shipped}</td>
            <td>${x.slipped ? `<b class="tk-alert-text">${x.slipped}</b>` : 0}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : '';
    return cols + table + undatedNote(tasks);
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!store.db?.tracker) return;
    cleanPrefs();
    ix = index(tr());
    renderTabs();
    renderFilters();
    const view = {
      mine: mineHtml, overdue: overdueHtml, blocked: blockedHtml, project: projectHtml, weekly: weeklyHtml,
    }[prefs.view];
    $('tkBody').innerHTML = view();
  }

  // ---------------------------------------------------------------- saving

  /**
   * Apply `mutate` to the live tracker, validate, save. `mutate` returns the
   * audit entries describing what it did. On any failure the tracker is put
   * back exactly as it was — unless a realtime update replaced store.db while
   * we waited, in which case that newer data wins and we leave it alone.
   */
  async function commit(mutate) {
    const dbRef = store.db;
    const snapshot = structuredClone(dbRef.tracker);
    let audit;
    try {
      audit = mutate(dbRef.tracker) ?? [];
    } catch (e) {
      dbRef.tracker = snapshot;
      h.banner(esc(e.message), 'bad');
      h.rerender();
      return { ok: false, message: e.message };
    }
    const problems = validateTracker(dbRef.tracker, people().map((c) => c.id));
    if (problems.length) {
      dbRef.tracker = snapshot;
      h.rerender();
      return { ok: false, message: `Refused — ${problems[0]}` };
    }
    const res = await save(audit);
    if (!res.ok) {
      if (store.db === dbRef) dbRef.tracker = snapshot;
      if (res.conflict) {
        h.banner(`${esc(res.message)} Your change was not saved.`, 'bad',
          { label: 'Reload', fn: () => window.location.reload() });
      } else {
        h.banner(esc(res.message), 'bad');
      }
    }
    h.rerender();
    return res;
  }

  const gone = () => new Error('That task no longer exists — someone may have just deleted it.');

  async function setStatus(id, status) {
    let needsReason = false;
    const res = await commit((t) => {
      const task = t.tasks.find((x) => x.id === id);
      if (!task) throw gone();
      const before = task.status;
      if (before === status) return [];
      applyStatus(task, status);
      needsReason = status === 'blocked' && !task.blocked_by?.trim();
      return [{ node_id: task.id, node_title: task.title, field: 'task status',
        old_value: STATUS_LABEL[before], new_value: STATUS_LABEL[status] }];
    });
    // Blocked with no reason is half a status. Ask for the reason straight away.
    if (res.ok && needsReason) openTask(id, { focus: 'tkBlocked' });
  }

  function diffTask(before, after) {
    const out = [];
    const push = (field, o, v) => {
      if (String(o ?? '') !== String(v ?? '')) {
        out.push({ node_id: before.id, node_title: after.title, field, old_value: String(o ?? ''), new_value: String(v ?? '') });
      }
    };
    push('task title', before.title, after.title);
    push('task project', projectTitle(before.project_id), projectTitle(after.project_id));
    push('task owners', ownerNames(before.owners), ownerNames(after.owners));
    push('task due', before.due_date || 'none', after.due_date || 'none');
    push('task status', STATUS_LABEL[before.status], STATUS_LABEL[after.status]);
    push('task blocked by', before.blocked_by, after.blocked_by);
    push('task source', before.source, after.source);
    return out;
  }

  // ---------------------------------------------------------------- drawers

  function drawer(title, path, body) {
    $('drawerTitle').textContent = title;
    $('drawerPath').textContent = path;
    $('drawerBody').innerHTML = body;
    h.openDrawer();
  }
  const errorIn = (id) => (m) => { $(id).innerHTML = `<span style="color:var(--danger)">${esc(m)}</span>`; };

  /** Two clicks to delete, same as the KPI tree's node delete. */
  function armDelete(btnId, label, run) {
    const btn = $(btnId);
    let armed = false;
    btn.onclick = async () => {
      if (!armed) { armed = true; btn.textContent = 'Click again to confirm'; return; }
      btn.disabled = true;
      const res = await run();
      if (res?.ok) h.closeDrawer();
      else { btn.disabled = false; armed = false; btn.textContent = label; }
    };
  }

  function openTask(id, opts = {}) {
    const t = tr();
    const existing = id ? t.tasks.find((x) => x.id === id) : null;
    if (id && !existing) return;
    if (!t.projects.length) {
      h.banner('Create a project first — every task belongs to one.', 'warn');
      return openProject(null, {});
    }
    const me = minePerson();
    const task = existing ?? {
      title: '', status: 'not_started', due_date: '', blocked_by: '', source: '',
      project_id: opts.project_id || prefs.project || t.projects[0].id,
      owners: opts.owners ?? (me ? [me] : []),
    };

    const projOptions = t.categories.map((c) => {
      const ps = projectsIn(t, c.id);
      return ps.length ? `<optgroup label="${esc(c.title)}">${ps.map((p) =>
        `<option value="${esc(p.id)}" ${p.id === task.project_id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</optgroup>` : '';
    }).join('');

    const stamps = existing ? [
      existing.created_at ? `Created ${fmtStamp(existing.created_at)}` : '',
      existing.done_at ? `done ${fmtStamp(existing.done_at)}` : '',
    ].filter(Boolean).join(' · ') : '';

    const path = existing
      ? `${ix.categoryOf(existing)?.title ?? ''} › ${ix.projectOf(existing)?.title ?? ''}`
      : 'Accountability';
    drawer(existing ? existing.title : 'New task', path, `
      <div class="field"><label>Task</label>
        <input id="tkTitle" value="${esc(task.title)}" placeholder="What was promised?"></div>
      <div class="field"><label>Project</label><select id="tkProject">${projOptions}</select></div>
      <div class="field"><label>Owners</label>
        <div class="checks">${people().map((c) => `
          <label class="check"><input type="checkbox" value="${esc(c.id)}" ${task.owners.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}
        </div></div>
      <div class="two">
        <div class="field"><label>Due date</label><input id="tkDue" type="date" value="${esc(task.due_date)}"></div>
        <div class="field"><label>Status</label><select id="tkStatus">${STATUSES.map((s) =>
          `<option value="${s}" ${s === task.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Blocked by</label>
        <input id="tkBlocked" value="${esc(task.blocked_by)}" placeholder="What is it waiting on?">
        <div class="readout" id="tkBlockedHint"></div></div>
      <div class="field"><label>Source</label>
        <input id="tkSource" value="${esc(task.source)}" placeholder="Where it came from — e.g. Sep 4 standup, BAM call"></div>
      <button class="btn primary" id="tkSaveBtn">${existing ? 'Save changes' : 'Create task'}</button>
      <div class="readout" id="tkMsg"></div>
      ${stamps ? `<div class="readout">${esc(stamps)}</div>` : ''}
      ${existing ? '<div class="struct"><button class="btn danger" id="tkDeleteBtn">Delete task</button></div>' : ''}`);

    const hint = () => {
      const blocked = $('tkStatus').value === 'blocked';
      const empty = !$('tkBlocked').value.trim();
      $('tkBlockedHint').textContent = blocked && empty
        ? 'Say what it’s waiting on. Name a teammate and it shows up under them in the Blocked view.'
        : blocked ? '' : 'Only shown while the task is blocked.';
    };
    $('tkStatus').onchange = hint;
    $('tkBlocked').oninput = hint;
    hint();
    if (opts.focus) setTimeout(() => $(opts.focus)?.focus(), 240);   // after the drawer slides in
    else if (!existing) setTimeout(() => $('tkTitle')?.focus(), 240);

    $('tkSaveBtn').onclick = async () => {
      const fail = errorIn('tkMsg');
      const title = $('tkTitle').value.trim();
      const owners = [...$('drawerBody').querySelectorAll('.checks input:checked')].map((i) => i.value);
      if (!title) return fail('Give the task a title.');
      if (!owners.length) return fail('Every task needs at least one owner.');
      const fields = {
        title, owners,
        project_id: $('tkProject').value,
        due_date: $('tkDue').value,
        blocked_by: $('tkBlocked').value.trim(),
        source: $('tkSource').value.trim(),
      };
      const status = $('tkStatus').value;
      const btn = $('tkSaveBtn');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      const res = await commit((tt) => {
        const now = new Date().toISOString();
        if (!existing) {
          const created = { id: newId('tt'), ...fields, status: 'not_started', created_at: now, updated_at: now, done_at: '' };
          applyStatus(created, status, now);
          tt.tasks.push(created);
          return [{ node_id: created.id, node_title: created.title, field: 'task created', old_value: '',
            new_value: `${ownerNames(owners)} · ${projectTitle(fields.project_id)}` }];
        }
        const live = tt.tasks.find((x) => x.id === existing.id);
        if (!live) throw gone();
        const audit = diffTask(live, { ...fields, status });
        Object.assign(live, fields);
        if (live.status !== status) applyStatus(live, status, now);
        else live.updated_at = now;
        return audit;
      });

      if (res.ok) return h.closeDrawer();
      if ($('tkSaveBtn')) {
        btn.disabled = false;
        btn.textContent = existing ? 'Save changes' : 'Create task';
        if (!res.conflict) fail(res.message);
      }
    };

    if (existing) {
      armDelete('tkDeleteBtn', 'Delete task', () => commit((tt) => {
        const i = tt.tasks.findIndex((x) => x.id === existing.id);
        if (i < 0) return [];
        const [removed] = tt.tasks.splice(i, 1);
        return [{ node_id: removed.id, node_title: removed.title, field: 'task deleted',
          old_value: STATUS_LABEL[removed.status], new_value: '' }];
      }));
    }
  }

  function openProject(id, opts = {}) {
    const t = tr();
    const existing = id ? t.projects.find((p) => p.id === id) : null;
    if (id && !existing) return;
    if (!t.categories.length) {
      h.banner('Create a category first — every project belongs to one.', 'warn');
      return openCategory(null);
    }
    const categoryId = existing?.category_id || opts.category_id || prefs.category || t.categories[0].id;
    const taskCount = existing ? t.tasks.filter((x) => x.project_id === existing.id).length : 0;

    drawer(existing ? existing.title : 'New project', 'Accountability · project', `
      <div class="field"><label>Project</label>
        <input id="tkProjTitle" value="${esc(existing?.title ?? '')}" placeholder="e.g. Venue partnerships"></div>
      <div class="field"><label>Category</label><select id="tkProjCat">${t.categories.map((c) =>
        `<option value="${esc(c.id)}" ${c.id === categoryId ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}</select></div>
      <button class="btn primary" id="tkProjSave">${existing ? 'Save changes' : 'Create project'}</button>
      <div class="readout" id="tkMsg"></div>
      ${existing ? `<div class="struct">
        <button class="btn danger" id="tkProjDelete">Delete project${taskCount ? ` and its ${taskCount} task${taskCount === 1 ? '' : 's'}` : ''}</button>
      </div>` : ''}`);
    if (!existing) setTimeout(() => $('tkProjTitle')?.focus(), 240);

    $('tkProjSave').onclick = async () => {
      const title = $('tkProjTitle').value.trim();
      if (!title) return errorIn('tkMsg')('Give the project a title.');
      const category_id = $('tkProjCat').value;
      const res = await commit((tt) => {
        if (!existing) {
          const p = { id: newId('tp'), category_id, title };
          tt.projects.push(p);
          return [{ node_id: p.id, node_title: title, field: 'project created', old_value: '', new_value: '' }];
        }
        const live = tt.projects.find((p) => p.id === existing.id);
        if (!live) throw new Error('That project no longer exists.');
        const before = live.title;
        Object.assign(live, { title, category_id });
        return before !== title
          ? [{ node_id: live.id, node_title: title, field: 'project title', old_value: before, new_value: title }] : [];
      });
      if (res.ok) h.closeDrawer();
      else if (!res.conflict) errorIn('tkMsg')(res.message);
    };

    if (existing) {
      const label = $('tkProjDelete').textContent;
      armDelete('tkProjDelete', label, () => commit((tt) => {
        tt.tasks = tt.tasks.filter((x) => x.project_id !== existing.id);
        tt.projects = tt.projects.filter((p) => p.id !== existing.id);
        return [{ node_id: existing.id, node_title: existing.title, field: 'project deleted',
          old_value: `${taskCount} tasks`, new_value: '' }];
      }));
    }
  }

  /** KPI nodes in tree order, indented, for the category link picker. */
  function kpiOptions(selected) {
    const opts = ['<option value="">Not linked</option>'];
    try {
      const tree = buildTree(store.db.nodes);
      (function walk(n, depth) {
        if (n.parent_id != null) {
          // Non-breaking spaces: ordinary ones collapse inside <option>.
          opts.push(`<option value="${esc(n.id)}" ${n.id === selected ? 'selected' : ''}>${
            '\u00a0\u00a0\u00a0'.repeat(depth - 1)}${esc(n.title)}</option>`);
        }
        tree.childrenOf.get(n.id).forEach((c) => walk(c, depth + 1));
      })(tree.root, 0);
    } catch {
      for (const n of store.db.nodes) {
        opts.push(`<option value="${esc(n.id)}" ${n.id === selected ? 'selected' : ''}>${esc(n.title)}</option>`);
      }
    }
    return opts.join('');
  }

  function openCategory(id) {
    const t = tr();
    const existing = id ? t.categories.find((c) => c.id === id) : null;
    if (id && !existing) return;
    const projIds = existing ? new Set(projectsIn(t, existing.id).map((p) => p.id)) : new Set();
    const taskCount = t.tasks.filter((x) => projIds.has(x.project_id)).length;

    drawer(existing ? existing.title : 'New category', 'Accountability · category', `
      <div class="field"><label>Category</label>
        <input id="tkCatTitle" value="${esc(existing?.title ?? '')}" placeholder="e.g. Partnerships"></div>
      <div class="field"><label>Reconciles with KPI node</label>
        <select id="tkCatKpi">${kpiOptions(existing?.kpi_node_id ?? '')}</select>
        <div class="readout">A loose link so the tracker and the KPI tree can be read side by side.
          Nothing here changes weights or credit.</div></div>
      <button class="btn primary" id="tkCatSave">${existing ? 'Save changes' : 'Create category'}</button>
      <div class="readout" id="tkMsg"></div>
      ${existing ? `<div class="struct"><button class="btn danger" id="tkCatDelete">Delete category${
        projIds.size ? ` with ${projIds.size} project${projIds.size === 1 ? '' : 's'} and ${taskCount} task${taskCount === 1 ? '' : 's'}` : ''}</button></div>` : ''}`);
    if (!existing) setTimeout(() => $('tkCatTitle')?.focus(), 240);

    $('tkCatSave').onclick = async () => {
      const title = $('tkCatTitle').value.trim();
      if (!title) return errorIn('tkMsg')('Give the category a title.');
      const kpi_node_id = $('tkCatKpi').value;
      const res = await commit((tt) => {
        if (!existing) {
          const c = { id: newId('tc'), title, kpi_node_id };
          tt.categories.push(c);
          return [{ node_id: c.id, node_title: title, field: 'category created', old_value: '', new_value: '' }];
        }
        const live = tt.categories.find((c) => c.id === existing.id);
        if (!live) throw new Error('That category no longer exists.');
        const before = live.title;
        Object.assign(live, { title, kpi_node_id });
        return before !== title
          ? [{ node_id: live.id, node_title: title, field: 'category title', old_value: before, new_value: title }] : [];
      });
      if (res.ok) h.closeDrawer();
      else if (!res.conflict) errorIn('tkMsg')(res.message);
    };

    if (existing) {
      const label = $('tkCatDelete').textContent;
      armDelete('tkCatDelete', label, () => commit((tt) => {
        tt.tasks = tt.tasks.filter((x) => !projIds.has(x.project_id));
        tt.projects = tt.projects.filter((p) => p.category_id !== existing.id);
        tt.categories = tt.categories.filter((c) => c.id !== existing.id);
        return [{ node_id: existing.id, node_title: existing.title, field: 'category deleted',
          old_value: `${projIds.size} projects, ${taskCount} tasks`, new_value: '' }];
      }));
    }
  }

  // ---------------------------------------------------------------- events

  // Delegated once; render() only ever rewrites innerHTML beneath these.
  root.addEventListener('click', (e) => {
    if (e.target.closest('select')) return;
    const el = e.target.closest([
      '[data-tk-view]', '[data-tk-week]', '[data-tk-clear]', '[data-tk-showdone]',
      '[data-tk-new-task]', '[data-tk-new-project]', '[data-tk-new-category]',
      '[data-tk-project]', '[data-tk-category]', '[data-tk-kpi]', '[data-task]',
    ].join(','));
    if (!el) return;
    const d = el.dataset;
    if ('tkView' in d) { prefs.view = d.tkView; savePrefs(); render(); }
    else if ('tkWeek' in d) { weekOffset = d.tkWeek === '0' ? 0 : weekOffset + Number(d.tkWeek); render(); }
    else if ('tkClear' in d) {
      Object.assign(prefs, { owner: '', category: '', project: '', status: 'open' });
      savePrefs(); render();
    }
    else if ('tkShowdone' in d) { prefs.status = ''; savePrefs(); render(); }
    else if ('tkNewTask' in d) {
      openTask(null, { project_id: d.tkNewTask || undefined, owners: d.tkOwner ? [d.tkOwner] : undefined });
    }
    else if ('tkNewProject' in d) openProject(null, { category_id: d.tkNewProject || undefined });
    else if ('tkNewCategory' in d) openCategory(null);
    else if ('tkProject' in d) openProject(d.tkProject);
    else if ('tkCategory' in d) openCategory(d.tkCategory);
    else if ('tkKpi' in d) h.showKpiNode(d.tkKpi);
    else if ('task' in d) openTask(d.task);
  });

  root.addEventListener('change', (e) => {
    const s = e.target;
    if (s.dataset.statusFor) { setStatus(s.dataset.statusFor, s.value); return; }
    const key = s.dataset.tkFilter;
    if (!key) return;
    prefs[key] = s.value;
    if (key === 'category' && s.value) {
      const proj = tr().projects.find((p) => p.id === prefs.project);
      if (proj && proj.category_id !== s.value) prefs.project = '';
    }
    savePrefs();
    render();
  });

  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-task]')) {
      e.preventDefault();
      openTask(e.target.dataset.task);
    }
  });

  return { render };
}
