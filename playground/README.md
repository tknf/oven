# playground

A committed, Vite-based local preview of the admin panel (`@tknf/oven/admin`),
useful for eyeballing layout/CSS changes without writing a throwaway script.
It is part of the repo (covered by `vp check` / `vp run typecheck`) but is not
published — `package.json`'s `files` field only ships `dist`.

## Run it

From the repository root:

```sh
vp run playground
```

Then open <http://localhost:5173/admin> (or the root `/`, which redirects
there). Sign in with:

- username: `admin`
- password: `secret`

## Pages

- `/admin` — dashboard
- `/admin/resources/publishers` — resource list (search, filters, date
  hierarchy, pagination)
- `/admin/resources/publishers/pub-1/edit` — resource edit form with a
  `books` inline
- `/admin/jobs` — jobs console
- `/admin/settings` — feature flags and maintenance mode
- `/admin/audit` — audit log

## Data

The database is an in-memory libSQL instance seeded with publishers, books,
jobs, and audit-log rows on startup. Feature flags and maintenance mode run
against an in-memory key-value store. Nothing persists outside the running
process — every restart starts from a fresh seed.
