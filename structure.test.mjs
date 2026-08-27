import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildTree, creditByContributor, leaves, companyShare, contributorMix, normalizeSplit } from './rollup.js';

const seed = JSON.parse(readFileSync('./data/seed.json','utf8'));
let pass = 0;
const t = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n);}catch(e){ console.error('  FAIL '+n+'\n       '+e.message); process.exitCode=1; } };
const near=(a,b,tol=1e-9,m='')=>assert.ok(Math.abs(a-b)<tol, `${m} expected ${b} got ${a}`);

/** Company share held by leaves with nobody assigned. Never redistributed. */
const unstaffedShare = (t) => leaves(t)
  .filter(l => !(l.contributions ?? []).length)
  .reduce((s,l) => s + companyShare(t,l.id)*100, 0);
/** Allocated credit and the unassigned remainder must always close to 100. */
const totalsClose = (t,m='') =>
  near(creditByContributor(t).reduce((s,c)=>s+c.allocated,0) + unstaffedShare(t), 100, 1e-9, m);

// Mirror of addChildNode from app.js
function addChild(nodes, parentId, title) {
  const tree = buildTree(nodes);
  const parent = nodes.find(n=>n.id===parentId);
  const first = (tree.childrenOf.get(parentId)??[]).length===0;
  const child = { id:'x'+nodes.length, parent_id:parentId, type:'milestone', title,
                  weight:1, status:'not_started', target_date:'', notes:'', contributions:[] };
  if (first) {
    child.status = parent.status;
    child.contributions = parent.contributions ?? [];
    parent.contributions = [];
  }
  nodes.push(child);
  return child;
}

console.log('\nadd child');
t('first child under a leaf leaves every number unchanged', () => {
  const nodes = structuredClone(seed.nodes);
  const beforeTree = buildTree(nodes);
  const beforeBackend = companyShare(beforeTree,'backend');
  const beforeCredit = creditByContributor(beforeTree);
  addChild(nodes,'backend','API endpoints');
  const tree = buildTree(nodes);
  // The child now holds the whole of what the parent held.
  near(companyShare(tree,'backend'), beforeBackend, 1e-9, 'backend share');
  near(companyShare(tree,nodes[nodes.length-1].id), beforeBackend, 1e-9, 'child share');
  const after = creditByContributor(tree);
  for (const b of beforeCredit) {
    const a = after.find(x=>x.contributor_id===b.contributor_id);
    near(a.allocated, b.allocated, 1e-9, b.contributor_id+' allocated');
  }
});
t('parent stops holding contributions once it has a child', () => {
  const nodes = structuredClone(seed.nodes);
  addChild(nodes,'backend','API endpoints');
  assert.equal(nodes.find(n=>n.id==='backend').contributions.length, 0);
});
t('a second child halves what the first one holds', () => {
  const nodes = structuredClone(seed.nodes);
  const parentShare = companyShare(buildTree(nodes),'backend');
  const a = addChild(nodes,'backend','API endpoints');   // inherits the split
  const b = addChild(nodes,'backend','Webhooks');        // starts unstaffed
  const tree = buildTree(nodes);
  near(companyShare(tree,a.id), parentShare/2, 1e-9, 'first child');
  near(companyShare(tree,b.id), parentShare/2, 1e-9, 'second child');
});
t('new empty nodes leave credit unallocated, not miscounted', () => {
  const nodes = structuredClone(seed.nodes);
  addChild(nodes,'backend','a'); addChild(nodes,'backend','b'); addChild(nodes,'r5','c');
  const tree = buildTree(nodes);
  near(leaves(tree).reduce((s,l)=>s+companyShare(tree,l.id),0), 1, 1e-9, 'shares still sum to 1');
  // 'b' and 'c' have no contributors yet, so their share of the company belongs
  // to nobody. Allocated must fall short by exactly the share of unstaffed
  // leaves — never silently redistribute it.
  totalsClose(tree, 'allocated + unstaffed');
  assert.ok(unstaffedShare(tree) > 0, 'this fixture should have unstaffed leaves');
});

console.log('\ndelete + move');
const subtreeIds=(tree,id)=>{const o=[];(function w(n){o.push(n);(tree.childrenOf.get(n)??[]).forEach(c=>w(c.id));})(id);return o;};
t('deleting a subtree removes exactly its descendants', () => {
  const nodes = structuredClone(seed.nodes);
  const doomed = new Set(subtreeIds(buildTree(nodes),'venues'));
  assert.equal(doomed.size, 4);   // venues + v3 + v6 + v9
  const left = nodes.filter(n=>!doomed.has(n.id));
  const tree = buildTree(left);
  near(leaves(tree).reduce((s,l)=>s+companyShare(tree,l.id),0), 1, 1e-9, 'shares still sum to 1');
  totalsClose(tree, 'totals still closed');
});
t('moving a node keeps the tree valid and totals closed', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find(n=>n.id==='backtest').parent_id = 'eng';
  const tree = buildTree(nodes);
  near(leaves(tree).reduce((s,l)=>s+companyShare(tree,l.id),0), 1, 1e-9);
  totalsClose(tree);
});
t('moving a node inside its own subtree is rejected', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find(n=>n.id==='riskq2').parent_id = 'score';   // score is riskq2's child
  assert.throws(()=>buildTree(nodes), /unreachable|cycle/i);
});
console.log('\nadd then delete round trip');
t('deleting the only child restores the parent as a leaf', () => {
  const nodes = structuredClone(seed.nodes);
  const r5before = structuredClone(nodes.find(n=>n.id==='r5'));
  const child = addChild(nodes,'r5','temp');
  // now delete it, mirroring deleteSubtree's carry-back
  let tree = buildTree(nodes);
  const carriedMix = contributorMix(tree,'r5');
  const idx = nodes.findIndex(n=>n.id===child.id);
  nodes.splice(idx,1);
  const parent = nodes.find(n=>n.id==='r5');
  parent.contributions = normalizeSplit(carriedMix);
  assert.deepEqual(
    parent.contributions.map(c=>c.contributor_id).sort(),
    r5before.contributions.map(c=>c.contributor_id).sort(),
    'contributors restored');
  near(parent.contributions.reduce((s,c)=>s+c.pct,0), 100, 1e-9, 'split totals 100');
});
t('round trip on a staffed leaf preserves every credit number', () => {
  const nodes = structuredClone(seed.nodes);
  const before = creditByContributor(buildTree(nodes));
  const child = addChild(nodes,'backend','temp');
  let tree = buildTree(nodes);
  const cm = contributorMix(tree,'backend');
  nodes.splice(nodes.findIndex(n=>n.id===child.id),1);
  const parent = nodes.find(n=>n.id==='backend');
  parent.contributions = normalizeSplit(cm);
  const after = creditByContributor(buildTree(nodes));
  for (const b of before) {
    const a = after.find(x=>x.contributor_id===b.contributor_id);
    near(a.allocated, b.allocated, 1e-9, b.contributor_id+' allocated');
  }
});

console.log(`\n${pass} passed${process.exitCode?', SOME FAILED':''}\n`);
