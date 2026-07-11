# Support

## What / Why

`@tknf/oven/support` is a set of small, independent primitives that other
oven modules build on: id generation, typed cookie access, base64url and
Base32 encoding, constant-time comparison, fetch timeouts, env validation,
and two runtime security warnings. Like `@tknf/oven/helpers`, there's no
single "support" object — each export is a standalone class or function you
wire in where needed.

## Minimal example

```ts
import { SnowflakeIdGenerator, CookieAccessor } from "@tknf/oven/support";

const idGenerator = new SnowflakeIdGenerator();
const visitorId = new CookieAccessor({
  name: "visitor_id",
  options: { path: "/", secure: true },
});

app.get("/set", (c) => {
  visitorId.set(c, idGenerator.generate());
  return c.text("ok");
});
```

## Common tasks

**Choosing an id generator for a `Model`** (the default is
`SnowflakeIdGenerator` — see [Models](./models.md)):

```ts
import { SnowflakeIdGenerator, UuidV7IdGenerator, UlidIdGenerator, UuidV4IdGenerator } from "@tknf/oven/support";

new SnowflakeIdGenerator(); // numeric string, edge-mode (random) by default
new UuidV7IdGenerator(); // RFC 9562 UUIDv7, chronologically sortable
new UlidIdGenerator(); // ULID, chronologically sortable, Crockford Base32
new UuidV4IdGenerator(); // fully random UUIDv4, not sortable
```

All four implement the abstract `IdGenerator` class (`generate(): string`),
so app code that only needs an id should depend on `IdGenerator`, not a
concrete scheme.

**Reading/writing a cookie that needs integrity protection** (e.g. a
`remember_token` that must not be forgeable by the client): call Hono's own
signed cookie API directly — `CookieAccessor` intentionally stays unsigned
(see the module JSDoc for why signed/unsigned are two separate shapes), so
this is the supported way to get a signed cookie in oven:

```ts
import { getSignedCookie, setSignedCookie } from "hono/cookie";

const secret = process.env.REMEMBER_SECRET as string;

await setSignedCookie(c, "remember_token", token, secret);
const value = await getSignedCookie(c, secret, "remember_token"); // string | undefined | false (false = tampered)
```

Use the plain `CookieAccessor` instead when the value doesn't need
integrity protection (e.g. a UI preference, as in the minimal example above).

> **Legacy: `SignedCookieAccessor`/`SignedCookieDefinition`.** These used to
> wrap the call above in a typed accessor matching `CookieAccessor`'s shape.
> They are now `@deprecated` and scheduled for removal in the next major —
> use `getSignedCookie`/`setSignedCookie` directly as shown above, or
> `CookieAccessor` combined with your own explicit signing (the pattern
> `UrlSigner`/`CookieSessionStorage` use internally) if you need to reuse the
> signing logic across several cookies.

**Validating `c.env` once at startup, then distributing a typed config**
(via `ScopedValueAccessor` from `@tknf/oven/routing`, with `scope: "app"`
so the validated `Promise` is memoized and every request after the first
one reuses it):

```ts
import { validateEnv } from "@tknf/oven/support";
import { ScopedValueAccessor } from "@tknf/oven/routing";
import { z } from "zod";

const configSchema = z.object({ TURSO_DATABASE_URL: z.string() });
type AppConfig = z.infer<typeof configSchema>;
type AppBindings = { TURSO_DATABASE_URL: string };
type AppEnv = { Bindings: AppBindings; Variables: { config?: AppConfig } };

const accessor = new ScopedValueAccessor<AppEnv, "config">("config", {
  create: (c) => validateEnv(configSchema, c.env),
  scope: "app",
});

export const registerConfig = accessor.register;
export const useConfig = accessor.use;
```

A failed validation throws `EnvValidationError` (with all issues'
path/message formatted into `error.message`), and because the rejected
`Promise` under `scope: "app"` is not cached, the next request retries
`create` rather than repeating a stale failure forever.

**Comparing a submitted secret in constant time** (e.g. a signature or
token), instead of `===`:

```ts
import { constantTimeEqual } from "@tknf/oven/support";

const isValid = constantTimeEqual(submittedBytes, expectedBytes);
```

## Gotchas / Security notes

- **A signed cookie's `secret` must be a high-entropy random value equivalent
  to ~32 bytes** — whether signed via `getSignedCookie`/`setSignedCookie`
  directly or the legacy `SignedCookieAccessor`. `warnWeakSecrets` (used
  internally by classes such as `Encrypter`/`UrlSigner`/`CookieSessionStorage`,
  not by Hono's own signed cookie functions) only issues a `console.warn`
  once per context at construction time — it never throws, so it must not be
  relied on to catch misconfiguration in CI.
- **No cookie class in oven defaults `secure` to `true`**, `CookieAccessor`
  included — set it explicitly via `options.secure` in production.
  `warnInsecureCookieInProduction` only warns (once per context, via
  `console.warn`, when `NODE_ENV === "production"` can be determined) and
  never injects a default or rejects the request.
- **`constantTimeEqual` must be used for every secret-vs-secret
  comparison** (signatures, tokens, masked CSRF values) — a plain `===`
  can leak the position of the first mismatching byte through timing.
- **`decodeBase64Url`/`encodeBase64Url` avoid Node-only APIs** (`Buffer`)
  and are built on `btoa`/`atob`, so they work the same in Workers,
  browsers, and Node.
- **`encodeBase32`/`decodeBase32` are RFC 4648 §6 Base32** (distinct from
  Base64URL — different alphabet, used where the encoded form must be
  human-typeable/scannable, e.g. a TOTP secret in
  [Authentication](./auth.md#common-tasks)). `encodeBase32` always produces
  uppercase, unpadded output; `decodeBase32` tolerates lowercase input and
  trailing `=` padding but throws `TypeError` on any other character
  outside the alphabet.
- **`timeoutSignal` returns `undefined` when `timeoutMs` is not given** —
  Workers' `fetch` has no default timeout, so an unbounded outbound call
  can hang and consume execution time/concurrency; pass an explicit
  `timeoutMs` for any subrequest to an external service.
- **`registerConfig`/`useConfig` are not literal exports of this module** —
  they are the recommended naming convention for the `register`/`use` pair
  you create yourself from `ScopedValueAccessor` (`@tknf/oven/routing`), as
  shown above.

## See also

- [Models](./models.md) — `IdGenerator`'s role in the model layer's
  default id assignment.
- [Sessions](./sessions.md) — cookie `secure` defaults and `secrets`
  requirements in full, for the session storage built on top of these
  cookie/warning primitives.
- [Security](./security.md) — `Encrypter`/`UrlSigner`/`Csrf`, which build
  on `constantTimeEqual`, `encodeBase64Url`/`decodeBase64Url`, and
  `warnWeakSecrets`.
