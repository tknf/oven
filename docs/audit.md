# Audit Log

## What / Why

`@tknf/oven/audit` is an append-only audit log recorder backed directly
by a Drizzle table — `SQLiteAuditLog`, `PgAuditLog`, and `MySqlAuditLog`
each parallel-implement the same contract (record/list, column names, and
algorithm) for their dialect, with no shared abstract base, because
Drizzle's per-dialect types aren't compatible enough to unify (the same
reasoning as `SQLiteModel`/`PgModel`/`MySqlModel` in
[Models](./models.md)). Every entry records who (`actor`) did what
(`action`) to what (`target`), with an optional `changes` payload —
enough to answer "who changed this and when" without standing up a
separate logging service.

Recording is never automatic: there's no hook wired into model saves or
route handlers. Calling `record()` is always an explicit line in your own
code, so an audit trail only exists where you deliberately put one.

The `AdminPanel`'s built-in audit log viewer is a separate concern — see
[Admin panel](./admin.md#adding-job-operations-settings-and-audit-log-sections)
for wiring an `AuditLog` into it. This guide covers using an `AuditLog`
on its own, outside the admin panel.

## Minimal example

```ts
// src/lib/audit.ts
import { SQLiteAuditLog, sqliteAuditsTable } from "@tknf/oven/audit";
import { db } from "./db.js";

export const audits = sqliteAuditsTable(); // default table name: "audits"
export const auditLog = new SQLiteAuditLog(db, audits);
```

```ts
// inside a handler
await auditLog.record({
  actor: userId,
  action: "user.update",
  target: targetUserId,
  changes: { name: { from: "Alice", to: "Alicia" } },
});
```

## Common tasks

**Wiring the `audits` table and constructing an `AuditLog`.** Each
backend has its own table factory (`sqliteAuditsTable`/`pgAuditsTable`/
`mysqlAuditsTable`) returning a Drizzle table that satisfies the
corresponding `*AuditRecordTable` contract (`id`, `actor`, `action`,
`target`, `changes`, `createdAt`). Pass a different table name if
`"audits"` collides with an existing table:

```ts
import { PgAuditLog, pgAuditsTable } from "@tknf/oven/audit";

export const audits = pgAuditsTable("admin_audits");
export const auditLog = new PgAuditLog(db, audits);
```

**Recording an action.** `record()` takes an `actor`/`action`/`target`
triple and an optional `changes` value (any JSON-serializable value; it's
`JSON.stringify`-ed before storage, and stored as `null` when omitted).
`id` and `createdAt` are filled in automatically (`id` via
`SnowflakeIdGenerator` by default, `createdAt` as the current epoch ms):

```ts
await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-2" });
```

**Listing entries with filters and pagination.** `list()` takes an
optional `actor`/`action`/`target`/`limit` (each `*AuditLogListOptions`);
only the fields you pass are ANDed together, and results come back newest
first (ordered by `createdAt` descending, `id` descending as a
tiebreaker), capped at `limit` (default 100):

```ts
const rows = await auditLog.list({ actor: "user-1", action: "user.update", limit: 20 });
```

## Gotchas / Security notes

- **Migrations are your app's responsibility.** The `*AuditsTable`
  factories only return a schema definition — generate the actual
  migration with your app's own drizzle-kit setup (oven never generates
  migrations for you).
- **Resolving `actor` is up to the caller.** `record()` takes `actor` as
  a plain string; deriving it from the authenticated user (e.g.
  `accountGuard.use(c).email`) happens at the call site, not inside
  `AuditLog`.
- **No update/delete API is provided, by design.** This is an
  append-only recording layer; correcting a bad entry means recording a
  new one, not mutating history.
- **The three backends are independent parallel implementations, not a
  shared class.** `SQLiteAuditLog`/`PgAuditLog`/`MySqlAuditLog` expose the
  same method vocabulary (`record`/`list`) and column contract, but there
  is no common base class or interface to program against — pick the one
  matching your database and construct it directly.
- **`changes` is stored as an opaque JSON string**, not queryable
  structured data. Don't rely on filtering `list()` by contents of
  `changes` — only `actor`/`action`/`target` are indexed query
  parameters.

## See also

- [Admin panel](./admin.md) — wiring an `AuditLog` into the built-in
  audit log viewer and automatic recording of job/flag/maintenance
  toggles.
- [Models](./models.md) — the same per-dialect parallel-implementation
  convention (`SQLiteModel`/`PgModel`/`MySqlModel`) used here.
- [Database](./database.md) — wiring the Drizzle `db` connection that
  `AuditLog` is constructed with.
