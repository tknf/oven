# oven documentation

Guides for [`@tknf/oven`](../README.md) — a thin convention layer over Hono
for SSR full-stack apps. Every guide is example-first and maps to a public
subpath export (`@tknf/oven/<name>`).

## Start here

- [Getting started](./getting-started.md) — install oven and write your
  first `RouteHandler`, layout, and route.
- [Concepts](./concepts.md) — the design principles, the request lifecycle,
  dependency injection, and the full subpath export map.

## Core layers

- [Routing](./routing.md) — `RouteHandler`, `ContextAccessor`,
  `NamedRoutes`, `ErrorPages`, health checks (`@tknf/oven/routing`).
- [View](./view.md) — `View` multi-format responses, snippets for
  htmx/Turbo, `ViewHelpers`, fragment caching (`@tknf/oven/view`).
- [Models](./models.md) — the thin Drizzle base (`SQLiteModel`/`PgModel`/
  `MySqlModel`): CRUD, cursor pagination, optimistic locking
  (`@tknf/oven/model`).
- [Forms](./forms.md) — Standard Schema validation, `FormView`, upload
  validation (`@tknf/oven/form`).
- [Sessions](./sessions.md) — `Session` (server-side + flash) and the
  storage adapters (`@tknf/oven/session`).
- [Authentication](./auth.md) — `Guard`, `Policy`, password hashing, tokens,
  OAuth (`@tknf/oven/auth`).
- [Security](./security.md) — `Csrf`, `SecureHeaders`, `RateLimiter`,
  `TrustedHost`, `Encrypter`, `UrlSigner`, `MaintenanceMode`
  (`@tknf/oven/security`).

## Data & infrastructure

- [Storage, Key-Value, and Cache](./storage-kv.md) — `Storage`,
  `KeyValueStore`, `Cache`, `FeatureFlags`, presigning
  (`@tknf/oven/storage`, `@tknf/oven/kv`, `@tknf/oven/cache`).
- [Jobs](./jobs.md) — `Job`, `JobQueue`, `JobRegistry`, workers, `Schedule`
  (`@tknf/oven/jobs`).
- [Realtime](./realtime.md) — `Broadcaster`, SSE, WebSocket, channel
  authorization (`@tknf/oven/realtime`).
- [Mailer](./mailer.md) — `Mailer`, templates, preview, queued delivery
  (`@tknf/oven/mailer`).
- [Pagination](./pagination.md) — query parsing, opaque cursors,
  `PaginationView` (`@tknf/oven/pagination`).
- [Audit log](./audit.md) — append-only audit recording
  (`@tknf/oven/audit`).
- [Database](./database.md) — `DatabaseAccessor` for wiring a Drizzle
  connection into the context (`@tknf/oven/database`).
- [Datasource](./datasource.md) — `Datasource`/`RestDatasource`, a thin
  `fetch` base for external HTTP/REST sources with Standard Schema response
  validation (`@tknf/oven/datasource`).
- [Logging](./logging.md) — `Logger`, `ConsoleLogger`, `NullLogger`,
  redaction (`@tknf/oven/logging`).

## Features & utilities

- [Internationalization](./i18n.md) — `Translator`, catalogs,
  `languageDetector` wiring (`@tknf/oven/i18n`).
- [Admin panel](./admin.md) — `AdminPanel`, `AdminResource`, CRUD/jobs/
  settings/audit sections (`@tknf/oven/admin`).
- [Helpers](./helpers.md) — CSV, currency/date-time/duration formatting,
  DOM ids (`@tknf/oven/helpers`).
- [Support](./support.md) — id generators, signed cookies, base64url,
  env validation, constant-time compare (`@tknf/oven/support`).
- [Vite assets](./vite.md) — `ViteAssets`, manifest resolution
  (`@tknf/oven/vite`).

## Deploying & testing

- [Deployment](./deployment.md) — Node and Cloudflare Workers adapters:
  KV/R2/Queues/Scheduled, filesystem stores, asset serving
  (`@tknf/oven/node`, `@tknf/oven/cloudflare`).
- [Testing](./testing.md) — the test harness: `createTestDb`,
  `defineFactory`, `actingAs`, `TestJobQueue`/`TestMailer`, `stubBinding`
  (`@tknf/oven/test`).
