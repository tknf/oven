# Routing

## What / Why

oven does not wrap Hono's router. A route module is a plain Hono app written as
one method chain, exported from its domain's `routes.ts`, and mounted with
`app.route(prefix, subApp)`. Keeping the chain intact preserves each route's
path, parameters, validator input, and response type in the app's type, so
Hono's `hc` client and `testClient` stay fully typed.

`@tknf/oven/routing` supplies the pieces Hono leaves to the application:

- **`ContextAccessor`** (and its concrete `ValueAccessor`/
  `ScopedValueAccessor`) — the `register`/`use` pair that stands in for a
  dependency-injection container: middleware computes a value once per
  request, and any downstream handler reads it back with a function call
  that throws loudly if the wiring was forgotten.
- **`NamedRoutes`** — type-safe reverse URL generation from an explicit
  "name → path template" table, for building links and redirects without
  hardcoding paths.
- **`ErrorPages`** / **`healthCheck`** — the shared 404/500 page and a
  liveness endpoint, wired the same `onError`/`notFound` way Hono itself
  expects.

For the design rationale and the request lifecycle, see
[Concepts](./concepts.md).

## Minimal example

```ts
// src/domains/books/routes.ts
import { Hono } from "hono";

export const booksRoutes = new Hono()
  .get("/", (c) => c.text("books-index"))
  .get("/:id", (c) => c.text(`book-${c.req.param("id")}`));
```

```ts
// src/main.ts
import { Hono } from "hono";
import { booksRoutes } from "./domains/books/routes.js";

const app = new Hono().route("/books", booksRoutes);

export type AppType = typeof app;
export default app;
```

## Common tasks

### Keeping routes typed for `hc` and `testClient`

Hono accumulates route types only through the value each method returns.
Registering routes as separate statements (`app.get(...); app.get(...);`)
still serves them, but drops them from the app's type. Write each route
module and the mounting code as chains, and export the app's type:

```ts
import { hc } from "hono/client";
import type { AppType } from "./main.js";

const client = hc<AppType>("https://example.com");
const res = await client.books[":id"].$get({ param: { id: "42" } });
```

In tests, `testClient(app)` from `hono/testing` gives the same typed calls
without a network round trip (see [Testing](./testing.md)). oven's own
sub-apps (`AdminPanel`, `MailPreviewHandler`) can be mounted anywhere in the
chain; their routes are untyped, but the routes around them keep their types.

### Registering CRUD routes

Write each action as its own route. Register static paths such as `/new`
before parameterized paths such as `/:id`, which would otherwise match them:

```ts
export const booksRoutes = new Hono<AppEnv>()
  .get("/", listBooks)
  .get("/new", newBook)
  .post("/", createBook)
  .get("/:id", showBook)
  .get("/:id/edit", editBook)
  .post("/:id/update", updateBook)
  .post("/:id/delete", deleteBook);
```

Native HTML forms can only send `GET` and `POST`, so a no-JavaScript
workflow uses `POST` routes for update and delete as above; use
`.on(["PATCH", "PUT"], "/:id", ...)` and `.delete("/:id", ...)` when the
client sends those methods.

### Sharing a layout and middleware across routes

Apply `jsxRenderer` and middleware with `.use()` at the start of a chain. A
path-less `.use()` applies only to the routes registered after it, so a route
placed before it never passes through it:

```tsx
// src/domains/books/routes.tsx
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";

export const booksRoutes = new Hono<AppEnv>()
  .use(jsxRenderer(PageLayout))
  .get("/", (c) => c.render(<p>books</p>, { title: "Books" }));
```

To share a layout and middleware across several domains, apply them on an
intermediate app and mount the domains' routes under it. Middleware added to
a domain's own chain runs after the shared middleware:

```ts
// src/main.ts
const adminApp = new Hono<AppEnv>()
  .use(jsxRenderer(AdminLayout))
  .use(requireAdminAuth)
  .route("/books", adminBooksRoutes)
  .route("/authors", adminAuthorsRoutes);

const app = new Hono<AppEnv>().route("/admin", adminApp);
```

### Injecting a shared value with `ContextAccessor`

Most services only need `ScopedValueAccessor`, which adds `scope`-based
memoization on top of `ValueAccessor`'s plain "compute once per request" —
`"request"` (default) recomputes the value on every request, right for
anything derived from per-request state such as bindings or credentials
handed to each invocation; `"app"` memoizes the first result for the
process's lifetime, right for values that are safe and expensive to build
once, such as a connection pool:

```ts
// src/db/client.ts
import { ScopedValueAccessor } from "@tknf/oven/routing";
import { drizzle } from "drizzle-orm/libsql";

type AppBindings = { DATABASE_URL: string };
type AppEnv = { Bindings: AppBindings; Variables: { db?: ReturnType<typeof drizzle> } };

const accessor = new ScopedValueAccessor<AppEnv, "db">("db", {
  create: (c) => drizzle(c.env.DATABASE_URL),
});

export const registerDatabase = accessor.register;
export const useDatabase = accessor.use;
```

```ts
// main.ts
app.use(registerDatabase);
```

```ts
// src/domains/books/routes.ts
export const booksRoutes = new Hono<AppEnv>().get("/", (c) => {
  const db = useDatabase(c);
  // ...
});
```

### Reverse-generating URLs with `NamedRoutes`

```ts
import { NamedRoutes } from "@tknf/oven/routing";

const routes = new NamedRoutes(
  {
    "books.index": "/books",
    "books.show": "/books/:id",
  },
  { baseUrl: "https://example.com" },
);

routes.pathFor("books.show", { id: "42" }); // "/books/42"
routes.urlFor("books.show", { id: "42" }); // "https://example.com/books/42"
```

`pathFor`/`urlFor` are class-field arrow functions, so they can be
destructured and passed around detached from the instance:

```ts
const { pathFor } = routes;
pathFor("books.index"); // "/books"
```

### Wiring the shared error page and health check

```ts
import { ErrorPages, healthCheck } from "@tknf/oven/routing";

const errors = new ErrorPages({ logger: (c) => useLogger(c) });
app.onError(errors.onError);
app.notFound(errors.notFound);
app.get("/up", healthCheck);
```

The 404/500 copy defaults to English (`@tknf/oven/i18n`'s bundled
default catalog) when `languageDetector` hasn't detected another
supported language. Pass `options.t` (a `Translator<C>`'s `t`, see
[i18n](./i18n.md)) to replace it with your own catalog, or apply
`languageDetector` to switch between the framework's bundled languages
(currently English and Japanese) per request.

## Gotchas / Security notes

- **Route types survive only through the chain.** A route registered as a
  separate statement still works at runtime but is missing from `hc` and
  `testClient`. The same applies to `app.route()` in `src/main.ts`.
- **Mounting at the app root (`app.route("/", subApp)`) leaks the sub-app's
  path-less middleware onto the whole parent app.** A path-less `.use(...)`
  registers under Hono's internal `"*"` path; `app.route(path, subApp)` lifts
  that registration onto the parent via `mergePath(path, "*")`. For any other
  `path` this merges to a scoped `"<path>/*"`, but for `path === "/"` it merges
  to `"/*"` — every route on the parent, not just the sub-app's own:

  ```ts
  // Leaks: every route on `app`, not just the sub-app's own, now runs
  // through AdminLayout and requireAdminAuth.
  const system = new Hono()
    .use(jsxRenderer(AdminLayout))
    .use(requireAdminAuth)
    .get("/up", (c) => c.text("ok"));
  app.route("/", system);
  ```

  ```ts
  // Scoped: mount on a dedicated base path instead of "/".
  app.route("/system", system);

  // Or, if it must stay at the root, apply the middleware per route.
  const system = new Hono().get("/up", requireAdminAuth, jsxRenderer(AdminLayout), (c) =>
    c.text("ok"),
  );
  app.route("/", system);
  ```
- `ContextAccessor#use(c)` throws (naming the missing key) rather than
  returning `undefined` when `register` was never applied to that route —
  treat that error as "you forgot `app.use(x.register)`" rather than an
  application bug to work around.
- `ErrorPages` unifies "not found" and "forbidden" into the same 404
  response, to avoid letting a third party infer whether a resource exists
  from the status code alone; a JSON API sub-app is expected to override
  `onError` itself rather than reuse `ErrorPages`.

## See also

- [Getting started](./getting-started.md) — installing oven and writing
  your first route end-to-end.
- [Concepts](./concepts.md) — the request lifecycle, and why a provider
  container was rejected in favor of `register`/`use`.
