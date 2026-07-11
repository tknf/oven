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

**Passwordless (magic-link) login.** `PasswordlessLogin` follows the same
`request`/`verify` shape as `EmailVerification`/`PasswordReset`, plus `login`
to complete the flow. A login-granting link must be genuinely single-use
(anyone who observes the URL — mail forwarding, a shared machine, a proxy
log — must not be able to replay it), which the other two flows either don't
need or get "for free" from data that already changes; see the class's own
JSDoc in `src/auth/passwordless_login.ts` for the full comparison. To get
single-use here, wire `fingerprintOf` to a per-user random nonce and
`rotateNonce` to replace it on every successful login:

```ts
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
  rotateNonce: async (account) => {
    account.loginNonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await accounts.save(account);
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
- **`identityKey` must be set with `session.set`, never `session.flash`.**
  `Guard` reads it with a plain `session.get`, and a flashed value is
  consumed (and disappears) on the very first read — this manifests as
  users being logged out immediately after logging in.
- **Tokens (`RememberToken`, `ApiToken`, `EmailVerification`,
  `PasswordReset`, `PasswordlessLogin`) are all generated with
  `crypto.getRandomValues` high-entropy random bytes** — there is no
  low-entropy path to opt into, but if you build your own token scheme on
  top, don't substitute a weaker source.
- **`PasswordlessLogin` is only single-use if `rotateNonce` actually rotates
  the same value `fingerprintOf` reads, and only `login` (not `verify`)
  triggers it.** Skip either half of that wiring — or complete the flow by
  calling `verify` instead of `login` — and the link silently degrades to
  plain replay-until-expiry, the same as `EmailVerification`. Keep
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

- [Sessions](./sessions.md) — `Guard` and `RememberToken` both read from
  and write to the `Session` established by `SessionAccessor`.
- [Security](./security.md) — CSRF, rate limiting, and other cross-cutting
  protections that typically sit alongside `Guard` on write routes.
- [Concepts](./concepts.md) — the `register`/`use` convention shared by
  `Guard` and every other `ContextAccessor` subclass.
- [Admin accounts](./admin-accounts.md) — the ready-made TOTP
  enrollment/verification/login-second-step wiring built on top of
  `totp.ts`'s primitives.
