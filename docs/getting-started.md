# Getting started

This guide walks through installing `@tknf/oven` and wiring up your first route.
For the design rationale behind the APIs used here, see [Concepts](./concepts.md).

## Prerequisites

- **ESM only.** `@tknf/oven`'s `package.json` `exports` map declares only the
  `default` condition, so it cannot be loaded via CommonJS `require()`. Your
  app must be an ESM project (`"type": "module"` or a bundler that resolves
  the `default`/`types` conditions).
- **A JavaScript runtime that supports Web-standard `Request`/`Response`**,
  such as Node.js or Cloudflare Workers. oven's core (`@tknf/oven`) is
  runtime-agnostic; platform-specific adapters live behind the
  `@tknf/oven/node` and `@tknf/oven/cloudflare` subpath exports.
- **Peer dependencies.** oven is built on top of [Hono](https://hono.dev) and,
  for the `model`/`database` modules, [Drizzle ORM](https://orm.drizzle.team).
  At the time of writing the supported versions are:

  | Package | Version | Required? |
  | --- | --- | --- |
  | `hono` | `^4.12.27` | always |
  | `drizzle-orm` | `^0.45.2` | if you use `@tknf/oven/model` or `@tknf/oven/database` |
  | `@libsql/client` | `^0.17.4` | optional (SQLite/libSQL adapters) |
  | `@cloudflare/workers-types` | `^5.0.0` | optional (only for Cloudflare Workers projects) |

## Installation

Install `@tknf/oven` together with the peer dependencies you need:

```sh
pnpm add @tknf/oven hono drizzle-orm
```

```sh
npm install @tknf/oven hono drizzle-orm
```

If you're working inside this repository (or a project that already uses
[vite-plus](https://viteplus.dev)), prefer `vp add` instead:

```sh
vp add @tknf/oven hono drizzle-orm
```

## Application structure

This is the canonical starting layout for a new oven application. For feature
selection, check **oven first, then Hono for the unmet requirement, then custom
code for any remaining gap**. Extend oven through its published hooks and
callbacks before replacing a layer. Domain logic in a model method or form
schema is normal application code. Hono app creation, mounting, request/response
methods, Hono/JSX rendering, Drizzle, and Standard Schema are intended integration
boundaries and require no exception.

Explicit user instructions override existing project conventions; both override
these defaults. Keep an existing app's structure and use `oven generate --dir`
where necessary. For other deviations, identify the concrete requirement and
check the installed oven version, exports, types/source, and usage/tests; explain
which standard capability or extension cannot meet it and why the chosen Hono
or custom addition is needed. Do not infer a missing API from unfamiliarity.
See the [application skill](../skills/oven/SKILL.md#choose-oven-first) for the
responsibility-to-API map.

oven organizes an application by **domain**: everything one feature needs — its
routes, tables, model, form, authorization policy, admin resource, views, and
jobs — lives in one directory under `src/domains/`. Database tooling lives in
the top-level `db/`, and tests mirror `src/` under `test/`.

```
db/
  config.ts              # drizzle-kit configuration (passed with --config)
  migrations/            # drizzle-kit output
  seed.ts                # seed script
src/
  main.ts                # compose the app and mount each domain's routes
  env.ts                 # bindings/context types and renderer augmentation
  db/
    client.ts            # driver creation and DatabaseAccessor wiring
    schema.ts            # re-exports every domain's schema.ts
  domains/
    books/
      routes.ts          # export const booksRoutes = new Hono<AppEnv>()...
      schema.ts          # Drizzle tables and relations only
      model.ts           # BookModel, importing its table from ./schema.js
      form.ts            # BookForm
      policy.ts          # BookPolicy
      admin.ts           # BookResource for AdminPanel
      views/
        list.tsx         # BooksListView or a Hono/JSX page component
        detail.tsx
      jobs/
        import_books.ts  # ImportBooksJob
  layouts/               # layouts shared across domains
  lib/                   # session, auth, CSRF, audit, and other services
test/
  domains/books/routes.test.ts
  integration/           # flows that span domains or the assembled app
  support/               # shared test setup
```

| Location | Responsibility | Generator behavior |
| --- | --- | --- |
| `src/main.ts` | Compose the Hono app, register middleware/services, mount each domain's routes | App-owned |
| `src/env.ts` | Application bindings/context types and renderer augmentation | App-owned |
| `src/domains/<domain>/routes.ts` | A Hono sub-app written as one method chain | `oven generate routes books` |
| `src/domains/<domain>/schema.ts` | Drizzle tables and relations, with no runtime initialization | `oven generate schema books book` |
| `src/domains/<domain>/model.ts` | Dialect-specific `Model` subclasses | `oven generate model books book` |
| `src/domains/<domain>/form.ts` | `Form` subclasses and validation schemas | `oven generate form books book` |
| `src/domains/<domain>/policy.ts` | `Policy` subclasses | `oven generate policy books book` |
| `src/domains/<domain>/admin.ts` | `AdminResource` subclasses | `oven generate admin books book` |
| `src/domains/<domain>/views/*.tsx` | One `View` subclass or page component per screen | `oven generate view books list` |
| `src/domains/<domain>/jobs/*.ts` | One `Job` subclass per file | `oven generate job books import_books` |
| `src/db/client.ts` | `DatabaseAccessor` and driver creation; export `register`/`use` wiring | App-owned |
| `src/db/schema.ts` | Re-exports every domain's tables for Drizzle, drizzle-kit, and `createTestDb` | App-owned |
| `src/db/` | Other runtime database code, such as raw SQL for an SQLite FTS5 search | App-owned |
| `src/layouts/*.tsx` | Hono/JSX layouts shared across domains | App-owned |
| `src/lib/` | Session, auth, CSRF, audit, and other service composition | App-owned |
| `db/config.ts` | drizzle-kit configuration, including `schema` and `out` | App-owned |
| `db/migrations/` | Generated migrations | Generated by the app's migration script, never by `oven generate` |
| `db/seed.ts` | Seed script | App-owned |
| `test/**` | Tests mirroring `src/`, plus `test/integration/` and `test/support/` | App-owned |

Only create the files needed for the feature. Runtime-specific entry points such
as `src/server.ts` or `src/worker.ts` may compose/import `src/main.ts` when needed.
There is no file-based discovery or app registry: `src/main.ts` imports each
domain's routes and mounts them explicitly. See [CLI](./cli.md) for every
generator type.

**Naming.** File names are short because the directory already names the
domain; exported symbols carry the full name (`BookModel`, `BooksListView`,
`booksRoutes`) so that search and auto-import find them unambiguously. A domain
may import another domain's model or schema directly.

**Single file or directory.** Each role may stay a single file or become a
directory once it grows: `view.tsx` or `views/*.tsx`, `job.ts` or `jobs/*.ts`,
`model.ts` or `models/*.ts`, and so on. The generator writes views and jobs as
one file per name because a domain usually has several of each.

For CRUD with native HTML forms, remember that `FormView` defaults to POST (and
accepts `get`/`post`/`dialog`). For a no-JavaScript form workflow, register
explicit POST routes for update and delete (for example `/:id/update` and
`/:id/delete`) and retain auth, CSRF, validation, and audit checks. A hidden
method field does not change the HTTP method by itself.

### Schema and database tooling

Each domain's `schema.ts` holds only table and relation definitions, so
drizzle-kit can load it without starting any runtime service. The app collects
them in one module:

```ts
// src/db/schema.ts
export * from "../domains/books/schema.js";
export * from "../domains/users/schema.js";
```

Pass that same module to drizzle-kit, to `drizzle(client, { schema })`, and to
`createTestDb`, so a table that is missing from it is missing everywhere rather
than only at runtime. Keep the drizzle-kit configuration in `db/config.ts` and
point every drizzle-kit script at it with `--config`. drizzle-kit resolves
`schema` and `out` from the current working directory, not from the
configuration file's location:

```ts
// db/config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
});
```

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate --config db/config.ts",
    "db:migrate": "drizzle-kit migrate --config db/config.ts"
  }
}
```

Generate migrations through these scripts after changing a schema, and point
`createTestDb`'s `migrationsFolder` at `db/migrations`. SQL that Drizzle cannot
express as a table definition, such as an SQLite FTS5 virtual table, belongs in
a migration created with `drizzle-kit generate --custom --config db/config.ts`;
the queries that use it at runtime belong in `src/db/`. Add `db` to
`tsconfig.json`'s `include` so the configuration and seed script are type
checked. See [Database](./database.md) for seeding and [Testing](./testing.md).

## Your first route

A route module is a plain Hono app written as one method chain. Keeping the
chain intact is what carries each route's path, parameters, and response type
into the app's type, where Hono's `hc` client and `testClient` read it:

```ts
// src/domains/books/routes.ts
import { Hono } from "hono";

export const booksRoutes = new Hono()
  .get("/", (c) => c.text("books-index"))
  .get("/:id", (c) => c.json({ id: c.req.param("id") }));
```

Mount it onto your app with Hono's `route()` method, again as a chain:

```ts
// src/main.ts
import { Hono } from "hono";
import { booksRoutes } from "./domains/books/routes.js";

const app = new Hono().route("/books", booksRoutes);

export type AppType = typeof app;
export default app;
```

`app` is a plain Hono app, so serving it follows Hono's own runtime
conventions. On Node, pass `app.fetch` to an HTTP adapter such as
[`@hono/node-server`](https://github.com/honojs/node-server) (`@tknf/oven/node`
ships filesystem-backed `KeyValueStore`/`Storage` implementations, not an HTTP
server). On Cloudflare Workers, `export default app` is all that's needed —
Hono's `fetch` handler is picked up automatically.

A request to `GET /books` now returns `books-index`.

## Rendering with a layout

Apply Hono's `jsxRenderer` with a layout component at the start of the chain;
`c.render(...)` is then available in every route after it:

```tsx
// src/domains/pages/routes.tsx
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import type { LayoutComponent } from "@tknf/oven/view";

const PageLayout: LayoutComponent = ({ title, children }) => (
  <html>
    <head>
      <title>{title}</title>
    </head>
    <body>{children}</body>
  </html>
);

export const pagesRoutes = new Hono()
  .use(jsxRenderer(PageLayout))
  .get("/", (c) => c.render(<p>hello</p>, { title: "Test Page" }));
```

The second argument to `c.render` is typed through Hono's `ContextRenderer`
interface, which is empty by default. Declare the augmentation once in your
app (typically alongside `src/env.ts`) so `c.render`'s second argument is
typed as `LayoutProps`:

```ts
// src/env.ts
import type { LayoutProps } from "@tknf/oven/view";

declare module "hono" {
  interface ContextRenderer {
    (content: string | Promise<string>, props: LayoutProps): Response | Promise<Response>;
  }
}
```

`LayoutProps` requires `title` and accepts an optional `head` slot for
page-specific `<meta>`/`<link>` elements. Deeper layouts (e.g. an
`AdminLayout` wrapping a `BaseLayout`) are function composition. A layout used
by several domains belongs in `src/layouts/`.

## Development commands

This repository uses [vite-plus](https://viteplus.dev) (`vp`) for all
package-manager and script operations:

```sh
vp install          # install dependencies
vp check            # lint + format
vp run typecheck    # type check
vp test             # run the test suite
```

If your own app doesn't use `vp`, the equivalent `pnpm`/`npm` scripts work
the same way — run whatever `check`/`typecheck`/`test` scripts you've wired
up in your `package.json`.

## See also

- [Concepts](./concepts.md) — the design principles behind oven's API surface,
  the request lifecycle, dependency injection, and the full subpath export
  reference.
