/**
 * One-shot 2026 restructure. Kept for reference like migrate.mjs.
 *
 * Two things happen here.
 *
 * 1. Asad's subdivisions from the Aug 26 standup: custody becomes a function
 *    of the backend rather than its peer, trader acquisition moves under
 *    Capital (anything touching money lives there), marketplace V0 and V0.5
 *    are added ahead of V1, and legal/compliance joins Operations.
 *
 * 2. A time layer: every category gets a 2026 goal, and under it Q1-Q4. The
 *    existing branches hang off the quarter they belong to.
 *
 * The quarter layer is deliberately weight-transparent: a quarter's weight is
 * the SUM of its children's weights, so a child's share of the category is
 * identical to what it would be with no quarters at all. Grouping work by
 * quarter therefore moves nobody's credit -- only the content changes in (1)
 * do. Empty quarters end up at weight 0 and hold no share until filled.
 */

const mk = (id, parent_id, type, title, extra = {}) => ({
  id, parent_id, type, title, weight: 1, status: 'not_started',
  target_date: '', notes: '', contributions: [], ...extra,
});

// category -> which quarter each existing branch belongs to
const PLACEMENT = {
  eng:          { q2: ['market'] },
  risk:         { q2: ['credit'], q3: ['creditv2'] },
  partnerships: { q3: ['venues', 'botbuilder'] },
  capital:      { q3: ['raise', 'lenderpool', 'traders'] },   // traders moves in
  ops:          { q3: ['bdconvo', 'kpimgmt', 'followthru', 'internalorg'] },
};

export function restructure(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const get = (id) => { const n = byId.get(id); if (!n) throw new Error(`missing node ${id}`); return n; };
  const out = [...nodes];
  const add = (n) => { out.push(n); byId.set(n.id, n); return n; };

  if (byId.has('eng2026')) throw new Error('already restructured');

  // --- 1. Engineering: custody under backend, ui under frontend
  add(mk('be', 'market', 'branch', 'Backend'));
  add(mk('fe', 'market', 'branch', 'Frontend'));
  get('backend').parent_id = 'be';      // database + scalability work, LFG
  get('custody').parent_id = 'be';      // a function of the backend, not a peer
  get('frontend').parent_id = 'fe';
  get('ux').parent_id = 'fe';

  // --- 2. Marketplace V0 / V0.5 ahead of V1
  add(mk('mktv0', 'eng', 'kpi', '01 Marketplace V0', {
    weight: 1.5, status: 'done',
    notes: 'Original concept: credit against trading, venue selection, portfolio and audit criteria.',
    contributions: [{ contributor_id: 'pmt0z6mh6', pct: 75 }, { contributor_id: 'ethan', pct: 25 }],
  }));
  add(mk('mktv05', 'eng', 'kpi', '01 Marketplace V0.5', {
    weight: 0.5, status: 'done',
    notes: 'Prototype layered on V0: logic and product refinement handed to the tech team.',
    contributions: [{ contributor_id: 'ethan', pct: 100 }],
  }));
  get('market').weight = 1.5;           // V1 raised to match V0

  // --- 3. Legal joins Operations
  add(mk('legal', 'ops', 'kpi', 'Legal & Compliance',
    { notes: 'Regulatory and compliance workstream. Raised as a gap on 2026-08-26.' }));
  PLACEMENT.ops.q3.push('legal');
  PLACEMENT.eng = { q1: ['mktv0', 'mktv05'], q2: ['market'] };

  // --- 4. year + quarters, then reparent the branches onto them
  for (const [cat, place] of Object.entries(PLACEMENT)) {
    const year = add(mk(`${cat}2026`, cat, 'category', '2026',
      { notes: 'Annual objective for this branch -- fill in the number it is measured by.' }));
    for (const q of [1, 2, 3, 4]) {
      const qNode = add(mk(`${cat}q${q}`, year.id, 'branch', `Q${q} 2026`));
      for (const childId of place[`q${q}`] ?? []) get(childId).parent_id = qNode.id;
    }
  }

  // --- 5. quarter weights = sum of children, so the layer shifts nobody's share
  for (const n of out) {
    if (!/q[1-4]$/.test(n.id)) continue;
    const kids = out.filter((k) => k.parent_id === n.id);
    n.weight = kids.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  }
  return out;
}

/**
 * Rebuild the node list depth-first so the array order matches the order the
 * tree renders in -- app.js walks children in array order. ORDER pins the few
 * places where the natural order reads wrong: the raise should lead Capital,
 * and the backend build should lead custody rather than trail it.
 */
const ORDER = {
  capitalq3: ['raise', 'lenderpool', 'traders'],
  be: ['backend', 'custody'],
};

export function reorder(nodes) {
  const kids = new Map();
  for (const n of nodes) {
    if (n.parent_id == null) continue;
    if (!kids.has(n.parent_id)) kids.set(n.parent_id, []);
    kids.get(n.parent_id).push(n);
  }
  for (const [pid, ids] of Object.entries(ORDER)) {
    const list = kids.get(pid);
    if (!list) continue;
    const rank = (n) => (ids.indexOf(n.id) < 0 ? ids.length : ids.indexOf(n.id));
    list.sort((a, b) => rank(a) - rank(b));
  }
  const out = [];
  const root = nodes.find((n) => n.parent_id == null);
  (function walk(n) { out.push(n); (kids.get(n.id) ?? []).forEach(walk); })(root);
  if (out.length !== nodes.length) throw new Error(`reorder lost nodes: ${nodes.length} -> ${out.length}`);
  return out;
}
