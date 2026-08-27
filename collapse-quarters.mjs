/**
 * Collapse any quarter whose single child just restates it.
 *
 * "Q2 2026 -> Finish 01 Marketplace V1 -> Backend/Frontend" becomes
 * "Q2 2026: Finish 01 Marketplace V1 -> Backend/Frontend". The middle node
 * carried nothing the quarter did not, so the quarter becomes the goal.
 *
 * Share-neutral: the child was the ONLY child, so it already held 100% of the
 * quarter. Moving its weight up leaves every descendant's share untouched.
 *
 * Deliberately does NOT touch a category's single "2026" child -- that layer
 * is the annual goal, and it is meant to be there.
 */
export function collapseSingleChildQuarters(nodes) {
  const kidsOf = (id) => nodes.filter((n) => n.parent_id === id);
  const dropped = new Set();
  const done = [];

  for (const q of nodes) {
    if (!/q[1-4]$/.test(q.id)) continue;
    if (q.title.includes(':')) continue;          // already carries a goal
    const kids = kidsOf(q.id);
    if (kids.length !== 1) continue;

    const child = kids[0];
    const grandkids = kidsOf(child.id);
    q.title = `${q.title}: ${child.title}`;
    q.weight = Number(child.weight);              // <- the share-preserving step
    q.status = child.status;
    if (child.notes) q.notes = child.notes;
    if (child.target_date) q.target_date = child.target_date;

    if (grandkids.length) {
      for (const g of grandkids) g.parent_id = q.id;
      q.contributions = [];                       // non-leaves never hold a split
    } else {
      // The child was a leaf, so the quarter becomes one and must take the
      // split with it -- otherwise that credit would simply vanish.
      q.contributions = child.contributions ?? [];
    }
    dropped.add(child.id);
    done.push(q.title);
  }

  if (done.length) console.log('collapsed:', done.join(' | '));
  return nodes.filter((n) => !dropped.has(n.id));
}
