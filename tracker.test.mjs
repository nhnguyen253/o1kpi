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
  overdueByOwner, mentionedContributors, blockedByDependency,
  weeklyRollup, weeklyByOwner, validateTracker, STATUSES,
} from './tracker.js';
import { recategorise } from './tracker-recategorise.mjs';

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

test('name mentions are whole-word, case-insensitive, and skip the owners', () => {
  const names = (l) => l.map((c) => c.name);
  assert.deepEqual(names(mentionedContributors('waiting on nam for the API', people)), ['Nam']);
  assert.deepEqual(names(mentionedContributors('the Vietnam desk', people)), [], 'not a substring match');
  assert.deepEqual(names(mentionedContributors('Nam and Asad to agree', people, ['nam'])), ['Asad']);
  assert.deepEqual(mentionedContributors('', people), []);
});

test('blocked work groups by who or what it waits on', () => {
  const onNam = task({ owners: ['ethan'], status: 'blocked', blocked_by: 'Nam to ship the scoring API' });
  const onBoth = task({ owners: ['francis'], status: 'blocked', blocked_by: 'sign-off from Asad and Nam' });
  const external = task({ status: 'blocked', blocked_by: 'Aster legal review' });
  const silent = task({ status: 'blocked', blocked_by: '  ' });
  const self = task({ owners: ['nam'], status: 'blocked', blocked_by: 'Nam needs a GPU box' });
  const notBlocked = task({ status: 'in_progress', blocked_by: 'Nam' });
  const g = blockedByDependency([onNam, onBoth, external, silent, self, notBlocked], people);
  const people_ = Object.fromEntries(g.people.map((x) => [x.contributor_id, x.tasks]));
  assert.deepEqual(people_.nam, [onNam, onBoth]);
  assert.deepEqual(people_.asad, [onBoth], 'naming two people files under both');
  assert.deepEqual(g.external, [external, self], 'naming only yourself is not a dependency');
  assert.deepEqual(g.unexplained, [silent], 'blank reasons are their own group');
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
  assert.equal(tr.projects.length, 9);
  assert.equal(tr.tasks.length, 15);
  const owned = (id) => filterTasks(tr, { owner: id }).length;
  assert.deepEqual([owned('ethan'), owned('pmt0z6mh6'), owned('nam'), owned('francis')], [5, 5, 4, 3]);
});

test('shared tasks carry both owners', () => {
  for (const title of ['Sync on tech', 'Technical documents to send to investors']) {
    const t = seed.tracker.tasks.find((x) => x.title === title);
    assert.deepEqual([...t.owners].sort(), ['nam', 'pmt0z6mh6'], title);
  }
});

test('the seed invents nothing: no dates, no statuses, no sources', () => {
  for (const t of seed.tracker.tasks) {
    assert.equal(t.due_date, '', `${t.title} has an invented due date`);
    assert.equal(t.status, 'not_started', `${t.title} has an invented status`);
    assert.equal(t.source, '', `${t.title} has an invented source`);
  }
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
