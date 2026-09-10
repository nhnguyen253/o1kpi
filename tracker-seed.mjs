/**
 * One-shot seed for the accountability tracker. Kept for reference, like
 * migrate.mjs and restructure.mjs.
 *
 * Only what was given is seeded: titles, owners, projects, categories. No due
 * dates, statuses or sources were supplied, so none are invented — every task
 * starts Not started and undated. Inventing dates would manufacture overdue
 * work against named people.
 */

const ASAD = 'pmt0z6mh6';
const NAM = 'nam';
const ETHAN = 'ethan';
const FRANCIS = 'francis';

/** Francis owns tracker tasks, so he needs to exist as a contributor. */
export const FRANCIS_CONTRIBUTOR = {
  id: FRANCIS, name: 'Francis', role: 'LFG', bio: '', contact: '',
};

// Categories point loosely at the KPI node they reconcile with.
const CATEGORIES = [
  ['tc_credit', 'Credit model', 'risk'],
  ['tc_fundraise', 'Fundraise', 'raise'],
  ['tc_traders', 'Trader acquisition', 'traders'],
  ['tc_partners', 'Partnerships', 'partnerships'],
  ['tc_company', 'Company', 'ops'],
];

const PROJECTS = [
  ['tp_clusters', 'tc_credit', 'Copy trading clusters'],
  ['tp_livescore', 'tc_credit', 'Live scoring'],
  ['tp_techsync', 'tc_credit', 'Tech sync'],
  ['tp_investor', 'tc_fundraise', 'Investor materials'],
  ['tp_outreach', 'tc_traders', 'Outreach'],
  ['tp_venues', 'tc_partners', 'Venue partnerships'],
  ['tp_lfg', 'tc_partners', 'LFG'],
  ['tp_presence', 'tc_company', 'Presence'],
  ['tp_os', 'tc_company', 'Internal OS'],
];

const TASKS = [
  ['tp_clusters', 'Update on cluster progress', [ASAD]],
  ['tp_livescore', 'Update live scoring', [NAM]],
  ['tp_livescore', 'Update frontend visuals', [NAM]],
  ['tp_techsync', 'Sync on tech', [ASAD, NAM]],
  ['tp_investor', 'Technical documents to send to investors', [ASAD, NAM]],
  ['tp_investor', 'NDA', [ASAD]],
  ['tp_outreach', 'Outreach draft to Concept211 (KOL and trader)', [ASAD]],
  ['tp_outreach', 'Outreach to traders', [ETHAN]],
  ['tp_outreach', 'Organise outreach system', [ETHAN]],
  ['tp_outreach', 'Create outreach target doc for Francis and Egide', [ETHAN]],
  ['tp_venues', 'Follow up with Aptos Labs', [FRANCIS]],
  ['tp_venues', 'Follow up with Aster', [FRANCIS]],
  ['tp_lfg', 'Sync with LFG team on pipeline', [FRANCIS]],
  ['tp_presence', 'Create X account', [ETHAN]],
  ['tp_os', 'Work on KPI tree', [ETHAN]],
];

export function trackerSeed(nowIso = new Date().toISOString()) {
  return {
    categories: CATEGORIES.map(([id, title, kpi_node_id]) => ({ id, title, kpi_node_id })),
    projects: PROJECTS.map(([id, category_id, title]) => ({ id, category_id, title })),
    tasks: TASKS.map(([project_id, title, owners], i) => ({
      id: `tt${String(i + 1).padStart(2, '0')}`,
      project_id, title, owners,
      due_date: '', status: 'not_started', blocked_by: '', source: '',
      created_at: nowIso, updated_at: nowIso, done_at: '',
    })),
  };
}
