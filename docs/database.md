# Database

## What / Why

`@tknf/oven/database` provides `DatabaseAccessor`, a dedicated
`ContextAccessor` (see [Concepts](./concepts.md) and
[Routing](./routing.md#injecting-a-shared-value-with-contextaccessor))
whose only job is wiring a Drizzle DB connection into the request
context. It's a thin subclass of `ScopedValueAccessor` — same
`register`/`use` pair, same `scope`-based memoization — that exists
purely to give the DB connection a dedicated, self-documenting class name
and a DB-specific "not registered" hint, instead of every app reaching
for the generic `ScopedValueAccessor` and writing its own key string.

Like the rest of oven, this is backend-agnostic: `DatabaseAccessor` knows
nothing about D1, Postgres, or MySQL specifically. It just holds whatever
`create(c)` returns (typically a `drizzle(...)` instance) and hands it
back through `use(c)`.

## Minimal example

```ts
// src/lib/db.ts
import { DatabaseAccessor } from "@tknf/oven/database";
import { drizzle } from "drizzle-orm/libsql";

type AppBindings = { DATABASE_URL: string };
type AppEnv = { Bindings: AppBindings; Variables: { db?: ReturnType<typeof drizzle> } };

const accessor = new DatabaseAccessor<AppEnv, "db">("db", {
  create: (c) => drizzle(c.env.DATABASE_URL),
});

export const registerDatabase = accessor.register;
export const useDatabase = accessor.use;
```

```ts
// main.ts
app.use(registerDatabase);
```

```ts
// inside a handler's register()
this.get("/", (c) => {
  const db = useDatabase(c);
  // ...
});
```

## Common tasks

**Exporting only the `register`/`use` pair, keeping the accessor
private.** This is the same wiring convention as every other
`ContextAccessor`-based service in oven (`SessionAccessor`, `Guard`,
etc.) — the app's own `src/lib/db.ts` module owns the instance, and
callers never see `DatabaseAccessor` itself:

```ts
export const registerDatabase = accessor.register;
export const useDatabase = accessor.use;
```

**Choosing `scope` for your runtime.** `"request"` (the default) calls
`create` on every request — the right choice for Cloudflare Workers,
where a client is built per request from a binding on `c.env` (e.g. D1,
Hyperdrive) because bindings aren't guaranteed reusable across requests.
`"app"` memoizes the first `create` result for the lifetime of the
process — the right choice for a Node-style connection pool you only
want created once:

```ts
const accessor = new DatabaseAccessor<AppEnv, "db">("db", {
  create: (c) => drizzle(pool),
  scope: "app",
});
```

**Passing `db` into a `Model`.** Once `useDatabase(c)` returns the
connection, hand it straight to a `Model` subclass's constructor (see
[Models](./models.md)) the same way you'd pass any other Drizzle `db`:

```ts
this.get("/books", async (c) => {
  const db = useDatabase(c);
  const books = await new BookModel(db).paginate({ limit: 20 });
  return c.json(books);
});
```

## Gotchas / Security notes

- **`use(c)` throws if `register` was never applied to that route.** The
  thrown message names the key (`"db"` by default) — treat it as "you
  forgot `app.use(registerDatabase)`" rather than an application bug to
  work around (see [Routing](./routing.md#gotchas--security-notes)).
- **`scope: "app"` caches the `Promise`, not the resolved value** — if
  `create` rejects, the rejection isn't cached, so the next request
  retries `create` instead of failing forever with the same error.
- **Picking the wrong `scope` for your runtime is a correctness bug, not
  just a performance one.** `scope: "app"` on Cloudflare Workers would
  reuse a connection built from a possibly stale/wrong-isolate binding;
  `scope: "request"` on Node needlessly recreates a pool client per
  request. See [Deployment](./deployment.md) for runtime-specific
  guidance.

## See also

- [Routing](./routing.md) — `ContextAccessor`/`ScopedValueAccessor`, the
  general-purpose DI mechanism `DatabaseAccessor` specializes.
- [Concepts](./concepts.md) — why `register`/`use` was chosen over a
  provider container.
- [Models](./models.md) — constructing a `Model` subclass with the `db`
  connection this accessor wires in.
- [Deployment](./deployment.md) — runtime-specific guidance on choosing
  `scope`.
