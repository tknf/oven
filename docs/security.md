# Security

## What / Why

`@tknf/oven/security` bundles a set of independent, composable hardening
primitives — there's no single "security middleware", each class covers one
concern and is wired in individually:

- **`Csrf`** — token-based CSRF protection. It deliberately replaces Hono's
  built-in `csrf` middleware (which validates `Origin`/`Sec-Fetch-Site`):
  some browser/proxy setups don't send an `Origin` header reliably, which
  makes origin-only checks prone to false positives. `Csrf` instead binds a
  per-session secret and verifies a submitted token against it, with
  BREACH-resistant one-time-pad masking on every issuance.
- **`SecureHeaders`** — a thin preset over `hono/secure-headers` (no header
  logic of its own), strengthening only `xFrameOptions` to `"DENY"`. It does
  not set a `Content-Security-Policy` — see the Gotchas note below.
- **`RateLimiter`** — fixed-window rate limiting backed by a
  `KeyValueStore` (`@tknf/oven/kv`), suitable for coarse-grained use cases
  like login-attempt throttling. Not an IP allow/deny list either — it
  throttles by whatever `key` you pass, not by network address.
- **`TrustedHost`** — fail-closed `Host` header validation against an allow
  list, guarding against Host header spoofing behind misconfigured
  proxies. This is **not** an IP allow/deny list — see below.
- **`Encrypter`** — reversible AES-256-GCM encryption for values you need
  to recover later (e.g. a stored third-party API key). Never use this for
  passwords — see [Auth](./auth.md) for password hashing.
- **`UrlSigner`** — HMAC-signed, optionally time-limited URLs for one-time
  links (email verification, password reset).
- **`MaintenanceMode`** — a `KeyValueStore`-backed toggle that serves a 503
  response to all but an allow-listed set of paths.

## Minimal example

```ts
// src/main.ts
import { Hono } from "hono";
import { Csrf, SecureHeaders, TrustedHost } from "@tknf/oven/security";
import { sessionAccessor } from "./lib/session.js";

const app = new Hono();

app.use(new TrustedHost(["example.com", ".example.com"]).verify);
app.use(new SecureHeaders().register);
app.use(sessionAccessor.register);

const csrf = new Csrf({ session: sessionAccessor.use });
app.use(csrf.verify);

app.get("/form", (c) => c.html(`<meta name="csrf-token" content="${csrf.csrfToken(c)}">`));
app.post("/action", (c) => c.text("done"));

export default app;
```

`Csrf` must run downstream of a `SessionAccessor` (it stores its per-session
secret in the `Session` — see [Sessions](./sessions.md)); calling
`csrf.verify` before `sessionAccessor.register` throws with the session
key's name embedded, the same as any other unregistered `ContextAccessor`.

## Common tasks

**Injecting the CSRF token into a form / layout, and reading it back on
submit:**

```ts
import { csrfMetaTag, CSRF_FORM_FIELD_NAME } from "@tknf/oven/security";

app.get("/books/new", (c) => {
  const token = csrf.csrfToken(c);
  return c.html(`
    ${csrfMetaTag(token)}
    <form method="post" action="/books">
      <input type="hidden" name="${CSRF_FORM_FIELD_NAME}" value="${token}" />
      <!-- ... -->
    </form>
  `);
});
```

Non-form requests (e.g. `fetch`) should send the token via the
`X-CSRF-Token` header instead; `Csrf.verify` checks the header first and
only falls back to the form body when the content type indicates a form
submission.

**Exempting a legitimate cross-site POST** (e.g. an OAuth provider's
callback), instead of disabling CSRF protection wholesale:

```ts
const csrf = new Csrf({
  session: sessionAccessor.use,
  exceptions: [{ origin: "https://provider.example", path: "/auth/callback" }],
});
```

**Rate-limiting login attempts:**

```ts
import { RateLimiter } from "@tknf/oven/security";
import { InMemoryKeyValueStore } from "@tknf/oven/kv";

const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());

app.post("/login", async (c) => {
  const key = `login:${c.req.header("CF-Connecting-IP") ?? "unknown"}`;
  const allowed = await rateLimiter.consume(key, 5, 60); // 5 attempts per 60s window
  if (!allowed) return c.text("Too many attempts", 429);

  // ... verify credentials; on success:
  await rateLimiter.reset(key);
  return c.redirect("/dashboard");
});
```

**Signing and verifying a time-limited link** (e.g. email verification):

```ts
import { UrlSigner } from "@tknf/oven/security";

const urlSigner = new UrlSigner({ secrets: [process.env.URL_SIGNING_SECRET as string] });

const link = await urlSigner.sign("https://example.com/verify-email?userId=1", {
  expiresInSeconds: 60 * 60 * 24, // 24 hours
});

app.get("/verify-email", async (c) => {
  const ok = await urlSigner.verify(c.req.raw);
  if (!ok) return c.text("Link expired or invalid", 400);
  // ... mark email verified
});
```

**Restricting access by client IP.** oven has no IP allow/deny list of its
own — `TrustedHost` validates the `Host` header (which domain the request
claims to be for), not the connecting address, and `RateLimiter` throttles
by whatever `key` you give it, not by network address specifically. For an
actual IP allow/deny list, use Hono's own `hono/ip-restriction`, paired
with the `getConnInfo` helper for your runtime (`hono/cloudflare-workers`,
`@hono/node-server/conninfo`, ...):

```ts
import { ipRestriction } from "hono/ip-restriction";
import { getConnInfo } from "hono/cloudflare-workers";

app.use(
  "/admin/*",
  ipRestriction(getConnInfo, {
    allowList: ["203.0.113.0/24"],
  }),
);
```

As with `RateLimiter`'s IP-derived keys, only trust an address if
`getConnInfo` (or an upstream proxy header you've explicitly validated) is
actually the client's real address for your deployment — a client-supplied
header like `X-Forwarded-For` taken at face value can be spoofed.

**Limiting request body size.** oven has no request-size-limiting primitive
of its own — apply Hono's own `hono/body-limit` upstream of anything that
buffers the body, most importantly `Csrf#verify` (it reads the CSRF token
from the form body via `c.req.parseBody()`) and any handler that does the
same for a file upload:

```ts
import { bodyLimit } from "hono/body-limit";

app.use(bodyLimit({ maxSize: 10 * 1024 * 1024 })); // before csrf.verify
app.use(csrf.verify);
```

Without this, `Csrf#verify` (and any multipart handler downstream of it)
buffers the full request body before any size check runs — see
[Forms](./forms.md#validating-an-uploaded-files-size-and-mime-type) for why
`validateUploadedFile`'s `maxSizeBytes` does not substitute for this.
`AdminPanel` exposes the same protection as its `bodyLimitBytes` option (see
the [admin guide](./admin.md)).

**Toggling maintenance mode:**

```ts
import { MaintenanceMode } from "@tknf/oven/security";
import { InMemoryKeyValueStore } from "@tknf/oven/kv";

const maintenanceMode = new MaintenanceMode(new InMemoryKeyValueStore(), {
  allowPaths: ["/up", "/status"],
});

app.use(maintenanceMode.use);

// From an ops script or admin action:
await maintenanceMode.enable();
await maintenanceMode.disable();
```

## Gotchas / Security notes

- **`secrets` (for `Csrf`'s underlying session, `Encrypter`, `UrlSigner`,
  and `CookieSessionStorage`) must be high-entropy random values
  equivalent to ~32 bytes.** Human-chosen passphrases are vulnerable to
  brute force and are not acceptable substitutes. Weak secrets only log a
  `console.warn` at construction time — they are not rejected at runtime,
  so don't rely on this check catching misconfiguration in CI.
- **`secure` is not on by default** on any cookie in oven (session cookies,
  remember tokens). Set it explicitly in production; see
  [Sessions](./sessions.md) and [Auth](./auth.md) for where.
- **When mounting `AdminPanel`, wire CSRF verification into its write
  routes yourself** (via the panel's CSRF option, or by applying
  `csrf.verify` upstream of it) — it is not automatic.
- **`SecureHeaders` sets no `Content-Security-Policy`.** For your app's own
  routes, pass `hono/secure-headers`'s own `contentSecurityPolicy` option
  directly (`SecureHeaders` only wraps that middleware and doesn't add
  CSP logic of its own). `AdminPanel` (`@tknf/oven/admin`) is the
  exception: it sends a strict default CSP on its own mounted routes
  regardless of whether `SecureHeaders` is wired elsewhere — see [Admin
  panel](./admin.md#content-security-policy).
- **`Csrf#verify` calls `c.req.parseBody()` to read the submitted token**,
  which buffers the whole request body — including any multipart file
  upload — before CSRF verification even runs. Neither `Csrf` nor `Form`
  imposes a cap on that buffering; apply `hono/body-limit` ahead of
  `csrf.verify` if unbounded body buffering is a concern for your
  deployment (see "Limiting request body size" above).
- **`BroadcastWebSocket` needs its own Origin check and connection
  authorization**, performed in the `authorize` hook or inside the
  `channels` callback, to prevent Cross-Site WebSocket Hijacking. This is
  outside the scope of this page — see [Realtime](./realtime.md).
- **`RateLimiter` is not atomic.** It reads then writes against a
  `KeyValueStore` in two steps, so concurrent requests against the same
  key can race and let the effective count exceed `limit` — an accepted
  tradeoff for coarse use cases like login throttling. If `key` is derived
  from a client IP, only use the IP attached by a trusted proxy layer, not
  a client-spoofable header like `X-Forwarded-For` taken at face value.
- **If a `key` you pass to any `KeyValueStore`-backed class (including
  `RateLimiter`/`MaintenanceMode`) is derived from user input, sanitize it
  on the application side** so it can't contain `..` or path separators —
  the same caution as `Storage` keys.
- **`UrlSigner` excludes the origin (scheme/host/port) from what gets
  signed** — only the path and query are covered. This is intentional (a
  reverse proxy's internal hostname often differs from the public one),
  but it also means the signature does not protect against the link being
  served from an unexpected host; combine it with `TrustedHost` if that
  matters for your deployment.
- **`Encrypter`/`UrlSigner` derive their key from a single SHA-256 pass
  over `secrets`, with no stretching** (unlike `hashPassword`'s PBKDF2).
  This is fine given a genuinely high-entropy secret, but it means these
  classes are not a substitute for password hashing — see
  [Auth](./auth.md).

## See also

- [Sessions](./sessions.md) — `Csrf` stores its secret in the `Session`
  established by `SessionAccessor`, and cookie `secure` defaults are
  covered there in full.
- [Auth](./auth.md) — password hashing, token issuance, and `Guard`, which
  typically sit alongside these primitives on the same routes.
- [Concepts](./concepts.md) — why `Csrf` replaces Hono's own CSRF
  middleware, and the `register`/`use` convention `Csrf`/`SecureHeaders`/
  `TrustedHost`/`MaintenanceMode` all follow for their middleware fields.
