/**
 * One-shot: investor docs, the sends that wait on them, and Tech sync's move.
 * Kept for reference, like the other tracker one-shots.
 *
 * The three docs (technical docs with and without NDA, the lender pool return
 * simulation) gate everything with pool and VC investors, so every send is
 * Blocked on the docs it needs. The blocked-by text names the doc owners on
 * purpose: the Blocked view files a task under any teammate its reason names,
 * so these land under Asad and Nam — the people the investor work waits on.
 *
 * "Technical documents to send to investors" was one in-progress task; it is
 * now the without-NDA half, and the with-NDA half is created beside it with
 * the same owners and status, since it is the same piece of work split in two.
 *
 * Owners were given by Ethan (2026-09-10): the sends are his, the simulation is
 * Nam's. No due dates or sources were given, so none are set.
 *
 * Idempotent: re-running finds everything already in place and changes nothing.
 */
const ETHAN = 'ethan';
const NAM = 'nam';

const DOCS = 'tp_investor';            // VC Investors › Investor materials

const NEW_PROJECTS = [
  { id: 'tp_vc_outreach', category_id: 'tc_fundraise', title: 'Outreach' },   // VC Investors
  { id: 'tp_pool_outreach', category_id: 'tc_pool', title: 'Outreach' },      // Pool Investors
];

const SENDS = [
  ['tp_vc_outreach', 'Proxima Ventures: follow up with technical docs (non-NDA) and 1 pager',
    'Technical docs without NDA (Asad, Nam)'],
  ['tp_venues', 'Send Avantis technical docs and venue integration doc',
    'Technical docs (Asad, Nam) and a venue integration doc'],
  ['tp_pool_outreach', 'Send Galaxy all technical docs and lender doc',
    'All technical docs, with and without NDA (Asad, Nam)'],
  ['tp_pool_outreach', 'Send DWF Ventures all technical docs, lender return simulation, lender doc and model technical doc (non-NDA)',
    'All technical docs (Asad, Nam) and the lender pool return simulation (Nam)'],
  ['tp_pool_outreach', 'Send MH Ventures pitch deck, lender doc, technical docs, pool return simulation and NDA',
    'Technical docs with NDA (Asad, Nam), the lender pool return simulation (Nam) and the NDA'],
];

export function applyInvestorPlan(tracker, nowIso = new Date().toISOString()) {
  const has = (title) => tracker.tasks.some((t) => t.title === title);
  const task = (id, project_id, title, owners, extra = {}) => ({
    id, project_id, title, owners, due_date: '', status: 'not_started', blocked_by: '', source: '',
    created_at: nowIso, updated_at: nowIso, done_at: '', ...extra,
  });
  const changes = [];

  // Tech sync is marketplace work, not the credit model.
  const techSync = tracker.projects.find((p) => p.id === 'tp_techsync');
  if (techSync && techSync.category_id !== 'tc_marketplace') {
    techSync.category_id = 'tc_marketplace';
    changes.push('Tech sync -> Marketplace');
  }

  for (const p of NEW_PROJECTS) {
    if (!tracker.projects.some((x) => x.id === p.id)) { tracker.projects.push({ ...p }); changes.push(`project ${p.title} <${p.category_id}>`); }
  }

  // The docs. Split the existing technical-documents task in two.
  const techDocs = tracker.tasks.find((t) => t.id === 'tt05' || t.title === 'Technical documents to send to investors');
  if (techDocs && techDocs.title !== 'Technical docs without NDA') {
    techDocs.title = 'Technical docs without NDA';
    techDocs.updated_at = nowIso;
    changes.push('renamed: Technical docs without NDA');
  }
  if (!has('Technical docs with NDA')) {
    tracker.tasks.push(task('tt_docs_nda', DOCS, 'Technical docs with NDA',
      [...(techDocs?.owners ?? ['pmt0z6mh6', NAM])], { status: techDocs?.status ?? 'not_started' }));
    changes.push('task: Technical docs with NDA');
  }
  if (!has('Lender pool return simulation')) {
    tracker.tasks.push(task('tt_pool_sim', DOCS, 'Lender pool return simulation', [NAM]));
    changes.push('task: Lender pool return simulation');
  }

  // The sends, each blocked on what it needs.
  SENDS.forEach(([project_id, title, blocked_by], i) => {
    if (has(title)) return;
    tracker.tasks.push(task(`tt_send${i + 1}`, project_id, title, [ETHAN], { status: 'blocked', blocked_by }));
    changes.push(`task: ${title.split(':')[0].split(' ').slice(0, 3).join(' ')}…`);
  });
  return changes;
}
