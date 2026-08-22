/**
 * 01 Internal OS — rendering and editing.
 *
 * Weights and credit come from rollup.js; nothing on this page hand-types a
 * parent's share any more. Persistence and auth come from store.js.
 */
import {
  buildTree, children, isLeaf, leaves, rolledStatus, companyShare,
  creditByContributor, contributorMix, subtreeLeaves,
  validateSplit, normalizeSplit, evenSplit, pathTo,
} from './rollup.js';
import { store, init, save, setActor, onChange, recentAudit } from './store.js';

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, dp = 1) => `${v.toFixed(dp)}%`;

let tree = null;
let auditRows = [];

const db = () => store.db;
const nodeById = (id) => tree.byId.get(id);
const contributor = (id) =>
  db().contributors.find((c) => c.id === id) ?? { id, name: 'Unknown', role: '', bio: '' };

const STATUS_LABEL = {
  done: 'Done', in_progress: 'In progress', blocked: 'Blocked', not_started: 'Not started',
};
const statusLabel = (s) => STATUS_LABEL[s] ?? s;

function rebuild() {
  tree = buildTree(db().nodes);
}

// ---------------------------------------------------------------- chrome

function renderChrome() {
  const badge = $('modeBadge');
  if (store.mode === 'local') {
    badge.className = 'badge local';
    badge.textContent = 'Local only';
  } else {
    badge.className = 'badge live';
    badge.textContent = 'Live';
  }

  // No sign-in. Instead each browser picks a name once so the change log can
  // attribute edits — a label, not a credential.
  const bar = $('authbar');
  const names = db()?.contributors ?? [];
  bar.innerHTML = `
    <select id="whoami" class="whoami" title="Recorded as the author of your changes">
      <option value="">Who are you?</option>
      ${names.map((p) => `<option value="${esc(p.name)}" ${p.name === store.actor ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      ${store.actor && !names.some((p) => p.name === store.actor)
        ? `<option value="${esc(store.actor)}" selected>${esc(store.actor)}</option>` : ''}
    </select>`;
  $('whoami').onchange = (e) => setActor(e.target.value);

  $('sidebarNote').innerHTML =
    store.mode === 'local'
      ? 'Local mode — changes stay in this browser and are <b>not shared</b>. Fill in config.js to go live.'
      : store.actor
        ? `Editing as <b>${esc(store.actor)}</b>. Changes save for the whole team.`
        : 'Anyone can edit. Pick your name up top so changes are attributed.';

  const updated = db()?.meta?.updated_at;
  $('pageSub').textContent = updated
    ? `Updated ${new Date(updated).toLocaleString()}${db().meta.updated_by ? ` by ${db().meta.updated_by}` : ''}`
    : '';
}

function banner(text, kind = '', action = null) {
  const el = $('banner');
  const btn = $('bannerAction');
  if (!text) { el.classList.remove('show'); return; }
  el.className = `banner show ${kind}`;
  $('bannerText').innerHTML = text;
  if (action) {
    btn.hidden = false;
    btn.textContent = action.label;
    btn.onclick = action.fn;
  } else {
    btn.hidden = true;
  }
}

function refreshBanner() {
  if (store.mode === 'local') {
    banner(
      'Running in <b>local mode</b> — nothing is shared with the team. Add your Supabase URL and anon key to <code>config.js</code> to go live.',
      'warn');
  } else if (store.lastError) {
    banner(esc(store.lastError), 'warn');
  } else {
    banner('');
  }
}

// ---------------------------------------------------------------- dashboard

function renderMetrics() {
  const leafNodes = leaves(tree);
  const rows = [
    ['Leaf nodes', leafNodes.length],
    ['Milestones complete', `${leafNodes.filter((n) => n.status === 'done').length}/${leafNodes.length}`],
    ['Blocked', tree.nodes.filter((n) => isLeaf(tree, n.id) && n.status === 'blocked').length],
    ['Contributors', db().contributors.length],
  ];
  $('metrics').innerHTML = rows.map(([label, value]) => `
    <div class="metric">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
    </div>`).join('');
}

function chipsFor(id, limit = 5) {
  return contributorMix(tree, id).slice(0, limit).map((c) =>
    `<span class="chip">${esc(contributor(c.contributor_id).name)}<span class="count">${c.pct.toFixed(0)}%</span></span>`
  ).join('');
}

function renderSystems() {
  const tops = children(tree, 'root');
  // Bars are scaled against the biggest system, not against 100 — with four
  // even systems every bar would otherwise sit at a quarter and read as "low".
  const maxShare = Math.max(...tops.map((n) => companyShare(tree, n.id)), 1e-9);
  $('systems').innerHTML = tops.map((n) => {
    const share = companyShare(tree, n.id);
    return `
      <div class="share-row">
        <div>
          <b>${esc(n.title)}</b>
          <div class="chips">${chipsFor(n.id)}</div>
        </div>
        <div class="track"><div style="width:${(share / maxShare) * 100}%"></div></div>
        <div class="muted" style="text-align:right">${(share * 100).toFixed(0)}%</div>
      </div>`;
  }).join('');
}

function renderBlockers() {
  const blocked = tree.nodes.filter(
    (n) => (isLeaf(tree, n.id) && n.status === 'blocked') || /block/i.test(n.notes ?? ''));
  $('blockers').innerHTML = blocked.length
    ? blocked.map((n) => `
        <div class="log-item">
          <b>${esc(n.title)}</b>
          <div class="muted" style="margin-top:4px">${esc(n.notes) || 'No note.'}</div>
        </div>`).join('')
    : '<div class="muted">No blockers recorded.</div>';
}

// ---------------------------------------------------------------- tree

function treeNodeHtml(n) {
  const kids = children(tree, n.id);
  const share = companyShare(tree, n.id) * 100;
  const isRoot = n.type === 'root';
  return `<li>
    <div class="node ${esc(n.type)}" data-node="${esc(n.id)}">
      <div class="node-title">${esc(n.title)}</div>
      <div class="chips">${chipsFor(n.id, 3)}</div>
      <div class="node-meta">
        <span>${isRoot ? '' : `weight ${Number(n.weight ?? 1)}`}</span>
        <span>${isRoot ? '' : `${share.toFixed(1)}% of co.`}</span>
      </div>
      <div class="node-meta">
        <span>${esc(statusLabel(rolledStatus(tree, n.id)))}</span>
        <span>${kids.length ? `<span class="node-share">${kids.length} children</span>` : ''}</span>
      </div>
    </div>
    ${kids.length ? `<ul>${kids.map(treeNodeHtml).join('')}</ul>` : ''}
  </li>`;
}

function renderTree() {
  $('treeRoot').innerHTML = `<ul>${treeNodeHtml(tree.root)}</ul>`;
  document.querySelectorAll('[data-node]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.node.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      openNode(el.dataset.node);
    });
  });
}

// ---------------------------------------------------------------- credit

function renderCredit() {
  const rows = creditByContributor(tree);
  if (!rows.length) {
    $('creditRows').innerHTML = '<div class="empty">No contributions assigned yet.</div>';
    return;
  }
  const maxAlloc = Math.max(...rows.map((r) => r.allocated), 1);
  $('creditRows').innerHTML = rows.map((r) => {
    const p = contributor(r.contributor_id);
    return `
      <div class="credit-row">
        <div class="name">
          <div class="avatar">${esc((p.name || '?').slice(0, 1).toUpperCase())}</div>
          <div style="min-width:0">
            <b>${esc(p.name)}</b>
            <div class="muted">${esc(p.role || '')}</div>
          </div>
        </div>
        <div class="credit-bars">
          <div class="bar alloc"><div style="width:${(r.allocated / maxAlloc) * 100}%"></div></div>
        </div>
        <div class="credit-num"><b>${pct(r.allocated)}</b><span>of roadmap</span></div>
      </div>`;
  }).join('');

  // Leaves with nobody assigned hold real company share that belongs to no one.
  // Show it, or the Credit column looks broken when it simply isn't finished.
  const unstaffed = leaves(tree).filter((l) => !(l.contributions ?? []).length);
  const unstaffedShare = unstaffed.reduce((s, l) => s + companyShare(tree, l.id) * 100, 0);
  if (unstaffedShare > 0.05) {
    $('creditRows').insertAdjacentHTML('beforeend', `
      <div class="credit-row unassigned">
        <div class="name">
          <div class="avatar" style="background:#2a3038">?</div>
          <div style="min-width:0">
            <b>Unassigned</b>
            <div class="muted">${unstaffed.length} node${unstaffed.length === 1 ? '' : 's'} with no contributors</div>
          </div>
        </div>
        <div class="credit-bars">
          <div class="bar alloc"><div style="width:${(unstaffedShare / maxAlloc) * 100}%;background:#3a4350"></div></div>
        </div>
        <div class="credit-num"><b>${pct(unstaffedShare)}</b><span>of roadmap</span></div>
      </div>`);
  }
}

// ---------------------------------------------------------------- people

function renderPeople() {
  const credit = new Map(creditByContributor(tree).map((c) => [c.contributor_id, c]));
  $('peopleGrid').innerHTML = db().contributors.map((p) => {
    const c = credit.get(p.id) ?? { allocated: 0, leaf_count: 0 };
    return `
      <div class="person-card" data-person="${esc(p.id)}">
        <div class="person-top">
          <div class="avatar">${esc((p.name || '?').slice(0, 1).toUpperCase())}</div>
          <div>
            <h4>${esc(p.name)}</h4>
            <p>${esc(p.role || 'No role yet')}</p>
          </div>
        </div>
        <div class="person-stats">
          <div class="stat"><b>${pct(c.allocated)}</b><span>Allocated</span></div>
          <div class="stat"><b>${c.leaf_count}</b><span>Nodes</span></div>
        </div>
        <p style="margin-top:12px">${esc(p.bio || 'No profile notes yet.')}</p>
      </div>`;
  }).join('');
  document.querySelectorAll('[data-person]').forEach((el) => {
    el.addEventListener('click', () => openPerson(el.dataset.person));
  });
}

// ---------------------------------------------------------------- history

function renderHistory() {
  $('historyTable').innerHTML = (db().history ?? []).map((h) => `
    <tr>
      <td>${esc(h.date)}</td>
      <td>${esc(nodeById(h.node_id)?.title ?? '')}</td>
      <td>${esc(contributor(h.contributor_id).name)}</td>
      <td>${esc(h.type)}</td>
      <td>${esc(h.note)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No notes yet.</td></tr>';

  $('auditTable').innerHTML = auditRows.length
    ? auditRows.map((a) => `
        <tr>
          <td>${esc(new Date(a.at).toLocaleString())}</td>
          <td>${esc(a.actor ?? '')}</td>
          <td>${esc(a.node_title || a.node_id || '')}</td>
          <td>${esc(a.field)}</td>
          <td>${esc(a.old_value)} → <b>${esc(a.new_value)}</b></td>
        </tr>`).join('')
    : `<tr><td colspan="5" class="muted">${store.mode === 'local'
        ? 'Change log needs the Supabase backend.' : 'No changes recorded yet.'}</td></tr>`;
}

// ---------------------------------------------------------------- drawer

const drawer = () => $('drawer');
function openDrawer() {
  drawer().classList.add('open');
  $('overlay').classList.add('show');
}
function closeDrawer() {
  drawer().classList.remove('open');
  $('overlay').classList.remove('show');
}

const readOnlyNote = () => '';

// ---------------------------------------------------------------- structure edits

const NODE_TYPES = ['category', 'kpi', 'branch', 'milestone'];

const newId = () => 'n' + Math.random().toString(36).slice(2, 10);

/** Sensible default type for a child of `parent`. Type is cosmetic; only 'root' is load-bearing. */
function defaultChildType(parent) {
  return { root: 'category', category: 'kpi', kpi: 'milestone', branch: 'milestone' }[parent.type]
    ?? 'milestone';
}

/**
 * Add a child under `parentId`.
 *
 * If the parent was a leaf, it stops being one — it may no longer hold
 * contributions of its own (that would double-count against its children). So
 * the FIRST child inherits the parent's status and split, which keeps every
 * number in the tree exactly where it was.
 */
function addChildNode(parentId, title) {
  const parent = nodeById(parentId);
  const firstChild = children(tree, parentId).length === 0;
  const child = {
    id: newId(),
    parent_id: parentId,
    type: defaultChildType(parent),
    title: title.trim() || 'Untitled',
    weight: 1,
    status: 'not_started',
    target_date: '',
    notes: '',
    contributions: [],
  };
  if (firstChild) {
    child.status = parent.status ?? 'not_started';
    child.contributions = parent.contributions ?? [];
    parent.contributions = [];
  }
  db().nodes.push(child);
  return child;
}

/**
 * Remove a node and everything under it.
 *
 * If this empties the parent, the parent becomes a leaf again — so it needs its
 * own split back, or the credit it was carrying vanishes. We capture its
 * rolled-up values first and write them down onto it, which is the exact
 * inverse of what addChildNode does when a leaf gains its first child.
 */
function deleteSubtree(id) {
  const node = nodeById(id);
  const parentId = node?.parent_id ?? null;
  const parent = parentId != null ? nodeById(parentId) : null;
  const willEmptyParent = parent && children(tree, parentId).length === 1;

  // Snapshot before the tree changes underneath us.
  const carriedStatus = willEmptyParent ? rolledStatus(tree, parentId) : null;
  const carriedSplit = willEmptyParent ? normalizeSplit(contributorMix(tree, parentId)) : null;

  const doomed = new Set(subtreeIds(id));
  db().nodes = db().nodes.filter((n) => !doomed.has(n.id));
  db().history = (db().history ?? []).filter((h) => !doomed.has(h.node_id));

  if (willEmptyParent) {
    parent.status = carriedStatus;
    parent.contributions = carriedSplit;
  }
  return [...doomed];
}

function subtreeIds(id) {
  const out = [];
  (function walk(nid) {
    out.push(nid);
    children(tree, nid).forEach((c) => walk(c.id));
  })(id);
  return out;
}

/**
 * Persist after a structural change, but only if the result is still a valid
 * tree. buildTree throws on cycles and orphans; catching here means a bad move
 * is refused with a message instead of leaving the page unrenderable.
 */
async function saveStructure(auditEntries) {
  try {
    buildTree(db().nodes);
  } catch (e) {
    return { ok: false, message: `Refused — that would break the tree: ${e.message}` };
  }
  return save(auditEntries);
}

// ---------------------------------------------------------------- node drawer

function openNode(id) {
  const n = nodeById(id);
  const leaf = isLeaf(tree, id);
  const kids = children(tree, id);
  const isRoot = n.parent_id == null;

  $('drawerTitle').textContent = n.title;
  $('drawerPath').textContent = pathTo(tree, id).map((x) => x.title).join(' / ');

  const statusBlock = leaf
    ? `<div class="field">
         <label>Status</label>
         <select id="nodeStatus">
           ${['not_started', 'in_progress', 'blocked', 'done'].map((s) =>
             `<option value="${s}" ${s === n.status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
         </select>
       </div>`
    : `<div class="field">
         <label>Status (computed)</label>
         <div class="computed">${statusLabel(rolledStatus(tree, id))}</div>
       </div>`;

  const splitBlock = leaf ? `
    <div class="field">
      <div class="split-head">
        <label style="margin:0">Contribution split</label>
        <div class="split-actions">
          <span class="total-badge" id="splitTotal">100%</span>
          <button class="btn" id="splitEvenBtn">Split evenly</button>
          <button class="btn" id="splitNormBtn">Normalize</button>
        </div>
      </div>
      <div id="splitRows"></div>
      <div class="readout">Must total exactly 100%. This node is
        <b>${pct(companyShare(tree, id) * 100, 2)}</b> of the company, so each point here is
        ${pct(companyShare(tree, id), 3)} of total credit.</div>
    </div>`
    : `<div class="field">
      <label>Rolled-up contribution</label>
      <div class="chips">${chipsFor(id, 20) || '<span class="muted">None yet.</span>'}</div>
      <div class="readout">Weighted by each descendant's share, across
        ${subtreeLeaves(tree, id).length} leaf nodes. Set percentages on the leaves themselves.</div>
    </div>`;

  // Everything except self and own descendants is a legal new parent.
  const banned = new Set(subtreeIds(id));
  const moveOptions = tree.nodes
    .filter((x) => !banned.has(x.id))
    .map((x) => `<option value="${esc(x.id)}" ${x.id === n.parent_id ? 'selected' : ''}>${esc(pathTo(tree, x.id).map((p) => p.title).join(' / '))}</option>`)
    .join('');

  $('drawerBody').innerHTML = `
    <div class="field">
      <label>Title</label>
      <input id="nodeTitle" value="${esc(n.title)}">
    </div>
    <div class="two">
      <div class="field">
        <label>Type</label>
        <select id="nodeType" ${isRoot ? 'disabled' : ''}>
          ${isRoot ? '<option>root</option>' : NODE_TYPES.map((t) =>
            `<option value="${t}" ${t === n.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Target date</label>
        <input id="nodeTarget" type="date" value="${esc(n.target_date ?? '')}">
      </div>
    </div>
    <div class="field">
      <label>Weight (relative to siblings)</label>
      <input id="nodeWeight" type="number" min="0" step="0.5" value="${n.weight ?? 1}" ${isRoot ? 'disabled' : ''}>
    </div>
    <div class="readout" id="weightReadout"></div>
    ${statusBlock}
    ${splitBlock}
    <div class="field">
      <label>Notes / who did what</label>
      <textarea id="nodeNotes">${esc(n.notes ?? '')}</textarea>
    </div>

    <button class="btn primary" id="saveNodeBtn">Save changes</button>
    <div class="readout" id="saveMsg"></div>

    <div class="struct">
      <div class="struct-head">Structure</div>
      <div class="field">
        <label>Add a child under this node</label>
        <div class="add-row">
          <input id="newChildTitle" placeholder="New node title…">
          <button class="btn" id="addChildBtn">Add</button>
        </div>
        ${leaf ? `<div class="readout">This node is a leaf. Its first child inherits
          the current split, so nothing shifts.</div>` : ''}
      </div>
      ${isRoot ? '' : `
      <div class="field">
        <label>Move under</label>
        <select id="moveParent">${moveOptions}</select>
        <div class="readout">Its own descendants are excluded — a node can't be moved inside itself.</div>
      </div>
      <button class="btn danger" id="deleteNodeBtn">Delete${kids.length ? ` node and ${subtreeIds(id).length - 1} descendant${subtreeIds(id).length === 2 ? '' : 's'}` : ' node'}</button>`}
      <div class="readout" id="structMsg"></div>
    </div>
  `;

  openDrawer();

  // --- weight readout, live
  const weightInput = $('nodeWeight');
  const updateWeightReadout = () => {
    if (isRoot) {
      $('weightReadout').textContent = 'The root is the whole company by definition.';
      return;
    }
    const siblings = children(tree, n.parent_id);
    const proposed = Math.max(0, Number(weightInput.value) || 0);
    const others = siblings.filter((s) => s.id !== n.id)
      .reduce((s, x) => s + (Number(x.weight) || 0), 0);
    const total = others + proposed;
    const shareOfParent = total > 0 ? proposed / total : 1 / siblings.length;
    const parentShare = companyShare(tree, n.parent_id);
    $('weightReadout').innerHTML =
      `= <b>${pct(shareOfParent * 100)}</b> of ${esc(nodeById(n.parent_id).title)} · ` +
      `<b>${pct(shareOfParent * parentShare * 100, 2)}</b> of the company` +
      (siblings.length > 1 ? ` &nbsp;<span class="muted">(${siblings.length} siblings)</span>` : '');
  };
  weightInput.addEventListener('input', updateWeightReadout);
  updateWeightReadout();

  // --- contribution split editor
  //
  // Structure is rendered ONCE per membership change. Dragging a slider only
  // updates values in place — re-rendering innerHTML mid-drag destroys the
  // element under the pointer, which is what made the sliders un-draggable.
  let working = leaf ? structuredClone(n.contributions ?? []) : [];
  const pctOf = (cid) => working.find((c) => c.contributor_id === cid)?.pct ?? 0;

  function syncSplit() {
    const { ok, total } = validateSplit(working);
    const badge = $('splitTotal');
    if (badge) {
      badge.textContent = `${total.toFixed(0)}%`;
      badge.className = `total-badge ${ok || !working.length ? '' : 'bad'}`;
    }
    const saveBtn = $('saveNodeBtn');
    if (saveBtn) {
      const valid = !working.length || ok;
      saveBtn.disabled = !valid;
      saveBtn.title = valid ? '' : 'Contribution split must total exactly 100%';
    }
  }

  /** Push `working` values into the inputs without touching the DOM structure. */
  function refreshSplitValues(exceptEl) {
    $('splitRows').querySelectorAll('[data-row]').forEach((row) => {
      const cid = row.dataset.row;
      const on = working.some((c) => c.contributor_id === cid);
      const v = pctOf(cid);
      row.classList.toggle('off', !on);
      row.querySelectorAll('input[data-range], input[data-num]').forEach((el) => {
        el.disabled = !on;
        if (el !== exceptEl && el.value !== String(v)) el.value = v;
      });
    });
    syncSplit();
  }

  function drawSplit() {
    if (!leaf) return;
    $('splitRows').innerHTML = db().contributors.map((p) => {
      const on = working.some((c) => c.contributor_id === p.id);
      const v = pctOf(p.id);
      return `
        <div class="split-row ${on ? '' : 'off'}" data-row="${esc(p.id)}">
          <div class="who">
            <input type="checkbox" data-toggle="${esc(p.id)}" ${on ? 'checked' : ''}>
            <span>${esc(p.name)}</span>
          </div>
          <input type="range" min="0" max="100" step="1" value="${v}" data-range="${esc(p.id)}" ${on ? '' : 'disabled'}>
          <input type="number" min="0" max="100" step="1" value="${v}" data-num="${esc(p.id)}" ${on ? '' : 'disabled'}>
        </div>`;
    }).join('');

    $('splitRows').querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('change', () => {
        const cid = el.dataset.toggle;
        if (el.checked) working.push({ contributor_id: cid, pct: 0 });
        else working = working.filter((c) => c.contributor_id !== cid);
        drawSplit();   // membership changed: structure must be rebuilt
      });
    });

    const setPct = (cid, v, sourceEl) => {
      const row = working.find((c) => c.contributor_id === cid);
      if (row) row.pct = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      refreshSplitValues(sourceEl);   // values only — never innerHTML
    };
    $('splitRows').querySelectorAll('[data-range]').forEach((el) =>
      el.addEventListener('input', () => setPct(el.dataset.range, el.value, el)));
    $('splitRows').querySelectorAll('[data-num]').forEach((el) => {
      el.addEventListener('input', () => setPct(el.dataset.num, el.value, el));
      el.addEventListener('change', () => refreshSplitValues());
    });

    syncSplit();
  }

  if (leaf) {
    drawSplit();
    $('splitEvenBtn').onclick = () => {
      working = evenSplit(working.map((c) => c.contributor_id));
      refreshSplitValues();
    };
    $('splitNormBtn').onclick = () => {
      working = normalizeSplit(working);
      refreshSplitValues();
    };
  }

  // --- save field edits
  $('saveNodeBtn').onclick = async () => {
    const before = structuredClone(n);
    const btn = $('saveNodeBtn');
    n.title = $('nodeTitle').value.trim() || n.title;
    if (!isRoot) {
      n.type = $('nodeType').value;
      n.weight = Math.max(0, Number(weightInput.value) || 0);
    }
    n.target_date = $('nodeTarget').value;
    if (leaf) {
      n.status = $('nodeStatus').value;
      n.contributions = working.filter((c) => c.pct > 0);
    }
    n.notes = $('nodeNotes').value.trim();

    btn.disabled = true;
    btn.textContent = 'Saving…';
    const res = await save(diffNode(before, n));
    btn.textContent = 'Save changes';
    btn.disabled = false;

    if (res.ok) {
      renderAll();
      closeDrawer();
    } else {
      Object.assign(n, before);
      $('saveMsg').innerHTML = `<span style="color:var(--danger)">${esc(res.message)}</span>`;
      if (res.conflict) {
        banner(`${esc(res.message)} Your edit was not saved.`, 'bad',
          { label: 'Reload', fn: () => window.location.reload() });
      }
    }
  };

  // --- structure: add child
  const addChild = async () => {
    const title = $('newChildTitle').value.trim();
    if (!title) return;
    const btn = $('addChildBtn');
    btn.disabled = true;
    const child = addChildNode(id, title);
    const res = await saveStructure([{
      node_id: child.id, node_title: child.title, field: 'created',
      old_value: '', new_value: `under ${n.title}`,
    }]);
    btn.disabled = false;
    if (res.ok) {
      renderAll();
      openNode(child.id);         // drop straight into the new node
    } else {
      deleteSubtree(child.id);
      $('structMsg').innerHTML = `<span style="color:var(--danger)">${esc(res.message)}</span>`;
    }
  };
  $('addChildBtn').onclick = addChild;
  $('newChildTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') addChild(); });

  if (!isRoot) {
    // --- structure: move
    $('moveParent').onchange = async (e) => {
      const target = e.target.value;
      if (target === n.parent_id) return;
      const prev = n.parent_id;
      n.parent_id = target;
      const res = await saveStructure([{
        node_id: n.id, node_title: n.title, field: 'moved',
        old_value: nodeById(prev)?.title ?? prev, new_value: nodeById(target)?.title ?? target,
      }]);
      if (res.ok) {
        renderAll();
        openNode(id);
      } else {
        n.parent_id = prev;
        e.target.value = prev;
        $('structMsg').innerHTML = `<span style="color:var(--danger)">${esc(res.message)}</span>`;
      }
    };

    // --- structure: delete
    let armed = false;
    $('deleteNodeBtn').onclick = async (e) => {
      const btn = e.currentTarget;
      const count = subtreeIds(id).length;
      if (!armed) {
        armed = true;
        btn.textContent = count > 1
          ? `Really delete ${count} nodes? Click again`
          : 'Really delete? Click again';
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          btn.textContent = count > 1 ? `Delete node and ${count - 1} descendants` : 'Delete node';
        }, 4000);
        return;
      }
      btn.disabled = true;
      const snapshot = structuredClone(db().nodes);
      deleteSubtree(id);
      const res = await saveStructure([{
        node_id: n.id, node_title: n.title, field: 'deleted',
        old_value: `${count} node${count === 1 ? '' : 's'}`, new_value: '',
      }]);
      if (res.ok) {
        renderAll();
        closeDrawer();
      } else {
        db().nodes = snapshot;
        btn.disabled = false;
        armed = false;
        $('structMsg').innerHTML = `<span style="color:var(--danger)">${esc(res.message)}</span>`;
      }
    };
  }
}

function diffNode(before, after) {
  const out = [];
  const push = (field, o, v) => {
    if (String(o) !== String(v)) {
      out.push({
        node_id: after.id, node_title: after.title, field,
        old_value: String(o), new_value: String(v),
      });
    }
  };
  push('weight', before.weight, after.weight);
  push('status', before.status, after.status);
  push('notes', (before.notes ?? '').slice(0, 120), (after.notes ?? '').slice(0, 120));
  const fmt = (list) => (list ?? []).map((c) => `${contributor(c.contributor_id).name} ${c.pct}%`).join(', ');
  push('contributions', fmt(before.contributions), fmt(after.contributions));
  return out;
}

function openPerson(id) {
  const p = contributor(id);
  const ro = store.canEdit ? '' : 'disabled';
  $('drawerTitle').textContent = p.name;
  $('drawerPath').textContent = 'Contributor profile';
  const owned = tree.nodes.filter((n) =>
    (n.contributions ?? []).some((c) => c.contributor_id === id));
  $('drawerBody').innerHTML = `
    ${readOnlyNote()}
    <div class="field"><label>Name</label><input id="pName" value="${esc(p.name)}" ${ro}></div>
    <div class="field"><label>Role</label><input id="pRole" value="${esc(p.role ?? '')}" ${ro}></div>
    <div class="field"><label>Bio</label><textarea id="pBio" ${ro}>${esc(p.bio ?? '')}</textarea></div>
    <div class="field"><label>Contact</label><input id="pContact" value="${esc(p.contact ?? '')}" ${ro}></div>
    <div class="field">
      <label>Nodes (${owned.length})</label>
      ${owned.map((n) => `<div class="log-item"><b>${esc(n.title)}</b>
        <div class="muted">${pct((n.contributions.find((c) => c.contributor_id === id)?.pct) ?? 0, 0)}
        of a node worth ${pct(companyShare(tree, n.id) * 100, 2)} of the company</div></div>`).join('')
        || '<div class="muted">Not assigned to any node yet.</div>'}
    </div>
    ${store.canEdit ? '<button class="btn primary" id="savePersonBtn">Save profile</button>' : ''}
    <div class="readout" id="saveMsg"></div>`;
  openDrawer();
  if (!store.canEdit) return;
  $('savePersonBtn').onclick = async () => {
    p.name = $('pName').value.trim() || p.name;
    p.role = $('pRole').value.trim();
    p.bio = $('pBio').value.trim();
    p.contact = $('pContact').value.trim();
    const res = await save([{ node_id: null, node_title: p.name, field: 'profile', old_value: '', new_value: 'edited' }]);
    if (res.ok) { renderAll(); closeDrawer(); }
    else $('saveMsg').innerHTML = `<span style="color:var(--danger)">${esc(res.message)}</span>`;
  };
}

function openNewContributor() {
  $('drawerTitle').textContent = 'New contributor';
  $('drawerPath').textContent = 'Create profile';
  $('drawerBody').innerHTML = `
    <div class="field"><label>Name</label><input id="newName"></div>
    <div class="field"><label>Role</label><input id="newRole"></div>
    <div class="field"><label>Bio</label><textarea id="newBio"></textarea></div>
    <div class="field"><label>Contact</label><input id="newContact"></div>
    <button class="btn primary" id="createContributorBtn">Create contributor</button>
    <div class="readout" id="saveMsg"></div>`;
  openDrawer();
  $('createContributorBtn').onclick = async () => {
    const name = $('newName').value.trim();
    if (!name) return;
    db().contributors.push({
      id: 'p' + Math.random().toString(36).slice(2, 10),
      name,
      role: $('newRole').value.trim(),
      bio: $('newBio').value.trim(),
      contact: $('newContact').value.trim(),
    });
    const res = await save([{ node_id: null, node_title: name, field: 'contributor', old_value: '', new_value: 'created' }]);
    if (res.ok) { renderAll(); closeDrawer(); }
    else $('saveMsg').innerHTML = `<span style="color:var(--danger)">${esc(res.message)}</span>`;
  };
}

function openBackup() {
  $('drawerTitle').textContent = 'Backup data';
  $('drawerPath').textContent = 'Current state as JSON';
  const json = JSON.stringify(db(), null, 2);
  $('drawerBody').innerHTML = `
    <div class="field">
      <label>JSON</label>
      <textarea id="backupText" style="min-height:360px;font-family:ui-monospace,Menlo,monospace;font-size:11px"></textarea>
    </div>
    <div class="actions">
      <button class="btn primary" id="downloadBackupBtn">Download .json</button>
      <button class="btn" id="selectBackupBtn">Select all</button>
    </div>`;
  openDrawer();
  const ta = $('backupText');
  ta.value = json;
  $('selectBackupBtn').onclick = () => { ta.focus(); ta.select(); };
  $('downloadBackupBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'o1kpi_backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

// ---------------------------------------------------------------- render all

function renderAll() {
  // Supabase fires an initial auth event before load() resolves, so this can be
  // reached before there is any data. Nothing to draw yet — boot renders next.
  if (!store.db) return;
  rebuild();
  renderChrome();
  refreshBanner();
  renderMetrics();
  renderSystems();
  renderBlockers();
  renderTree();
  renderCredit();
  renderPeople();
  renderHistory();
}

// ---------------------------------------------------------------- nav + tree nav

const VIEW_TITLES = {
  dashboard: 'Dashboard',
  tree: 'KPI Tree',
  credit: 'Credit',
  contributors: 'Contributors',
  history: 'Notes & History',
};

document.querySelectorAll('.nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(btn.dataset.view).classList.add('active');
    $('pageTitle').textContent = VIEW_TITLES[btn.dataset.view];
    if (btn.dataset.view === 'tree') centerRoot();
    setTimeout(updateDockVisibility, 0);
  });
});

$('closeDrawer').onclick = closeDrawer;
$('overlay').onclick = closeDrawer;
$('addPersonBtn').onclick = openNewContributor;
$('backupBtn').onclick = openBackup;

$('treeSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.node.selected').forEach((el) => el.classList.remove('selected'));
  if (!q) return;
  const match = [...document.querySelectorAll('[data-node]')]
    .find((el) => el.querySelector('.node-title')?.textContent.toLowerCase().includes(q));
  if (match) {
    match.classList.add('selected');
    match.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
});

const treeViewport = $('treeViewport');

/**
 * Centre the root node.
 *
 * Self-correcting: measures the gap, nudges, then re-measures on the next
 * frame until it is centred (or the retries run out). The first time the tree
 * section flips from display:none the geometry settles over a frame or two, so
 * a single measure-and-scroll lands short by a varying amount. Converging on
 * the measurement is more robust than trying to predict when layout is final.
 */
function centerRoot(retries = 4) {
  const el = document.querySelector('[data-node="root"]');
  const again = () => { if (retries > 0) requestAnimationFrame(() => centerRoot(retries - 1)); };

  if (!el || !treeViewport.clientWidth) return again();

  const v = treeViewport.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const dx = (r.left - v.left) - (treeViewport.clientWidth - r.width) / 2;
  const dy = (r.top - v.top) - 40;

  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;   // already there

  treeViewport.scrollTo({
    left: Math.max(0, treeViewport.scrollLeft + dx),
    top: Math.max(0, treeViewport.scrollTop + dy),
    // 'instant', not 'auto': per CSSOM-View, 'auto' defers to the element's CSS
    // scroll-behavior, which is `smooth` here — so 'auto' animates, and the
    // retries below end up chasing a moving target.
    behavior: 'instant',
  });
  again();
}
$('addTopNodeBtn').onclick = () => openNode('root');   // add-a-child lives in the node drawer
$('centerRootBtn').onclick = () => centerRoot();   // not `= centerRoot`: the MouseEvent would land in `retries`
$('fitTreeBtn').onclick = () => {
  treeViewport.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  centerRoot();
};

(function enableDragScroll() {
  let down = false, startX = 0, startY = 0, sl = 0, st = 0;
  treeViewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    down = true;
    treeViewport.classList.add('dragging');
    startX = e.clientX; startY = e.clientY;
    sl = treeViewport.scrollLeft; st = treeViewport.scrollTop;
  });
  window.addEventListener('pointerup', () => {
    down = false;
    treeViewport.classList.remove('dragging');
  });
  window.addEventListener('pointermove', (e) => {
    if (!down) return;
    treeViewport.scrollLeft = sl - (e.clientX - startX);
    treeViewport.scrollTop = st - (e.clientY - startY);
  });
})();

const dock = $('bottomScrollDock');
const range = $('treeScrollRange');
const maxScroll = () => Math.max(0, treeViewport.scrollWidth - treeViewport.clientWidth);
function syncRange() {
  const m = maxScroll();
  range.value = Math.round((m ? treeViewport.scrollLeft / m : 0) * 1000);
}
function updateDockVisibility() {
  const on = $('tree').classList.contains('active');
  dock.classList.toggle('show', on);
  if (on) syncRange();
}
treeViewport.addEventListener('scroll', syncRange, { passive: true });
range.addEventListener('input', () => { treeViewport.scrollLeft = maxScroll() * (Number(range.value) / 1000); });
$('scrollLeftBtn').onclick = () =>
  treeViewport.scrollBy({ left: -Math.max(260, treeViewport.clientWidth * 0.45), behavior: 'smooth' });
$('scrollRightBtn').onclick = () =>
  treeViewport.scrollBy({ left: Math.max(260, treeViewport.clientWidth * 0.45), behavior: 'smooth' });
window.addEventListener('resize', () => setTimeout(syncRange, 30));

// ---------------------------------------------------------------- boot

onChange(async (reason) => {
  if (reason === 'remote') {
    renderAll();
    banner('Someone else just saved — this page updated live.', '',
      { label: 'Dismiss', fn: () => banner('') });
    return;
  }
  if (reason === 'actor') {
    renderChrome();
  }
});

(async function boot() {
  try {
    await init();
    renderAll();
    if (store.mode === 'supabase') {
      auditRows = await recentAudit();
      renderHistory();
    }
    setTimeout(updateDockVisibility, 50);
  } catch (e) {
    console.error(e);
    document.querySelector('.content').innerHTML =
      `<div class="banner bad show">Failed to start: ${esc(e.message)}</div>`;
  }
})();
