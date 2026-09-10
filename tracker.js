/**
 * Accountability tracker — pure logic, no DOM.
 *
 * The KPI tree says what work is worth and who owns it. This says what is due
 * and whether it happened. They are deliberately separate data: a category
 * here may point at a KPI node (`kpi_node_id`) so the two reconcile, but
 * nothing in the credit math reads the tracker, and nothing here reads weights.
 *
 * Shape, stored at db.tracker:
 *
 *   categories: [{ id, title, kpi_node_id }]
 *   projects:   [{ id, category_id, title }]
 *   tasks:      [{ id, project_id, title, owners: [contributor_id], due_date,
 *                  status, blocked_by, blocked_by_tasks: [task_id], source,
 *                  created_at, updated_at, done_at }]
 *
 * Dependencies. `blocked_by_tasks` lists tasks that must be finished first;
 * `blocked_by` stays free text for anything that isn't a task here. Being
 * blocked is derived, not stored: a task is blocked if someone set its status
 * to Blocked, OR it is waiting on a task that isn't done. The reverse — what a
 * task is holding up — is what each owner sees on their own list.
 *
 * Dates. `due_date` is a calendar date, 'YYYY-MM-DD', exactly what an
 * <input type="date"> produces. It is compared as a string against today's
 * *local* date — never parsed with `new Date('YYYY-MM-DD')`, which reads it as
 * UTC midnight and lands on the previous day anywhere west of Greenwich.
 * `done_at` is a full ISO timestamp, converted to a local date when needed.
 *
 * Every function that cares about "today" takes it as an argument, so the
 * logic is testable at any date.
 */

export const STATUSES = ['not_started', 'in_progress', 'blocked', 'done'];
export const STATUS_LABEL = {
  not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};

export const emptyTracker = () => ({ categories: [], projects: [], tasks: [] });

// ---------------------------------------------------------------- dates

/** Local calendar date of a Date, as 'YYYY-MM-DD'. */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date at local midnight. */
export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Whole days from a to b ('YYYY-MM-DD'). UTC arithmetic, so DST can't skew it. */
export function daysBetween(a, b) {
  const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(b) - utc(a)) / 86400000);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/** Monday-to-Sunday week containing `s`. */
export function weekBounds(s) {
  const d = parseDate(s);
  const back = (d.getDay() + 6) % 7;          // Monday = 0
  const start = addDays(s, -back);
  return { start, end: addDays(start, 6) };
}

const inRange = (s, start, end) => !!s && s >= start && s <= end;
const doneDate = (t) => (t.done_at ? localDate(new Date(t.done_at)) : '');

// ---------------------------------------------------------------- task state

export const isDone = (t) => t.status === 'done';
export const isOpen = (t) => !isDone(t);

/** Past its due date and not done. A task with no due date is never overdue. */
export function isOverdue(t, today) {
  return isOpen(t) && !!t.due_date && t.due_date < today;
}

export function daysOverdue(t, today) {
  return isOverdue(t, today) ? daysBetween(t.due_date, today) : 0;
}

/**
 * Change a task's status, keeping `done_at` honest: stamped on the way into
 * done, cleared on the way out. The weekly rollup's "shipped" column is built
 * from it, so it must reflect when the work actually finished.
 */
export function applyStatus(t, status, nowIso = new Date().toISOString()) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  if (status === 'done' && t.status !== 'done') t.done_at = nowIso;
  if (status !== 'done') t.done_at = '';
  t.status = status;
  t.updated_at = nowIso;
  return t;
}

// ---------------------------------------------------------------- lookups

export function index(tracker) {
  const cat = new Map(tracker.categories.map((c) => [c.id, c]));
  const proj = new Map(tracker.projects.map((p) => [p.id, p]));
  return {
    cat, proj,
    task: new Map(tracker.tasks.map((t) => [t.id, t])),
    categoryOf: (t) => cat.get(proj.get(t.project_id)?.category_id),
    projectOf: (t) => proj.get(t.project_id),
  };
}

// ---------------------------------------------------------------- dependencies

export const taskIndex = (tasks) => new Map(tasks.map((t) => [t.id, t]));

/** The unfinished tasks `t` is waiting on. A finished blocker blocks nothing. */
export function openBlockers(t, byId) {
  return (t.blocked_by_tasks ?? []).map((id) => byId.get(id)).filter((b) => b && isOpen(b));
}

/** Blocked because someone said so, or because it waits on unfinished work. */
export function isBlocked(t, byId) {
  return isOpen(t) && (t.status === 'blocked' || openBlockers(t, byId).length > 0);
}

/** Open tasks that can't move until `t` is done. Nothing, once `t` is done. */
export function blocking(t, tasks) {
  if (isDone(t)) return [];
  return tasks.filter((x) => isOpen(x) && (x.blocked_by_tasks ?? []).includes(t.id));
}

/** Everything waiting on `id`, directly or down a chain. */
export function dependentsOf(tasks, id) {
  const out = new Set();
  (function walk(tid) {
    for (const x of tasks) {
      if ((x.blocked_by_tasks ?? []).includes(tid) && !out.has(x.id)) { out.add(x.id); walk(x.id); }
    }
  })(id);
  return out;
}

/** Delete tasks and scrub them from every other task's waiting-on list. */
export function removeTasks(tracker, ids) {
  const gone = new Set(ids);
  tracker.tasks = tracker.tasks.filter((t) => !gone.has(t.id));
  for (const t of tracker.tasks) {
    if (t.blocked_by_tasks?.some((id) => gone.has(id))) {
      t.blocked_by_tasks = t.blocked_by_tasks.filter((id) => !gone.has(id));
    }
  }
  return tracker;
}

export const projectsIn = (tracker, categoryId) =>
  tracker.projects.filter((p) => !categoryId || p.category_id === categoryId);

// ---------------------------------------------------------------- filtering

/**
 * Filters, all optional ('' means any):
 *   owner    — contributor id; matches if they are ANY of the owners
 *   category — category id
 *   project  — project id
 *   status   — a status, 'open' (anything not done), or '' for all
 */
export function filterTasks(tracker, f = {}) {
  const { proj } = index(tracker);
  return tracker.tasks.filter((t) => {
    if (f.owner && !(t.owners ?? []).includes(f.owner)) return false;
    if (f.project && t.project_id !== f.project) return false;
    if (f.category && proj.get(t.project_id)?.category_id !== f.category) return false;
    if (f.status === 'open' && isDone(t)) return false;
    if (f.status && f.status !== 'open' && t.status !== f.status) return false;
    return true;
  });
}

/** Earliest due date first; undated last; then title, so the order is stable. */
export function sortByDue(tasks) {
  return [...tasks].sort((a, b) => {
    if (!!a.due_date !== !!b.due_date) return a.due_date ? -1 : 1;
    if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * My-tasks sections, in due-date order. Done work sinks to its own section
 * rather than sitting among open work it no longer competes with.
 */
export function bucketByDue(tasks, today) {
  const { end } = weekBounds(today);
  const out = { overdue: [], week: [], later: [], undated: [], done: [] };
  for (const t of sortByDue(tasks)) {
    if (isDone(t)) out.done.push(t);
    else if (!t.due_date) out.undated.push(t);
    else if (t.due_date < today) out.overdue.push(t);
    else if (t.due_date <= end) out.week.push(t);
    else out.later.push(t);
  }
  return out;
}

/**
 * A person's list, most urgent first. First match wins:
 *
 *   holding — unfinished work other tasks are waiting on. Leads the list,
 *             biggest hold-up first: it is what unblocks other people.
 *   overdue / week / later / undated — actionable work, by due date.
 *   waiting — blocked, so nothing to do yet. Still shown, never hidden.
 *   done
 */
export function bucketMine(tasks, today, allTasks) {
  const byId = taskIndex(allTasks);
  const { end } = weekBounds(today);
  const out = { holding: [], overdue: [], week: [], later: [], undated: [], waiting: [], done: [] };
  for (const t of sortByDue(tasks)) {
    if (isDone(t)) out.done.push(t);
    else if (blocking(t, allTasks).length) out.holding.push(t);
    else if (isBlocked(t, byId)) out.waiting.push(t);
    else if (!t.due_date) out.undated.push(t);
    else if (t.due_date < today) out.overdue.push(t);
    else if (t.due_date <= end) out.week.push(t);
    else out.later.push(t);
  }
  // Stable sort: equal hold-ups keep their due-date order.
  out.holding.sort((a, b) => blocking(b, allTasks).length - blocking(a, allTasks).length);
  return out;
}

/** Distinct open tasks held up by any of `mine` that isn't finished. */
export function heldUpBy(mine, allTasks) {
  const held = new Map();
  for (const t of mine) for (const x of blocking(t, allTasks)) held.set(x.id, x);
  return [...held.values()];
}

// ---------------------------------------------------------------- views

/**
 * Overdue work grouped by owner, most overdue first. A shared task appears
 * under every owner: each of them is on the hook for it.
 */
export function overdueByOwner(tasks, today) {
  const groups = new Map();
  for (const t of tasks.filter((x) => isOverdue(x, today))) {
    for (const o of t.owners ?? []) {
      if (!groups.has(o)) groups.set(o, []);
      groups.get(o).push(t);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => daysOverdue(b, today) - daysOverdue(a, today) || a.title.localeCompare(b.title));
  }
  return [...groups.entries()]
    .map(([owner, list]) => ({ owner, tasks: list }))
    .sort((a, b) => b.tasks.length - a.tasks.length);
}

/**
 * Contributors named in free text, excluding `except` (a task's own owners —
 * someone mentioning themselves isn't a cross-team dependency). Whole-word,
 * case-insensitive, so "Nam" does not match "Vietnam".
 */
export function mentionedContributors(text, contributors, except = []) {
  if (!text) return [];
  return contributors.filter((c) => {
    if (except.includes(c.id) || !c.name) return false;
    const name = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${name}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
  });
}

/**
 * Blocked work grouped by who it is waiting on — which is the point of this
 * view: it surfaces dependencies between people. The people come from the
 * owners of the unfinished tasks it waits on, plus any teammate named in its
 * free-text reason (under each, if several). Anything else is "something
 * else". Two groups need chasing in their own right:
 *
 *   unexplained — Blocked, with no reason and nothing linked.
 *   ready       — still marked Blocked, but everything it waited on is done.
 *
 * `allTasks` is the whole tracker: a blocker can sit outside the filtered view.
 */
export function blockedByDependency(tasks, contributors, allTasks = tasks) {
  const byId = taskIndex(allTasks);
  const people = new Map();
  const external = [];
  const unexplained = [];
  const ready = [];
  for (const t of tasks.filter((x) => isBlocked(x, byId))) {
    const owners = t.owners ?? [];
    const blockers = openBlockers(t, byId);
    const named = [...new Set([
      ...blockers.flatMap((b) => b.owners ?? []),
      ...mentionedContributors(t.blocked_by, contributors).map((c) => c.id),
    ])].filter((id) => !owners.includes(id));
    if (named.length) {
      for (const id of named) {
        if (!people.has(id)) people.set(id, []);
        people.get(id).push(t);
      }
    } else if (t.blocked_by?.trim() || blockers.length) {
      external.push(t);
    } else if ((t.blocked_by_tasks ?? []).length) {
      ready.push(t);
    } else {
      unexplained.push(t);
    }
  }
  return {
    people: [...people.entries()]
      .map(([contributor_id, list]) => ({ contributor_id, tasks: list }))
      .sort((a, b) => b.tasks.length - a.tasks.length),
    external,
    unexplained,
    ready,
  };
}

/**
 * The week containing `weekOf`:
 *
 *   due     — due this week, whatever happened to it
 *   shipped — marked done this week, whenever it was due
 *   slipped — due this week, date now passed, and not done by its due date.
 *             Tasks due later this week haven't slipped yet. Work finished
 *             late still counts as slipped (flagged `late`): it did miss.
 */
export function weeklyRollup(tasks, weekOf, today) {
  const { start, end } = weekBounds(weekOf);
  const due = sortByDue(tasks.filter((t) => inRange(t.due_date, start, end)));
  const shipped = sortByDue(tasks.filter((t) => isDone(t) && inRange(doneDate(t), start, end)));
  const slipped = due
    .filter((t) => t.due_date < today)
    .filter((t) => !isDone(t) || doneDate(t) > t.due_date)
    .map((t) => ({ task: t, late: isDone(t) }));
  return { start, end, due, shipped, slipped };
}

/** Per-owner tallies for the week, for the rollup's summary table. */
export function weeklyByOwner(rollup) {
  const acc = new Map();
  const bump = (t, key) => {
    for (const o of t.owners ?? []) {
      if (!acc.has(o)) acc.set(o, { owner: o, due: 0, shipped: 0, slipped: 0 });
      acc.get(o)[key] += 1;
    }
  };
  rollup.due.forEach((t) => bump(t, 'due'));
  rollup.shipped.forEach((t) => bump(t, 'shipped'));
  rollup.slipped.forEach((s) => bump(s.task, 'slipped'));
  return [...acc.values()].sort((a, b) => b.due - a.due || b.shipped - a.shipped);
}

// ---------------------------------------------------------------- integrity

/** Every reference resolves. Returns a list of problems; empty means valid. */
export function validateTracker(tracker, contributorIds = null) {
  const problems = [];
  const cats = new Set(tracker.categories.map((c) => c.id));
  const projs = new Set(tracker.projects.map((p) => p.id));
  const ids = new Set();
  for (const x of [...tracker.categories, ...tracker.projects, ...tracker.tasks]) {
    if (ids.has(x.id)) problems.push(`duplicate id ${x.id}`);
    ids.add(x.id);
  }
  for (const p of tracker.projects) {
    if (!cats.has(p.category_id)) problems.push(`project ${p.id} has unknown category ${p.category_id}`);
  }
  for (const t of tracker.tasks) {
    if (!projs.has(t.project_id)) problems.push(`task ${t.id} has unknown project ${t.project_id}`);
    if (!STATUSES.includes(t.status)) problems.push(`task ${t.id} has unknown status ${t.status}`);
    if (!(t.owners ?? []).length) problems.push(`task ${t.id} has no owner`);
    if (t.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(t.due_date)) problems.push(`task ${t.id} has malformed due date ${t.due_date}`);
    if (contributorIds) {
      for (const o of t.owners ?? []) {
        if (!contributorIds.includes(o)) problems.push(`task ${t.id} has unknown owner ${o}`);
      }
    }
  }
  const taskIds = new Set(tracker.tasks.map((t) => t.id));
  for (const t of tracker.tasks) {
    for (const b of t.blocked_by_tasks ?? []) {
      if (b === t.id) problems.push(`task ${t.id} waits on itself`);
      else if (!taskIds.has(b)) problems.push(`task ${t.id} waits on unknown task ${b}`);
    }
  }
  // A cycle means none of its tasks can ever start.
  for (const t of tracker.tasks) {
    if ((t.blocked_by_tasks ?? []).some((b) => b !== t.id) && dependentsOf(tracker.tasks, t.id).has(t.id)) {
      problems.push(`task ${t.id} is in a waiting-on cycle`);
    }
  }
  return problems;
}
