# oven

A thin convention layer over Hono that gives your SSR full-stack app a place for everything and a way to do it. npm: `@tknf/oven`.

oven delivers a convention-driven development experience on the Hono + Hono/JSX (SSR) + Turbo/Stimulus stack. It is runtime- and backend-agnostic: platform-specific implementations (such as the Node and Cloudflare Workers adapters) are isolated behind subpath exports. Only patterns that were grown and proven inside a production app are extracted here.

## 30-second example

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
export default app;
```

Routes are plain Hono apps written as method chains, so Hono's `hc` client and `testClient` stay fully typed. Each feature lives in its own domain directory (`src/domains/books/`) beside its schema, model, form, policy, and views.

## Installation

```sh
pnpm add @tknf/oven hono drizzle-orm
```

Peer dependencies: `hono@^4.12.27` and `drizzle-orm@^0.45.2` are required. Add `@libsql/client@^0.17.4` for SQLite (Turso/libSQL) and `@cloudflare/workers-types@^5.0.0` if you deploy to Cloudflare Workers. This package is ESM-only. See [`docs/getting-started.md`](docs/getting-started.md) for a full walkthrough.

## Documentation

- [Getting started](docs/getting-started.md) — installation, the domain-based project layout, and your first route.
- [Concepts](docs/concepts.md) — why routes are plain Hono chains while Model, Session, Storage, and the rest share one class-based idiom.
- [Documentation index](docs/README.md) — a guide per subpath export: routing, view, models, forms, sessions, auth, security, storage/kv/cache, jobs, realtime, mailer, i18n, admin, pagination, audit, database, datasource, logging, helpers, support, vite, deployment, and testing.

## Codex skill

oven ships a [Codex skill](skills/oven/SKILL.md) with the class idiom, the
`register`/`use` wiring convention, the subpath API map, and security defaults.
Ask Codex to install it from this repository with the built-in skill installer:

```text
$skill-installer Install the oven skill from https://github.com/tknf/oven/tree/main/skills/oven
```

To keep the skill inside a project for repository-scoped discovery, place the
`oven` skill directory at `.agents/skills/oven/`.

## Supported runtimes

oven targets Web-standard `Request`/`Response` and runs anywhere Hono does, including Node.js and Cloudflare Workers. Platform-specific glue lives behind subpath exports so the core stays backend-agnostic:

- `@tknf/oven/node` — Node.js adapter.
- `@tknf/oven/cloudflare` — Cloudflare Workers adapter (KV/R2-backed implementations of the abstract `KeyValueStore` / `Storage` interfaces).

## Design principles

1. **Stay a thin wrapper over Hono** — lean on Hono's built-ins (jsx-renderer, cookie helpers, languageDetector, etc.) as much as possible. The one intentional replacement is CSRF (Origin checking → token-based).
2. **Classes for behavior, plain Hono for routes** — Session / Storage / Mailer / Model and the wiring layer (`ContextAccessor` and friends) share the vocabulary of an abstract base class plus inheritance; routes stay plain Hono method chains so their types reach `hc` and `testClient`.
3. **Backend-agnostic** — the core depends only on abstractions such as `KeyValueStore` and `Storage`. Cloudflare KV / R2 are just one adapter.
4. **No magic** — no file-based routing, no lifecycle hooks, no auto-discovery or app registry. Explicit declaration only.

## What it provides

A domain-based project layout and generator, Model (a thin base over Drizzle), Form (Standard Schema), Session (server-side + flash), CSRF, Guard (authentication), Storage (R2/S3 adapters with presigning split out), KeyValueStore, Mailer (with a template layer), RateLimiter, DI (typed context `register`/`use`), Layout, i18n catalogs, Queue/Scheduled, assorted helpers, and a test harness (`@tknf/oven/test`).

## Development

Codex contributors should start with [`AGENTS.md`](AGENTS.md). Project agents live
under [`.codex/agents/`](.codex/agents/), and reusable development workflows live
under [`.agents/skills/`](.agents/skills/).

```sh
vp install
vp check          # lint + format
vp run typecheck
vp test           # two projects: node (L1/L2) + workerd (L3)
```

## Security notes

- The `secure` attribute on the session cookie and remember token is **not** set by default (an intentional choice that keeps local HTTP development frictionless). **In production you must set `secure: true` explicitly via the cookie options.**
- The `secrets` you pass to `CookieSessionStorage`, `UrlSigner`, `Encrypter`, etc. must be high-entropy random values of ~32 bytes (do not reuse a human-chosen passphrase).
- The two points above are not enforced at runtime (nothing is thrown); oven only emits a `console.warn` so you can catch a misconfiguration (when a `secret` is short, or when `secure` is unset in a production-like environment). The default behavior itself is unchanged.
- This package is ESM-only (`exports` declares only the `default` condition; it cannot be loaded via CJS `require`).

## Status

- Published on npm as [`@tknf/oven`](https://www.npmjs.com/package/@tknf/oven), currently on the `1.x` line. See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## License

MIT
