/**
 * One-shot: give the accountability tracker its own categories. Kept for
 * reference, like tracker-seed.mjs.
 *
 * The first seed mirrored the KPI tree's branches and linked each category to
 * a KPI node. Ethan's correction: accountability and KPIs are different
 * things, so the tracker gets the categories people actually work in, and no
 * category points into the KPI tree.
 *
 * Only categories change. Projects and tasks keep their ids and their
 * category_id, so every task — and everything the team has done to them since
 * (statuses, dates) — carries over untouched.
 *
 *   Credit model       -> Credit Model        (Copy trading clusters, Live scoring, Tech sync)
 *   Fundraise          -> VC Investors        (Investor materials)
 *   Trader acquisition -> Trader Acquisition  (Outreach)
 *   Partnerships       -> Venue Partnerships  (Venue partnerships, LFG)
 *   Company            -> Company             (Presence, Internal OS)
 *   new, empty         :  Marketplace, Pool Investors, Bot Building Partnerships,
 *                         Frontend Terminals
 *
 * The last two keep work that fits none of the listed categories: the Aptos,
 * Aster and LFG follow-ups, the X account and the KPI tree task.
 */
const CATEGORIES = [
  ['tc_credit', 'Credit Model'],
  ['tc_marketplace', 'Marketplace'],
  ['tc_pool', 'Pool Investors'],
  ['tc_fundraise', 'VC Investors'],
  ['tc_traders', 'Trader Acquisition'],
  ['tc_botbuild', 'Bot Building Partnerships'],
  ['tc_frontends', 'Frontend Terminals'],
  ['tc_partners', 'Venue Partnerships'],
  ['tc_company', 'Company'],
];

export function recategorise(tracker) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const pool = [...tracker.categories];
  const take = (id, title) => {
    // By id first; by title second, so a category someone already created by
    // hand ("Marketplace") is reused rather than duplicated.
    const i = pool.findIndex((c) => c.id === id);
    const j = i >= 0 ? i : pool.findIndex((c) => norm(c.title) === norm(title));
    return j >= 0 ? pool.splice(j, 1)[0] : null;
  };

  const ordered = CATEGORIES.map(([id, title]) => {
    const c = take(id, title) ?? { id, title, kpi_node_id: '' };
    c.title = title;
    return c;
  });
  // Anything else the team made keeps its relative order, after the list.
  tracker.categories = [...ordered, ...pool];
  for (const c of tracker.categories) c.kpi_node_id = '';
  return tracker;
}
