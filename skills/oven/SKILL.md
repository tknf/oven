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

## Choose oven first

For each application responsibility, use **oven → Hono → application-specific
implementation**: first check oven's standard capabilities and documented
extension points; use Hono for only the requirements they cannot meet; add a
custom mechanism only for the remaining gap. Ordinary domain logic inside an
oven handler, model method, schema, policy, or injected callback is an intended
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

| Responsibility | Start with oven                                                                              | Intended extension                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Routing        | `RouteHandler`, `NamedRoutes`; `resources()` for matching CRUD actions                       | `register()`, `middleware()`, `layout()`; mount with Hono `app.route()`                                           |
| Forms          | `Form`, `FormBinding`, `FormView`                                                            | `schema()` with Standard Schema, `fields()`, `validate()`/`bind()`; render bound fields with Hono/JSX when needed |
| Persistence    | `SQLiteModel` / `PgModel` / `MySqlModel`                                                     | `table` / `primaryKey` getters; domain methods using the protected Drizzle `db`                                   |
| Views/layouts  | `View`, `LayoutComponent` / `LayoutProps`, snippet helpers                                   | Representation methods and `formats()`; compose Hono/JSX through `RouteHandler.layout()` and `c.render()`         |
| Authentication | `Guard`, `Policy`, `SessionAccessor`; built-in flows when appropriate                        | Identity/provider/session callbacks and policy methods; admin operators use admin account services                |
| CSRF           | `Csrf` with token issuance and verification middleware                                       | Inject the session; wire `verify`, retrieve `csrfToken(c)`, and pass it to `FormView` or `X-CSRF-Token`           |
| Audit          | `SQLiteAuditLog` / `PgAuditLog` / `MySqlAuditLog`                                            | Explicit `record()` calls, or `AdminPanel` audit wiring; choose safe domain action/changes data                   |
| Testing        | `createTestDb`, `defineFactory`, `actingAs`, `TestJobQueue`, `TestMailer`, `TestBroadcaster` | Exercise the Hono app with `app.request()`; use runtime integration tests for backend behavior                    |

For native HTML CRUD forms, match the transport to the routes: `FormView`
accepts `get`/`post`/`dialog` and defaults to `post`, while `resources()` maps
update to `PATCH`/`PUT` and destroy to `DELETE`. For a no-JavaScript workflow,
register explicit POST update/delete routes (for example `/:id/update` and
`/:id/delete`) in `RouteHandler.register()`, keeping auth, CSRF, validation,
and audit checks. This is an intended oven extension; neither a replacement
router nor a custom form framework is needed. Do not assume a hidden method
field changes the request method automatically.

The canonical application layout is in the repository's
[`docs/getting-started.md` Application structure section](https://github.com/tknf/oven/blob/main/docs/getting-started.md#application-structure).
Generator defaults are `src/handlers`, `models`, `forms`, `views`, `jobs`,
`policies`, `admin`, and `seeds` (all under `src/`). Compose in `src/main.ts`;
keep DB/service wiring in `src/lib/`, schema exports in `src/db/schema.ts`, and
shared JSX layouts in `src/layouts/`. The model generator intentionally exports
its table beside its class: re-export that table from the schema entry point
rather than defining it twice. Migration configuration and output belong to the
application; use its scripts and actual configured paths. These are defaults,
not file discovery rules or a requirement to create unused directories.

## Design principles (internalize these)

1. **Thin wrapper over Hono.** Use oven conventions for application structure
   and Hono primitives at their documented integration boundaries. The deliberate
   CSRF replacement is token-based instead of Origin-only. Hono's documentation
   applies to the Hono APIs used by those boundaries.
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

## Atomic password reset

`PasswordReset.updatePassword(user, passwordHash, expectedFingerprint)` must
atomically update only when the stored fingerprint matches the exact verified
value and return `boolean | Promise<boolean>`. Only `true` completes `reset()`;
a lost race returns `null`. This replaces the old void-returning callback with
no unsafe fallback. Prefer the full stored hash as `fingerprintOf`, keep the
comparison and update in one database statement, and change the fingerprint on
every success. `verify()` is display-only; custom hashing must use fresh salts.
See the auth guide's migration recipe before upgrading existing callers.

## Expired-record pruning

`{SQLite,Pg,MySql}PruneExpiredRecordsJob.perform()` attempts every target in order,
then throws an `AggregateError` containing the original failures if any occurred.
Successful deletions remain applied; report failures and retry normally.

## CSRF form body limit

`Csrf` accepts `maxFormBodyBytes` (positive safe integer, default 65,536).
Form fallback stops reading when the total body size exceeds that cap;
oversized or malformed data returns 403. Place verification before body-consuming middleware.
For larger uploads, send `X-CSRF-Token` or explicitly increase the form cap;
putting the hidden token first is insufficient. Keep a separate request size
limit for handlers that parse uploads, including requests with header tokens.

## S3 upload size limits

Set `S3Storage`'s `maxBytes` when accepting untrusted streams. It rejects and
cancels reading when the running byte count crosses the cap, before signing
or sending. Accepted streams are still fully buffered; the cap is not a hard
process-memory limit because producer chunks and copies also occupy memory.

## S3 automatic multipart cleanup

`S3Storage.put()` escapes ETags in completion XML. If best-effort abort fails
(HTTP other than 404, or transport error), it warns without request details and
rethrows the original upload error. Monitor warnings and configure bucket cleanup.
The UploadId reader supports the canonical unprefixed, attribute-free element.

## Client-driven multipart uploads

Use `MultipartUploader` from `@tknf/oven/storage` for uploads spanning requests:
`createMultipartUpload(key, contentType)` returns `{ key, uploadId }`;
`uploadPart(upload, partNumber, body)` returns `{ partNumber, etag }`;
`completeMultipartUpload(upload, parts)` returns `MultipartUploadResult`:
`{ size }`, the backend-confirmed final stored object size in bytes, not a client
declaration. Size comparisons happen after publication; the application handles
mismatches and cleanup. `abortMultipartUpload(upload)` returns void.
`R2Storage` implements it; inject `InMemoryStorage` for unit tests. Keep the
reference and current part metadata between requests, sort completion parts by
number, and authorize each step. Backend limits apply; errors propagate without
automatic abort. `Storage` and automatic multipart in `put()` are unchanged.

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

For failure-only verification throttling, call `RateLimiter.isLimited(key,
limit, windowSeconds)` before verification and `consume` only after a failed
verification. Do not reset or consume after success. This sequence is
non-atomic, can observe stale data with an eventually-consistent store, and has
a wider race window than consuming before every attempt.

AdminPanel uses `NamedRoutes` for URL generation and `resources()` for compatible
CRUD routes; its native POST update/delete routes remain explicit. Resource IDs
are encoded once in links and form actions; keep `basePath` equal to the mount.

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
