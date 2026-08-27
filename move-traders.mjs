/**
 * Move Trader Acquisition back under Business Development.
 *
 * This reverses the move made after the Aug 26 standup, where Asad's rule was
 * "anything touching money belongs under Capital". Ethan's call: acquiring
 * traders is business development work, whatever the traders then do with
 * money, so it sits with venues and bot builders.
 *
 * Both quarters are still plain wrappers (no goal in the title), so their
 * weights are kept equal to the sum of their children's -- that is what makes
 * the quarter layer transparent. Neither quarter's own share changes, since
 * each is the only non-empty quarter in its year.
 */
export function moveTraders(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const traders = byId.get('traders');
  if (!traders) throw new Error('no traders node');
  if (traders.parent_id === 'partnershipsq3') throw new Error('already moved');

  traders.parent_id = 'partnershipsq3';

  for (const qid of ['partnershipsq3', 'capitalq3']) {
    const q = byId.get(qid);
    if (!q || q.title.includes(':')) continue;      // a goal quarter is weighted by hand
    q.weight = nodes
      .filter((n) => n.parent_id === qid)
      .reduce((s, k) => s + Number(k.weight), 0);
  }
  return nodes;
}
