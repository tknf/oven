# Logging

## What / Why

`@tknf/oven/logging` provides `Logger`, an abstract base for structured
loggers, following the same single-idiom (abstract base + inheritance)
convention as `Mailer`/`Storage`/`KeyValueStore`. Two concrete
implementations ship out of the box: `ConsoleLogger` (writes to
`console.debug`/`.info`/`.warn`/`.error`) and `NullLogger` (writes
nothing, for tests or an unconfigured placeholder).

`debug`/`info`/`warn`/`error` are thin wrappers that merge the
constructor-bound `fields` with any call-site `fields` and delegate to
the subclass's `write`, so a subclass only ever has to implement `write`
(the actual output mechanism) and `child` (returning a new logger with
extra bound fields). `child` is the intended way to attach per-request
context, such as the `requestId` `hono/request-id` issues, without
threading it through every call site by hand.

## Minimal example

```ts
import { ConsoleLogger } from "@tknf/oven/logging";

const logger = new ConsoleLogger({ service: "checkout" });

logger.info("item created", { itemId: "123" });
// console.info({ level: "info", message: "item created", service: "checkout", itemId: "123" })
```

## Common tasks

**Attaching per-request fields with `child`.** Bind a `requestId` (or any
other per-request context) once, then log through the child so every
subsequent call carries it automatically:

```ts
const requestLogger = logger.child({ requestId: c.get("requestId") });
requestLogger.warn("rate limit close to exhausted", { remaining: 3 });
```

**Wiring a per-request `Logger` with `ScopedValueAccessor`** (see
[Routing](./routing.md#injecting-a-shared-value-with-contextaccessor)),
so handlers pull a logger already carrying `requestId` via `useLogger(c)`
instead of constructing one by hand:

```ts
// src/lib/logger.ts
import { ConsoleLogger } from "@tknf/oven/logging";
import { ScopedValueAccessor } from "@tknf/oven/routing";

type AppEnv = { Variables: { logger?: ConsoleLogger; requestId?: string } };

const rootLogger = new ConsoleLogger();
const accessor = new ScopedValueAccessor<AppEnv, "logger">("logger", {
  create: (c) => rootLogger.child({ requestId: c.get("requestId") }),
});

export const registerLogger = accessor.register;
export const useLogger = accessor.use;
```

**Wiring `Logger` into `ErrorPages`** (see
[Routing § Wiring the shared error page and health check](./routing.md#wiring-the-shared-error-page-and-health-check)),
so unhandled errors are logged with full detail while the response body
stays generic:

```ts
import { ErrorPages } from "@tknf/oven/routing";

const errors = new ErrorPages({ logger: (c) => useLogger(c) });
app.onError(errors.onError);
```

**Swapping in `NullLogger` for tests.** Anywhere a `Logger` is required
by an API but you don't want output during a test run, construct a
`NullLogger` instead of a real one — same interface, no-op `write`:

```ts
import { NullLogger } from "@tknf/oven/logging";

const logger = new NullLogger();
```

**Masking sensitive fields with `redact`.** By default, `fields` are
emitted unmodified — it's the caller's job not to pass secrets. Opt into
masking with `LoggerOptions.redact`: `true` masks a built-in list of
sensitive-looking keys (substring match, case-insensitive: `password`,
`token`, `authorization`, `cookie`, `secret`, `apikey`); a string array
masks only those key names instead. Masking is shallow — it inspects
top-level field keys only, not nested objects:

```ts
const logger = new ConsoleLogger({}, { redact: true });
logger.info("login", { password: "s3cr3t", userId: "u1" });
// -> { level: "info", message: "login", password: "[REDACTED]", userId: "u1" }
```

## Gotchas / Security notes

- **`redact` is opt-in, not a default.** Without it, `fields` are logged
  exactly as passed — never pass a password, token, `Authorization`
  header, or other secret as a field unless `redact` (or your own
  filtering) is in place first.
- **Redaction only inspects top-level keys.** A secret nested inside an
  object value (e.g. `{ user: { password: "..." } }`) is not masked, by
  design (a deliberate simplification, not an oversight) — flatten or
  redact nested secrets yourself before logging them.
- **Set the log level in your logging backend, not in `Logger` itself.**
  `Logger` has no built-in level filtering (no "only log `warn` and
  above") — `debug`/`info`/`warn`/`error` all reach `write`
  unconditionally; filter by level in your own `write` override or at the
  log-aggregation layer if needed.
- **`ErrorPages` logs full error detail but never returns it in the
  response body** (see [Routing § Gotchas](./routing.md#gotchas--security-notes)) —
  don't bypass that by logging and then also echoing raw error internals
  back to the client elsewhere.
- **`NullLogger` silently discards everything**, including `error` calls
  — don't wire it in production paths where you actually need the
  output; it's meant for tests and "no logger configured" defaults only.

## See also

- [Routing](./routing.md) — `ErrorPages`'s `logger` option and the
  `ContextAccessor`/`ScopedValueAccessor` DI pattern used to wire a
  per-request `Logger`.
- [Deployment](./deployment.md) — runtime-specific guidance on `scope`
  when wiring services (including a `Logger`) via `ScopedValueAccessor`.
