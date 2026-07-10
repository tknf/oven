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
except `cloudflare`, `node`, `test`, and `vite` (the last is opt-in because
it's specific to apps that bundle client-side assets with Vite, not because
it depends on the `vite` package itself — it has no hard dependency on it).

| Subpath                 | Key exports                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tknf/oven/routing`    | `RouteHandler`, `ContextAccessor`, `ValueAccessor`, `ScopedValueAccessor`, `NamedRoutes`, `ErrorPages`, `healthCheck`                                                                                                                                                                                                                     |
| `@tknf/oven/view`       | `View` (Accept-negotiated multi-format), `renderSnippet`/`renderSnippetStream` (htmx/Turbo), `ViewHelpers`, `cacheFragment`, `LayoutComponent`/`LayoutProps`                                                                                                                                                                              |
| `@tknf/oven/model`      | `SQLiteModel`/`PgModel`/`MySqlModel` (thin Drizzle base), `StaleRecordError`                                                                                                                                                                                                                                                              |
| `@tknf/oven/form`       | `Form` (Standard Schema), `FormView`, `validateUploadedFile`/`validateUploadedFiles`, `localizeUploadedFileError`                                                                                                                                                                                                                         |
| `@tknf/oven/session`    | `Session` (server-side + flash), `SessionAccessor`, `SessionStorage` + Cookie/InMemory/KeyValue/DB adapters (`KeyValueSessionStorage` + a DB-backed `KeyValueStore` is the default for DB-backed sessions; `*DatabaseSessionStorage` is for a dedicated `sessions` table)                                                                 |
| `@tknf/oven/auth`       | `Guard`, `Policy`, `hashPassword`/`verifyPassword`, `ApiToken`, `RememberToken`, `EmailVerification`, `PasswordReset`, `OAuthClient`                                                                                                                                                                                                      |
| `@tknf/oven/security`   | `Csrf`, `SecureHeaders`, `RateLimiter`, `TrustedHost`, `Encrypter`, `UrlSigner`, `MaintenanceMode`                                                                                                                                                                                                                                        |
| `@tknf/oven/storage`    | `Storage` + `S3Storage`/`GoogleCloudStorage`/`InMemoryStorage`, `S3UrlSigner`                                                                                                                                                                                                                                                             |
| `@tknf/oven/kv`         | `KeyValueStore` + InMemory/DB/`UpstashRedisStore`, `FeatureFlags`                                                                                                                                                                                                                                                                         |
| `@tknf/oven/cache`      | `Cache` (JSON + `remember`), `CacheControl`                                                                                                                                                                                                                                                                                               |
| `@tknf/oven/jobs`       | `Job`, `JobQueue`, `JobRegistry`, `InlineJobQueue`, DB queue/worker, `{SQLite,Pg,MySql}PruneExpiredRecordsJob`, `Schedule`                                                                                                                                                                                                                |
| `@tknf/oven/realtime`   | `Broadcaster`, `broadcastSse`, `BroadcastWebSocket`, `ChannelAuthorizer`                                                                                                                                                                                                                                                                  |
| `@tknf/oven/mailer`     | `Mailer`, `ConsoleMailer`, `FetchMailer`, `MailTemplate`, `DeliverMailJob`, `MailPreviewHandler`                                                                                                                                                                                                                                          |
| `@tknf/oven/i18n`       | `Translator` (wraps Hono `languageDetector`)                                                                                                                                                                                                                                                                                              |
| `@tknf/oven/admin`      | `AdminPanel` (extends RouteHandler), `AdminResource`, `fieldsFromTable`, `SQLiteAdminAccounts`/`PgAdminAccounts`/`MySqlAdminAccounts` (+ `sqliteAdminUsersTable` etc.), `SQLiteAdminGroups`/`PgAdminGroups`/`MySqlAdminGroups` (+ `sqliteAdminGroupsTable`/`sqliteAdminUserGroupsTable` etc.), `resourcePermission`/`resourcePermissions` |
| `@tknf/oven/pagination` | `parsePaginationQuery`, `encodeCursor`/`decodeCursor`, `PaginationView`, `OffsetPaginationView`                                                                                                                                                                                                                                           |
| `@tknf/oven/audit`      | `SQLiteAuditLog`/`PgAuditLog`/`MySqlAuditLog`                                                                                                                                                                                                                                                                                             |
| `@tknf/oven/database`   | `DatabaseAccessor`                                                                                                                                                                                                                                                                                                                        |
| `@tknf/oven/datasource` | `Datasource` (low-level `fetch` base), `RestDatasource` (retrieve/list/create/update/delete), `DatasourceError`, `DatasourceParseError`, `DatasourceValidationError`                                                                                                                                                                      |
| `@tknf/oven/logging`    | `Logger`, `ConsoleLogger`, `NullLogger`                                                                                                                                                                                                                                                                                                   |
| `@tknf/oven/helpers`    | CSV, `formatCurrency`/`formatDateTime`, `domId`                                                                                                                                                                                                                                                                                           |
| `@tknf/oven/support`    | `IdGenerator` variants, `CookieAccessor` (`SignedCookieAccessor` is deprecated), base64url, `validateEnv`, `constantTimeEqual`                                                                                                                                                                                                            |
| `@tknf/oven/vite`       | `ViteAssets`, `parseViteManifest`                                                                                                                                                                                                                                                                                                         |
| `@tknf/oven/cloudflare` | `CloudflareKVStore`, `R2Storage`, `CloudflareCacheStore`, `CloudflareJobQueue`, `QueueConsumer`, `ScheduledDispatcher`, `CloudflareEmailMailer`, `DurableObjectBroadcaster`, `BroadcasterDurableObject`                                                                                                                                   |
| `@tknf/oven/node`       | `FileKeyValueStore`, `FileStorage`                                                                                                                                                                                                                                                                                                        |
| `@tknf/oven/test`       | `createTestDb`, `defineFactory`, `actingAs`, `TestJobQueue`, `TestMailer`, `TestBroadcaster`, `stubBinding`                                                                                                                                                                                                                               |

The full narrative guides live in the package repo under `docs/` (one guide per
area, example-first). Consult them for depth.

## Gotchas and security defaults (do not get these wrong)

- **Hooks are methods, not class fields.** `layout = MyLayout` is `undefined` at
  construction time — write `protected layout() { return MyLayout; }`.
- **Reserved names.** A `RouteHandler` subclass must not reuse names Hono holds
  (`get`, `post`, `use`, `route`, `routes`, `fetch`, `onError`, ...). Shadowing
  `routes` breaks the instance.
- **`app.route("/", handler)` leaks `layout()`/`middleware()` to the whole
  app.** Both compile to a path-less `this.use(...)`, registered under Hono's
  internal `"*"`; mounting merges that to `"<path>/*"` via `mergePath`, which
  for `path === "/"` is `"/*"` — every route on the parent app. Mount on a
  dedicated base path instead, or, if the handler must sit at the root, leave
  `layout()`/`middleware()` unset and apply them per route inside `register()`.
- **`secure` cookie attribute is OFF by default** (session cookie, remember
  token). Set `secure: true` explicitly in production via the cookie options.
- **`storage.destroy(session)` always wins over `SessionAccessor`'s auto-commit.**
  `destroy` marks the `Session` instance destroyed (`session.isDestroyed`), so a
  `set`/`flash` made on that same instance earlier or later in the request (e.g.
  a "logged out" flash before destroying) does not get auto-committed and
  re-append a reviving `Set-Cookie` after the `Max-Age=0` destroy cookie.
- **`Guard`'s `except` is an exact-match public-path allowlist**, kept as a
  fallback to routing-order exclusion (mounting a public handler before
  `require`) — `except: ["/admin/login"]` skips session/provider resolution
  entirely for that path (no glob/prefix matching, so keep the list minimal).
- **`secrets` must be high-entropy random ~32 bytes** (`Encrypter`, `UrlSigner`,
  `CookieSessionStorage`, ...). Weak/short secrets only emit a `console.warn`,
  never throw — do not rely on the runtime to catch it.
- **`Model#paginate` is keyset (cursor) pagination**, not offset — options are
  `{ limit, cursor?, direction? }`; there is no `page` number. For an
  arbitrary-column-order, numbered-page listing (e.g. admin), use
  `Model#listPage({ where?, orderBy?, limit, offset? })` instead — offset-based,
  so prefer `paginate` for large-scale public listings. `PaginationView`
  (cursor, "next" link only) and `OffsetPaginationView` (offset, numbered page
  links + optional summary) are the matching `@tknf/oven/pagination` view
  components for each.
- **`Model` soft delete has no implicit global scope** — add
  `isNull(table.deletedAt)` to your own `where` when you want to exclude deleted
  rows. Concurrency uses `updateLocked` + a `lockVersion` column (`StaleRecordError`).
- **`Model` has no built-in tenant/row-level scope either.** `where` is always
  composed by the caller, and PK-only methods (`retrieve`/`update`/`delete`/
  `touch`/`increment`/`decrement`/`updateLocked`) bypass `where` entirely — a
  forgotten tenant condition silently reads/writes across every tenant. Write
  the scope as an explicit subclass (bind the tenant id, override every
  method that can leak); see the "Tenant-scoped models" recipe in
  `docs/models.md` for the full pattern, including `with(tx)` and the
  INSERT-side pitfall.
- **`Csrf#verify` and `validateUploadedFile` both act only after the body is
  already fully buffered** — `Csrf#verify` calls `c.req.parseBody()` to read
  the submitted token (including on a multipart request), and
  `validateUploadedFile`'s `maxSizeBytes` (`@tknf/oven/form`) only rejects an
  already-buffered `File`. Neither one bounds how large a request the server
  will actually receive into memory; apply Hono's own `bodyLimit`
  (`hono/body-limit`) upstream of both if that matters.
- **`widget: "file"` has no `value`** — browsers refuse to pre-populate
  `input[type=file]`'s selection, so `Form#toInput` never sets a key for it
  either; render a previously uploaded file separately if you need to show it.
  The older `widget: "input"` + `type: "file"` spelling still works.
- **`validateUploadedFiles` (`@tknf/oven/form`) shares one
  `UploadedFileConstraints` across every file in a `multiple: true` field** —
  there's no per-file override. Convert a failure with
  `toUploadedFileFormErrors(result, field)` into `FormError[]`;
  `localizeUploadedFileError` accepts each batch entry directly.
- **CSRF is not automatic on `AdminPanel`** — inject a `Csrf` instance so write
  routes are verified.
- **`AdminPanel`'s header user-tools block is opt-in** — inject
  `userTools: (c) => ({ greeting?, links? })` to render a greeting plus links
  (e.g. "View site" / "Log out") in the header; omit it and nothing renders
  (authentication is outside admin's scope). A link with `method: "post"`
  renders as a `<form>` + submit button (needed for logout) and picks up the
  CSRF hidden input automatically when `csrf` is also injected; other links
  render as plain `<a>`.
- **`AdminPanel`'s login/logout is opt-in via `auth: { authenticate }`** —
  admin doesn't assume the app's user table shape, so `authenticate: (c, {
username, password }) => Promise<AdminIdentity | null>` (verify however
  you like, e.g. `verifyPassword` from `@tknf/oven/auth`) is the only thing
  the app supplies; `auth` requires `session` to also be injected (throws
  otherwise) and, once wired, registers `GET`/`POST /login` +
  `POST /logout`, redirects any logged-out request to
  `/login?next=<path>` (confined to `basePath`, so an external `next` is
  ignored), reissues the session id on successful login (fixation
  defense), and — unless you also inject `userTools` — defaults the header
  greeting/logout link from the logged-in identity. `authorize` still runs
  on every logged-in request; `auth` only answers "who is this", not "are
  they allowed in here". Omit `auth` and nothing changes (no login routes,
  no redirect gate — `authorize` alone gates access, as before).
- **`AdminPanel`'s built-in `/login` is not rate-limited unless you inject
  `rateLimiter`** — a `RateLimiter` (`@tknf/oven/security`), applied to
  `POST /login` before `auth.authenticate` runs (5 attempts per submitted
  username per 5 minutes, key `` `admin-login:${username}` ``); a rejected
  attempt re-renders the login screen with a generic message and `429`
  without calling `authenticate` at all, and a successful login resets the
  counter. Only meaningful when login is wired (`auth`/`accounts`); when it
  is and `rateLimiter` is omitted, a one-time `console.warn` fires at
  construction (`/login` still serves every submission — no fail-closed
  default).
- **`AdminPanel` has no request body size limit unless you inject
  `bodyLimitBytes`** — wires `hono/body-limit` (`bodyLimit({ maxSize:
bodyLimitBytes })`) as the panel's very first middleware, ahead of CSRF
  verification and any of the panel's own `parseBody` calls, so an oversized
  request (e.g. against an `AdminResource` form with a `File` field) is
  rejected before it's buffered rather than after. Omitting it keeps the
  previous unlimited-body behavior and, unlike `csrf`/`rateLimiter`, emits no
  one-time warning (not every panel accepts uploads).
- **`AdminPanel` sends a strict `Content-Security-Policy` header on every
  response by default — no wiring needed.** The default is
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  (the panel's screens are script-free SSR HTML with only an inlined
  `<style>`). Pass `contentSecurityPolicy: "<policy>"` to replace it, or
  `contentSecurityPolicy: false` to omit the header (e.g. if you've
  customized the layout with a script or an external image). `SecureHeaders`
  (`@tknf/oven/security`) sets no CSP of its own — this is unrelated to it.
- **`FetchMailer` ships no vendor implementation on purpose.** Subclass it and
  implement `buildRequest` (`MailMessage` → `Request`) for your provider; `send`,
  timeout, and header-injection validation are inherited. See `docs/mailer.md`'s
  complete `ResendMailer` example for a copy-paste starting point (field
  mapping, Base64 attachment encoding, `ScopedValueAccessor` API-key wiring).
- **`@tknf/oven/admin` also ships operator accounts to back `auth`** —
  `SQLiteAdminAccounts`/`PgAdminAccounts`/`MySqlAdminAccounts` over a shipped
  users table (`sqliteAdminUsersTable()` etc., or spread
  `sqliteAdminUserColumns()` into your own table, keeping the `username`
  UNIQUE index). Security defaults to keep intact: usernames are normalized
  (trim + lowercase) at the service boundary (cross-dialect uniqueness);
  passwords are PBKDF2-hashed with a minimum length of 8 (configurable
  `minPasswordLength`) and a hard maximum of 1024; `authenticate` is
  enumeration-safe (dummy-hash verification when no user matches, inactive
  accounts cost the same, every failure returns the same `null`) and rejects
  oversized passwords before hashing. Do not raise the `iterations` option
  when the app runs on Cloudflare Workers (workerd rejects PBKDF2 above
  100,000 iterations and `verifyPassword` maps the error to `false` — logins
  fail silently), and never expose the users table as an `AdminResource`
  (the screens would render `passwordHash`). Permissions are plain strings
  (`resourcePermission(key, action)`, built-ins like `"audit.view"`) stored
  per user (`setUserPermissions`/`userPermissions`) — the panel does not
  enforce them; check them in your own `authorize`.
- **`AdminPanel`'s `accounts` option hands enforcement to the panel
  instead** — `accounts: { users, groups? }` (the same services above):
  derives the built-in login from `users.authenticate` when `auth` isn't
  also given (an explicit `auth` overrides the derived one — an escape
  hatch, e.g. for rate limiting — but its identity's `id` must then be an
  accounts user id); makes `authorize` optional (a built-in permission
  gate resolves each route's required permission — resource
  view/create/update/delete, `jobs.view`/`.manage`,
  `settings.view`/`.manage`, `audit.view` — and checks it against the
  operator's granted set; an explicit `authorize` still runs, ANDed with
  the gate); requires both `session` and `csrf` (constructor throws
  otherwise); re-validates the operator row against the DB on **every
  request**, so `isActive: false` or a deleted row revokes access
  immediately; and lets superusers bypass every permission check. A
  password change ends every outstanding session too: at login the panel
  stores a short `passwordStamp` fingerprint of `passwordHash` alongside
  the identity, re-derives it from the current row on every later request,
  and signs the session out on a mismatch — `setPassword`'s fresh PBKDF2
  salt guarantees a mismatch after any change. A session with no stamp at
  all (issued before this existed) is rejected the same way, so upgrading
  asks every logged-in operator to log back in once. This applies only to
  the `accounts` option — a hand-rolled `authorize`/`auth` gets neither
  behavior (see `docs/admin-accounts.md`'s Gotchas section). When
  omitted, `audit.actor` defaults to the logged-in identity's label
  (falling back to its id), falling back further to the literal `"admin"`
  when there's no login wiring or no logged-in identity.
- **Injecting `accounts.users` also turns on a built-in, superuser-only
  `/accounts/users` screen** (plus `/accounts/groups` once `accounts.groups`
  is injected too) for creating, editing, and deleting operators —
  `/accounts/*` requires `isSuperuser: true` regardless of any granted
  permission string, and the nav/dashboard hide any link a non-superuser
  couldn't actually open. Permission checkboxes only ever offer
  `ADMIN_BUILTIN_PERMISSIONS` (the five built-ins, exported from
  `@tknf/oven/admin`) plus `resource.<key>.<action>` per wired resource;
  saving preserves any already-stored permission string the screen doesn't
  recognize instead of dropping it. Deactivating, demoting, or deleting the
  last active superuser is refused. Writes are audited as
  `accounts.user.create`/`.update`/`.delete`/`.setPassword` and
  `accounts.group.create`/`.update`/`.delete` (`setPassword` never records
  the password itself). The last-active-superuser guard is a service-layer
  feature (`updateUser(id, patch, { protectLastActiveSuperuser: true })` /
  `deleteUser(id, { protectLastActiveSuperuser: true })`, all three
  dialects): a rejected write throws `LastActiveSuperuserError`
  (`@tknf/oven/admin`) via a single conditional `UPDATE`/`DELETE`, not a
  check-then-act read, so it holds under concurrent requests too. The panel
  always passes that option; a script calling `accounts.updateUser`/
  `deleteUser` directly gets the same protection only by passing it too
  (omit it for the unguarded call). Unknown-permission preservation, by
  contrast, is UI-only — `accounts.setUserPermissions` itself always
  overwrites the stored set outright.
- **Operator groups (`SQLiteAdminGroups`/`PgAdminGroups`/`MySqlAdminGroups`)
  layer named permission groups over the accounts** — constructed with both
  shipped tables (`sqliteAdminGroupsTable()` + `sqliteAdminUserGroupsTable()`).
  `setUserGroups` replaces a user's memberships with two statements (DELETE
  then INSERT — not transactional, deliberately fail-closed: a mid-way
  failure leaves fewer groups, never stale extras; re-run on error), and
  group permissions resolve via `permissionsForUser(userId)` (the union of
  every group's set) — combine it with the user's own `userPermissions` in
  your `authorize`. Group names are only trimmed, never lowercased (unlike
  usernames).
- **`AdminResource#filters()` is a closed allowlist** — declare each filter's
  `options` explicitly; a query value outside that list is silently ignored
  rather than applied. The sidebar (`#changelist-filter`) only renders once
  `filters()` returns at least one entry.
- **`AdminResource#dateHierarchy()` adds a year/month/day drilldown nav to the
  list screen** — return an integer epoch-millisecond column name and
  `?dhy=`/`?dhm=`/`?dhd=` narrow the list to that period (combined with any
  search/filter via `AND`), one level deeper per selection. It's a
  simplified drilldown: the enumerated years/months/days span the column's
  min to max value (two `AdminModel#listPage` calls, no new aggregation
  query), not only periods that actually contain rows, so a selected period
  can render an empty list. No nav renders unless implemented.
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
  current sort/search/filters. Both the resource list and the accounts-user
  list render this pagination with `OffsetPaginationView`
  (`@tknf/oven/pagination`).
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
- **`AdminPanel`'s markup targets WCAG 2.1 AAA** — a skip link to `#content`,
  a `<nav>`/`<ol>` breadcrumb trail, sortable/labeled table headers
  (`scope`, `aria-sort`, per-link `aria-label`), no inert "select all"
  checkbox, and `aria-current="page"` on both the active sidebar item and
  the current breadcrumb; every added string lives under the `a11y.*`
  catalog keys in `admin_catalog.ts`.
- **`BroadcastWebSocket` needs an Origin check + connection authorization** in
  the `authorize` hook / `channels` callback (prevents Cross-Site WebSocket
  Hijacking).
- **`DurableObjectBroadcaster` reconnects automatically with exponential
  backoff** (`reconnectInitialDelayMs`/`reconnectMaxDelayMs`, `reconnect: false`
  to opt out) — still at-most-once: a `publish` while the socket is down (or
  reconnecting) is never redelivered. `onDisconnect`/`onReconnect` are
  observability-only hooks (logging/metrics); there's nothing to act on beyond
  that since the adapter retries on its own.
- **Sanitize user-derived `Storage`/`KeyValueStore` keys** (no `..` or path
  separators) at the application boundary.
- **Job delivery is at-least-once** — make `Job#perform` idempotent.
  `InlineJobQueue` is for dev/tests only.
- **DB-backed `KeyValueStore`/`SessionStorage` tables never GC themselves** —
  expiry is checked lazily on `get` only. Sweep them with
  `{SQLite,Pg,MySql}PruneExpiredRecordsJob`, invoked directly
  (`job.perform()`) from a `Schedule` entry / `ScheduledDispatcher` (see
  `docs/jobs.md`'s "Pruning expired rows" task).
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
identity })` (auth cookie), and `TestJobQueue`/`TestMailer`/`TestBroadcaster`
(record instead of performing) — the fakes still run real validation, and
`TestBroadcaster` also delivers to its own `subscribe`d listeners like
`InMemoryBroadcaster`. Drive the app via `app.request(...)`.
