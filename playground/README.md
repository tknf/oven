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
there). The panel is wired with the `accounts` option (DB-backed operator
accounts), so that first request bounces to `/admin/login`. Sign in with one
of the seeded dev-only accounts (never deploy this harness):

- `admin` / `playground-admin` — superuser, sees every screen
- `viewer` / `playground-viewer` — granted `jobs.view` and
  `resource.publishers.view` directly
- `editor` / `playground-editor` — granted the `publishers` resource's full
  CRUD set through membership in the "Editors" group

## Pages

- `/admin` — dashboard (filtered to the signed-in operator's granted
  permissions; the nav and resource list differ between `admin`, `viewer`,
  and `editor`)
- `/admin/resources/publishers` — resource list (search, filters, date
  hierarchy, pagination)
- `/admin/resources/publishers/pub-1/edit` — resource edit form with a
  `books` inline
- `/admin/jobs` — jobs console
- `/admin/settings` — feature flags and maintenance mode
- `/admin/audit` — audit log
- `/admin/accounts/users` — operator accounts management (superuser only;
  `viewer`/`editor` get a 403)
- `/admin/accounts/groups` — operator group management (superuser only)

## Data

The database is an in-memory libSQL instance seeded with publishers, books,
jobs, audit-log, and operator-account rows on startup. Feature flags and
maintenance mode run against an in-memory key-value store. Nothing persists
outside the running process — every restart starts from a fresh seed.
