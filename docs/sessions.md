# Sessions

## What / Why

A `Session` is a server-side, per-request bag of data with one extra
primitive on top of a plain key-value store: `flash(key, value)`, a value
that survives exactly one `get(key)` call and then disappears. Sessions
don't persist themselves — that's the job of a `SessionStorage` subclass,
chosen based on where you want the data to actually live (in the cookie
itself, in a KV store, in a SQL table, or just in memory for
development/tests). Wiring a `SessionStorage` into every request is done by
`SessionAccessor`, which follows oven's `register`/`use` convention
(`@tknf/oven/routing`'s `ContextAccessor`): apply `register` once as
middleware, then call `use(c)` anywhere downstream to read the current
request's `Session`.

`SessionAccessor` also removes the most common source of session bugs —
forgetting to save. After your handler runs, it checks `session.isDirty`
(set by any `set`/`unset`/`flash` call, or by consuming a flash value) and
only then calls `storage.commit()` and appends `Set-Cookie`. Read-only
requests never trigger a write. If `storage.destroy()` was called anywhere
during the request, that always wins over a pending dirty commit — see
"Logging out" below.

## Minimal example

```ts
// src/env.ts
import type { Session } from "@tknf/oven/session";

export type AppEnv = { Variables: { session: Session } };
```

```ts
// src/lib/session.ts
import { InMemorySessionStorage, SessionAccessor } from "@tknf/oven/session";
import type { AppEnv } from "../env.js";

export const sessionStorage = new InMemorySessionStorage();
export const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", sessionStorage);
```

```ts
// src/domains/visits/routes.ts
import { Hono } from "hono";
import type { AppEnv } from "../../env.js";
import { sessionAccessor } from "../../lib/session.js";

export const visitsRoutes = new Hono<AppEnv>().get("/", (c) => {
  const session = sessionAccessor.use(c);
  const visits = Number(session.get("visits") ?? 0);
  session.set("visits", visits + 1);
  return c.text(`visit #${visits + 1}`);
});
```

```ts
// src/main.ts
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { visitsRoutes } from "./domains/visits/routes.js";
import { sessionAccessor } from "./lib/session.js";

const app = new Hono<AppEnv>().use(sessionAccessor.register).route("/", visitsRoutes);

export default app;
```

`InMemorySessionStorage` is only a reference implementation for development
and tests — it has no TTL support and doesn't survive a process restart. For
production, pick one of the backends below.

## Common tasks

**Choosing a `SessionStorage` backend.** All backends share the same
`get`/`commit`/`destroy` contract; only where the data lives differs:

| Class | Where data lives | Notes |
| --- | --- | --- |
| `CookieSessionStorage` | The cookie itself (HMAC-SHA256 signed) | No server-side storage, but data is only Base64URL-encoded, not encrypted — never put secrets in it (see Gotchas). Limited by the browser's ~4KB cookie size. |
| `KeyValueSessionStorage` | A `KeyValueStore` (`@tknf/oven/kv`) | Only a session id is kept in the cookie. Supports TTL and best-effort sliding-TTL refresh. Store keys are prefixed with `keyPrefix` (default `"oven_session:"`) — override it to namespace multiple session purposes on the same store, or to match an existing key scheme when migrating from another system. **The default recommendation for DB-backed sessions** — see below. |
| `PgDatabaseSessionStorage` / `SQLiteDatabaseSessionStorage` / `MySqlDatabaseSessionStorage` | A dedicated Drizzle-backed `sessions` table | A more specialized option for when you need session-specific columns or queries against the session table itself — see below. |
| `InMemorySessionStorage` | An in-process `Map` | Development/tests only — no TTL, no persistence across restarts. |

**Picking between the two DB-backed options.** Both rows above that
mention a database land on the same `SessionStorage` contract; the
difference is what's actually queryable on disk, not the session
semantics:

| You want... | Use |
| --- | --- |
| DB-backed sessions, with no dedicated schema to design or maintain | `KeyValueSessionStorage` + a DB-backed `KeyValueStore` (`SQLiteDatabaseKeyValueStore`/`PgDatabaseKeyValueStore`/`MySqlDatabaseKeyValueStore`, `@tknf/oven/kv`) — the default choice below. Sessions land in the same generic `key`/`value`/`expiresAt` table (and store) any other `KeyValueStore` consumer (`RateLimiter`, `MaintenanceMode`, cache, ...) can share, with TTL and best-effort sliding-TTL refresh already built in. |
| A dedicated `sessions` table you can query or join against directly (e.g. "list every active session for user X", a foreign key from another table into the session row) | `PgDatabaseSessionStorage`/`SQLiteDatabaseSessionStorage`/`MySqlDatabaseSessionStorage` — a purpose-built `id`/`data`/`expiresAt` table instead of a shared generic KV row. No sliding TTL (see the class's own module doc for why) and no built-in GC of expired rows (see Gotchas), so the schema and cleanup are yours to own. |

Reach for `KeyValueSessionStorage` first. Move to a `*DatabaseSessionStorage`
only once you actually need session-specific columns or direct queries
against the session table — it's not a stepping stone toward the
KV-backed option, it's a genuinely different tradeoff (a dedicated schema
you maintain vs. a generic store shared with other `KeyValueStore`
consumers).

```ts
// src/lib/session.ts (production, DB-backed via a shared KeyValueStore — the default choice)
import { KeyValueSessionStorage, SessionAccessor } from "@tknf/oven/session";
import { SQLiteDatabaseKeyValueStore } from "@tknf/oven/kv";
import type { AppEnv } from "../env.js";
import { db } from "../db/client.js"; // a Drizzle db built once for the process
import { keyValues } from "../domains/sessions/schema.js"; // export const keyValues = sqliteKeyValueTable();

const store = new SQLiteDatabaseKeyValueStore(db, keyValues);
export const sessionStorage = new KeyValueSessionStorage(store, {
  secure: true, // see Gotchas — not on by default
});

export const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", sessionStorage);
```

```ts
// src/lib/session.ts (production, cookie-backed — no server-side storage at all)
import { CookieSessionStorage, SessionAccessor } from "@tknf/oven/session";
import type { AppEnv } from "../env.js";

export const sessionStorage = new CookieSessionStorage({
  secrets: [process.env.SESSION_SECRET ?? ""],
  secure: true, // see Gotchas — not on by default
});

export const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", sessionStorage);
```

**Using a dedicated `sessions` table instead** (once the decision table
above points you there):

```ts
// src/lib/session.ts (production, a dedicated sessions table)
import { SessionAccessor, SQLiteDatabaseSessionStorage } from "@tknf/oven/session";
import type { AppEnv } from "../env.js";
import { db } from "../db/client.js"; // a Drizzle db built once for the process
import { sessions } from "../domains/sessions/schema.js"; // export const sessions = sqliteSessionsTable();

export const sessionStorage = new SQLiteDatabaseSessionStorage(db, sessions, {
  secure: true, // see Gotchas — not on by default
});

export const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", sessionStorage);
```

**Flash messages** (e.g. a "saved successfully" banner shown once after a
redirect):

```tsx
// src/domains/books/routes.tsx
export const booksRoutes = new Hono<AppEnv>()
  .post("/", (c) => {
    sessionAccessor.use(c).flash("notice", "Book created");
    return c.redirect("/books");
  })
  .get("/", (c) => {
    const notice = sessionAccessor.use(c).get("notice"); // undefined on the next request
    return c.render(<BooksListPage notice={notice} />, { title: "Books" });
  });
```

**Regenerating the session id on login** (defense against session
fixation — call this in your login handler, right after establishing a new
authenticated identity):

```ts
export const accountsRoutes = new Hono<AppEnv>().post("/login", (c) => {
  const session = sessionAccessor.use(c);
  session.set("accountId", account.id);
  session.regenerate(); // reissues the id on the next commit; data is kept
  return c.redirect("/");
});
```

**Logging out** (destroy the session and clear the cookie):

```ts
export const accountsRoutes = new Hono<AppEnv>().post("/logout", async (c) => {
  const session = sessionAccessor.use(c);
  const cookie = await sessionStorage.destroy(session);
  c.header("Set-Cookie", cookie, { append: true });
  return c.redirect("/login");
});
```

`storage.destroy()` marks the `Session` instance as destroyed
(`session.isDestroyed`), and `SessionAccessor` skips its automatic commit for
a destroyed session even if it is also dirty. This means it's safe to flash a
message before destroying in the same request — for example
`sessionAccessor.use(c).flash("notice", "Logged out")` followed by
`sessionStorage.destroy(session)` — without the auto-commit reviving the session
data after the destroy `Set-Cookie` has already gone out.

## Gotchas / Security notes

- **`secure` is not on by default** on the session cookie. In production,
  pass `secure: true` explicitly to your `SessionStorage` constructor's
  cookie options — leaving it unset only avoids breaking local HTTP
  development, it is not a safe production default.
- **`secrets` (for `CookieSessionStorage` and any HMAC/AES-based class) must
  be high-entropy random values equivalent to ~32 bytes.** A human-chosen
  passphrase is not acceptable. Weak secrets only trigger a `console.warn`
  at construction time, not a thrown error — don't rely on the runtime to
  catch this for you.
- **`CookieSessionStorage` signs but does not encrypt.** Anyone with access
  to the browser, a proxy, or DevTools can read the session payload as
  plaintext. Keep only non-secret data there; if you need to store
  something sensitive, use a KV/DB-backed storage and keep just the id in
  the cookie.
- **`CookieSessionStorage` sessions cannot be revoked server-side.** The
  signed payload carries no expiry, and `destroy` only returns a cookie that
  clears the browser's copy; a copied cookie stays valid until the secret is
  rotated. Use a KV/DB-backed storage when logout must invalidate the session.
- **Auto-commit is incompatible with `stream: true` rendering** (see
  `SessionAccessor`'s JSDoc). If you stream a response, call
  `storage.commit()` explicitly before you start streaming — headers must
  be finalized before the body, so `Set-Cookie` can't be attached
  afterward.
- **`identityKey`-style values must be `set`, not `flash`ed.** If code
  elsewhere (e.g. `Guard`) reads a value with plain `get`, storing it via
  `flash` means it disappears after being read once — this shows up as
  "the user gets logged out immediately after logging in."
- **If `next()` throws, the automatic `Set-Cookie` is not applied.** If a
  flash message or other session change made just before an error must
  survive that error response, call `storage.commit()` yourself before
  throwing.
- **`{Pg,SQLite,MySql}DatabaseSessionStorage` never deletes expired rows**
  — `get` just treats them as empty. Schedule
  `{Pg,SQLite,MySql}PruneExpiredRecordsJob` (`@tknf/oven/jobs`) if you use a
  dedicated `sessions` table and want expired rows actually removed; see
  [Jobs](./jobs.md#common-tasks).

## See also

- [Auth](./auth.md) — session-mode `Guard` reads the authenticated identity
  from this session; request-mode guards can use a separate CSRF-only session.
- [Security](./security.md) — `Csrf` stores its per-session secret inside
  the same `Session`, downstream of `SessionAccessor`.
- [Concepts](./concepts.md) — the `register`/`use` convention that
  `SessionAccessor` follows.
- [Jobs](./jobs.md) — `{Pg,SQLite,MySql}PruneExpiredRecordsJob` GCs expired
  rows out of a dedicated `sessions` table.
