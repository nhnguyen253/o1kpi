/**
 * One-shot: turn the investor sends' free-text reasons into real links to the
 * doc tasks they wait on. Kept for reference, like the other tracker one-shots.
 *
 * Linked, each doc's owners see — on their own list — exactly which sends
 * they are holding up, and each send clears the moment its docs are done.
 *
 * The free text is only replaced where it is still exactly what was written
 * when the sends were created. If someone has reworded it since, the links are
 * added and their wording is left alone. "Venue integration doc" stays as text:
 * there is no task for it.
 */
const LINKS = {
  tt_send1: { was: 'Technical docs without NDA (Asad, Nam)',
    tasks: ['tt05'], text: '' },
  tt_send2: { was: 'Technical docs (Asad, Nam) and a venue integration doc',
    tasks: ['tt05'], text: 'Venue integration doc' },
  tt_send3: { was: 'All technical docs, with and without NDA (Asad, Nam)',
    tasks: ['tt05', 'tt_docs_nda'], text: '' },
  tt_send4: { was: 'All technical docs (Asad, Nam) and the lender pool return simulation (Nam)',
    tasks: ['tt05', 'tt_docs_nda', 'tt_pool_sim'], text: '' },
  tt_send5: { was: 'Technical docs with NDA (Asad, Nam), the lender pool return simulation (Nam) and the NDA',
    tasks: ['tt_docs_nda', 'tt_pool_sim', 'tt06'], text: '' },   // tt06: the NDA template
};

export function linkInvestorDeps(tracker) {
  const ids = new Set(tracker.tasks.map((t) => t.id));
  const changes = [];
  for (const [id, link] of Object.entries(LINKS)) {
    const t = tracker.tasks.find((x) => x.id === id);
    if (!t) continue;
    const want = link.tasks.filter((b) => ids.has(b));
    const have = t.blocked_by_tasks ?? [];
    if (want.some((b) => !have.includes(b))) {
      t.blocked_by_tasks = [...new Set([...have, ...want])];
      changes.push(`${t.title.slice(0, 32)}… waits on ${want.length}`);
    }
    if (t.blocked_by === link.was) {
      t.blocked_by = link.text;
      changes.push(`${t.title.slice(0, 32)}… reason → ${link.text || '(links only)'}`);
    }
  }
  return changes;
}
