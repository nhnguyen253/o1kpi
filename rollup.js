/**
 * Pure weight / progress / credit math for the KPI tree.
 *
 * Model
 * -----
 * Every node carries a free-form `weight` (default 1). A node's share of its
 * parent is its weight over the sum of its siblings' weights, so adding a
 * sibling never forces you to re-edit the others.
 *
 * Progress is authored only on leaves. A parent's progress is the
 * weight-weighted average of its children, recursively.
 *
 * Contributions live only on leaves, as percentages totalling 100. Because
 * leaf company-shares sum to 1, credit across people sums to 100% with no
 * double-counting.
 *
 * No dependencies, no DOM. Import from the browser or from node.
 */

const EPS = 1e-9;

/** Index the node list once; every other function takes this tree. */
export function buildTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map(nodes.map((n) => [n.id, []]));
  let root = null;

  for (const n of nodes) {
    if (n.parent_id == null) {
      if (root) throw new Error(`multiple roots: ${root.id} and ${n.id}`);
      root = n;
      continue;
    }
    const siblings = childrenOf.get(n.parent_id);
    if (!siblings) throw new Error(`${n.id} has unknown parent_id ${n.parent_id}`);
    siblings.push(n);
  }
  if (!root) throw new Error('no root node (none with parent_id === null)');

  // Reachability doubles as a cycle check: a cycle is simply unreachable.
  const seen = new Set();
  (function walk(n) {
    if (seen.has(n.id)) throw new Error(`cycle at ${n.id}`);
    seen.add(n.id);
    childrenOf.get(n.id).forEach(walk);
  })(root);
  if (seen.size !== nodes.length) {
    const orphans = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
    throw new Error(`nodes unreachable from root (cycle or bad parent): ${orphans.join(', ')}`);
  }

  return { byId, childrenOf, root, nodes };
}

export const children = (tree, id) => tree.childrenOf.get(id) ?? [];
export const isLeaf = (tree, id) => children(tree, id).length === 0;
export const leaves = (tree) => tree.nodes.filter((n) => isLeaf(tree, n.id));

const weightOf = (n) => {
  const w = Number(n.weight);
  return Number.isFinite(w) && w >= 0 ? w : 1;
};

/**
 * Share of the parent, from weight. Siblings that all sit at weight 0 split
 * evenly rather than producing NaN.
 */
export function weightShare(tree, id) {
  const n = tree.byId.get(id);
  if (!n || n.parent_id == null) return 1;
  const siblings = children(tree, n.parent_id);
  const total = siblings.reduce((s, x) => s + weightOf(x), 0);
  if (total < EPS) return 1 / siblings.length;
  return weightOf(n) / total;
}

/** Leaf: authored progress. Parent: weighted average of children. 0-100. */
export function rolledProgress(tree, id, _seen = new Set()) {
  const n = tree.byId.get(id);
  if (!n) return 0;
  const kids = children(tree, id);
  if (!kids.length) return clamp(Number(n.progress) || 0);
  return clamp(
    kids.reduce((s, c) => s + weightShare(tree, c.id) * rolledProgress(tree, c.id, _seen), 0)
  );
}

/** Fraction of the whole company this node represents. Root = 1. */
export function companyShare(tree, id) {
  let share = 1;
  let n = tree.byId.get(id);
  while (n && n.parent_id != null) {
    share *= weightShare(tree, n.id);
    n = tree.byId.get(n.parent_id);
  }
  return share;
}

/**
 * Credit per contributor, as percentages.
 *
 *   allocated — share of the whole roadmap this person owns. Sums to 100.
 *   earned    — share of progress actually achieved that is theirs.
 *               Sums to the company's rolled-up progress. This is the honest
 *               number: being assigned to a not-started node earns nothing.
 */
export function creditByContributor(tree) {
  const acc = new Map();
  const bump = (id, field, amount) => {
    if (!acc.has(id)) acc.set(id, { contributor_id: id, allocated: 0, earned: 0, leaf_count: 0 });
    acc.get(id)[field] += amount;
  };

  for (const leaf of leaves(tree)) {
    const share = companyShare(tree, leaf.id);
    const done = clamp(Number(leaf.progress) || 0) / 100;
    for (const c of leaf.contributions ?? []) {
      const frac = (Number(c.pct) || 0) / 100;
      bump(c.contributor_id, 'allocated', share * frac * 100);
      bump(c.contributor_id, 'earned', share * frac * done * 100);
      acc.get(c.contributor_id).leaf_count += 1;
    }
  }

  return [...acc.values()].sort((a, b) => b.earned - a.earned || b.allocated - a.allocated);
}

/**
 * Rolled-up contributors for any node, weighted by the share each descendant
 * leaf contributes. Replaces the old "appears in N descendants" count, which
 * treated a trivial leaf and the whole backend as equal.
 */
export function contributorMix(tree, id) {
  const sub = subtreeLeaves(tree, id);
  const totalShare = sub.reduce((s, l) => s + companyShare(tree, l.id), 0);
  const acc = new Map();

  for (const leaf of sub) {
    const rel = totalShare < EPS ? 0 : companyShare(tree, leaf.id) / totalShare;
    for (const c of leaf.contributions ?? []) {
      const frac = (Number(c.pct) || 0) / 100;
      acc.set(c.contributor_id, (acc.get(c.contributor_id) ?? 0) + rel * frac * 100);
    }
  }

  return [...acc.entries()]
    .map(([contributor_id, pct]) => ({ contributor_id, pct }))
    .sort((a, b) => b.pct - a.pct);
}

export function subtreeLeaves(tree, id) {
  const out = [];
  (function walk(nid) {
    const kids = children(tree, nid);
    if (!kids.length) {
      const n = tree.byId.get(nid);
      if (n) out.push(n);
      return;
    }
    kids.forEach((c) => walk(c.id));
  })(id);
  return out;
}

/** Status for a computed (non-leaf) node, derived from its subtree. */
export function rolledStatus(tree, id) {
  const n = tree.byId.get(id);
  if (!n) return 'not_started';
  if (isLeaf(tree, id)) return n.status;
  const sub = subtreeLeaves(tree, id);
  if (sub.some((l) => l.status === 'blocked')) return 'blocked';
  if (sub.length && sub.every((l) => l.status === 'done')) return 'done';
  if (sub.some((l) => l.status !== 'not_started')) return 'in_progress';
  return 'not_started';
}

/** Contribution splits must total exactly 100 (or be empty). */
export function validateSplit(contributions) {
  const list = contributions ?? [];
  if (!list.length) return { ok: true, total: 0 };
  const total = list.reduce((s, c) => s + (Number(c.pct) || 0), 0);
  return { ok: Math.abs(total - 100) < EPS, total };
}

/** Rescale a split to total exactly 100; remainder lands on the largest. */
export function normalizeSplit(contributions) {
  const list = (contributions ?? []).filter((c) => (Number(c.pct) || 0) > 0);
  if (!list.length) return [];
  const total = list.reduce((s, c) => s + Number(c.pct), 0);
  const scaled = list.map((c) => ({
    contributor_id: c.contributor_id,
    pct: Math.round((Number(c.pct) / total) * 100),
  }));
  const drift = 100 - scaled.reduce((s, c) => s + c.pct, 0);
  if (drift !== 0) {
    const biggest = scaled.reduce((a, b) => (b.pct > a.pct ? b : a));
    biggest.pct += drift;
  }
  return scaled;
}

/** Even split totalling exactly 100; remainder to the first. */
export function evenSplit(contributorIds) {
  const ids = contributorIds ?? [];
  if (!ids.length) return [];
  const base = Math.floor(100 / ids.length);
  const remainder = 100 - base * ids.length;
  return ids.map((contributor_id, i) => ({
    contributor_id,
    pct: base + (i === 0 ? remainder : 0),
  }));
}

export function pathTo(tree, id) {
  const out = [];
  let n = tree.byId.get(id);
  while (n) {
    out.unshift(n);
    n = n.parent_id != null ? tree.byId.get(n.parent_id) : null;
  }
  return out;
}

function clamp(v) {
  return Math.max(0, Math.min(100, v));
}
