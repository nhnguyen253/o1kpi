/**
 * One-shot: make the model's quarter nodes the goals themselves.
 *
 * The model branch read Q3 2026 -> Finish Credit Model V1 -> six milestones,
 * where the middle node carried no information the quarter did not. So the
 * quarter node now IS the goal: "Q3 2026: Finish Credit Model V1", with the
 * milestones hanging directly off it.
 *
 * V1 stays in Q2 where the work was done; V2 -- the market context and watchdog
 * additions -- is the Q3 goal.
 *
 * Share-neutral by construction: each collapsed branch was the ONLY child of
 * its quarter, so the quarter's weight already equalled the branch's. Taking
 * the branch's weight onto the quarter leaves every milestone's share of the
 * company exactly where it was.
 */
const PLAN = [
  {
    quarter: 'riskq2', branch: 'credit',
    title: 'Q2 2026: Finish Credit Model V1',
    notes: 'Ship a credit model that scores trading agents accurately enough '
         + 'that the ones it approves go on to perform once onboarded.',
  },
  {
    quarter: 'riskq3', branch: 'creditv2',
    title: 'Q3 2026: Finish Credit Model V2',
    notes: 'Extend the model with market context and a watchdog.',
  },
];

export function collapseModel(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const { quarter, branch, title, notes } of PLAN) {
    const q = byId.get(quarter), b = byId.get(branch);
    if (!q || !b) throw new Error(`expected ${quarter} and ${branch}`);
    q.title = title;
    q.weight = Number(b.weight);      // <- the share-preserving step
    q.status = b.status;
    if (notes) q.notes = notes;
    for (const leaf of nodes.filter((n) => n.parent_id === branch)) leaf.parent_id = quarter;
  }

  const dropped = new Set(PLAN.map((p) => p.branch));
  const out = nodes.filter((n) => !dropped.has(n.id));

  // A quarter with nothing in it holds no company share until it is filled.
  for (const n of out) {
    if (!/q[1-4]$/.test(n.id)) continue;
    if (!out.some((k) => k.parent_id === n.id)) n.weight = 0;
  }
  return out;
}
