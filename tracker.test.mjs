/**
 * Assertions for the accountability tracker. Run: node tracker.test.mjs
 * Date logic is timezone-sensitive; the suite is also worth running as
 *   TZ=America/Los_Angeles node tracker.test.mjs
 *   TZ=Asia/Singapore node tracker.test.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  localDate, parseDate, daysBetween, addDays, weekBounds,
  isOverdue, daysOverdue, applyStatus, filterTasks, sortByDue, bucketByDue,
  overdueByOwner, blockedByDependency,
  weeklyRollup, weeklyByOwner, validateTracker, STATUSES,
  taskIndex, openBlockers, isBlocked, blocking, dependentsOf, removeTasks, bucketMine, heldUpBy, syncBlocked,
} from './tracker.js';
import { linkInvestorDeps } from './tracker-deps.mjs';
import { recategorise } from './tracker-recategorise.mjs';
import { applyInvestorPlan } from './tracker-investors.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const seed = JSON.parse(readFileSync(new URL('./data/seed.json', import.meta.url), 'utf8'));
const people = [
  { id: 'ethan', name: 'Ethan' }, { id: 'nam', name: 'Nam' },
  { id: 'asad', name: 'Asad' }, { id: 'francis', name: 'Francis' },
];

// Thursday 10 September 2026; its week runs Mon 7 – Sun 13.
const TODAY = '2026-09-10';
/** A done_at stamp at 3pm local time on a given date — TZ-independent. */
const doneOn = (s) => { const d = parseDate(s); d.setHours(15); return d.toISOString(); };

let n = 0;
const task = (over = {}) => ({
  id: `x${++n}`, project_id: 'p1', title: `task ${n}`, owners: ['ethan'],
  due_date: '', status: 'not_started', blocked_by: '', source: '',
  created_at: '', updated_at: '', done_at: '', ...over,
});
const trackerOf = (tasks) => ({
  categories: [{ id: 'c1', title: 'C1' }, { id: 'c2', title: 'C2' }],
  projects: [{ id: 'p1', category_id: 'c1', title: 'P1' }, { id: 'p2', category_id: 'c2', title: 'P2' }],
  tasks,
});

console.log('\ndates');

test('parseDate lands on the calendar day it names, in any timezone', () => {
  // new Date('2026-09-10') would be UTC midnight: the 9th, west of Greenwich.
  assert.equal(localDate(parseDate('2026-09-10')), '2026-09-10');
  assert.equal(parseDate('2026-09-10').getDate(), 10);
});

test('daysBetween counts calendar days, across month, year and DST', () => {
  assert.equal(daysBetween('2026-09-10', '2026-09-10'), 0);
  assert.equal(daysBetween('2026-09-08', '2026-09-10'), 2);
  assert.equal(daysBetween('2026-09-10', '2026-09-08'), -2);
  assert.equal(daysBetween('2026-08-30', '2026-09-02'), 3);
  assert.equal(daysBetween('2026-12-30', '2027-01-02'), 3);
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2);   // US DST ends Nov 1
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);   // EU DST starts Mar 29
});

test('addDays crosses month ends', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('weeks run Monday to Sunday', () => {
  assert.deepEqual(weekBounds('2026-09-10'), { start: '2026-09-07', end: '2026-09-13' });
  assert.deepEqual(weekBounds('2026-09-07'), { start: '2026-09-07', end: '2026-09-13' }); // Monday
  assert.deepEqual(weekBounds('2026-09-13'), { start: '2026-09-07', end: '2026-09-13' }); // Sunday
  assert.deepEqual(weekBounds('2026-12-31'), { start: '2026-12-28', end: '2027-01-03' });
});

console.log('\ntask state');

test('overdue means past due and not done', () => {
  assert.ok(isOverdue(task({ due_date: '2026-09-09' }), TODAY));
  assert.ok(!isOverdue(task({ due_date: TODAY }), TODAY), 'due today is not overdue yet');
  assert.ok(!isOverdue(task({ due_date: '2026-09-01', status: 'done' }), TODAY));
  assert.ok(!isOverdue(task({ due_date: '' }), TODAY), 'undated work is never overdue');
  assert.equal(daysOverdue(task({ due_date: '2026-09-03' }), TODAY), 7);
});

test('applyStatus stamps done_at on the way into done and clears it on the way out', () => {
  const t = task();
  applyStatus(t, 'in_progress', '2026-09-08T10:00:00.000Z');
  assert.equal(t.done_at, '');
  applyStatus(t, 'done', '2026-09-09T10:00:00.000Z');
  assert.equal(t.done_at, '2026-09-09T10:00:00.000Z');
  applyStatus(t, 'done', '2026-09-10T10:00:00.000Z');
  assert.equal(t.done_at, '2026-09-09T10:00:00.000Z', 're-saving done keeps the original stamp');
  applyStatus(t, 'blocked', '2026-09-10T11:00:00.000Z');
  assert.equal(t.done_at, '', 'reopened work is not shipped');
  assert.throws(() => applyStatus(t, 'finished'), /unknown status/);
});

console.log('\nfilters and sorting');

test('an owner filter matches any of several owners', () => {
  const shared = task({ owners: ['asad', 'nam'] });
  const tr = trackerOf([shared, task({ owners: ['ethan'] })]);
  assert.deepEqual(filterTasks(tr, { owner: 'nam' }), [shared]);
  assert.deepEqual(filterTasks(tr, { owner: 'asad' }), [shared]);
});

test('category filters through the project; status understands "open"', () => {
  const a = task({ project_id: 'p1' });
  const b = task({ project_id: 'p2', status: 'done' });
  const c = task({ project_id: 'p2', status: 'blocked' });
  const tr = trackerOf([a, b, c]);
  assert.deepEqual(filterTasks(tr, { category: 'c2' }), [b, c]);
  assert.deepEqual(filterTasks(tr, { status: 'open' }), [a, c]);
  assert.deepEqual(filterTasks(tr, { status: 'done' }), [b]);
  assert.deepEqual(filterTasks(tr, { category: 'c2', status: 'open' }), [c]);
  assert.equal(filterTasks(tr, {}).length, 3, 'no filter keeps everything');
});

test('sorting puts the earliest due first and undated work last', () => {
  const late = task({ title: 'late', due_date: '2026-09-20' });
  const soon = task({ title: 'soon', due_date: '2026-09-11' });
  const none = task({ title: 'none' });
  assert.deepEqual(sortByDue([none, late, soon]).map((t) => t.title), ['soon', 'late', 'none']);
});

test('my-tasks buckets follow the due date, with done set aside', () => {
  const b = bucketByDue([
    task({ title: 'past', due_date: '2026-09-08' }),
    task({ title: 'today', due_date: TODAY }),
    task({ title: 'sunday', due_date: '2026-09-13' }),
    task({ title: 'next week', due_date: '2026-09-14' }),
    task({ title: 'undated' }),
    task({ title: 'finished', due_date: '2026-09-08', status: 'done' }),
  ], TODAY);
  const titles = (l) => l.map((t) => t.title);
  assert.deepEqual(titles(b.overdue), ['past']);
  assert.deepEqual(titles(b.week), ['today', 'sunday']);
  assert.deepEqual(titles(b.later), ['next week']);
  assert.deepEqual(titles(b.undated), ['undated']);
  assert.deepEqual(titles(b.done), ['finished'], 'done work is not overdue');
});

console.log('\noverdue');

test('overdue groups by owner, and a shared task lands under each owner', () => {
  const shared = task({ owners: ['asad', 'nam'], due_date: '2026-09-01' });
  const namOnly = task({ owners: ['nam'], due_date: '2026-09-09' });
  const groups = overdueByOwner([shared, namOnly, task({ due_date: '2026-09-20' })], TODAY);
  const byOwner = Object.fromEntries(groups.map((g) => [g.owner, g.tasks]));
  assert.deepEqual(byOwner.asad, [shared]);
  assert.deepEqual(byOwner.nam, [shared, namOnly], 'most overdue first');
  assert.equal(groups[0].owner, 'nam', 'owner with the most overdue leads');
  assert.ok(!byOwner.ethan, 'nothing of ethan\'s is overdue');
});

console.log('\nblocked');


test('blocked work files under the owners of the tasks it waits on', () => {
  const doc = task({ id: 'doc', owners: ['nam', 'asad'] });
  const sim = task({ id: 'sim', owners: ['nam'] });
  const a = task({ id: 'a', owners: ['ethan'], blocked_by_tasks: ['doc'] });
  const b = task({ id: 'b', owners: ['francis'], blocked_by_tasks: ['sim'] });
  const picked = task({ id: 'p', owners: ['ethan'], status: 'blocked' });   // Blocked, nothing picked
  const free = task({ id: 'f', owners: ['ethan'], blocked_by_tasks: ['gone'] });
  const all = [doc, sim, a, b, picked, free];
  const g = blockedByDependency([a, b, picked, free], all);
  const by = Object.fromEntries(g.people.map((x) => [x.contributor_id, x.tasks.map((t) => t.id)]));
  assert.deepEqual(by, { nam: ['a', 'b'], asad: ['a'] }, 'the block goes to each blocker owner');
  assert.deepEqual(g.unexplained.map((t) => t.id), ['p'], 'Blocked with nothing picked is chased');
});

console.log('\nweekly rollup');

test('due, shipped and slipped each mean what they say', () => {
  const doneOnTime = task({ title: 'on time', due_date: '2026-09-08', status: 'done', done_at: doneOn('2026-09-08') });
  const doneLate = task({ title: 'late', due_date: '2026-09-08', status: 'done', done_at: doneOn('2026-09-10') });
  const missed = task({ title: 'missed', due_date: '2026-09-09' });
  const pending = task({ title: 'friday', due_date: '2026-09-11' });
  const early = task({ title: 'early', due_date: '2026-09-25', status: 'done', done_at: doneOn('2026-09-09') });
  const lastWeek = task({ title: 'last week', due_date: '2026-09-02', status: 'done', done_at: doneOn('2026-09-03') });
  const r = weeklyRollup([doneOnTime, doneLate, missed, pending, early, lastWeek], TODAY, TODAY);
  const titles = (l) => l.map((t) => t.title);

  assert.equal(r.start, '2026-09-07');
  assert.equal(r.end, '2026-09-13');
  assert.deepEqual(titles(r.due), ['late', 'on time', 'missed', 'friday']);
  assert.deepEqual(titles(r.shipped).sort(), ['early', 'late', 'on time'],
    'shipped is whatever finished this week, whenever it was due');
  assert.deepEqual(r.slipped.map((s) => [s.task.title, s.late]), [['late', true], ['missed', false]],
    'due Friday has not slipped on Thursday; done late still slipped');
});

test('a past week counts every miss, since all its due dates have passed', () => {
  const missed = task({ due_date: '2026-09-04' });
  const r = weeklyRollup([missed], '2026-09-02', TODAY);
  assert.deepEqual(r.slipped.map((s) => s.task), [missed]);
});

test('the per-owner tally credits every owner of a shared task', () => {
  const r = weeklyRollup([
    task({ owners: ['asad', 'nam'], due_date: '2026-09-08', status: 'done', done_at: doneOn('2026-09-08') }),
    task({ owners: ['nam'], due_date: '2026-09-09' }),
  ], TODAY, TODAY);
  const tally = Object.fromEntries(weeklyByOwner(r).map((x) => [x.owner, x]));
  assert.deepEqual(tally.nam, { owner: 'nam', due: 2, shipped: 1, slipped: 1 });
  assert.deepEqual(tally.asad, { owner: 'asad', due: 1, shipped: 1, slipped: 0 });
});

console.log('\nintegrity');

test('validateTracker catches every broken reference', () => {
  const bad = trackerOf([
    task({ project_id: 'nope' }),
    task({ owners: [] }),
    task({ status: 'finished' }),
    task({ due_date: '10/09/2026' }),
    task({ owners: ['ghost'] }),
  ]);
  bad.projects.push({ id: 'p9', category_id: 'missing', title: 'orphan' });
  const problems = validateTracker(bad, ['ethan']).join('\n');
  for (const want of ['unknown project', 'no owner', 'unknown status', 'malformed due date',
    'unknown owner ghost', 'unknown category']) {
    assert.ok(problems.includes(want), `expected "${want}" in:\n${problems}`);
  }
  assert.deepEqual(validateTracker(trackerOf([task()]), ['ethan']), []);
});

console.log('\nseed');

test('the seed is valid and every owner is a real contributor', () => {
  assert.deepEqual(validateTracker(seed.tracker, seed.contributors.map((c) => c.id)), []);
});

test('the seed has the categories, projects and tasks that were specified', () => {
  const tr = seed.tracker;
  assert.deepEqual(tr.categories.map((c) => c.title), [
    'Credit Model', 'Marketplace', 'Pool Investors', 'VC Investors', 'Trader Acquisition',
    'Bot Building Partnerships', 'Frontend Terminals', 'Venue Partnerships', 'Company',
  ]);
  assert.equal(tr.projects.length, 11);
  assert.equal(tr.tasks.length, 22);
  const owned = (id) => filterTasks(tr, { owner: id }).length;
  assert.deepEqual([owned('ethan'), owned('pmt0z6mh6'), owned('nam'), owned('francis')], [10, 6, 6, 3]);
});

test('shared tasks carry both owners', () => {
  for (const title of ['Sync on tech', 'Technical docs without NDA', 'Technical docs with NDA']) {
    const t = seed.tracker.tasks.find((x) => x.title === title);
    assert.deepEqual([...t.owners].sort(), ['nam', 'pmt0z6mh6'], title);
  }
});

test('the seed invents nothing: no dates, no sources, and only declared blocks', () => {
  for (const t of seed.tracker.tasks) {
    assert.equal(t.due_date, '', `${t.title} has an invented due date`);
    assert.equal(t.source, '', `${t.title} has an invented source`);
    assert.ok(['not_started', 'blocked'].includes(t.status), `${t.title} has an invented status`);
    if (t.status === 'blocked') assert.ok(t.blocked_by_tasks.length, `${t.title} is blocked without a blocking task`);
    assert.ok(!('blocked_by' in t), `${t.title} still has a free-text reason`);
  }
});

console.log('\ninvestor docs');

test('Tech sync is marketplace work, not the credit model', () => {
  const p = seed.tracker.projects.find((x) => x.title === 'Tech sync');
  assert.equal(seed.tracker.categories.find((c) => c.id === p.category_id).title, 'Marketplace');
});

test('every investor send is blocked on the docs, and waits on the people who own them', () => {
  const sends = seed.tracker.tasks.filter((t) => /^(Send |Proxima)/.test(t.title));
  assert.equal(sends.length, 5);
  for (const t of sends) {
    assert.equal(t.status, 'blocked', t.title);
    assert.deepEqual(t.owners, ['ethan'], t.title);
  }
  const g = blockedByDependency(seed.tracker.tasks);
  const waiting = Object.fromEntries(g.people.map((p) => [p.contributor_id, p.tasks.length]));
  assert.deepEqual(waiting, { pmt0z6mh6: 5, nam: 5 }, 'the Blocked view routes all five to the doc owners');
});

test('dual VC-and-pool investors file under Pool Investors', () => {
  const { categoryOf } = (() => { const cat = new Map(seed.tracker.categories.map((c) => [c.id, c]));
    const proj = new Map(seed.tracker.projects.map((p) => [p.id, p]));
    return { categoryOf: (t) => cat.get(proj.get(t.project_id).category_id).title }; })();
  const where = (s) => categoryOf(seed.tracker.tasks.find((t) => t.title.includes(s)));
  assert.deepEqual(['Proxima', 'Galaxy', 'DWF', 'MH Ventures', 'Avantis'].map(where),
    ['VC Investors', 'Pool Investors', 'Pool Investors', 'Pool Investors', 'Venue Partnerships']);
});

test('the investor plan is idempotent', () => {
  const again = structuredClone(seed.tracker);
  assert.deepEqual(applyInvestorPlan(again), []);
  assert.deepEqual(again, seed.tracker);
});

test('no category links into the KPI tree — they are different things', () => {
  for (const c of seed.tracker.categories) assert.equal(c.kpi_node_id, '', `${c.title} still links to ${c.kpi_node_id}`);
});

console.log('\nrecategorise');

test('recategorising leaves every project and task exactly as it was', () => {
  const before = structuredClone(seed.tracker);
  before.categories = [{ id: 'tc_credit', title: 'Credit model', kpi_node_id: 'risk' },
    { id: 'tc_company', title: 'Company', kpi_node_id: 'ops' }];
  before.projects = before.projects.filter((p) => ['tc_credit', 'tc_company'].includes(p.category_id));
  before.tasks = before.tasks.filter((t) => before.projects.some((p) => p.id === t.project_id));
  before.tasks[0].status = 'in_progress';      // work the team did since the seed
  const after = recategorise(structuredClone(before));
  assert.deepEqual(after.projects, before.projects);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(validateTracker(after), []);
});

test('recategorising reuses a same-named category, keeps extras last, and is idempotent', () => {
  const tr = { projects: [], tasks: [], categories: [
    { id: 'custom', title: 'Legal', kpi_node_id: '' },
    { id: 'byhand', title: 'marketplace', kpi_node_id: 'eng' },
  ] };
  const once = recategorise(tr);
  assert.equal(once.categories.filter((c) => c.title === 'Marketplace').length, 1, 'no duplicate');
  assert.equal(once.categories.find((c) => c.title === 'Marketplace').id, 'byhand', 'the existing one is reused');
  assert.equal(once.categories.at(-1).title, 'Legal', 'categories not on the list stay, at the end');
  assert.ok(once.categories.every((c) => c.kpi_node_id === ''));
  const twice = recategorise(structuredClone(once));
  assert.deepEqual(twice, once);
});

test('the status list matches the KPI tree\'s', () => {
  assert.deepEqual(STATUSES, ['not_started', 'in_progress', 'blocked', 'done']);
});

console.log('\ndependencies');

test('a task is blocked by an unfinished blocker, and freed when it is done', () => {
  const doc = task({ id: 'doc', owners: ['nam'] });
  const send = task({ id: 'send', owners: ['ethan'], blocked_by_tasks: ['doc'] });
  const all = [doc, send];
  assert.ok(isBlocked(send, taskIndex(all)), 'blocked by a link, though its status says Not started');
  assert.deepEqual(blocking(doc, all), [send], 'and the doc knows what it holds up');
  doc.status = 'done';
  assert.ok(!isBlocked(send, taskIndex(all)), 'a finished blocker blocks nothing');
  assert.deepEqual(blocking(doc, all), [], 'a finished task holds nothing up');
  assert.deepEqual(openBlockers(send, taskIndex(all)), []);
});

test('a status of Blocked still counts, with or without links', () => {
  assert.ok(isBlocked(task({ status: 'blocked' }), new Map()));
  assert.ok(!isBlocked(task({ status: 'done', blocked_by_tasks: ['x'] }), new Map()), 'done is never blocked');
});

test('dependents are found down a chain', () => {
  const all = [task({ id: 'a' }), task({ id: 'b', blocked_by_tasks: ['a'] }), task({ id: 'c', blocked_by_tasks: ['b'] })];
  assert.deepEqual([...dependentsOf(all, 'a')].sort(), ['b', 'c']);
});

test('validation refuses self-links, dangling links and loops', () => {
  const selfy = trackerOf([task({ id: 's', blocked_by_tasks: ['s'] })]);
  assert.ok(validateTracker(selfy).some((p) => p.includes('waits on itself')));
  const dangling = trackerOf([task({ id: 'd', blocked_by_tasks: ['ghost'] })]);
  assert.ok(validateTracker(dangling).some((p) => p.includes('unknown task ghost')));
  const loop = trackerOf([task({ id: 'a', blocked_by_tasks: ['b'] }), task({ id: 'b', blocked_by_tasks: ['a'] })]);
  assert.ok(validateTracker(loop).some((p) => p.includes('cycle')));
});

test('deleting a task takes it off every waiting-on list', () => {
  const tr = trackerOf([task({ id: 'doc' }), task({ id: 'send', blocked_by_tasks: ['doc', 'other'] }), task({ id: 'other' })]);
  removeTasks(tr, ['doc']);
  assert.deepEqual(tr.tasks.map((t) => t.id), ['send', 'other']);
  assert.deepEqual(tr.tasks[0].blocked_by_tasks, ['other']);
  assert.deepEqual(validateTracker(tr), []);
});

test('my list leads with what holds others up and ends with what waits on others', () => {
  const big = task({ id: 'big', title: 'big', owners: ['nam'] });
  const small = task({ id: 'small', title: 'small', owners: ['nam'], due_date: '2026-09-01' });
  const plain = task({ id: 'plain', title: 'plain', owners: ['nam'], due_date: TODAY });
  const stuck = task({ id: 'stuck', title: 'stuck', owners: ['nam'], blocked_by_tasks: ['x'] });
  const x = task({ id: 'x', owners: ['asad'] });
  const others = [1, 2, 3].map((i) => task({ id: `o${i}`, owners: ['ethan'], blocked_by_tasks: i < 3 ? ['big'] : ['small'] }));
  const all = [big, small, plain, stuck, x, ...others];
  const b = bucketMine([big, small, plain, stuck], TODAY, all);
  assert.deepEqual(b.holding.map((t) => t.title), ['big', 'small'], 'biggest hold-up first, even undated');
  assert.deepEqual(b.overdue, [], 'an overdue task holding people up sits in holding');
  assert.deepEqual(b.week.map((t) => t.title), ['plain']);
  assert.deepEqual(b.waiting.map((t) => t.title), ['stuck']);
  assert.equal(heldUpBy([big, small], all).length, 3, 'distinct tasks held up');
});

test('picking a blocker blocks the task; finishing it restores what it was', () => {
  const doc = task({ id: 'doc', owners: ['nam'] });
  const send = task({ id: 'send', owners: ['ethan'], status: 'in_progress', blocked_by_tasks: ['doc'] });
  const tr = trackerOf([doc, send]);
  let moved = syncBlocked(tr);
  assert.equal(send.status, 'blocked', 'blocked as soon as it waits on unfinished work');
  assert.equal(send.status_before_block, 'in_progress');
  assert.deepEqual(moved.map((m) => [m.task.id, m.from, m.to]), [['send', 'in_progress', 'blocked']]);
  applyStatus(doc, 'done');
  moved = syncBlocked(tr);
  assert.equal(send.status, 'in_progress', 'released back to what it was');
  assert.deepEqual(moved.map((m) => [m.from, m.to]), [['blocked', 'in_progress']]);
  applyStatus(doc, 'in_progress');                   // the blocker is reopened
  syncBlocked(tr);
  assert.equal(send.status, 'blocked', 'and blocked again');
  assert.deepEqual(syncBlocked(tr), [], 'idempotent');
});

test('sync never touches finished work or a Blocked task with nothing picked', () => {
  const lone = task({ id: 'lone', status: 'blocked' });
  const done = task({ id: 'done', status: 'done', blocked_by_tasks: ['x'] });
  const x = task({ id: 'x' });
  const tr = trackerOf([lone, done, x]);
  assert.deepEqual(syncBlocked(tr), []);
  assert.equal(lone.status, 'blocked');
  assert.equal(done.status, 'done');
});

console.log('\nseed dependencies');

test('every investor send links the doc tasks it needs', () => {
  const byTitle = (s) => seed.tracker.tasks.find((t) => t.title.includes(s));
  const deps = (s) => byTitle(s).blocked_by_tasks.map((id) => seed.tracker.tasks.find((t) => t.id === id).title).sort();
  assert.deepEqual(deps('Proxima'), ['Technical docs without NDA']);
  assert.deepEqual(deps('Avantis'), ['Technical docs without NDA']);
  assert.ok(!('blocked_by' in byTitle('Avantis')), 'no free-text reasons remain');
  assert.deepEqual(deps('Galaxy'), ['Technical docs with NDA', 'Technical docs without NDA']);
  assert.deepEqual(deps('DWF'), ['Lender pool return simulation', 'Technical docs with NDA', 'Technical docs without NDA']);
  assert.equal(deps('MH Ventures').length, 3);
});

test('Nam and Asad each see the five sends they are holding up', () => {
  const all = seed.tracker.tasks;
  const mine = (id) => all.filter((t) => t.owners.includes(id));
  assert.equal(heldUpBy(mine('nam'), all).length, 5);
  assert.equal(heldUpBy(mine('pmt0z6mh6'), all).length, 5);
  const count = (s) => blocking(all.find((t) => t.title === s), all).length;
  assert.deepEqual([count('Technical docs without NDA'), count('Technical docs with NDA'), count('Lender pool return simulation')], [4, 3, 2]);
  const b = bucketMine(mine('nam'), TODAY, all);
  assert.deepEqual(b.holding.map((t) => t.title),
    ['Technical docs without NDA', 'Technical docs with NDA', 'Lender pool return simulation'], 'biggest hold-up first');
});

test('finishing the docs frees every send, automatically', () => {
  const tr = structuredClone(seed.tracker);
  for (const t of tr.tasks) if (['tt05', 'tt_docs_nda', 'tt_pool_sim', 'tt06'].includes(t.id)) applyStatus(t, 'done');
  const moved = syncBlocked(tr);
  assert.equal(moved.length, 5, 'all five sends released');
  assert.ok(tr.tasks.filter((t) => t.id.startsWith('tt_send')).every((t) => t.status === 'not_started'));
  const g = blockedByDependency(tr.tasks);
  assert.equal(g.people.length + g.unexplained.length, 0, 'nothing left blocked');
});

test('linking the investor dependencies is idempotent', () => {
  const again = structuredClone(seed.tracker);
  assert.deepEqual(linkInvestorDeps(again), []);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
