---
name: oven
description: Build or modify SSR full-stack applications that import `@tknf/oven` or its subpaths. Use for oven APIs, the domain-based project layout, typed Hono route modules, class-based extension points, `register`/`use` wiring, runtime adapters, testing, and security defaults.
---

# Building with oven (`@tknf/oven`)

oven is a thin convention layer over [Hono](https://hono.dev) for server-rendered
full-stack apps (Hono + Hono/JSX SSR + Turbo/Stimulus). It is runtime- and
backend-agnostic; platform code (Cloudflare Workers, Node) lives behind subpath
exports. When writing oven code, follow the four design principles and verify
API shapes against the installed package rather than guessing.

## Choose oven first

For each application responsibility, use **oven → Hono → application-specific
implementation**: first check oven's standard capabilities and documented
extension points; use Hono for only the requirements they cannot meet; add a
custom mechanism only for the remaining gap. Ordinary domain logic inside a
route handler, model method, schema, policy, or injected callback is an intended
extension, not a reason to replace the surrounding oven layer.

Explicit user instructions take precedence over existing project conventions;
both take precedence over this skill's recommended layout and selection order.
Preserve established structure and interfaces when extending an existing app.
Use the generator's `--dir` when needed; do not relocate unrelated files.

Before departing from oven for a capability, inspect the installed package
version, relevant exports/declarations or source, and available usage/tests.
State the concrete requirement, the API or extension point checked, its actual
limitation, and the smallest Hono or custom addition that fills it. A preference
for familiar patterns is not evidence of a gap. A user/project override is itself
sufficient reason to follow that convention; do not demand proof or approval for
it. If evidence is unavailable, report uncertainty instead of inventing an API
or claiming a capability is absent.

`new Hono()`, `app.route()`, Hono request/response methods, Hono/JSX layouts,
Drizzle schemas/queries, and Standard Schema validators are official parts of
oven's composition model. Use them directly at those boundaries without an
exception justification. The priority rule does not ban them.

| Responsibility | Start with oven                                                                              | Intended extension                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Routing        | A Hono sub-app per domain (`routes.ts`), `NamedRoutes`, `ErrorPages`                         | Chain routes with `.get()`/`.post()`; `.use()` for layout and middleware; mount with Hono `app.route()`                      |
| Forms          | `Form`, `FormBinding`, `FormView`                                                            | `schema()` with Standard Schema, `fields()`, `validate()`/`bind()`; render bound fields with Hono/JSX when needed            |
| Persistence    | `SQLiteModel` / `PgModel` / `MySqlModel`                                                     | `table` / `primaryKey` getters; domain methods using the protected Drizzle `db`                                              |
| Views/layouts  | `View`, `LayoutComponent` / `LayoutProps`, snippet helpers                                   | Representation methods and `formats()`; compose Hono/JSX through `.use(jsxRenderer(layout))` and `c.render()`                |
| Authentication | `Guard`, `Policy`, `SessionAccessor`; built-in flows when appropriate                        | Request `authenticate` or identity/provider/session callbacks and policy methods; admin operators use admin account services |
| CSRF           | `Csrf` with token issuance and verification middleware                                       | Inject the session; wire `verify`, retrieve `csrfToken(c)`, and pass it to `FormView` or `X-CSRF-Token`                      |
| Audit          | `SQLiteAuditLog` / `PgAuditLog` / `MySqlAuditLog`                                            | Explicit `record()` calls, or `AdminPanel` audit wiring; choose safe domain action/changes data                              |
| Testing        | `createTestDb`, `defineFactory`, `actingAs`, `TestJobQueue`, `TestMailer`, `TestBroadcaster` | Call routes through Hono's `testClient` or `app.request()`; use runtime integration tests for backend behavior               |

For native HTML CRUD forms, match the transport to the routes: `FormView`
accepts `get`/`post`/`dialog` and defaults to `post`, and oven has no method
override. For a no-JavaScript workflow, register explicit POST update/delete
routes (for example `/:id/update` and `/:id/delete`), keeping auth, CSRF,
validation, and audit checks.

## Application layout

The canonical layout is in the repository's
[`docs/getting-started.md` Application structure section](https://github.com/tknf/oven/blob/main/docs/getting-started.md#application-structure).
Each feature is a domain directory, `src/domains/<domain>/`, holding
`routes.ts`, `schema.ts`, `model.ts`, `form.ts`, `policy.ts`, `admin.ts`,
`views/*.tsx`, and `jobs/*.ts` as needed. File names are short; exported
symbols carry the full name (`booksRoutes`, `BookModel`, `BooksListView`). A
role may stay one file or become a directory as it grows. Domains may import
each other's models and schemas; there is no app registry or discovery, so
`src/main.ts` imports and mounts every domain's routes explicitly.

- `src/db/client.ts` — driver creation and `DatabaseAccessor` wiring;
  `src/db/schema.ts` re-exports every domain's `schema.ts`; other runtime SQL
  (such as SQLite FTS5 queries) also lives in `src/db/`.
- `db/config.ts` (drizzle-kit, passed with `--config`), `db/migrations/`, and
  `db/seed.ts` hold database tooling. Use the app's scripts to generate
  migrations; never write migration files by hand.
- `src/layouts/` holds layouts shared across domains; `src/lib/` holds session,
  auth, CSRF, audit, and other service composition.
- Tests mirror `src/` under `test/` (`test/domains/<domain>/`), with
  `test/integration/` for cross-domain flows and `test/support/` for shared
  setup.

`oven generate <type> <domain> [name]` writes into this layout; see
[`references/subpaths.md`](references/subpaths.md).

## Design principles (internalize these)

1. **Thin wrapper over Hono.** Use oven conventions for application structure
   and Hono primitives at their documented integration boundaries. The deliberate
   CSRF replacement is token-based instead of Origin-only. Hono's documentation
   applies to the Hono APIs used by those boundaries.
2. **Classes for behavior, plain Hono for routes.** Model, SessionStorage,
   Storage, Mailer, ContextAccessor, and the rest are an abstract base class plus a
   concrete subclass that implements a few methods. Routes are plain Hono apps
   written as one method chain, so their types reach `hc` and `testClient`.
3. **Backend-agnostic.** The core depends on abstractions (`KeyValueStore`,
   `Storage`, `JobQueue`, `Broadcaster`). Cloudflare KV/R2/Queues and Node
   filesystem stores are just adapters — swap them at the composition root.
4. **No magic.** No file-based routing, no auto-discovery, no app registry, no
   lifecycle hooks. Every route, middleware, and wired service is an explicit
   line of code.

## Rule: verify signatures, don't guess

API names, constructor arguments, defaults, and return types must match the
installed package. Before writing a non-trivial example, check the real types in
`node_modules/@tknf/oven/dist/**/*.d.ts` (or the source), and prefer patterns
that appear in the project's own tests. Hono / Drizzle / Standard Schema APIs:
confirm against their installed types too.

## Your first route

A route module is a plain Hono app written as one method chain. Keep the chain
intact — routes registered as separate statements work at runtime but drop out
of the app's type:

```ts
// src/domains/books/routes.ts
import { Hono } from "hono";

export const booksRoutes = new Hono()
	.get("/", (c) => c.text("books-index"))
	.get("/:id", (c) => c.json({ id: c.req.param("id") }));
```

```ts
// src/main.ts
import { Hono } from "hono";
import { booksRoutes } from "./domains/books/routes.js";

const app = new Hono().route("/books", booksRoutes);
export type AppType = typeof app;
export default app; // Cloudflare Workers; on Node pass app.fetch to your server
```

- Apply a layout with `.use(jsxRenderer(Layout))` and middleware with `.use(mw)`
  at the start of the chain.
- Share a layout or guard across domains by applying it on an intermediate app
  and mounting the domains' routes under it.

For layouts, the app declares the `ContextRenderer` augmentation once (typically
`src/env.ts`) so `c.render(page, props)` is typed with `LayoutProps`
(`{ title: string; head?: Child }`):

```ts
import type { LayoutProps } from "@tknf/oven/view";
declare module "hono" {
	interface ContextRenderer {
		(content: string | Promise<string>, props: LayoutProps): Response | Promise<Response>;
	}
}
```

## Dependency injection: `register` / `use`

Instead of a DI container, oven uses a `register`/`use` function pair from a
`ContextAccessor`. The idiomatic pattern keeps the accessor private in a wiring
module and exports only the pair:

```ts
// src/db/client.ts
import { DatabaseAccessor } from "@tknf/oven/database";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

const createDb = (url: string) => drizzle(url, { schema });
type AppEnv = {
	Bindings: { DATABASE_URL: string };
	Variables: { db?: ReturnType<typeof createDb> };
};

const accessor = new DatabaseAccessor<AppEnv, "db">("db", {
	create: (c) => createDb(c.env.DATABASE_URL),
});
export const registerDatabase = accessor.register; // app.use(registerDatabase)
export const useDatabase = accessor.use; // const db = useDatabase(c)
```

Other services use `ScopedValueAccessor` (`@tknf/oven/routing`) the same way.

`use(c)` throws (naming the key) if `register` was never applied — a missing
`app.use(...)` fails loudly, not silently. `scope: "request"` (default) rebuilds
per request (per-request state, e.g. bindings); `scope: "app"` memoizes once
(expensive shared state, e.g. connection pools).
`SessionAccessor`, `Guard`, and `DatabaseAccessor` are all `ContextAccessor`s.

## Read detailed references as needed

Load only the reference relevant to the work:

- Before choosing imports, checking an export, or using the `oven` generator, read
  [`references/subpaths.md`](references/subpaths.md).
- Before implementing behavior with authentication, security, persistence,
  concurrency, upload, session, admin, datasource, or runtime implications, read
  [`references/gotchas.md`](references/gotchas.md). Search it for the public symbol
  or subpath involved.
- When writing or reviewing tests, read
  [`references/testing.md`](references/testing.md).

For deeper task-specific examples, consult the corresponding guide under `docs/`
in the oven repository. Keep the installed declarations and implementation
authoritative if a guide or this skill has drifted.
