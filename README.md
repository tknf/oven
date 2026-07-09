# oven

A thin convention layer over Hono that gives your SSR full-stack app a place for everything and a way to do it. npm: `@tknf/oven`.

oven delivers a convention-driven development experience on the Hono + Hono/JSX (SSR) + Turbo/Stimulus stack. It is runtime- and backend-agnostic: platform-specific implementations (such as the Node and Cloudflare Workers adapters) are isolated behind subpath exports. Only patterns that were grown and proven inside a production app are extracted here.

## 30-second example

```ts
import { Hono } from "hono";
import { RouteHandler } from "@tknf/oven/routing";

class BooksHandler extends RouteHandler {
	protected register() {
		this.get("/", (c) => c.text("books-index"));
	}
}

const app = new Hono();
app.route("/books", new BooksHandler());
export default app;
```

`RouteHandler` is an abstract base class that extends Hono. Override the `register()` (and optionally `layout()` / `middleware()`) methods, then mount an instance with the same `app.route()` you already use.

## Installation

```sh
pnpm add @tknf/oven hono drizzle-orm
```

Peer dependencies: `hono@^4.12.27` and `drizzle-orm@^0.45.2` are required. Add `@libsql/client@^0.17.4` for SQLite (Turso/libSQL) and `@cloudflare/workers-types@^5.0.0` if you deploy to Cloudflare Workers. This package is ESM-only. See [`docs/getting-started.md`](docs/getting-started.md) for a full walkthrough.

## Documentation

- [Getting started](docs/getting-started.md) — installation, project layout, and your first `RouteHandler`.
- [Concepts](docs/concepts.md) — the class-based idiom shared across RouteHandler, Model, Session, Storage, and the rest.
- [Documentation index](docs/README.md) — a guide per subpath export: routing, view, models, forms, sessions, auth, security, storage/kv/cache, jobs, realtime, mailer, i18n, admin, pagination, audit, database, logging, helpers, support, vite, deployment, and testing.

## AI agent skill

oven ships a [`SKILL.md`](skills/oven/SKILL.md) that teaches AI coding agents (Claude Code, Codex, and others) how to build with oven — the class-based idiom, the `register`/`use` DI convention, the subpath API map, and the security defaults. Install it into your project with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add tknf/oven
```

This drops the skill into your agent's config (e.g. `.claude/skills/`). To preview before installing, run `npx skills add tknf/oven --list`.

## Supported runtimes

oven targets Web-standard `Request`/`Response` and runs anywhere Hono does, including Node.js and Cloudflare Workers. Platform-specific glue lives behind subpath exports so the core stays backend-agnostic:

- `@tknf/oven/node` — Node.js adapter.
- `@tknf/oven/cloudflare` — Cloudflare Workers adapter (KV/R2-backed implementations of the abstract `KeyValueStore` / `Storage` interfaces).

## Design principles

1. **Stay a thin wrapper over Hono** — lean on Hono's built-ins (jsx-renderer, cookie helpers, languageDetector, etc.) as much as possible. The one intentional replacement is CSRF (Origin checking → token-based).
2. **One idiom: the class** — from Session / Storage / Mailer / Model / RouteHandler down to the wiring layer (`ContextAccessor` and friends), everything uses the same vocabulary of an abstract base class plus inheritance.
3. **Backend-agnostic** — the core depends only on abstractions such as `KeyValueStore` and `Storage`. Cloudflare KV / R2 are just one adapter.
4. **No magic** — no file-based routing, no lifecycle hooks, no auto-discovery. Explicit declaration and inheritance only.

## What it provides

RouteHandler (extends Hono), Model (a thin base over Drizzle), Form (Standard Schema), Session (server-side + flash), CSRF, Guard (authentication), Storage (R2/S3 adapters with presigning split out), KeyValueStore, Mailer (with a template layer), RateLimiter, DI (typed context `register`/`use`), Layout, i18n catalogs, Queue/Scheduled, assorted helpers, and a test harness (`@tknf/oven/test`).

## Development

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

- Not yet published to npm (planned release as `@tknf/oven` once setup is complete).

## License

MIT
