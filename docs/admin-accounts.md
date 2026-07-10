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

Bootstrap the first superuser from a seed script that runs on startup (or as
a one-off migration step) and reads credentials from environment variables —
never hardcode credentials. Gate it on `countActiveSuperusers()` rather than a
specific username, so the seed is idempotent (safe to run on every boot) and
keeps working even after that first account is renamed or replaced:

```ts
// scripts/seed_admin.ts
import { accounts } from "../src/lib/admin_accounts.js";

const username = process.env.OVEN_ADMIN_USERNAME;
const password = process.env.OVEN_ADMIN_PASSWORD;
if (!username || !password) {
  throw new Error("Set OVEN_ADMIN_USERNAME and OVEN_ADMIN_PASSWORD");
}
if ((await accounts.countActiveSuperusers()) === 0) {
  await accounts.createUser({ username, password, isSuperuser: true });
}
```

That covers only the very first operator. Once the panel is reachable, create
every operator after that (and any group) from the panel's own UI instead of
scripting more seeds — see
[Manage operators from the panel](#manage-operators-from-the-panel).

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

This recipe checks permissions by hand inside your own `authorize`
callback — useful when you don't hand enforcement to `AdminPanel` via the
`accounts` option (see
[Let the panel enforce permissions](#let-the-panel-enforce-permissions)
below), or when you check permissions somewhere other than the panel
entirely.

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

### Let the panel enforce permissions

Rather than checking `userPermissions`/`permissionsForUser` by hand inside
`authorize` ([Grant and check permissions](#grant-and-check-permissions)),
pass the services straight to `AdminPanel`'s `accounts` option and let the
panel derive the login screens and enforce permissions itself:

```ts
new AdminPanel({
  session: sessionAccessor.use,
  csrf,
  accounts: { users: accounts, groups }, // `groups` is optional
  resources: [new PublisherResource()],
  jobs: { console: jobsConsole },
  settings: { featureFlags: { flags: featureFlags, names: ["beta"] } },
  audit: { log: auditLog },
});
```

No `authorize` and no `auth` needed: the built-in login/logout screens are
derived from `accounts.users.authenticate`, and every route resolves to a
required permission checked against the union of the operator's own
`userPermissions` and (when `groups` is injected) every group's
`permissionsForUser`. The operator row is re-read on **every request** (not
cached in the session), so `updateUser(id, { isActive: false })` or
`deleteUser(id)` revokes access on the very next request. A superuser
(`isSuperuser: true`) bypasses every check.

The route-to-permission mapping:

| Route | Permission required |
| --- | --- |
| `GET /` (dashboard) | none — any active operator |
| `GET /resources/:key`, `GET /resources/:key/:id` | `resource.<key>.view` |
| `GET /resources/:key/new` | `resource.<key>.create` |
| `GET /resources/:key/:id/edit`, `POST /resources/:key/:id` | `resource.<key>.update` |
| `GET`/`POST /resources/:key/:id/delete` | `resource.<key>.delete` |
| `POST /resources/:key` | `resource.<key>.create`, or `.delete` when the submitted `action` is `"delete"` (the list screen's bulk-delete form posts here too) |
| `GET /jobs` | `jobs.view` |
| `POST /jobs/:id/retry`, `POST /jobs/:id/delete` | `jobs.manage` |
| `GET /settings` | `settings.view` |
| `POST /settings/flags/:name`, `POST /settings/maintenance` | `settings.manage` |
| `GET /audit` | `audit.view` |
| `/accounts/*` | superuser only — no granted permission string reaches it |

The nav links and the dashboard's resource list are filtered to match:
a non-superuser only sees the sections and resources their granted set
actually lets them open (so a link never leads to a 403), and the
Accounts nav link only ever renders for a superuser.

A permission check that fails responds with `denyStatus` (default `403`).
Passing an explicit `authorize` alongside `accounts` still runs it, in
addition to this gate (both must allow); passing `auth` alongside
`accounts` overrides the derived login (an escape hatch for e.g. wrapping
the credential check in rate limiting), but its `authenticate` must then
resolve to an identity whose `id` is one of `accounts.users`'s own user
ids, since re-validation on every request looks the row up by that id.
`session` and `csrf` are both required once `accounts` is injected — the
constructor throws otherwise. See
[Handing enforcement to the panel](./admin.md#handing-enforcement-to-the-panel-accounts)
for the full option reference.

### Manage operators from the panel

Once `accounts.users` is wired in as above, a superuser-only screen at
`/accounts/users` (and `/accounts/groups` too, once `accounts.groups` is
also injected) lets an operator create, edit, and delete other operators
without you writing any of this by hand. Reach for
[Manage users programmatically](#manage-users-programmatically) instead
when you need to script account changes (seeding, a migration, an
internal tool) outside the panel's own UI.

The screen covers:

- **Users** (`/accounts/users`): a searchable (`?q=`), paginated (`?p=`)
  list; a create form (username, password, label, active, superuser,
  permissions, and — when `accounts.groups` is injected — group
  membership); an edit form for the same fields (password changes through
  a separate form); and a delete confirmation.
- **Groups** (`/accounts/groups`, requires `accounts.groups`): list,
  create, edit, and delete for the groups themselves (name and permission
  set) — distinct from the group-membership checkboxes on the user form.
- **The permission checkboxes only ever offer a known set**:
  `ADMIN_BUILTIN_PERMISSIONS` (the five built-ins, exported from
  `@tknf/oven/admin`) plus `resource.<key>.<action>` for every wired
  resource. Saving a form writes checked-known permissions **union**
  whatever unrecognized permission strings the row already had — a
  permission granted some other way (an older app version, a script) is
  preserved rather than silently dropped just because this screen doesn't
  recognize it.
- **The last active superuser is protected.** Deactivating, demoting, or
  deleting the last remaining active superuser (`isSuperuser && isActive`)
  is refused with an error, so the panel can never lock every operator out
  of itself. The panel gets this by always passing
  `{ protectLastActiveSuperuser: true }` to `updateUser`/`deleteUser` — see
  [Manage users programmatically](#manage-users-programmatically) for how
  to get the same protection outside the panel.
- **Every write is audited** (once `audit` is also injected):
  `accounts.user.create`/`.update`/`.delete`/`.setPassword` and
  `accounts.group.create`/`.update`/`.delete`. The password itself is
  never recorded — `setPassword`'s audit entry carries no `changes`
  payload at all.

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
removes a row, and `countActiveSuperusers()` tells you how many active
superusers currently exist.

Pass `{ protectLastActiveSuperuser: true }` as the last argument to
`updateUser`/`deleteUser` to get the same protection the panel itself
uses: a patch or delete that would deactivate, demote, or remove the
only remaining active superuser is rejected with `LastActiveSuperuserError`
(exported from `@tknf/oven/admin`) instead of applied. This is enforced
as a single conditional write in the dialect service, not a separate
read-then-write check, so it holds up even under concurrent requests.

```ts
import { LastActiveSuperuserError } from "@tknf/oven/admin";

try {
  await accounts.updateUser(user.id, { isActive: false }, { protectLastActiveSuperuser: true });
} catch (err) {
  if (err instanceof LastActiveSuperuserError) {
    // refused: this would have left zero active superusers
  }
}
```

Omit the options argument (or pass `protectLastActiveSuperuser: false`)
to get the unguarded behavior — the call always applies, exactly as
before.

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
- **Rate-limit the built-in login.** The service bounds cost per attempt
  but does not count attempts — pass `rateLimiter` (a `RateLimiter` from
  `@tknf/oven/security`) straight to `AdminPanel` instead of wrapping
  `authenticate` by hand. It is applied to `POST /login` **before**
  `auth.authenticate` runs, keyed by the submitted username
  (`` `admin-login:${username}` ``), so a request over the limit never
  reaches the credential check at all:

  ```ts
  import { RateLimiter } from "@tknf/oven/security";

  new AdminPanel({
    // ...
    auth: {
      authenticate: async (_c, credentials) => {
        const user = await accounts.authenticate(credentials);
        return user ? { id: user.id, label: user.label ?? user.username } : null;
      },
    },
    rateLimiter: new RateLimiter(kvStore),
  });
  ```

  This allows 5 attempts per username per 5 minutes. A rejected attempt
  re-renders the login screen with a generic "too many attempts" message
  and `429` (rather than the `401` an invalid credential gets), and a
  successful login resets the counter, so an operator who mistypes their
  password once and then logs in correctly is not penalized on their next
  attempt. Omitting `rateLimiter` while login is wired (`auth`/`accounts`)
  logs a one-time `console.warn` at construction — the panel still starts,
  but `/login` is unprotected against brute-forcing until you wire it.

  If you need a different limit/window, fold rate limiting into
  `auth.authenticate` by hand instead:

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
  failed login (a plain `401`, not the built-in gate's dedicated `429`).
- **With `accounts` injected, both deactivation and a password change end
  every outstanding session on its very next request** — no extra wiring
  needed. Deactivation works through the per-request re-validation
  described in
  [Let the panel enforce permissions](#let-the-panel-enforce-permissions):
  `isActive: false` fails the row re-read on the very next request. A
  password change works through a `passwordStamp`: at login, `AdminPanel`
  derives a short fingerprint of the row's `passwordHash` and stores it
  alongside the identity in the session; every later request re-derives
  the fingerprint from the row's *current* `passwordHash` and rejects the
  session on a mismatch. Because `setPassword` always produces a
  different hash (PBKDF2 with a fresh random salt), any password change —
  through [the panel's own accounts screen](#manage-operators-from-the-panel)
  or a script calling `setPassword` directly — signs out every session
  logged in under the old password, including the one that made the
  change. **A session with no stamp at all (issued by an app that hasn't
  upgraded to this behavior yet) is treated the same as a mismatch and
  rejected**, so upgrading asks every currently-logged-in operator to log
  back in once; after that they stay logged in as usual until they change
  their password again.
- **This protection is scoped to the `accounts` option.** Wiring your own
  `authorize`/`auth` instead — the [minimal example](#minimal-example)
  above, or checking `userPermissions` by hand inside `authorize` — gets
  neither the per-request re-validation nor `passwordStamp`: a session
  issued before a deactivation or a password change stays valid until it
  expires or your own `authorize` rejects it. If you need the same
  guarantee without `accounts` (e.g. your own end-user auth from
  [Authentication](./auth.md)), re-read the current row from inside your
  `authorize`/middleware on every request and build a similar fingerprint
  yourself (a hash of the stored password hash, compared to one saved in
  the session at login) — `accounts` has no monopoly on the technique, it
  just does it for you.
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
- **Last-active-superuser protection is opt-in on `updateUser`/`deleteUser`,
  unknown-permission preservation lives only in the panel.** The service
  guards against locking every operator out only when you pass
  `{ protectLastActiveSuperuser: true }` (see
  [Manage users programmatically](#manage-users-programmatically)); the
  panel always passes it, so calling `accounts.updateUser`/`deleteUser`
  without that option bypasses the guard. It is enforced as a single
  conditional `UPDATE`/`DELETE` in the dialect service, not a
  check-then-act read, so it holds even under concurrent requests.
  Unknown-permission preservation (retaining a permission string the
  panel's checkboxes don't recognize) is a UI-level concern with no
  service equivalent — calling `accounts.setUserPermissions` directly
  overwrites the stored set outright, so reimplement that merge yourself
  if you manage permissions programmatically instead of through
  [Manage operators from the panel](#manage-operators-from-the-panel).

## See also

- [Admin panel](./admin.md) — the `auth`/`session`/`authorize` options
  these accounts plug into, and the built-in login/logout screens.
- [Authentication](./auth.md) — `hashPassword`/`verifyPassword` (the
  primitives used here) and auth for your app's own end users.
- [Models](./models.md) — the same per-dialect parallel-implementation
  convention (`SQLiteModel`/`PgModel`/`MySqlModel`) used here.
- [Database](./database.md) — wiring the Drizzle `db` connection the
  service is constructed with.
