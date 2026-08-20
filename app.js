/**
 * 01 Internal OS — rendering and editing.
 *
 * Progress and credit come from rollup.js; nothing on this page hand-types a
 * parent's percentage any more. Persistence and auth come from store.js.
 */
import {
  buildTree, children, isLeaf, rolledProgress, rolledStatus, companyShare,
  weightShare, creditByContributor, contributorMix, subtreeLeaves,
  validateSplit, normalizeSplit, evenSplit, pathTo,
} from './rollup.js';
import { store, init, save, signIn, signOut, onChange, recentAudit } from './store.js';

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
  } else if (store.canEdit) {
    badge.className = 'badge live';
    badge.textContent = 'Live · editor';
  } else {
    badge.className = 'badge ro';
    badge.textContent = 'Live · read-only';
  }

  const bar = $('authbar');
  if (store.mode === 'local') {
    bar.innerHTML = '';
  } else if (store.user) {
    bar.innerHTML = `<span class="who" title="${esc(store.user.email)}">${esc(store.user.email)}</span>
      <button class="btn" id="signOutBtn">Sign out</button>`;
    $('signOutBtn').onclick = () => signOut();
  } else {
    bar.innerHTML = '<button class="btn" id="signInBtn">Sign in to edit</button>';
    $('signInBtn').onclick = openSignIn;
  }

  $('sidebarNote').innerHTML =
    store.mode === 'local'
      ? 'Local mode — changes stay in this browser and are <b>not shared</b>. Fill in config.js to go live.'
      : store.canEdit
        ? 'Signed in as an editor. Changes save for the whole team.'
        : 'Read-only. Sign in with an allowlisted email to edit.';

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
  const leaves = tree.nodes.filter((n) => isLeaf(tree, n.id));
  const rows = [
    ['Company progress', pct(rolledProgress(tree, 'root'))],
    ['Milestones complete', `${leaves.filter((n) => n.status === 'done').length}/${leaves.length}`],
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
  $('systems').innerHTML = children(tree, 'root').map((n) => {
    const p = rolledProgress(tree, n.id);
    return `
      <div class="progress-row">
        <div>
          <b>${esc(n.title)}</b>
          <div class="chips">${chipsFor(n.id)}</div>
        </div>
        <div class="track"><div style="width:${p}%"></div></div>
        <div class="muted" style="text-align:right">${p.toFixed(0)}%</div>
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
  const p = rolledProgress(tree, n.id);
  const share = companyShare(tree, n.id) * 100;
  const computed = kids.length > 0;
  return `<li>
    <div class="node ${esc(n.type)} ${computed ? 'computed-progress' : ''}" data-node="${esc(n.id)}">
      <div class="node-title">${esc(n.title)}</div>
      ${n.type !== 'root' ? `<div class="node-progress"><div style="width:${p}%"></div></div>` : ''}
      <div class="chips">${chipsFor(n.id, 3)}</div>
      <div class="node-meta">
        <span>${p.toFixed(0)}%${computed ? ' <span class="node-share">calc</span>' : ''}</span>
        <span>${n.type === 'root' ? '' : `${share.toFixed(1)}% of co.`}</span>
      </div>
      <div class="node-meta"><span>${esc(statusLabel(rolledStatus(tree, n.id)))}</span><span></span></div>
    </div>
    ${kids.length ? `<ul>${kids.map(treeNodeHtml).join('')}</ul>` : ''}
  </li>`;
}

function renderTree() {
  $('treeRoot').innerHTML = `<ul>${treeNodeHtml(tree.root)}</ul>`;
  $('rootProgressPill').textContent = `Company ${pct(rolledProgress(tree, 'root'))}`;
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
          <div class="bar earned"><div style="width:${(r.earned / maxAlloc) * 100}%"></div></div>
          <div class="bar alloc"><div style="width:${(r.allocated / maxAlloc) * 100}%"></div></div>
        </div>
        <div class="credit-num"><b>${pct(r.earned)}</b><span>earned</span></div>
        <div class="credit-num"><b>${pct(r.allocated)}</b><span>of roadmap</span></div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------- people

function renderPeople() {
  const credit = new Map(creditByContributor(tree).map((c) => [c.contributor_id, c]));
  $('peopleGrid').innerHTML = db().contributors.map((p) => {
    const c = credit.get(p.id) ?? { earned: 0, allocated: 0, leaf_count: 0 };
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
          <div class="stat"><b>${pct(c.earned)}</b><span>Earned</span></div>
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

const readOnlyNote = () =>
  store.canEdit ? '' :
    `<div class="callout">Read-only — ${store.mode === 'local'
      ? 'local mode' : 'sign in with an allowlisted email to make changes'}.</div>`;

function openNode(id) {
  const n = nodeById(id);
  const leaf = isLeaf(tree, id);
  const kids = children(tree, id);
  const ro = !store.canEdit ? 'disabled' : '';

  $('drawerTitle').textContent = n.title;
  $('drawerPath').textContent = pathTo(tree, id).map((x) => x.title).join(' / ');

  const progressBlock = leaf
    ? `<div class="field">
         <label>Progress %</label>
         <input id="nodeProgress" type="number" min="0" max="100" value="${n.progress ?? 0}" ${ro}>
       </div>`
    : `<div class="field">
         <label>Progress (computed)</label>
         <div class="computed"><b>${pct(rolledProgress(tree, id))}</b>
           <span class="muted"> — weighted average of ${kids.length} ${kids.length === 1 ? 'child' : 'children'}</span></div>
       </div>`;

  const statusBlock = leaf
    ? `<div class="field">
         <label>Status</label>
         <select id="nodeStatus" ${ro}>
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
          <button class="btn" id="splitEvenBtn" ${ro}>Split evenly</button>
          <button class="btn" id="splitNormBtn" ${ro}>Normalize</button>
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

  $('drawerBody').innerHTML = `
    ${readOnlyNote()}
    <div class="two">
      <div class="field">
        <label>Weight (relative to siblings)</label>
        <input id="nodeWeight" type="number" min="0" step="0.5" value="${n.weight ?? 1}"
          ${n.parent_id == null ? 'disabled' : ro}>
      </div>
      ${progressBlock}
    </div>
    <div class="readout" id="weightReadout"></div>
    ${statusBlock}
    ${splitBlock}
    <div class="field">
      <label>Notes / who did what</label>
      <textarea id="nodeNotes" ${ro}>${esc(n.notes ?? '')}</textarea>
    </div>
    ${store.canEdit ? '<button class="btn primary" id="saveNodeBtn">Save changes</button>' : ''}
    <div class="readout" id="saveMsg"></div>
  `;

  openDrawer();

  // --- weight readout, live
  const weightInput = $('nodeWeight');
  const updateWeightReadout = () => {
    if (n.parent_id == null) {
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
  let working = leaf ? structuredClone(n.contributions ?? []) : [];
  const pctOf = (cid) => working.find((c) => c.contributor_id === cid)?.pct ?? 0;

  function drawSplit() {
    if (!leaf) return;
    $('splitRows').innerHTML = db().contributors.map((p) => {
      const on = working.some((c) => c.contributor_id === p.id);
      const v = pctOf(p.id);
      return `
        <div class="split-row ${on ? '' : 'off'}" data-row="${esc(p.id)}">
          <div class="who">
            <input type="checkbox" data-toggle="${esc(p.id)}" ${on ? 'checked' : ''} ${ro}>
            <span>${esc(p.name)}</span>
          </div>
          <input type="range" min="0" max="100" step="1" value="${v}" data-range="${esc(p.id)}" ${on && store.canEdit ? '' : 'disabled'}>
          <input type="number" min="0" max="100" step="1" value="${v}" data-num="${esc(p.id)}" ${on && store.canEdit ? '' : 'disabled'}>
        </div>`;
    }).join('');

    const { ok, total } = validateSplit(working);
    const badge = $('splitTotal');
    badge.textContent = `${total.toFixed(0)}%`;
    badge.className = `total-badge ${ok || !working.length ? '' : 'bad'}`;
    const saveBtn = $('saveNodeBtn');
    if (saveBtn) {
      const valid = !working.length || ok;
      saveBtn.disabled = !valid;
      saveBtn.title = valid ? '' : 'Contribution split must total exactly 100%';
    }

    $('splitRows').querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('change', () => {
        const cid = el.dataset.toggle;
        if (el.checked) working.push({ contributor_id: cid, pct: 0 });
        else working = working.filter((c) => c.contributor_id !== cid);
        drawSplit();
      });
    });
    const setPct = (cid, v) => {
      const row = working.find((c) => c.contributor_id === cid);
      if (row) row.pct = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      drawSplit();
    };
    $('splitRows').querySelectorAll('[data-range]').forEach((el) =>
      el.addEventListener('input', () => setPct(el.dataset.range, el.value)));
    $('splitRows').querySelectorAll('[data-num]').forEach((el) =>
      el.addEventListener('change', () => setPct(el.dataset.num, el.value)));
  }

  if (leaf) {
    drawSplit();
    if (store.canEdit) {
      $('splitEvenBtn').onclick = () => {
        working = evenSplit(working.map((c) => c.contributor_id));
        drawSplit();
      };
      $('splitNormBtn').onclick = () => {
        working = normalizeSplit(working);
        drawSplit();
      };
    }
  }

  // --- save
  const saveBtn = $('saveNodeBtn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const before = structuredClone(n);
      if (n.parent_id != null) n.weight = Math.max(0, Number(weightInput.value) || 0);
      if (leaf) {
        n.progress = Math.max(0, Math.min(100, Number($('nodeProgress').value) || 0));
        n.status = $('nodeStatus').value;
        n.contributions = working.filter((c) => c.pct > 0);
      }
      n.notes = $('nodeNotes').value.trim();

      const entries = diffNode(before, n);
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const res = await save(entries);
      saveBtn.textContent = 'Save changes';
      saveBtn.disabled = false;

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
  push('progress', before.progress, after.progress);
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
  if (!store.canEdit) return openSignIn();
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

function openSignIn() {
  $('drawerTitle').textContent = 'Sign in';
  $('drawerPath').textContent = 'Magic link — no password';
  $('drawerBody').innerHTML = `
    <div class="field">
      <label>Email</label>
      <input id="signInEmail" type="email" placeholder="you@company.com" autocomplete="email">
    </div>
    <button class="btn primary" id="sendLinkBtn">Send magic link</button>
    <div class="readout" id="signInMsg">Only emails on the editor allowlist can save changes.</div>`;
  openDrawer();
  $('sendLinkBtn').onclick = async () => {
    const email = $('signInEmail').value.trim();
    if (!email) return;
    $('sendLinkBtn').disabled = true;
    const res = await signIn(email);
    $('sendLinkBtn').disabled = false;
    $('signInMsg').innerHTML = res.ok
      ? '<span style="color:#7fd7a4">Check your email for the link.</span>'
      : `<span style="color:var(--danger)">${esc(res.message)}</span>`;
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
  if (reason === 'auth') {
    renderAll();
    if (store.canEdit) auditRows = await recentAudit().then((r) => (auditRows = r, renderHistory(), r));
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
