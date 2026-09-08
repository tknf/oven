# Auth

## What / Why

`@tknf/oven/auth` covers three separate concerns, kept as separate classes
rather than folded into a single "auth module":

- **Authentication** — deciding *who* is making the request. `Guard`
  (extends `ContextAccessor`, the same `register`/`use` convention as
  everything else in oven) resolves a subject either from a `Session`
  identifier through `provider`, or directly from the request through
  `authenticate`. It registers a non-nullish result with `c.set`, or hands
  off to `onFailure` when resolution returns `null`/`undefined`.
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
  (rotating "remember me" cookies), `EmailVerification`/`PasswordReset`/
  `PasswordlessLogin` (signed, expiring one-time links), and `OAuthClient` (a
  thin OAuth2 code exchange helper).
- **TOTP two-factor codes** — `totp.ts`'s `generateTotpSecret`/
  `buildOtpauthUrl`/`generateTotpCode`/`verifyTotpCode` implement RFC 6238
  (Time-Based One-Time Password) on Web Crypto alone, no dependency. Admin
  accounts' built-in enrollment/login flow (see
  [Admin accounts](./admin-accounts.md)) is the primary consumer, but these
  are standalone primitives any app can use for its own 2FA.

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
reads the session, calls `provider`/`authenticate`, or `c.set`s the subject. Only use
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

### Authenticate each request without a session

Use `authenticate(c)` when a verified external assertion, API credential, or
another request credential is the source of identity. No `SessionAccessor` or
session variable is required for this mode. `Guard` calls the callback for every
non-excepted request and never caches subjects across requests.

For example, Cloudflare Access forwards an assertion in `Cf-Access-Jwt-Assertion`.
The application must validate it; merely decoding a JWT or trusting an identity
header is insufficient. See [Cloudflare's JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

```ts
import { Hono } from "hono";
import { Guard } from "@tknf/oven/auth";
import { verifyAccessAssertion } from "./access_assertion.js";
import type { AccessSubject } from "./access_assertion.js";

/**
 * access_assertion.ts is application-owned, not an oven API.
 * AccessSubject contains the validated identity, including id: string.
 */
type AppEnv = {
  Bindings: { ACCESS_ISSUER: string; ACCESS_AUDIENCE: string };
  Variables: { account: AccessSubject };
};

const accountGuard = new Guard<AppEnv, "account">("account", {
  authenticate: async (c) => {
    const assertion = c.req.header("Cf-Access-Jwt-Assertion");
    if (!assertion) return null;
    return verifyAccessAssertion(assertion, {
      issuer: c.env.ACCESS_ISSUER,
      audience: c.env.ACCESS_AUDIENCE,
    });
  },
  onFailure: (c) => c.json({ error: "unauthorized" }, 401),
});

const app = new Hono<AppEnv>();
app.get("/me", accountGuard.require, (c) => c.json(accountGuard.use(c)));
```

`verifyAccessAssertion` above must return `Promise<AccessSubject | null>` and
validate the signature with trusted keys, the allowed algorithm, expected issuer
and audience, expiry, and the required claim types before constructing the
subject. Treat invalid credentials as `null`; let key-fetch/network/service
failures throw. `Guard` does not install a JWT library or catch these exceptions:
they reach Hono's error handler instead of `onFailure` or the protected handler.
Do not put authentication subjects in an application-wide cache.

Choose exactly one option shape:

- Session: `session`, `identityKey`, `provider`, and optional `remember`.
- Request: `authenticate`, with none of the four session-mode properties.

Both require `onFailure` and support the same `require`/`register`/`use`, `except`,
and `cacheControl` behavior. Types reject incomplete modes and mixing configured
values from both modes. Construction also throws `TypeError` for these cases,
including a non-function `authenticate`. Omit properties from the other mode
entirely, even when their value would be `undefined`: without TypeScript
[`exactOptionalPropertyTypes`](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html),
optional `never` properties still accept explicit `undefined` at compile time,
but Guard rejects their presence at runtime. `null`/`undefined` results do not register a subject or run the next
handler. `use(c)` still throws when no subject was registered. Successful protected
responses get `Cache-Control: no-store` by default; `cacheControl: false` disables
that addition. Existing session-mode callers require no migration.

### Keep CSRF sessions independent of authentication

Request authentication does not replace CSRF protection for browser write
requests. A separate session may hold only the CSRF secret; the request guard
neither reads it for identity nor creates, updates, or regenerates it.
Continue from the request guard above, extending its environment for CSRF:

```ts
import { Csrf } from "@tknf/oven/security";
import { SessionAccessor } from "@tknf/oven/session";
import type { Session } from "@tknf/oven/session";
import { csrfStorage } from "./session.js";

type FormEnv = AppEnv & { Variables: AppEnv["Variables"] & { csrfSession: Session } };
const csrfSession = new SessionAccessor<FormEnv, "csrfSession">("csrfSession", csrfStorage);
const csrf = new Csrf<FormEnv>({ session: csrfSession.use });
const forms = new Hono<FormEnv>();

forms.use(accountGuard.require, csrfSession.register, csrf.verify);
forms.get("/token", (c) => c.text(csrf.csrfToken(c)));
forms.post("/action", (c) => c.json({ accountId: accountGuard.use(c).id }));
```

`csrfStorage` is an application-owned `SessionStorage` configured as in the
[session guide](./sessions.md). Submit the issued token in the form's `csrf_token`
field or `X-CSRF-Token` header. The session middleware manages the CSRF session's
cookie; this does not turn it into an authentication session. Keep `except` to
exact public paths, which skip authentication and do not make `use(c)` available.

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

### Reset passwords atomically

`PasswordReset` handles token delivery, verification, and password hashing. Its
required `updatePassword(user, passwordHash, expectedFingerprint)` callback must
perform a single conditional write and return whether that write succeeded.
Use the full stored password hash as the fingerprint so the condition can compare
one column directly. For SQLite or Postgres with Drizzle:

```ts
import { and, eq } from "drizzle-orm";
import { PasswordReset } from "@tknf/oven/auth";

const passwordReset = new PasswordReset<Account>({
  secrets: [env.RESET_TOKEN_SECRET],
  findByEmail: (email) => accounts.findByEmail(email),
  provider: (identity) => accounts.get(identity),
  identityOf: (account) => account.id,
  fingerprintOf: (account) => account.passwordHash,
  resetUrl: (token) => `https://example.com/reset?token=${encodeURIComponent(token)}`,
  deliver: (account, url) => mailer.deliver(new PasswordResetMail(account.email, url)),
  updatePassword: async (account, passwordHash, expectedFingerprint) => {
    const updated = await db.update(accountsTable)
      .set({ passwordHash })
      .where(and(
        eq(accountsTable.id, account.id),
        eq(accountsTable.passwordHash, expectedFingerprint),
      ))
      .returning({ id: accountsTable.id });
    return updated.length === 1;
  },
});

await passwordReset.request(email); // same response whether or not the email exists
const preview = await passwordReset.verify(token); // display/pre-check only, does not consume
const account = await passwordReset.reset(token, validatedPassword);
// null for an invalid token, removed account, or a concurrent reset/password change
```

For MySQL, use the driver's affected-row result instead of `returning()`.
Keep the comparison and update in the same database statement: a separate read
followed by an unconditional write, or a lock in one process, cannot prevent
requests on different instances from both succeeding. `expectedFingerprint` is
captured during signature verification; do not replace it with a fresh value
read from the user or the database after hashing. Only a literal `true` from the
callback makes `reset()` return the verified user; hash/storage errors propagate.
The returned user is the verified snapshot, not a fresh database read.

**Migration from the old callback (breaking change):** replace
`updatePassword(user, passwordHash): void | Promise<void>` with the three-argument,
boolean-returning callback above. There is no unconditional fallback. Do not
merely append `return true` to the old write: implement the conditional update
and return its actual outcome. If you keep an existing fingerprint expression,
the database condition must compare that same expression; changing the fingerprint
to the full hash invalidates already-issued links, so request new links afterward.
Every successful update must change the fingerprint, including when resetting to
the same password: the default `hashPassword` uses a fresh salt, and a custom
`hash` function must provide the same property. Validate the new password in the
application before calling `reset`, and retain the handler's CSRF/rate limits.

**Passwordless (magic-link) login.** `PasswordlessLogin` follows the same
`request`/`verify` shape as `EmailVerification`/`PasswordReset`, plus `login`
to complete the flow. A login-granting link must be genuinely single-use
(anyone who observes the URL — mail forwarding, a shared machine, a proxy
log — must not be able to replay it). Like `PasswordReset`'s atomic password
update, this flow needs a conditional change to its fingerprint. To get
single-use here, wire `fingerprintOf` to a per-user random nonce and
`rotateNonce` to a compare-and-swap that only replaces it when the stored
value still matches the nonce `login` just verified against — a blind
unconditional write would let two concurrent `login` calls for the same
token both succeed (see `rotateNonce`'s JSDoc for why):

```ts
import { and, eq } from "drizzle-orm";
import { PasswordlessLogin } from "@tknf/oven/auth";
import { encodeBase64Url } from "@tknf/oven/support";

// `loginNonce` needs an initial random value set at account creation time,
// the same way `fingerprintOf`/`rotateNonce` require thereafter.
const passwordlessLogin = new PasswordlessLogin<Account>({
  secrets: [env.LOGIN_TOKEN_SECRET],
  findByEmail: (email) => accounts.findByEmail(email),
  provider: (identity) => accounts.get(identity),
  identityOf: (account) => account.id,
  fingerprintOf: (account) => account.loginNonce,
  loginUrl: (token) => `https://example.com/login/${token}`,
  deliver: (account, url) => mailer.deliver(new MagicLinkMail(account.email, url)),
  rotateNonce: async (account, expectedNonce) => {
    const fresh = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const updated = await db
      .update(accountsTable)
      .set({ loginNonce: fresh })
      .where(and(eq(accountsTable.id, account.id), eq(accountsTable.loginNonce, expectedNonce)))
      .returning();
    return updated.length > 0; // false means another concurrent login already consumed this token
  },
});

app.post("/login/request", async (c) => {
  const { email } = await c.req.parseBody();
  await passwordlessLogin.request(String(email)); // enumeration-safe: same response either way
  return c.redirect("/login/check-your-email");
});

app.get("/login/:token", async (c) => {
  const account = await passwordlessLogin.login(c.req.param("token"));
  if (!account) return c.redirect("/login?error=invalid_or_expired");
  sessionAccessor.use(c).set("accountId", account.id); // session establishment stays app-side
  return c.redirect("/dashboard");
});
```

**API token authentication for non-browser clients.** `ApiToken` only
issues/verifies the token string — pulling it out of the
`Authorization: Bearer <token>` header and rejecting the request when it's
missing is already Hono's own `hono/bearer-auth`, so wire `ApiToken.verify`
into its `verifyToken` option instead of parsing the header by hand:

```ts
import { bearerAuth } from "hono/bearer-auth";
import { ApiToken } from "@tknf/oven/auth";

const apiToken = new ApiToken({ prefix: "oven_" });

const issued = await apiToken.issue(); // { token, selector, validatorHash }
// Persist `selector`/`validatorHash` in your own token table; hand `token` to the client once.

app.use(
  bearerAuth({
    verifyToken: async (token, c) => {
      const record = await apiToken.verify(token, (selector) =>
        db.apiTokens.findBySelector(selector),
      );
      if (!record) return false;
      c.set("apiTokenRecord", record); // verifyToken returns a boolean, not the record
      return true;
    },
  }),
);
```

**Decoding an OAuth ID token — and verifying it when the trust chain
requires it.** `OAuthClient.exchangeCode` returns `OAuthTokens.idToken` as
a raw JWT string. `decodeIdToken` only base64url-decodes its payload for
convenience; **it does not verify the signature** (see the class's own
JSDoc in `src/auth/oauth.ts`). That's an acceptable shortcut only when the
token came straight back from the provider's token endpoint over TLS — the
transport itself is what you're trusting, not the signature. Any other
path (a token forwarded from a client-side redirect, a mobile app handing
you an ID token it obtained separately, ...) needs the signature actually
checked before the payload is trustworthy. oven doesn't add its own JWT
verifier for this — use Hono's, from `hono/jwt`:

```ts
import { verify } from "hono/jwt";

// Symmetric example (an HMAC secret shared with the provider):
const payload = await verify(idToken, provider.jwtSecret, "HS256");
```

```ts
import { verifyWithJwks } from "hono/jwt";

// Asymmetric example — the common case for OpenID Connect providers that
// publish a JWKS endpoint (e.g. Google):
const payload = await verifyWithJwks(idToken, {
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  allowedAlgorithms: ["RS256"],
});
```

Both throw on a signature/claims mismatch and, on success, already return
the decoded payload — once you've verified, `decodeIdToken` is redundant.

**RFC 6238 TOTP two-factor codes.** `generateTotpSecret` returns a random
Base32 secret; `buildOtpauthUrl` turns it into an `otpauth://totp/...`
provisioning URL (the "Key URI Format" most authenticator apps and QR-code
libraries understand — QR rendering itself is out of scope, bring your own
library); `generateTotpCode`/`verifyTotpCode` generate/check codes against
it. All four default to HMAC-SHA1, 6 digits, and a 30-second period (the
values every mainstream authenticator app assumes); `algorithm` also accepts
`"SHA-256"`/`"SHA-512"` if your app controls both ends.

```ts
import { buildOtpauthUrl, generateTotpSecret, verifyTotpCode } from "@tknf/oven/auth";

// Enrollment: generate a secret, show it as a QR code (bring your own QR library).
const secret = generateTotpSecret();
const otpauthUrl = buildOtpauthUrl({ secret, issuer: "My App", accountName: user.email });
// Persist `secret` against the user once they confirm a code (see below).

// Verification: `driftSteps` (default 1) accepts the previous/current/next 30s step,
// tolerating small clock drift between the server and the operator's device.
const step = await verifyTotpCode({ secret, code: submittedCode });
if (step === null) {
  // reject — no step in the drift window matched
}
```

`verifyTotpCode` returns the MATCHED time step (not just `true`/`false`)
specifically so you can persist it and reject a future verification against
that same step — a code is otherwise valid for the whole `periodSeconds`
window and anyone who observes it (over someone's shoulder, in a log, ...)
could replay it until the window closes. Store the returned step (e.g. in a
`lastUsedStep` column) and only accept a NEW verification whose step is
strictly greater:

```ts
const previousStep = await loadLastUsedStep(userId); // from your own storage
const step = await verifyTotpCode({ secret, code: submittedCode });
if (step === null || (previousStep !== null && step <= previousStep)) {
  // reject — no match, or a replay of an already-used step
}
await saveLastUsedStep(userId, step);
```

`@tknf/oven/admin`'s accounts services implement exactly this pattern as a
single atomic conditional UPDATE — see
[Admin accounts' "Add TOTP two-factor authentication"](./admin-accounts.md#add-totp-two-factor-authentication)
for the ready-made version (enrollment, replay protection, and the built-in
login second step) instead of wiring the primitives above by hand.

## Gotchas / Security notes

- **`RememberToken`'s cookie `secure` attribute is not on by default**,
  same as the session cookie — pass `cookie: { secure: true }` explicitly
  in production.
- **Request authentication verifies every request.** Return only validated
  subjects from `authenticate`; return nullish values for invalid credentials
  and propagate service errors. Authentication does not remove the need for
  CSRF protection on browser writes; a separate CSRF session is supported.
- **In session mode, `identityKey` must be set with `session.set`, never `session.flash`.**
  `Guard` reads it with a plain `session.get`, and a flashed value is
  consumed (and disappears) on the very first read — this manifests as
  users being logged out immediately after logging in.
- **Reset and verification links use signed `DataToken` payloads.** The
  fingerprint is included in the signed content, not exposed in the payload.
  Tokens may be identical for the same identity, fingerprint, and expiry;
  issuing another link alone does not revoke earlier links. Use strong signing
  secrets and an atomic fingerprint change when single-use behavior is required.
- **`PasswordReset.updatePassword` is a required compare-and-swap.** It must
  change the value returned by `fingerprintOf` and return true only for the
  successful conditional update. `verify()` alone never consumes a token. See
  [Reset passwords atomically](#reset-passwords-atomically) for migration details.
- **`PasswordlessLogin` is only single-use if `rotateNonce` actually rotates
  the same value `fingerprintOf` reads, and only `login` (not `verify`)
  triggers it.** Skip either half of that wiring — or complete the flow by
  calling `verify` instead of `login` — and the link silently degrades to
  plain replay-until-expiry, the same as `EmailVerification`. `rotateNonce`
  must also be a compare-and-swap, not a blind write — see its JSDoc — or two
  concurrent `login` calls for the same token can both succeed and grant two
  sessions from one single-use link. Keep
  `expiresInSeconds` short regardless, since it's the only backstop left if
  rotation is ever misconfigured.
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
- **`OAuthClient.decodeIdToken` never checks the signature.** It's only
  safe to trust the payload it returns when the ID token was obtained
  directly from the provider's token endpoint over TLS — verify with
  `hono/jwt`'s `verify`/`verifyWithJwks` first for any ID token that
  arrives by another path (see "Decoding an OAuth ID token" above).
- **`verifyTotpCode` alone does not stop replay** — it only checks whether
  `code` matches some step in the drift window, and by itself would accept
  the same code again on a second call within that window. Persisting and
  comparing the returned step (see "RFC 6238 TOTP two-factor codes" above)
  is what actually prevents replay; do this even if you don't use the
  admin-accounts services, which already do it for you.
- **A wider `driftSteps` trades security for clock-skew tolerance** —
  each extra step doubles the number of codes that verify at any given
  moment (a 30-second window per step on each side). The default (`1`, ±30s)
  already covers ordinary clock drift; only widen it if you have a specific
  reason to expect more.

## See also

- [Sessions](./sessions.md) — session-mode `Guard` and `RememberToken` read from
  and write to the `Session` established by `SessionAccessor`.
- [Security](./security.md) — CSRF, rate limiting, and other cross-cutting
  protections that typically sit alongside `Guard` on write routes.
- [Concepts](./concepts.md) — the `register`/`use` convention shared by
  `Guard` and every other `ContextAccessor` subclass.
- [Admin accounts](./admin-accounts.md) — the ready-made TOTP
  enrollment/verification/login-second-step wiring built on top of
  `totp.ts`'s primitives.
