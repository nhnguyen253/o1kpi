/**
 * One-shot: fold Credit / Risk and Engineering into a single Technology KPI.
 *
 * Asad's structural point from the Aug 26 standup, which Ethan accepted: the
 * model and the marketplace are both engineering, so they belong under one
 * top-line KPI rather than sitting as peers of Capital and Partnerships.
 *
 * Two rules keep this from quietly moving money around:
 *
 *   Technology's weight is the SUM of the two branches it replaces, so folding
 *   does not change what technology is worth to the company as a whole. Only
 *   the split *inside* it changes.
 *
 *   Inside, the model is weighted 2x the marketplace, per Ethan. That is the
 *   one intended shift: the old ratio was 1.5:1.
 *
 * Each branch keeps its own 2026 / Q1-Q4 substructure untouched.
 */
export function foldTech(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.has('tech')) throw new Error('already folded');
  const eng = byId.get('eng');
  const risk = byId.get('risk');
  if (!eng || !risk) throw new Error('expected eng and risk at the root');

  const tech = {
    id: 'tech', parent_id: 'root', type: 'category', title: 'Technology',
    weight: Number(eng.weight) + Number(risk.weight),   // <- share preserved
    status: 'in_progress', target_date: '', contributions: [],
    notes: 'Annual objective for technology — fill in the number it is measured by.',
  };

  risk.parent_id = 'tech';
  risk.title = 'Credit / Risk Model';
  risk.weight = 2;                    // model is 2x the marketplace

  eng.parent_id = 'tech';
  eng.title = 'Marketplace';
  eng.weight = 1;

  // Insert Technology where Engineering used to sit; reorder() puts the
  // subtrees back in depth-first order afterwards.
  const out = [...nodes];
  out.splice(out.indexOf(eng), 0, tech);
  return out;
}
