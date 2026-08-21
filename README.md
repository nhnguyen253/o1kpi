# o1kpi — 01 Internal OS

A weighted KPI tree with per-node contribution splits, published on GitHub Pages
and backed by Supabase.

**Live:** https://nhnguyen253.github.io/o1kpi/

> ⚠️ This repo is **public**, and so is the dashboard. There is no sign-in:
> anyone with the URL can read **and edit** the KPI data, including fundraise
> figures and per-person notes. This is a deliberate trade for a small internal
> board — see "Who can edit" below, and `revoke-anon-editing.sql` to undo it.

---

## How the numbers work

**Weights.** Every node has a `weight`. Its share of its parent is its weight
over the sum of its siblings' weights — so weights are relative, and adding a
sibling never forces you to re-edit the others. All weights start at 1, which
means an even split.

**Progress rolls up.** You only type a progress number on *leaf* nodes. Every
parent is the weight-weighted average of its children, all the way to the root.
Nobody hand-types the company number any more.

**Contribution splits.** Each leaf carries percentages across contributors that
must total exactly 100. Splits live on leaves only — that is what makes credit
sum cleanly instead of double-counting a parent against its own children. If a
parent needs its own credit, add a child node for that work.

**Two credit numbers**, both on the Credit tab:

| | Meaning | Sums to |
|---|---|---|
| **Allocated** | Share of the whole roadmap you own | 100% |
| **Earned** | Share of progress *actually achieved* that's yours | company progress |

Earned is the honest one — being assigned to a not-started node earns nothing.

### One-time change from the old file

The old dashboard let you type a percentage at every level, so parents drifted
free of their children. Recomputing from even weights moves some numbers:

| Node | Was (hand-typed) | Now (computed) |
|---|---|---|
| **01 Company KPIs** | 46 | **47.5** |
| Engineering / Product | 68 | 72.5 |
| Credit / Risk | 55 | 59.7 |
| Partnership Acquisition | 38 | 30.5 |
| Capital | 30 | 27.5 |

That is the model working, not a regression. Tuning the weights — is Capital
really worth as much as Engineering? — is now an explicit argument you have in
the UI instead of a number someone typed once.

---

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

It must be served over HTTP — opening `index.html` from the filesystem fails
because ES module imports are blocked over `file://`.

With `config.js` left at its placeholders the app runs in **local mode**: it
loads `data/seed.json`, saves only to your browser's localStorage, and says so
in a banner. The whole UI is reviewable this way without a backend.

### Tests

```bash
node rollup.test.mjs      # 22 assertions — the credit/progress arithmetic
node structure.test.mjs   #  9 assertions — adding, moving and deleting nodes
```

`structure.test.mjs` covers the tricky part of editing the tree: adding a first
child under a leaf must leave every number in the company unchanged, deleting
the last child must hand the parent its progress and split back, and a node can
never be moved inside its own subtree.

`rollup.test.mjs` is 22 assertions over the real seed data: the rollup arithmetic, that leaf shares
sum to 1, that allocated credit sums to 100%, that earned credit sums to root
progress, plus weight edge cases (zero weights, all-equal weights, scaling) and
tree validation (cycles, orphans). Run this before touching `rollup.js`.

---

## Setting up the backend

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. **SQL Editor → New query** → paste all of `schema.sql` → Run.
3. **Project Settings → API** → copy the Project URL and the `anon` key into
   `config.js`. Both are publishable; the `service_role` key is *not* — never
   put it in this repo.
4. **Authentication → URL Configuration** → add
   `https://nhnguyen253.github.io/o1kpi/` to the redirect allowlist so magic
   links come back to the right page.
5. Commit and push. Sign in on the live page and hit Save once on any node —
   that publishes the seed into the database.

### Who can edit

**Anyone who opens the page.** There is no sign-in and no allowlist. Pick your
name from the dropdown in the header and start editing; that name is recorded as
the author of each change in the log.

Be clear-eyed about the trade: the anon key ships in a public page, so write
access is open to anyone who finds the URL, and the name you pick is a
self-asserted label, not a credential. What you keep is recoverability, not
prevention — `os_state.version` increments on every write and `os_audit` is an
append-only log, so damage is visible and reversible. **Hit Backup periodically**
and keep the JSON somewhere safe; that is the real safety net here.

To tighten later, without touching the data:

| Want | Run |
|---|---|
| Require a signed-in user | `revoke-anon-editing.sql` |
| Restrict to a named list | `revoke-anon-editing.sql`, then swap `true` → `is_editor()` and fill `allowed_editors` |

Both need the sign-in UI back — it lives in git history (commit `db stuff`).

### Making it private later

In `schema.sql`, the two `for select ... to anon, authenticated` policies are
what make the data public. Change them to `to authenticated` and re-run. Reads
then require a signed-in account. (Note that GitHub Pages itself stays public on
a free plan — this closes the *data*, not the page shell.)

---

## Editing the tree

Click any node to open it. Beyond progress and the split you can change its
**title, type, target date and weight**, and under **Structure**:

- **Add a child.** If the node was a leaf, its first child inherits the node's
  progress, status and split — so the company number doesn't jump when you break
  work into sub-tasks. Later children start empty.
- **Move under.** Pick a new parent. The node's own descendants are excluded, so
  you can't move a node inside itself.
- **Delete.** Removes the node and everything beneath it (click twice to
  confirm). If that empties the parent, the parent gets the subtree's rolled-up
  progress and contributor mix written back onto it, so deleting is the exact
  inverse of adding.

Structural edits are validated before they save — anything that would produce a
cycle or an orphan is refused with a message rather than breaking the page.

Nodes with no contributors assigned still hold company share; that share shows
up as an **Unassigned** row on the Credit tab rather than being silently
redistributed.

## Architecture

| File | Role |
|---|---|
| `index.html` | Markup and styles. No logic. |
| `rollup.js` | Pure weight/progress/credit math. No DOM, no deps, testable in node. |
| `app.js` | Rendering, the node drawer, the split editor. |
| `store.js` | Load/save, auth, realtime, the concurrency guard. |
| `config.js` | Supabase URL + anon key. |
| `schema.sql` | Tables, RLS policies, realtime. |
| `anon-editing.sql` | One-off: opens editing to everyone, no sign-in. **Currently in effect.** |
| `revoke-anon-editing.sql` | Undo: require a signed-in user again. |
| `open-editing.sql` | Intermediate step: signed-in users, no allowlist. |
| `data/seed.json` | First-run seed and offline fallback. |
| `migrate.mjs` | One-shot v1→v2 schema conversion. Already run; kept for reference. |
| `structure.test.mjs` | Tests for add / move / delete node. |
| `vendor/supabase.umd.js` | Pinned Supabase client (v2.58.0), vendored so the page has no CDN dependency. |

**Concurrency.** `os_state` has an integer `version`. A save matches on the
version it loaded; if zero rows update, someone else saved first and you get a
"reload?" prompt instead of silently clobbering their work. A realtime
subscription usually updates open tabs before that can happen.

**Audit.** Every field change writes a row to `os_audit`, shown under
Notes & History → Change log. The hand-written `history` notes are separate and
stay editorial.

---

## Deploying

Already configured to deploy from `main`. Push to `main` and Pages rebuilds.

**Expect a lag.** GitHub Pages serves assets with `cache-control: max-age=600`,
so for up to 10 minutes after a deploy a browser may keep using the old
`app.js` / `config.js`. If the page looks stale or wrong right after a push,
hard-reload (`Cmd+Shift+R`) before debugging anything.

First-time setup: **Settings → Pages → Source: Deploy from a branch →
`main` → `/ (root)`**.
