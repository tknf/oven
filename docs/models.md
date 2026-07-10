# Models

## What / Why

`@tknf/oven/model` is a thin abstract base class over
[Drizzle ORM](https://orm.drizzle.team) that absorbs the boilerplate every
model in an app ends up repeating — id generation, automatic
`createdAt`/`updatedAt` management, cursor-based pagination, bulk `IN`
fetches without an N+1 pattern, and optimistic-lock updates — without
hiding Drizzle itself. Subclasses are free to write `this.db.select()...`
directly inside their own methods whenever the base vocabulary
(`retrieve`/`list`/`create`/`update`/...) doesn't fit.

Because Drizzle's type system is mutually incompatible across SQL dialects,
there is no single shared generic base: `SQLiteModel`, `PgModel`, and
`MySqlModel` are three parallel implementations of the same method
vocabulary, one per dialect. This page uses `SQLiteModel`; `PgModel` and
`MySqlModel` follow the same contract (MySQL's implementation has one
notable difference — see Gotchas).

Deliberately not provided: lifecycle hooks (before/after callbacks) and
validation. Validation is the [Form](./forms.md) layer's job; the model
stays a thin DB layer that trusts already-normalized input.

## Minimal example

```ts
// src/models/item_model.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SQLiteModel } from "@tknf/oven/model";

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lockVersion: integer("lock_version").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

const schema = { items };

export class ItemModel extends SQLiteModel<typeof items, typeof items.id, typeof schema> {
  protected get table() {
    return items;
  }
  protected get primaryKey() {
    return items.id;
  }
}
```

```ts
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { ItemModel } from "./src/models/item_model.js";

const db = drizzle(createClient({ url: "file:./data.sqlite" }), { schema: { items } });
const model = new ItemModel(db);

const created = await model.create({ name: "First book" });
// created.id / createdAt / updatedAt are filled in automatically.
```

The three type parameters are the Drizzle table (`typeof items`), its
primary key column (`typeof items.id`), and the Drizzle schema object
(`typeof schema`, used to type `db`) — all three are required for a
subclass to compile against `this.db`.

## Common tasks

### Fetching one row, a filtered list, or a count

```ts
await model.retrieve(id); // single row by primary key, or undefined
await model.retrieveBy(eq(items.status, "published")); // first match, or undefined
await model.list(eq(items.status, "draft")); // all matching rows (unbounded — use paginate for large tables)
await model.count(eq(items.status, "draft"));
await model.exists(eq(items.status, "published"));
```

### Bulk-loading by a set of ids or foreign keys (avoiding N+1)

```ts
// "belongs to": Map<primaryKeyValue, row>
const byId = await model.retrieveMany(["id-1", "id-2"]);

// "has many": Map<columnValue, row[]>
const byAuthor = await model.groupedIn(items.authorId, ["author-1", "author-2"]);

// flat list matching an IN clause
const rows = await model.listIn(items.status, ["draft", "published"]);
```

Passing an empty array returns an empty result with no query issued; passing
more values than the model's `maxInValues` (constructor's third argument,
default `1000`) throws instead of silently truncating.

### Cursor pagination

```ts
const page1 = await model.paginate({ limit: 20 });
const page2 = page1.hasMore
  ? await model.paginate({ limit: 20, cursor: page1.nextCursor ?? undefined })
  : null;
```

`OFFSET` is intentionally avoided; `paginate` walks in primary-key order
(`direction: "desc"` for "most recent first" when the primary key is a
monotonically increasing id, such as the default Snowflake id).

### Offset pagination with `listPage`

```ts
const page = await model.listPage({
  orderBy: [{ column: items.name, direction: "asc" }],
  limit: 20,
  offset: 20, // page 2
});
```

`listPage` is the counterpart to `paginate` for cases `paginate` can't cover:
sorting by an arbitrary column (not just the primary key) and jumping
directly to a page number, the shape a column-sortable admin listing needs.
`orderBy` defaults to primary key ascending when omitted, and `where` filters
the same way as other list methods. Prefer `paginate` for large-scale,
publicly listed data — a large `offset` still makes the database scan and
discard that many rows, so `listPage` is best kept to bounded, internal-facing
listings (e.g. an admin panel).

### Optimistic locking with `updateLocked`

```ts
import { StaleRecordError } from "@tknf/oven/model";

const item = await model.retrieve(id);
if (!item) throw new Error("not found");

try {
  const updated = await model.updateLocked(id, item.lockVersion, { name: "New name" });
} catch (err) {
  if (err instanceof StaleRecordError) {
    // The row was deleted, or another update won the race — re-retrieve and retry/report.
  } else {
    throw err;
  }
}
```

`updateLocked` requires a `lockVersion` column on the table (integer,
`NOT NULL`, initial value `0`); it throws with a clear message on tables
that don't have one.

### Soft delete

```ts
await model.softDelete(id); // sets deletedAt to now
await model.restore(id); // sets deletedAt back to null
```

Fetch methods (`list`/`retrieve`/...) never automatically exclude
soft-deleted rows — there is no implicit global scope. Add
`isNull(items.deletedAt)` to your own `where` conditions when you want to
exclude them.

### Running inside a transaction

```ts
await db.transaction(async (tx) => {
  const txItems = model.with(tx);
  await txItems.create({ name: "Created inside a transaction" });
});
```

### Tenant-scoped models (multi-tenant recipe)

A common shape for a shared-database multi-tenant app is one set of tables
with a tenant/account column that every query must be filtered by. That
column is exactly the kind of condition a model's `where` does *not* add for
you — forgetting it on one call site doesn't error, it silently reads or
writes across every tenant. oven has no built-in scoping hook (no implicit
`baseWhere()` merged into every query): `SQLiteModel`/`PgModel`/`MySqlModel`
are three intentionally parallel implementations with no shared base to hook
into, and rewriting a caller's query behind their back would conflict with
the "no magic" principle the rest of this base class follows. Instead, write
the scope as an explicit subclass: bind the tenant id in the constructor, add
a `scope()` helper that ANDs it onto any `where` (`and()` drops `undefined`
operands, so it reads correctly whether a caller passes a `where` or not),
and override every method that could otherwise leak across tenants.

```ts
// src/models/tenant_item_model.ts
import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { SQLiteModel } from "@tknf/oven/model";
import type { IdGenerator } from "@tknf/oven/support";
import { items } from "../db/schema.js"; // has an `accountId` column

const schema = { items };

export class TenantItemModel extends SQLiteModel<typeof items, typeof items.id, typeof schema> {
  constructor(
    db: BaseSQLiteDatabase<"async", unknown, typeof schema>,
    private readonly tenantId: string,
    idGenerator?: IdGenerator,
    maxInValues?: number,
  ) {
    super(db, idGenerator, maxInValues);
  }

  protected get table() {
    return items;
  }
  protected get primaryKey() {
    return items.id;
  }

  private scope(where?: SQL): SQL | undefined {
    return and(eq(items.accountId, this.tenantId), where);
  }

  list(where?: SQL) {
    return super.list(this.scope(where));
  }

  retrieveBy(where: SQL | undefined) {
    return super.retrieveBy(this.scope(where));
  }

  retrieve(pk: string) {
    return this.retrieveBy(eq(items.id, pk));
  }
}
```

The same substitution — `super.method(this.scope(where))` — covers `count`,
`exists`, `pluck`, `updateWhere`, and the `where` option of `paginate`/
`listPage`.

**PK-only methods bypass `where` entirely** (`retrieve`, `update`,
`updateLocked`, `touch`, `increment`/`decrement`, `delete`), so scoping them
means re-deriving them instead of passing a `where` through. `retrieve`
above is one example (routed through the now-scoped `retrieveBy`); the rest
follow the same idea, reaching `this.db`/`this.table` directly where the base
class has no `where`-accepting equivalent to delegate to (both are `protected`
on the base class, so a subclass can use them):

```ts
async update(pk: string, patch: Partial<typeof items.$inferInsert>) {
  const updated = await super.updateWhere(this.scope(eq(items.id, pk)), patch);
  return updated === 0 ? undefined : this.retrieve(pk);
}

async delete(pk: string) {
  const [row] = await this.db
    .delete(this.table)
    .where(this.scope(eq(items.id, pk)))
    .returning();
  return row;
}

async touch(pk: string): Promise<void> {
  await this.db
    .update(this.table)
    .set({ updatedAt: Date.now() })
    .where(this.scope(eq(items.id, pk)));
}
```

`increment`/`updateLocked` have no `where`-accepting counterpart either, so
they need the same direct-`this.db` treatment (mirror the base class's own
`increment`/`updateLocked` implementation in `sqlite_model.ts`, adding
`this.scope(...)` to the `where`). `decrement` needs no override of its own —
the base implementation calls `this.increment(...)`, which already resolves
to your overridden, scoped version through normal method dispatch. The same
applies to `softDelete`/`restore`: both delegate to `this.update(...)`, so
overriding `update` as above scopes them for free.

**`listIn`/`groupedIn`/`retrieveMany` don't accept a `where` at all** (they
build an `inArray` condition internally), so a scoped version can't delegate
to `super`. Compose the equivalent from the now-scoped `list`/`retrieveBy`
instead, e.g. `tenantItems.list(inArray(items.id, ids))` for the `listIn`
case; `groupedIn`/`retrieveMany`'s `Map`-building needs reimplementing on top
of that same scoped `list` if you need them.

**`create`/`createMany`/`upsert` can't be protected by a `where` at all** —
scoping an insert means never trusting the tenant column from the caller's
input and always setting it from `this.tenantId`:

```ts
type ScopedItemInput = Omit<typeof items.$inferInsert, "id" | "createdAt" | "updatedAt" | "accountId"> &
  Partial<Pick<typeof items.$inferInsert, "id" | "createdAt" | "updatedAt">>;

create(input: ScopedItemInput) {
  return super.create({ ...input, accountId: this.tenantId });
}

createMany(inputs: ScopedItemInput[]) {
  return super.createMany(inputs.map((input) => ({ ...input, accountId: this.tenantId })));
}
```

**`with(tx)` needs its own override too.** The base implementation
reconstructs `this.constructor` assuming the unchanged `(db, idGenerator?,
maxInValues?)` signature; once the subclass's constructor takes `tenantId` as
well, the base's `with` would drop it silently. Re-declare it with the wider
constructor shape:

```ts
with(tx: BaseSQLiteDatabase<"async", unknown, typeof schema>): this {
  const Ctor = this.constructor as new (
    db: BaseSQLiteDatabase<"async", unknown, typeof schema>,
    tenantId: string,
  ) => this;
  return new Ctor(tx, this.tenantId);
}
```

Because this recipe depends on knowing every method the base class exposes,
guard it with a test that fails the day oven adds a new one — a prompt to
reconsider whether the new method needs scoping too:

```ts
import { SQLiteModel } from "@tknf/oven/model";

test("SQLiteModel's public surface hasn't grown past what TenantItemModel scopes", () => {
  // Includes `constructor` and the compile-time-only "private" methods too —
  // `private` is a type-checker concept, not a runtime one, so both still
  // show up in this enumeration alongside the public methods above.
  expect(Object.getOwnPropertyNames(SQLiteModel.prototype).sort()).toEqual(
    [
      "constructor",
      "retrieve",
      "retrieveBy",
      "list",
      "exists",
      "count",
      "pluck",
      "listIn",
      "groupedIn",
      "retrieveMany",
      "paginate",
      "listPage",
      "create",
      "createMany",
      "update",
      "updateWhere",
      "updateLocked",
      "softDelete",
      "restore",
      "upsert",
      "touch",
      "increment",
      "decrement",
      "delete",
      "with",
      "withAutoFields",
      "withTouchedUpdatedAt",
      "lockVersionColumn",
      "assertDeletedAtColumn",
      "assertWithinMaxInValues",
    ].sort(),
  );
});
```

## Gotchas / Security notes

- **`maxInValues` upper bound.** `listIn`/`groupedIn`/`retrieveMany` throw
  once the number of values passed exceeds the limit (default `1000`,
  overridable via the model's third constructor argument), rather than
  silently truncating. Use `paginate`'s `where` for large-scale filtering
  instead of a giant `IN` list.
- **`updateLocked` collapses two causes into one error.** Both "the row is
  gone" and "the version doesn't match" produce the same zero-row UPDATE,
  and `StaleRecordError` can't distinguish them — if your app needs to tell
  them apart, catch the error and `retrieve(pk)` again.
- **Soft delete has no implicit scope.** Unlike frameworks with a global
  "exclude deleted rows" default, oven's `softDelete`/`restore` only touch
  `deletedAt`; every read call site is responsible for filtering it out
  when that's the desired behavior (a deliberate consequence of the
  "no magic" design principle).
- **No built-in tenant/row-level scope, either.** A shared-database
  multi-tenant table has the same "no magic" consequence as soft delete: every
  `where` is caller-composed, and PK-only methods (`retrieve`/`update`/
  `delete`/...) bypass `where` entirely. See
  [Tenant-scoped models](#tenant-scoped-models-multi-tenant-recipe) for the
  full recipe.
- **Automatic `id` generation assumes a string primary key.** The base
  class fills in `id` from an `IdGenerator` (Snowflake by default) only
  when the table has an `id` column and it wasn't supplied — this assumes
  that column is a string/text type. For an integer `AUTOINCREMENT`
  primary key, pass `id` explicitly (or don't rely on `create`'s
  auto-generation).
- **MySQL's `create`/`update`/`upsert`/`delete` are not atomic with their
  read-back.** MySQL has no `RETURNING` clause, so `MySqlModel` re-`SELECT`s
  by the already-known primary key after the write. Under concurrent writes
  to the same row, the value returned can reflect a subsequent state rather
  than the value actually written; running inside `with(tx)` mitigates this
  within that transaction's isolation level but doesn't fully close the gap.
  SQLite and Postgres don't have this caveat (both support `RETURNING`).
- **`rowsAffectedFrom` only understands the mysql2 driver by default.**
  `updateWhere`/`updateLocked`/`delete` read the affected-row count from
  `update()`/`delete()`'s execution result through the protected
  `rowsAffectedFrom` hook. The default implementation reads mysql2's
  `[ResultSetHeader, FieldPacket[]]` shape (`affectedRows`); on any other
  driver it throws with a message telling you to override it, instead of
  silently returning `0`. A driver like PlanetScale
  (`drizzle-orm/planetscale-serverless`) returns a different shape —
  `@planetscale/database`'s `ExecutedQuery`, whose row count lives on
  `rowsAffected` — so a `PlanetScaleModel` base class would override the hook
  once for every subclass to use:

  ```ts
  import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
  import type {
    PlanetScalePreparedQueryHKT,
    PlanetscaleQueryResultHKT,
  } from "drizzle-orm/planetscale-serverless";
  import { MySqlModel } from "@tknf/oven/model";

  abstract class PlanetScaleModel<
    TTable extends MySqlTable,
    TPk extends MySqlColumn,
    TSchema extends Record<string, unknown> = Record<string, never>,
  > extends MySqlModel<TTable, TPk, PlanetscaleQueryResultHKT, PlanetScalePreparedQueryHKT, TSchema> {
    protected override rowsAffectedFrom(result: unknown): number {
      if (
        typeof result === "object" &&
        result !== null &&
        "rowsAffected" in result &&
        typeof result.rowsAffected === "number"
      ) {
        return result.rowsAffected;
      }
      throw new Error("PlanetScaleModel#rowsAffectedFrom: unexpected execution result shape.");
    }
  }
  ```

  For a driver other than mysql2/PlanetScale, check that driver's own
  types/docs for the equivalent field before writing the override — don't
  assume the shape.

## See also

- [Concepts](./concepts.md) — why oven has one idiom per stateful concept
  (`Model` is one instance of the same class-based pattern as
  `RouteHandler`), and the backend-agnostic design principle.
- [Forms](./forms.md) — where input validation belongs; models trust
  already-normalized input.
