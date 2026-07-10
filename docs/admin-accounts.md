# Admin accounts

## What / Why

`@tknf/oven/admin` ships operator accounts for the admin panel: a users
table you add to your own Drizzle schema (via a per-dialect schema
factory and column contract) plus a service class —
`SQLiteAdminAccounts`, `PgAdminAccounts`, and `MySqlAdminAccounts` —
each parallel-implementing the same contract (method vocabulary, column
contract, and algorithm) for its dialect, with no shared abstract base
(the same reasoning as `SQLiteModel`/`PgModel`/`MySqlModel` in
[Models](./models.md)). The service handles password hashing and
verification (PBKDF2-HMAC-SHA256 — the same `hashPassword`/
`verifyPassword` as `@tknf/oven/auth`), authentication with an
account-enumeration defense, `isActive`/`isSuperuser` flags, and a
stored permission set (a JSON string array in a TEXT column) with a
small permission-string vocabulary (`resourcePermission` and friends).
Everything here is imported from `@tknf/oven/admin`.

These are **admin-panel operator accounts, not your app's end-user
accounts**. The people who log into `/admin` are a handful of staff
operators; your application's own users keep their own table and
authenticate through the `@tknf/oven/auth` primitives (`Guard`,
`hashPassword`/`verifyPassword`, tokens) as described in
[Authentication](./auth.md).

The stored permission set is data, not enforcement: `AdminPanel` does
not check these permissions itself. Granting is `setUserPermissions`,
reading is `userPermissions`, and checking is your own code — see
[Grant and check permissions](#grant-and-check-permissions). A parallel
trio of group services — `SQLiteAdminGroups`, `PgAdminGroups`, and
`MySqlAdminGroups` — adds named permission groups over two more tables;
see [Group your operators](#group-your-operators).

## Minimal example

Add the table to your app's Drizzle schema. The factory only returns a
schema definition — generate and apply the actual migration with your
app's own drizzle-kit setup (oven never generates migrations for you):

```ts
// src/db/schema.ts
import { sqliteAdminUsersTable } from "@tknf/oven/admin";

export const adminUsers = sqliteAdminUsersTable(); // default table name: "admin_users"
```

Construct the service from your Drizzle `db` and the table:

```ts
// src/lib/admin_accounts.ts
import { SQLiteAdminAccounts } from "@tknf/oven/admin";
import { adminUsers } from "../db/schema.js";
import { db } from "./db.js";

export const accounts = new SQLiteAdminAccounts(db, adminUsers);
```

Create the first operator from a seed script that reads credentials
from environment variables — never hardcode credentials:

```ts
// scripts/seed_admin.ts
import { accounts } from "../src/lib/admin_accounts.js";

const username = process.env.OVEN_ADMIN_USERNAME;
const password = process.env.OVEN_ADMIN_PASSWORD;
if (!username || !password) {
  throw new Error("Set OVEN_ADMIN_USERNAME and OVEN_ADMIN_PASSWORD");
}
if (!(await accounts.findByUsername(username))) {
  await accounts.createUser({ username, password, isSuperuser: true });
}
```

Then back the panel's built-in login screens
([Admin panel](./admin.md#wiring-built-in-loginlogout)) with
`accounts.authenticate`:

```ts
new AdminPanel({
  authorize: () => true, // every logged-in operator is allowed; see "Grant and check permissions"
  session: sessionAccessor.use,
  csrf,
  auth: {
    authenticate: async (_c, credentials) => {
      const user = await accounts.authenticate(credentials);
      return user ? { id: user.id, label: user.label ?? user.username } : null;
    },
  },
});
```

`authenticate` returns the user row on success and `null` on any
failure (unknown username, wrong password, inactive account, oversized
input) — exactly the shape the panel's `auth.authenticate` callback
wants to map into an `AdminIdentity`.

## Common tasks

### Extend the users table with your own columns

Spread `sqliteAdminUserColumns()` into your own `sqliteTable` and keep
the UNIQUE index on `username` — uniqueness (and `createUser`'s
duplicate handling) depends on it:

```ts
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { SQLiteAdminAccounts, sqliteAdminUserColumns } from "@tknf/oven/admin";

export const adminOperators = sqliteTable(
  "admin_operators",
  {
    ...sqliteAdminUserColumns(),
    email: text("email").notNull(),
  },
  (t) => [uniqueIndex("admin_operators_username_idx").on(t.username)],
);

export const accounts = new SQLiteAdminAccounts(db, adminOperators);
```

The service is generic over the concrete table, so extra NOT NULL
columns become required on `createUser` (and optional on `updateUser`)
and show up typed on returned rows:

```ts
await accounts.createUser({ username: "ops", password, email: "ops@example.com" });
```

Reserved columns (`passwordHash`, `permissions`, `id`, timestamps, ...)
are excluded from the extra-column input and stripped at runtime, so
they can never be smuggled through the extension mechanism.

### Grant and check permissions

A permission is a plain string. Resource permissions follow
`resource.<resourceKey>.<action>` with the four actions
`view`/`create`/`update`/`delete` (`ADMIN_PERMISSION_ACTIONS`), built by
`resourcePermission(resourceKey, action)` — or all four at once with
`resourcePermissions(resourceKey)`. A small built-in set covers the
non-resource screens: `jobs.view`, `jobs.manage`, `settings.view`,
`settings.manage`, `audit.view`. Strings are compared by literal set
membership only, never parsed at check time:

```ts
import { resourcePermission, resourcePermissions } from "@tknf/oven/admin";

await accounts.setUserPermissions(user.id, [
  ...resourcePermissions("books"), // resource.books.view/create/update/delete
  "audit.view",
]);
const granted = await accounts.userPermissions(user.id); // string[]
```

`setUserPermissions` replaces the whole set in a single UPDATE. The
panel does not enforce these permissions itself — check them in your
own `authorize` callback. Store the operator id under your own session
key during `authenticate` (the session survives the login-time id
reissue) and read it back in `authorize`:

```ts
new AdminPanel({
  auth: {
    authenticate: async (c, credentials) => {
      const user = await accounts.authenticate(credentials);
      if (!user) return null;
      sessionAccessor.use(c).set("adminUserId", user.id);
      return { id: user.id, label: user.label ?? user.username };
    },
  },
  authorize: async (c) => {
    const userId = sessionAccessor.use(c).get("adminUserId");
    if (typeof userId !== "string") return false;
    const user = await accounts.retrieve(userId);
    if (!user || !user.isActive) return false;
    if (user.isSuperuser) return true; // the superuser bypass is your code, not the vocabulary's
    const granted = await accounts.userPermissions(userId);
    return granted.includes(resourcePermission("books", "view"));
  },
  session: sessionAccessor.use,
  csrf,
});
```

### Group your operators

`SQLiteAdminGroups` (and `PgAdminGroups`/`MySqlAdminGroups`) adds named
permission groups over two more tables from per-dialect factories — a
groups table and a membership table, both required by the constructor:

```ts
import {
  SQLiteAdminGroups,
  sqliteAdminGroupsTable,
  sqliteAdminUserGroupsTable,
} from "@tknf/oven/admin";

// src/db/schema.ts
export const adminGroups = sqliteAdminGroupsTable(); // default table name: "admin_groups"
export const adminUserGroups = sqliteAdminUserGroupsTable(); // default table name: "admin_user_groups"

// src/lib/admin_groups.ts
export const groups = new SQLiteAdminGroups(db, {
  groups: adminGroups,
  userGroups: adminUserGroups,
});
```

Create a group with a permission set, then assign it. `setUserGroups`
*replaces* the user's memberships (an empty array removes them all):

```ts
const editors = await groups.createGroup({
  name: "Editors",
  permissions: resourcePermissions("books"),
});
await groups.setUserGroups(user.id, [editors.id]);
```

`permissionsForUser` resolves the union of every group's permission set
for one user. As with user permissions, nothing is enforced for you —
union it with the user's own set inside your `authorize` callback (the
superuser bypass stays your code too, as in
[Grant and check permissions](#grant-and-check-permissions)):

```ts
authorize: async (c) => {
  const userId = sessionAccessor.use(c).get("adminUserId");
  if (typeof userId !== "string") return false;
  const user = await accounts.retrieve(userId);
  if (!user || !user.isActive) return false;
  if (user.isSuperuser) return true;
  const granted = new Set([
    ...(await accounts.userPermissions(userId)),
    ...(await groups.permissionsForUser(userId)),
  ]);
  return granted.has(resourcePermission("books", "view"));
},
```

Group management mirrors the accounts service: `retrieve`/`findByName`/
`listGroups` read (names are matched after trimming),
`updateGroup(id, { name })` renames, `setGroupPermissions`/
`groupPermissions` replace and read one group's set, `groupMembers`
lists a group's member user ids, and `deleteGroup` removes the group
along with its membership rows.

### Manage users programmatically

```ts
await accounts.updateUser(user.id, { label: "Night shift" }); // profile fields only
await accounts.setPassword(user.id, newPassword); // re-validates length, then hashes
await accounts.updateUser(user.id, { isActive: false }); // deactivate: blocks the next login
const rows = await accounts.listUsers({ query: "ops", limit: 20, offset: 0 });
const total = await accounts.count("ops");
```

`updateUser` accepts profile fields only (`username`, `label`,
`isActive`, `isSuperuser`, plus your extra columns) — `passwordHash`,
`permissions`, `id`, and timestamps can never pass through it; the
dedicated methods own those. `listUsers`/`count` match `query` against
`username` OR `label` with a wildcard-escaped `LIKE`. `deleteUser(id)`
removes a row, and `countActiveSuperusers()` tells you whether you are
about to deactivate, demote, or delete the last active superuser —
check it first.

### Use Postgres or MySQL

Same vocabulary, per-dialect classes and factories:

```ts
import { PgAdminAccounts, pgAdminUsersTable } from "@tknf/oven/admin";

export const adminUsers = pgAdminUsersTable();
export const accounts = new PgAdminAccounts(db, adminUsers);
```

```ts
import { MySqlAdminAccounts, mysqlAdminUsersTable } from "@tknf/oven/admin";

export const adminUsers = mysqlAdminUsersTable();
export const accounts = new MySqlAdminAccounts(db, adminUsers);
```

MySQL specifics you will see in the generated migration: `username` is
`varchar(255)` rather than TEXT (MySQL cannot put a UNIQUE index on a
TEXT column without a key-length prefix), and the `permissions` TEXT
column has no DEFAULT clause (MySQL TEXT columns cannot have one). The
service always writes `permissions` explicitly, so this only matters if
you insert rows outside the service — supply `permissions` yourself
then.

## Gotchas / Security notes

- **Migrations are your app's responsibility.** The `*AdminUsersTable`
  factories only return a schema definition — generate the actual
  migration with your app's own drizzle-kit setup (oven never generates
  migrations for you).
- **Usernames are normalized (trimmed + lowercased) at the service
  boundary** in `createUser`/`findByUsername`/`authenticate`/
  `updateUser`. Default MySQL collations compare strings
  case-insensitively while SQLite and Postgres do not; without
  normalization the same pair of usernames could collide on one dialect
  and coexist on another. Normalizing before every write and lookup
  makes uniqueness and login behave identically across dialects.
- **Password length is bounded on both sides.** The minimum is 8
  (configurable via `minPasswordLength`); the maximum is a fixed 1024.
  `createUser`/`setPassword` throw outside the range, and
  `authenticate` rejects an oversized password up front — before any
  user lookup or hashing — so unauthenticated input cannot burn PBKDF2
  preprocessing CPU.
- **`authenticate` is enumeration-safe.** When no user matches, it
  still runs `verifyPassword` against a fixed dummy hash so PBKDF2
  always does the same work; when the user exists, the hash is verified
  *before* the `isActive` check, so an inactive account costs the same
  as an active one. Every failure returns the same `null`.
- **Do not raise the `iterations` option if the app runs on Cloudflare
  Workers.** workerd's `crypto.subtle` rejects PBKDF2 above 100,000
  iterations, and `verifyPassword` maps that error to `false` — so a
  hash stored with a higher count makes every login fail silently, as
  if the password were wrong. Same constraint as `hashPassword`'s
  default in [Authentication](./auth.md); raise it only when running
  exclusively on a runtime like Node.
- **Never register the admin users table as a regular `AdminResource`.**
  The list/show/form screens render the columns you give them —
  including `passwordHash` — and form-based writes would bypass the
  service's normalization and validation.
- **Rate-limit `authenticate`.** The service bounds cost per attempt
  but does not count attempts — put `RateLimiter`
  (`@tknf/oven/security`) in front of it:

  ```ts
  const limiter = new RateLimiter(kvStore);

  authenticate: async (_c, credentials) => {
    if (!(await limiter.consume(`admin-login:${credentials.username}`, 5, 300))) return null;
    const user = await accounts.authenticate(credentials);
    return user ? { id: user.id, label: user.label ?? user.username } : null;
  },
  ```

  `consume(key, limit, windowSeconds)` increments the counter and
  returns `true` while under `limit`; once at the limit it returns
  `false` without counting, and here that maps to the same `null` as a
  failed login. This allows 5 attempts per username per 5 minutes.
- **Deactivation and password changes do not end existing sessions.**
  `isActive: false` blocks the next login, but with the minimal wiring
  above an already-logged-in session stays valid until it expires, and
  `setPassword` does not invalidate existing sessions either. If access
  must be cut immediately, re-read the row per request in `authorize`
  and check `isActive` there (the permission-check example above does
  exactly that).
- **The duplicate-username pre-check is advisory.** `createUser`/
  `updateUser` pre-check with `findByUsername` and throw a clear
  "already taken" error, but the table's UNIQUE index is the
  authoritative guard — a concurrent insert racing past the pre-check
  surfaces as a raw driver error instead. The same applies to
  `createGroup`/`updateGroup` and the group name's UNIQUE index.
- **Membership replacement is two statements.** `setUserGroups` deletes
  all of the user's membership rows, then inserts the new set — there is
  no cross-table transaction. The order is deliberately fail-closed: a
  failure between the two statements leaves the user with *fewer* groups,
  never stale extras. Re-run `setUserGroups` on error.
- **Group names are NOT lowercased — only trimmed.** Unlike usernames, a
  group name is a display label, so case is preserved: "Editors" and
  "editors" are distinct groups on SQLite and Postgres. On MySQL's
  default case-insensitive collations they collide instead (in both the
  pre-check and the UNIQUE index).
- **Deleting a user does not remove its membership rows.** The
  membership table has no foreign keys, and the accounts and groups
  services do not know about each other — call
  `groups.setUserGroups(userId, [])` before or after
  `accounts.deleteUser(userId)`. Leftover rows are ignored by
  `userGroups`/`permissionsForUser` (inner join) but keep showing up in
  `groupMembers` until cleaned up.

## See also

- [Admin panel](./admin.md) — the `auth`/`session`/`authorize` options
  these accounts plug into, and the built-in login/logout screens.
- [Authentication](./auth.md) — `hashPassword`/`verifyPassword` (the
  primitives used here) and auth for your app's own end users.
- [Models](./models.md) — the same per-dialect parallel-implementation
  convention (`SQLiteModel`/`PgModel`/`MySqlModel`) used here.
- [Database](./database.md) — wiring the Drizzle `db` connection the
  service is constructed with.
