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
`Change` links) instead. Every screen except the dashboard itself also
renders a breadcrumb trail (e.g. `Home › Publisher › Add`) below the
header, built from the same `authorize`-gated nav.

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

`audit.actor` defaults to the literal string `"admin"` if omitted. Job
retry/delete, flag toggles, and maintenance toggles are all recorded to
`audit.log` automatically once `audit` is injected.

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
- **`authorize` is mandatory and the panel assumes nothing about roles.**
  There's no default "is this user an admin" check; a misconfigured
  `authorize` (e.g. one that always returns `true`) is the same as
  leaving `/admin` unauthenticated.
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
- **Column allowlisting on write is your form's job, not the panel's.**
  `AdminPanel` passes a successful `Form#validate()` result straight to
  `model.create`/`model.update` (stripping only the primary-key column on
  update, so the URL's `id` can't be overwritten); your `Form#schema()`
  is what determines which fields are actually accepted.

## See also

- [Auth](./auth.md) — `Guard`/`Policy`, the building blocks typically
  reused inside `authorize`.
- [Security](./security.md) — `Csrf`, `MaintenanceMode`, and the rest of
  the hardening primitives the panel's options accept.
- [Forms](./forms.md) — the `Form`/`FieldDef` machinery `AdminResource`
  builds its create/edit screens on top of.
- [i18n](./i18n.md) — `languageDetector` wiring and how the translation
  fallback chain behaves.
