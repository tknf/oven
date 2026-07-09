# Routing

## What / Why

oven's routing layer solves one problem: giving every handler in an app a
single, predictable place to declare its routes, layout, and middleware —
without inventing a second vocabulary (file conventions, decorators, a DI
container) on top of what Hono and JavaScript classes already provide. The
whole layer is four small, independent pieces:

- **`RouteHandler`** — a `Hono` subclass. You extend it, write `register()`
  (and optionally `layout()`/`middleware()`), and mount the instance with
  plain `app.route(prefix, handler)`.
- **`ContextAccessor`** (and its concrete `ValueAccessor`/
  `ScopedValueAccessor`) — the `register`/`use` pair that stands in for a
  dependency-injection container: middleware computes a value once per
  request, and any downstream handler reads it back with a function call
  that throws loudly if the wiring was forgotten.
- **`NamedRoutes`** — type-safe reverse URL generation from an explicit
  "name → path template" table, for building links without hardcoding paths.
- **`ErrorPages`** / **`healthCheck`** — the shared 404/500 page and a
  liveness endpoint, wired the same `register`/`onError`/`notFound` way Hono
  itself expects.

For the design rationale (why classes, why no file-based routing, the full
request lifecycle) see [Concepts](./concepts.md).

## Minimal example

```ts
// src/handlers/books_handler.ts
import { RouteHandler } from "@tknf/oven/routing";

export class BooksHandler extends RouteHandler {
  protected register() {
    this.get("/", (c) => c.text("books-index"));
    this.get("/:id", (c) => c.text(`book-${c.req.param("id")}`));
  }
}
```

```ts
// src/main.ts
import { Hono } from "hono";
import { BooksHandler } from "./handlers/books_handler.js";

const app = new Hono();
app.route("/books", new BooksHandler());

export default app;
```

`RouteHandler` instances are ordinary Hono apps — there is no special
mounting API, so `app.route()` is all you ever write in `main.ts`.

## Common tasks

### Registering a RESTful resource in one call

`resources()` registers only the actions you supply, in a fixed order
(`index` → `new` → `create` → `show` → `edit` → `update` → `destroy`), with
`/new` always registered before `/:id` so it isn't swallowed by `show`:

```ts
export class BooksHandler extends RouteHandler {
  protected register() {
    this.resources({
      index: (c) => c.text("index"),
      new: (c) => c.text("new"),
      create: (c) => c.text("create"),
      show: (c) => c.text(`show:${c.req.param("id")}`),
      edit: (c) => c.text(`edit:${c.req.param("id")}`),
      update: (c) => c.text(`update:${c.req.param("id")}`),
      destroy: (c) => c.text(`destroy:${c.req.param("id")}`),
    });
  }
}
```

### Sharing a layout and middleware across a namespace

Because `layout()`/`middleware()` are plain (overridable) methods, an
intermediate base class can declare them once, and a leaf handler composes
with `super.middleware()`:

```ts
abstract class AdminHandler extends RouteHandler {
  protected layout() {
    return AdminLayout;
  }
  protected middleware() {
    return [requireAdminAuth];
  }
}

export class AdminBooksHandler extends AdminHandler {
  protected middleware() {
    return [...super.middleware(), auditLog];
  }
  protected register() {
    this.get("/", (c) => c.render(<p>admin books</p>, { title: "Books" }));
  }
}
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
// src/lib/db.ts
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
// inside a handler's register()
this.get("/", (c) => {
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

- **Reserved names.** `RouteHandler` extends `Hono` directly, so any name
  Hono itself uses (`get`, `post`, `use`, `route`, `router`, `fetch`,
  `notFound`, `onError`, and — most commonly hit — `routes`, Hono's own
  route registry field) cannot be reused as a subclass hook or field name.
  Shadowing `routes` produces `this.routes is not a function` once
  `super()` runs.
- **Hooks must be methods, not class fields.** `layout()`, `middleware()`,
  and `ContextAccessor#handle()` all run from code inside the *base*
  class's constructor, before a subclass's own class-field initializers
  have run. Writing `layout = MyLayout` as a class field is `undefined` at
  the point the base constructor reads it — write `protected layout() { return MyLayout; }` instead.
- **`register`/`use` are the deliberate exception** — they *are* class-field
  arrow functions, precisely so `app.use(accessor.register)` and
  `const { pathFor } = routes` work without losing `this`.
- **The Hono RPC client (`hc`) type chain is not preserved** across
  `RouteHandler` subclassing. This is an accepted tradeoff for oven's
  server-rendered target (Hono/JSX SSR, not an RPC client workflow).
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
- [Concepts](./concepts.md) — the class-based idiom, the fixed
  `layout()` → `middleware()` → `register()` wiring order, and why a
  provider container was rejected in favor of `register`/`use`.
