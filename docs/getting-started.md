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

## Your first route

oven's routing convention is a single idiom: subclass `RouteHandler`
(which itself extends `Hono`) and register your routes inside the
`register()` method. Here's the smallest possible handler:

```ts
// src/handlers/books_handler.ts
import { RouteHandler } from "@tknf/oven/routing";

export class BooksHandler extends RouteHandler {
  protected register() {
    this.get("/", (c) => c.text("books-index"));
  }
}
```

Mount it onto your app with the plain Hono `route()` method — `RouteHandler`
instances are ordinary Hono apps, so there's no special mounting API to learn:

```ts
// src/main.ts
import { Hono } from "hono";
import { BooksHandler } from "./handlers/books_handler.js";

const app = new Hono();
app.route("/books", new BooksHandler());

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

`RouteHandler` has two more hooks besides `register()`: `layout()` and
`middleware()`. Both must be written as methods, not class fields — see
[Concepts § Class-based idiom](./concepts.md#class-based-idiom) for why.

`layout()` returns a component compatible with `hono/jsx-renderer`. When
you return one, oven applies `jsxRenderer` for you, so `c.render(...)`
becomes available inside `register()`:

```tsx
// src/handlers/pages_handler.ts
import { RouteHandler } from "@tknf/oven/routing";
import type { LayoutComponent } from "@tknf/oven/view";

const PageLayout: LayoutComponent = ({ title, children }) => (
  <html>
    <head>
      <title>{title}</title>
    </head>
    <body>{children}</body>
  </html>
);

export class PagesHandler extends RouteHandler {
  protected layout() {
    return PageLayout;
  }

  protected register() {
    this.get("/", (c) => c.render(<p>hello</p>, { title: "Test Page" }));
  }
}
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
page-specific `<meta>`/`<link>` elements. Because oven doesn't hide layout
inheritance behind a hook, deeper layouts (e.g. an `AdminLayout` wrapping a
`BaseLayout`) are just function composition — see
[Concepts](./concepts.md) for the reasoning.

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
