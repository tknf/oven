---
name: oven
description: Build or modify SSR full-stack applications that import `@tknf/oven` or its subpaths. Use for oven APIs, class-based extension points, `register`/`use` wiring, runtime adapters, testing, and security defaults.
---

# Building with oven (`@tknf/oven`)

oven is a thin convention layer over [Hono](https://hono.dev) for server-rendered
full-stack apps (Hono + Hono/JSX SSR + Turbo/Stimulus). It is runtime- and
backend-agnostic; platform code (Cloudflare Workers, Node) lives behind subpath
exports. When writing oven code, follow the four design principles and verify
API shapes against the installed package rather than guessing.

## Design principles (internalize these)

1. **Thin wrapper over Hono.** Lean on Hono's built-ins (jsx-renderer, cookie
   helpers, `languageDetector`). The one deliberate replacement is CSRF
   (token-based instead of Origin-only). Hono's own docs apply directly.
2. **One idiom: the class.** Everything — RouteHandler, Model, Session, Storage,
   Mailer, ContextAccessor — is an abstract base class plus a concrete subclass
   that implements a few methods. No second vocabulary to learn.
3. **Backend-agnostic.** The core depends on abstractions (`KeyValueStore`,
   `Storage`, `JobQueue`, `Broadcaster`). Cloudflare KV/R2/Queues and Node
   filesystem stores are just adapters — swap them at the composition root.
4. **No magic.** No file-based routing, no auto-discovery, no lifecycle hooks.
   Every route, middleware, and wired service is an explicit line of code.

## Rule: verify signatures, don't guess

API names, constructor arguments, defaults, and return types must match the
installed package. Before writing a non-trivial example, check the real types in
`node_modules/@tknf/oven/dist/**/*.d.ts` (or the source), and prefer patterns
that appear in the project's own tests. Hono / Drizzle / Standard Schema APIs:
confirm against their installed types too.

## Your first route

`RouteHandler` extends `Hono`. Subclass it, implement `register()`, and mount an
instance with plain `app.route()`:

```ts
// src/handlers/books_handler.ts
import { RouteHandler } from "@tknf/oven/routing";

export class BooksHandler extends RouteHandler {
	protected register() {
		this.get("/", (c) => c.text("books-index"));
	}
}
```

```ts
// src/main.ts
import { Hono } from "hono";
import { BooksHandler } from "./handlers/books_handler.js";

const app = new Hono();
app.route("/books", new BooksHandler());
export default app; // Cloudflare Workers; on Node pass app.fetch to your server
```

Three hooks, **all written as methods (never class fields)** because they run
inside the base constructor in a fixed order — `layout()` → `middleware()` →
`register()`:

- `protected layout(): LayoutComponent | null` — return a `hono/jsx-renderer`
  component to enable `c.render(...)`.
- `protected middleware(): MiddlewareHandler[]` — middleware applied after the
  renderer.
- `protected register(): void` — declare routes with `this.get/post/...`.
- `protected resources(actions)` — register RESTful routes (index/new/create/
  show/edit/update/destroy); only the actions you pass are created.

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
// src/lib/db.ts
import { ScopedValueAccessor } from "@tknf/oven/routing";
import { drizzle } from "drizzle-orm/libsql";

const accessor = new ScopedValueAccessor("db", { create: (c) => drizzle(c.env.DATABASE_URL) });
export const registerDatabase = accessor.register; // app.use(registerDatabase)
export const useDatabase = accessor.use; // const db = useDatabase(c)
```

`use(c)` throws (naming the key) if `register` was never applied — a missing
`app.use(...)` fails loudly, not silently. `scope: "request"` (default) rebuilds
per request (per-request state, e.g. bindings); `scope: "app"` memoizes once
(expensive shared state, e.g. connection pools).
`SessionAccessor`, `Guard`, and `DatabaseAccessor` are all `ContextAccessor`s.

## Read detailed references as needed

Load only the reference relevant to the work:

- Before choosing imports, checking an export, or using the `oven` generator, read
  [`references/subpaths.md`](references/subpaths.md).
- Before implementing behavior with security, persistence, concurrency, upload,
  session, admin, datasource, or runtime implications, read
  [`references/gotchas.md`](references/gotchas.md). Search it for the public symbol
  or subpath involved.
- When writing or reviewing tests, read
  [`references/testing.md`](references/testing.md).

For deeper task-specific examples, consult the corresponding guide under `docs/`
in the oven repository. Keep the installed declarations and implementation
authoritative if a guide or this skill has drifted.
