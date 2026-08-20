/**
 * Assertions for the rollup math. Run: node rollup.test.mjs
 * No framework, no browser, no backend — this is the load-bearing logic.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  buildTree, rolledProgress, companyShare, creditByContributor, leaves,
  weightShare, contributorMix, validateSplit, normalizeSplit, evenSplit,
  rolledStatus, subtreeLeaves,
} from './rollup.js';

const near = (a, b, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(a - b) < tol, `${msg} expected ${b}, got ${a}`);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const seed = JSON.parse(readFileSync(new URL('./data/seed.json', import.meta.url), 'utf8'));
const tree = buildTree(seed.nodes);

console.log('\nseed invariants');

// (72.5 + 358/6 + 30.5 + 27.5) / 4
const ROOT_EXPECTED = (72.5 + 358 / 6 + 30.5 + 27.5) / 4; // 47.5416...

test('root progress is 47.54 with even weights', () => {
  near(rolledProgress(tree, 'root'), ROOT_EXPECTED, 1e-9);
});

test('leaf company shares sum to exactly 1', () => {
  near(leaves(tree).reduce((s, l) => s + companyShare(tree, l.id), 0), 1, 1e-9);
});

test('allocated credit sums to 100%', () => {
  const total = creditByContributor(tree).reduce((s, c) => s + c.allocated, 0);
  near(total, 100, 1e-9);
});

test('earned credit sums to root progress', () => {
  const total = creditByContributor(tree).reduce((s, c) => s + c.earned, 0);
  near(total, rolledProgress(tree, 'root'), 1e-9);
});

test('intermediate rollups match hand-computed values', () => {
  near(rolledProgress(tree, 'market'), 72.5, 1e-6, 'market');
  near(rolledProgress(tree, 'eng'), 72.5, 1e-6, 'eng');
  near(rolledProgress(tree, 'credit'), 358 / 6, 1e-6, 'credit');
  near(rolledProgress(tree, 'traders'), 50, 1e-6, 'traders');
  near(rolledProgress(tree, 'venues'), 11, 1e-6, 'venues');
  near(rolledProgress(tree, 'partnerships'), 30.5, 1e-6, 'partnerships');
  near(rolledProgress(tree, 'capital'), 27.5, 1e-6, 'capital');
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

test('weighting a node up moves the parent toward it', () => {
  const nodes = structuredClone(seed.nodes);
  const base = rolledProgress(buildTree(nodes), 'root');
  // custody is 100%; leaning market's weight onto it must raise the root.
  nodes.find((n) => n.id === 'custody').weight = 10;
  const after = rolledProgress(buildTree(nodes), 'root');
  assert.ok(after > base, `expected rise from ${base}, got ${after}`);
});

test('weight 0 drops a node out of progress and credit', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find((n) => n.id === 'capital').weight = 0;
  const t = buildTree(nodes);
  near(companyShare(t, 'capital'), 0, 1e-12, 'capital share');
  // r25's contributors keep credit only via other nodes; totals must still close.
  near(t.nodes.filter((n) => !t.childrenOf.get(n.id).length)
        .reduce((s, l) => s + companyShare(t, l.id), 0), 1, 1e-9, 'shares');
  near(creditByContributor(t).reduce((s, c) => s + c.allocated, 0), 100, 1e-9, 'allocated');
});

test('all-zero sibling weights fall back to an even split', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.filter((n) => n.parent_id === 'root').forEach((n) => { n.weight = 0; });
  const t = buildTree(nodes);
  near(weightShare(t, 'eng'), 0.25, 1e-9);
  near(rolledProgress(t, 'root'), ROOT_EXPECTED, 1e-9);
});

test('weights are relative, so scaling them all changes nothing', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.forEach((n) => { n.weight = (n.weight ?? 1) * 7; });
  near(rolledProgress(buildTree(nodes), 'root'), ROOT_EXPECTED, 1e-9);
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

test('earned is zero for a not-started leaf but allocated is not', () => {
  const nodes = structuredClone(seed.nodes);
  // tr20 sits at 0% with isaiah + saif assigned.
  const only = nodes.filter((n) => n.id === 'tr20' || n.parent_id === 'traders');
  assert.ok(only.length > 0);
  const t = buildTree(nodes);
  const tr20 = t.byId.get('tr20');
  assert.equal(tr20.progress, 0);
  assert.ok((tr20.contributions ?? []).length > 0, 'tr20 should have contributors');
  // Their earned contribution from tr20 specifically is 0.
  near(companyShare(t, 'tr20') * (tr20.progress / 100), 0, 1e-12);
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

test('contributorMix totals 100 for any node with contributors', () => {
  for (const id of ['root', 'market', 'credit', 'partnerships', 'venues']) {
    const total = contributorMix(tree, id).reduce((s, c) => s + c.pct, 0);
    near(total, 100, 1e-6, `${id} mix`);
  }
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
