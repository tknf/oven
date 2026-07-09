---
name: oven
description: Build and edit SSR full-stack apps with oven (npm `@tknf/oven`), a thin convention layer over Hono. Load this whenever you write or modify code that imports from `@tknf/oven` or `@tknf/oven/*` — RouteHandler, Model, Form, Session, Guard, Csrf, Storage, KeyValueStore, Mailer, JobQueue, Broadcaster, AdminPanel, i18n, and the Cloudflare/Node adapters. Covers the class-based idiom (abstract base + inheritance), the `register`/`use` DI convention, backend-agnostic wiring, and the security defaults. Biases toward verifying real signatures in the installed types over guessing.
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

## Where things live (subpath cheat-sheet)

Import from the specific subpath. The root `@tknf/oven` re-exports everything
except `cloudflare`, `node`, and `test`.

| Subpath                 | Key exports                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tknf/oven/routing`    | `RouteHandler`, `ContextAccessor`, `ValueAccessor`, `ScopedValueAccessor`, `NamedRoutes`, `ErrorPages`, `healthCheck`                                                |
| `@tknf/oven/view`       | `View` (Accept-negotiated multi-format), `renderSnippet`/`renderSnippetStream` (htmx/Turbo), `ViewHelpers`, `cacheFragment`, `LayoutComponent`/`LayoutProps`         |
| `@tknf/oven/model`      | `SQLiteModel`/`PgModel`/`MySqlModel` (thin Drizzle base), `StaleRecordError`                                                                                         |
| `@tknf/oven/form`       | `Form` (Standard Schema), `FormView`, `validateUploadedFile`, `localizeUploadedFileError`                                                                            |
| `@tknf/oven/session`    | `Session` (server-side + flash), `SessionAccessor`, `SessionStorage` + Cookie/InMemory/KeyValue/DB adapters                                                          |
| `@tknf/oven/auth`       | `Guard`, `Policy`, `hashPassword`/`verifyPassword`, `ApiToken`, `RememberToken`, `EmailVerification`, `PasswordReset`, `OAuthClient`                                 |
| `@tknf/oven/security`   | `Csrf`, `SecureHeaders`, `RateLimiter`, `TrustedHost`, `Encrypter`, `UrlSigner`, `MaintenanceMode`                                                                   |
| `@tknf/oven/storage`    | `Storage` + `S3Storage`/`GoogleCloudStorage`/`InMemoryStorage`, `S3UrlSigner`                                                                                        |
| `@tknf/oven/kv`         | `KeyValueStore` + InMemory/DB/`UpstashRedisStore`, `FeatureFlags`                                                                                                    |
| `@tknf/oven/cache`      | `Cache` (JSON + `remember`), `CacheControl`                                                                                                                          |
| `@tknf/oven/jobs`       | `Job`, `JobQueue`, `JobRegistry`, `InlineJobQueue`, DB queue/worker, `Schedule`                                                                                      |
| `@tknf/oven/realtime`   | `Broadcaster`, `broadcastSse`, `BroadcastWebSocket`, `ChannelAuthorizer`                                                                                             |
| `@tknf/oven/mailer`     | `Mailer`, `ConsoleMailer`, `FetchMailer`, `MailTemplate`, `DeliverMailJob`, `MailPreviewHandler`                                                                     |
| `@tknf/oven/i18n`       | `Translator` (wraps Hono `languageDetector`)                                                                                                                         |
| `@tknf/oven/admin`      | `AdminPanel` (extends RouteHandler), `AdminResource`, `fieldsFromTable`                                                                                              |
| `@tknf/oven/pagination` | `parsePaginationQuery`, `encodeCursor`/`decodeCursor`, `PaginationView`                                                                                              |
| `@tknf/oven/audit`      | `SQLiteAuditLog`/`PgAuditLog`/`MySqlAuditLog`                                                                                                                        |
| `@tknf/oven/database`   | `DatabaseAccessor`                                                                                                                                                   |
| `@tknf/oven/datasource` | `Datasource` (low-level `fetch` base), `RestDatasource` (retrieve/list/create/update/delete), `DatasourceError`, `DatasourceParseError`, `DatasourceValidationError` |
| `@tknf/oven/logging`    | `Logger`, `ConsoleLogger`, `NullLogger`                                                                                                                              |
| `@tknf/oven/helpers`    | CSV, `formatCurrency`/`formatDateTime`, `domId`                                                                                                                      |
| `@tknf/oven/support`    | `IdGenerator` variants, `CookieAccessor`/`SignedCookieAccessor`, base64url, `validateEnv`, `constantTimeEqual`                                                       |
| `@tknf/oven/vite`       | `ViteAssets`, `parseViteManifest`                                                                                                                                    |
| `@tknf/oven/cloudflare` | `CloudflareKVStore`, `R2Storage`, `CloudflareCacheStore`, `CloudflareJobQueue`, `QueueConsumer`, `ScheduledDispatcher`                                               |
| `@tknf/oven/node`       | `FileKeyValueStore`, `FileStorage`                                                                                                                                   |
| `@tknf/oven/test`       | `createTestDb`, `defineFactory`, `actingAs`, `TestJobQueue`, `TestMailer`, `stubBinding`                                                                             |

The full narrative guides live in the package repo under `docs/` (one guide per
area, example-first). Consult them for depth.

## Gotchas and security defaults (do not get these wrong)

- **Hooks are methods, not class fields.** `layout = MyLayout` is `undefined` at
  construction time — write `protected layout() { return MyLayout; }`.
- **Reserved names.** A `RouteHandler` subclass must not reuse names Hono holds
  (`get`, `post`, `use`, `route`, `routes`, `fetch`, `onError`, ...). Shadowing
  `routes` breaks the instance.
- **`secure` cookie attribute is OFF by default** (session cookie, remember
  token). Set `secure: true` explicitly in production via the cookie options.
- **`secrets` must be high-entropy random ~32 bytes** (`Encrypter`, `UrlSigner`,
  `CookieSessionStorage`, ...). Weak/short secrets only emit a `console.warn`,
  never throw — do not rely on the runtime to catch it.
- **`Model#paginate` is keyset (cursor) pagination**, not offset — options are
  `{ limit, cursor?, direction? }`; there is no `page` number. For an
  arbitrary-column-order, numbered-page listing (e.g. admin), use
  `Model#listPage({ where?, orderBy?, limit, offset? })` instead — offset-based,
  so prefer `paginate` for large-scale public listings.
- **`Model` soft delete has no implicit global scope** — add
  `isNull(table.deletedAt)` to your own `where` when you want to exclude deleted
  rows. Concurrency uses `updateLocked` + a `lockVersion` column (`StaleRecordError`).
- **CSRF is not automatic on `AdminPanel`** — inject a `Csrf` instance so write
  routes are verified.
- **`AdminPanel`'s header user-tools block is opt-in** — inject
  `userTools: (c) => ({ greeting?, links? })` to render a greeting plus links
  (e.g. "View site" / "Log out") in the header; omit it and nothing renders
  (authentication is outside admin's scope). A link with `method: "post"`
  renders as a `<form>` + submit button (needed for logout) and picks up the
  CSRF hidden input automatically when `csrf` is also injected; other links
  render as plain `<a>`.
- **`AdminResource#filters()` is a closed allowlist** — declare each filter's
  `options` explicitly; a query value outside that list is silently ignored
  rather than applied. The sidebar (`#changelist-filter`) only renders once
  `filters()` returns at least one entry.
- **`AdminPanel`'s dashboard (`GET /admin`) is resource-driven** — once you
  inject `resources`, the dashboard shows a module list of every resource
  (with `Add`/`Change` links) instead of the plain welcome message. Every
  screen but the dashboard also renders a breadcrumb trail below the header.
- **Navigation is a left sidebar (`#nav-sidebar`), not a header nav bar** —
  every screen renders a vertical, JS-free link list (dashboard/jobs/
  settings/audit, then a resources heading and one link per `AdminResource`)
  so it stays a single scrollable column no matter how many resources you
  register.
- **`AdminPanel`'s create/edit forms have three submit buttons** —
  `_save`/`_addanother`/`_continue` (list / new-form / just-saved row's edit
  URL, respectively; a missing or unrecognized button name falls back to
  `_save`'s list redirect). Inject `session` (e.g. `SessionAccessor#use`) to
  flash a one-time "added/changed/deleted successfully" `<ul class="messagelist">`
  banner on the next screen; without it, no banner is shown.
- **`AdminPanel` deletes are two-step** — every `Delete` link navigates to a
  `GET /resources/:key/:id/delete` confirmation screen; the row is removed
  only when that screen's form (hidden `post=yes` field) is submitted. A
  `POST` without `post=yes` redirects back to the list without deleting.
- **`AdminPanel`'s list screen supports bulk delete** — a writable resource
  with at least one row shows a row-checkbox column and an actions bar
  (`<select name="action">` + `Run`). Choosing "Delete selected {label}" and
  running it is also two-step: it posts `action`/`_selected_action` (no
  `post=yes` yet) to render a confirmation screen, which then posts
  `post=yes`/`action=delete`/`_selected_action` back to actually delete. Both
  the actions-bar form and the create-form POST target the same
  `/resources/:key` URL; `AdminPanel` dispatches on whether `action` is
  present in the body. `AdminModel` requires a `count(where?)` method (all of
  `SQLiteModel`/`PgModel`/`MySqlModel` already have it); the list screen shows
  the total row count near pagination for every resource, writable or not.
- **`AdminPanel`'s list screen is numbered pagination + single-column sort**,
  built on `AdminModel#listPage` (not `Model#paginate`) — `?o=<i>`/`?o=-<i>`
  sorts the `i`-th display column (`AdminResource#columns()`'s order)
  ascending/descending, falling back to primary key descending when absent or
  out of range; `?p=<n>` selects the 0-based page. Clicking a column header or
  a filter link resets to page 0; only the paginator's own page links keep the
  current sort/search/filters.
- **`AdminResource#inlines()` renders and persists child rows, but not
  atomically.** Each `AdminInline` (child `model`/`table`/`primaryKey`/
  `foreignKey`/`form()`, plus `extra` blank rows, default 3) renders a
  fixed-row `.inline-group` table inside the parent's create/edit form —
  no "add another row" JS. Row `i`'s fields use the name prefix
  `${key}-${i}`; an existing row additionally carries hidden
  `${key}-${i}-__pk` and a `${key}-${i}-__delete` checkbox, and the group
  carries a hidden `${key}-__total`. Submitting the parent form validates
  the parent and every row first (re-rendering `422` with nothing written
  if any of them fails), then creates/updates/deletes each row via
  `inline.model` — a checked `__delete` on a row with `__pk` deletes it, a
  row with `__pk` and filled-in fields updates it, a row with no `__pk`
  but at least one non-empty field creates it (with `foreignKey` set to
  the parent's id), and an untouched blank row is skipped. The parent
  write and the child writes are separate sequential calls, not one
  transaction. The child `Form#fields()` must omit the foreign key column
  (`AdminPanel` sets it itself on create).
- **`BroadcastWebSocket` needs an Origin check + connection authorization** in
  the `authorize` hook / `channels` callback (prevents Cross-Site WebSocket
  Hijacking).
- **Sanitize user-derived `Storage`/`KeyValueStore` keys** (no `..` or path
  separators) at the application boundary.
- **Job delivery is at-least-once** — make `Job#perform` idempotent.
  `InlineJobQueue` is for dev/tests only.
- **`Datasource`/`RestDatasource` treat every response body as untrusted** —
  always pass a `schema`; a failed validation throws
  `DatasourceValidationError` (distinct from `DatasourceError`, which covers
  non-2xx transport failures, and `DatasourceParseError`, for a 2xx response
  whose body isn't valid JSON). `RestDatasource#retrieve` returns `undefined`
  only on `404`; other non-2xx statuses still throw. `DatasourceError#body`/
  `DatasourceParseError#body` are truncated to 8192 characters — may still
  contain sensitive upstream data, so avoid forwarding them verbatim to logs.
- **`Datasource` is the constraint layer, not just an escape hatch.** Beyond
  `RestDatasource`'s retrieve/list/create/update/delete, any subclass can call
  the protected `request(path, { method?, query?, body?, headers?, schema? })`
  to define its own fully typed method for any endpoint — passing `schema`
  makes the return type infer from the schema, no cast needed. Use this for
  enveloped/metadata-carrying list responses (`{ items, totalCount, ... }`):
  declare a schema for the envelope and return `this.request(path, { schema:
envelopeSchema })` directly; `toArray` only fits a list that's a bare array
  or a thin `{ data: [...] }` wrapper, since it discards everything else.
- **ESM-only.** The package cannot be `require()`d.

## Testing

`@tknf/oven/test` provides `createTestDb({ schema, migrationsFolder })` (throwaway
libSQL DB), `defineFactory(persist, defaults)`, `actingAs(storage, { identityKey,
identity })` (auth cookie), and `TestJobQueue`/`TestMailer` (record instead of
performing) — the fakes still run real validation. Drive the app via
`app.request(...)`.
