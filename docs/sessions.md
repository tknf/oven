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
requests never trigger a write.

## Minimal example

```ts
// src/lib/session.ts
import { InMemorySessionStorage, SessionAccessor } from "@tknf/oven/session";
import type { Session } from "@tknf/oven/session";

export type AppEnv = { Variables: { session: Session } };

const storage = new InMemorySessionStorage();
export const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
```

```ts
// src/main.ts
import { Hono } from "hono";
import { sessionAccessor } from "./lib/session.js";
import type { AppEnv } from "./lib/session.js";

const app = new Hono<AppEnv>();
app.use(sessionAccessor.register);

app.get("/", (c) => {
  const session = sessionAccessor.use(c);
  const visits = Number(session.get("visits") ?? 0);
  session.set("visits", visits + 1);
  return c.text(`visit #${visits + 1}`);
});

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
| `KeyValueSessionStorage` | A `KeyValueStore` (`@tknf/oven/kv`) | Only a session id is kept in the cookie. Supports TTL and best-effort sliding-TTL refresh. Store keys are prefixed with `keyPrefix` (default `"oven_session:"`) — override it to namespace multiple session purposes on the same store, or to match an existing key scheme when migrating from another system. |
| `PgDatabaseSessionStorage` / `SQLiteDatabaseSessionStorage` / `MySqlDatabaseSessionStorage` | A Drizzle-backed table | Use when you already have a SQL database and want sessions queryable/auditable there. |
| `InMemorySessionStorage` | An in-process `Map` | Development/tests only — no TTL, no persistence across restarts. |

```ts
// src/lib/session.ts (production, cookie-backed)
import { CookieSessionStorage, SessionAccessor } from "@tknf/oven/session";

const storage = new CookieSessionStorage({
  secrets: [process.env.SESSION_SECRET as string],
  secure: true, // see Gotchas — not on by default
});

export const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
```

**Flash messages** (e.g. a "saved successfully" banner shown once after a
redirect):

```ts
app.post("/books", (c) => {
  sessionAccessor.use(c).flash("notice", "Book created");
  return c.redirect("/books");
});

app.get("/books", (c) => {
  const notice = sessionAccessor.use(c).get("notice"); // undefined on the next request
  return c.render(<BooksIndex notice={notice} />, { title: "Books" });
});
```

**Regenerating the session id on login** (defense against session
fixation — call this right after establishing a new authenticated identity,
typically from inside `Guard`'s `provider` flow or your login handler):

```ts
app.post("/login", (c) => {
  const session = sessionAccessor.use(c);
  session.set("accountId", account.id);
  session.regenerate(); // reissues the id on the next commit; data is kept
  return c.redirect("/");
});
```

**Logging out** (destroy the session and clear the cookie):

```ts
app.post("/logout", async (c) => {
  const session = sessionAccessor.use(c);
  const cookie = await storage.destroy(session);
  c.header("Set-Cookie", cookie, { append: true });
  return c.redirect("/login");
});
```

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

## See also

- [Auth](./auth.md) — `Guard` reads the authenticated identity out of the
  session established here.
- [Security](./security.md) — `Csrf` stores its per-session secret inside
  the same `Session`, downstream of `SessionAccessor`.
- [Concepts](./concepts.md) — the `register`/`use` convention that
  `SessionAccessor` follows.
