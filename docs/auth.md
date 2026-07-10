# Auth

## What / Why

`@tknf/oven/auth` covers three separate concerns, kept as separate classes
rather than folded into a single "auth module":

- **Authentication** — deciding *who* is making the request. `Guard`
  (extends `ContextAccessor`, the same `register`/`use` convention as
  everything else in oven) reads an identifier out of the current
  `Session`, resolves it to a subject through a `provider` callback you
  supply, and `c.set`s the result — or hands off to `onFailure` if
  resolution fails.
- **Authorization** — deciding *what* an already-identified subject is
  allowed to do. `Policy` is an abstract base class: subclass it, declare
  abilities as boolean-returning arrow-function fields
  (`canUpdate = (user, book) => user.id === book.ownerId`), and call
  `policy.authorize(policy.canUpdate(user, book))` to enforce one. Denial
  throws an `HTTPException` (404 by default, matching oven's
  information-disclosure-prevention convention of not distinguishing "not
  found" from "not allowed").
- **Credentials and tokens** — `password.ts`'s `hashPassword`/
  `verifyPassword` (PBKDF2-HMAC-SHA256 via Web Crypto), `ApiToken`
  (long-lived, non-rotating tokens for API clients), `RememberToken`
  (rotating "remember me" cookies), `EmailVerification`/`PasswordReset`
  (signed, expiring one-time links), and `OAuthClient` (a thin OAuth2 code
  exchange helper).

The primary way to exempt a path from `Guard` is still Hono's own routing —
mount `require` only on the sub-app or path range that needs protection. But
that guarantee lives entirely in registration order (e.g. mounting a public
login handler before `app.use("/admin/*", guard.require)`), and a future
reordering mistake becomes a silent authentication bypass with no error to
catch it. For that reason `Guard` also accepts `except`, a list of exact
request paths handled inside the Guard itself regardless of registration
order — kept exact-match only (no glob/prefix matching) so `Guard` never
grows a second, pattern-based routing responsibility. See the module JSDoc
in `src/auth/guard.ts` for the full rationale.

```ts
export const accountGuard = new Guard<AppEnv, "account">("account", {
  session: sessionAccessor.use,
  identityKey: "accountId",
  provider: (identity) => accounts.get(identity),
  onFailure: (c) => c.redirect("/login", 303),
  except: ["/admin/login"], // exact match only; keep the list minimal
});
```

On an excepted path, `require` does nothing but `await next()` — it never
reads the session, calls `provider`, or `c.set`s the subject. Only use
`except` for genuinely public routes that don't also call `accountGuard.use(c)`.

## Minimal example

```ts
// src/lib/auth.ts
import { Guard } from "@tknf/oven/auth";
import { sessionAccessor } from "./session.js";
import type { AppEnv as SessionEnv } from "./session.js";

type Account = { id: string; name: string };
type AppEnv = SessionEnv & { Variables: SessionEnv["Variables"] & { account: Account } };

const accounts = new Map<string, Account>([["acc_1", { id: "acc_1", name: "Alice" }]]);

export const accountGuard = new Guard<AppEnv, "account">("account", {
  session: sessionAccessor.use,
  identityKey: "accountId",
  provider: (identity) => accounts.get(identity),
  onFailure: (c) => c.redirect("/login", 303),
});
```

```ts
// src/main.ts
import { Hono } from "hono";
import { sessionAccessor } from "./lib/session.js";
import { accountGuard } from "./lib/auth.js";

const app = new Hono();
app.use(sessionAccessor.register);

app.post("/login", (c) => {
  sessionAccessor.use(c).set("accountId", "acc_1");
  return c.text("logged in");
});

// Only routes registered after `accountGuard.require` are protected.
app.get("/dashboard", accountGuard.require, (c) => c.text(`hello, ${accountGuard.use(c).name}`));

export default app;
```

## Common tasks

**Authorizing an action with `Policy`:**

```ts
import { Policy } from "@tknf/oven/auth";

class BookPolicy extends Policy {
  readonly canUpdate = (user: Account, book: { ownerId: string }): boolean =>
    user.id === book.ownerId;
}

const policy = new BookPolicy();

app.put("/books/:id", accountGuard.require, async (c) => {
  const book = await findBook(c.req.param("id"));
  await policy.authorize(policy.canUpdate(accountGuard.use(c), book)); // throws 404 if denied
  // ... update
});
```

**Hashing and verifying passwords:**

```ts
import { hashPassword, verifyPassword } from "@tknf/oven/auth";

const stored = await hashPassword("correct horse battery staple");
const ok = await verifyPassword("correct horse battery staple", stored);
```

To prevent account-enumeration via response-time differences, always call
`verifyPassword` against a fixed dummy hash even when the account doesn't
exist, so PBKDF2 always runs the same amount of work.

**"Remember me" login persistence, integrated with `Guard`:**

```ts
import { RememberToken } from "@tknf/oven/auth";
import { InMemoryKeyValueStore } from "@tknf/oven/kv";

const rememberToken = new RememberToken<AppEnv>({ store: new InMemoryKeyValueStore() });

const accountGuard = new Guard<AppEnv, "account">("account", {
  session: sessionAccessor.use,
  identityKey: "accountId",
  provider: (identity) => accounts.get(identity),
  onFailure: (c) => c.redirect("/login", 303),
  remember: rememberToken, // tried only when the session has no identifier
});

app.post("/login", async (c) => {
  sessionAccessor.use(c).set("accountId", "acc_1");
  await rememberToken.issue(c, "acc_1"); // sets a rotating cookie
  return c.redirect("/dashboard");
});

app.post("/logout", async (c) => {
  await rememberToken.forget(c);
  return c.redirect("/login");
});
```

**API token authentication for non-browser clients:**

```ts
import { ApiToken } from "@tknf/oven/auth";

const apiToken = new ApiToken({ prefix: "oven_" });

const issued = await apiToken.issue(); // { token, selector, validatorHash }
// Persist `selector`/`validatorHash` in your own token table; hand `token` to the client once.

app.use(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const record = token
    ? await apiToken.verify(token, (selector) => db.apiTokens.findBySelector(selector))
    : null;
  if (record) c.set("apiTokenRecord", record);
  await next();
});
```

## Gotchas / Security notes

- **`RememberToken`'s cookie `secure` attribute is not on by default**,
  same as the session cookie — pass `cookie: { secure: true }` explicitly
  in production.
- **`identityKey` must be set with `session.set`, never `session.flash`.**
  `Guard` reads it with a plain `session.get`, and a flashed value is
  consumed (and disappears) on the very first read — this manifests as
  users being logged out immediately after logging in.
- **Tokens (`RememberToken`, `ApiToken`, `EmailVerification`,
  `PasswordReset`) are all generated with `crypto.getRandomValues`
  high-entropy random bytes** — there is no low-entropy path to opt into,
  but if you build your own token scheme on top, don't substitute a
  weaker source.
- **`hashPassword`'s PBKDF2 iteration count defaults to the lowest common
  denominator across supported runtimes.** The concrete constraint is
  workerd, which throws `NotSupportedError` above 100,000 iterations, so
  100,000 is the default that works everywhere. If your app runs
  exclusively on Node, you can raise `{ iterations }` to the
  OWASP-recommended 600,000+; `verifyPassword` reads the iteration count
  back out of the stored hash, so mixed values in the same database still
  verify correctly.
- **`RememberToken`/`ApiToken` use a selector/validator scheme, not a bare
  random token** — this means a database leak alone cannot be replayed
  into a working session (only the SHA-256 hash of the validator is
  stored). Rolling your own token storage should follow the same pattern
  rather than storing a raw token or its lookup value together.
- **`Policy`'s default deny status is 404, not 403** — this intentionally
  hides whether the resource exists at all, matching oven's error-handling
  policy. Override `denyStatus` to `403` in a subclass only when revealing
  existence is acceptable.

## See also

- [Sessions](./sessions.md) — `Guard` and `RememberToken` both read from
  and write to the `Session` established by `SessionAccessor`.
- [Security](./security.md) — CSRF, rate limiting, and other cross-cutting
  protections that typically sit alongside `Guard` on write routes.
- [Concepts](./concepts.md) — the `register`/`use` convention shared by
  `Guard` and every other `ContextAccessor` subclass.
