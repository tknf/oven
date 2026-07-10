# Admin panel

## What / Why

`@tknf/oven/admin` is a unified admin panel in oven's explicit-registration
style: you mount it once, and each of its sections (resource CRUD, job
operations, settings, audit log) only renders and gets routes when you
inject the corresponding config. Nothing is auto-discovered.

`AdminPanel` is a `RouteHandler` subclass, mounted like any other handler
via `app.route("/admin", new AdminPanel({...}))`. It deliberately has no
built-in notion of "who's an admin" — authorization is a required
`authorize` callback you write yourself, typically by reusing your
existing `Guard`/`Policy` (see [Auth](./auth.md)). There's no client-side
JavaScript: every write action is a native `<form method="post">` plus a
303 redirect, and the panel's CSS is inlined server-side.

`AdminResource` is the abstract base class for one resource's CRUD screen
(one Drizzle table + one `Model`): you implement `key`/`label`/`model`/
`table`/`primaryKey`, and optionally `form()` to make it writable.

## Minimal example

```ts
// src/main.ts
import { Hono } from "hono";
import { AdminPanel } from "@tknf/oven/admin";
import { accountGuard } from "./lib/auth.js";

const app = new Hono();

app.route(
  "/admin",
  new AdminPanel({
    authorize: (c) => accountGuard.use(c).role === "admin",
  }),
);
```

With only `authorize` supplied, the panel renders a dashboard at
`GET /admin` and nothing else — every other section below is opt-in. The
dashboard shows a welcome message until you inject `resources`; once you
do, it becomes a module list of every registered resource (with `Add`/
`Change` links) instead. Every screen renders a left-hand sidebar
(`#nav-sidebar`, a vertical link list built from the same `authorize`-gated
nav) rather than a horizontal header nav, so it stays a single scrollable
column regardless of how many resources you register — a header nav would
grow sideways and eventually overflow. Every screen except the dashboard
itself also renders a breadcrumb trail (e.g. `Home › Publisher › Add`)
below the header.

## Common tasks

### Adding a resource CRUD screen

Subclass `AdminResource` per table. `fieldsFromTable` derives sensible
`FieldDef`s (widget, required-ness, `<select>` options for enum columns,
etc.) from the Drizzle table's columns, so a simple form doesn't need to
restate them by hand:

```ts
// src/admin/publisher_resource.ts
import { z } from "zod";
import { AdminResource, fieldsFromTable } from "@tknf/oven/admin";
import { Form } from "@tknf/oven/form";
import type { FieldDef } from "@tknf/oven/form";
import { publishers } from "../db/schema.js";
import { publisherModel } from "../lib/models.js";

const publisherSchema = z.object({
  name: z.string().min(1),
  contactEmail: z.string().email(),
});

class PublisherForm extends Form<typeof publisherSchema> {
  protected schema() {
    return publisherSchema;
  }
  protected fields(): Record<string, FieldDef> {
    return fieldsFromTable(publishers);
  }
}

export class PublisherResource extends AdminResource {
  get key() {
    return "publishers";
  }
  get label() {
    return "Publishers";
  }
  get model() {
    return publisherModel;
  }
  get table() {
    return publishers;
  }
  get primaryKey() {
    return "id";
  }
  form() {
    return new PublisherForm();
  }
}
```

```ts
new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  resources: [new PublisherResource()],
});
```

Leaving `form()` unimplemented makes a resource view-only: no create/
edit/delete routes are registered for it (`AdminResource#canWrite()`
governs this). Override `listColumns()`/`exclude()` to control which
columns the list screen shows, and `searchColumns()` to enable a search
box (search terms are matched with an escaped `LIKE`, so `%`/`_` in user
input can't widen the match unexpectedly).

### Sorting and paging the list screen

The list screen is offset-based, numbered pagination over
`AdminModel#listPage` (`SQLiteModel`/`PgModel`/`MySqlModel` all implement
it) — not `Model#paginate`'s cursor pagination, which has no way to jump
to an arbitrary page. Every display column's header (`AdminResource#columns()`'s
order) is a sort link: clicking an unsorted column sorts it ascending;
clicking the active column toggles its direction. This is reflected in
two query parameters, matching a familiar admin-console convention:

- `?o=<i>` sorts the `i`-th display column ascending; `?o=-<i>` sorts it
  descending. An absent or out-of-range `o` falls back to primary key
  descending (newest first) — the list screen's previous default.
- `?p=<n>` selects the `n`-th page, 0-based. The page footer
  (`.paginator`) shows numbered links (eliding long runs down to the
  first 2, the last 2, and a window around the current page) plus the
  total row count.

Changing the sort or a filter always resets back to page 0; only the
paginator's own page links preserve the current sort/search/filters.



Deleting a row is a two-step flow: every `Delete` link (on the list,
show, and edit screens) navigates to a `GET
/resources/:key/:id/delete` confirmation screen that summarizes the
target row, rather than deleting immediately. The row is only removed
once that screen's `<form method="post">` — which embeds a hidden
`post=yes` field — is submitted; a `POST` to the same URL without
`post=yes` (e.g. one that skipped the confirmation screen) redirects
back to the list without deleting anything.

Every create/edit form renders three submit buttons — `Save`, `Save and
add another`, and `Save and continue editing` — matching the `_save`/
`_addanother`/`_continue` submit button names of a familiar admin-console
convention. Pressing `Save` (or posting without one of these three names,
kept for backward compatibility) redirects to the resource's list;
`Save and add another` redirects to the resource's own new-form URL; and
`Save and continue editing` redirects to the just-saved row's edit URL.

### Bulk deleting rows from the list screen

For a writable resource, the list screen also shows a row-selection
checkbox column and an actions bar (`<select name="action">` + a `Run`
button) above the result table, whenever at least one row is on the
current page. Selecting one or more rows, choosing "Delete selected
{label}", and pressing `Run` follows the same two-step confirmation
contract as a single-row delete: it first renders a confirmation screen
listing the selected rows, and only deletes them once that screen's
`<form method="post">` — embedding `post=yes`, `action=delete`, and one
hidden `_selected_action` per selected id — is submitted. Rows that no
longer exist by the time the confirmation is submitted are skipped
rather than causing an error. Read-only resources (no `form()`) show
neither the checkbox column nor the actions bar.

The list screen also always shows the total row count (matching the
current search/filter) near the pagination controls, for both writable
and read-only resources.

When `audit` is injected, a confirmed bulk delete records one
`resource.bulkDelete` audit entry (covering every id in the batch, not
one entry per row). When `session` is injected, a one-time success banner
("{count} {label} were deleted successfully.") appears on the next
screen, same as the single-row delete/create/update banners.

### Success messages after save

Inject `session` (any session accessor's `.use`, e.g. `SessionAccessor#use`
from `@tknf/oven/session`) to show a one-time success banner
("The {label} was added/changed successfully.") at the top of the next
screen after a resource create or update:

```ts
import { sessionAccessor } from "./lib/session.js";

new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  resources: [new PublisherResource()],
  session: sessionAccessor.use,
});
```

The banner is pushed to `session`'s flash storage (consume-once — it
disappears after being shown, even if the redirect target changes based
on which save button was pressed) and rendered as a `<ul class="messagelist">`
between the breadcrumb trail and the screen body. The same banner
("The {label} was deleted successfully.") appears after a confirmed
delete. Without `session` injected, no banner is ever shown (backward
compatible, same opt-in pattern as `csrf`/`audit`).

### Adding a filter sidebar to the list screen

Override `filters()` to declare one or more columns as filterable. Each
filter lists the exact values it offers via `options`; the sidebar
renders those values as links, and only a listed value is ever applied
to the query — an unrecognized value in the URL is silently ignored
rather than turned into an arbitrary `WHERE` clause:

```ts
export class PublisherResource extends AdminResource {
  // ...key/label/model/table/primaryKey/form as above

  filters() {
    return [
      {
        column: "status",
        label: "Status",
        options: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
        ],
      },
    ];
  }
}
```

The sidebar (`#changelist-filter`) only renders when `filters()` returns
at least one entry; resources that don't implement it keep the
single-column list layout. Selecting a filter combines with an active
search (`q`) via `AND` and resets pagination back to the first page.

### Adding a year/month/day drilldown to the list screen

Override `dateHierarchy()` to return the name of a date column, and the
list screen renders a year → month → day drilldown nav above the toolbar.
The column is assumed to hold an integer epoch-millisecond timestamp
(oven's usual convention, e.g. `createdAt: integer(...)`):

```ts
export class PublisherResource extends AdminResource {
  // ...key/label/model/table/primaryKey/form as above

  dateHierarchy() {
    return "createdAt";
  }
}
```

Selecting a year (`?dhy=`), then a month (`&dhm=`), then a day (`&dhd=`)
narrows the list to that period (combined with any active search/filter
via `AND`) and drills one level deeper each time, down to a day. Every
link preserves the current search query and active filters and resets
pagination back to the first page.

This is a simplified drilldown: the year/month/day lists enumerate every
period between the column's min and max value (found via two
`AdminModel#listPage` calls, not a new aggregation query), not only
periods that actually contain rows. Selecting an empty period is possible
and simply renders an empty list. A resource that doesn't implement
`dateHierarchy()` renders no drilldown nav, same opt-in pattern as
`filters()`.

### Editing child rows inline (tabular inlines)

Override `inlines()` to render a related child table as an editable,
fixed-row grid inside the parent's create/edit form — no JavaScript "add
another row" control. Each declared `AdminInline` needs the child's own
`Model`, table, primary/foreign key column names, and a `Form` (the same
kind of `Form` subclass a top-level resource uses):

```ts
import { AdminResource, fieldsFromTable } from "@tknf/oven/admin";
import type { AdminInline } from "@tknf/oven/admin";
import { Form } from "@tknf/oven/form";
import type { FieldDef } from "@tknf/oven/form";
import { books, publishers } from "../db/schema.js";
import { bookModel, publisherModel } from "../lib/models.js";

class BookForm extends Form<typeof bookSchema> {
  protected schema() {
    return bookSchema;
  }
  protected fields(): Record<string, FieldDef> {
    return fieldsFromTable(books, { omit: ["publisherId"] });
  }
}

export class PublisherResource extends AdminResource {
  // ...key/label/model/table/primaryKey/form as above

  inlines(): AdminInline[] {
    return [
      {
        key: "books",
        label: "Books",
        model: bookModel,
        table: books,
        primaryKey: "id",
        foreignKey: "publisherId",
        form: () => new BookForm(),
        extra: 2, // blank rows rendered in addition to existing children (default 3)
      },
    ];
  }
}
```

The edit form renders one bound row per existing child (via
`inline.model.listPage`, matched on `foreignKey`) plus `extra` blank rows;
the new form (no parent row yet) renders only blank rows. Each rendered
row's fields use the name prefix `${key}-${index}` (0-based), an existing
row additionally carries a hidden `${key}-${index}-__pk` (the child's
primary key) and a `${key}-${index}-__delete` checkbox, and the group as a
whole carries a hidden `${key}-__total` (the rendered row count). A
resource that doesn't implement `inlines()` renders no inline group, same
opt-in pattern as `filters()`.

Submitting the parent create/edit form also creates, updates, and deletes
child rows, one per rendered row:

- A row with a `${key}-${index}-__pk` and its `${key}-${index}-__delete`
  checked is **deleted** (`inline.model.delete`) — its own fields are not
  validated.
- A row with a `${key}-${index}-__pk` and its fields filled in is
  **updated** (`inline.model.update`) through the child `Form`.
- A row with no `${key}-${index}-__pk` but at least one non-empty field is
  **created** (`inline.model.create`), with `foreignKey` set to the
  parent's row id.
- A row with no `${key}-${index}-__pk` and every field left blank (an
  untouched extra row) is **skipped** entirely — it is not validated or
  created.

The parent form and every inline row are validated **before anything is
written**: if the parent or any row fails validation, the whole request
re-renders with `422` and nothing is written, parent or child. Once
everything validates, the parent is written first, then each inline row
in declaration order — **this sequence is not a single transaction**
(`AdminModel` has no cross-table transaction primitive), so a DB failure
partway through child writes can leave the parent and some children
committed while others are not.

### Wiring CSRF protection

Inject a `Csrf` instance (from `@tknf/oven/security`) so every write
route under `/admin` is verified, and every generated form embeds the
hidden token input automatically:

```ts
import { Csrf } from "@tknf/oven/security";
import { sessionAccessor } from "./lib/session.js";

const csrf = new Csrf({ session: sessionAccessor.use });

new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  csrf,
});
```

### Adding a user-tools block to the header

Authentication is outside admin's scope, so the header's user-tools block
(a greeting plus links such as "View site" or "Log out") is entirely
opt-in: inject `userTools` to build it from `Context`, or omit it to
render nothing:

```ts
new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  csrf,
  userTools: (c) => ({
    greeting: `Welcome, ${accountGuard.use(c).name}.`,
    links: [
      { label: "View site", href: "/" },
      { label: "Change password", href: "/account/password" },
      { label: "Log out", href: "/logout", method: "post" },
    ],
  }),
});
```

`greeting` is rendered as-is (admin does not prepend any wording of its
own), and each link renders as a plain `<a>` unless `method: "post"` is
set, in which case it renders as a `<form method="post">` with a submit
button — the shape a logout link needs, since logging out must not be a
plain `GET`. When `csrf` is also injected, every `method: "post"` link's
form automatically embeds the CSRF hidden input, same as every other
form in the panel.

### Wiring built-in login/logout

Admin does not assume the app's user table shape, so authentication is
split the same way as everything else it doesn't own: inject `auth` with
an `authenticate` callback that verifies credentials however the app's
own user table works, and admin provides the login/logout screens,
session wiring, and the redirect-when-not-logged-in gate on top of it.
`auth` requires `session` to also be injected (the constructor throws
otherwise — there is nowhere to hold the logged-in identity between
requests):

```ts
import { verifyPassword } from "@tknf/oven/auth";
import { sessionAccessor } from "./lib/session.js";
import { userModel } from "./lib/models.js";

new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  session: sessionAccessor.use,
  csrf,
  auth: {
    authenticate: async (c, { username, password }) => {
      const user = await userModel.findByUsername(username);
      if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
      return { id: user.id, label: user.name };
    },
  },
});
```

`authenticate` returns an `AdminIdentity` (`{ id, label? }`) on success or
`null` on failure; `verifyPassword` (from `@tknf/oven/auth`) is the same
constant-time PBKDF2 check `Guard`/`Policy` use elsewhere, but admin
doesn't require it — any check that resolves to an identity or `null`
works.

If you'd rather not maintain your own operator user table,
`@tknf/oven/admin` also ships an operator-accounts service
(`SQLiteAdminAccounts`/`PgAdminAccounts`/`MySqlAdminAccounts`, plus a
users-table schema factory) purpose-built to back `auth.authenticate` —
password hashing, an enumeration-safe `authenticate`, active/superuser
flags, and a stored permission set. See
[Admin accounts](./admin-accounts.md).

Once `auth` is injected:

- `GET`/`POST "/login"` and `POST "/logout"` are registered under the
  panel's mount base (e.g. `/admin/login`, `/admin/logout`).
- Any other request without a logged-in identity in the session is
  redirected to `/login?next=<original path>` (confined to the panel's
  own `basePath` — an unrecognized or external `next` falls back to
  `basePath` itself, an open-redirect guard). A logged-in request still
  goes through `authorize` as before (when `accounts` is also injected,
  it goes through the accounts permission gate too — both must allow), so
  `auth` narrows "is this operator who they say they are" while
  `authorize`/`accounts` decide "is this operator allowed in here".
- On successful login, the session id is reissued (`Session#regenerate`)
  before the identity is stored, as a defense against session-fixation.
- If `userTools` is not separately injected, the header's user-tools block
  defaults to a greeting built from the identity (`label` falling back to
  `id`) plus a working "Log out" link — so `auth` alone is enough to get a
  functioning login/logout flow without also wiring `userTools`. Injecting
  `userTools` explicitly still takes priority, same as always.

Without `auth` injected, there are no login/logout routes and no redirect
gate — every route is guarded by `authorize` alone, exactly as before
(backward compatible).

### Handing enforcement to the panel (`accounts`)

Wiring `auth` still leaves "who is allowed to do what" up to your own
`authorize` callback. Injecting `accounts` instead hands both login and
permission enforcement to the panel itself, built on top of the operator
accounts service described in [Admin accounts](./admin-accounts.md):

```ts
import { SQLiteAdminAccounts, SQLiteAdminGroups } from "@tknf/oven/admin";
import { adminGroups, adminUserGroups, adminUsers } from "./db/schema.js";
import { db } from "./lib/db.js";
import { csrf } from "./lib/csrf.js";
import { sessionAccessor } from "./lib/session.js";

const accounts = new SQLiteAdminAccounts(db, adminUsers);
const groups = new SQLiteAdminGroups(db, { groups: adminGroups, userGroups: adminUserGroups });

new AdminPanel({
  session: sessionAccessor.use,
  csrf,
  accounts: { users: accounts, groups }, // `groups` is optional
  resources: [new PublisherResource()],
});
```

With `accounts` injected and no explicit `authorize`:

- The built-in login/logout screens are derived from `accounts.users.authenticate`
  automatically (same as wiring `auth` yourself, so `auth` is optional too).
  Passing an explicit `auth` still wins over the derived one — an escape
  hatch for e.g. wrapping the credential check in rate limiting — but its
  returned identity's `id` must then be one of `accounts.users`'s own user
  ids, since every request re-validates the logged-in operator by that id.
- `authorize` becomes optional: a built-in permission gate takes over,
  resolving the permission each route requires (view/create/update/delete
  per resource, plus `jobs.view`/`jobs.manage`/`settings.view`/
  `settings.manage`/`audit.view`) and checking it against the operator's
  granted set. Passing `authorize` anyway runs it IN ADDITION to the
  accounts gate (both must allow — an AND). At least one of `authorize`/
  `accounts` is required; the constructor throws if both are omitted.
- `session` and `csrf` are both required once `accounts` is injected — the
  constructor throws if either is missing.
- The logged-in operator's row is re-validated against the DB on **every
  request** (not only at login), so setting `isActive: false` or deleting
  the row revokes access immediately, redirecting the stale session back
  to `/login`.
- Superusers (`isSuperuser: true`) bypass every permission check. Everyone
  else needs the resolved permission to be in the union of their own
  granted set (`accounts.users.userPermissions`) and, when `groups` is
  also injected, every group's set (`accounts.groups.permissionsForUser`).
  The dashboard itself requires no permission — any active operator may
  open it.

See [Admin accounts](./admin-accounts.md#let-the-panel-enforce-permissions)
for the permission vocabulary and the full route-to-permission mapping.

Injecting `accounts.users` also turns on a built-in, superuser-only
`/accounts/users` screen for managing operators themselves (and
`/accounts/groups` too, once `accounts.groups` is injected), so you don't
have to hand-build one on top of `AdminAccountsUsers`/`AdminAccountsGroups`.
The nav and dashboard also drop any link a non-superuser's granted set
wouldn't actually let them open. See
[Manage operators from the panel](./admin-accounts.md#manage-operators-from-the-panel)
for what the screen does and its guardrails.

### Adding job operations, settings, and audit log sections

Each section activates independently by injecting its config; the nav
only lists the sections you've wired:

```ts
new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  jobs: { console: jobsConsole }, // e.g. an `SQLiteJobsConsole` — see the jobs guide
  settings: {
    featureFlags: { flags: featureFlags, names: ["new-checkout", "beta-search"] },
    maintenance: maintenanceMode, // from `@tknf/oven/security`
  },
  audit: { log: auditLog, actor: (c) => accountGuard.use(c).email },
});
```

When `audit.actor` is omitted, the recorded actor defaults to the
logged-in identity's `label` (falling back to its `id`) if `auth` or
`accounts` is wired and a request is logged in; the literal string
`"admin"` remains the last-resort fallback for a panel with no login
wiring at all, or a write that somehow reaches the handler while logged
out. Job retry/delete, flag toggles, and maintenance toggles are all
recorded to `audit.log` automatically once `audit` is injected.

### Localizing the admin UI

The panel's own chrome (nav labels, headings, buttons, column headers —
not your resource/brand/flag names, which always render as-is) resolves
its language from `c.get("language")`, the same value `languageDetector`
sets on the context elsewhere in oven (see [i18n](./i18n.md)). Wiring
`languageDetector` upstream of the mount is the only step required —
there's no separate admin-specific i18n API to call:

```ts
import { languageDetector } from "hono/language";

app.use(languageDetector({ supportedLanguages: ["en", "ja"], fallbackLanguage: "en" }));
app.route("/admin", new AdminPanel({ authorize: (c) => accountGuard.use(c).role === "admin" }));
```

Without `languageDetector` applied (or for an unsupported/undetected
language), the panel falls back to English.

## Gotchas / Security notes

- **CSRF is not enforced unless you inject `csrf`.** This mirrors the
  general CSRF guidance in [Security](./security.md) and
  [`SECURITY.md`](../SECURITY.md): wire CSRF verification into the
  panel's write routes yourself, either via the `csrf` option shown above
  or by verifying upstream. Without it, the panel logs a one-time
  `console.warn` on the first unsafe-method request, but still serves it
  — it does not fail closed on its own.
- **An access gate is mandatory and the panel assumes nothing about
  roles.** At least one of `authorize` or `accounts` must be injected —
  the constructor throws otherwise. Without `accounts`, there's no
  default "is this user an admin" check; a misconfigured `authorize`
  (e.g. one that always returns `true`) is the same as leaving `/admin`
  unauthenticated. When both are injected, they run as an AND (every
  request must pass both). `auth` (see "Wiring built-in login/logout"
  above), when injected on its own, only answers "who is this operator"
  — `authorize` still runs on every logged-in request and still decides
  "are they allowed in here".
- **`auth` doesn't hash or store anything — that's still the app's own
  user table and `verifyPassword`/`hashPassword` (`@tknf/oven/auth`).**
  `authenticate` is a plain lookup-and-verify callback; admin only wires
  the screens, the session-backed identity, and the redirect gate on top
  of whatever it returns.
- **Resources are structural, not tied to a specific dialect.**
  `AdminResource#model` only needs to satisfy the `AdminModel` shape
  (`paginate`/`listPage`/`retrieve`/`create`/`update`/`delete`/`count`), so
  `SQLiteModel`, `PgModel`, and `MySqlModel` subclasses all work without
  adapters.
- **Primary keys are assumed to be strings.** Number-PK tables aren't
  supported by `AdminResource` today.
- **List sort/pagination is single-column and offset-based.** `?o=`
  supports sorting by exactly one display column at a time (clicking a
  different header replaces, not adds to, the active sort); `?p=` pages
  via `listPage`'s `offset`, which does a full scan-and-discard for deep
  pages on large tables (the same tradeoff `listPage` itself documents).
- **`dateHierarchy()` assumes an integer epoch-millisecond column and lists
  every period in range, not only non-empty ones.** The year/month/day
  lists span the column's min to max value, so selecting a period that
  happens to contain no rows is possible and just renders an empty list.
- **Column allowlisting on write is your form's job, not the panel's.**
  `AdminPanel` passes a successful `Form#validate()` result straight to
  `model.create`/`model.update` (stripping only the primary-key column on
  update, so the URL's `id` can't be overwritten); your `Form#schema()`
  is what determines which fields are actually accepted.
- **Inline child writes are not transactional.** The parent and every
  inline row are validated together before any write, but the writes
  themselves (parent, then each child) happen as separate sequential
  `AdminModel` calls, not inside one DB transaction — `AdminModel` exposes
  no cross-table transaction primitive. A failure partway through child
  writes can leave the parent and some children committed while others
  are not.
- **An inline child `Form#fields()` must not declare the foreign key
  column.** `AdminPanel` sets `foreignKey` itself when creating a new
  child row (`fieldsFromTable(childTable, { omit: ["theForeignKey"] })`,
  as in the example above); if the child form's schema also accepts and
  returns that column, its value would come from operator input instead.

## See also

- [Auth](./auth.md) — `Guard`/`Policy`, the building blocks typically
  reused inside `authorize`.
- [Security](./security.md) — `Csrf`, `MaintenanceMode`, and the rest of
  the hardening primitives the panel's options accept.
- [Forms](./forms.md) — the `Form`/`FieldDef` machinery `AdminResource`
  builds its create/edit screens on top of.
- [i18n](./i18n.md) — `languageDetector` wiring and how the translation
  fallback chain behaves.
