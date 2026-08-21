import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildTree, rolledProgress, creditByContributor, leaves, companyShare, contributorMix, normalizeSplit } from './rollup.js';

const seed = JSON.parse(readFileSync('./data/seed.json','utf8'));
let pass = 0;
const t = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n);}catch(e){ console.error('  FAIL '+n+'\n       '+e.message); process.exitCode=1; } };
const near=(a,b,tol=1e-9,m='')=>assert.ok(Math.abs(a-b)<tol, `${m} expected ${b} got ${a}`);

// Mirror of addChildNode from app.js
function addChild(nodes, parentId, title) {
  const tree = buildTree(nodes);
  const parent = nodes.find(n=>n.id===parentId);
  const first = (tree.childrenOf.get(parentId)??[]).length===0;
  const child = { id:'x'+nodes.length, parent_id:parentId, type:'milestone', title,
                  weight:1, progress:0, status:'not_started', target_date:'', notes:'', contributions:[] };
  if (first) {
    child.progress = Number(parent.progress)||0;
    child.status = parent.status;
    child.contributions = parent.contributions ?? [];
    delete parent.progress;
    parent.contributions = [];
  }
  nodes.push(child);
  return child;
}

console.log('\nadd child');
t('first child under a leaf leaves every number unchanged', () => {
  const nodes = structuredClone(seed.nodes);
  const beforeRoot = rolledProgress(buildTree(nodes),'root');
  const beforeCredit = creditByContributor(buildTree(nodes));
  addChild(nodes,'backend','API endpoints');
  const tree = buildTree(nodes);
  near(rolledProgress(tree,'root'), beforeRoot, 1e-9, 'root');
  const after = creditByContributor(tree);
  for (const b of beforeCredit) {
    const a = after.find(x=>x.contributor_id===b.contributor_id);
    near(a.allocated, b.allocated, 1e-9, b.contributor_id+' allocated');
    near(a.earned, b.earned, 1e-9, b.contributor_id+' earned');
  }
});
t('parent stops holding contributions once it has a child', () => {
  const nodes = structuredClone(seed.nodes);
  addChild(nodes,'backend','API endpoints');
  assert.equal(nodes.find(n=>n.id==='backend').contributions.length, 0);
  assert.equal(nodes.find(n=>n.id==='backend').progress, undefined);
});
t('second child starts empty and dilutes the parent', () => {
  const nodes = structuredClone(seed.nodes);
  addChild(nodes,'backend','API endpoints');       // inherits 70
  addChild(nodes,'backend','Webhooks');            // starts 0
  near(rolledProgress(buildTree(nodes),'backend'), 35, 1e-9);
});
t('new empty nodes leave credit unallocated, not miscounted', () => {
  const nodes = structuredClone(seed.nodes);
  addChild(nodes,'backend','a'); addChild(nodes,'backend','b'); addChild(nodes,'r5','c');
  const tree = buildTree(nodes);
  near(leaves(tree).reduce((s,l)=>s+companyShare(tree,l.id),0), 1, 1e-9, 'shares still sum to 1');
  // 'b' and 'c' have no contributors yet, so their share of the company belongs
  // to nobody. Allocated must fall short by exactly the share of unstaffed
  // leaves — never silently redistribute it.
  const allocated = creditByContributor(tree).reduce((s,c)=>s+c.allocated,0);
  const unstaffed = leaves(tree)
    .filter(l => !(l.contributions ?? []).length)
    .reduce((s,l)=>s+companyShare(tree,l.id)*100, 0);
  near(allocated + unstaffed, 100, 1e-9, 'allocated + unstaffed');
  assert.ok(unstaffed > 0, 'this fixture should have unstaffed leaves');
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
  near(creditByContributor(tree).reduce((s,c)=>s+c.allocated,0), 100, 1e-9, 'allocated still 100');
});
t('moving a node keeps the tree valid and totals closed', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find(n=>n.id==='backtest').parent_id = 'eng';
  const tree = buildTree(nodes);
  near(leaves(tree).reduce((s,l)=>s+companyShare(tree,l.id),0), 1, 1e-9);
  near(creditByContributor(tree).reduce((s,c)=>s+c.allocated,0), 100, 1e-9);
});
t('moving a node inside its own subtree is rejected', () => {
  const nodes = structuredClone(seed.nodes);
  nodes.find(n=>n.id==='credit').parent_id = 'score';   // score is credit's child
  assert.throws(()=>buildTree(nodes), /unreachable|cycle/i);
});
console.log('\nadd then delete round trip');
t('deleting the only child restores the parent as a leaf', () => {
  const nodes = structuredClone(seed.nodes);
  const r5before = structuredClone(nodes.find(n=>n.id==='r5'));
  const child = addChild(nodes,'r5','temp');
  // now delete it, mirroring deleteSubtree's carry-back
  let tree = buildTree(nodes);
  const carriedProgress = rolledProgress(tree,'r5');
  const carriedMix = contributorMix(tree,'r5');
  const idx = nodes.findIndex(n=>n.id===child.id);
  nodes.splice(idx,1);
  const parent = nodes.find(n=>n.id==='r5');
  parent.progress = Math.round(carriedProgress);
  parent.contributions = normalizeSplit(carriedMix);
  assert.equal(parent.progress, r5before.progress, 'progress restored');
  assert.deepEqual(
    parent.contributions.map(c=>c.contributor_id).sort(),
    r5before.contributions.map(c=>c.contributor_id).sort(),
    'contributors restored');
  near(parent.contributions.reduce((s,c)=>s+c.pct,0), 100, 1e-9, 'split totals 100');
});
t('round trip on a staffed leaf preserves company progress', () => {
  const nodes = structuredClone(seed.nodes);
  const before = rolledProgress(buildTree(nodes),'root');
  const child = addChild(nodes,'backend','temp');
  let tree = buildTree(nodes);
  const cp = rolledProgress(tree,'backend'), cm = contributorMix(tree,'backend');
  nodes.splice(nodes.findIndex(n=>n.id===child.id),1);
  const parent = nodes.find(n=>n.id==='backend');
  parent.progress = Math.round(cp);
  parent.contributions = normalizeSplit(cm);
  near(rolledProgress(buildTree(nodes),'root'), before, 1e-9, 'root unchanged');
});

console.log(`\n${pass} passed${process.exitCode?', SOME FAILED':''}\n`);
