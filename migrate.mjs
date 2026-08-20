#!/usr/bin/env node
/**
 * One-shot migration: schema v1 -> v2.
 *
 *   v1 node: { ..., progress, direct_contributors: ["ethan","nam"] }
 *   v2 node: { ..., progress, weight: 1, contributions: [{contributor_id, pct}] }
 *
 * - `direct_contributors` becomes an even split totalling exactly 100
 *   (rounding remainder goes to the first contributor).
 * - `weight` defaults to 1 on every node, so siblings split evenly until
 *   someone tunes them.
 * - Parent `progress` values are dropped from the source of truth: they are
 *   computed by rollup.js from here on. We keep the old value under
 *   `legacy_progress` on non-leaves so the one-time change is auditable.
 *
 * Usage: node migrate.mjs <input.json> <output.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node migrate.mjs <input.json> <output.json>');
  process.exit(1);
}

const src = JSON.parse(readFileSync(inPath, 'utf8'));

/** Even split across ids, totalling exactly 100. Remainder to the first. */
export function evenSplit(ids) {
  if (!ids.length) return [];
  const base = Math.floor(100 / ids.length);
  const remainder = 100 - base * ids.length;
  return ids.map((contributor_id, i) => ({
    contributor_id,
    pct: base + (i === 0 ? remainder : 0),
  }));
}

const hasChildren = new Set(src.nodes.map((n) => n.parent_id).filter(Boolean));

const nodes = src.nodes.map((n) => {
  const isLeaf = !hasChildren.has(n.id);
  const out = {
    id: n.id,
    parent_id: n.parent_id ?? null,
    type: n.type,
    title: n.title,
    weight: typeof n.weight === 'number' ? n.weight : 1,
    status: n.status,
    target_date: n.target_date ?? '',
    notes: n.notes ?? '',
    contributions: Array.isArray(n.contributions)
      ? n.contributions
      : evenSplit(n.direct_contributors ?? []),
  };
  if (isLeaf) {
    out.progress = Number(n.progress) || 0;
  } else {
    // Parents compute their progress now. Keep the old hand-typed number
    // so the one-time shift is inspectable, but it is no longer authoritative.
    out.legacy_progress = Number(n.progress) || 0;
  }
  return out;
});

// Contributions on non-leaves would double-count against their children.
const offenders = nodes.filter((n) => n.legacy_progress !== undefined && n.contributions.length);
if (offenders.length) {
  console.error('ERROR: non-leaf nodes carry contributions (would double-count credit):');
  offenders.forEach((n) => console.error(`  - ${n.id} (${n.title})`));
  process.exit(1);
}

for (const n of nodes) {
  const total = n.contributions.reduce((s, c) => s + c.pct, 0);
  if (n.contributions.length && total !== 100) {
    console.error(`ERROR: ${n.id} contributions total ${total}, expected 100`);
    process.exit(1);
  }
}

const out = {
  meta: {
    ...src.meta,
    schema_version: 2,
    storage_model: 'supabase',
    updated_at: src.meta?.updated_at ?? null,
  },
  contributors: src.contributors,
  nodes,
  history: src.history ?? [],
};

writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`migrated ${nodes.length} nodes -> ${outPath}`);
console.log(`  leaves:     ${nodes.filter((n) => n.progress !== undefined).length}`);
console.log(`  parents:    ${nodes.filter((n) => n.legacy_progress !== undefined).length}`);
console.log(`  with split: ${nodes.filter((n) => n.contributions.length).length}`);
