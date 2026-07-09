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

## See also

- [Concepts](./concepts.md) — why oven has one idiom per stateful concept
  (`Model` is one instance of the same class-based pattern as
  `RouteHandler`), and the backend-agnostic design principle.
- [Forms](./forms.md) — where input validation belongs; models trust
  already-normalized input.
