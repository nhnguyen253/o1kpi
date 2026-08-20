# o1kpi — 01 Internal OS

A weighted KPI tree with per-node contribution splits, published on GitHub Pages
and backed by Supabase.

**Live:** https://nhnguyen253.github.io/o1kpi/

> ⚠️ This repo is **public**, and so is the dashboard. Anyone with the URL can
> read the KPI data, including fundraise figures and per-person notes. Only
> allowlisted, signed-in editors can change anything. To close reads, see
> "Making it private" below.

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
node rollup.test.mjs
```

22 assertions over the real seed data: the rollup arithmetic, that leaf shares
sum to 1, that allocated credit sums to 100%, that earned credit sums to root
progress, plus weight edge cases (zero weights, all-equal weights, scaling) and
tree validation (cycles, orphans). Run this before touching `rollup.js`.

---

## Setting up the backend

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. **SQL Editor → New query** → paste all of `schema.sql` → Run.
3. Still in the SQL editor, add the team to the allowlist:
   ```sql
   insert into allowed_editors (email, note) values
     ('nam@…',    'Nam'),
     ('ethan@…',  'Ethan'),
     ('isaiah@…', 'Isaiah'),
     ('saif@…',   'LFG'),
     ('asad@…',   'Asad')
   on conflict (email) do nothing;
   ```
4. **Project Settings → API** → copy the Project URL and the `anon` key into
   `config.js`. Both are publishable; the `service_role` key is *not* — never
   put it in this repo.
5. **Authentication → URL Configuration** → add
   `https://nhnguyen253.github.io/o1kpi/` to the redirect allowlist so magic
   links come back to the right page.
6. Commit and push. Sign in on the live page and hit Save once on any node —
   that publishes the seed into the database.

### Adding or removing an editor

Insert into or delete from `allowed_editors` in the Supabase SQL editor. No
deploy needed; it takes effect on their next save.

### Making it private later

In `schema.sql`, the two `for select ... to anon, authenticated` policies are
what make the data public. Change them to `to authenticated` and re-run. Reads
then require a signed-in account. (Note that GitHub Pages itself stays public on
a free plan — this closes the *data*, not the page shell.)

---

## Architecture

| File | Role |
|---|---|
| `index.html` | Markup and styles. No logic. |
| `rollup.js` | Pure weight/progress/credit math. No DOM, no deps, testable in node. |
| `app.js` | Rendering, the node drawer, the split editor. |
| `store.js` | Load/save, auth, realtime, the concurrency guard. |
| `config.js` | Supabase URL + anon key. |
| `schema.sql` | Tables, RLS policies, realtime. |
| `data/seed.json` | First-run seed and offline fallback. |
| `migrate.mjs` | One-shot v1→v2 schema conversion. Already run; kept for reference. |
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

First-time setup: **Settings → Pages → Source: Deploy from a branch →
`main` → `/ (root)`**.
