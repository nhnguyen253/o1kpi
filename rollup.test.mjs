/**
 * Assertions for the rollup math. Run: node rollup.test.mjs
 * No framework, no browser, no backend — this is the load-bearing logic.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  buildTree, companyShare, creditByContributor, leaves,
  weightShare, contributorMix, validateSplit, normalizeSplit, evenSplit,
  rolledStatus, subtreeLeaves,
} from './rollup.js';

const near = (a, b, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(a - b) < tol, `${msg} expected ${b}, got ${a}`);

/** Company share held by leaves with nobody assigned. Never redistributed. */
const unstaffedShare = (t) => leaves(t)
  .filter((l) => !(l.contributions ?? []).length)
  .reduce((s, l) => s + companyShare(t, l.id) * 100, 0);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const seed = JSON.parse(readFileSync(new URL('./data/seed.json', import.meta.url), 'utf8'));
const tree = buildTree(seed.nodes);

console.log('\nseed invariants');

test('leaf company shares sum to exactly 1', () => {
  near(leaves(tree).reduce((s, l) => s + companyShare(tree, l.id), 0), 1, 1e-9);
});

test('allocated credit plus unstaffed share sums to 100%', () => {
  // Operations is in the tree but nobody is assigned to it yet, so allocated
  // deliberately falls short. The gap is shown as "Unassigned" on the Credit
  // tab rather than being spread over the people who are assigned elsewhere.
  const total = creditByContributor(tree).reduce((s, c) => s + c.allocated, 0);
  near(total + unstaffedShare(tree), 100, 1e-9);
  assert.ok(unstaffedShare(tree) > 0, 'this seed should have unstaffed leaves');
});

test('no node carries a progress field any more', () => {
  for (const n of seed.nodes) {
    assert.ok(!('progress' in n), `${n.id} still has a progress field`);
  }
});

test('company shares match hand-computed values', () => {
  // Five systems at weight 1 -> a fifth each, then down the path.
  near(companyShare(tree, 'eng'), 0.2, 1e-9, 'eng');
  near(companyShare(tree, 'market'), 0.2, 1e-9, 'market');      // only child of eng
  near(companyShare(tree, 'custody'), 0.05, 1e-9, 'custody');   // 1 of market's 4
  // Credit / Risk splits between V1 and V2, so each holds half of its fifth.
  near(companyShare(tree, 'risk'), 0.2, 1e-9, 'risk');
  near(companyShare(tree, 'credit'), 0.1, 1e-9, 'credit');
  near(companyShare(tree, 'score'), 0.1 / 6, 1e-9, 'score');    // 1 of V1's 6
  // Partnerships splits three ways: traders, venues, bot builders.
  near(companyShare(tree, 'partnerships'), 0.2, 1e-9, 'partnerships');
  near(companyShare(tree, 'traders'), 0.2 / 3, 1e-9, 'traders');
  near(companyShare(tree, 'tr20'), 0.2 / 9, 1e-9, 'tr20');
  // Capital splits between the raise and the lender pool.
  near(companyShare(tree, 'capital'), 0.2, 1e-9, 'capital');
  near(companyShare(tree, 'raise'), 0.1, 1e-9, 'raise');
  near(companyShare(tree, 'r5'), 0.05, 1e-9, 'r5');
});

test('the lender pool sits beside the raise with three goals', () => {
  assert.deepEqual(tree.childrenOf.get('capital').map((n) => n.title),
    ['Capital Raise', 'Lender Pool Capital Acquisition']);
  near(companyShare(tree, 'lenderpool'), companyShare(tree, 'raise'), 1e-9, 'raise vs pool');
  assert.deepEqual(tree.childrenOf.get('lenderpool').map((n) => n.title),
    ['$1M lender pool', '$5M lender pool', '$10M lender pool']);
  // Three even goals inside a tenth.
  for (const k of tree.childrenOf.get('lenderpool')) {
    near(companyShare(tree, k.id), 0.1 / 3, 1e-9, k.id);
  }
});

test('Operations sits alongside the other systems and holds a fifth', () => {
  const ops = tree.byId.get('ops');
  assert.equal(ops.parent_id, 'root');
  near(companyShare(tree, 'ops'), 0.2, 1e-9, 'ops');
  const kids = tree.childrenOf.get('ops');
  assert.deepEqual(kids.map((k) => k.title), [
    'BD Conversation Management',
    'KPI Tree Management',
    'Accountability + Follow Through',
    'Internal Organization of 01',
  ]);
  // Four even children of a fifth -> 5% of the company each.
  for (const k of kids) near(companyShare(tree, k.id), 0.05, 1e-9, k.id);
});

test('Credit Model V2 sits beside V1 and halves it', () => {
  const v2 = tree.byId.get('creditv2');
  assert.equal(v2.parent_id, 'risk');
  assert.deepEqual(tree.childrenOf.get('risk').map((n) => n.title),
    ['Finish Credit Model V1', 'Finish Credit Model V2']);
  near(companyShare(tree, 'creditv2'), companyShare(tree, 'credit'), 1e-9, 'V1 vs V2');
  assert.deepEqual(tree.childrenOf.get('creditv2').map((n) => n.title),
    ['Add market context to model', 'Watchdog addition']);
  // Two even children of a tenth -> 5% of the company each.
  for (const k of tree.childrenOf.get('creditv2')) {
    near(companyShare(tree, k.id), 0.05, 1e-9, k.id);
  }
});

test('bot builder partnerships sit beside traders and venues', () => {
  assert.deepEqual(tree.childrenOf.get('partnerships').map((n) => n.title),
    ['Trader Acquisition', 'Venue Integrations', 'Bot Builder / Frontend Partnerships']);
  // Three even branches inside a fifth.
  for (const b of tree.childrenOf.get('partnerships')) {
    near(companyShare(tree, b.id), 0.2 / 3, 1e-9, b.id);
  }
  assert.deepEqual(tree.childrenOf.get('botbuilder').map((n) => n.title),
    ['5 partnerships', '10 partnerships', '15 partnerships']);
});

test('every leaf split totals exactly 100', () => {
  for (const l of leaves(tree)) {
    const { ok, total } = validateSplit(l.contributions);
    assert.ok(ok, `${l.id} totals ${total}`);
  }
});

test('no non-leaf carries contributions', () => {
  for (const n of seed.nodes) {
    if (subtreeLeaves(tree, n.id)[0]?.id !== n.id) {
      assert.equal((n.contributions ?? []).length, 0, `${n.id} would double-count`);
    }
  }
});

console.log('\nweights');

test('weighting a node up takes share from its siblings', () => {
  const nodes = structuredClone(seed.nodes);
  const before = buildTree(nodes);
  const baseCustody = companyShare(before, 'custody');
  const baseBackend = companyShare(before, 'backend');
  nodes.find((n) => n.id === 'custody').weight = 10;
  const after = buildTree(nodes);
  assert.ok(companyShare(after, 'custody') > baseCustody, 'custody should gain');
  assert.ok(companyShare(after, 'backend') < baseBackend, 'its siblings should give it up');
  // The parent is unchanged: reweighting inside market never leaks upward.
  near(companyShare(after, 'market'), companyShare(before, 'market'), 1e-9, 'market');
  near(leaves(after).reduce((s, l) => s + companyShare(after, l.id), 0), 1, 1e-9, 'shares');
});

test('weight 0 drops a node out of credit', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find((n) => n.id === 'capital').weight = 0;
  const t = buildTree(nodes);
  near(companyShare(t, 'capital'), 0, 1e-12, 'capital share');
  // r25's contributors keep credit only via other nodes; totals must still close.
  near(t.nodes.filter((n) => !t.childrenOf.get(n.id).length)
        .reduce((s, l) => s + companyShare(t, l.id), 0), 1, 1e-9, 'shares');
  near(creditByContributor(t).reduce((s, c) => s + c.allocated, 0) + unstaffedShare(t),
       100, 1e-9, 'allocated + unstaffed');
});

test('all-zero sibling weights fall back to an even split', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.filter((n) => n.parent_id === 'root').forEach((n) => { n.weight = 0; });
  const t = buildTree(nodes);
  near(weightShare(t, 'eng'), 0.2, 1e-9);
  near(creditByContributor(t).reduce((s, c) => s + c.allocated, 0) + unstaffedShare(t),
       100, 1e-9, 'allocated + unstaffed');
});

test('weights are relative, so scaling them all changes nothing', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.forEach((n) => { n.weight = (n.weight ?? 1) * 7; });
  const t = buildTree(nodes);
  for (const l of leaves(tree)) {
    near(companyShare(t, l.id), companyShare(tree, l.id), 1e-12, `${l.id} share`);
  }
});

console.log('\ncredit');

test('a single contributor at 100% on one leaf gets that leaf share', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find((n) => n.id === 'backend').contributions = [{ contributor_id: 'saif', pct: 100 }];
  const t = buildTree(nodes);
  const share = companyShare(t, 'backend') * 100;
  const saif = creditByContributor(t).find((c) => c.contributor_id === 'saif');
  assert.ok(saif.allocated >= share - 1e-9, 'saif must hold at least the backend share');
});

test('a not-started leaf still carries its full allocated credit', () => {
  // Credit follows weight and assignment only — how far along a node is has no
  // bearing on it, which is the whole point of dropping progress.
  const tr20 = tree.byId.get('tr20');
  assert.equal(tr20.status, 'not_started');
  assert.ok((tr20.contributions ?? []).length > 0, 'tr20 should have contributors');
  const credit = creditByContributor(tree);
  const share = companyShare(tree, 'tr20') * 100;
  for (const c of tr20.contributions) {
    const row = credit.find((r) => r.contributor_id === c.contributor_id);
    assert.ok(row.allocated >= share * (c.pct / 100) - 1e-9,
      `${c.contributor_id} should hold their tr20 share`);
  }
});

test('contributorMix is share-weighted, not a raw count', () => {
  const nodes = structuredClone(seed.nodes);
  const t0 = buildTree(nodes);
  const before = contributorMix(t0, 'market').find((c) => c.contributor_id === 'ethan').pct;
  // ux is ethan-only; making it dominate market must raise ethan's mix.
  nodes.find((n) => n.id === 'ux').weight = 20;
  const after = contributorMix(buildTree(nodes), 'market').find((c) => c.contributor_id === 'ethan').pct;
  assert.ok(after > before, `expected rise from ${before}, got ${after}`);
});

test('contributorMix totals 100 for a fully staffed subtree', () => {
  // Not 'partnerships' any more — its bot builder branch is unstaffed, so its
  // mix falls short on purpose. Only subtrees with a contributor on every leaf
  // belong in this list.
  for (const id of ['market', 'credit', 'traders', 'venues']) {
    const total = contributorMix(tree, id).reduce((s, c) => s + c.pct, 0);
    near(total, 100, 1e-6, `${id} mix`);
  }
});

test('contributorMix falls short by exactly the unstaffed share', () => {
  // Root's subtree now includes unstaffed Operations leaves, so its chips add
  // up to less than 100 — the same shortfall allocated credit shows, and for
  // the same reason. Silently scaling it back to 100 would hide the gap.
  const total = contributorMix(tree, 'root').reduce((s, c) => s + c.pct, 0);
  near(total, 100 - unstaffedShare(tree), 1e-6, 'root mix');
  near(contributorMix(tree, 'ops').reduce((s, c) => s + c.pct, 0), 0, 1e-9, 'ops mix');
});

console.log('\nsplit helpers');

test('evenSplit totals 100 for awkward counts', () => {
  for (const n of [1, 2, 3, 6, 7]) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    near(evenSplit(ids).reduce((s, c) => s + c.pct, 0), 100, 1e-9, `n=${n}`);
  }
  assert.deepEqual(evenSplit(['a', 'b', 'c']).map((c) => c.pct), [34, 33, 33]);
});

test('normalizeSplit rescales to exactly 100', () => {
  near(normalizeSplit([{ contributor_id: 'a', pct: 3 }, { contributor_id: 'b', pct: 1 }])
        .reduce((s, c) => s + c.pct, 0), 100, 1e-9);
  assert.deepEqual(
    normalizeSplit([{ contributor_id: 'a', pct: 30 }, { contributor_id: 'b', pct: 10 }]),
    [{ contributor_id: 'a', pct: 75 }, { contributor_id: 'b', pct: 25 }]
  );
  near(normalizeSplit([{ contributor_id: 'a', pct: 1 }, { contributor_id: 'b', pct: 1 },
                       { contributor_id: 'c', pct: 1 }]).reduce((s, c) => s + c.pct, 0), 100, 1e-9);
});

test('validateSplit rejects totals off 100', () => {
  assert.ok(validateSplit([{ contributor_id: 'a', pct: 100 }]).ok);
  assert.ok(!validateSplit([{ contributor_id: 'a', pct: 99 }]).ok);
  assert.ok(validateSplit([]).ok, 'empty split is allowed');
});

console.log('\nstatus + structure');

test('rolledStatus surfaces a blocked descendant', () => {
  assert.equal(rolledStatus(tree, 'market'), 'blocked', 'backend is blocked');
  assert.equal(rolledStatus(tree, 'root'), 'blocked');
});

test('rolledStatus reports done only when every leaf is done', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.filter((n) => n.parent_id === 'venues').forEach((n) => { n.status = 'done'; });
  assert.equal(rolledStatus(buildTree(nodes), 'venues'), 'done');
});

test('buildTree rejects a cycle', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find((n) => n.id === 'eng').parent_id = 'market';
  assert.throws(() => buildTree(nodes), /unreachable|cycle/i);
});

test('buildTree rejects an unknown parent', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find((n) => n.id === 'eng').parent_id = 'nope';
  assert.throws(() => buildTree(nodes), /unknown parent/i);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
